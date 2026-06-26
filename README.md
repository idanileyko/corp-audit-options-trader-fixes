# CorpAuditOptionsTrader ML Fixes

This repository contains fixes for the three root causes identified in production that prevent MLs from learning or trading:

1. **Rollback deploy-verified serving gate** (revert Task 3 of #275) - The markDeployed choke is blocking models because May/June deployments are weightless
2. **Normalize strategyType at all mlModels write paths** (complete Task 1) - Drift values still route to no-model → fallback  
3. **Backfill missing feature vectors** for decisionLogs rows without features - 1,454 of 1,587 real samples excluded as "no-features"
4. **SnapTrade isolation fix** (Issue #266) - namespaced userIds + de-fang 1010 handler
5. **OOF validation refactor** (Issue #250) - re-apply expanding-window OOF with per-fold scaler

All changes are additive where possible; no shadow→live execution changes. Quality gates unchanged except temporarily disabling the verified-serving choke to restore deployment capability.

Tests: full suite green, including new backfill tests and OOF validation tests. pnpm check clean.