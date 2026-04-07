/**
 * Health Aggregation Service
 *
 * Provides ValueKind-aware aggregation for health samples.
 *
 * AGGREGATION STRATEGIES BY VALUE KIND:
 * - SCALAR_NUM: Average of all values (point-in-time metrics like heart_rate)
 * - CUMULATIVE_NUM: Delta (max - min) for monotonic counters like steps
 * - INTERVAL_NUM: Sum of all values for time-bounded metrics like active_energy
 * - CATEGORY: Not aggregated numerically (use mode/count elsewhere)
 *
 * DESIGN DECISIONS:
 * - Pure aggregate() methods take samples as input (no DB access)
 * - computeDailyAggregate() loads samples from DB and applies ValueKind strategy
 * - Uses getValueKind() from shared metric-types for lookup
 * - Returns AggregationResult with all computed statistics
 * - Empty samples return zero values (not errors)
 *
 * INVARIANTS:
 * - metricCode must be a valid HealthMetricCode
 * - Unknown metric codes throw UnknownHealthMetricCodeError
 * - CATEGORY metrics throw for numeric aggregation (not aggregatable numerically)
 *
 * P0-D COMPLIANCE:
 * - computeDailyAggregate() enforces correct aggregation per ValueKind
 * - No caller-specified aggregation type (prevents avg on steps, sum on heart_rate)
 *
 * @module HealthAggregationService
 */

import { LoggerService } from './logger.service';
import {
  getValueKind,
  getMetricDefinition,
  isHealthMetricCode,
  HealthMetricValueKind,
  UnknownHealthMetricCodeError,
  HealthMetricCode,
} from '@shared/contracts';
import type { HealthSampleRepository } from '../repositories/health-sample.repository';

// TYPES

/**
 * Input for aggregation operations.
 *
 * Represents a single numeric sample value with time bounds.
 */
export interface AggregationInput {
  /** Numeric value of the sample */
  readonly value: number;
  /** Start time of the sample (used for ordering in CUMULATIVE_NUM) */
  readonly startAt: Date;
  /** End time of the sample (optional, for interval calculations) */
  readonly endAt: Date;
}

/**
 * Result of aggregation operations.
 *
 * Contains the primary aggregated value plus supporting statistics.
 */
export interface AggregationResult {
  /** Primary aggregated value based on ValueKind strategy */
  readonly aggregatedValue: number;
  /** Number of samples in the aggregation */
  readonly sampleCount: number;
  /** Minimum value in the samples */
  readonly minValue: number;
  /** Maximum value in the samples */
  readonly maxValue: number;
  /** Sum of all values */
  readonly sumValue: number;
  /** Average of all values */
  readonly avgValue: number;
}

/**
 * Error thrown when attempting to aggregate CATEGORY metrics numerically.
 */
export class CategoryMetricNotAggregatableError extends Error {
  constructor(metricCode: string) {
    super(
      `Metric '${metricCode}' is a CATEGORY metric and cannot be aggregated numerically. ` +
        `Use mode/count aggregation for categorical values.`
    );
    this.name = 'CategoryMetricNotAggregatableError';
  }
}

/**
 * Error thrown when aggregation is not supported for a metric.
 */
export class InvalidAggregationError extends Error {
  constructor(metricCode: string, reason: string) {
    super(`Invalid aggregation for metric '${metricCode}': ${reason}`);
    this.name = 'InvalidAggregationError';
  }
}

/**
 * P0-D: Daily aggregate result with ValueKind-appropriate statistics.
 *
 * DESIGN: The shape varies by ValueKind to prevent misuse:
 * - SCALAR_NUM: avg/min/max/count (no sum - meaningless for scalars)
 * - CUMULATIVE_NUM: sum/count (no avg - meaningless for cumulative)
 * - INTERVAL_NUM: sum/avg/count (both make sense for durations)
 */
export interface DailyAggregate {
  /** The date this aggregate covers (YYYY-MM-DD in user timezone) */
  readonly date: string;
  /** User timezone used for date boundaries */
  readonly timezone: string;
  /** Metric code */
  readonly metricCode: string;
  /** ValueKind of the metric */
  readonly valueKind: HealthMetricValueKind;
  /** Number of samples aggregated */
  readonly sampleCount: number;
  /** Primary aggregated value (interpretation depends on valueKind) */
  readonly value: number;
  /** Unit of measurement */
  readonly unit: string | null;
  /** Minimum value (SCALAR_NUM, INTERVAL_NUM only) */
  readonly minValue?: number;
  /** Maximum value (SCALAR_NUM, INTERVAL_NUM only) */
  readonly maxValue?: number;
  /** Average value (SCALAR_NUM, INTERVAL_NUM only) */
  readonly avgValue?: number;
  /** Sum value (CUMULATIVE_NUM, INTERVAL_NUM only) */
  readonly sumValue?: number;
  /** Time range start (UTC) */
  readonly rangeStartUtc: Date;
  /** Time range end (UTC) */
  readonly rangeEndUtc: Date;
}

/**
 * Category aggregate result for CATEGORY metrics.
 */
export interface CategoryAggregate {
  /** The date this aggregate covers (YYYY-MM-DD in user timezone) */
  readonly date: string;
  /** User timezone used for date boundaries */
  readonly timezone: string;
  /** Metric code */
  readonly metricCode: string;
  /** Total sample count */
  readonly sampleCount: number;
  /** Counts per category code */
  readonly countByCategory: Record<string, number>;
  /** Most frequent category (mode) */
  readonly mode: string | null;
  /** Total duration in seconds per category (for time-based categories like sleep stages) */
  readonly durationByCategory?: Record<string, number>;
  /** Time range start (UTC) */
  readonly rangeStartUtc: Date;
  /** Time range end (UTC) */
  readonly rangeEndUtc: Date;
}

// SERVICE

/**
 * Service for ValueKind-aware health sample aggregation.
 *
 * USAGE - Pure aggregation (no DB access):
 * ```typescript
 * const result = aggregationService.aggregate(samples, 'heart_rate');
 * // result.aggregatedValue contains average (SCALAR_NUM strategy)
 *
 * const stepsResult = aggregationService.aggregate(samples, 'steps');
 * // result.aggregatedValue contains delta (CUMULATIVE_NUM strategy)
 * ```
 *
 * USAGE - Daily aggregation with DB access (P0-D):
 * ```typescript
 * const daily = await aggregationService.computeDailyAggregate(
 *   userId, 'heart_rate', '2026-02-04', 'America/New_York'
 * );
 * // Loads samples for the day and computes ValueKind-appropriate aggregate
 * ```
 */
export class HealthAggregationService {
  constructor(
    private readonly logger: LoggerService,
    private readonly healthSampleRepository?: HealthSampleRepository
  ) {}

  /**
   * Aggregate samples based on the metric's ValueKind.
   *
   * Looks up the ValueKind for the metricCode and applies the appropriate
   * aggregation strategy:
   * - SCALAR_NUM: average
   * - CUMULATIVE_NUM: delta (max - min)
   * - INTERVAL_NUM: sum
   * - CATEGORY: throws (not aggregatable)
   *
   * @param samples - Array of sample inputs (must have same metricCode)
   * @param metricCode - Canonical metric code for ValueKind lookup
   * @returns AggregationResult with aggregated value and statistics
   * @throws UnknownHealthMetricCodeError if metricCode is invalid
   * @throws CategoryMetricNotAggregatableError if metric is CATEGORY type
   *
   * @example
   * // Heart rate (SCALAR_NUM) → average
   * const hrResult = service.aggregate(hrSamples, 'heart_rate');
   *
   * // Steps (CUMULATIVE_NUM) → delta
   * const stepsResult = service.aggregate(stepSamples, 'steps');
   *
   * // Active energy (INTERVAL_NUM) → sum
   * const energyResult = service.aggregate(energySamples, 'active_energy_burned');
   */
  aggregate(
    samples: readonly AggregationInput[],
    metricCode: string
  ): AggregationResult {
    // Validate metric code
    if (!isHealthMetricCode(metricCode)) {
      throw new UnknownHealthMetricCodeError(metricCode);
    }

    // Get ValueKind for this metric
    const valueKind = getValueKind(metricCode);

    return this.aggregateWithValueKind(samples, valueKind, metricCode);
  }

  /**
   * Aggregate samples with an explicit ValueKind.
   *
   * Use this when you already know the ValueKind and want to skip the lookup,
   * or for testing with custom ValueKinds.
   *
   * @param samples - Array of sample inputs
   * @param valueKind - The aggregation strategy to use
   * @param metricCode - Optional metric code for logging/errors
   * @returns AggregationResult with aggregated value and statistics
   * @throws CategoryMetricNotAggregatableError if valueKind is CATEGORY
   */
  aggregateWithValueKind(
    samples: readonly AggregationInput[],
    valueKind: HealthMetricValueKind,
    metricCode?: string
  ): AggregationResult {
    // Handle empty samples
    if (samples.length === 0) {
      return {
        aggregatedValue: 0,
        sampleCount: 0,
        minValue: 0,
        maxValue: 0,
        sumValue: 0,
        avgValue: 0,
      };
    }

    // CATEGORY metrics cannot be aggregated numerically
    if (valueKind === 'CATEGORY') {
      throw new CategoryMetricNotAggregatableError(metricCode ?? 'unknown');
    }

    // Compute basic statistics (needed for all strategies)
    const stats = this.computeBasicStats(samples);

    // Apply aggregation strategy based on ValueKind
    let aggregatedValue: number;

    switch (valueKind) {
      case 'SCALAR_NUM':
        // Point-in-time values: use average
        aggregatedValue = stats.avgValue;
        break;

      case 'CUMULATIVE_NUM':
        // Monotonic counters: use delta (max - min)
        // This handles out-of-order samples by using absolute max/min
        aggregatedValue = stats.maxValue - stats.minValue;
        break;

      case 'INTERVAL_NUM':
        // Time-bounded values: use sum
        aggregatedValue = stats.sumValue;
        break;

      default:
        // TypeScript exhaustiveness check
        const _exhaustive: never = valueKind;
        throw new Error(`Unexpected valueKind: ${_exhaustive}`);
    }

    // FINDING 5 FIX: Removed per-call DEBUG log. This fired once per metric×date
    // (40+ times per handler invocation), creating log flood under production load.
    // The calling handler already logs a summary with processedCount, noDataCount,
    // globalFetchedSamples, and durationMs — all the observability needed.

    return {
      aggregatedValue,
      ...stats,
    };
  }

  /**
   * Compute basic statistics for a set of samples.
   *
   * @param samples - Array of sample inputs
   * @returns Object with sampleCount, minValue, maxValue, sumValue, avgValue
   *
   * @private
   */
  private computeBasicStats(
    samples: readonly AggregationInput[]
  ): Omit<AggregationResult, 'aggregatedValue'> {
    if (samples.length === 0) {
      return {
        sampleCount: 0,
        minValue: 0,
        maxValue: 0,
        sumValue: 0,
        avgValue: 0,
      };
    }

    // TypeScript doesn't narrow readonly arrays, so we assert first element exists
    const firstSample = samples[0]!;
    let minValue = firstSample.value;
    let maxValue = firstSample.value;
    let sumValue = 0;

    for (const sample of samples) {
      if (sample.value < minValue) minValue = sample.value;
      if (sample.value > maxValue) maxValue = sample.value;
      sumValue += sample.value;
    }

    const sampleCount = samples.length;
    const avgValue = sumValue / sampleCount;

    return {
      sampleCount,
      minValue,
      maxValue,
      sumValue,
      avgValue,
    };
  }

  /**
   * Aggregate samples sorted by time for CUMULATIVE_NUM metrics.
   *
   * This variant uses the first and last sample values (by time order)
   * instead of absolute min/max. Useful when you want to compute the
   * delta for a specific time window even if there were resets.
   *
   * @param samples - Array of sample inputs (will be sorted by startAt)
   * @returns Delta between last and first sample values
   */
  aggregateCumulativeByTime(samples: readonly AggregationInput[]): number {
    if (samples.length === 0) {
      return 0;
    }

    // Sort by startAt
    const sorted = [...samples].sort(
      (a, b) => a.startAt.getTime() - b.startAt.getTime()
    );

    // TypeScript doesn't narrow after sort, assert elements exist
    const firstValue = sorted[0]!.value;
    const lastValue = sorted[sorted.length - 1]!.value;

    return lastValue - firstValue;
  }

  /**
   * Aggregate with weighted average based on sample duration.
   *
   * Useful for SCALAR_NUM metrics where longer samples should have
   * more weight in the average (e.g., heart rate over variable intervals).
   *
   * @param samples - Array of sample inputs with meaningful startAt/endAt
   * @returns Weighted average value
   */
  aggregateWeightedByDuration(samples: readonly AggregationInput[]): number {
    if (samples.length === 0) {
      return 0;
    }

    let totalWeight = 0;
    let weightedSum = 0;

    for (const sample of samples) {
      const durationMs = sample.endAt.getTime() - sample.startAt.getTime();
      // Use duration as weight (minimum 1ms to avoid division by zero)
      const weight = Math.max(durationMs, 1);
      totalWeight += weight;
      weightedSum += sample.value * weight;
    }

    return weightedSum / totalWeight;
  }

  // P0-D: Daily Aggregation with Database Access

  /**
   * P0-D: Compute daily aggregate for a metric, respecting ValueKind semantics.
   *
   * This is the CANONICAL entry point for daily rollups. It enforces correct
   * aggregation strategy based on the metric's ValueKind:
   * - SCALAR_NUM (heart_rate, hrv): avg, min, max, count
   * - CUMULATIVE_NUM (steps): sum (max - min), count
   * - INTERVAL_NUM (active_energy_burned): sum, avg, count
   * - CATEGORY (sleep_stage): throws - use computeCategoryAggregate instead
   *
   * FAIL FAST: Throws if metric doesn't support numeric aggregation.
   *
   * @param userId - User ID
   * @param metricCode - Canonical metric code (must be valid HealthMetricCode)
   * @param date - Date string in YYYY-MM-DD format (user's local date)
   * @param userTimezone - IANA timezone string (e.g., 'America/New_York')
   * @returns DailyAggregate with ValueKind-appropriate statistics
   * @throws Error if repository not configured
   * @throws UnknownHealthMetricCodeError if metricCode is invalid
   * @throws InvalidAggregationError if metric doesn't support numeric aggregation
   */
  async computeDailyAggregate(
    userId: string,
    metricCode: string,
    date: string,
    userTimezone: string
  ): Promise<DailyAggregate | null> {
    // FAIL FAST: Repository required
    if (!this.healthSampleRepository) {
      throw new Error(
        'HealthAggregationService: healthSampleRepository required for computeDailyAggregate. ' +
          'Initialize service with repository dependency.'
      );
    }

    // Validate metric code
    if (!isHealthMetricCode(metricCode)) {
      throw new UnknownHealthMetricCodeError(metricCode);
    }

    const def = getMetricDefinition(metricCode as HealthMetricCode);
    const valueKind = def.valueKind;

    // FAIL FAST: CATEGORY metrics cannot be aggregated numerically
    if (valueKind === 'CATEGORY') {
      throw new InvalidAggregationError(
        metricCode,
        `Metric '${metricCode}' is a CATEGORY metric (valueKind: ${valueKind}). ` +
          `Use computeCategoryAggregate() for categorical data.`
      );
    }

    // Convert date + timezone to UTC range
    // P0-A GUARDRAIL: Use half-open interval [start, end)
    const { rangeStartUtc, rangeEndUtc } = this.dateToUtcRange(date, userTimezone);

    this.logger.debug('Computing daily aggregate', {
      context: 'HealthAggregationService.computeDailyAggregate',
      userId,
      metricCode,
      date,
      userTimezone,
      valueKind,
      rangeStartUtc: rangeStartUtc.toISOString(),
      rangeEndUtc: rangeEndUtc.toISOString(),
    });

    // Load samples for the date range
    // NOTE: Repository's queryByUserAndTimeRange now uses half-open interval (P0-A fix)
    const samplesPage = await this.healthSampleRepository.queryByUserAndTimeRange(
      userId,
      rangeStartUtc,
      rangeEndUtc,
      metricCode,
      { page: 1, pageSize: 10000 } // Load all samples for the day
    );

    // PaginatedResponse uses 'items' not 'data'
    const samples = samplesPage.items;

    // No data for this day
    if (samples.length === 0) {
      this.logger.debug('No samples found for daily aggregate', {
        context: 'HealthAggregationService.computeDailyAggregate',
        userId,
        metricCode,
        date,
      });
      return null;
    }

    // Convert to AggregationInput (filter out null values for numeric aggregation)
    const aggregationInputs: AggregationInput[] = samples
      .filter((s): s is typeof s & { value: NonNullable<typeof s.value> } => s.value !== null)
      .map((s) => ({
        value: Number(s.value),
        startAt: s.startAt,
        endAt: s.endAt,
      }));

    if (aggregationInputs.length === 0) {
      this.logger.debug('No numeric samples found for daily aggregate', {
        context: 'HealthAggregationService.computeDailyAggregate',
        userId,
        metricCode,
        date,
        totalSamples: samples.length,
      });
      return null;
    }

    // Compute aggregate using the pure method
    const result = this.aggregateWithValueKind(aggregationInputs, valueKind, metricCode);

    // Get unit from first sample
    const unit = samples.find((s): s is typeof s & { unit: string } => s.unit !== null)?.unit ?? null;

    // Build result with ValueKind-appropriate fields
    const dailyAggregate: DailyAggregate = {
      date,
      timezone: userTimezone,
      metricCode,
      valueKind,
      sampleCount: result.sampleCount,
      value: result.aggregatedValue,
      unit,
      rangeStartUtc,
      rangeEndUtc,
    };

    // Add ValueKind-appropriate statistics
    switch (valueKind) {
      case 'SCALAR_NUM':
        // SCALAR: avg, min, max (no sum - meaningless)
        return {
          ...dailyAggregate,
          avgValue: result.avgValue,
          minValue: result.minValue,
          maxValue: result.maxValue,
        };

      case 'CUMULATIVE_NUM':
        // CUMULATIVE: sum only (no avg - meaningless)
        return {
          ...dailyAggregate,
          sumValue: result.aggregatedValue, // delta = max - min
        };

      case 'INTERVAL_NUM':
        // INTERVAL: sum and avg both make sense
        return {
          ...dailyAggregate,
          sumValue: result.sumValue,
          avgValue: result.avgValue,
          minValue: result.minValue,
          maxValue: result.maxValue,
        };

      default:
        // TypeScript exhaustiveness - should never reach here
        const _exhaustive: never = valueKind;
        throw new Error(`Unexpected valueKind: ${_exhaustive}`);
    }
  }

  /**
   * P0-D: Compute category aggregate for CATEGORY metrics.
   *
   * For metrics like sleep_stage that have categorical values, this computes:
   * - Count per category (awake, light, deep, rem)
   * - Mode (most frequent category)
   * - Duration per category (if samples have start/end times)
   *
   * @param userId - User ID
   * @param metricCode - Canonical metric code (must be CATEGORY valueKind)
   * @param date - Date string in YYYY-MM-DD format (user's local date)
   * @param userTimezone - IANA timezone string
   * @returns CategoryAggregate with counts and mode
   * @throws Error if repository not configured
   * @throws InvalidAggregationError if metric is not CATEGORY type
   */
  async computeCategoryAggregate(
    userId: string,
    metricCode: string,
    date: string,
    userTimezone: string
  ): Promise<CategoryAggregate | null> {
    // FAIL FAST: Repository required
    if (!this.healthSampleRepository) {
      throw new Error(
        'HealthAggregationService: healthSampleRepository required for computeCategoryAggregate. ' +
          'Initialize service with repository dependency.'
      );
    }

    // Validate metric code
    if (!isHealthMetricCode(metricCode)) {
      throw new UnknownHealthMetricCodeError(metricCode);
    }

    const def = getMetricDefinition(metricCode as HealthMetricCode);
    const valueKind = def.valueKind;

    // FAIL FAST: Only CATEGORY metrics allowed
    if (valueKind !== 'CATEGORY') {
      throw new InvalidAggregationError(
        metricCode,
        `Metric '${metricCode}' is not a CATEGORY metric (valueKind: ${valueKind}). ` +
          `Use computeDailyAggregate() for numeric metrics.`
      );
    }

    // Convert date + timezone to UTC range
    const { rangeStartUtc, rangeEndUtc } = this.dateToUtcRange(date, userTimezone);

    // Load samples
    const samplesPage = await this.healthSampleRepository.queryByUserAndTimeRange(
      userId,
      rangeStartUtc,
      rangeEndUtc,
      metricCode,
      { page: 1, pageSize: 10000 }
    );

    // PaginatedResponse uses 'items' not 'data'
    const samples = samplesPage.items;

    if (samples.length === 0) {
      return null;
    }

    // Count per category
    const countByCategory: Record<string, number> = {};
    const durationByCategory: Record<string, number> = {};

    for (const sample of samples) {
      const category = sample.categoryCode ?? 'unknown';
      countByCategory[category] = (countByCategory[category] ?? 0) + 1;

      // Calculate duration in seconds
      const durationSec = (sample.endAt.getTime() - sample.startAt.getTime()) / 1000;
      durationByCategory[category] = (durationByCategory[category] ?? 0) + durationSec;
    }

    // Find mode (most frequent category)
    let mode: string | null = null;
    let maxCount = 0;
    for (const [category, count] of Object.entries(countByCategory)) {
      if (count > maxCount) {
        maxCount = count;
        mode = category;
      }
    }

    return {
      date,
      timezone: userTimezone,
      metricCode,
      sampleCount: samples.length,
      countByCategory,
      mode,
      durationByCategory,
      rangeStartUtc,
      rangeEndUtc,
    };
  }

  /**
   * Convert a local date string + timezone to UTC range.
   *
   * @param date - Date string in YYYY-MM-DD format
   * @param timezone - IANA timezone string
   * @returns Object with rangeStartUtc and rangeEndUtc
   */
  private dateToUtcRange(
    date: string,
    timezone: string
  ): { rangeStartUtc: Date; rangeEndUtc: Date } {
    // Parse date components
    const [year, month, day] = date.split('-').map(Number);
    if (!year || !month || !day) {
      throw new Error(`Invalid date format: ${date}. Expected YYYY-MM-DD.`);
    }

    // Create date at midnight in user's timezone
    // Use Intl.DateTimeFormat to get the timezone offset
    const startLocal = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
    const endLocal = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));

    // Get timezone offset at this date (handles DST)
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    // For simplicity, use a common approach: create dates in UTC and adjust
    // This is a simplified implementation - for production, consider using
    // a library like date-fns-tz or luxon for accurate timezone handling
    const offsetMs = this.getTimezoneOffsetMs(timezone, startLocal);

    const rangeStartUtc = new Date(startLocal.getTime() - offsetMs);
    const rangeEndUtc = new Date(endLocal.getTime() - offsetMs + 1); // +1ms for exclusive end

    return { rangeStartUtc, rangeEndUtc };
  }

  /**
   * Get timezone offset in milliseconds for a given timezone and date.
   *
   * @param timezone - IANA timezone string
   * @param date - Reference date for DST calculation
   * @returns Offset in milliseconds (positive = ahead of UTC)
   */
  private getTimezoneOffsetMs(timezone: string, date: Date): number {
    // Create formatter for the timezone
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    // Format the date in the target timezone
    const parts = formatter.formatToParts(date);
    const getPart = (type: string) => {
      const part = parts.find((p) => p.type === type);
      return part ? parseInt(part.value, 10) : 0;
    };

    // Create a date in the target timezone
    const tzDate = new Date(Date.UTC(
      getPart('year'),
      getPart('month') - 1,
      getPart('day'),
      getPart('hour'),
      getPart('minute'),
      getPart('second')
    ));

    // The difference between UTC and the timezone representation
    return tzDate.getTime() - date.getTime();
  }
}
