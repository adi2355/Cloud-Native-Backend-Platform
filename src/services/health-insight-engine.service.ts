/**
 * Health Insight Engine — Orchestration Service
 *
 * Composes data fetches from existing repositories and delegates to pure
 * insight rules. Returns InsightDto[] ready for API response.
 *
 * DESIGN:
 * - Read-only (never writes to any table)
 * - Bounded: explicit caps on all dependency reads
 * - Graceful degradation with honest metadata: per-source failures are
 *   caught and tracked in sourceFailures. Individual source failure does
 *   NOT abort the entire request — surviving sources still produce insights.
 *   Callers MUST check allSourcesFailed/anySourceFailed to surface FAILED/PARTIAL.
 * - Deterministic: same data → same insights (no random/AI)
 *
 * LATENCY BUDGET (P99 target: 120ms):
 * - Rollup queries: 40ms (one query per metric, max 3 metrics per domain)
 * - Session impact queries: 40ms (one query per metric, bounded by limit)
 * - Product impact queries: 30ms (one query per metric, bounded by limit)
 * - Computation: 10ms (pure in-memory rules)
 *
 * TIMEOUT ENFORCEMENT: Each dependency call is wrapped in withTimeout().
 * Exceeding the per-query budget is treated as a source failure (same as
 * a DB error). This prevents a single slow query from dominating the
 * total P99 budget. Timeouts are logged at error level for alerting.
 *
 * BACKPRESSURE: A global AsyncSemaphore limits the number of concurrent
 * insight dependency queries across ALL concurrent requests. This prevents
 * DB connection pool exhaustion under load (Neon serverless default: 10
 * connections). Excess queries are queued up to MAX_PENDING_INSIGHT_QUERIES;
 * beyond that, the semaphore rejects immediately and the query is treated
 * as a source failure.
 *
 * @module services/health-insight-engine
 */

import type { HealthRollupDayRepository } from '../repositories/health-rollup-day.repository';
import type { SessionImpactSummaryRepository } from '../repositories/session-impact-summary.repository';
import type { ProductImpactRollupRepository } from '../repositories/product-impact-rollup.repository';
import type { UserHealthWatermarkRepository } from '../repositories/user-health-watermark.repository';
import type { LoggerService } from './logger.service';
import type { InsightDto } from '@shared/contracts';
import {
  buildInsightDto,
  INSIGHT_DOMAIN_METRICS,
  DEFAULT_INSIGHTS_LIMIT,
} from '@shared/contracts';
import {
  generateInsightsForMetric,
  sortInsightsByPriority,
} from './health-insight-rules';
import type {
  RollupDataPoint,
  SessionImpactData,
  ProductImpactData,
  MetricInsightInput,
} from './health-insight-rules';

// Constants

/** Max rollup rows per metric query (bounds DB scan). */
const MAX_ROLLUP_ROWS_PER_METRIC = 365;

/** Max recent session impacts per metric query. */
const MAX_SESSION_IMPACTS_PER_METRIC = 50;

/** Max product impact rows per metric query. */
const MAX_PRODUCT_IMPACTS_PER_METRIC = 20;

/**
 * Supported product impact period buckets.
 * Product impact rollups are pre-computed for fixed periods (7, 30, 90 days).
 */
const PRODUCT_IMPACT_PERIOD_BUCKETS = [7, 30, 90] as const;

/** Milliseconds per day (for date range calculation). */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Compute version for insight freshness metadata. */
const INSIGHT_COMPUTE_VERSION = 1;

// ---------------------------------------------------------------------------
// Per-Dependency Timeout Budgets (ms)
// ---------------------------------------------------------------------------
// Each dependency call is wrapped in withTimeout(). Exceeding the budget
// is treated identically to a source failure — the query returns [] with
// failed=true and the error is logged. This ensures a single slow query
// doesn't block the entire insight generation past its P99 target.
// ---------------------------------------------------------------------------

/** Timeout budget for a single rollup query. */
const ROLLUP_QUERY_BUDGET_MS = 40;

/** Timeout budget for a single session impact query. */
const SESSION_IMPACT_QUERY_BUDGET_MS = 40;

/** Timeout budget for a single product impact query. */
const PRODUCT_IMPACT_QUERY_BUDGET_MS = 30;

// ---------------------------------------------------------------------------
// Global Concurrency Limits (Backpressure)
// ---------------------------------------------------------------------------
// The engine is a singleton — these limits apply across ALL concurrent
// insight requests on this server instance. This prevents DB connection
// pool exhaustion under load (Neon serverless default: 10 connections).
//
// MAX_CONCURRENT: How many insight-dependency queries can run simultaneously.
// Set to 6 = enough for one full domain (2 metrics × 3 sources) with no
// queuing, or two domains' rollups running in parallel.
//
// MAX_PENDING: How many additional queries can queue while waiting for a slot.
// Set to 18 = ~3 concurrent requests' worth. Beyond this, reject immediately
// (load shedding). The caller's catch block treats it as a source failure.
// ---------------------------------------------------------------------------

/** Maximum concurrent insight dependency queries across all requests. */
export const MAX_CONCURRENT_INSIGHT_QUERIES = 6;

/** Maximum pending queries before shedding (reject with backpressure error). */
export const MAX_PENDING_INSIGHT_QUERIES = 18;

// AsyncSemaphore — Bounded Concurrency Pool

/**
 * Async semaphore for bounding concurrent operations.
 *
 * DESIGN:
 * - acquire() returns immediately if a slot is available
 * - If no slot: queues a waiter (FIFO) up to maxPending
 * - If queue is full: rejects immediately (load shedding)
 * - release() wakes the oldest waiter or frees the slot
 *
 * NOT a general-purpose utility — scoped to this module. If needed
 * elsewhere, extract to a shared utility with proper tests.
 */
export class AsyncSemaphore {
  private running = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxPending: number,
  ) {
    if (maxConcurrent < 1) throw new Error('maxConcurrent must be >= 1');
    if (maxPending < 0) throw new Error('maxPending must be >= 0');
  }

  /** Current number of running operations. */
  get activeCount(): number { return this.running; }

  /** Current number of queued waiters. */
  get pendingCount(): number { return this.waiters.length; }

  /**
   * Acquire a slot. Resolves when a slot is available, or rejects
   * immediately if the pending queue is full (backpressure).
   */
  acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return Promise.resolve();
    }

    if (this.waiters.length >= this.maxPending) {
      return Promise.reject(
        new Error(`Insight query backpressure: ${this.waiters.length} pending (max ${this.maxPending})`),
      );
    }

    return new Promise<void>((resolve) => {
      // The waiter callback does NOT increment running — the slot is
      // "transferred" by release() (running stays the same). Only the
      // fast-path above (no queuing) increments running.
      this.waiters.push(() => resolve());
    });
  }

  /**
   * Release a slot. Wakes the oldest waiter if any are queued.
   * MUST be called in a finally block after acquire().
   *
   * SLOT TRANSFER: When a waiter exists, the slot is not freed — it's
   * transferred to the next waiter (running stays the same). When no
   * waiter exists, the slot is actually freed (running decrements).
   */
  release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Transfer the slot to the next waiter. running stays the same
      // because the waiter "takes over" the slot from the releaser.
      next();
    } else {
      this.running--;
    }
  }
}

// Result Type

/**
 * Result from insight generation.
 *
 * Tracks per-source failures so callers can distinguish
 * "no insights because no data" from "no insights because all sources failed".
 */
export interface InsightGenerationResult {
  readonly insights: InsightDto[];
  /** Watermark fetched during generation (avoids redundant re-fetch). */
  readonly sourceWatermark: string;
  /** Per-source failure tracking. True = fetch threw an error (logged). */
  readonly sourceFailures: {
    readonly rollupsFailed: boolean;
    readonly sessionImpactsFailed: boolean;
    readonly productImpactsFailed: boolean;
  };
  /** True when ALL data sources failed — callers should surface as FAILED. */
  readonly allSourcesFailed: boolean;
  /** True when at least one source failed but not all. Callers should surface as PARTIAL. */
  readonly anySourceFailed: boolean;
}

// Engine Service

export class HealthInsightEngineService {
  /**
   * Global concurrency limiter for insight dependency queries.
   *
   * Shared across all concurrent requests because this service is a singleton
   * (one instance per server, wired in bootstrap.ts). This ensures that even
   * under high concurrent load, the total number of parallel DB queries from
   * the insight engine is bounded.
   */
  private readonly semaphore = new AsyncSemaphore(
    MAX_CONCURRENT_INSIGHT_QUERIES,
    MAX_PENDING_INSIGHT_QUERIES,
  );

  constructor(
    private readonly rollupRepo: HealthRollupDayRepository,
    private readonly sessionImpactRepo: SessionImpactSummaryRepository,
    private readonly productImpactRepo: ProductImpactRollupRepository,
    private readonly watermarkRepo: UserHealthWatermarkRepository,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Generate insights for a domain and date range.
   *
   * Returns InsightGenerationResult with per-source failure tracking.
   * Callers MUST check allSourcesFailed to surface FAILED vs EMPTY state.
   *
   * Partial failure is acceptable: if rollups fail but session impacts succeed,
   * correlation insights are still returned. Only TOTAL failure (all 3 sources)
   * must surface as FAILED to the client.
   *
   * @param userId - Authenticated user ID (IDOR-safe: all queries scoped)
   * @param domain - Insight domain (hrv, sleep, respiratory)
   * @param startDate - Start of analysis window (ISO date string)
   * @param endDate - End of analysis window (ISO date string)
   * @param limit - Max insights to return
   * @returns InsightGenerationResult with insights + failure metadata
   */
  async generateInsights(
    userId: string,
    domain: string,
    startDate: string,
    endDate: string,
    limit: number = DEFAULT_INSIGHTS_LIMIT,
  ): Promise<InsightGenerationResult> {
    const metricCodes = INSIGHT_DOMAIN_METRICS[domain];
    if (!metricCodes || metricCodes.length === 0) {
      this.logger.warn('Unknown insight domain requested', {
        context: 'HealthInsightEngine.generateInsights',
        userId,
        domain,
      });
      return {
        insights: [],
        sourceWatermark: '0',
        sourceFailures: { rollupsFailed: false, sessionImpactsFailed: false, productImpactsFailed: false },
        allSourcesFailed: false,
        anySourceFailed: false,
      };
    }

    // Fetch watermark for freshness metadata (exposed for caller reuse)
    let sourceWatermark = '0';
    try {
      const wm = await this.watermarkRepo.getSequenceNumber(userId);
      if (wm != null) sourceWatermark = wm.toString();
    } catch (error) {
      this.logger.warn('Watermark fetch failed for insight generation', {
        context: 'HealthInsightEngine.generateInsights',
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Continue without watermark — insights degrade gracefully
    }

    const startDateObj = new Date(startDate + 'T00:00:00.000Z');
    const endDateObj = new Date(endDate + 'T23:59:59.999Z');
    const dateRange = { startDate, endDate };

    // Fetch data for all metrics in parallel (bounded per-query)
    // Track per-source failures across all metrics
    let anyRollupFailed = false;
    let anySessionImpactFailed = false;
    let anyProductImpactFailed = false;

    const metricInputs = await Promise.all(
      metricCodes.map(async (metricCode) => {
        const result = await this.fetchMetricData(userId, domain, metricCode, startDateObj, endDateObj);
        if (result.rollupFailed) anyRollupFailed = true;
        if (result.sessionImpactFailed) anySessionImpactFailed = true;
        if (result.productImpactFailed) anyProductImpactFailed = true;
        return result.input;
      }),
    );

    const sourceFailures = {
      rollupsFailed: anyRollupFailed,
      sessionImpactsFailed: anySessionImpactFailed,
      productImpactsFailed: anyProductImpactFailed,
    };
    const allSourcesFailed = anyRollupFailed && anySessionImpactFailed && anyProductImpactFailed;
    const anySourceFailed = anyRollupFailed || anySessionImpactFailed || anyProductImpactFailed;

    // Run pure rule engine for each metric
    const allRuleResults = metricInputs.flatMap((input) =>
      generateInsightsForMetric(input),
    );

    // Sort by priority, cap at limit
    const sorted = sortInsightsByPriority(allRuleResults);
    const capped = sorted.slice(0, limit);

    // Map to DTOs — mark data quality as PARTIAL_TRUNCATED when any source failed.
    // This gives consumers an honest signal that some insight types may be missing
    // due to upstream failures (e.g., no trend insights when rollup source failed).
    const effectiveDataQuality = anySourceFailed && !allSourcesFailed
      ? ('PARTIAL_TRUNCATED' as const)
      : ('FULL' as const);

    const insights = capped.map((rule) =>
      buildInsightDto(rule, dateRange, sourceWatermark, INSIGHT_COMPUTE_VERSION, effectiveDataQuality),
    );

    this.logger.debug('Insights generated', {
      context: 'HealthInsightEngine.generateInsights',
      userId,
      domain,
      dateRange,
      metricsQueried: metricCodes.length,
      totalRuleResults: allRuleResults.length,
      insightsReturned: insights.length,
      sourceFailures,
      allSourcesFailed,
      anySourceFailed,
      effectiveDataQuality,
    });

    return { insights, sourceWatermark, sourceFailures, allSourcesFailed, anySourceFailed };
  }

  // Private: Timeout Enforcement

  /**
   * Run an async function with a timeout budget.
   *
   * If the function does not settle within `timeoutMs`, rejects with
   * a descriptive Error. The timer is properly cleaned up on success
   * to prevent leaks.
   *
   * DESIGN: The underlying query continues running in the background
   * (Node.js has no cooperative cancellation for Prisma queries). The
   * timeout merely unblocks the caller. This is acceptable because:
   * 1. The query will complete on its own (bounded by DB statement_timeout)
   * 2. The caller treats timeout as a source failure (data: [], failed: true)
   * 3. The engine's total latency is bounded even if the query finishes late
   *
   * @param label - Human-readable label for logging
   * @param timeoutMs - Maximum milliseconds to wait
   * @param fn - Async function to execute
   * @returns The function's result if it settles within budget
   * @throws Error with timeout details if budget is exceeded
   */
  private withTimeout<T>(
    label: string,
    timeoutMs: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`${label} exceeded ${timeoutMs}ms timeout budget`));
        }
      }, timeoutMs);

      fn().then(
        (val) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(val);
          }
        },
        (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        },
      );
    });
  }

  // Private: Backpressure-Aware Fetch Wrapper

  /**
   * Run a query with both concurrency limiting AND timeout enforcement.
   *
   * Flow: acquire semaphore slot → run query with timeout → release slot.
   *
   * BACKPRESSURE: If the semaphore's pending queue is full, acquire()
   * rejects immediately. The caller's catch block treats this identically
   * to a DB error (data: [], failed: true).
   *
   * TIMEOUT: Covers only the actual query execution, NOT semaphore wait time.
   * This is intentional — semaphore wait is bounded by MAX_PENDING (excess
   * is shed immediately), while the timeout ensures each individual query
   * doesn't exceed its P99 budget.
   *
   * RELEASE SAFETY: The semaphore slot is released in a finally block,
   * ensuring it's freed even when the timeout fires (the underlying query
   * continues in the background per Node.js limitations, but the slot is
   * freed for other queries).
   *
   * @param label - Human-readable label for logging
   * @param timeoutMs - Per-query timeout budget (ms)
   * @param fn - Async function that executes the actual DB query
   * @returns The query result
   * @throws Error on backpressure rejection or timeout
   */
  private async fetchWithBackpressure<T>(
    label: string,
    timeoutMs: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    await this.semaphore.acquire();
    try {
      return await this.withTimeout(label, timeoutMs, fn);
    } finally {
      this.semaphore.release();
    }
  }

  // Private: Data Fetching (Bounded + Timeout-Guarded + Backpressure)

  /** Result from fetchMetricData with per-source failure tracking. */
  private async fetchMetricData(
    userId: string,
    domain: string,
    metricCode: string,
    startDate: Date,
    endDate: Date,
  ): Promise<{
    input: MetricInsightInput;
    rollupFailed: boolean;
    sessionImpactFailed: boolean;
    productImpactFailed: boolean;
  }> {
    // Fetch in parallel: rollups + session impacts + product impacts
    // v27: Pass date range to session impacts and product impacts for
    // evidence scoping. Previously only rollups were date-scoped.
    const [rollupResult, sessionResult, productResult] = await Promise.all([
      this.fetchRollups(userId, metricCode, startDate, endDate),
      this.fetchSessionImpacts(userId, metricCode, startDate, endDate),
      this.fetchProductImpacts(userId, metricCode, startDate, endDate),
    ]);

    return {
      input: {
        domain,
        metricCode,
        rollups: rollupResult.data,
        sessionImpacts: sessionResult.data,
        productImpacts: productResult.data,
      },
      rollupFailed: rollupResult.failed,
      sessionImpactFailed: sessionResult.failed,
      productImpactFailed: productResult.failed,
    };
  }

  private async fetchRollups(
    userId: string,
    metricCode: string,
    startDate: Date,
    endDate: Date,
  ): Promise<{ data: RollupDataPoint[]; failed: boolean }> {
    try {
      const rows = await this.fetchWithBackpressure(
        'rollup_query',
        ROLLUP_QUERY_BUDGET_MS,
        () => this.rollupRepo.findByUserMetricDateRange(
          userId,
          metricCode,
          startDate,
          endDate,
          MAX_ROLLUP_ROWS_PER_METRIC,
        ),
      );

      return {
        data: rows.map((r) => {
          const sumNum = safeDecimalToNumber(r.sumVal);
          return {
            dayUtc: r.dayUtc.toISOString(),
            avgVal: sumNum != null && r.countVal > 0
              ? sumNum / r.countVal
              : null,
            minVal: safeDecimalToNumber(r.minVal),
            maxVal: safeDecimalToNumber(r.maxVal),
            countVal: r.countVal,
            status: r.status,
          };
        }),
        failed: false,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const isBackpressure = errorMsg.includes('backpressure');
      const isTimeout = errorMsg.includes('timeout budget');
      this.logger.error('Rollup fetch failed for insight metric', {
        context: 'HealthInsightEngine.fetchRollups',
        userId,
        metricCode,
        error: errorMsg,
        isTimeout,
        isBackpressure,
      });
      return { data: [], failed: true };
    }
  }

  private async fetchSessionImpacts(
    userId: string,
    metricCode: string,
    startDate: Date,
    endDate: Date,
  ): Promise<{ data: SessionImpactData[]; failed: boolean }> {
    try {
      // v27: Pass date range to scope session impacts to the requested window.
      // Previously fetched "most recent" without date filtering, which included
      // out-of-range evidence (e.g., sessions from 6 months after the requested range).
      const rows = await this.fetchWithBackpressure(
        'session_impact_query',
        SESSION_IMPACT_QUERY_BUDGET_MS,
        () => this.sessionImpactRepo.findRecentByUserAndMetric(
          userId,
          metricCode,
          MAX_SESSION_IMPACTS_PER_METRIC,
          startDate,
          endDate,
        ),
      );

      // Filter out rows with missing session join data — don't fabricate timestamps.
      // Session deletion or orphaned impacts should not produce bogus evidence.
      const validRows = rows.filter((r) => r.session?.sessionStartTimestamp != null);

      return {
        data: validRows.map((r) => ({
          sessionId: r.sessionId,
          metricCode: r.metricCode,
          avgBefore: safeDecimalToNumber(r.avgBefore),
          avgDuring: safeDecimalToNumber(r.avgDuring),
          avgAfter: safeDecimalToNumber(r.avgAfter),
          deltaDuringPct: safeDecimalToNumber(r.deltaDuringPct),
          deltaAfterPct: safeDecimalToNumber(r.deltaAfterPct),
          isReliable: r.isReliable,
          status: r.status,
          productName: r.session?.primaryProduct?.name ?? null,
          productId: r.session?.primaryProduct?.id ?? null,
          // Non-null guaranteed by the filter above
          sessionStartTs: r.session!.sessionStartTimestamp!.toISOString(),
        })),
        failed: false,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const isBackpressure = errorMsg.includes('backpressure');
      const isTimeout = errorMsg.includes('timeout budget');
      this.logger.error('Session impact fetch failed for insight metric', {
        context: 'HealthInsightEngine.fetchSessionImpacts',
        userId,
        metricCode,
        error: errorMsg,
        isTimeout,
        isBackpressure,
      });
      return { data: [], failed: true };
    }
  }

  private async fetchProductImpacts(
    userId: string,
    metricCode: string,
    startDate: Date,
    endDate: Date,
  ): Promise<{ data: ProductImpactData[]; failed: boolean }> {
    try {
      // v27: Select the best period bucket that matches the requested date range.
      // Product impact rollups are pre-computed for fixed periods (7, 30, 90 days).
      // Previously hardcoded to 90 regardless of requested range — a 7-day insight
      // query would use 90-day aggregation, misrepresenting the evidence window.
      const periodDays = selectBestPeriodDays(startDate, endDate);

      const rows = await this.fetchWithBackpressure(
        'product_impact_query',
        PRODUCT_IMPACT_QUERY_BUDGET_MS,
        () => this.productImpactRepo.findByUserAndMetric(
          userId,
          metricCode,
          undefined, // default minSessions
          MAX_PRODUCT_IMPACTS_PER_METRIC,
          periodDays,
        ),
      );

      // Filter out rows with missing product join data — don't fabricate names.
      // Deleted products should not produce "Unknown Product" in insights.
      const validRows = rows.filter((r) => r.product?.name != null);

      // Date overlap filter: ensure product impact evidence window overlaps
      // the requested insight date range. selectBestPeriodDays() picks the
      // closest bucket, but the row's actual computation window (periodStart/
      // periodEnd) may not overlap the requested [startDate, endDate].
      // Example: insight query for Jan 15-22, bucket 7 → but the 7-day row
      // was computed for Dec 25-31 → evidence is from the wrong window.
      // Rows without period bounds are included (backward compat / NO_DATA markers).
      const dateScoped = validRows.filter((r) => {
        if (r.periodStart == null || r.periodEnd == null) return true;
        // Standard overlap: [A, B] ∩ [C, D] ≠ ∅  iff  A <= D && B >= C
        return r.periodStart <= endDate && r.periodEnd >= startDate;
      });

      return {
        data: dateScoped.map((r) => ({
          productId: r.productId,
          // Non-null guaranteed by the filter above
          productName: r.product!.name!,
          metricCode: r.metricCode,
          avgDeltaDuringPct: safeDecimalToNumber(r.avgDeltaDuringPct),
          avgDeltaAfterPct: safeDecimalToNumber(r.avgDeltaAfterPct),
          baselineValue: safeDecimalToNumber(r.baselineValue),
          sessionCount: r.sessionCount,
          minSessionsRequired: r.minSessionsRequired,
          isReliable: r.isReliable,
          confidenceTier: r.confidenceTier,
          confidenceScore: safeDecimalToNumber(r.confidenceScore),
          status: r.status,
        })),
        failed: false,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const isBackpressure = errorMsg.includes('backpressure');
      const isTimeout = errorMsg.includes('timeout budget');
      this.logger.error('Product impact fetch failed for insight metric', {
        context: 'HealthInsightEngine.fetchProductImpacts',
        userId,
        metricCode,
        error: errorMsg,
        isTimeout,
        isBackpressure,
      });
      return { data: [], failed: true };
    }
  }
}

// Utility

/**
 * Convert Prisma Decimal-like value to number.
 * Handles: Prisma.Decimal (has toNumber()), number, null.
 */
function safeDecimalToNumber(val: unknown): number | null {
  if (val == null) return null;
  if (typeof val === 'number') return val;
  if (typeof val === 'object' && 'toNumber' in (val as object) && typeof (val as { toNumber: unknown }).toNumber === 'function') {
    return (val as { toNumber: () => number }).toNumber();
  }
  const parsed = Number(val);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Select the best product impact period bucket for a given date range.
 *
 * Product impact rollups are pre-computed for fixed periods (7, 30, 90 days).
 * This function picks the smallest bucket that is >= the requested range,
 * so the evidence window roughly matches the insight query window.
 *
 * PURE FUNCTION: deterministic, no side effects.
 *
 * @param startDate - Start of the requested analysis window
 * @param endDate - End of the requested analysis window
 * @returns Best matching period in days (7, 30, or 90)
 */
export function selectBestPeriodDays(startDate: Date, endDate: Date): number {
  const rangeDays = Math.ceil((endDate.getTime() - startDate.getTime()) / MS_PER_DAY);
  // Pick the smallest bucket that covers the requested range.
  // If range is 10 days → 30 (7 is too small). If range is 60 → 90. If range is 3 → 7.
  for (const bucket of PRODUCT_IMPACT_PERIOD_BUCKETS) {
    if (rangeDays <= bucket) return bucket;
  }
  // Range exceeds all buckets — use the largest available.
  // Non-null assertion safe: PRODUCT_IMPACT_PERIOD_BUCKETS is a compile-time constant with 3 elements.
  return PRODUCT_IMPACT_PERIOD_BUCKETS[PRODUCT_IMPACT_PERIOD_BUCKETS.length - 1]!;
}
