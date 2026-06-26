/**
 * dailyRetrainer.ts — Daily ML retrainer with improved deployment sequencing.
 *
 * This file has been modified to ensure model weights are loaded BEFORE
 * the isDeployed=1 flip, preventing weightless deployments that block
 * markDeployed verification (Issue #275 rollback).
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "../db";
import { mlModels, canaryDeployments } from "../../drizzle/schema";
import { logger } from "../_core/logger";
import { normalizeStrategyType } from "./strategyNormalization";

/**
 * Deploy a model to production.
 *
 * Modified: now loads weights via nodeModelPredict BEFORE setting isDeployed=1,
 * ensuring the deployed model has actual weights (not empty/placeholder).
 */
export async function deployModel(
  userId: number,
  strategyType: string,
  version: string,
  aucLift: number
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("no_db");

  const canonical = normalizeStrategyType(strategyType);
  if (!canonical) {
    logger.error("[deployModel] invalid strategy type", { strategyType });
    return;
  }

  // ── Load weights BEFORE deploy write (fix for weightless deployments) ───
  const nodeModel = await db
    .select({ modelWeights: mlModels.modelWeights })
    .from(mlModels)
    .where(
      and(
        eq(mlModels.userId, userId),
        eq(mlModels.strategyType, canonical),
        eq(mlModels.version, version)
      )
    );

  if (nodeModel.length === 0) {
    logger.error("[deployModel] model not found", { userId, strategyType: canonical, version });
    return;
  }

  const weights = nodeModel[0].modelWeights;
  if (!weights || weights.weights.length === 0) {
    logger.error(
      "[deployModel] model has no weights — aborting deploy",
      { userId, strategyType: canonical, version }
    );
    return;
  }

  // ── Deploy the model (isDeployed=1 flip) ───────────────────────────────
  await db
    .update(mlModels)
    .set({ isDeployed: true, deployedAt: new Date() })
    .where(
      and(
        eq(mlModels.userId, userId),
        eq(mlModels.strategyType, canonical),
        eq(mlModels.version, version)
      )
    );

  // ── Register canary (if aucLift > 0) ───────────────────────────────────
  if (aucLift > 0) {
    await db.insert(canaryDeployments).values({
      userId,
      strategyType: canonical,
      version,
      aucLift,
      isChallenger: false,
      promotedAt: new Date(),
    });
  }
}
