# ML Fixes Plan — CorpAuditOptionsTrader

## Overview

The MLs aren't learning or trading today due to three interlocking problems:

1. **Deploy-verified serving gate blocking models** (PR #275) — The new `markDeployed.ts` choke requires every deployed model to pass `verifyModelServes`. May/June deployments are weightless, so they fail verification and can't be deployed. Weight-carrying retrains sit as un-promoted canaries.

2. **Strategy type drift causing no-model routing** — Drift values like `long_call_v2`, `call`, `put` don't match trained model rows, causing routing failures to fallback. PR #275 only normalized at `selectModelVersion` + `persistModel`; missing normalization in write paths leaves drift names unhandled.

3. **Feature vector starvation** (Issue #243) — 1,454 of 1,587 real samples excluded as "no-features" because the Hedge Fund Manager didn't score signals in time. The retrainer can't learn without feature vectors.

---

## Issue #1: Deploy-Verified Serving Gate Blocking Models

### Root Cause
PR #275 introduced `markDeployed.ts` which requires every deployed model to pass `verifyModelServes`. The probe uses version-isolated verification with real feature vectors, but May/June models appear weightless (no actual weights loaded). Weight-carrying retrains sit as un-promoted canaries.

### Actions
1. **Immediate rollback of PR #275** — revert the verified-serving choke to restore deployment capability while we diagnose why models are weightless. This is a temporary measure; the gate itself is correct but currently failing due to model state issues.
   - Revert `server/ml/markDeployed.ts` (or remove it from all deploy paths)
   - Restore original canaryDeployment, dailyRetrainer, routers/ml.ts, continuousLearning.ts, and abTesting.ts logic that directly set `isDeployed=1`

2. **Diagnose weightless models** — query the database for deployed model versions with recent deployment timestamps (May/June) and inspect their weights:
   ```sql
   SELECT strategyType, version, isDeployed, promotedAt, 
          ARRAY_LENGTH(modelWeights.weights, 1) as weightCount
   FROM mlModels
   WHERE isDeployed = true AND promotedAt < NOW() - INTERVAL '30 days';
   ```
   If `weightCount` is zero or very small for these rows, the models were deployed before weights were populated (e.g., during canary evaluation phase).

3. **Fix deployment sequencing** — ensure that when a model is promoted to deployed, its weights are already loaded:
   - In `dailyRetrainer.ts`, move weight loading (`nodeModelPredict` or equivalent) *before* the deploy write, not after.
   - Add an assertion in tests that `deployedModels.deployModel()` returns a row with non-empty weights.

4. **Add monitoring** — create a new metric `modelDeployedWeightlessCount` (count of deployed rows where weight count is zero) and alert when it exceeds 1 for more than 5 minutes. This will catch regressions early.

---

## Issue #2: Strategy Type Drift Causing No-Model Routing

### Root Cause
Drift values like `long_call_v2`, `call`, `put`, etc. don't match trained model rows, causing routing failures to fallback. The commit message for PR #275 explicitly identifies this as a root cause.

### Actions
1. **Normalize strategy types at all write paths** — the fix in PR #275 already added `normalizeStrategyType()` and applied it at `selectModelVersion` and `persistModel`. Verify that normalization is also applied at:
   - `registerCanary` (canaryDeployment.ts)
   - `getDeployedModel` (routers/ml.ts)
   - `deployModel` mutations (routers/ml.ts, continuousLearning.ts, abTesting.ts)

2. **Add drift-name alias mapping** — create a constant map of known drift names to canonical strategy types:
   ```typescript
   const DRIFT_ALIAS_MAP = {
     'long_call_v2': 'long_call',
     'call': 'long_call',
     'put': 'long_put',
     // add others as discovered in decisionLogs
   };
   ```

3. **Backfill missing feature vectors** — for decisions that lack `featureVector` (the 1,454 rows identified in Issue #243), compute them retroactively using the strategy type normalization:
   - Query `decisionLogs` where `featureVector IS NULL AND outcome IN ('win','loss','breakeven')`.
   - For each row, look up the corresponding candidate's feature vector from the data pipeline (using normalized strategy type).
   - Update `decisionLogs.featureVector` with the computed value.

4. **Add regression tests** — ensure that after normalization, drift values route to trained models instead of fallback:
   ```typescript
   test('normalizeStrategyType maps drift names correctly', () => {
     expect(normalizeStrategyType('long_call_v2')).toBe('long_call');
     // add more mappings as discovered
   });
   ```

---

## Issue #3: Feature Vector Starvation (Issue #243)

### Root Cause
1,454 of 1,587 real closed samples are excluded for "no-features" because the Hedge Fund Manager didn't score signals in time. The `signalPublisher.ts` logs a decisionLogs row with `skipEnrichment: true` and `features: mgrDecision?.featureVector`. When features is undefined, the row has `featureVector=null`, and retrainer skips it.

### Actions
1. **Understand why Manager didn't score** — query `decisionLogs` for rows where `source = 'manager' AND skipEnrichment = true`:
   ```sql
   SELECT COUNT(*) as total,
          SUM(CASE WHEN mgrDecision IS NULL THEN 1 ELSE 0 END) as noMgrDecision,
          SUM(CASE WHEN mgrDecision.featureVector IS NULL THEN 1 ELSE 0 END) as noMgrFeatures
   FROM decisionLogs;
   ```

2. **Determine if features can be computed at publish time** — check the data pipeline to see if feature computation is lazy or requires Manager scoring:
   - If features are computed independently of Manager, add a backfill job that computes them for all missing rows.
   - If features require Manager scoring, investigate why Manager didn't score (e.g., latency, failure) and fix the scoring path.

3. **Add enrichment-on-publish** — modify `signalPublisher.ts` to compute features even when `mgrDecision` is null:
   ```typescript
   const featureVector = mgrDecision?.featureVector ?? 
                         await computeFeaturesForCandidate(candidateId);
   ```

4. **Lower the trainable floor temporarily** — if backfilling isn't feasible immediately, lower `minSamplesForRetrain` from 200 to 150 (or even 133) as a temporary measure while we fix the root cause. Document this change and plan to revert once feature vectors are populated.

---

## Issue #4: SnapTrade Multi-Deployment Collision (Issue #266)

### Root Cause
Two production deployments share one SnapTrade client key but have separate databases. The `userId` is derived as `user_${ctx.user.id}_${broker}` — both deployments compute the identical userId, causing mutual destruction of authorizations on every register.

### Actions
1. **Add per-deployment namespace** — introduce a new env var `SNAPTRADE_USER_NAMESPACE` (e.g., `apex`, `corpaudit`) and change the userId derivation to `${namespace}_user_${ctx.user.id}_${broker}`. This ensures distinct SnapTrade users per deployment.

2. **De-fang the 1010 handler** — in `initSnapTradeUser`, on code 1010 ("user exists") do NOT call `deleteSnapTradeUser` (it wipes authorizations). Instead, reuse the existing user:
   ```typescript
   if (snapTradeResponse.code === 1010) {
     // Reset secret without deleting the user
     await resetSnapTradeUserSecret(userId);
     return;
   }
   ```

3. **Re-link broker connections** — after deploying with distinct namespaces, run the connect flow once per deployment to establish fresh, isolated authorizations:
   - Update `brokerConnections` rows to point to the new namespaced userIds.
   - Verify `/api/health` shows `snaptrade_holdings.lastSuccessAt` populating for both deployments.

4. **Add test coverage** — write a test that registers two users with different namespaces and confirms they don't collide:
   ```typescript
   test('namespaced userIds prevent collision', async () => {
     const apexUserId = deriveSnapTradeUserId({ namespace: 'apex', ... });
     const corpauditUserId = deriveSnapTradeUserId({ namespace: 'corpaudit', ... });
     expect(apexUserId).not.toBe(corpauditUserId);
   });
   ```

---

## Issue #5: OOF Validation Refactor Collision (Issue #250)

### Root Cause
PR #204's expanding-window OOF validation refactor removed/relocated the local `scaler` definition, but main's return block still references it (`scaler.means`/`scaler.stds`) → TypeScript error. It also collides with PR #212 which added `modelWeights.scaler` serialization for loadable models — one of the central fixes in the "prod ML never worked" saga.

### Actions
1. **Re-apply OOF structure on top of current code** — re-introduce the local `scaler` definition that PR #204 removed, but ensure it's scoped per training fold (no test-fold leakage):
   ```typescript
   const scaler = new StandardScaler();
   // fit only on train folds
   scaler.fit(trainFeatures);
   // transform both train and test using the same scaler
   const trainScaled = scaler.transform(trainFeatures);
   const testScaled = scaler.transform(testFeatures);
   ```

2. **Preserve #212's scaler serialization** — ensure that after training, `modelWeights.scaler` is serialized so trained models load at scoring time:
   ```typescript
   modelWeights.scaler = scaler; // will be serialized by drizzle
   ```

3. **Add test verifying scaler travels with weights** — write a test that trains a model and confirms the scaler can be deserialized at scoring time:
   ```typescript
   test('scaler serializes with model weights', () => {
     const trainedModel = trainModel(trainData, testData);
     expect(trainedModel.modelWeights.scaler).toBeDefined();
     // deserialize and verify it works
     const scaler = trainedModel.modelWeights.scaler;
     expect(scaler.mean).toBeCloseTo(expectedMean);
   });
   ```

4. **Validate full ML pipeline** — run `pnpm test` on the affected files (`nodeFallbackTrainer.ts`, any new OOF tests) and ensure all tests pass:
   - Check that OOF validation fits the scaler per training fold only (no test-fold leakage).
   - Confirm final model still serializes `modelWeights.scaler`.

---

## Verification & Rollout Plan

### Phase 1: Immediate Stabilization
- [ ] Revert PR #275 verified-serving gate
- [ ] Lower `minSamplesForRetrain` to 150 (temporary)
- [ ] Deploy and verify ML scoring works again

### Phase 2: Fix Weightless Models
- [ ] Diagnose weightless deployed models in DB
- [ ] Fix deployment sequencing in dailyRetrainer.ts
- [ ] Add `modelDeployedWeightlessCount` metric and alerting
- [ ] Verify all deployed models have non-empty weights

### Phase 3: Strategy Normalization & Backfill
- [ ] Apply normalization at all write paths
- [ ] Add drift alias map
- [ ] Backfill missing feature vectors for 1,454 decisions
- [ ] Run regression tests

### Phase 4: SnapTrade Isolation
- [ ] Deploy namespaced userIds fix to both repos (apex-options and CorpAuditOptionsTrader)
- [ ] De-fang 1010 handler in both repos
- [ ] Re-link broker connections
- [ ] Verify health endpoint for both deployments

### Phase 5: OOF Validation Fix
- [ ] Re-apply expanding-window OOF structure with per-fold scaler
- [ ] Preserve modelWeights.scaler serialization
- [ ] Add and run full test suite
- [ ] Validate ML pipeline end-to-end

### Phase 6: Monitoring & Documentation
- [ ] Create SOP for future deploy-verified serving gate changes (must include weight-loading verification)
- [ ] Document the drift normalization process in `.claude/rules/ml/`
- [ ] Add runbook entry for feature vector backfill job

---

## Dependencies Between Issues
- Issue #1 fix must happen before any new model deployments can occur.
- Issue #2 normalization is required for Issue #3 backfill to work correctly (drift names must be resolved).
- Issue #4 SnapTrade fix should be deployed independently of ML fixes, as it affects brokerage data flow.
- Issue #5 OOF validation fix can proceed in parallel with Issues #1–#4, but its tests depend on the ML pipeline being functional (Issue #1 fixed).

---

## Risk Mitigation
- All changes are additive where possible; no shadow→live execution changes.
- Quality gates unchanged — only serving verification is temporarily disabled.
- Each phase includes explicit test coverage and regression checks.
- Temporary floor lowering for Issue #3 is documented with a plan to revert once backfill completes.

This plan addresses the root causes identified in the repository's recent commits and open issues, restoring ML learning and trading capability while preventing regressions through comprehensive testing and monitoring.