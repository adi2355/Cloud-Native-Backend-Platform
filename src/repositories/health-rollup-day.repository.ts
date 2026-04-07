/**
 * Health Rollup Day Repository
 *
 * Data access layer for the user_health_rollup_day derived read model.
 * Provides idempotent upsert and range queries for daily health aggregates.
 *
 * INVARIANTS:
 * - Upsert on (userId, metricCode, dayUtc) — safe under at-least-once delivery
 * - All writes go through Prisma typed operations (no raw SQL)
 * - Status transitions: PENDING → READY | NO_DATA | PARTIAL | FAILED, READY|NO_DATA|PARTIAL → STALE
 *
 * @see health-projection-coordinator.service.ts HealthRollupProjectionHandler
 */

import { PrismaClient, UserHealthRollupDay, Prisma } from '@prisma/client';
import { BaseRepository } from './base.repository';
import { LoggerService } from '../services/logger.service';

// Types

/**
 * Input for upserting a daily health rollup.
 */
export interface UpsertHealthRollupInput {
  readonly userId: string;
  readonly metricCode: string;
  readonly dayUtc: Date;
  readonly valueKind: string;
  readonly sumVal?: Prisma.Decimal | number | null;
  readonly countVal: number;
  readonly minVal?: Prisma.Decimal | number | null;
  readonly maxVal?: Prisma.Decimal | number | null;
  readonly sumSq?: Prisma.Decimal | number | null;
  /** Dominant timezone offset (minutes) of aggregated samples. Nullable for backward compat. */
  readonly timezoneOffsetMin?: number | null;
  readonly status: string;
  readonly sourceWatermark?: bigint | null;
  readonly computeVersion?: number;
}

// Repository

export class HealthRollupDayRepository extends BaseRepository<UserHealthRollupDay> {
  constructor(
    prisma: PrismaClient,
    logger: LoggerService
  ) {
    super(prisma, 'UserHealthRollupDay', logger);
  }

  /**
   * Upsert a daily health rollup.
   *
   * INSERT...ON CONFLICT DO UPDATE on (userId, metricCode, dayUtc).
   * Idempotent: calling with the same data produces the same result.
   *
   * @param data - Rollup data to upsert
   * @returns The upserted rollup row
   */
  async upsertRollup(data: UpsertHealthRollupInput): Promise<UserHealthRollupDay> {
    try {
      const now = new Date();

      return await this.prisma.userHealthRollupDay.upsert({
        where: {
          user_health_rollup_day_unique: {
            userId: data.userId,
            metricCode: data.metricCode,
            dayUtc: data.dayUtc,
          },
        },
        create: {
          userId: data.userId,
          metricCode: data.metricCode,
          dayUtc: data.dayUtc,
          valueKind: data.valueKind,
          sumVal: data.sumVal != null ? new Prisma.Decimal(String(data.sumVal)) : null,
          countVal: data.countVal,
          minVal: data.minVal != null ? new Prisma.Decimal(String(data.minVal)) : null,
          maxVal: data.maxVal != null ? new Prisma.Decimal(String(data.maxVal)) : null,
          sumSq: data.sumSq != null ? new Prisma.Decimal(String(data.sumSq)) : null,
          timezoneOffsetMin: data.timezoneOffsetMin ?? null,
          status: data.status,
          sourceWatermark: data.sourceWatermark ?? null,
          computeVersion: data.computeVersion ?? 1,
          computedAt: now,
        },
        update: {
          valueKind: data.valueKind,
          sumVal: data.sumVal != null ? new Prisma.Decimal(String(data.sumVal)) : null,
          countVal: data.countVal,
          minVal: data.minVal != null ? new Prisma.Decimal(String(data.minVal)) : null,
          maxVal: data.maxVal != null ? new Prisma.Decimal(String(data.maxVal)) : null,
          sumSq: data.sumSq != null ? new Prisma.Decimal(String(data.sumSq)) : null,
          timezoneOffsetMin: data.timezoneOffsetMin ?? null,
          status: data.status,
          sourceWatermark: data.sourceWatermark ?? null,
          computeVersion: data.computeVersion ?? 1,
          computedAt: now,
        },
      });
    } catch (error) {
      this.handleError(error, 'upsertRollup');
    }
  }

  /**
   * Find rollups for a user/metric within a date range.
   *
   * Orders by (dayUtc ASC, metricCode ASC, id ASC) to match the paginated path
   * and provide deterministic, consistent ordering regardless of query mode.
   *
   * FINDING 2 FIX: Changed from DESC to ASC. Callers that previously relied on
   * newest-first ordering should use cursor-based pagination with explicit limit.
   *
   * @param userId - User ID
   * @param metricCode - Metric code
   * @param startDate - Start date (inclusive)
   * @param endDate - End date (inclusive)
   * @param limit - Optional row cap (for bounded legacy queries)
   * @returns Array of rollup rows ordered by (dayUtc ASC, metricCode ASC, id ASC)
   */
  async findByUserMetricDateRange(
    userId: string,
    metricCode: string,
    startDate: Date,
    endDate: Date,
    limit?: number,
  ): Promise<UserHealthRollupDay[]> {
    try {
      return await this.prisma.userHealthRollupDay.findMany({
        where: {
          userId,
          metricCode,
          dayUtc: {
            gte: startDate,
            lte: endDate,
          },
        },
        orderBy: [
          { dayUtc: 'asc' },
          { metricCode: 'asc' },
          { id: 'asc' },
        ],
        ...(limit != null ? { take: limit + 1 } : {}),
      });
    } catch (error) {
      this.handleError(error, 'findByUserMetricDateRange');
    }
  }

  /**
   * Find rollups for a user/metric within a date range with cursor-based pagination.
   *
   * Uses keyset pagination on (dayUtc ASC, metricCode ASC, id ASC) for O(1)
   * seek with index support. Fetches limit+1 rows to detect hasMore without
   * a separate COUNT query.
   *
   * INVARIANT: Deterministic sort order — no duplicate or missing rows across pages.
   *
   * @param userId - User ID
   * @param metricCode - Metric code
   * @param startDate - Start date (inclusive)
   * @param endDate - End date (inclusive)
   * @param limit - Page size (caller must enforce hard cap)
   * @param cursor - Optional decoded cursor for keyset pagination
   * @returns Rows (at most limit+1 to detect hasMore)
   */
  async findByUserMetricDateRangePaginated(
    userId: string,
    metricCode: string,
    startDate: Date,
    endDate: Date,
    limit: number,
    cursor?: { dayUtc: string; metricCode: string; id: string },
  ): Promise<UserHealthRollupDay[]> {
    try {
      const where: Prisma.UserHealthRollupDayWhereInput = {
        userId,
        metricCode,
        dayUtc: {
          gte: startDate,
          lte: endDate,
        },
      };

      // Keyset pagination: seek past the cursor using composite key ordering.
      // (dayUtc, metricCode, id) forms a total order.
      // We use OR conditions to express "row > cursor" in this 3-column sort:
      //   dayUtc > cursor.dayUtc
      //   OR (dayUtc = cursor.dayUtc AND metricCode > cursor.metricCode)
      //   OR (dayUtc = cursor.dayUtc AND metricCode = cursor.metricCode AND id > cursor.id)
      if (cursor) {
        const cursorDate = new Date(cursor.dayUtc);
        where.AND = [
          {
            OR: [
              { dayUtc: { gt: cursorDate } },
              {
                dayUtc: cursorDate,
                metricCode: { gt: cursor.metricCode },
              },
              {
                dayUtc: cursorDate,
                metricCode: cursor.metricCode,
                id: { gt: cursor.id },
              },
            ],
          },
        ];
      }

      return await this.prisma.userHealthRollupDay.findMany({
        where,
        orderBy: [
          { dayUtc: 'asc' },
          { metricCode: 'asc' },
          { id: 'asc' },
        ],
        take: limit + 1, // Fetch one extra to detect hasMore
      });
    } catch (error) {
      this.handleError(error, 'findByUserMetricDateRangePaginated');
    }
  }

  /**
   * Bulk mark rollups as STALE for a user.
   *
   * Used when new samples arrive that may affect previously-computed rollups.
   *
   * @param userId - User ID
   * @param metricCodes - Optional: only mark these metric codes stale
   * @param dates - Optional: only mark these specific dates stale
   * @returns Number of rows updated
   */
  async markStaleByUser(
    userId: string,
    metricCodes?: string[],
    dates?: Date[]
  ): Promise<number> {
    try {
      const where: Prisma.UserHealthRollupDayWhereInput = {
        userId,
        status: { in: ['READY', 'NO_DATA', 'PARTIAL'] },
      };

      if (metricCodes && metricCodes.length > 0) {
        where.metricCode = { in: metricCodes };
      }
      if (dates && dates.length > 0) {
        where.dayUtc = { in: dates };
      }

      const result = await this.prisma.userHealthRollupDay.updateMany({
        where,
        data: { status: 'STALE' },
      });

      return result.count;
    } catch (error) {
      this.handleError(error, 'markStaleByUser');
    }
  }
}
