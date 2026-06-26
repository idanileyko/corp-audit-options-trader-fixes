/**
 * strategyNormalization.ts — Normalize strategy types to canonical names.
 *
 * Handles drift values (long_call_v2, call, put, etc.) and whitespace-only
 * inputs. Returns the canonical name or null if normalization fails.
 */

import { logger } from "../_core/logger";

/** Frozen set of canonical strategy types — no mutations allowed. */
export const CANONICAL_STRATEGIES = new ReadonlySet([
  "long_call",
  "long_put",
  "equity_long",
  "universal",
]);

/** Known drift-name aliases → canonical name mapping. */
const DRIFT_ALIAS_MAP: Record<string, string> = {
  // long_call variants
  "long_call_v2": "long_call",
  "call": "long_call",
  "call_v1": "long_call",
  "call_v2": "long_call",
  "call_v3": "long_call",
  "call_v4": "long_call",
  // long_put variants
  "put": "long_put",
  "put_v1": "long_put",
  "put_v2": "long_put",
  "put_v3": "long_put",
  // equity_long variants
  "equity_long_v1": "equity_long",
  "equity_long_v2": "equity_long",
};

/**
 * Normalize a strategy type string to its canonical form.
 *
 * - Trims whitespace and lowercases.
 * - Looks up drift aliases in DRIFT_ALIAS_MAP.
 * - Returns null if the result is not in CANONICAL_STRATEGIES or is empty.
 */
export function normalizeStrategyType(strategyType: string | undefined): string | null {
  // Guard against null/undefined — caller must provide a valid strategy type
  if (strategyType == null) return null;

  let normalized = strategyType.trim().toLowerCase();

  // Check for drift-name alias
  const canonical = DRIFT_ALIAS_MAP[normalized];
  if (canonical != null) {
    normalized = canonical;
  }

  // Validate against frozen set — fail fast on invalid input
  if (!CANONICAL_STRATEGIES.has(normalized)) {
    logger.warn(
      "[normalizeStrategyType] unknown strategy type",
      { original: strategyType, normalized }
    );
    return null;
  }

  // Empty string after normalization is invalid
  if (normalized === "") {
    logger.warn("[normalizeStrategyType] empty string returned", {
      original: strategyType,
    });
    return null;
  }

  return normalized;
}
