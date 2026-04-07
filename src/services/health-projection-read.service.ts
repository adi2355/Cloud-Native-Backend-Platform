/**
 * Health Projection Read Service
 *
 * Thin read service for querying derived health projection data.
 * Maps DB rows to DTOs using pure mapper functions from shared contracts.
 *
 * ARCHITECTURE:
 * - Read-only: no mutations, no side effects
 * - Pure DI: all dependencies injected via constructor
 * - Fail-fast: throws on missing dependencies
 * - User-scoped: all queries filter by userId to prevent IDOR
 * - Watermark-based freshness: on read, compares current watermark against
 *   each row's sourceWatermark. If watermark > sourceWatermark, overrides
 *   freshness to STALE (internal design spec:1145 contract).
 *
 * @see health-projection.contract.ts for DTO types and mappers
 * @see health-projection-coordinator.service.ts for write-side projection handlers
 */

import { HealthRollupDayRepository } from '../repositories/health-rollup-day.repository';
import { SleepNightSummaryRepository } from '../repositories/sleep-night-summary.repository';
import { SessionImpactSummaryRepository } from '../repositories/session-impact-summary.repository';
import { ProductImpactRollupRepository } from '../repositories/product-impact-rollup.repository';
import { UserHealthWatermarkRepository } from '../repositories/user-health-watermark.repository';
import { LoggerService } from './logger.service';
import { HealthInsightEngineService } from './health-insight-engine.service';
import {
  toHealthRollupDayDto,
  toSleepNightSummaryDto,
  toSessionImpactDto,
  toRecentSessionImpactDto,
  toProductImpactDto,
  buildProjectionResponseSummary,
  encodeRollupCursor,
  decodeRollupCursor,
  SUPPORTED_PERIOD_DAYS,
  DEFAULT_ROLLUP_PAGE_LIMIT,
  DEFAULT_RECENT_IMPACT_LIMIT,
  DEFAULT_PRODUCT_IMPACT_LIMIT,
  type PeriodKey,
  type HealthRollupDayDto,
  type SleepNightSummaryDto,
  type SessionImpactDto,
  type RecentSessionImpactDto,
  type ProductImpactDto,
  type InsightDto,
  type ProjectionResponseSummary,
  type ProjectionFreshnessMeta,
  type PaginationMeta,
} from '@shared/contracts';

/**
 * Result type for projection read queries.
 *
 * Bundles items with a summary that resolves the empty-response ambiguity:
 * when items=[], the summary.state tells the client WHY (EMPTY vs COMPUTING vs NO_DATA).
 */
export interface ProjectionReadResult<T> {
  readonly items: T[];
  readonly summary: ProjectionResponseSummary;
}

/**
 * Paginated result type for projection read queries.
 *
 * Extends ProjectionReadResult with cursor-based pagination metadata.
 */
export interface PaginatedProjectionReadResult<T> extends ProjectionReadResult<T> {
  readonly pagination: PaginationMeta;
}

/**
 * Structural type for any DTO that has freshness metadata.
 * Used by the watermark freshness override helper.
 */
interface WithFreshness {
  readonly freshness: ProjectionFreshnessMeta;
}

export class HealthProjectionReadService {
  constructor(
    private readonly rollupRepo: HealthRollupDayRepository,
    private readonly sleepRepo: SleepNightSummaryRepository,
    private readonly sessionImpactRepo: SessionImpactSummaryRepository,
    private readonly productImpactRepo: ProductImpactRollupRepository,
    private readonly logger: LoggerService,
    private readonly watermarkRepo: UserHealthWatermarkRepository,
  ) {
    // Fail-fast: all dependencies are required
    if (!rollupRepo) throw new Error('HealthProjectionReadService: rollupRepo is required');
    if (!sleepRepo) throw new Error('HealthProjectionReadService: sleepRepo is required');
    if (!sessionImpactRepo) throw new Error('HealthProjectionReadService: sessionImpactRepo is required');
    if (!productImpactRepo) throw new Error('HealthProjectionReadService: productImpactRepo is required');
    if (!logger) throw new Error('HealthProjectionReadService: logger is required');
    if (!watermarkRepo) throw new Error('HealthProjectionReadService: watermarkRepo is required');
  }

  /**
   * Apply watermark-based freshness override on read.
   *
   * internal design spec:1145 CONTRACT: On read, if current watermark > row's sourceWatermark,
   * the data is STALE (newer samples exist that haven't been projected yet).
   *
   * OVERRIDE RULES:
   * - READY → STALE (data exists but is behind the source)
   * - NO_DATA, COMPUTING, FAILED, STALE → unchanged (already non-fresh or empty)
   *
   * This is a PURE function over the items — it does NOT mutate the input array.
   * Returns a new array with overridden freshness and a rebuilt summary.
   *
   * INVARIANT: Single watermark query per read call (not per row).
   *
   * @param userId - User ID for watermark lookup
   * @param items - DTOs with freshness metadata
   * @returns Items with watermark-aware freshness and rebuilt summary
   */
  private async applyWatermarkFreshness<T extends WithFreshness>(
    userId: string,
    items: T[],
    precomputedWatermark?: bigint | null,
  ): Promise<{ items: T[]; summary: ProjectionResponseSummary }> {
    // Early exit: no items → no watermark check needed
    if (items.length === 0) {
      return { items, summary: buildProjectionResponseSummary(items) };
    }

    // Use pre-computed watermark when available (avoids redundant DB query).
    // Callers that already fetched the watermark (e.g., InsightEngine) pass it in.
    const currentWatermark = precomputedWatermark !== undefined
      ? precomputedWatermark
      : await this.watermarkRepo.getSequenceNumber(userId);

    // No watermark row → user has no health data mutations yet.
    // All items keep their stored freshness (likely NO_DATA or initial READY).
    if (currentWatermark == null) {
      return { items, summary: buildProjectionResponseSummary(items) };
    }

    let overrideCount = 0;

    const overriddenItems = items.map((item) => {
      // Only override READY items. Items that are already FAILED, COMPUTING,
      // NO_DATA, or STALE should keep their stored status — they carry different
      // semantic meaning that the watermark check doesn't supersede.
      if (item.freshness.status !== 'READY') {
        return item;
      }

      // Compare current watermark against the row's sourceWatermark.
      // sourceWatermark is serialized as string in the DTO (bigintToString).
      // Use BigInt for precision-safe comparison.
      const rowWatermark = BigInt(item.freshness.sourceWatermark);
      if (currentWatermark > rowWatermark) {
        overrideCount++;
        return {
          ...item,
          freshness: {
            ...item.freshness,
            status: 'STALE' as const,
          },
        };
      }

      return item;
    });

    if (overrideCount > 0) {
      this.logger.debug('Watermark freshness override applied', {
        context: 'HealthProjectionReadService.applyWatermarkFreshness',
        userId,
        currentWatermark: currentWatermark.toString(),
        totalItems: items.length,
        overriddenToStale: overrideCount,
      });
    }

    // Rebuild summary AFTER freshness override so summary.state reflects live state
    const summary = buildProjectionResponseSummary(overriddenItems);
    return { items: overriddenItems, summary };
  }

  /**
   * Get daily health rollups for a user/metric within a date range.
   *
   * Supports optional cursor-based pagination. When cursor/limit are omitted,
   * applies DEFAULT_ROLLUP_PAGE_LIMIT as a cap (Finding 2 fix).
   *
   * @param userId - User ID
   * @param metricCode - Metric code to query
   * @param startDate - Start date (inclusive, YYYY-MM-DD)
   * @param endDate - End date (inclusive, YYYY-MM-DD)
   * @param cursor - Optional opaque cursor from previous page
   * @param limit - Optional page size (defaults to DEFAULT_ROLLUP_PAGE_LIMIT when cursor is provided)
   * @returns Items, summary, and pagination metadata
   */
  async getRollups(
    userId: string,
    metricCode: string,
    startDate: string,
    endDate: string,
    cursor?: string,
    limit?: number,
  ): Promise<PaginatedProjectionReadResult<HealthRollupDayDto>> {
    this.logger.debug('Fetching health rollups', {
      context: 'HealthProjectionReadService.getRollups',
      userId,
      metricCode,
      startDate,
      endDate,
      hasCursor: cursor != null,
      limit,
    });

    // If pagination params are provided, use paginated path
    const usePagination = cursor != null || limit != null;

    if (usePagination) {
      return this.getRollupsPaginated(userId, metricCode, startDate, endDate, cursor, limit);
    }

    // FINDING 2 FIX: Legacy path now bounded by DEFAULT_ROLLUP_PAGE_LIMIT.
    // Prevents unbounded responses that violate P99 latency targets.
    // Ordering unified to ASC (consistent with paginated path).
    this.logger.debug('Legacy rollup path used (no cursor/limit) — applying default cap', {
      context: 'HealthProjectionReadService.getRollups',
      userId,
      metricCode,
      defaultLimit: DEFAULT_ROLLUP_PAGE_LIMIT,
    });

    const rows = await this.rollupRepo.findByUserMetricDateRange(
      userId,
      metricCode,
      new Date(startDate),
      new Date(endDate),
      DEFAULT_ROLLUP_PAGE_LIMIT,
    );

    // Detect if more rows exist beyond the cap
    const hasMore = rows.length > DEFAULT_ROLLUP_PAGE_LIMIT;
    const pageRows = hasMore ? rows.slice(0, DEFAULT_ROLLUP_PAGE_LIMIT) : rows;

    const mappedItems = pageRows.map(toHealthRollupDayDto);

    // FINDING 1 FIX: Apply watermark-based freshness override
    const { items, summary } = await this.applyWatermarkFreshness(userId, mappedItems);

    // Encode cursor from the last row so clients can paginate if needed
    const lastItem = items[items.length - 1];
    const nextCursor = hasMore && lastItem
      ? encodeRollupCursor(lastItem.dayUtc, lastItem.metricCode, lastItem.id)
      : null;

    return {
      items,
      summary,
      pagination: {
        nextCursor,
        hasMore,
        returnedCount: items.length,
      },
    };
  }

  /**
   * Paginated rollup query using keyset (cursor) pagination.
   *
   * Fetches limit+1 rows from the repository to detect hasMore without
   * a separate COUNT query. The extra row is not included in the response.
   */
  private async getRollupsPaginated(
    userId: string,
    metricCode: string,
    startDate: string,
    endDate: string,
    cursor?: string,
    limit?: number,
  ): Promise<PaginatedProjectionReadResult<HealthRollupDayDto>> {
    const effectiveLimit = limit ?? DEFAULT_ROLLUP_PAGE_LIMIT;

    // Decode cursor (fail-fast on malformed cursor — throws)
    const decodedCursor = cursor != null ? decodeRollupCursor(cursor) : undefined;

    const rows = await this.rollupRepo.findByUserMetricDateRangePaginated(
      userId,
      metricCode,
      new Date(startDate),
      new Date(endDate),
      effectiveLimit,
      decodedCursor,
    );

    // If we got limit+1 rows, there are more pages
    const hasMore = rows.length > effectiveLimit;
    const pageRows = hasMore ? rows.slice(0, effectiveLimit) : rows;

    const mappedItems = pageRows.map(toHealthRollupDayDto);

    // FINDING 1 FIX: Apply watermark-based freshness override
    const { items, summary } = await this.applyWatermarkFreshness(userId, mappedItems);

    // Encode cursor from the last row's composite key
    const lastItem = items[items.length - 1];
    const nextCursor = hasMore && lastItem
      ? encodeRollupCursor(lastItem.dayUtc, lastItem.metricCode, lastItem.id)
      : null;

    return {
      items,
      summary,
      pagination: {
        nextCursor,
        hasMore,
        returnedCount: items.length,
      },
    };
  }

  /**
   * Get sleep night summaries for a user within a date range.
   *
   * @param userId - User ID
   * @param startDate - Start night date (inclusive, YYYY-MM-DD)
   * @param endDate - End night date (inclusive, YYYY-MM-DD)
   * @returns Items and summary with derived state
   */
  async getSleepSummaries(
    userId: string,
    startDate: string,
    endDate: string,
  ): Promise<ProjectionReadResult<SleepNightSummaryDto>> {
    this.logger.debug('Fetching sleep summaries', {
      context: 'HealthProjectionReadService.getSleepSummaries',
      userId,
      startDate,
      endDate,
    });

    const rows = await this.sleepRepo.findByUserDateRange(
      userId,
      new Date(startDate),
      new Date(endDate),
    );

    const mappedItems = rows.map(toSleepNightSummaryDto);

    // FINDING 1 FIX: Apply watermark-based freshness override
    const { items, summary } = await this.applyWatermarkFreshness(userId, mappedItems);
    return { items, summary };
  }

  /**
   * Get session impact summaries for a specific session.
   *
   * SECURITY: Uses findBySessionAndUser (not findBySession) to prevent IDOR.
   *
   * @param sessionId - Session ID (UUID)
   * @param userId - User ID (authorization scope)
   * @returns Items and summary with derived state
   */
  async getSessionImpact(
    sessionId: string,
    userId: string,
  ): Promise<ProjectionReadResult<SessionImpactDto>> {
    this.logger.debug('Fetching session impact', {
      context: 'HealthProjectionReadService.getSessionImpact',
      userId,
      sessionId,
    });

    const rows = await this.sessionImpactRepo.findBySessionAndUser(sessionId, userId);

    const mappedItems = rows.map(toSessionImpactDto);

    // FINDING 1 FIX: Apply watermark-based freshness override
    const { items, summary } = await this.applyWatermarkFreshness(userId, mappedItems);
    return { items, summary };
  }

  /**
   * Get recent session impact summaries for a user/metric,
   * enriched with session timestamps and product metadata.
   *
   * SECURITY: Uses user-scoped repository query to prevent IDOR.
   * FRESHNESS: Applies watermark-based freshness override on read.
   *
   * Only includes COMPLETED sessions with an end timestamp.
   * Ordered by session start time DESC (most recent first).
   *
   * @param userId - User ID (authorization scope)
   * @param metricCode - Metric code to query
   * @param limit - Optional page size (defaults to DEFAULT_RECENT_IMPACT_LIMIT)
   * @returns Items and summary with derived state
   */
  async getRecentSessionImpacts(
    userId: string,
    metricCode: string,
    limit?: number,
  ): Promise<ProjectionReadResult<RecentSessionImpactDto>> {
    const effectiveLimit = limit ?? DEFAULT_RECENT_IMPACT_LIMIT;

    this.logger.debug('Fetching recent session impacts', {
      context: 'HealthProjectionReadService.getRecentSessionImpacts',
      userId,
      metricCode,
      limit: effectiveLimit,
    });

    const rows = await this.sessionImpactRepo.findRecentByUserAndMetric(
      userId,
      metricCode,
      effectiveLimit,
    );

    const mappedItems = rows.map(toRecentSessionImpactDto);

    // Apply watermark-based freshness override (consistent with all other read endpoints)
    const { items, summary } = await this.applyWatermarkFreshness(userId, mappedItems);
    return { items, summary };
  }

  /**
   * Get product impact rollups for a user.
   *
   * Three query modes:
   * 1. **By single metric** (metricCode): All products ranked by ABS(avgDeltaAfterPct) DESC.
   *    Filtered by minSessions. Used for "Which products affect my heart rate most?"
   * 2. **By multiple metrics** (metricCodes): All products across multiple metrics.
   *    Used for cross-metric comparison (internal design spec:3028 multi-metric grouped queries).
   * 3. **By product**: Single product detail, optionally filtered by metric.
   *    Used for "How does Product X affect all my metrics?"
   *
   * All queries are filtered by periodDays (internal design spec:2327 lookback window variant).
   *
   * SECURITY: All queries are user-scoped (IDOR prevention via userId filter).
   * FRESHNESS: Applies watermark-based freshness override on read.
   *
   * @param userId - User ID (authorization scope)
   * @param options - Query options: metricCode/metricCodes, period, productId, minSessions, limit
   * @returns Items and summary with derived state
   */
  async getProductImpact(
    userId: string,
    options: {
      metricCode?: string;
      metricCodes?: string[];
      period?: PeriodKey;
      productId?: string;
      minSessions?: number;
      limit?: number;
    } = {},
  ): Promise<ProjectionReadResult<ProductImpactDto>> {
    const effectiveLimit = options.limit ?? DEFAULT_PRODUCT_IMPACT_LIMIT;
    const periodDays = SUPPORTED_PERIOD_DAYS[options.period ?? '90d'];

    // Resolve effective metric codes: metricCodes takes precedence over metricCode
    const effectiveMetricCodes = options.metricCodes
      ?? (options.metricCode ? [options.metricCode] : []);

    this.logger.debug('Fetching product impact rollups', {
      context: 'HealthProjectionReadService.getProductImpact',
      userId,
      metricCodes: effectiveMetricCodes,
      periodDays,
      productId: options.productId ?? null,
      minSessions: options.minSessions ?? 3,
      limit: effectiveLimit,
    });

    let rows: Awaited<ReturnType<typeof this.productImpactRepo.findByUserAndMetric>>;

    if (options.productId) {
      // Single product detail — filtered by metric code(s)
      // For productId queries, use first metric code if single, otherwise no filter
      const metricFilter = effectiveMetricCodes.length === 1
        ? effectiveMetricCodes[0]
        : undefined;
      rows = await this.productImpactRepo.findByUserAndProduct(
        userId,
        options.productId,
        metricFilter,
        options.minSessions ?? 3,
        periodDays,
      );
      // If multi-metric with productId, filter in-memory (rare case, bounded by 6 metrics)
      if (effectiveMetricCodes.length > 1) {
        const metricSet = new Set(effectiveMetricCodes);
        rows = rows.filter((r) => metricSet.has(r.metricCode));
      }
    } else if (effectiveMetricCodes.length === 1) {
      // Single metric — ranked list
      // Non-null assertion safe: length === 1 guarantees element exists
      const singleMetric = effectiveMetricCodes[0]!;
      rows = await this.productImpactRepo.findByUserAndMetric(
        userId,
        singleMetric,
        options.minSessions ?? 3,
        effectiveLimit,
        periodDays,
      );
    } else if (effectiveMetricCodes.length > 1) {
      // Multi-metric — cross-metric comparison (internal design spec:3028)
      rows = await this.productImpactRepo.findByUserAndMetrics(
        userId,
        effectiveMetricCodes,
        options.minSessions ?? 3,
        effectiveLimit,
        periodDays,
      );
    } else {
      // No metric specified — should be caught by schema validation, but fail-fast
      rows = [];
    }

    const mappedItems = rows.map(toProductImpactDto);

    // Apply watermark-based freshness override (consistent with all other read endpoints)
    const { items, summary } = await this.applyWatermarkFreshness(userId, mappedItems);
    return { items, summary };
  }

  // Health Insights (read-time computed, not stored projections)

  /**
   * Generate health insights for a domain and date range.
   *
   * Unlike other read methods (which query stored projections), insights are
   * computed at read-time from rollups + session impacts + product impacts.
   * The InsightEngine handles data fetching and rule execution.
   *
   * @param userId - Authenticated user ID
   * @param domain - Insight domain (hrv, sleep, respiratory)
   * @param startDate - Start date (YYYY-MM-DD)
   * @param endDate - End date (YYYY-MM-DD)
   * @param limit - Max insights to return (default: 5)
   * @returns Insights with response summary (READY/EMPTY/FAILED)
   */
  async getInsights(
    userId: string,
    domain: string,
    startDate: string,
    endDate: string,
    limit?: number,
  ): Promise<ProjectionReadResult<InsightDto>> {
    if (!this.insightEngine) {
      throw new Error('HealthProjectionReadService: insightEngine not configured');
    }

    const result = await this.insightEngine.generateInsights(
      userId,
      domain,
      startDate,
      endDate,
      limit,
    );

    // If ALL data sources failed, surface as FAILED immediately.
    // Do NOT mask total failure behind an empty EMPTY response.
    if (result.allSourcesFailed) {
      return {
        items: [],
        summary: {
          state: 'FAILED' as const,
          totalItems: 0,
          statusCounts: { ready: 0, computing: 0, noData: 0, failed: 0, stale: 0 },
        },
      };
    }

    // Apply watermark-based freshness override (consistent with all read endpoints).
    // Pass pre-fetched watermark from engine to avoid redundant DB query.
    // Engine already fetched it at generation time — reuse via sourceWatermark.
    const precomputedWatermark = result.sourceWatermark !== '0'
      ? BigInt(result.sourceWatermark)
      : null; // '0' = watermark unavailable (fetch failed or no mutations yet)
    const { items, summary } = await this.applyWatermarkFreshness(userId, result.insights, precomputedWatermark);

    // If ANY source failed (but not all), override summary state to PARTIAL.
    // This gives consumers an honest signal that the insight set may be incomplete.
    //
    // Two cases:
    // 1. items.length > 0, state === 'READY': Insights were produced from surviving
    //    sources, but some insight types are missing (e.g., no trend insights when
    //    rollup source failed). Override READY → PARTIAL.
    // 2. items.length === 0, state === 'EMPTY': No insights were produced, but we
    //    CAN'T claim EMPTY ("no data exists") — some sources failed, so we don't
    //    know if data exists or not. Override EMPTY → PARTIAL.
    //
    // States that should NOT be overridden: FAILED (already indicates a problem),
    // COMPUTING (transient, will resolve), STALE (already non-fresh).
    if (result.anySourceFailed && (summary.state === 'READY' || summary.state === 'EMPTY')) {
      return {
        items,
        summary: { ...summary, state: 'PARTIAL' as const },
      };
    }

    return { items, summary };
  }

  /**
   * Set the insight engine for read-time insight generation.
   * Called after construction because InsightEngine depends on the same repos.
   */
  setInsightEngine(engine: HealthInsightEngineService): void {
    this.insightEngine = engine;
  }

  private insightEngine: HealthInsightEngineService | null = null;
}
