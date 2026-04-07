/**
 * Session Impact Summary Repository
 *
 * Data access layer for the user_session_impact_summary derived read model.
 * Provides idempotent upsert and session-based queries for health impact metrics.
 *
 * INVARIANTS:
 * - Upsert on (sessionId, metricCode, windowMinutes, resolution) — safe under at-least-once
 * - All writes go through Prisma typed operations (no raw SQL)
 * - isReliable=false when coverage < threshold
 *
 * @see health-projection-coordinator.service.ts SessionImpactProjectionHandler
 */

import { PrismaClient, UserSessionImpactSummary, Prisma } from '@prisma/client';
import { BaseRepository } from './base.repository';
import { LoggerService } from '../services/logger.service';

// Types

/**
 * Input for upserting a session impact summary.
 */
export interface UpsertSessionImpactInput {
  readonly sessionId: string;
  readonly userId: string;
  readonly metricCode: string;
  readonly windowMinutes?: number;
  readonly resolution?: string;

  // Before-session bucket
  readonly avgBefore?: number | null;
  readonly minBefore?: number | null;
  readonly maxBefore?: number | null;
  readonly countBefore?: number;

  // During-session bucket
  readonly avgDuring?: number | null;
  readonly minDuring?: number | null;
  readonly maxDuring?: number | null;
  readonly countDuring?: number;

  // After-session bucket
  readonly avgAfter?: number | null;
  readonly minAfter?: number | null;
  readonly maxAfter?: number | null;
  readonly countAfter?: number;

  // Computed deltas
  readonly deltaDuringAbs?: number | null;
  readonly deltaDuringPct?: number | null;
  readonly deltaAfterAbs?: number | null;
  readonly deltaAfterPct?: number | null;

  // Coverage metrics
  readonly beforeCoverage?: number | null;
  readonly duringCoverage?: number | null;
  readonly afterCoverage?: number | null;

  // Data quality flags
  readonly hasSignificantGaps?: boolean;
  readonly isReliable?: boolean;

  // Computation metadata
  readonly status: string;
  readonly sourceWatermark?: bigint | null;
  readonly computeVersion?: number;
}

// Helpers

/** Convert nullable number to Prisma.Decimal or null */
function toDecimalOrNull(value: number | null | undefined): Prisma.Decimal | null {
  return value != null ? new Prisma.Decimal(String(value)) : null;
}

// Repository

export class SessionImpactSummaryRepository extends BaseRepository<UserSessionImpactSummary> {
  constructor(
    prisma: PrismaClient,
    logger: LoggerService
  ) {
    super(prisma, 'UserSessionImpactSummary', logger);
  }

  /**
   * Upsert a session impact summary.
   *
   * INSERT...ON CONFLICT DO UPDATE on (sessionId, metricCode, windowMinutes, resolution).
   * Idempotent: calling with the same data produces the same result.
   *
   * @param data - Impact data to upsert
   * @returns The upserted impact row
   */
  async upsertImpact(data: UpsertSessionImpactInput): Promise<UserSessionImpactSummary> {
    try {
      const now = new Date();
      const windowMinutes = data.windowMinutes ?? 60;
      const resolution = data.resolution ?? '1min';

      const fields = {
        avgBefore: toDecimalOrNull(data.avgBefore),
        minBefore: toDecimalOrNull(data.minBefore),
        maxBefore: toDecimalOrNull(data.maxBefore),
        countBefore: data.countBefore ?? 0,
        avgDuring: toDecimalOrNull(data.avgDuring),
        minDuring: toDecimalOrNull(data.minDuring),
        maxDuring: toDecimalOrNull(data.maxDuring),
        countDuring: data.countDuring ?? 0,
        avgAfter: toDecimalOrNull(data.avgAfter),
        minAfter: toDecimalOrNull(data.minAfter),
        maxAfter: toDecimalOrNull(data.maxAfter),
        countAfter: data.countAfter ?? 0,
        deltaDuringAbs: toDecimalOrNull(data.deltaDuringAbs),
        deltaDuringPct: toDecimalOrNull(data.deltaDuringPct),
        deltaAfterAbs: toDecimalOrNull(data.deltaAfterAbs),
        deltaAfterPct: toDecimalOrNull(data.deltaAfterPct),
        beforeCoverage: toDecimalOrNull(data.beforeCoverage),
        duringCoverage: toDecimalOrNull(data.duringCoverage),
        afterCoverage: toDecimalOrNull(data.afterCoverage),
        hasSignificantGaps: data.hasSignificantGaps ?? false,
        isReliable: data.isReliable ?? true,
        status: data.status,
        sourceWatermark: data.sourceWatermark ?? null,
        computeVersion: data.computeVersion ?? 1,
        computedAt: now,
      };

      return await this.prisma.userSessionImpactSummary.upsert({
        where: {
          user_session_impact_summary_unique: {
            sessionId: data.sessionId,
            metricCode: data.metricCode,
            windowMinutes,
            resolution,
          },
        },
        create: {
          sessionId: data.sessionId,
          userId: data.userId,
          metricCode: data.metricCode,
          windowMinutes,
          resolution,
          ...fields,
        },
        update: fields,
      });
    } catch (error) {
      this.handleError(error, 'upsertImpact');
    }
  }

  /**
   * Find all impact summaries for a session.
   *
   * @param sessionId - Session ID
   * @returns Array of impact summaries for all metrics/windows
   */
  async findBySession(sessionId: string): Promise<UserSessionImpactSummary[]> {
    try {
      return await this.prisma.userSessionImpactSummary.findMany({
        where: { sessionId },
        orderBy: { metricCode: 'asc' },
      });
    } catch (error) {
      this.handleError(error, 'findBySession');
    }
  }

  /**
   * Find all impact summaries for a session scoped to a specific user.
   *
   * SECURITY: This method MUST be used for all API-facing queries to prevent
   * IDOR vulnerabilities. The userId filter ensures users can only access
   * their own session impact data.
   *
   * @param sessionId - Session ID
   * @param userId - User ID (authorization scope)
   * @returns Array of impact summaries for all metrics/windows belonging to this user
   */
  async findBySessionAndUser(sessionId: string, userId: string): Promise<UserSessionImpactSummary[]> {
    try {
      return await this.prisma.userSessionImpactSummary.findMany({
        where: { sessionId, userId },
        orderBy: { metricCode: 'asc' },
      });
    } catch (error) {
      this.handleError(error, 'findBySessionAndUser');
    }
  }

  /**
   * Bulk mark impact summaries as STALE for a user.
   *
   * @param userId - User ID
   * @param sessionIds - Optional: only mark these session IDs stale
   * @returns Number of rows updated
   */
  async markStaleByUser(
    userId: string,
    sessionIds?: string[]
  ): Promise<number> {
    try {
      const where: Prisma.UserSessionImpactSummaryWhereInput = {
        userId,
        status: { in: ['READY', 'NO_DATA', 'PARTIAL'] },
      };

      if (sessionIds && sessionIds.length > 0) {
        where.sessionId = { in: sessionIds };
      }

      const result = await this.prisma.userSessionImpactSummary.updateMany({
        where,
        data: { status: 'STALE' },
      });

      return result.count;
    } catch (error) {
      this.handleError(error, 'markStaleByUser');
    }
  }

  /**
   * Find all session impacts for a given user×product×metric combination.
   *
   * Used by ProductImpactProjectionHandler to aggregate session-level impacts
   * into per-product rollups. Returns all columns needed for aggregation.
   *
   * JOIN: UserSessionImpactSummary → Session (for primaryProductId + timestamps)
   *
   * FILTERS:
   * - User-scoped (userId on impact summary)
   * - Product-scoped (session.primaryProductId = productId)
   * - Metric + window + resolution scoped
   * - Only READY/PARTIAL status (excludes NO_DATA/STALE/FAILED — NO_DATA rows have
   *   null deltas and zero counts that would dilute aggregates with non-information)
   *
   * @param userId - User ID
   * @param productId - Product ID (matched via session.primaryProductId)
   * @param metricCode - Metric code
   * @param windowMinutes - Window size (default 60)
   * @param resolution - Resolution (default '1min')
   * @returns Session impacts with session start timestamp for aggregation
   */
  async findByUserProductAndMetricForAggregation(
    userId: string,
    productId: string,
    metricCode: string,
    windowMinutes: number = 60,
    resolution: string = '1min',
  ): Promise<(UserSessionImpactSummary & {
    session: {
      sessionStartTimestamp: Date;
      sessionEndTimestamp: Date | null;
    };
  })[]> {
    try {
      return await this.prisma.userSessionImpactSummary.findMany({
        where: {
          userId,
          metricCode,
          windowMinutes,
          resolution,
          status: { in: ['READY', 'PARTIAL'] },
          session: {
            primaryProductId: productId,
            sessionEndTimestamp: { not: null },
            status: 'COMPLETED',
          },
        },
        include: {
          session: {
            select: {
              sessionStartTimestamp: true,
              sessionEndTimestamp: true,
            },
          },
        },
        orderBy: {
          session: {
            sessionStartTimestamp: 'desc',
          },
        },
      });
    } catch (error) {
      this.handleError(error, 'findByUserProductAndMetricForAggregation');
    }
  }

  /**
   * Count session-impact rows in non-terminal states (STALE, COMPUTING, PENDING)
   * for a specific user × product × metric combination.
   *
   * Used by ProductImpactProjectionHandler to distinguish between:
   * - "upstream session-impacts haven't computed yet" (non-terminal count > 0)
   * - "upstream computed and no READY/PARTIAL data exists" (non-terminal count = 0)
   *
   * This prevents false NO_DATA writes when upstream is still processing.
   *
   * @param userId - User ID
   * @param productId - Product ID (matched via session.primaryProductId)
   * @param metricCode - Metric code
   * @param windowMinutes - Window minutes (default 60)
   * @param resolution - Resolution (default '1min')
   * @returns Count of session-impact rows in STALE/COMPUTING/PENDING status
   */
  async countNonTerminalByUserProductAndMetric(
    userId: string,
    productId: string,
    metricCode: string,
    windowMinutes: number = 60,
    resolution: string = '1min',
  ): Promise<number> {
    try {
      return await this.prisma.userSessionImpactSummary.count({
        where: {
          userId,
          metricCode,
          windowMinutes,
          resolution,
          status: { in: ['STALE', 'COMPUTING', 'PENDING'] },
          session: {
            primaryProductId: productId,
            sessionEndTimestamp: { not: null },
            status: 'COMPLETED',
          },
        },
      });
    } catch (error) {
      this.handleError(error, 'countNonTerminalByUserProductAndMetric');
    }
  }

  /**
   * Find recent session impact summaries for a user and metric,
   * enriched with session timestamps and product metadata.
   *
   * JOIN: UserSessionImpactSummary → Session → Product
   *
   * FILTERS:
   * - User-scoped (IDOR prevention via userId filter)
   * - Metric code filter (single metric per call)
   * - Completed sessions only (sessionEndTimestamp IS NOT NULL, status = COMPLETED)
   *
   * ORDER: session.sessionStartTimestamp DESC (most recent first)
   *
   * INDEX COVERAGE:
   * - user_session_impact_summary_user_session_idx on (userId, sessionId)
   * - consumption_sessions (userId, sessionStartTimestamp) for ordering
   * - Small TAKE limit (max 50) keeps query within P99 budget
   *
   * @param userId - User ID (authorization scope)
   * @param metricCode - Metric code to filter by
   * @param limit - Maximum number of results (caller must enforce cap)
   * @param startDate - Optional: filter sessions starting on or after this date
   * @param endDate - Optional: filter sessions starting on or before this date
   * @returns Array of impact summaries with joined session/product data
   */
  async findRecentByUserAndMetric(
    userId: string,
    metricCode: string,
    limit: number,
    startDate?: Date,
    endDate?: Date,
  ): Promise<(UserSessionImpactSummary & {
    session: {
      sessionStartTimestamp: Date;
      sessionEndTimestamp: Date | null;
      primaryProduct: {
        id: string;
        name: string;
      } | null;
    };
  })[]> {
    try {
      // v27: Optional date range filtering for insight engine.
      // When startDate/endDate are provided, only sessions within the
      // requested analysis window are returned. Without these params,
      // behavior is unchanged (backward-compatible).
      const sessionFilter: Record<string, unknown> = {
        sessionEndTimestamp: { not: null },
        status: 'COMPLETED',
      };
      if (startDate != null || endDate != null) {
        const tsFilter: Record<string, Date> = {};
        if (startDate != null) tsFilter.gte = startDate;
        if (endDate != null) tsFilter.lte = endDate;
        sessionFilter.sessionStartTimestamp = tsFilter;
      }

      return await this.prisma.userSessionImpactSummary.findMany({
        where: {
          userId,
          metricCode,
          session: sessionFilter,
        },
        include: {
          session: {
            select: {
              sessionStartTimestamp: true,
              sessionEndTimestamp: true,
              primaryProduct: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
        },
        orderBy: {
          session: {
            sessionStartTimestamp: 'desc',
          },
        },
        take: limit,
      });
    } catch (error) {
      this.handleError(error, 'findRecentByUserAndMetric');
    }
  }
}
