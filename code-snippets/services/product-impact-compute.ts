/**
 * Product Impact Compute Module
 *
 * Pure, stateless statistical computation functions for aggregating
 * session-level health impacts into per-product rollups.
 *
 * DESIGN PRINCIPLES:
 * - ALL functions are pure (no side effects, deterministic)
 * - ALL functions are synchronous (no I/O, no DB, no async)
 * - Input validation is caller's responsibility (fail-fast at boundary)
 * - NaN/Infinity are never returned (guarded by empty-check + Math.abs)
 *
 * @module product-impact-compute
 */

// Types

export type ConfidenceTier = 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';
export type Exactness = 'EXACT' | 'PARTIAL' | 'ESTIMATED';
export type QualityFlag =
  | 'LOW_SESSION_COUNT'
  | 'INCONSISTENT_DELTAS'
  | 'LOW_COVERAGE'
  | 'MIXED_RELIABILITY'
  | 'STALE_SESSIONS'
  | 'SHORT_OBSERVATION_PERIOD'
  | 'MULTI_PRODUCT_SESSION'
  | 'PRIMARY_PRODUCT_ONLY';

/**
 * Quality flag semantics:
 *
 * - PRIMARY_PRODUCT_ONLY: All product-impact rollups use primary-product attribution.
 *   Present on EVERY product-impact row as a global data-model acknowledgment
 *   (per internal design spec plan contract). Does not indicate an anomaly.
 *
 * - MULTI_PRODUCT_SESSION: At least one session in the evidence set had multiple
 *   products consumed. The impact was attributed entirely to the primary product.
 *   This IS an anomaly flag — indicates reduced attribution precision.
 *
 * Future: Cross-product attribution requires consumption-level impact modeling.
 */

/**
 * Input for a single session's impact data (for aggregation).
 * Represents one row from user_session_impact_summary.
 */
export interface ReliableImpactInput {
  readonly sessionId: string;
  readonly deltaDuringAbs: number | null;
  readonly deltaDuringPct: number | null;
  readonly deltaAfterAbs: number | null;
  readonly deltaAfterPct: number | null;
  readonly avgBefore: number | null;
  readonly beforeCoverage: number | null;
  readonly duringCoverage: number | null;
  readonly afterCoverage: number | null;
  readonly isReliable: boolean;
  readonly status: string;
  readonly sessionStartTs: Date;
}

/**
 * Input for exactness computation (status-aware).
 */
export interface ImpactStatusInput {
  readonly status: string;
  readonly isReliable: boolean;
}

/**
 * Input for quality flag computation.
 */
export interface QualityFlagInput {
  readonly reliableCount: number;
  readonly totalCount: number;
  readonly avgCoverage: number;
  readonly consistencyScore: number;
  readonly observationDays: number;
  readonly minSessionsRequired: number;
}

/**
 * Aggregated product impact result (output of computeProductImpactAggregate).
 */
export interface ProductImpactAggregate {
  // Effects
  readonly avgDeltaDuringAbs: number | null;
  readonly avgDeltaDuringPct: number | null;
  readonly avgDeltaAfterAbs: number | null;
  readonly avgDeltaAfterPct: number | null;
  readonly medianDeltaAfterPct: number | null;

  // Baseline
  readonly baselineValue: number | null;
  readonly baselineMethod: string;
  readonly baselineN: number;
  readonly baselineWindow: string;

  // Quality
  readonly coverageScore: number | null;
  readonly isReliable: boolean;
  readonly qualityFlags: QualityFlag[];
  readonly exactness: Exactness;

  // Confidence
  readonly confidenceTier: ConfidenceTier;
  readonly confidenceScore: number;
  readonly ciLow: number | null;
  readonly ciHigh: number | null;

  // Aggregation
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
  readonly sessionCount: number;
  readonly reliableCount: number;
  /**
   * Count of sessions with at least one non-null delta value (meaningful evidence).
   * A session can be "reliable" (good coverage) yet have all-null deltas if before/during/after
   * averages happened to be null. Status derivation should use this, not just reliableCount.
   */
  readonly meaningfulDeltaCount: number;

  // Traceability
  readonly evidenceSessionIds: string[];
}

// Confidence Tier Thresholds

/** Minimum reliable sessions for HIGH confidence. */
const HIGH_SESSION_THRESHOLD = 10;
/** Minimum reliable sessions for MEDIUM confidence. */
const MEDIUM_SESSION_THRESHOLD = 5;
/** Minimum reliable sessions for LOW confidence. */
const LOW_SESSION_THRESHOLD = 3;

/** Minimum average coverage for HIGH confidence. */
const HIGH_COVERAGE_THRESHOLD = 0.8;
/** Minimum average coverage for MEDIUM confidence. */
const MEDIUM_COVERAGE_THRESHOLD = 0.6;
/** Minimum average coverage for LOW confidence. */
const LOW_COVERAGE_THRESHOLD = 0.4;

/** Maximum evidence session IDs to sample for traceability. */
const MAX_EVIDENCE_SESSION_IDS = 20;

/**
 * T-distribution critical values for 95% CI.
 * Index = degrees of freedom (n-1). For df >= 30, use z = 1.96.
 */
const T_CRITICAL_95: Record<number, number> = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
  6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
  11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131,
  16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086,
  25: 2.060, 29: 2.045,
};

/**
 * Get the t-critical value for a given degrees of freedom at 95% CI.
 * Falls back to z = 1.96 for df >= 30.
 */
function getTCritical(df: number): number {
  if (df >= 30) return 1.96;
  if (T_CRITICAL_95[df] != null) return T_CRITICAL_95[df]!;
  // Interpolate for missing keys between 20 and 29
  const keys = Object.keys(T_CRITICAL_95).map(Number).sort((a, b) => a - b);
  let lower = 1;
  let upper = 30;
  for (const k of keys) {
    if (k <= df) lower = k;
    if (k >= df) { upper = k; break; }
  }
  if (lower === upper) return T_CRITICAL_95[lower]!;
  const lowerVal = T_CRITICAL_95[lower]!;
  const upperVal = T_CRITICAL_95[upper] ?? 1.96;
  // Linear interpolation
  return lowerVal + (upperVal - lowerVal) * ((df - lower) / (upper - lower));
}

// Statistical Helpers (Pure Functions)

/**
 * Compute the arithmetic mean of a number array.
 * Returns null for empty input.
 */
export function computeMean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * Compute the median of a number array.
 * Returns null for empty input.
 *
 * Creates a sorted copy (does not mutate input).
 */
export function computeMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

/**
 * Compute the population standard deviation given a pre-computed mean.
 * Returns 0 for arrays with < 2 elements.
 */
export function computeStdDev(values: readonly number[], mean: number): number {
  if (values.length < 2) return 0;
  let sumSqDiff = 0;
  for (const v of values) {
    const diff = v - mean;
    sumSqDiff += diff * diff;
  }
  // Use sample std dev (n-1) for CI calculation
  return Math.sqrt(sumSqDiff / (values.length - 1));
}

/**
 * Compute a 95% confidence interval for the mean.
 *
 * Uses t-distribution for n < 30, z-score for n >= 30.
 * Returns null if n < 2 (cannot compute CI with fewer than 2 observations).
 */
export function computeConfidenceInterval(
  values: readonly number[],
  confidenceLevel: number = 0.95,
): { ciLow: number; ciHigh: number } | null {
  if (values.length < 2) return null;

  const mean = computeMean(values);
  if (mean == null) return null;

  const stdDev = computeStdDev(values, mean);
  const df = values.length - 1;
  const tCritical = getTCritical(df);
  const marginOfError = tCritical * (stdDev / Math.sqrt(values.length));

  return {
    ciLow: mean - marginOfError,
    ciHigh: mean + marginOfError,
  };
}

// Quality Assessment (Pure Functions)

/**
 * Determine the confidence tier based on session count and coverage.
 *
 * Tiers (in priority order):
 * - HIGH: >= 10 reliable sessions AND avg coverage >= 0.8
 * - MEDIUM: >= 5 reliable AND coverage >= 0.6
 * - LOW: >= 3 reliable AND coverage >= 0.4
 * - INSUFFICIENT: < 3 reliable
 */
export function computeConfidenceTier(
  reliableCount: number,
  avgCoverage: number,
): ConfidenceTier {
  if (reliableCount >= HIGH_SESSION_THRESHOLD && avgCoverage >= HIGH_COVERAGE_THRESHOLD) {
    return 'HIGH';
  }
  if (reliableCount >= MEDIUM_SESSION_THRESHOLD && avgCoverage >= MEDIUM_COVERAGE_THRESHOLD) {
    return 'MEDIUM';
  }
  if (reliableCount >= LOW_SESSION_THRESHOLD && avgCoverage >= LOW_COVERAGE_THRESHOLD) {
    return 'LOW';
  }
  return 'INSUFFICIENT';
}

/**
 * Compute a confidence score in [0, 1].
 *
 * Weighted combination:
 * - 40% session count contribution (log-scaled, capped at 20)
 * - 30% average coverage
 * - 30% consistency score
 */
export function computeConfidenceScore(
  reliableCount: number,
  avgCoverage: number,
  consistencyScore: number,
): number {
  // Session count: log-scaled, 0→0, 3→~0.35, 10→~0.77, 20→1.0
  const sessionContribution = Math.min(1.0, Math.log(1 + reliableCount) / Math.log(21));
  // Clamp inputs to [0, 1]
  const clampedCoverage = Math.max(0, Math.min(1, avgCoverage));
  const clampedConsistency = Math.max(0, Math.min(1, consistencyScore));

  return Math.round(
    (0.4 * sessionContribution + 0.3 * clampedCoverage + 0.3 * clampedConsistency) * 10000
  ) / 10000;
}

/**
 * Compute consistency score: 1 - normalized standard deviation.
 *
 * Measures how consistent the delta values are across sessions.
 * 1.0 = perfectly consistent, 0.0 = highly variable.
 *
 * Returns 1.0 for < 2 values (no variance to measure).
 */
export function computeConsistencyScore(deltaValues: readonly number[]): number {
  if (deltaValues.length < 2) return 1.0;

  const mean = computeMean(deltaValues);
  if (mean == null || mean === 0) return 1.0; // Avoid division by zero

  const stdDev = computeStdDev(deltaValues, mean);
  // Coefficient of variation (normalized std dev)
  const cv = stdDev / Math.abs(mean);
  // Clamp to [0, 1]: high CV → low consistency
  return Math.max(0, Math.min(1, 1 - cv));
}

/**
 * Determine exactness from impact statuses.
 *
 * - EXACT: All impacts have READY status and isReliable=true
 * - PARTIAL: Some but not all are READY+reliable
 * - ESTIMATED: None are READY+reliable (or empty input)
 */
export function computeExactness(impacts: readonly ImpactStatusInput[]): Exactness {
  if (impacts.length === 0) return 'ESTIMATED';

  let readyReliable = 0;
  for (const impact of impacts) {
    if (impact.status === 'READY' && impact.isReliable) {
      readyReliable++;
    }
  }

  if (readyReliable === impacts.length) return 'EXACT';
  if (readyReliable > 0) return 'PARTIAL';
  return 'ESTIMATED';
}

/**
 * Compute quality flags based on aggregate statistics.
 *
 * PRIMARY_PRODUCT_ONLY is always emitted — it acknowledges the global attribution
 * model (all impact attributed to session's primary product). This is a contract
 * requirement from internal design spec, not an anomaly indicator.
 */
export function computeQualityFlags(params: QualityFlagInput): QualityFlag[] {
  const flags: QualityFlag[] = ['PRIMARY_PRODUCT_ONLY'];

  if (params.reliableCount < params.minSessionsRequired) {
    flags.push('LOW_SESSION_COUNT');
  }
  if (params.consistencyScore < 0.3) {
    flags.push('INCONSISTENT_DELTAS');
  }
  if (params.avgCoverage < 0.5) {
    flags.push('LOW_COVERAGE');
  }
  if (params.reliableCount < params.totalCount) {
    flags.push('MIXED_RELIABILITY');
  }
  if (params.observationDays < 7) {
    flags.push('SHORT_OBSERVATION_PERIOD');
  }

  return flags;
}

// Core Aggregate (Pure Function)

/**
 * Compute a full product impact aggregate from session-level impacts.
 *
 * PURE FUNCTION: No I/O, no side effects, deterministic output.
 *
 * ALGORITHM:
 * 1. Separate reliable vs unreliable impacts
 * 2. Use ONLY reliable impacts for aggregate computation
 * 3. Compute mean/median of delta values
 * 4. Compute baseline from before-session averages
 * 5. Compute average coverage across all impacts
 * 6. Assess confidence tier, score, and CI
 * 7. Generate quality flags
 *
 * @param impacts - All session impacts for a product×metric (reliable + unreliable)
 * @param minSessionsRequired - Minimum reliable sessions for READY status (default 3)
 * @returns Full aggregate with all 8 field groups
 */
export function computeProductImpactAggregate(
  impacts: readonly ReliableImpactInput[],
  minSessionsRequired: number = 3,
): ProductImpactAggregate {
  // Separate reliable impacts for computation
  const reliable = impacts.filter((i) => i.isReliable);
  const reliableCount = reliable.length;

  // Count sessions with at least one meaningful delta (evidence of actual measurement).
  // A session with all-null deltas provides no impact evidence even if marked reliable.
  const meaningfulDeltaCount = reliable.filter((i) =>
    i.deltaDuringAbs != null || i.deltaDuringPct != null ||
    i.deltaAfterAbs != null || i.deltaAfterPct != null
  ).length;

  // 1. Collect non-null delta values from reliable impacts
  const duringAbsValues = reliable.map((i) => i.deltaDuringAbs).filter((v): v is number => v != null);
  const duringPctValues = reliable.map((i) => i.deltaDuringPct).filter((v): v is number => v != null);
  const afterAbsValues = reliable.map((i) => i.deltaAfterAbs).filter((v): v is number => v != null);
  const afterPctValues = reliable.map((i) => i.deltaAfterPct).filter((v): v is number => v != null);

  // 2. Compute effects
  const avgDeltaDuringAbs = computeMean(duringAbsValues);
  const avgDeltaDuringPct = computeMean(duringPctValues);
  const avgDeltaAfterAbs = computeMean(afterAbsValues);
  const avgDeltaAfterPct = computeMean(afterPctValues);
  const medianDeltaAfterPct = computeMedian(afterPctValues);

  // 3. Compute baseline from before-session averages
  const baselineValues = reliable
    .map((i) => i.avgBefore)
    .filter((v): v is number => v != null);
  const baselineValue = computeMean(baselineValues);

  // 4. Compute average coverage
  const coverageValues: number[] = [];
  for (const impact of impacts) {
    const vals = [impact.beforeCoverage, impact.duringCoverage, impact.afterCoverage]
      .filter((v): v is number => v != null);
    if (vals.length > 0) {
      coverageValues.push(vals.reduce((a, b) => a + b, 0) / vals.length);
    }
  }
  const avgCoverage = computeMean(coverageValues) ?? 0;
  const coverageScore = coverageValues.length > 0 ? avgCoverage : null;

  // 5. Compute consistency score from deltaAfterPct (most important metric)
  const consistencyScore = computeConsistencyScore(afterPctValues);

  // 6. Confidence assessment
  const confidenceTier = computeConfidenceTier(reliableCount, avgCoverage);
  const confidenceScoreValue = computeConfidenceScore(reliableCount, avgCoverage, consistencyScore);
  const ci = computeConfidenceInterval(afterPctValues);

  // 7. Quality flags
  const periodStart = impacts.length > 0
    ? impacts.reduce((min, i) => i.sessionStartTs < min ? i.sessionStartTs : min, impacts[0]!.sessionStartTs)
    : null;
  const periodEnd = impacts.length > 0
    ? impacts.reduce((max, i) => i.sessionStartTs > max ? i.sessionStartTs : max, impacts[0]!.sessionStartTs)
    : null;
  const observationDays = periodStart && periodEnd
    ? Math.max(1, Math.ceil((periodEnd.getTime() - periodStart.getTime()) / (24 * 60 * 60 * 1000)))
    : 0;

  const qualityFlags = computeQualityFlags({
    reliableCount,
    totalCount: impacts.length,
    avgCoverage,
    consistencyScore,
    observationDays,
    minSessionsRequired,
  });

  // 8. Exactness — use REAL session-impact statuses, not synthetic READY
  const exactness = computeExactness(
    impacts.map((i) => ({ status: i.status, isReliable: i.isReliable })),
  );

  // 9. Reliability: true only when enough reliable sessions with good confidence
  const isReliable = reliableCount >= minSessionsRequired && confidenceTier !== 'INSUFFICIENT';

  // 10. Evidence session IDs (sampled, most recent first)
  const evidenceSessionIds = impacts
    .slice()
    .sort((a, b) => b.sessionStartTs.getTime() - a.sessionStartTs.getTime())
    .slice(0, MAX_EVIDENCE_SESSION_IDS)
    .map((i) => i.sessionId);

  return {
    avgDeltaDuringAbs,
    avgDeltaDuringPct,
    avgDeltaAfterAbs,
    avgDeltaAfterPct,
    medianDeltaAfterPct,
    baselineValue,
    baselineMethod: 'mean_before_session',
    baselineN: baselineValues.length,
    baselineWindow: 'all_time',
    coverageScore,
    isReliable,
    qualityFlags,
    exactness,
    confidenceTier,
    confidenceScore: confidenceScoreValue,
    ciLow: ci?.ciLow ?? null,
    ciHigh: ci?.ciHigh ?? null,
    periodStart,
    periodEnd,
    sessionCount: impacts.length,
    reliableCount,
    meaningfulDeltaCount,
    evidenceSessionIds,
  };
}
