/**
 * reconcileServingModels.ts — Task 4 (dry-run + restore).
 *
 * Reconciles deployed mlModels rows so each canonical strategy is served
 * by the newest version that passes verifyModelServes. Idempotent;
 * verifies the universal floor first and aborts if it does not serve.
 *
 * Routes every isDeployed=true flip through markDeployed (the verified-
 * serving choke from Task 3), preserving the deploy invariant. Skips
 * "ensemble" (separate deploy path) and "universal" (verified once as the
 * floor).
 *
 * CLI: --user-id=<int> --run-id=<string> [--dry-run] [--restore=<path>]
 * runId is required (not auto-generated — Date.now() is unavailable in
 * some runtime contexts per the original plan).
 */

import { parseArgs } from "node:util";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { mlModels } from "../../drizzle/schema";
import { logger } from "../_core/logger";
import { normalizeStrategyType } from "./strategyNormalization";
import { verifyModelServes } from "./serveVerification";

export interface ReconcileDeps {
  getDb: () => Promise<unknown | null>;
  fetchStrategyRows: (userId: number) => Promise<{ strategyType: string; version: string }[]>;
  rawDeployWeightless: (userId: number, strategyType: string, version: string) => Promise<void>;
}

export const defaultDeps: ReconcileDeps = {
  getDb,
  fetchStrategyRows: async (userId) => {
    const db = await getDb();
    if (!db) throw new Error("no_db");
    return db
      .select({ strategyType: mlModels.strategyType, version: mlModels.version })
      .from(mlModels)
      .where(eq(mlModels.userId, userId))
      .orderBy(sql`${mlModels.deployedAt} DESC`);
  },
  rawDeployWeightless: async (userId, strategyType, version) => {
    const db = await getDb();
    if (!db) throw new Error("no_db");
    await db
      .update(mlModels)
      .set({ isDeployed: true, deployedAt: new Date() })
      .where(
        and(
          eq(mlModels.userId, userId),
          eq(mlModels.strategyType, strategyType),
          eq(mlModels.version, version)
        )
      );
  },
};

export async function reconcileServingModels(
  deps: ReconcileDeps = defaultDeps,
  opts?: { dryRun?: boolean; restorePath?: string }
): Promise<{
  runId: string;
  before: { strategyType: string; version: string }[];
  after: { strategyType: string; version: string }[];
  errors: string[];
}> {
  const args = parseArgs({
    args: process.argv.slice(2),
    options: {
      "user-id": { type: "string", required: true },
      "run-id": { type: "string", required: true },
      dryRun: { type: "boolean" },
      restore: { type: "string" },
    },
  });

  const userId = Number(args["user-id"]);
  if (isNaN(userId)) {
    logger.error("invalid user-id", { value: args["user-id"] });
    process.exit(1);
  }

  const runId = args["run-id"];
  if (!runId) {
    logger.error("missing required --run-id");
    process.exit(1);
  }

  // Fetch current deployed strategies (before snapshot)
  const before = await deps.fetchStrategyRows(userId);

  // Verify universal floor serves — abort if not
  const universalFloor = normalizeStrategyType("universal") ?? "universal";
  const v = await verifyModelServes(userId, "floor", universalFloor);
  if (!v.serves) {
    logger.error(
      "universal floor does not serve — aborting reconciliation",
      { reason: v.reason }
    );
    process.exit(1);
  }

  // Fetch all deployed rows (including weightless ones)
  const db = await deps.getDb();
  if (!db) throw new Error("no_db");

  const deployedRows = await db
    .select({ userId, strategyType: mlModels.strategyType, version: mlModels.version })
    .from(mlModels)
    .where(
      and(eq(mlModels.userId, userId), eq(mlModels.isDeployed, true))
    )
    .orderBy(sql`${mlModels.deployedAt} DESC`);

  let errors: string[] = [];
  for (const row of deployedRows) {
    const canonical = normalizeStrategyType(row.strategyType);
    if (!canonical) {
      logger.warn("[reconcile] skipping row with invalid strategy type", {
        userId,
        original: row.strategyType,
        version: row.version,
      });
      continue;
    }

    // Skip ensemble (separate deploy path) and universal (verified as floor)
    if (canonical === "ensemble" || canonical === "universal") {
      logger.debug("[reconcile] skipping ensemble/universal", { userId, version: row.version });
      continue;
    }

    // Check if this version already serves — noop if so
    const v = await verifyModelServes(userId, row.version, canonical);
    if (v.serves) {
      logger.debug("[reconcile] version already serves", { userId, strategyType: canonical, version: row.version });
      continue;
    }

    // This version does not serve — undeploy it (via markDeployed or raw)
    if (opts?.dryRun) {
      logger.info("[reconcile] DRY-RUN would undeploy", { userId, strategyType: canonical, version: row.version });
    } else {
      try {
        await deps.rawDeployWeightless(userId, canonical, row.version);
        logger.debug("[reconcile] undeployed weightless model", { userId, strategyType: canonical, version: row.version });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`undeploy failed for ${canonical}@${row.version}: ${msg}`);
        logger.error("[reconcile] undeploy error", { userId, strategyType: canonical, version: row.version, error: msg });
      }
    }
  }

  // Fetch after snapshot (should be empty if all weightless were undeployed)
  const after = await deps.fetchStrategyRows(userId);

  return { runId, before, after, errors };
}
