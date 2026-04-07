/**
 * Sleep Night Summary Repository
 *
 * Data access layer for the user_sleep_night_summary derived read model.
 * Provides idempotent upsert and range queries for nightly sleep aggregates.
 *
 * INVARIANTS:
 * - Upsert on (userId, nightLocalDate) — safe under at-least-once delivery
 * - All writes go through Prisma typed operations (no raw SQL)
 * - NULL stage durations mean "data unavailable" (not "0 minutes")
 *
 * @see health-projection-coordinator.service.ts SleepSummaryProjectionHandler
 */

import { PrismaClient, UserSleepNightSummary, Prisma } from '@prisma/client';
import { BaseRepository } from './base.repository';
import { LoggerService } from '../services/logger.service';

// Types

/**
 * Input for upserting a sleep night summary.
 */
export interface UpsertSleepNightSummaryInput {
  readonly userId: string;
  readonly nightLocalDate: Date;
  readonly timezoneOffsetMin: number;

  // Core sleep timestamps (UTC)
  readonly sleepStartTs?: Date | null;
  readonly sleepEndTs?: Date | null;
  readonly inBedStartTs?: Date | null;
  readonly inBedEndTs?: Date | null;

  // Duration breakdowns (minutes) — NULL means unavailable
  readonly totalSleepMin?: number | null;
  readonly inBedMin?: number | null;
  readonly awakeMin?: number | null;
  readonly remMin?: number | null;
  readonly deepMin?: number | null;
  readonly lightMin?: number | null;

  // Derived metrics
  readonly sleepEfficiency?: number | null;
  readonly wakeEvents?: number | null;
  readonly sleepLatencyMin?: number | null;

  // Pre-bed session correlation
  readonly hadSessionBefore?: boolean;
  readonly sessionIdBefore?: string | null;
  readonly hoursBeforeBed?: number | null;

  // Stage availability flags
  readonly hasRemData?: boolean;
  readonly hasDeepData?: boolean;
  readonly hasLightData?: boolean;
  readonly hasAwakeData?: boolean;

  // Source dedup metadata
  readonly canonicalSourceId?: string | null;
  readonly sourceCount?: number;
  readonly sourceCoverage?: number | null;
  readonly dataQualityScore?: number | null;

  // Computation metadata
  readonly status: string;
  readonly sourceWatermark?: bigint | null;
  readonly computeVersion?: number;
}

// Repository

export class SleepNightSummaryRepository extends BaseRepository<UserSleepNightSummary> {
  constructor(
    prisma: PrismaClient,
    logger: LoggerService
  ) {
    super(prisma, 'UserSleepNightSummary', logger);
  }

  /**
   * Upsert a sleep night summary.
   *
   * INSERT...ON CONFLICT DO UPDATE on (userId, nightLocalDate).
   * Idempotent: calling with the same data produces the same result.
   *
   * @param data - Night summary data to upsert
   * @returns The upserted summary row
   */
  async upsertNightSummary(data: UpsertSleepNightSummaryInput): Promise<UserSleepNightSummary> {
    try {
      const now = new Date();

      const fields = {
        timezoneOffsetMin: data.timezoneOffsetMin,
        sleepStartTs: data.sleepStartTs ?? null,
        sleepEndTs: data.sleepEndTs ?? null,
        inBedStartTs: data.inBedStartTs ?? null,
        inBedEndTs: data.inBedEndTs ?? null,
        totalSleepMin: data.totalSleepMin ?? null,
        inBedMin: data.inBedMin ?? null,
        awakeMin: data.awakeMin ?? null,
        remMin: data.remMin ?? null,
        deepMin: data.deepMin ?? null,
        lightMin: data.lightMin ?? null,
        sleepEfficiency: data.sleepEfficiency != null
          ? new Prisma.Decimal(String(data.sleepEfficiency))
          : null,
        wakeEvents: data.wakeEvents ?? null,
        sleepLatencyMin: data.sleepLatencyMin ?? null,
        hadSessionBefore: data.hadSessionBefore ?? false,
        sessionIdBefore: data.sessionIdBefore ?? null,
        hoursBeforeBed: data.hoursBeforeBed != null
          ? new Prisma.Decimal(String(data.hoursBeforeBed))
          : null,
        hasRemData: data.hasRemData ?? false,
        hasDeepData: data.hasDeepData ?? false,
        hasLightData: data.hasLightData ?? false,
        hasAwakeData: data.hasAwakeData ?? false,
        canonicalSourceId: data.canonicalSourceId ?? null,
        sourceCount: data.sourceCount ?? 1,
        sourceCoverage: data.sourceCoverage != null
          ? new Prisma.Decimal(String(data.sourceCoverage))
          : null,
        dataQualityScore: data.dataQualityScore != null
          ? new Prisma.Decimal(String(data.dataQualityScore))
          : null,
        status: data.status,
        sourceWatermark: data.sourceWatermark ?? null,
        computeVersion: data.computeVersion ?? 1,
        computedAt: now,
      };

      return await this.prisma.userSleepNightSummary.upsert({
        where: {
          user_sleep_night_summary_unique: {
            userId: data.userId,
            nightLocalDate: data.nightLocalDate,
          },
        },
        create: {
          userId: data.userId,
          nightLocalDate: data.nightLocalDate,
          ...fields,
        },
        update: fields,
      });
    } catch (error) {
      this.handleError(error, 'upsertNightSummary');
    }
  }

  /**
   * Find sleep summaries for a user within a date range.
   *
   * @param userId - User ID
   * @param startDate - Start night date (inclusive)
   * @param endDate - End night date (inclusive)
   * @returns Array of sleep summaries ordered by night date descending
   */
  async findByUserDateRange(
    userId: string,
    startDate: Date,
    endDate: Date
  ): Promise<UserSleepNightSummary[]> {
    try {
      return await this.prisma.userSleepNightSummary.findMany({
        where: {
          userId,
          nightLocalDate: {
            gte: startDate,
            lte: endDate,
          },
        },
        orderBy: { nightLocalDate: 'desc' },
      });
    } catch (error) {
      this.handleError(error, 'findByUserDateRange');
    }
  }

  /**
   * Bulk mark summaries as STALE for a user.
   *
   * @param userId - User ID
   * @param dates - Optional: only mark these specific night dates stale
   * @returns Number of rows updated
   */
  async markStaleByUser(
    userId: string,
    dates?: Date[]
  ): Promise<number> {
    try {
      const where: Prisma.UserSleepNightSummaryWhereInput = {
        userId,
        status: { in: ['READY', 'NO_DATA', 'PARTIAL'] },
      };

      if (dates && dates.length > 0) {
        where.nightLocalDate = { in: dates };
      }

      const result = await this.prisma.userSleepNightSummary.updateMany({
        where,
        data: { status: 'STALE' },
      });

      return result.count;
    } catch (error) {
      this.handleError(error, 'markStaleByUser');
    }
  }
}
