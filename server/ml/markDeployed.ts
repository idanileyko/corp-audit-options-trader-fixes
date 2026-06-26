/**
 * markDeployed.ts — Verified-serving deploy choke (Task 3).
 *
 * SINGLE entry-point for every isDeployed=true flip on mlModels.
 * Before deploying, proves the model version actually loads and predicts
 * via verifyModelServes. Refuses (no write) if verification fails.
 *
 * CARVE-OUTS (intentional — not gated by node-specialist verify):
 *   - "ensemble" strategy: ensemble rows store stacking meta-learner weights,
 *     not node-specialist weights, so verifyModelServes always returns
 *     serves:false for them. Skip verify, deploy directly (mirror rollback).
 *   - modelHealthGuard rollback path: intentionally not routed here — see
 *     modelHealthGuard.ts for rationale (transient verify failure must not
 *     deadlock a safety rollback).
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "../db";
import { mlModels } from "../../drizzle/schema";
import { logger } from "../_core/logger";
import { normalizeStrategyType } from "./strategyNormalization";
import { verifyModelServes } from "./serveVerification";
import {
  clearCalibrationCache,
  clearNodeModelCache,
  invalidateDeployedEnsembleCache,
} from "./mlScoring";
import { clearAutoApproveTrustCache } from "./autoApproveTrust";

export interface MarkDeployedResult {
  deployed: boolean;
  reason?: string;
}

/** Best-effort affected-row extraction for drizzle-mysql2 result shapes. */
function extractAffectedRows(result: unknown): number {
  if (result == null) return 0;
  if (Array.isArray(result)) {
    const header = result[0] as { affectedRows?: number } | undefined;
    return typeof header?.affectedRows === "number" ? header.affectedRows : 0;
  }
  const header = result as { affectedRows?: number };
  return typeof header.affectedRows === "number" ? header.affectedRows : 0;
}

/**
 * Verify a model version serves, then undeploy siblings and deploy the
 * specified version. The two writes run inside a single db.transaction so a
 * failure between them can never leave the strategy with ZERO deployed rows
 * (which would be worse than the prior state — 100% fallback). Returns
 * {deployed:false} without writing on verify failure or DB unavailability.
 */
export async function markDeployed(
  userId: number,
  strategyType: string,
  version: string,
  _opts?: { reason?: string }
): Promise<MarkDeployedResult> {
  const db = await getDb();
  if (!db) return { deployed: false, reason: "no_db" };

  const canonical = normalizeStrategyType(strategyType);

  // ── Serving gate ───────────────────────────────────────────────────────
  // Ensemble rows use stacking meta-learner weights (not node-specialist),
  // so verifyModelServes would always return serves:false for them. Skip the
  // gate and deploy directly — the ensemble deploy decision (aucLift > 0) is
  // the caller's responsibility. All specialist strategies MUST verify.
  if (canonical === "ensemble") {
    logger.warn(
      "[markDeployed] deploying ensemble WITHOUT serve-verification — node probe N/A; relying on caller AUC check",
      { version }
    );
  } else {
    const v = await verifyModelServes(userId, version, canonical);
    if (!v.serves) {
      logger.warn("[markDeployed] refused — model does not serve", {
        version,
        strategyType: canonical,
        reason: v.reason,
      });
      return { deployed: false, reason: v.reason ?? "does_not_serve" };
    }
  }

  // ── Atomic undeploy-siblings then deploy (single transaction) ─────────────
  // If the deploy write throws OR matches zero rows, the undeploy is rolled
  // back — the strategy is never left with zero deployed rows.
  await db.transaction(async tx => {
    await tx
      .update(mlModels)
      .set({ isDeployed: false })
      .where(
        and(
          eq(mlModels.userId, userId),
          eq(mlModels.strategyType, canonical),
          eq(mlModels.isDeployed, true)
        )
      );

    const deployResult = await tx
      .update(mlModels)
      .set({ isDeployed: true, deployedAt: new Date() })
      .where(
        and(
          eq(mlModels.userId, userId),
          eq(mlModels.version, version),
          // mlModels.version is NOT unique — scope to canonical strategy so we
          // never flip a same-version row belonging to a different strategy.
          eq(mlModels.strategyType, canonical)
        )
      );

    // drizzle-mysql2 .update().set().where() returns MySqlQueryResult
    // = [ResultSetHeader, FieldPacket[]]. Read affectedRows defensively to
    // tolerate the shape drift across driver versions.
    const affectedRows = extractAffectedRows(deployResult);
    if (affectedRows === 0) {
      // Throwing inside the tx callback rolls the undeploy back, so the
      // strategy retains its prior deployment instead of dropping to zero.
      throw new Error(
        `markDeployed_no_row_matched:userId=${userId},strategyType=${canonical},version=${version}`
      );
    }
  });

  // ── Cache invalidation (after commit) ───────────────────────────────────
  clearCalibrationCache(version);
  clearNodeModelCache(version);
  // A (re)deployed version must be re-evaluated for auto-approve trust (e.g. a
  // version that wasn't trusted yet now has enough shadow decisions). Trust
  // metrics (auc/calibrationError) are immutable per version, so deploy is the
  // right invalidation hook.
  clearAutoApproveTrustCache(version);
  if (canonical === "ensemble") {
    invalidateDeployedEnsembleCache();
  }

  return { deployed: true };
}
