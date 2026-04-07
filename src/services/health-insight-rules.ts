/**
 * Health Insight Rules — Pure Functions
 *
 * Deterministic, evidence-backed insight generation from derived read models.
 * No I/O, no side effects, no AI/LLM — rule-based only.
 *
 * DESIGN:
 * - Each rule function takes pre-fetched data and returns InsightRuleResult | null
 * - null = insufficient evidence (never fabricate)
 * - All numbers in output come from input data (traceable)
 * - Confidence tier derived from data point count + session count
 *
 * @module services/health-insight-rules
 */

import type {
  InsightRuleResult,
  InsightType,
  InsightDisplayType,
  InsightConfidenceTier,
  InsightEvidence,
} from '@shared/contracts';

// Input Types (structural — no Prisma dependency)

/** Rollup data point for trend analysis. */
export interface RollupDataPoint {
  readonly dayUtc: string; // ISO date
  readonly avgVal: number | null;
  readonly minVal: number | null;
  readonly maxVal: number | null;
  readonly countVal: number;
  readonly status: string;
}

/** Session impact summary for correlation analysis. */
export interface SessionImpactData {
  readonly sessionId: string;
  readonly metricCode: string;
  readonly avgBefore: number | null;
  readonly avgDuring: number | null;
  readonly avgAfter: number | null;
  readonly deltaDuringPct: number | null;
  readonly deltaAfterPct: number | null;
  readonly isReliable: boolean;
  readonly status: string;
  readonly productName: string | null;
  readonly productId: string | null;
  readonly sessionStartTs: string; // ISO timestamp
}

/** Product impact rollup for product-specific insights. */
export interface ProductImpactData {
  readonly productId: string;
  readonly productName: string;
  readonly metricCode: string;
  readonly avgDeltaDuringPct: number | null;
  readonly avgDeltaAfterPct: number | null;
  readonly baselineValue: number | null;
  readonly sessionCount: number;
  readonly minSessionsRequired: number;
  readonly isReliable: boolean;
  readonly confidenceTier: string;
  readonly confidenceScore: number | null;
  readonly status: string;
}

// Constants

/** Minimum rollup data points for any trend insight. */
const MIN_TREND_DATA_POINTS = 2;

/** Minimum reliable data points for trend (excludes NO_DATA/FAILED). */
const MIN_RELIABLE_DATA_POINTS = 2;

/** Threshold for "significant" percent change (trend insight). */
const SIGNIFICANT_CHANGE_THRESHOLD_PCT = 5;

/** Minimum sessions for correlation insight. */
const MIN_CORRELATION_SESSIONS = 2;

/** Minimum sessions for product insight. */
const MIN_PRODUCT_SESSIONS = 3;

/** Minimum reliable session impacts for correlation. */
const MIN_RELIABLE_IMPACTS = 2;

// Confidence Computation (Pure)

/**
 * Derive confidence tier from evidence quantity.
 *
 * - high: >= 14 data points AND (sessions >= 3 if applicable)
 * - medium: >= 7 data points AND (sessions >= 2 if applicable)
 * - low: below medium thresholds (still meets minimum)
 */
export function computeConfidenceTier(
  dataPointCount: number,
  sessionCount: number | null,
): InsightConfidenceTier {
  if (dataPointCount >= 14 && (sessionCount === null || sessionCount >= 3)) {
    return 'high';
  }
  if (dataPointCount >= 7 && (sessionCount === null || sessionCount >= 2)) {
    return 'medium';
  }
  return 'low';
}

// Metric Metadata (Pure)

interface MetricMeta {
  readonly label: string;
  readonly unit: string;
  readonly format: (val: number) => string;
  readonly higherIsBetter: boolean;
}

/**
 * Metric display metadata for insight text generation.
 *
 * IMPORTANT: All keys MUST be canonical metric codes from health-config/metric-types.ts.
 * Non-canonical codes (recovery_index, rem_sleep_pct, deep_sleep_pct) were removed in v27
 * because they have no rollup data and produced wasted empty queries.
 *
 * v27: Replaced rem_sleep_pct → sleep_rem (minutes), deep_sleep_pct → sleep_deep (minutes).
 *      Removed recovery_index (not a canonical metric, no rollup data).
 */
const METRIC_META: Record<string, MetricMeta> = {
  heart_rate_variability: {
    label: 'HRV',
    unit: 'ms',
    format: (v) => `${Math.round(v)}ms`,
    higherIsBetter: true,
  },
  heart_rate: {
    label: 'Heart Rate',
    unit: 'BPM',
    format: (v) => `${Math.round(v)} BPM`,
    higherIsBetter: false, // lower resting HR = better fitness
  },
  sleep_duration: {
    label: 'Sleep Duration',
    unit: 'hours',
    format: (v) => `${v.toFixed(1)}h`,
    higherIsBetter: true,
  },
  sleep_rem: {
    label: 'REM Sleep',
    unit: 'min',
    format: (v) => `${Math.round(v)} min`,
    higherIsBetter: true, // more REM = better
  },
  sleep_deep: {
    label: 'Deep Sleep',
    unit: 'min',
    format: (v) => `${Math.round(v)} min`,
    higherIsBetter: true, // more deep sleep = better
  },
  time_in_bed: {
    label: 'Time in Bed',
    unit: 'hours',
    format: (v) => `${v.toFixed(1)}h`,
    higherIsBetter: true,
  },
  blood_oxygen: {
    label: 'Blood Oxygen',
    unit: '%',
    format: (v) => `${v.toFixed(1)}%`,
    higherIsBetter: true,
  },
  respiratory_rate: {
    label: 'Respiratory Rate',
    unit: 'breaths/min',
    format: (v) => `${v.toFixed(1)} breaths/min`,
    higherIsBetter: false, // lower = calmer
  },
};

function getMetricMeta(metricCode: string): MetricMeta {
  return METRIC_META[metricCode] ?? {
    label: metricCode,
    unit: '',
    format: (v: number) => `${v.toFixed(1)}`,
    higherIsBetter: true,
  };
}

// Trend Insight Rule

/**
 * Generate a trend insight from rollup data for a single metric.
 *
 * Computes first-vs-last percent change and average over the window.
 * Returns null if insufficient data (< 2 reliable data points).
 */
export function computeTrendInsight(
  domain: string,
  metricCode: string,
  rollups: readonly RollupDataPoint[],
): InsightRuleResult | null {
  // Filter to READY/PARTIAL rows with non-null avgVal
  const reliable = rollups.filter(
    (r) => (r.status === 'READY' || r.status === 'PARTIAL') && r.avgVal != null,
  );

  if (reliable.length < MIN_RELIABLE_DATA_POINTS) return null;

  // Sort by date ascending
  const sorted = [...reliable].sort((a, b) => a.dayUtc.localeCompare(b.dayUtc));

  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const firstVal = first.avgVal!;
  const lastVal = last.avgVal!;

  // Compute stats
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const r of sorted) {
    const v = r.avgVal!;
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / sorted.length;
  const pctChange = firstVal !== 0 ? ((lastVal - firstVal) / Math.abs(firstVal)) * 100 : 0;
  const absPctChange = Math.abs(pctChange);

  const meta = getMetricMeta(metricCode);
  const trend = absPctChange < SIGNIFICANT_CHANGE_THRESHOLD_PCT
    ? 'stable'
    : lastVal > firstVal ? 'increasing' : 'decreasing';

  // Determine display type based on trend + metric polarity
  let displayType: InsightDisplayType;
  let icon: string;

  if (trend === 'stable') {
    displayType = 'secondary';
    icon = 'trending-neutral';
  } else {
    const improving = (trend === 'increasing') === meta.higherIsBetter;
    displayType = improving ? 'positive' : 'negative';
    icon = trend === 'increasing' ? 'trending-up' : 'trending-down';
  }

  // Build metric line
  const trendWord = trend === 'stable'
    ? 'stable'
    : trend === 'increasing' ? `up ${Math.round(absPctChange)}%` : `down ${Math.round(absPctChange)}%`;
  const metric = `${meta.label} ${trendWord}`;

  // Build description with specific numbers
  const rangeText = `${meta.format(min)}\u2013${meta.format(max)}`;
  const trendVerb = trend === 'stable' ? 'remained stable' : trend === 'increasing' ? 'increased' : 'decreased';
  const description =
    `${meta.label} ${trendVerb} over this period (${meta.format(firstVal)} \u2192 ${meta.format(lastVal)}). ` +
    `Average: ${meta.format(mean)}, range: ${rangeText}.`;

  return {
    domain,
    insightType: 'trend' as InsightType,
    icon,
    metric,
    description,
    displayType,
    confidenceTier: computeConfidenceTier(sorted.length, null),
    evidence: {
      metricCode,
      dataPointCount: sorted.length,
      supportingMetrics: {
        avgValue: round2(mean),
        percentChange: round2(pctChange),
        firstValue: round2(firstVal),
        lastValue: round2(lastVal),
        minValue: round2(min),
        maxValue: round2(max),
      },
      sessionCount: null,
      productName: null,
      productId: null,
    },
    metricCode,
  };
}

// Session Correlation Insight Rule

/**
 * Generate a session-correlation insight from recent session impact data.
 *
 * Compares baseline (before) metrics with during/after metrics to identify
 * session effects. Returns null if insufficient reliable sessions.
 */
export function computeSessionCorrelationInsight(
  domain: string,
  metricCode: string,
  impacts: readonly SessionImpactData[],
): InsightRuleResult | null {
  // Filter to reliable, READY impacts with non-null delta data
  const reliable = impacts.filter(
    (i) =>
      i.isReliable &&
      (i.status === 'READY' || i.status === 'PARTIAL') &&
      i.deltaDuringPct != null &&
      i.avgBefore != null,
  );

  if (reliable.length < MIN_RELIABLE_IMPACTS) return null;

  // Compute average delta across sessions
  let sumDeltaPct = 0;
  let sumBefore = 0;
  let sumDuring = 0;
  let withDuringCount = 0;

  for (const impact of reliable) {
    sumDeltaPct += impact.deltaDuringPct!;
    sumBefore += impact.avgBefore!;
    if (impact.avgDuring != null) {
      sumDuring += impact.avgDuring;
      withDuringCount++;
    }
  }

  const avgDeltaPct = sumDeltaPct / reliable.length;
  const avgBefore = sumBefore / reliable.length;
  const avgDuring = withDuringCount > 0 ? sumDuring / withDuringCount : null;

  // Only produce insight if the average delta is significant
  if (Math.abs(avgDeltaPct) < SIGNIFICANT_CHANGE_THRESHOLD_PCT) return null;

  const meta = getMetricMeta(metricCode);
  const direction = avgDeltaPct > 0 ? 'higher' : 'lower';
  const improving = (avgDeltaPct > 0) === meta.higherIsBetter;
  const displayType: InsightDisplayType = improving ? 'positive' : 'negative';
  const icon = improving ? 'check-circle-outline' : 'alert-circle-outline';

  const metric = `${Math.round(Math.abs(avgDeltaPct))}% ${direction} during sessions`;
  const beforeStr = meta.format(avgBefore);
  const duringStr = avgDuring != null ? meta.format(avgDuring) : 'N/A';

  const description =
    `${meta.label} is ${Math.round(Math.abs(avgDeltaPct))}% ${direction} during consumption sessions ` +
    `(baseline: ${beforeStr}, during sessions: ${duringStr}). ` +
    `Based on ${reliable.length} session${reliable.length > 1 ? 's' : ''}.`;

  return {
    domain,
    insightType: 'session_correlation' as InsightType,
    icon,
    metric,
    description,
    displayType,
    confidenceTier: computeConfidenceTier(reliable.length, reliable.length),
    evidence: {
      metricCode,
      dataPointCount: reliable.length,
      supportingMetrics: {
        avgDeltaPct: round2(avgDeltaPct),
        avgBefore: round2(avgBefore),
        ...(avgDuring != null ? { avgDuring: round2(avgDuring) } : {}),
        sessionCount: reliable.length,
      },
      sessionCount: reliable.length,
      productName: null,
      productId: null,
    },
    metricCode,
  };
}

// Product Effect Insight Rule

/**
 * Generate a product-specific effect insight from product impact rollup data.
 *
 * Picks the top product by |avgDeltaDuringPct| that is reliable and has
 * enough sessions. Returns null if no reliable product data.
 */
export function computeProductEffectInsight(
  domain: string,
  metricCode: string,
  products: readonly ProductImpactData[],
): InsightRuleResult | null {
  // Filter to READY, reliable products with enough sessions
  const reliable = products.filter(
    (p) =>
      p.isReliable &&
      (p.status === 'READY' || p.status === 'PARTIAL') &&
      p.sessionCount >= MIN_PRODUCT_SESSIONS &&
      p.avgDeltaDuringPct != null,
  );

  if (reliable.length === 0) return null;

  // Rank by |avgDeltaDuringPct| descending — strongest effect first
  const ranked = [...reliable].sort(
    (a, b) => Math.abs(b.avgDeltaDuringPct!) - Math.abs(a.avgDeltaDuringPct!),
  );

  const top = ranked[0]!;
  const deltaPct = top.avgDeltaDuringPct!;
  const absDelta = Math.abs(deltaPct);

  // Only produce insight if effect is significant
  if (absDelta < SIGNIFICANT_CHANGE_THRESHOLD_PCT) return null;

  const meta = getMetricMeta(metricCode);
  const direction = deltaPct > 0 ? 'increases' : 'decreases';
  const improving = (deltaPct > 0) === meta.higherIsBetter;
  const displayType: InsightDisplayType = improving ? 'positive' : 'negative';
  const icon = 'wellness';

  const metric = `${top.productName} ${direction} ${meta.label}`;
  const baselineStr = top.baselineValue != null ? ` from baseline ${meta.format(top.baselineValue)}` : '';

  const description =
    `Sessions with ${top.productName} are associated with ${Math.round(absDelta)}% ` +
    `${deltaPct > 0 ? 'higher' : 'lower'} ${meta.label}${baselineStr}. ` +
    `Based on ${top.sessionCount} sessions (confidence: ${top.confidenceTier}).`;

  return {
    domain,
    insightType: 'product_effect' as InsightType,
    icon,
    metric,
    description,
    displayType,
    confidenceTier: (top.confidenceTier as InsightConfidenceTier) ?? 'low',
    evidence: {
      metricCode,
      dataPointCount: top.sessionCount,
      supportingMetrics: {
        avgDeltaDuringPct: round2(deltaPct),
        ...(top.avgDeltaAfterPct != null ? { avgDeltaAfterPct: round2(top.avgDeltaAfterPct) } : {}),
        ...(top.baselineValue != null ? { baselineValue: round2(top.baselineValue) } : {}),
        sessionCount: top.sessionCount,
      },
      sessionCount: top.sessionCount,
      productName: top.productName,
      productId: top.productId,
    },
    metricCode,
  };
}

// Blood Oxygen Anomaly Rule

/**
 * Generate an anomaly insight for blood oxygen readings below safe thresholds.
 * Returns null if no readings below 95% or insufficient data.
 */
export function computeBloodOxygenAnomalyInsight(
  domain: string,
  rollups: readonly RollupDataPoint[],
): InsightRuleResult | null {
  const reliable = rollups.filter(
    (r) => (r.status === 'READY' || r.status === 'PARTIAL') && r.minVal != null,
  );
  if (reliable.length < MIN_TREND_DATA_POINTS) return null;

  let globalMin = Infinity;
  let belowCount = 0;
  for (const r of reliable) {
    const minV = r.minVal!;
    if (minV < globalMin) globalMin = minV;
    if (minV < 95) belowCount++;
  }

  if (globalMin >= 95) return null; // No anomaly

  const severity = globalMin < 90 ? 'negative' : 'primary';
  const icon = globalMin < 90 ? 'alert-circle' : 'alert-circle-outline';
  const metric = `SpO\u2082 dropped to ${globalMin.toFixed(1)}%`;
  const dayCount = `${belowCount} of ${reliable.length} days`;

  const description = globalMin < 90
    ? `Blood oxygen dropped below 90% (min: ${globalMin.toFixed(1)}%). ` +
      `Readings below 95% on ${dayCount}. Please consult a healthcare provider.`
    : `Blood oxygen dropped below 95% on ${dayCount} (min: ${globalMin.toFixed(1)}%). ` +
      `Consider monitoring for persistence.`;

  return {
    domain,
    insightType: 'anomaly' as InsightType,
    icon,
    metric,
    description,
    displayType: severity as InsightDisplayType,
    confidenceTier: computeConfidenceTier(reliable.length, null),
    evidence: {
      metricCode: 'blood_oxygen',
      dataPointCount: reliable.length,
      supportingMetrics: {
        minValue: round2(globalMin),
        daysBelow95: belowCount,
        totalDays: reliable.length,
      },
      sessionCount: null,
      productName: null,
      productId: null,
    },
    metricCode: 'blood_oxygen',
  };
}

// Rule Orchestration

/** Input bundle for all rules for a single metric. */
export interface MetricInsightInput {
  readonly domain: string;
  readonly metricCode: string;
  readonly rollups: readonly RollupDataPoint[];
  readonly sessionImpacts: readonly SessionImpactData[];
  readonly productImpacts: readonly ProductImpactData[];
}

/**
 * Run all applicable rules for a single metric and collect results.
 *
 * PURE FUNCTION: deterministic, no I/O.
 * Returns array of InsightRuleResult (may be empty if insufficient evidence).
 */
export function generateInsightsForMetric(input: MetricInsightInput): InsightRuleResult[] {
  const results: InsightRuleResult[] = [];

  // 1. Trend insight (always attempted)
  const trend = computeTrendInsight(input.domain, input.metricCode, input.rollups);
  if (trend) results.push(trend);

  // 2. Session correlation insight
  if (input.sessionImpacts.length >= MIN_CORRELATION_SESSIONS) {
    const correlation = computeSessionCorrelationInsight(
      input.domain, input.metricCode, input.sessionImpacts,
    );
    if (correlation) results.push(correlation);
  }

  // 3. Product effect insight
  if (input.productImpacts.length > 0) {
    const product = computeProductEffectInsight(
      input.domain, input.metricCode, input.productImpacts,
    );
    if (product) results.push(product);
  }

  // 4. Blood oxygen anomaly (domain-specific)
  if (input.metricCode === 'blood_oxygen') {
    const anomaly = computeBloodOxygenAnomalyInsight(input.domain, input.rollups);
    if (anomaly) results.push(anomaly);
  }

  return results;
}

/**
 * Sort insights by priority: anomaly > product_effect > session_correlation > trend.
 * Within same type, sort by confidence tier (high > medium > low).
 *
 * PURE FUNCTION.
 */
export function sortInsightsByPriority(insights: InsightRuleResult[]): InsightRuleResult[] {
  const TYPE_PRIORITY: Record<InsightType, number> = {
    anomaly: 4,
    product_effect: 3,
    session_correlation: 2,
    trend: 1,
  };

  const CONFIDENCE_PRIORITY: Record<InsightConfidenceTier, number> = {
    high: 3,
    medium: 2,
    low: 1,
  };

  return [...insights].sort((a, b) => {
    const typeDiff = TYPE_PRIORITY[b.insightType] - TYPE_PRIORITY[a.insightType];
    if (typeDiff !== 0) return typeDiff;
    return CONFIDENCE_PRIORITY[b.confidenceTier] - CONFIDENCE_PRIORITY[a.confidenceTier];
  });
}

// Utility

function round2(val: number): number {
  return Math.round(val * 100) / 100;
}
