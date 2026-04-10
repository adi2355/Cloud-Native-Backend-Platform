/**
 * Health Sample Repository
 * Handles health data operations in PostgreSQL
 *
 * Features:
 * - Batch upsert with two-layer idempotency
 * - Time-series data querying with efficient indexing
 * - Metric-specific aggregation queries
 * - JSONB metadata storage
 *
 * ARCHITECTURE:
 * - Single table for all metric types (differentiated by metricCode)
 * - Push-only sync (device → server, no pull)
 * - Two-layer idempotency:
 *   1. Request-level: requestId prevents duplicate batch processing
 *   2. Sample-level: (userId, sourceId, sourceRecordId) unique constraint
 *
 * - INSERT...ON CONFLICT DO UPDATE for idempotent upserts
 * - Provider corrections supported: value, unit, categoryCode, valueKind, endAt are updated on conflict
 * - This allows HealthKit/Health Connect to send corrected data for existing samples
 * - Soft-deleted samples not resurrected (is_deleted guard in DO UPDATE WHERE clause)
 * - No compaction (unlike entity sync outbox)
 * - Indefinite retention (no TTL)
 *
 * @see HEALTHKITPLANFINAL.md for architectural decisions
 */

import { PrismaClient, HealthSample, HealthIngestRequest, Prisma } from '@prisma/client';
import { BaseRepository, PaginatedResponse, PaginationParams, CursorPaginatedResponse } from './base.repository';
import { LoggerService } from '../services/logger.service';
import { PerformanceMonitoringService, PerformanceMetricType } from '../services/performanceMonitoring.service';
import { AppError, ErrorCodes } from '../utils/AppError';
import type { HealthMetricCode, HealthSampleCursor, SampleErrorCode } from '@shared/contracts';
import { encodeHealthSampleCursor, buildHealthSampleCursor } from '@shared/contracts';
import * as crypto from 'crypto';
import { getHealthMetricsTags, shouldEmitHealthMetrics } from '../utils/healthMetrics';
import { recordDbConnectionMetrics } from '../utils/dbConnectionMetrics';

// Types

/**
 * Valid valueKind discriminator values.
 * Aligned with shared contracts and enforced by CHECK constraint in PostgreSQL.
 */
export type HealthValueKind = 'SCALAR_NUM' | 'CUMULATIVE_NUM' | 'INTERVAL_NUM' | 'CATEGORY';

/**
 * Input for creating a single health sample.
 *
 * DATA MODEL (Discriminated by valueKind):
 *
 * The valueKind field is the authoritative discriminator for the sample shape.
 * CHECK constraints in PostgreSQL enforce these invariants at the DB level.
 *
 * For NUMERIC samples (SCALAR_NUM, CUMULATIVE_NUM, INTERVAL_NUM):
 * - valueKind: 'SCALAR_NUM' | 'CUMULATIVE_NUM' | 'INTERVAL_NUM'
 * - value: required numeric measurement (non-null)
 * - unit: required measurement unit (non-null)
 * - categoryCode: must be null
 *
 * For CATEGORY samples (e.g., sleep_stage):
 * - valueKind: 'CATEGORY'
 * - categoryCode: required category identifier (e.g., 'awake', 'light', 'deep', 'rem')
 * - value: must be null
 * - unit: must be null
 *
 * INVARIANTS (enforced by CHECK constraints in PostgreSQL - migration 20260123200000):
 * - valueKind IN ('SCALAR_NUM', 'CUMULATIVE_NUM', 'INTERVAL_NUM', 'CATEGORY')
 * - NUMERIC: value + unit NOT NULL, categoryCode NULL
 * - CATEGORY: categoryCode NOT NULL, value + unit NULL
 * - startAt <= endAt
 * - value >= 0 when present
 */
export interface CreateHealthSampleInput {
  userId: string;
  sourceId: string;
  sourceRecordId: string;
  metricCode: string;
  /** Discriminator for value shape - enforced by DB CHECK constraint */
  valueKind: HealthValueKind;
  /** Numeric value - null for CATEGORY samples, required for NUMERIC samples */
  value: number | null;
  /** Unit of measurement - null for CATEGORY samples, required for NUMERIC samples */
  unit: string | null;
  /** Category code for CATEGORY valueKind samples (null for numeric samples) */
  categoryCode?: string | null;
  startAt: Date;
  endAt: Date;
  /** Canonical duration in seconds for INTERVAL_NUM metrics */
  durationSeconds?: number | null;
  /** Device identifier from platform, if available */
  deviceId?: string | null;
  /** External UUID from platform metadata, if available */
  externalUuid?: string | null;
  metadata?: Record<string, unknown>;
  requestId?: string;
  /**
   * Timezone offset at sample collection time (minutes from UTC).
   * Positive = east of UTC (e.g., +330 for IST), Negative = west (e.g., -300 for EST)
   */
  timezoneOffsetMin?: number | null;
}

/**
 * Result of batch upsert operation.
 *
 * unambiguous sample identification. This matches the DB unique constraint:
 * (user_id, source_id, source_record_id, start_at)
 *
 * Clients use these fields to correlate server responses with local samples.
 */
export interface BatchUpsertResult {
  /** Samples that were successfully inserted */
  successful: Array<{
    sourceId: string;
    sourceRecordId: string;
    startAt: string; // ISO 8601 timestamp
    serverId: string;
  }>;
  /** Samples that failed validation or constraints */
  failed: Array<{
    sourceId: string;
    sourceRecordId: string;
    startAt: string; // ISO 8601 timestamp
    error: string;
    // ALIGNED WITH SHARED CONTRACT: Use SampleErrorCode from @shared/contracts
    // instead of manual inline union to prevent type drift.
    // See health.contract.ts:1083-1097 for complete list.
    errorCode: SampleErrorCode;
    retryable: boolean;
  }>;
  /**
   * Deletion results (optional for backward compatibility).
   * Present when the request included deletions.
   *
   * STOP-SHIP #1 FIX: Deletions are now included in the idempotency-cached response.
   * This ensures that retries with the same requestId return identical deletion results.
   */
  deletions?: {
    /** Successfully deleted samples */
    successful: Array<{
      sourceId: string;
      sourceRecordId: string;
      /** Sample start timestamp (ISO 8601). Present when request included startAt. */
      startAt?: string;
      /**
       * P0-G FIX: Sample end timestamp (ISO 8601).
       * Without this, projections must use imprecise time buffers.
       */
      endAt?: string;
      /**
       * P0-G FIX: Metric code of the deleted sample.
       * Enables downstream projections to filter by affected metrics.
       */
      metricCode?: string;
      /**
       * EDGE CASE 2 FIX: Per-sample timezone offset at recording time (minutes from UTC).
       * Read from DB column timezone_offset_min during deletion.
       * Used by computeAffectedLocalDates for correct date bucketing of deleted
       * interval samples, avoiding the silent UTC fallback.
       * null = not recorded (legacy sample). undefined = not available (cached response).
       */
      timezoneOffsetMin?: number | null;
      /** Whether the sample was already deleted (true if this was a no-op) */
      alreadyDeleted?: boolean;
    }>;
    /** Failed deletions */
    failed: Array<{
      sourceId: string;
      sourceRecordId: string;
      /** Sample start timestamp (ISO 8601). Present when request included startAt. */
      startAt?: string;
      error: string;
      errorCode: SampleErrorCode;
      retryable: boolean;
    }>;
  };
  /** Processing metrics */
  metrics: {
    totalReceived: number;
    successfulCount: number;
    failedCount: number;
    /** Number of samples deleted. Optional for backward compatibility. */
    deletedCount?: number;
    durationMs: number;
  };
}

/**
 * Query parameters for health samples.
 */
export interface HealthSampleQueryParams extends PaginationParams {
  userId?: string;
  metricCode?: string;
  startTime?: Date;
  endTime?: Date;
  sourceId?: string;
}

/**
 * Time range for aggregation queries.
 */
export interface TimeRange {
  startAt: Date;
  endAt: Date;
}

/**
 * Aggregated metric result.
 */
export interface AggregatedMetric {
  metricCode: string;
  value: number;
  unit: string;
  sampleCount: number;
  startAt: Date;
  endAt: Date;
}

/**
 * Status values for HealthIngestRequest.
 * Aligned with CHECK constraint in migration.
 */
export type HealthIngestRequestStatus = 'processing' | 'completed' | 'partial' | 'failed';

/**
 * Callback for writing outbox event inside the atomic mutation transaction.
 *
 * sample upserts, deletions, watermark bump, and ingest request status update.
 * This guarantees: mutations committed ⇒ outbox event durable ⇒ projections advance.
 *
 * If the callback throws, the ENTIRE transaction rolls back — no partial state.
 *
 * @param tx - Prisma transaction client
 * @param result - The BatchUpsertResult being committed
 * @param watermarkAfter - The watermark sequence number after all mutations in this transaction
 * @returns Promise that resolves when outbox event is written
 */
export type HealthIngestOutboxCallback = (
  tx: Prisma.TransactionClient,
  result: BatchUpsertResult,
  watermarkAfter: bigint
) => Promise<void>;

/**
 * Result of checking request-level idempotency.
 *
 * IDEMPOTENCY FLOW:
 * 1. NEW_REQUEST: First time seeing this requestId OR stale processing recovery
 *    - True new request: requestId not found in HealthIngestRequest table
 *    - Stale recovery: requestId found with status='processing' but createdAt
 *      older than STALE_PROCESSING_TIMEOUT_MS (5 minutes) - allows reprocessing
 *      to recover from crashed processes
 * 2. CACHED_RESPONSE: Same requestId + payloadHash, completed - return cached response
 * 3. PAYLOAD_MISMATCH: Same requestId but different payloadHash - reject (tampering)
 * 4. STILL_PROCESSING: Request exists with status='processing' and not stale - retry later
 */
export type IdempotencyCheckResult =
  | { status: 'NEW_REQUEST' }
  | { status: 'CACHED_RESPONSE'; cachedResult: BatchUpsertResult }
  | { status: 'PAYLOAD_MISMATCH'; originalHash: string }
  | { status: 'STILL_PROCESSING'; existingRequestId: string };

/**
 * Input for creating a HealthIngestRequest record.
 */
export interface CreateIngestRequestInput {
  userId: string;
  requestId: string;
  payloadHash: string;
  sampleCount: number;
}

/**
 * Result of a single upserted sample from the DB.
 * Used internally for mapping upsert results back to input samples.
 *
 * (sourceId, sourceRecordId, startAt) to match DB unique constraint.
 */
interface UpsertedSampleResult {
  id: string;
  sourceId: string;
  sourceRecordId: string;
  startAt: string; // ISO 8601
}

interface UpsertWithReturningResult {
  resultMap: Map<string, UpsertedSampleResult>;
  insertedCount: number;
  updatedCount: number;
}

interface BatchUpsertDbMetrics {
  upsertDurationMs: number;
  insertedCount: number;
  updatedCount: number;
}

// Constants

/**
 * Stale processing timeout in milliseconds.
 * If a request has been in 'processing' status for longer than this,
 * it is considered stale and can be recovered (reprocessed).
 *
 * RATIONALE:
 * - Prevents deadlock when a process crashes mid-processing
 * - 5 minutes is generous for batch processing (typically <30s)
 * - Client can retry with same requestId after timeout
 *
 * TRADE-OFF:
 * - Too short: May cause duplicate processing if network is slow
 * - Too long: Clients wait unnecessarily after crashes
 * - 5 minutes balances both concerns
 */
const STALE_PROCESSING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const STILL_PROCESSING_RETRY_AFTER_MS = 90 * 1000; // 90 seconds

// Repository

/**
 * Repository for health sample operations.
 * Handles time-series health data with PostgreSQL.
 */
export class HealthSampleRepository extends BaseRepository<HealthSample> {
  private performanceMonitoring?: PerformanceMonitoringService;

  constructor(prisma: PrismaClient, logger: LoggerService, performanceMonitoring?: PerformanceMonitoringService) {
    super(prisma, 'HealthSample', logger);
    this.performanceMonitoring = performanceMonitoring;
  }

  /**
   * Batch upsert health samples with idempotency.
   *
   * Uses INSERT...ON CONFLICT DO UPDATE pattern for sample-level idempotency.
   * Each sample is identified by (userId, sourceId, sourceRecordId, startAt).
   *
   * to enable unambiguous client-side correlation with local samples.
   *
   * @param samples - Array of samples to upsert
   * @param requestId - Request ID for logging and tracking
   * @returns Batch result with successful and failed samples
   */
  async batchUpsert(
    samples: CreateHealthSampleInput[],
    requestId: string,
    options?: {
      onDbMetrics?: (metrics: BatchUpsertDbMetrics) => void;
      /**
       * Optional Prisma transaction client. When provided, all DB operations
       * (upsert chunks + fallback lookups) execute within this transaction.
       * Used by processIngestRequest for atomic mutation + outbox + watermark.
       */
      tx?: Prisma.TransactionClient;
    }
  ): Promise<BatchUpsertResult> {
    const startTime = Date.now();
    const successful: BatchUpsertResult['successful'] = [];
    const failed: BatchUpsertResult['failed'] = [];

    // Helper to convert Date to ISO string for response
    const toIsoString = (d: Date): string => d.toISOString();

    try {
      this.logger.debug('Starting batch upsert', {
        context: 'HealthSampleRepository.batchUpsert',
        requestId,
        sampleCount: samples.length,
      });

      // Validate samples and check for duplicates within batch
      const seenRecords = new Set<string>();
      const validSamples: CreateHealthSampleInput[] = [];

      for (const sample of samples) {
        // Composite key matches DB unique constraint: (user_id, source_id, source_record_id, start_at)
        const startAtIso = toIsoString(sample.startAt);
        const key = HealthSampleRepository.makeSampleCompositeKey(
          sample.sourceId,
          sample.sourceRecordId,
          startAtIso
        );

        // Check for duplicate in batch using composite key
        if (seenRecords.has(key)) {
          failed.push({
            sourceId: sample.sourceId,
            sourceRecordId: sample.sourceRecordId,
            startAt: startAtIso,
            error: 'Duplicate sample in batch (same sourceId + sourceRecordId + startAt)',
            errorCode: 'DUPLICATE_IN_BATCH',
            retryable: false,
          });
          continue;
        }

        // Basic validation
        // Note: value can be null for CATEGORY samples, so only validate if present
        if (sample.value != null && sample.value < 0) {
          failed.push({
            sourceId: sample.sourceId,
            sourceRecordId: sample.sourceRecordId,
            startAt: startAtIso,
            error: 'Value must be non-negative',
            errorCode: 'VALIDATION_ERROR',
            retryable: false,
          });
          continue;
        }

        // FAIL FAST: Reject NaN/Infinity numeric values before they reach raw SQL.
        // NaN bypasses the `< 0` check above (NaN < 0 === false), and would cause
        // a PostgreSQL error inside $queryRawUnsafe, poisoning the transaction.
        if (sample.value != null && !Number.isFinite(sample.value)) {
          failed.push({
            sourceId: sample.sourceId,
            sourceRecordId: sample.sourceRecordId,
            startAt: startAtIso,
            error: `Value must be a finite number, got ${sample.value}`,
            errorCode: 'VALIDATION_ERROR',
            retryable: false,
          });
          continue;
        }

        if (sample.durationSeconds != null && !Number.isFinite(sample.durationSeconds)) {
          failed.push({
            sourceId: sample.sourceId,
            sourceRecordId: sample.sourceRecordId,
            startAt: startAtIso,
            error: `durationSeconds must be a finite number, got ${sample.durationSeconds}`,
            errorCode: 'VALIDATION_ERROR',
            retryable: false,
          });
          continue;
        }

        if (sample.timezoneOffsetMin != null && !Number.isFinite(sample.timezoneOffsetMin)) {
          failed.push({
            sourceId: sample.sourceId,
            sourceRecordId: sample.sourceRecordId,
            startAt: startAtIso,
            error: `timezoneOffsetMin must be a finite number, got ${sample.timezoneOffsetMin}`,
            errorCode: 'VALIDATION_ERROR',
            retryable: false,
          });
          continue;
        }

        if (sample.startAt > sample.endAt) {
          failed.push({
            sourceId: sample.sourceId,
            sourceRecordId: sample.sourceRecordId,
            startAt: startAtIso,
            error: 'startAt must be <= endAt',
            errorCode: 'VALIDATION_ERROR',
            retryable: false,
          });
          continue;
        }

        seenRecords.add(key);
        validSamples.push(sample);
      }

      // Execute batch insert with conflict handling
      if (validSamples.length > 0) {
        // Use raw query for INSERT...ON CONFLICT with RETURNING
        // Returns map keyed by composite key (sourceId|sourceRecordId|startAt)
        const upsertStart = Date.now();
        const { resultMap: upsertedMap, insertedCount, updatedCount } =
          await this.executeUpsertWithReturning(validSamples, requestId, options?.tx);
        const upsertDurationMs = Date.now() - upsertStart;

        options?.onDbMetrics?.({
          upsertDurationMs,
          insertedCount,
          updatedCount,
        });

        // STEP 1: Process upserted samples (inserted or updated)
        for (const sample of validSamples) {
          const startAtIso = toIsoString(sample.startAt);
          const compositeKey = HealthSampleRepository.makeSampleCompositeKey(
            sample.sourceId,
            sample.sourceRecordId,
            startAtIso
          );
          const upsertResult = upsertedMap.get(compositeKey);

          if (upsertResult) {
            successful.push({
              sourceId: upsertResult.sourceId,
              sourceRecordId: upsertResult.sourceRecordId,
              startAt: upsertResult.startAt,
              serverId: upsertResult.id,
            });
          }
        }

        // STEP 2: Handle samples that weren't returned (soft-deleted or other edge case)
        // Samples not in upsertedMap were likely blocked by is_deleted = false guard
        for (const sample of validSamples) {
          const startAtIso = toIsoString(sample.startAt);
          const compositeKey = HealthSampleRepository.makeSampleCompositeKey(
            sample.sourceId,
            sample.sourceRecordId,
            startAtIso
          );

          if (!upsertedMap.has(compositeKey)) {
            // Not returned from RETURNING clause - check if it exists but is deleted
            const existingSample = await this.findByCompositeKey(
              sample.userId,
              sample.sourceId,
              sample.sourceRecordId,
              sample.startAt,
              options?.tx
            );

            if (existingSample && existingSample.isDeleted) {
              // Sample exists but is soft-deleted - don't resurrect
              failed.push({
                sourceId: sample.sourceId,
                sourceRecordId: sample.sourceRecordId,
                startAt: startAtIso,
                error: 'Sample exists but was soft-deleted and cannot be resurrected',
                errorCode: 'VALIDATION_ERROR',
                retryable: false,
              });
            } else if (existingSample) {
              // Sample exists and not deleted - treat as success (already there)
              successful.push({
                sourceId: sample.sourceId,
                sourceRecordId: sample.sourceRecordId,
                startAt: startAtIso,
                serverId: existingSample.id,
              });
            } else {
              // Truly unexpected - neither inserted nor found
              failed.push({
                sourceId: sample.sourceId,
                sourceRecordId: sample.sourceRecordId,
                startAt: startAtIso,
                error: 'Unexpected: sample neither inserted nor found in database',
                errorCode: 'SERVER_ERROR',
                retryable: true,
              });
            }
          }
        }
      }

      const durationMs = Date.now() - startTime;

      this.logger.info('Batch upsert complete', {
        context: 'HealthSampleRepository.batchUpsert',
        requestId,
        successfulCount: successful.length,
        failedCount: failed.length,
        totalReceived: samples.length,
        durationMs,
      });

      return {
        successful,
        failed,
        metrics: {
          totalReceived: samples.length,
          successfulCount: successful.length,
          failedCount: failed.length,
          durationMs,
        },
      };
    } catch (error) {
      this.logger.error('Batch upsert failed', {
        context: 'HealthSampleRepository.batchUpsert',
        requestId,
        sampleCount: samples.length,
        error: error instanceof Error ? error.message : String(error),
      });

      // TRANSACTION CONTEXT: Re-throw immediately.
      //
      // When running inside a Prisma $transaction, a SQL failure puts the
      // PostgreSQL connection into an aborted state (error 25P02). All
      // subsequent queries on this connection will fail with "current
      // transaction is aborted, commands ignored until end of transaction
      // block". Swallowing the error and returning a "failed result" object
      // would:
      //   1. Hide the REAL SQL error from the client (they'd see a misleading
      //      25P02 from the next operation, e.g. markSamplesDeletedPrecise)
      //   2. Report incorrect "successful" entries from partially-completed
      //      chunks that WILL be rolled back
      //   3. Allow downstream steps (watermark, outbox) to execute on a
      //      poisoned connection, producing more cascading 25P02 errors
      //
      // Re-throwing lets processIngestRequest's transaction catch block handle
      // the failure correctly: the transaction rolls back atomically, the
      // ingest request is marked 'failed' via failIngestRequest(), and the
      // client receives the REAL error message for proper debugging.
      if (options?.tx) {
        throw error;
      }

      // Standalone mode (no transaction): graceful degradation is safe.
      // The connection is not poisoned, so we can mark unprocessed samples
      // as failed and return a partial result.

      // Helper to check if sample is already processed
      const isProcessed = (s: CreateHealthSampleInput): boolean => {
        const startAtIso = toIsoString(s.startAt);
        const key = HealthSampleRepository.makeSampleCompositeKey(s.sourceId, s.sourceRecordId, startAtIso);
        return successful.some(succ =>
          HealthSampleRepository.makeSampleCompositeKey(succ.sourceId, succ.sourceRecordId, succ.startAt) === key
        ) || failed.some(fail =>
          HealthSampleRepository.makeSampleCompositeKey(fail.sourceId, fail.sourceRecordId, fail.startAt) === key
        );
      };

      // Mark all remaining samples as failed
      for (const sample of samples) {
        if (!isProcessed(sample)) {
          const startAtIso = toIsoString(sample.startAt);
          failed.push({
            sourceId: sample.sourceId,
            sourceRecordId: sample.sourceRecordId,
            startAt: startAtIso,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: 'SERVER_ERROR',
            retryable: true,
          });
        }
      }

      return {
        successful,
        failed,
        metrics: {
          totalReceived: samples.length,
          successfulCount: successful.length,
          failedCount: failed.length,
          durationMs: Date.now() - startTime,
        },
      };
    }
  }

  /**
   * Composite key for sample identification matching DB unique constraint.
   * Used internally for mapping upsert results back to input samples.
   */
  private static makeSampleCompositeKey(sourceId: string, sourceRecordId: string, startAt: string): string {
    // Normalize sourceRecordId to lowercase for consistent composite key matching.
    // DB rows should already be lowercase, but this ensures key consistency
    // even if historical data contained mixed-case values.
    return `${sourceId}|${sourceRecordId.toLowerCase()}|${startAt}`;
  }

  /**
   * Execute INSERT...ON CONFLICT DO UPDATE with RETURNING.
   * Uses raw SQL for proper conflict handling with returned IDs.
   *
   * - Numeric samples (SCALAR_NUM, CUMULATIVE_NUM, INTERVAL_NUM): value + unit present, categoryCode NULL
   * - Category samples (CATEGORY): categoryCode present, value + unit NULL
   *
   * ON CONFLICT BEHAVIOR:
   * - Updates metadata (corrections allowed)
   * - UPDATES mutable fields (value, unit, categoryCode, valueKind, endAt) to support provider corrections
   * - DOES NOT resurrect soft-deleted samples (is_deleted = false guard)
   * - Returns both inserted AND updated rows for response mapping
   *
   * RETURNS: Map keyed by composite key (sourceId|sourceRecordId|startAt) to match
   * the DB unique constraint and allow unambiguous sample identification.
   */
  private async executeUpsertWithReturning(
    samples: CreateHealthSampleInput[],
    requestId: string,
    tx?: Prisma.TransactionClient
  ): Promise<UpsertWithReturningResult> {
    const resultMap = new Map<string, UpsertedSampleResult>();
    let insertedCount = 0;
    let updatedCount = 0;

    // Process in chunks to avoid query size limits
    const chunkSize = 100;
    for (let i = 0; i < samples.length; i += chunkSize) {
      const chunk = samples.slice(i, i + chunkSize);

      // Build VALUES clause (16 parameters per sample: includes value_kind + provenance + P0-E timezone)
      // NOTE: gen_random_uuid() is called directly in SQL for the id column rather than
      // relying on a column DEFAULT. This makes the INSERT self-contained and immune to
      // missing DEFAULT in the database schema (see: migration 20260128100000).
      const paramsPerSample = 16;
      const values = chunk.map((_, idx) => {
        const offset = idx * paramsPerSample;
        return `(gen_random_uuid(), $${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}::timestamptz, $${offset + 11}::timestamptz, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15}::jsonb, $${offset + 16})`;
      }).join(', ');

      // Flatten parameters
      // LAST LINE OF DEFENSE: Lowercase sourceRecordId before SQL binding.
      // Primary normalization: Zod schema. Secondary: service layer.
      // This ensures DB never receives mixed-case sourceRecordIds regardless of call path.
      const params: unknown[] = [];
      for (const sample of chunk) {
        params.push(
          sample.userId,
          sample.sourceId,
          sample.sourceRecordId.toLowerCase(),
          sample.metricCode,
          sample.valueKind,         // valueKind discriminator
          sample.value,
          sample.unit,
          sample.categoryCode ?? null,
          requestId,
          sample.startAt.toISOString(),
          sample.endAt.toISOString(),
          sample.durationSeconds ?? null,
          sample.deviceId ?? null,
          sample.externalUuid ?? null,
          sample.metadata ? JSON.stringify(sample.metadata) : null,
          sample.timezoneOffsetMin ?? null  // P0-E: Timezone offset for DST-aware aggregation
        );
      }

      // Execute INSERT with ON CONFLICT DO UPDATE
      //
      // PROVIDER CORRECTIONS SUPPORT:
      // - Updates ALL mutable fields (value, unit, categoryCode, valueKind, endAt, metadata)
      // - This allows HealthKit/Health Connect to send corrected values for existing samples
      // - Example: Apple Health might correct sleep duration or step count after recalculation
      //
      // SOFT-DELETE GUARD:
      // - WHERE is_deleted = false prevents resurrecting soft-deleted samples
      // - If a sample was deleted, provider corrections will NOT update it (INSERT becomes no-op)
      // - This enforces the monotonic soft-delete invariant (once deleted, never undeleted)
      //
      // TIMESCALEDB COMPATIBILITY:
      // - ON CONFLICT includes start_at for hypertable partition column requirement
      // - See migration: 20260128000000_convert_health_samples_to_timescaledb
      //
      // WRITE AMPLIFICATION NOTE:
      // - Every upsert touches all mutable columns even if values haven't changed
      // - If this becomes a performance issue, consider adding IS DISTINCT FROM checks
      // - For now, simplicity and correctness are prioritized over optimization
      // This allows unambiguous correlation between input samples and DB results.
      const client = tx ?? this.prisma;
      const result = await client.$queryRawUnsafe<Array<{
        id: string;
        source_id: string;
        source_record_id: string;
        start_at: Date;
        inserted: boolean;
      }>>(
        `INSERT INTO health_samples (
          id, user_id, source_id, source_record_id, metric_code, value_kind, value, unit, category_code, request_id, start_at, end_at, duration_seconds, device_id, external_uuid, metadata, timezone_offset_min
        ) VALUES ${values}
        ON CONFLICT (user_id, source_id, source_record_id, start_at)
        DO UPDATE SET
          value = EXCLUDED.value,
          unit = EXCLUDED.unit,
          category_code = EXCLUDED.category_code,
          value_kind = EXCLUDED.value_kind,
          end_at = EXCLUDED.end_at,
          duration_seconds = EXCLUDED.duration_seconds,
          device_id = COALESCE(EXCLUDED.device_id, health_samples.device_id),
          external_uuid = COALESCE(EXCLUDED.external_uuid, health_samples.external_uuid),
          metadata = COALESCE(EXCLUDED.metadata, health_samples.metadata),
          request_id = EXCLUDED.request_id,
          timezone_offset_min = COALESCE(EXCLUDED.timezone_offset_min, health_samples.timezone_offset_min)
        WHERE health_samples.is_deleted = false
        RETURNING id, source_id, source_record_id, start_at, (xmax = 0) AS inserted`,
        ...params
      );

      // Map results using composite key (sourceId|sourceRecordId|startAt)
      for (const row of result) {
        const startAtIso = row.start_at.toISOString();
        const compositeKey = HealthSampleRepository.makeSampleCompositeKey(
          row.source_id,
          row.source_record_id,
          startAtIso
        );
        resultMap.set(compositeKey, {
          id: row.id,
          sourceId: row.source_id,
          sourceRecordId: row.source_record_id,
          startAt: startAtIso,
        });
        if (row.inserted) {
          insertedCount += 1;
        } else {
          updatedCount += 1;
        }
      }
    }

    return { resultMap, insertedCount, updatedCount };
  }

  /**
   * Find sample ID by source record identifiers.
   * Used to get existing ID when conflict occurs.
   */
  private async findIdBySourceRecord(
    userId: string,
    sourceId: string,
    sourceRecordId: string
  ): Promise<string | null> {
    const sample = await this.prisma.healthSample.findFirst({
      where: {
        userId,
        sourceId,
        sourceRecordId,
      },
      select: { id: true },
    });
    return sample?.id ?? null;
  }

  /**
   * Find a sample by its full composite key.
   *
   * (user_id, source_id, source_record_id, start_at)
   *
   * This is used to check for soft-deleted samples or other edge cases
   * where the RETURNING clause didn't include a sample.
   *
   * @param userId - User ID
   * @param sourceId - Source identifier
   * @param sourceRecordId - Source record ID
   * @param startAt - Start timestamp
   * @returns The sample if found, null otherwise
   */
  private async findByCompositeKey(
    userId: string,
    sourceId: string,
    sourceRecordId: string,
    startAt: Date,
    tx?: Prisma.TransactionClient
  ): Promise<{ id: string; isDeleted: boolean } | null> {
    const client = tx ?? this.prisma;
    const sample = await client.healthSample.findFirst({
      where: {
        userId,
        sourceId,
        sourceRecordId,
        startAt,
      },
      select: { id: true, isDeleted: true },
    });
    return sample;
  }

  /**
   * Query health samples by user and time range.
   *
   * "treat deleted samples as excluded during compute"
   *
   * For session telemetry computation, use this method to ensure deleted samples
   * are not included in aggregations.
   */
  async queryByUserAndTimeRange(
    userId: string,
    startTime: Date,
    endTime: Date,
    metricCode?: string,
    params?: PaginationParams
  ): Promise<PaginatedResponse<HealthSample>> {
    try {
      const where: Prisma.HealthSampleWhereInput = {
        userId,
        // P0-A GUARDRAIL: Half-open interval [start, end) - use gte + lt, NOT lte
        // This ensures consistent semantics: sample at exactly endTime belongs to NEXT window
        startAt: {
          gte: startTime,
          lt: endTime,
        },
        // "treat deleted samples as excluded during compute"
        isDeleted: false,
        ...(metricCode && { metricCode }),
      };

      return this.findManyWithPagination<
        Prisma.HealthSampleFindManyArgs,
        Prisma.HealthSampleCountArgs
      >(
        (args) => this.prisma.healthSample.findMany(args),
        (args) => this.prisma.healthSample.count(args),
        {
          ...params,
          where,
          orderBy: params?.orderBy || { startAt: 'desc' },
        }
      );
    } catch (error) {
      throw this.handleError(error, 'queryByUserAndTimeRange');
    }
  }

  /**
   * Get latest sample for a user and metric.
   */
  async getLatestForUserAndMetric(
    userId: string,
    metricCode: string
  ): Promise<HealthSample | null> {
    try {
      return await this.prisma.healthSample.findFirst({
        where: {
          userId,
          metricCode,
        },
        orderBy: { startAt: 'desc' },
      });
    } catch (error) {
      throw this.handleError(error, 'getLatestForUserAndMetric');
    }
  }

  /**
   * Get sample count for a user within time range.
   */
  async getCountByUserAndTimeRange(
    userId: string,
    startTime: Date,
    endTime: Date,
    metricCode?: string
  ): Promise<number> {
    try {
      return await this.prisma.healthSample.count({
        where: {
          userId,
          // P0-A GUARDRAIL: Half-open interval [start, end) - use gte + lt, NOT lte
          startAt: {
            gte: startTime,
            lt: endTime,
          },
          ...(metricCode && { metricCode }),
        },
      });
    } catch (error) {
      throw this.handleError(error, 'getCountByUserAndTimeRange');
    }
  }

  /**
   * Get distinct metric codes for a user.
   *
   * the user has at least one active (non-deleted) sample.
   */
  async getDistinctMetricCodes(userId: string): Promise<string[]> {
    try {
      const result = await this.prisma.$queryRaw<Array<{ metric_code: string }>>`
        SELECT DISTINCT metric_code
        FROM health_samples
        WHERE user_id = ${userId}
          AND is_deleted = false
        ORDER BY metric_code
      `;
      return result.map((r) => r.metric_code);
    } catch (error) {
      throw this.handleError(error, 'getDistinctMetricCodes');
    }
  }

  /**
   * Aggregate samples for a user, metric, and time range.
   * Returns sum, avg, min, max depending on metric type.
   *
   * CATEGORY samples (e.g., sleep stages) have NULL value and are excluded.
   *
   * This is semantically correct because:
   * - CATEGORY samples represent discrete states (awake/light/deep/rem), not quantities
   * - Aggregating NULL values with numeric values produces misleading results
   * - COUNT should only count samples that contribute to the aggregation
   *
   * To aggregate CATEGORY samples, use a different method that groups by categoryCode.
   */
  async aggregateSamples(
    userId: string,
    metricCode: string,
    startTime: Date,
    endTime: Date,
    aggregationType: 'sum' | 'avg' | 'min' | 'max' | 'count'
  ): Promise<AggregatedMetric | null> {
    try {
      const aggFunction = aggregationType === 'count'
        ? 'COUNT(*)::numeric'
        : `${aggregationType.toUpperCase()}(value)`;

      // This ensures analytics correctness and respects user privacy (deleted data should not
      // appear in aggregations or influence insights).
      const result = await this.prisma.$queryRaw<Array<{
        agg_value: Prisma.Decimal;
        sample_count: bigint;
        unit: string;
      }>>`
        -- P0-A GUARDRAIL: Half-open interval [start, end) - use >= + <, NOT <=
        SELECT
          ${Prisma.raw(aggFunction)} as agg_value,
          COUNT(*) as sample_count,
          MIN(unit) as unit
        FROM health_samples
        WHERE user_id = ${userId}
          AND metric_code = ${metricCode}
          AND start_at >= ${startTime}
          AND start_at < ${endTime}
          AND value IS NOT NULL
          AND is_deleted = false
      `;

      const row = result[0];
      if (!row || row.sample_count === BigInt(0)) {
        return null;
      }

      return {
        metricCode,
        value: Number(row.agg_value),
        unit: row.unit,
        sampleCount: Number(row.sample_count),
        startAt: startTime,
        endAt: endTime,
      };
    } catch (error) {
      throw this.handleError(error, 'aggregateSamples');
    }
  }

  // Soft Delete Operations

  /**
   * Details of a deleted sample for precise cache invalidation.
   *
   * P0-G FIX: This structure provides the metadata needed for downstream
   * projections to accurately invalidate caches (telemetry-cache, rollups).
   * Without endAt and metricCode, projections must use imprecise time buffers.
   */
  static DeletedSampleDetails = class {
    constructor(
      /** Composite ID for logging/debugging: sourceId:sourceRecordId:startAt */
      public readonly compositeId: string,
      /** Source identifier (device UUID, app bundle ID) */
      public readonly sourceId: string,
      /** Source-provided record identifier */
      public readonly sourceRecordId: string,
      /** Sample start timestamp - used for time range calculation */
      public readonly startAt: Date,
      /** Sample end timestamp — for interval samples spanning midnight */
      public readonly endAt: Date,
      /** Metric code — for metric-specific projection targeting */
      public readonly metricCode: string,
      /**
       * EDGE CASE 2 FIX: Per-sample timezone offset at recording time (minutes from UTC).
       * Read from DB column timezone_offset_min. Used by computeAffectedLocalDates for
       * correct date bucketing of deleted interval samples, avoiding the silent UTC fallback.
       * null = not recorded (legacy sample ingested before P0-E).
       */
      public readonly timezoneOffsetMin: number | null = null,
    ) {}
  };

  /**
   * Result of a soft delete operation.
   */
  static SoftDeleteResult = class {
    constructor(
      /** Number of samples marked as deleted */
      public readonly deletedCount: number,
      /** Number of samples skipped (already deleted) */
      public readonly alreadyDeletedCount: number,
      /** sourceRecordIds that were not found in the database */
      public readonly notFoundRecordIds: string[],
      /**
       * sourceRecordIds that were already deleted (idempotent).
       * Used for per-record alreadyDeleted tracking in response.
       */
      public readonly alreadyDeletedRecordIds: string[] = [],
      /**
       * P0-G FIX: Full metadata for each deleted sample.
       * Used by TelemetryCacheProjectionHandler for precise cache invalidation.
       * Includes startAt, endAt, and metricCode for each successfully deleted sample.
       */
      public readonly deletedSampleDetails: Array<
        InstanceType<typeof HealthSampleRepository.DeletedSampleDetails>
      > = []
    ) {}
  };

  /**
   * Mark health samples as soft-deleted by their (sourceId, sourceRecordId) pairs.
   *
   * samples were deleted from HealthKit/Health Connect, mark them here
   * instead of hard-deleting. This preserves:
   * - Audit trail for compliance
   * - Analytics consistency (can filter out deleted samples)
   * - Debugging capability for data issues
   *
   * Different sources may (theoretically) have the same sourceRecordId. By scoping
   * deletions to (sourceId, sourceRecordId), we ensure only the exact sample from
   * the specified source is deleted.
   *
   * INVARIANT: Once isDeleted = true, it should NEVER be set back to false (monotonic).
   * This method enforces this by only updating samples where isDeleted = false.
   *
   * IDEMPOTENCY: Safe to call multiple times with the same (sourceId, sourceRecordId) pairs.
   * Already-deleted samples are counted but not modified.
   *
   * @param userId - User ID to scope the deletion
   * @param sourceId - Source identifier (device UUID, app bundle ID)
   * @param sourceRecordIds - Array of sourceRecordIds to mark as deleted
   * @returns Result with counts of deleted, already deleted, and not found samples
   *
   * @example
   * ```typescript
   * // When client reports deletions
   * const result = await repo.markSamplesDeleted(userId, sourceId, deletedRecordIds);
   * logger.info('Soft delete completed', {
   *   deleted: result.deletedCount,
   *   alreadyDeleted: result.alreadyDeletedCount,
   *   notFound: result.notFoundRecordIds.length,
   * });
   * ```
   */
  async markSamplesDeleted(
    userId: string,
    sourceId: string,
    sourceRecordIds: string[]
  ): Promise<InstanceType<typeof HealthSampleRepository.SoftDeleteResult>> {
    if (sourceRecordIds.length === 0) {
      return new HealthSampleRepository.SoftDeleteResult(0, 0, []);
    }

    // LAST LINE OF DEFENSE: Normalize sourceRecordIds to lowercase before DB query.
    // Upstream Zod schema and service layer should already normalize, but this
    // ensures consistent lookups regardless of call path.
    const normalizedRecordIds = sourceRecordIds.map(id => id.toLowerCase());

    try {
      const now = new Date();

      // PHASE 1: Find existing samples to distinguish "not found" from "already deleted"
      const existingSamples = await this.prisma.healthSample.findMany({
        where: {
          userId,
          sourceId,
          sourceRecordId: { in: normalizedRecordIds },
        },
        select: {
          sourceRecordId: true,
          isDeleted: true,
        },
      });

      // Build lookup map
      const existingMap = new Map<string, boolean>();
      for (const sample of existingSamples) {
        existingMap.set(sample.sourceRecordId, sample.isDeleted);
      }

      // Categorize sourceRecordIds
      const notFoundRecordIds: string[] = [];
      const alreadyDeletedRecordIds: string[] = [];
      const recordIdsToDelete: string[] = [];

      for (const recordId of normalizedRecordIds) {
        if (!existingMap.has(recordId)) {
          notFoundRecordIds.push(recordId);
        } else if (existingMap.get(recordId) === true) {
          alreadyDeletedRecordIds.push(recordId);
        } else {
          recordIdsToDelete.push(recordId);
        }
      }

      // PHASE 2: Update samples that need to be deleted
      let deletedCount = 0;
      if (recordIdsToDelete.length > 0) {
        // Process in chunks to avoid query size limits
        const chunkSize = 500;
        for (let i = 0; i < recordIdsToDelete.length; i += chunkSize) {
          const chunk = recordIdsToDelete.slice(i, i + chunkSize);

          // MONOTONIC INVARIANT: Only update where isDeleted = false
          const result = await this.prisma.healthSample.updateMany({
            where: {
              userId,
              sourceId,
              sourceRecordId: { in: chunk },
              isDeleted: false,
            },
            data: {
              isDeleted: true,
              deletedAt: now,
            },
          });

          deletedCount += result.count;
        }
      }

      this.logger.info('Samples soft-deleted', {
        context: 'HealthSampleRepository.markSamplesDeleted',
        userId,
        sourceId,
        requestedCount: sourceRecordIds.length,
        deletedCount,
        alreadyDeletedCount: alreadyDeletedRecordIds.length,
        notFoundCount: notFoundRecordIds.length,
      });

      return new HealthSampleRepository.SoftDeleteResult(
        deletedCount,
        alreadyDeletedRecordIds.length,
        notFoundRecordIds,
        alreadyDeletedRecordIds // Include per-record tracking
      );
    } catch (error) {
      this.logger.error('Error soft-deleting samples', {
        context: 'HealthSampleRepository.markSamplesDeleted',
        userId,
        sourceId,
        count: sourceRecordIds.length,
        error: error instanceof Error ? error.message : String(error),
      });
      throw this.handleError(error, 'markSamplesDeleted');
    }
  }

  /**
   * Input for precise sample deletion with startAt and deletedAt.
   *
   *   (user_id, source_id, source_record_id, start_at)
   *
   * Without startAt, deletions may be ambiguous if multiple samples share
   * (sourceId, sourceRecordId) with different start times.
   *
   * PHASE 5 CHANGE: Added optional deletedAt parameter.
   * When provided, the client-supplied deletion timestamp is preserved for audit accuracy.
   * When not provided, the server uses the current time.
   */
  static readonly PreciseDeletionInput = class {
    constructor(
      public readonly sourceId: string,
      public readonly sourceRecordId: string,
      /** Optional: When provided, enables precise deletion matching DB unique key */
      public readonly startAt?: Date | null,
      /** Optional: Client-supplied deletion timestamp for audit accuracy */
      public readonly deletedAt?: Date | null
    ) {}
  };

  /**
   * Mark health samples as soft-deleted with PRECISE identity.
   *
   *   (user_id, source_id, source_record_id, start_at)
   *
   * When startAt is provided for a deletion item:
   * - DELETE targets exactly that sample (using DB unique constraint)
   * - No ambiguity if multiple samples share (sourceId, sourceRecordId)
   *
   * When startAt is NOT provided (legacy behavior):
   * - DELETE targets ALL samples matching (sourceId, sourceRecordId)
   * - Logs warning about potential over-deletion
   *
   * BACKWARD COMPATIBILITY: Legacy clients can still send deletions without startAt.
   * The server handles both cases gracefully.
   *
   * @param userId - User ID to scope the deletion
   * @param deletions - Array of deletion items with optional startAt
   * @returns Result with per-item status
   */
  async markSamplesDeletedPrecise(
    userId: string,
    deletions: Array<InstanceType<typeof HealthSampleRepository.PreciseDeletionInput>>,
    tx?: Prisma.TransactionClient
  ): Promise<InstanceType<typeof HealthSampleRepository.SoftDeleteResult>> {
    if (deletions.length === 0) {
      return new HealthSampleRepository.SoftDeleteResult(0, 0, [], []);
    }

    try {
      const client = tx ?? this.prisma;
      const now = new Date();
      let totalDeletedCount = 0;
      const notFoundRecordIds: string[] = [];
      const alreadyDeletedRecordIds: string[] = [];
      // P0-G FIX: Collect deleted sample details for precise cache invalidation
      const deletedSampleDetails: Array<
        InstanceType<typeof HealthSampleRepository.DeletedSampleDetails>
      > = [];

      // Process deletions one by one to support precise vs legacy modes
      for (const deletion of deletions) {
        // LAST LINE OF DEFENSE: Normalize sourceRecordId before DB lookups.
        const normalizedRecordId = deletion.sourceRecordId.toLowerCase();
        const compositeId = `${deletion.sourceId}:${normalizedRecordId}` +
          (deletion.startAt ? `:${deletion.startAt.toISOString()}` : '');

        if (deletion.startAt) {
          // PRECISE MODE: Use full 4-column key for exact match
          // P0-G FIX: Select metricCode and endAt for precise cache invalidation
          const existingSample = await client.healthSample.findUnique({
            where: {
              // Use the DB unique constraint for precise lookup
              health_sample_source_unique: {
                userId,
                sourceId: deletion.sourceId,
                sourceRecordId: normalizedRecordId,
                startAt: deletion.startAt,
              },
            },
            // EDGE CASE 2 FIX: Include timezoneOffsetMin for correct date bucketing
            select: { id: true, isDeleted: true, metricCode: true, startAt: true, endAt: true, timezoneOffsetMin: true },
          });

          if (!existingSample) {
            notFoundRecordIds.push(compositeId);
            continue;
          }

          if (existingSample.isDeleted) {
            alreadyDeletedRecordIds.push(compositeId);
            continue;
          }

          // Delete the specific sample
          // PHASE 5 FIX: Use client-supplied deletedAt when available for audit accuracy
          await client.healthSample.update({
            where: { id: existingSample.id },
            data: { isDeleted: true, deletedAt: deletion.deletedAt ?? now },
          });
          totalDeletedCount++;

          // P0-G FIX: Capture metadata for precise cache invalidation
          // EDGE CASE 2 FIX: Include per-sample TZ for correct date bucketing
          deletedSampleDetails.push(
            new HealthSampleRepository.DeletedSampleDetails(
              compositeId,
              deletion.sourceId,
              deletion.sourceRecordId,
              existingSample.startAt,
              existingSample.endAt,
              existingSample.metricCode,
              existingSample.timezoneOffsetMin,
            )
          );

        } else {
          // LEGACY MODE: Delete all samples matching (sourceId, sourceRecordId)
          // Log warning about potential over-deletion
          this.logger.warn('Legacy deletion without startAt - may delete multiple samples', {
            context: 'HealthSampleRepository.markSamplesDeletedPrecise',
            userId,
            sourceId: deletion.sourceId,
            sourceRecordId: normalizedRecordId,
          });

          // Find all matching samples
          // P0-G FIX: Select metricCode, startAt, endAt for precise cache invalidation
          // EDGE CASE 2 FIX: Include timezoneOffsetMin for correct date bucketing
          const existingSamples = await client.healthSample.findMany({
            where: {
              userId,
              sourceId: deletion.sourceId,
              sourceRecordId: normalizedRecordId,
            },
            select: { id: true, isDeleted: true, metricCode: true, startAt: true, endAt: true, timezoneOffsetMin: true },
          });

          if (existingSamples.length === 0) {
            notFoundRecordIds.push(compositeId);
            continue;
          }

          const toDelete = existingSamples.filter(s => !s.isDeleted);
          const alreadyDeleted = existingSamples.filter(s => s.isDeleted);

          if (alreadyDeleted.length > 0 && toDelete.length === 0) {
            alreadyDeletedRecordIds.push(compositeId);
            continue;
          }

          if (toDelete.length > 0) {
            // PHASE 5 FIX: Use client-supplied deletedAt when available for audit accuracy
            const result = await client.healthSample.updateMany({
              where: {
                id: { in: toDelete.map(s => s.id) },
                isDeleted: false,
              },
              data: { isDeleted: true, deletedAt: deletion.deletedAt ?? now },
            });
            totalDeletedCount += result.count;

            // P0-G FIX: Capture metadata for precise cache invalidation
            // EDGE CASE 2 FIX: Include per-sample TZ for correct date bucketing
            for (const sample of toDelete) {
              const legacyCompositeId = `${deletion.sourceId}:${normalizedRecordId}:${sample.startAt.toISOString()}`;
              deletedSampleDetails.push(
                new HealthSampleRepository.DeletedSampleDetails(
                  legacyCompositeId,
                  deletion.sourceId,
                  normalizedRecordId,
                  sample.startAt,
                  sample.endAt,
                  sample.metricCode,
                  sample.timezoneOffsetMin,
                )
              );
            }
          }

          if (alreadyDeleted.length > 0) {
            alreadyDeletedRecordIds.push(compositeId);
          }
        }
      }

      this.logger.info('Samples soft-deleted (precise mode)', {
        context: 'HealthSampleRepository.markSamplesDeletedPrecise',
        userId,
        requestedCount: deletions.length,
        deletedCount: totalDeletedCount,
        alreadyDeletedCount: alreadyDeletedRecordIds.length,
        notFoundCount: notFoundRecordIds.length,
        preciseCount: deletions.filter(d => d.startAt).length,
        legacyCount: deletions.filter(d => !d.startAt).length,
      });

      // P0-G FIX: Include deleted sample details for downstream cache invalidation
      return new HealthSampleRepository.SoftDeleteResult(
        totalDeletedCount,
        alreadyDeletedRecordIds.length,
        notFoundRecordIds,
        alreadyDeletedRecordIds,
        deletedSampleDetails
      );
    } catch (error) {
      this.logger.error('Error soft-deleting samples (precise mode)', {
        context: 'HealthSampleRepository.markSamplesDeletedPrecise',
        userId,
        count: deletions.length,
        error: error instanceof Error ? error.message : String(error),
      });
      throw this.handleError(error, 'markSamplesDeletedPrecise');
    }
  }

  /**
   * Get count of soft-deleted samples for a user.
   *
   * Useful for monitoring and analytics.
   *
   * @param userId - User ID to count deleted samples for
   * @returns Count of soft-deleted samples
   */
  async getDeletedSampleCount(userId: string): Promise<number> {
    try {
      return await this.prisma.healthSample.count({
        where: {
          userId,
          isDeleted: true,
        },
      });
    } catch (error) {
      throw this.handleError(error, 'getDeletedSampleCount');
    }
  }

  /**
   * Purge old soft-deleted samples (cleanup operation).
   *
   * This hard-deletes samples that have been soft-deleted for longer than the threshold.
   *
   * ⚠️  WARNING: This is a DESTRUCTIVE operation that permanently removes data.
   * Call only with explicit retention policy configuration.
   *
   * POLICY CONSIDERATIONS:
   * - Server purge: Only if you accept losing long-range auditability
   * - If you need indefinite audit trail, consider archiving instead of purging
   * - Typical production values: 30-90 days for audit, 365+ days for compliance
   *
   * SECURITY: userId is REQUIRED to prevent accidental cross-user data deletion.
   * If system-wide purge is ever needed, use purgeAllOldDeletedSamples() which
   * requires explicit admin authorization.
   *
   * SAFETY: Only deletes samples where:
   * - userId matches the provided userId (REQUIRED for isolation)
   * - isDeleted = true
   * - deletedAt is older than (now - retentionDays)
   *
   * @param userId - REQUIRED: User ID to purge samples for. Must be a valid non-empty string.
   *                 This is a security requirement to prevent cross-user data deletion.
   * @param retentionDays - REQUIRED: Retention period in days. No default to force explicit policy decision.
   *                        Common values: 30 (audit), 90 (standard), 365 (compliance)
   * @returns Number of samples permanently deleted
   * @throws Error if userId is not a valid non-empty string
   * @throws Error if retentionDays is not specified
   */
  async purgeOldDeletedSamples(
    userId: string,
    retentionDays: number
  ): Promise<number> {
    // This prevents accidental cross-user data deletion. The userId parameter
    // is REQUIRED for multi-tenant isolation. If you need system-wide purge,
    // create a separate method with explicit admin authorization.
    if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
      throw new Error(
        '[HealthSampleRepository.purgeOldDeletedSamples] SECURITY: userId is REQUIRED. ' +
        'Cross-user purge is forbidden for data isolation. ' +
        'If system-wide purge is needed, use purgeAllOldDeletedSamples() with admin authorization.'
      );
    }

    // SAFETY: Require explicit retention policy
    if (retentionDays === undefined || retentionDays === null) {
      throw new Error(
        'purgeOldDeletedSamples requires explicit retentionDays parameter. ' +
        'This prevents accidental data loss from default values.'
      );
    }

    // SAFETY: Warn if very short retention (less than 7 days)
    if (retentionDays < 7 && retentionDays > 0) {
      this.logger.warn('Short purge retention period', {
        context: 'HealthSampleRepository.purgeOldDeletedSamples',
        userId,
        retentionDays,
        warning: 'Retention less than 7 days may lose audit data',
      });
    }

    try {
      const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

      // SECURITY: Always filter by userId for multi-tenant isolation
      const whereClause: Prisma.HealthSampleWhereInput = {
        userId, // REQUIRED - no conditional spread, always included
        isDeleted: true,
        deletedAt: { lt: cutoffDate },
      };

      const result = await this.prisma.healthSample.deleteMany({
        where: whereClause,
      });

      this.logger.info('Purged old deleted samples', {
        context: 'HealthSampleRepository.purgeOldDeletedSamples',
        userId,
        purgedCount: result.count,
        retentionDays,
        cutoffDate: cutoffDate.toISOString(),
      });

      return result.count;
    } catch (error) {
      this.logger.error('Error purging deleted samples', {
        context: 'HealthSampleRepository.purgeOldDeletedSamples',
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw this.handleError(error, 'purgeOldDeletedSamples');
    }
  }

  /**
   * System-wide purge of old soft-deleted samples (ADMIN ONLY).
   *
   * ⚠️  DANGER: This method purges deleted samples for ALL USERS.
   * Only call from internal admin/cron jobs with explicit authorization.
   *
   * SECURITY REQUIREMENTS:
   * - Must be called only from admin-authorized contexts (job scheduler, admin API)
   * - Must NOT be exposed to user-facing API endpoints
   * - Caller must pass explicit adminReason for audit trail
   *
   * SAFETY: Only deletes samples where:
   * - isDeleted = true
   * - deletedAt is older than (now - retentionDays)
   *
   * Now accepts maxRows parameter to bound deletion scope per run.
   * Uses CTE with LIMIT to prevent unbounded deletions that can cause:
   * - Extended table locks
   * - Massive WAL generation
   * - Connection timeouts
   * - Performance degradation
   *
   * @param retentionDays - REQUIRED: Retention period in days. No default to force explicit policy.
   * @param adminReason - REQUIRED: Audit reason for why system-wide purge is being performed
   * @param maxRows - REQUIRED: Maximum rows to delete per run (1-50000). For safety, no unbounded deletes.
   * @returns Number of samples permanently deleted (may be less than maxRows if fewer eligible)
   * @throws Error if retentionDays is not specified or invalid
   * @throws Error if adminReason is not specified
   * @throws Error if maxRows is not specified or invalid
   * @internal This method should only be called by admin services, not user-facing code
   */
  async purgeAllOldDeletedSamplesForAdmin(
    retentionDays: number,
    adminReason: string,
    maxRows: number
  ): Promise<number> {
    // SECURITY: FAIL-FAST validation for admin-only operation
    if (retentionDays === undefined || retentionDays === null) {
      throw new Error(
        '[HealthSampleRepository.purgeAllOldDeletedSamplesForAdmin] retentionDays is REQUIRED.'
      );
    }

    if (!adminReason || typeof adminReason !== 'string' || adminReason.trim().length === 0) {
      throw new Error(
        '[HealthSampleRepository.purgeAllOldDeletedSamplesForAdmin] adminReason is REQUIRED for audit trail.'
      );
    }

    if (maxRows === undefined || maxRows === null || !Number.isInteger(maxRows)) {
      throw new Error(
        '[HealthSampleRepository.purgeAllOldDeletedSamplesForAdmin] maxRows is REQUIRED and must be an integer.'
      );
    }
    if (maxRows < 1 || maxRows > 50000) {
      throw new Error(
        `[HealthSampleRepository.purgeAllOldDeletedSamplesForAdmin] maxRows (${maxRows}) ` +
        'must be between 1 and 50000 to prevent unbounded deletions.'
      );
    }

    // SAFETY: Minimum retention for system-wide purge (30 days)
    const MIN_SYSTEM_RETENTION_DAYS = 30;
    if (retentionDays < MIN_SYSTEM_RETENTION_DAYS) {
      throw new Error(
        `[HealthSampleRepository.purgeAllOldDeletedSamplesForAdmin] retentionDays (${retentionDays}) ` +
        `must be >= ${MIN_SYSTEM_RETENTION_DAYS} for system-wide purge. ` +
        'Use user-scoped purge for shorter retention periods.'
      );
    }

    try {
      const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

      // AUDIT: Log before destructive operation
      this.logger.warn('ADMIN: Starting system-wide purge of deleted samples', {
        context: 'HealthSampleRepository.purgeAllOldDeletedSamplesForAdmin',
        adminReason,
        retentionDays,
        maxRows,
        cutoffDate: cutoffDate.toISOString(),
        warning: 'This affects ALL users (bounded by maxRows)',
      });

      // This prevents unbounded deletions that can cause table locks and timeouts.
      //
      // Pattern matches reapStaleProcessingIngestRequests() which uses:
      // WITH to_update AS (SELECT id ... LIMIT $maxRows FOR UPDATE SKIP LOCKED)
      //
      // For DELETE, we use:
      // WITH to_delete AS (SELECT id ... ORDER BY deleted_at LIMIT $maxRows)
      // DELETE FROM ... WHERE id IN (SELECT id FROM to_delete)
      //
      // The ORDER BY deleted_at ensures oldest deleted samples are purged first,
      // which is the expected FIFO behavior for data retention.
      //
      // This uses the partial index: health_samples_purge_eligible_idx
      // ON health_samples(deleted_at) WHERE is_deleted = true
      const result = await this.prisma.$executeRaw`
        WITH to_delete AS (
          SELECT id
          FROM health_samples
          WHERE is_deleted = true
            AND deleted_at < ${cutoffDate}
          ORDER BY deleted_at ASC
          LIMIT ${maxRows}
        )
        DELETE FROM health_samples
        WHERE id IN (SELECT id FROM to_delete)
      `;

      this.logger.info('ADMIN: Completed system-wide purge', {
        context: 'HealthSampleRepository.purgeAllOldDeletedSamplesForAdmin',
        adminReason,
        purgedCount: result,
        maxRows,
        retentionDays,
        cutoffDate: cutoffDate.toISOString(),
        note: result < maxRows ? 'All eligible samples purged' : 'More samples may remain (run again)',
      });

      return result;
    } catch (error) {
      this.logger.error('ADMIN: Error in system-wide purge', {
        context: 'HealthSampleRepository.purgeAllOldDeletedSamplesForAdmin',
        adminReason,
        error: error instanceof Error ? error.message : String(error),
      });
      throw this.handleError(error, 'purgeAllOldDeletedSamplesForAdmin');
    }
  }

  /**
   * Query health samples excluding soft-deleted ones.
   *
   * This is the DEFAULT query behavior for most use cases.
   * Soft-deleted samples are hidden from normal queries.
   *
   * @param userId - User ID
   * @param startTime - Start of time range
   * @param endTime - End of time range
   * @param metricCode - Optional metric code filter (single string or array for IN clause)
   * @param params - Optional pagination params
   * @returns Paginated response excluding deleted samples
   */
  async queryActiveByUserAndTimeRange(
    userId: string,
    startTime: Date,
    endTime: Date,
    metricCode?: string | readonly string[],
    params?: PaginationParams
  ): Promise<PaginatedResponse<HealthSample>> {
    try {
      // Build metric filter: single string → exact match, array → IN clause, undefined → no filter.
      // Empty array intentionally matches nothing (Prisma { in: [] } returns 0 rows).
      const metricFilter: Prisma.HealthSampleWhereInput = metricCode
        ? Array.isArray(metricCode)
          ? { metricCode: { in: metricCode as string[] } }
          : { metricCode }
        : {};

      const where: Prisma.HealthSampleWhereInput = {
        userId,
        isDeleted: false,
        startAt: {
          gte: startTime,
          lt: endTime, // P0 FIX: Half-open interval [start, end) per internal design spec guardrails
        },
        ...metricFilter,
      };

      return this.findManyWithPagination<
        Prisma.HealthSampleFindManyArgs,
        Prisma.HealthSampleCountArgs
      >(
        (args) => this.prisma.healthSample.findMany(args),
        (args) => this.prisma.healthSample.count(args),
        {
          ...params,
          where,
          orderBy: params?.orderBy || { startAt: 'desc' },
        }
      );
    } catch (error) {
      throw this.handleError(error, 'queryActiveByUserAndTimeRange');
    }
  }

  // Cursor-Based Pagination

  /**
   * Query health samples using cursor-based (keyset) pagination.
   *
   * PERFORMANCE:
   * - O(log n) via B-tree index traversal regardless of page depth
   * - No COUNT(*) query (uses limit+1 technique for hasMore detection)
   * - Uses partial indexes with `WHERE is_deleted = false` for efficiency
   *
   * KEYSET PAGINATION:
   * - Cursor contains (startAt, id) for deterministic ordering
   * - `id` is the tie-breaker when multiple samples have identical timestamps
   * - Ordering is DESC (newest first) for natural time-series display
   *
   * INDEXES USED:
   * - health_samples_keyset_active_idx: (user_id, start_at DESC, id DESC) WHERE is_deleted = false
   * - health_samples_keyset_metric_active_idx: (user_id, metric_code, start_at DESC, id DESC) WHERE is_deleted = false
   *
   * @param userId - User ID (tenant isolation)
   * @param startTime - Range start (inclusive)
   * @param endTime - Range end (inclusive)
   * @param limit - Maximum items to return (1-500)
   * @param cursor - Optional cursor from previous page
   * @param metricCode - Optional metric code filter
   * @returns Cursor-paginated response with items and pagination metadata
   */
  async querySamplesCursor(
    userId: string,
    startTime: Date,
    endTime: Date,
    limit: number,
    cursor?: HealthSampleCursor,
    metricCode?: string
  ): Promise<CursorPaginatedResponse<HealthSample>> {
    try {
      // Validate limit (fail-fast on invalid input)
      const validLimit = Math.min(500, Math.max(1, limit));

      // Build base WHERE clause
      const baseWhere: Prisma.HealthSampleWhereInput = {
        userId,
        isDeleted: false,
        startAt: {
          gte: startTime,
          lt: endTime, // P0 FIX: Half-open interval [start, end) per internal design spec guardrails
        },
        ...(metricCode && { metricCode }),
      };

      // KEYSET PAGINATION WHERE CLAUSE
      // For DESC ordering (newest first), the cursor condition is:
      //   (start_at < cursor.startAt) OR (start_at = cursor.startAt AND id < cursor.id)
      //
      // This translates to "rows that come after the cursor in DESC order".
      //
      // WHY THIS WORKS:
      // - start_at < cursor.startAt: All samples older than cursor
      // - start_at = cursor.startAt AND id < cursor.id: Samples with same timestamp
      //   but smaller id (tie-breaker for deterministic ordering)
      //
      // PostgreSQL optimizes this into efficient index range scans.
      let where: Prisma.HealthSampleWhereInput = baseWhere;

      if (cursor) {
        const cursorDate = new Date(cursor.startAt);

        // Build keyset condition for DESC ordering
        where = {
          ...baseWhere,
          OR: [
            // Samples with startAt < cursor.startAt (strictly older)
            {
              startAt: { lt: cursorDate },
            },
            // Samples with same startAt but smaller id (tie-breaker)
            {
              startAt: cursorDate,
              id: { lt: cursor.id },
            },
          ],
        };
      }

      // Fetch limit + 1 to detect if there are more pages
      // This avoids expensive COUNT(*) query
      const rows = await this.prisma.healthSample.findMany({
        where,
        orderBy: [
          { startAt: 'desc' },
          { id: 'desc' },
        ],
        take: validLimit + 1,
      });

      // Determine if there are more pages
      const hasMore = rows.length > validLimit;

      // Return only the requested limit
      const items = hasMore ? rows.slice(0, validLimit) : rows;

      // Build next cursor from last item (if there are more pages)
      let nextCursor: string | null = null;
      if (hasMore && items.length > 0) {
        const lastItem = items[items.length - 1];
        if (lastItem) {
          nextCursor = encodeHealthSampleCursor(buildHealthSampleCursor(lastItem));
        }
      }

      this.logger.debug('Cursor pagination query completed', {
        context: 'HealthSampleRepository.querySamplesCursor',
        userId,
        metricCode,
        limit: validLimit,
        returnedCount: items.length,
        hasMore,
        hasCursor: !!cursor,
      });

      return {
        items,
        pagination: {
          limit: validLimit,
          hasMore,
          nextCursor,
        },
      };
    } catch (error) {
      this.logger.error('Cursor pagination query failed', {
        context: 'HealthSampleRepository.querySamplesCursor',
        userId,
        metricCode,
        limit,
        hasCursor: !!cursor,
        error: error instanceof Error ? error.message : String(error),
      });
      throw this.handleError(error, 'querySamplesCursor');
    }
  }

  // Request-Level Idempotency (HealthIngestRequest)

  /**
   * @deprecated DO NOT USE - This method has a DIFFERENT algorithm than the shared
   * `computeSamplesPayloadHash()` function used by the API middleware.
   *
   * BREAKING DIFFERENCES from shared function:
   * 1. This method EXCLUDES `metadata` from hash
   * 2. This method sorts by `sourceRecordId` only
   * 3. Shared function sorts by composite key: sourceId, sourceRecordId, metricCode, startAt, endAt, valueKind
   * 4. Shared function uses RFC 8785-inspired canonicalization
   *
   * IMPACT: Using this method causes hash mismatches between client and server,
   * breaking the idempotency contract's tamper detection.
   *
   * MIGRATION: The `batchUpsertWithIdempotency()` method now accepts a pre-validated
   * `payloadHash` parameter from the middleware. The hash is computed ONCE by the
   * middleware using `computeSamplesPayloadHash()` from `@shared/health-config/payload-hash.ts`,
   * and passed through the stack. Do NOT recompute here.
   *
   * This method is kept temporarily for backward compatibility during migration.
   * It will be removed in a future release.
   *
   * @param samples - Array of samples to hash
   * @returns SHA-256 hash of the samples (hex encoded) - WARNING: INCOMPATIBLE WITH SHARED FUNCTION
   */
  static computePayloadHash(samples: CreateHealthSampleInput[]): string {
    // DEPRECATED: This algorithm differs from shared computeSamplesPayloadHash()
    // See deprecation notice above for details.
    const canonicalSamples = samples.map((s) => ({
      sourceId: s.sourceId,
      sourceRecordId: s.sourceRecordId,
      metricCode: s.metricCode,
      valueKind: s.valueKind,
      value: s.value,
      unit: s.unit,
      categoryCode: s.categoryCode ?? null,
      startAt: s.startAt.toISOString(),
      endAt: s.endAt.toISOString(),
      durationSeconds: s.durationSeconds ?? null,
      deviceId: s.deviceId ?? null,
      externalUuid: s.externalUuid ?? null,
      // DEPRECATED: metadata excluded from hash (shared function includes it)
    }));

    // DEPRECATED: Sort by sourceRecordId only (shared function uses composite key)
    canonicalSamples.sort((a, b) => a.sourceRecordId.localeCompare(b.sourceRecordId));

    const payload = JSON.stringify(canonicalSamples);
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  /**
   * Check if a request has been processed before (request-level idempotency).
   *
   * IDEMPOTENCY FLOW:
   * 1. NEW_REQUEST: First time seeing this requestId - proceed with processing
   * 2. CACHED_RESPONSE: Same requestId + payloadHash - return cached response
   * 3. PAYLOAD_MISMATCH: Same requestId but different payloadHash - reject
   * 4. STILL_PROCESSING: Request exists but not completed - retry later
   *
   * @param userId - User ID
   * @param requestId - Client-generated idempotency key
   * @param payloadHash - SHA-256 hash of the payload for integrity
   * @returns Idempotency check result
   */
  async checkRequestIdempotency(
    userId: string,
    requestId: string,
    payloadHash: string
  ): Promise<IdempotencyCheckResult> {
    try {
      // Look up existing request by (userId, requestId) unique constraint
      const existingRequest = await this.prisma.healthIngestRequest.findUnique({
        where: {
          health_ingest_request_unique: {
            userId,
            requestId,
          },
        },
      });

      // CASE 1: No existing request - this is a new request
      if (!existingRequest) {
        return { status: 'NEW_REQUEST' };
      }

      // CASE 2: Request exists - check status and payload hash
      // SECURITY: Verify payload hash matches to detect tampering
      if (existingRequest.payloadHash !== payloadHash) {
        this.logger.warn('Payload hash mismatch detected', {
          context: 'HealthSampleRepository.checkRequestIdempotency',
          userId,
          requestId,
          expectedHash: existingRequest.payloadHash,
          receivedHash: payloadHash,
          warning: 'Possible tampering or client bug - requestId reused with different payload',
        });
        return {
          status: 'PAYLOAD_MISMATCH',
          originalHash: existingRequest.payloadHash,
        };
      }

      // CASE 3: Same requestId + same payloadHash - check processing status
      if (existingRequest.status === 'processing') {
        // STALE PROCESSING RECOVERY
        // If a process crashes mid-processing, the request can get stuck with
        // status='processing' indefinitely. This creates a deadlock where:
        // 1. Client retries with same requestId
        // 2. Server sees STILL_PROCESSING and rejects
        // 3. Request is permanently wedged
        //
        // SOLUTION: Check createdAt age. If older than STALE_PROCESSING_TIMEOUT_MS,
        // mark as failed and allow reprocessing.
        //
        // SAFETY: This is safe because:
        // - 5 minute timeout is generous (processing typically <30s)
        // - Payload hash is verified, so duplicate with same data is harmless
        // - Sample-level idempotency (sourceRecordId) prevents data duplication
        const ageMs = Date.now() - existingRequest.createdAt.getTime();

        if (ageMs > STALE_PROCESSING_TIMEOUT_MS) {
          // Request is stale - mark as failed and allow reprocessing
          this.logger.warn('Recovering stale processing request', {
            context: 'HealthSampleRepository.checkRequestIdempotency',
            userId,
            requestId,
            ageMs,
            staleTimeoutMs: STALE_PROCESSING_TIMEOUT_MS,
            action: 'Marking as failed and allowing reprocess',
          });

          // Mark the stale request as failed (best-effort)
          try {
            await this.prisma.healthIngestRequest.update({
              where: { id: existingRequest.id },
              data: {
                status: 'failed',
                responseJson: {
                  error: 'Request timed out in processing state (stale recovery)',
                  originalCreatedAt: existingRequest.createdAt.toISOString(),
                  recoveredAt: new Date().toISOString(),
                } as unknown as Prisma.InputJsonValue,
                completedAt: new Date(),
              },
            });
          } catch (updateError) {
            // Log but continue - stale recovery is best-effort
            this.logger.warn('Failed to mark stale request as failed (continuing with reprocess)', {
              context: 'HealthSampleRepository.checkRequestIdempotency',
              userId,
              requestId,
              error: updateError instanceof Error ? updateError.message : String(updateError),
            });
          }

          // Return NEW_REQUEST to allow reprocessing
          return { status: 'NEW_REQUEST' };
        }

        // Request is not stale - genuinely still processing
        return {
          status: 'STILL_PROCESSING',
          existingRequestId: existingRequest.id,
        };
      }

      // CASE 4: Request completed - handle based on status
      //
      // This is because:
      // 1. failIngestRequest() may have stored { error: string } which is NOT a valid
      //    BatchUpsertResult shape and would cause Zod parsing failures on clients
      // 2. Semantically, if a request failed, the client should be allowed to retry
      // 3. This is consistent with stale recovery behavior (also returns NEW_REQUEST)
      //
      // For completed/partial requests with valid responseJson, return CACHED_RESPONSE.

      // CASE 4a: Failed request - allow retry by returning NEW_REQUEST
      if (existingRequest.status === 'failed') {
        this.logger.info('Previous request failed, allowing retry as NEW_REQUEST', {
          context: 'HealthSampleRepository.checkRequestIdempotency',
          userId,
          requestId,
          originalStatus: existingRequest.status,
        });

        return { status: 'NEW_REQUEST' };
      }

      // CASE 4b: Completed or partial request with cached response - true idempotency
      if (existingRequest.responseJson &&
          (existingRequest.status === 'completed' || existingRequest.status === 'partial')) {
        this.logger.info('Returning cached response for idempotent request', {
          context: 'HealthSampleRepository.checkRequestIdempotency',
          userId,
          requestId,
          originalStatus: existingRequest.status,
        });

        return {
          status: 'CACHED_RESPONSE',
          cachedResult: existingRequest.responseJson as unknown as BatchUpsertResult,
        };
      }

      // INVARIANT VIOLATION RECOVERY
      // Edge case: Request is completed/partial but has no cached responseJson.
      // This indicates an invariant violation (bug) - completed requests MUST have
      // a cached response.
      //
      // That causes infinite retry loops because the request is NOT actually processing.
      //
      // SOLUTION:
      // 1. Log as ERROR (this is a bug, not a warning)
      // 2. Mark the broken request as 'failed' to clear the invariant violation
      // 3. Return NEW_REQUEST to allow the client to retry safely
      //
      // SAFETY: Sample-level idempotency (sourceRecordId) prevents data duplication.
      this.logger.error('INVARIANT VIOLATION: Completed request without cached response', {
        context: 'HealthSampleRepository.checkRequestIdempotency',
        userId,
        requestId,
        status: existingRequest.status,
        invariant: 'completed/partial status MUST have responseJson',
        action: 'Marking as failed and allowing retry',
        alert: 'HEALTH_INGEST_INVARIANT_VIOLATION',
      });

      // Mark the broken request as failed (best-effort)
      try {
        await this.prisma.healthIngestRequest.update({
          where: { id: existingRequest.id },
          data: {
            status: 'failed',
            responseJson: {
              error: 'Invariant violation: completed without responseJson',
              originalStatus: existingRequest.status,
              recoveredAt: new Date().toISOString(),
            } as unknown as Prisma.InputJsonValue,
            completedAt: new Date(),
          },
        });
      } catch (updateError) {
        // Log but continue - recovery is best-effort
        this.logger.warn('Failed to mark invariant-violated request as failed (continuing with retry)', {
          context: 'HealthSampleRepository.checkRequestIdempotency',
          userId,
          requestId,
          error: updateError instanceof Error ? updateError.message : String(updateError),
        });
      }

      // Return NEW_REQUEST to allow safe retry
      // Sample-level idempotency protects against data duplication
      return { status: 'NEW_REQUEST' };
    } catch (error) {
      this.logger.error('Error checking request idempotency', {
        context: 'HealthSampleRepository.checkRequestIdempotency',
        userId,
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw this.handleError(error, 'checkRequestIdempotency');
    }
  }

  /**
   * Create a new ingest request record (marks request as 'processing').
   *
   * CONCURRENCY: Uses database-level unique constraint on (userId, requestId)
   * to prevent race conditions. If two requests arrive simultaneously with
   * the same requestId, one will succeed and one will get a unique constraint
   * violation (P2002 in Prisma).
   *
   * @param input - Request creation input
   * @returns Created HealthIngestRequest record
   * @throws Prisma.PrismaClientKnownRequestError if duplicate (P2002)
   */
  async createIngestRequest(
    input: CreateIngestRequestInput
  ): Promise<HealthIngestRequest> {
    try {
      const request = await this.prisma.healthIngestRequest.create({
        data: {
          userId: input.userId,
          requestId: input.requestId,
          payloadHash: input.payloadHash,
          sampleCount: input.sampleCount,
          status: 'processing',
        },
      });

      this.logger.debug('Created ingest request', {
        context: 'HealthSampleRepository.createIngestRequest',
        requestId: input.requestId,
        userId: input.userId,
        sampleCount: input.sampleCount,
      });

      return request;
    } catch (error) {
      // Handle unique constraint violation (race condition)
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') {
          this.logger.warn('Duplicate ingest request (race condition)', {
            context: 'HealthSampleRepository.createIngestRequest',
            requestId: input.requestId,
            userId: input.userId,
            errorCode: 'P2002',
          });
          // Re-throw with specific message for caller to handle
          throw new AppError(
            409, // HTTP Conflict
            ErrorCodes.DUPLICATE_REQUEST,
            'Request already being processed (race condition)',
            true,
            { requestId: input.requestId, userId: input.userId }
          );
        }
      }
      throw this.handleError(error, 'createIngestRequest');
    }
  }

  /**
   * Reactivate a FAILED ingest request for retry processing.
   *
   * When checkRequestIdempotency returns NEW_REQUEST for a failed request,
   * we cannot simply call createIngestRequest because the row already exists.
   * This method atomically UPDATES the existing failed record back to 'processing'
   * status, allowing the retry to proceed.
   *
   * ATOMIC UPDATE PATTERN:
   * Uses UPDATE...WHERE status='failed' AND payloadHash=$payloadHash
   * - If row matches, it's updated and returned
   * - If no match (race condition or status changed), returns null
   * - The payloadHash check is a security measure to prevent reactivation with different payload
   *
   * STATE MACHINE TRANSITION:
   * failed → processing (only valid transition here)
   *
   * @param userId - User ID
   * @param requestId - Client-generated idempotency key
   * @param payloadHash - SHA-256 hash (MUST match existing record for security)
   * @param sampleCount - Number of samples in the retry request
   * @returns The reactivated HealthIngestRequest record, or null if no eligible record found
   */
  async reactivateFailedIngestRequest(
    userId: string,
    requestId: string,
    payloadHash: string,
    sampleCount: number
  ): Promise<HealthIngestRequest | null> {
    try {
      // Atomic UPDATE with WHERE clause ensures only one thread wins
      // The payloadHash check prevents security issues where attacker
      // could reactivate with different payload
      const result = await this.prisma.healthIngestRequest.updateMany({
        where: {
          userId,
          requestId,
          status: 'failed',
          payloadHash, // Security: must match
        },
        data: {
          status: 'processing',
          sampleCount,
          // Clear previous failure state
          responseJson: Prisma.JsonNull,
          completedAt: null,
          // Reset counts to 0 (schema has @default(0), not nullable)
          successCount: 0,
          failedCount: 0,
          // Note: createdAt is intentionally NOT reset - preserves original request timing
          // for audit trail and stale detection should use updatedAt pattern in future
        },
      });

      // If no rows updated, either:
      // 1. Record doesn't exist (shouldn't happen - checkRequestIdempotency found it)
      // 2. Status is no longer 'failed' (race - another thread won)
      // 3. payloadHash doesn't match (security: different payload)
      if (result.count === 0) {
        this.logger.debug('No failed ingest request found to reactivate', {
          context: 'HealthSampleRepository.reactivateFailedIngestRequest',
          userId,
          requestId,
          note: 'Either not found, not failed, or payloadHash mismatch',
        });
        return null;
      }

      // Fetch the updated record to return
      const reactivatedRequest = await this.prisma.healthIngestRequest.findUnique({
        where: {
          health_ingest_request_unique: { userId, requestId },
        },
      });

      if (!reactivatedRequest) {
        // Should not happen after successful updateMany, but handle gracefully
        this.logger.error('Failed to fetch reactivated ingest request after successful update', {
          context: 'HealthSampleRepository.reactivateFailedIngestRequest',
          userId,
          requestId,
        });
        return null;
      }

      this.logger.info('Reactivated failed ingest request for retry', {
        context: 'HealthSampleRepository.reactivateFailedIngestRequest',
        requestId,
        userId,
        sampleCount,
        ingestRequestId: reactivatedRequest.id,
      });

      return reactivatedRequest;
    } catch (error) {
      this.logger.error('Error reactivating failed ingest request', {
        context: 'HealthSampleRepository.reactivateFailedIngestRequest',
        userId,
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw this.handleError(error, 'reactivateFailedIngestRequest');
    }
  }

  /**
   * Complete an ingest request by updating status and caching response.
   *
   * @deprecated Since GAP A fix — processIngestRequest() now handles status
   * updates, watermark bumps, and outbox events atomically within its own
   * $transaction. This method is retained only as a simple status-update
   * utility for edge cases (e.g., manual recovery scripts).
   *
   * For the atomic path, see processIngestRequest() which wraps ALL mutations
   * + status + watermark + outbox in a single transaction.
   *
   * @param ingestRequestId - ID of the HealthIngestRequest record
   * @param result - The BatchUpsertResult to cache
   */
  async completeIngestRequest(
    ingestRequestId: string,
    result: BatchUpsertResult,
  ): Promise<void> {
    try {
      // Determine final status based on result
      let status: HealthIngestRequestStatus;
      if (result.failed.length === 0) {
        status = 'completed';
      } else if (result.successful.length === 0) {
        status = 'failed';
      } else {
        status = 'partial';
      }

      await this.prisma.healthIngestRequest.update({
        where: { id: ingestRequestId },
        data: {
          status,
          successCount: result.successful.length,
          failedCount: result.failed.length,
          responseJson: result as unknown as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });

      this.logger.info('Completed ingest request (status-only)', {
        context: 'HealthSampleRepository.completeIngestRequest',
        ingestRequestId,
        status,
        successCount: result.successful.length,
        failedCount: result.failed.length,
      });
    } catch (error) {
      this.logger.error('Error completing ingest request', {
        context: 'HealthSampleRepository.completeIngestRequest',
        ingestRequestId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw this.handleError(error, 'completeIngestRequest');
    }
  }

  /**
   * Mark an ingest request as failed.
   *
   * Called when sample processing fails unexpectedly. This allows
   * clients to retry the request.
   *
   * @param ingestRequestId - ID of the HealthIngestRequest record
   * @param errorMessage - Error message to log
   */
  async failIngestRequest(
    ingestRequestId: string,
    errorMessage: string
  ): Promise<void> {
    try {
      await this.prisma.healthIngestRequest.update({
        where: { id: ingestRequestId },
        data: {
          status: 'failed',
          responseJson: { error: errorMessage } as unknown as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });

      this.logger.warn('Marked ingest request as failed', {
        context: 'HealthSampleRepository.failIngestRequest',
        ingestRequestId,
        errorMessage,
      });
    } catch (error) {
      // Log but don't throw - this is a best-effort update
      this.logger.error('Error marking ingest request as failed', {
        context: 'HealthSampleRepository.failIngestRequest',
        ingestRequestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async processIngestRequest(
    userId: string,
    requestId: string,
    ingestRequest: HealthIngestRequest,
    samples: CreateHealthSampleInput[],
    deletions: Array<InstanceType<typeof HealthSampleRepository.PreciseDeletionInput>> | undefined,
    timings: {
      batchUpsertMs: number;
      dbUpsertMs: number;
      deletionMs: number;
      completeRequestMs: number;
    },
    onDbMetrics: (metrics: BatchUpsertDbMetrics) => void,
    outboxCallback?: HealthIngestOutboxCallback,
  ): Promise<BatchUpsertResult> {
    // ATOMIC TRANSACTION: mutations + status + watermark + outbox
    //
    // GAP A FIX: All operations are wrapped in a single Prisma $transaction to
    // guarantee:
    //   1. No lost signals: if mutations commit, outbox event + watermark MUST too
    //   2. No phantom events: if transaction rolls back, NO outbox event exists
    //   3. Idempotent replay: on crash-before-commit, nothing persists
    //
    // Previously, mutations auto-committed independently and the outbox event +
    // watermark were in a SEPARATE completeIngestRequest() transaction. A crash
    // between the two permanently lost the change signal — projections never
    // advanced, UI served stale data indefinitely.
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // Step 1: Batch upsert samples (within transaction)
        const sampleResult = await this.batchUpsert(samples, requestId, {
          tx,
          onDbMetrics: (metrics) => {
            onDbMetrics(metrics);
            timings.dbUpsertMs = metrics.upsertDurationMs;
          },
        });
        timings.batchUpsertMs = sampleResult.metrics.durationMs;

        // Step 2: Process deletions (within transaction)
        // NOTE: markSamplesDeletedPrecise handles logical "not found" / "already
        // deleted" cases internally (returns them in result, does NOT throw).
        // It only throws on unexpected DB errors, which correctly abort the
        // transaction — we want all-or-nothing atomicity.
        let deletionResults: BatchUpsertResult['deletions'] | undefined;

        if (deletions && deletions.length > 0) {
          const deletionStart = Date.now();
          const deleteResult = await this.markSamplesDeletedPrecise(userId, deletions, tx);

          const successful: NonNullable<BatchUpsertResult['deletions']>['successful'] = [];
          const failed: NonNullable<BatchUpsertResult['deletions']>['failed'] = [];

          const notFoundSet = new Set(deleteResult.notFoundRecordIds);
          const alreadyDeletedSet = new Set(deleteResult.alreadyDeletedRecordIds);

          // GAP C FIX: Build lookup map from deletedSampleDetails for enriching
          // the successful array with startAt (from DB), endAt, and metricCode.
          // Without this enrichment, the outbox callback cannot compute time ranges
          // from deletions, causing rangeStartMs/rangeEndMs to collapse to 0..0.
          // EDGE CASE 2 FIX: Also carry timezoneOffsetMin for correct date bucketing.
          const deletedDetailsMap = new Map<string, {
            startAt: Date;
            endAt: Date;
            metricCode: string;
            timezoneOffsetMin: number | null;
          }>();
          for (const detail of deleteResult.deletedSampleDetails) {
            // Primary key: exact compositeId with startAt (for precise deletion lookup)
            deletedDetailsMap.set(detail.compositeId, {
              startAt: detail.startAt,
              endAt: detail.endAt,
              metricCode: detail.metricCode,
              timezoneOffsetMin: detail.timezoneOffsetMin,
            });

            // GAP C FIX: Secondary key — legacy compositeId without startAt suffix.
            // When client sends delete-by-recordId (no startAt), the lookup key at
            // line ~2473 is "sourceId:sourceRecordId" which won't match the primary
            // key "sourceId:sourceRecordId:startAt". Without this secondary key,
            // deletedDetailsMap.get() returns undefined for legacy deletions, causing
            // the outbox time range to collapse to [0,0] and the invariant to throw.
            // For multi-sample legacy deletions (same sourceId:sourceRecordId but
            // different startAt), merge to the widest encompassing time range.
            const legacyKey = `${detail.sourceId}:${detail.sourceRecordId}`;
            const existing = deletedDetailsMap.get(legacyKey);
            if (!existing) {
              deletedDetailsMap.set(legacyKey, {
                startAt: detail.startAt,
                endAt: detail.endAt,
                metricCode: detail.metricCode,
                timezoneOffsetMin: detail.timezoneOffsetMin,
              });
            } else {
              // Merge: widen time range to cover all DB rows for this legacy key.
              // Ensures the outbox event covers the full affected time window when
              // a single sourceRecordId maps to multiple samples with different startAt.
              deletedDetailsMap.set(legacyKey, {
                startAt: detail.startAt < existing.startAt ? detail.startAt : existing.startAt,
                endAt: detail.endAt > existing.endAt ? detail.endAt : existing.endAt,
                metricCode: existing.metricCode, // Stable per sourceRecordId
                timezoneOffsetMin: existing.timezoneOffsetMin, // Stable per sourceRecordId
              });
            }
          }

          for (const deletion of deletions) {
            // Normalize for consistent composite key matching
            const normalizedRecId = deletion.sourceRecordId.toLowerCase();
            const compositeId = `${deletion.sourceId}:${normalizedRecId}` +
              (deletion.startAt ? `:${deletion.startAt.toISOString()}` : '');

            if (notFoundSet.has(compositeId)) {
              failed.push({
                sourceId: deletion.sourceId,
                sourceRecordId: normalizedRecId,
                ...(deletion.startAt ? { startAt: deletion.startAt.toISOString() } : {}),
                error: 'Sample not found (may have been purged)',
                errorCode: 'DELETE_NOT_FOUND',
                retryable: false,
              });
            } else {
              // GAP C FIX: Enrich with endAt and metricCode from DB-looked-up details.
              // For legacy deletions (no startAt input), also use startAt from DB lookup.
              // rangeStartMs/rangeEndMs and metricCodes for downstream projections.
              const details = deletedDetailsMap.get(compositeId);

              successful.push({
                sourceId: deletion.sourceId,
                sourceRecordId: normalizedRecId,
                // Use startAt from DB lookup (details) when input doesn't have it (legacy mode),
                // otherwise use the input startAt for consistency with the compositeId key
                startAt: deletion.startAt
                  ? deletion.startAt.toISOString()
                  : details?.startAt.toISOString(),
                // GAP C FIX: Include endAt and metricCode from DB lookup
                // EDGE CASE 2 FIX: Include per-sample TZ for correct date bucketing
                ...(details ? {
                  endAt: details.endAt.toISOString(),
                  metricCode: details.metricCode,
                  timezoneOffsetMin: details.timezoneOffsetMin,
                } : {}),
                alreadyDeleted: alreadyDeletedSet.has(compositeId),
              });
            }
          }

          deletionResults = { successful, failed };
          timings.deletionMs = Date.now() - deletionStart;

          this.logger.info('Deletions processed within atomic transaction', {
            context: 'HealthSampleRepository.processIngestRequest',
            userId,
            requestId,
            deletionCount: deletions.length,
            deletedCount: deleteResult.deletedCount,
            alreadyDeletedCount: deleteResult.alreadyDeletedCount,
            notFoundCount: deleteResult.notFoundRecordIds.length,
          });
        }

        // Step 3: Assemble batch result
        const batchResult: BatchUpsertResult = {
          ...sampleResult,
          ...(deletionResults && { deletions: deletionResults }),
          metrics: {
            ...sampleResult.metrics,
            ...(deletionResults && {
              deletedCount: deletionResults.successful.filter(d => !d.alreadyDeleted).length,
            }),
          },
        };

        // Step 4: Determine status and update ingest request (within transaction)
        const completeStart = Date.now();

        let status: HealthIngestRequestStatus;
        if (batchResult.failed.length === 0) {
          status = 'completed';
        } else if (batchResult.successful.length === 0) {
          status = 'failed';
        } else {
          status = 'partial';
        }

        await tx.healthIngestRequest.update({
          where: { id: ingestRequest.id },
          data: {
            status,
            successCount: batchResult.successful.length,
            failedCount: batchResult.failed.length,
            responseJson: batchResult as unknown as Prisma.InputJsonValue,
            completedAt: new Date(),
          },
        });

        // Step 5: Bump watermark if there are data changes (within transaction)
        // INVARIANT: watermark is bumped on EVERY successful mutation, regardless
        // of whether an outbox callback is provided. The watermark tracks data
        // freshness (a separate concern from event notification). No phantom
        // bumps for empty/all-failed batches.
        const hasDataChanges = batchResult.successful.length > 0 ||
          (batchResult.metrics.deletedCount ?? 0) > 0;

        let watermarkAfter = BigInt(0);

        if (hasDataChanges) {
          // Compute lastSampleAt from successful samples for audit trail
          const lastSampleAt = batchResult.successful.length > 0
            ? new Date(Math.max(...batchResult.successful.map(s => new Date(s.startAt).getTime())))
            : null;

          // Atomic upsert with RETURNING to capture the new sequence number.
          // This prevents race conditions under concurrent requests and provides
          // the exact watermark value for the outbox event payload.
          const watermarkRows = await tx.$queryRaw<Array<{ sequence_number: bigint }>>`
            INSERT INTO "user_health_watermarks" ("user_id", "sequence_number", "last_sample_at", "last_changed_at", "created_at", "updated_at")
            VALUES (${userId}, 1, ${lastSampleAt}, NOW(), NOW(), NOW())
            ON CONFLICT ("user_id")
            DO UPDATE SET
              "sequence_number" = "user_health_watermarks"."sequence_number" + 1,
              "last_sample_at" = COALESCE(${lastSampleAt}, "user_health_watermarks"."last_sample_at"),
              "last_changed_at" = NOW(),
              "updated_at" = NOW()
            RETURNING "sequence_number"
          `;

          if (!watermarkRows[0]) {
            throw new Error(
              `Watermark upsert RETURNING returned no rows for userId=${userId}. ` +
              `This should never happen — INSERT...ON CONFLICT...RETURNING always returns exactly one row.`,
            );
          }
          watermarkAfter = watermarkRows[0].sequence_number;

          this.logger.info('Incremented user health watermark (atomic)', {
            context: 'HealthSampleRepository.processIngestRequest',
            userId,
            requestId,
            watermarkAfter: Number(watermarkAfter),
            successCount: batchResult.successful.length,
            deletedCount: batchResult.metrics.deletedCount ?? 0,
          });
        }

        // Step 6: Write outbox event if callback provided (within transaction)
        if (outboxCallback) {
          await outboxCallback(tx, batchResult, watermarkAfter);
        }

        timings.completeRequestMs = Date.now() - completeStart;
        return batchResult;
      }, {
        timeout: 60_000,  // 60s — generous bound handles slow Neon cold starts
        maxWait: 10_000,  // 10s max wait to acquire connection from pool
      });

      this.logger.info('Processed ingest request atomically', {
        context: 'HealthSampleRepository.processIngestRequest',
        userId,
        requestId,
        successCount: result.successful.length,
        failedCount: result.failed.length,
        deletedCount: result.metrics.deletedCount ?? 0,
      });

      return result;
    } catch (error) {
      // Transaction rolled back — mark request as failed OUTSIDE the rolled-back
      // transaction for faster retry. Stale processing recovery remains as backup
      // safety net for any edge case where this best-effort update also fails.
      await this.failIngestRequest(
        ingestRequest.id,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  /**
   * Batch upsert with TRUE request-level idempotency.
   *
   * This is the RECOMMENDED entry point for health sample ingestion.
   * It wraps the sample upsert AND deletions with HealthIngestRequest tracking for
   * complete request-level idempotency.
   *
   * STOP-SHIP #1 FIX:
   * Deletions are now processed INSIDE the idempotency boundary. The cached responseJson
   * includes both sample results AND deletion results, ensuring retries with the same
   * requestId return byte-for-byte identical responses.
   *
   * IDEMPOTENCY GUARANTEE:
   * - First request: Processes samples AND deletions, caches full response
   * - Duplicate request (same payload): Returns cached response instantly (including deletions)
   * - Duplicate request (different payload): Rejects with PAYLOAD_MISMATCH
   * - Concurrent duplicate: Second request gets STILL_PROCESSING
   *
   * ATOMICITY NOTE:
   * The HealthIngestRequest creation and sample upserts are NOT in a single
   * transaction by design. This is intentional because:
   * 1. Long-running transactions with many samples can cause lock contention
   * 2. The idempotency key protects against duplicates even if partial failure
   * 3. Clients can retry failed requests safely
   *
   * TRUST BOUNDARY:
   * The payloadHash MUST be validated by middleware (validateBatchUpsertRequestWithHash)
   * BEFORE reaching this method. This repository TRUSTS the validated hash and does
   * NOT recompute it. This follows the "validate at boundaries, trust internally" pattern.
   *
   * @param userId - User ID
   * @param samples - Array of samples to upsert
   * @param requestId - Client-generated idempotency key (REQUIRED, UUID format)
   * @param payloadHash - Pre-validated SHA-256 hash of samples+deletions from middleware (REQUIRED)
   * @param deletions - Optional array of precise deletion inputs (STOP-SHIP #1 FIX)
   * @param outboxCallback - Optional callback to write outbox event atomically with completion (P0-A fix)
   * @returns BatchUpsertResult with idempotency status (includes deletion results if provided)
   */
  async batchUpsertWithIdempotency(
    userId: string,
    samples: CreateHealthSampleInput[],
    requestId: string,
    payloadHash: string,
    deletions?: Array<InstanceType<typeof HealthSampleRepository.PreciseDeletionInput>>,
    outboxCallback?: HealthIngestOutboxCallback
  ): Promise<BatchUpsertResult & { idempotencyStatus: 'NEW' | 'CACHED' }> {
    const metricsEnabled = shouldEmitHealthMetrics(userId);
    const metricsTags = getHealthMetricsTags(userId);
    const totalStartTime = Date.now();
    const timings: {
      idempotencyMs: number;
      createRequestMs: number;
      batchUpsertMs: number;
      dbUpsertMs: number;
      deletionMs: number;
      completeRequestMs: number;
    } = {
      idempotencyMs: 0,
      createRequestMs: 0,
      batchUpsertMs: 0,
      dbUpsertMs: 0,
      deletionMs: 0,
      completeRequestMs: 0,
    };
    let dbMetrics: BatchUpsertDbMetrics | null = null;

    const recordRepositoryMetrics = (
      status: 'cached' | 'new' | 'payload_mismatch' | 'still_processing' | 'error',
      extra?: Record<string, unknown>
    ): void => {
      if (!metricsEnabled) {
        return;
      }
      const totalDurationMs = Date.now() - totalStartTime;
      this.performanceMonitoring?.recordMetric(
        PerformanceMetricType.DATABASE_QUERY_TIME,
        'health.ingest.repository.total_ms',
        totalDurationMs,
        'ms',
        metricsTags,
        {
          status,
          samplesReceived: samples.length,
          deletionsReceived: deletions?.length ?? 0,
          idempotencyMs: timings.idempotencyMs,
          createRequestMs: timings.createRequestMs,
          batchUpsertMs: timings.batchUpsertMs,
          dbUpsertMs: timings.dbUpsertMs,
          deletionMs: timings.deletionMs,
          completeRequestMs: timings.completeRequestMs,
          insertedCount: dbMetrics?.insertedCount ?? 0,
          updatedCount: dbMetrics?.updatedCount ?? 0,
          ...extra,
        }
      );

      this.logger.info('Health ingest repository metrics', {
        context: 'HealthSampleRepository.batchUpsertWithIdempotency',
        event: 'health_ingest_repository',
        status,
        totalMs: totalDurationMs,
        idempotencyMs: timings.idempotencyMs,
        createRequestMs: timings.createRequestMs,
        batchUpsertMs: timings.batchUpsertMs,
        dbUpsertMs: timings.dbUpsertMs,
        deletionMs: timings.deletionMs,
        completeRequestMs: timings.completeRequestMs,
        samplesReceived: samples.length,
        deletionsReceived: deletions?.length ?? 0,
        insertedCount: dbMetrics?.insertedCount ?? 0,
        updatedCount: dbMetrics?.updatedCount ?? 0,
        ...metricsTags,
        ...(extra ?? {}),
      });
    };

    // TRUST BOUNDARY: payloadHash is already validated by middleware (validateBatchUpsertRequestWithHash)
    // using the shared computeSamplesPayloadHash() function. Do NOT recompute here.
    // Recomputing with a different algorithm (e.g., the old computePayloadHash static method)
    // would break idempotency due to hash mismatch.

    // Step 1: Check for existing request
    const idempotencyStart = Date.now();
    const idempotencyCheck = await this.checkRequestIdempotency(
      userId,
      requestId,
      payloadHash
    );
    timings.idempotencyMs = Date.now() - idempotencyStart;

    await recordDbConnectionMetrics(
      this.prisma,
      this.logger,
      'HealthSampleRepository.batchUpsertWithIdempotency',
      metricsTags
    );

    // Handle idempotency results
    switch (idempotencyCheck.status) {
      case 'CACHED_RESPONSE':
        // True idempotency: return cached response
        recordRepositoryMetrics('cached', { idempotencyStatus: 'CACHED' });
        return {
          ...idempotencyCheck.cachedResult,
          idempotencyStatus: 'CACHED',
        };

      case 'PAYLOAD_MISMATCH':
        // Security: Reject requests with same ID but different payload
        recordRepositoryMetrics('payload_mismatch', {
          idempotencyStatus: 'PAYLOAD_MISMATCH',
          originalHash: idempotencyCheck.originalHash,
        });
        throw new AppError(
          400, // HTTP Bad Request
          ErrorCodes.INVALID_INPUT,
          `Request ID '${requestId}' was already used with different payload. ` +
            'This may indicate a bug or tampering attempt.',
          true,
          {
            requestId,
            originalHash: idempotencyCheck.originalHash,
            newHash: payloadHash,
          }
        );

      case 'STILL_PROCESSING':
        // Concurrent request - tell client to retry later
        recordRepositoryMetrics('still_processing', {
          idempotencyStatus: 'STILL_PROCESSING',
          existingRequestId: idempotencyCheck.existingRequestId,
        });
        throw new AppError(
          409, // HTTP Conflict
          ErrorCodes.CONFLICT,
          `Request '${requestId}' is still being processed. Please retry later.`,
          true,
          { requestId, retryAfterMs: STILL_PROCESSING_RETRY_AFTER_MS }
        );

      case 'NEW_REQUEST':
        // Continue with processing
        break;

      default: {
        // TypeScript exhaustiveness check
        const _exhaustive: never = idempotencyCheck;
        throw new Error(`Unknown idempotency status: ${JSON.stringify(_exhaustive)}`);
      }
    }

    // Step 2: Create or reactivate ingest request record (marks as 'processing')
    //
    // When checkRequestIdempotency returns NEW_REQUEST for a failed request, we need
    // to REACTIVATE the existing record, not create a new one. The unique constraint
    // (userId, requestId) prevents creating a duplicate, so we must UPDATE instead.
    //
    // FLOW:
    // 1. Try to create new ingest request
    // 2. If P2002 (duplicate), try to reactivate failed request
    // 3. If reactivation fails (race or not failed), re-check idempotency
    let ingestRequest: HealthIngestRequest;
    const createRequestStart = Date.now();
    try {
      ingestRequest = await this.createIngestRequest({
        userId,
        requestId,
        payloadHash,
        sampleCount: samples.length,
      });
    } catch (error) {
      // Handle P2002 unique constraint violation
      if (error instanceof AppError && error.errorCode === ErrorCodes.DUPLICATE_REQUEST) {
        // This fixes BUG 3 where retrying a failed request caused 409 deadlock
        const reactivatedRequest = await this.reactivateFailedIngestRequest(
          userId,
          requestId,
          payloadHash,
          samples.length
        );

        if (reactivatedRequest) {
          // Successfully reactivated - use this request
          this.logger.info('Reactivated failed request for retry processing', {
            context: 'HealthSampleRepository.batchUpsertWithIdempotency',
            userId,
            requestId,
            ingestRequestId: reactivatedRequest.id,
          });
          ingestRequest = reactivatedRequest;
        } else {
          // Reactivation failed - either not found, not failed, or payloadHash mismatch
          // Re-check idempotency to determine correct response
          const recheckResult = await this.checkRequestIdempotency(
            userId,
            requestId,
            payloadHash
          );

          if (recheckResult.status === 'CACHED_RESPONSE') {
            timings.createRequestMs = Date.now() - createRequestStart;
            recordRepositoryMetrics('cached', { idempotencyStatus: 'CACHED' });
            return {
              ...recheckResult.cachedResult,
              idempotencyStatus: 'CACHED',
            };
          }

          if (recheckResult.status === 'PAYLOAD_MISMATCH') {
            timings.createRequestMs = Date.now() - createRequestStart;
            recordRepositoryMetrics('payload_mismatch', {
              idempotencyStatus: 'PAYLOAD_MISMATCH',
              originalHash: recheckResult.originalHash,
            });
            throw new AppError(
              400,
              ErrorCodes.INVALID_INPUT,
              `Request ID '${requestId}' was already used with different payload.`,
              true,
              { requestId, originalHash: recheckResult.originalHash, newHash: payloadHash }
            );
          }

          // Still processing - tell client to retry
          timings.createRequestMs = Date.now() - createRequestStart;
          recordRepositoryMetrics('still_processing', { idempotencyStatus: 'STILL_PROCESSING' });
          throw new AppError(
            409, // HTTP Conflict
            ErrorCodes.CONFLICT,
            `Request '${requestId}' is being processed by another instance. Please retry.`,
            true,
            { requestId, retryAfterMs: STILL_PROCESSING_RETRY_AFTER_MS }
          );
        }
      } else {
        timings.createRequestMs = Date.now() - createRequestStart;
        recordRepositoryMetrics('error', {
          idempotencyStatus: 'NEW',
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
    timings.createRequestMs = Date.now() - createRequestStart;

    let result: BatchUpsertResult;
    try {
      result = await this.processIngestRequest(
        userId,
        requestId,
        ingestRequest,
        samples,
        deletions,
        timings,
        (metrics) => {
          dbMetrics = metrics;
        },
        outboxCallback,
      );
    } catch (error) {
      recordRepositoryMetrics('error', {
        idempotencyStatus: 'NEW',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    recordRepositoryMetrics('new', {
      idempotencyStatus: 'NEW',
      successCount: result.metrics.successfulCount,
      failedCount: result.metrics.failedCount,
      deletedCount: result.metrics.deletedCount ?? 0,
    });

    return {
      ...result,
      idempotencyStatus: 'NEW',
    };
  }

  /**
   * Batch upsert using an EXISTING HealthIngestRequest record.
   *
   * Used by async queue workers that already created the ingest request and need
   * to process the batch without creating a second request record.
   *
   * GAP A FIX: When outboxCallback is provided, the entire mutation pipeline
   * (upserts + deletions + status + watermark + outbox event) runs in a single
   * atomic $transaction via processIngestRequest(). Queue workers should always
   * provide this callback to guarantee at-least-once event delivery.
   *
   * @param outboxCallback - Optional callback to write outbox event atomically
   *   within the same transaction as sample mutations. When provided, watermark
   *   is also bumped atomically, and the exact post-bump sequence number is
   *   passed to the callback as `watermarkAfter`.
   */
  async batchUpsertWithExistingRequest(
    userId: string,
    samples: CreateHealthSampleInput[],
    requestId: string,
    payloadHash: string,
    ingestRequestId?: string,
    deletions?: Array<InstanceType<typeof HealthSampleRepository.PreciseDeletionInput>>,
    outboxCallback?: HealthIngestOutboxCallback,
  ): Promise<BatchUpsertResult & { idempotencyStatus: 'NEW' | 'CACHED' }> {
    const metricsEnabled = shouldEmitHealthMetrics(userId);
    const metricsTags = getHealthMetricsTags(userId);
    const totalStartTime = Date.now();
    const timings: {
      idempotencyMs: number;
      createRequestMs: number;
      batchUpsertMs: number;
      dbUpsertMs: number;
      deletionMs: number;
      completeRequestMs: number;
    } = {
      idempotencyMs: 0,
      createRequestMs: 0,
      batchUpsertMs: 0,
      dbUpsertMs: 0,
      deletionMs: 0,
      completeRequestMs: 0,
    };
    let dbMetrics: BatchUpsertDbMetrics | null = null;

    const recordRepositoryMetrics = (
      status: 'cached' | 'new' | 'payload_mismatch' | 'error',
      extra?: Record<string, unknown>
    ): void => {
      if (!metricsEnabled) {
        return;
      }
      const totalDurationMs = Date.now() - totalStartTime;
      this.performanceMonitoring?.recordMetric(
        PerformanceMetricType.DATABASE_QUERY_TIME,
        'health.ingest.repository.total_ms',
        totalDurationMs,
        'ms',
        metricsTags,
        {
          status,
          samplesReceived: samples.length,
          deletionsReceived: deletions?.length ?? 0,
          idempotencyMs: timings.idempotencyMs,
          createRequestMs: timings.createRequestMs,
          batchUpsertMs: timings.batchUpsertMs,
          dbUpsertMs: timings.dbUpsertMs,
          deletionMs: timings.deletionMs,
          completeRequestMs: timings.completeRequestMs,
          insertedCount: dbMetrics?.insertedCount ?? 0,
          updatedCount: dbMetrics?.updatedCount ?? 0,
          ...(extra ?? {}),
        }
      );

      this.logger.info('Health ingest repository metrics', {
        context: 'HealthSampleRepository.batchUpsertWithExistingRequest',
        event: 'health_ingest_repository',
        status,
        totalMs: totalDurationMs,
        idempotencyMs: timings.idempotencyMs,
        createRequestMs: timings.createRequestMs,
        batchUpsertMs: timings.batchUpsertMs,
        dbUpsertMs: timings.dbUpsertMs,
        deletionMs: timings.deletionMs,
        completeRequestMs: timings.completeRequestMs,
        samplesReceived: samples.length,
        deletionsReceived: deletions?.length ?? 0,
        insertedCount: dbMetrics?.insertedCount ?? 0,
        updatedCount: dbMetrics?.updatedCount ?? 0,
        ...metricsTags,
        ...(extra ?? {}),
      });
    };

    const idempotencyStart = Date.now();
    const idempotencyCheck = await this.checkRequestIdempotency(
      userId,
      requestId,
      payloadHash
    );
    timings.idempotencyMs = Date.now() - idempotencyStart;

    switch (idempotencyCheck.status) {
      case 'CACHED_RESPONSE':
        recordRepositoryMetrics('cached', { idempotencyStatus: 'CACHED' });
        return {
          ...idempotencyCheck.cachedResult,
          idempotencyStatus: 'CACHED',
        };

      case 'PAYLOAD_MISMATCH':
        recordRepositoryMetrics('payload_mismatch', {
          idempotencyStatus: 'PAYLOAD_MISMATCH',
          originalHash: idempotencyCheck.originalHash,
        });
        throw new AppError(
          400,
          ErrorCodes.INVALID_INPUT,
          `Request ID '${requestId}' was already used with different payload.`,
          true,
          { requestId, originalHash: idempotencyCheck.originalHash, newHash: payloadHash }
        );

      case 'STILL_PROCESSING':
        // Continue - worker is responsible for completion.
        break;

      case 'NEW_REQUEST':
        // Continue - attempt to reactivate if needed below.
        break;

      default: {
        const _exhaustive: never = idempotencyCheck;
        throw new Error(`Unknown idempotency status: ${JSON.stringify(_exhaustive)}`);
      }
    }

    let ingestRequest: HealthIngestRequest | null = null;
    if (ingestRequestId) {
      ingestRequest = await this.prisma.healthIngestRequest.findUnique({
        where: { id: ingestRequestId },
      });
    }
    if (!ingestRequest) {
      ingestRequest = await this.prisma.healthIngestRequest.findUnique({
        where: {
          health_ingest_request_unique: { userId, requestId },
        },
      });
    }
    if (!ingestRequest) {
      recordRepositoryMetrics('error', { reason: 'INGEST_REQUEST_NOT_FOUND' });
      throw new AppError(
        404,
        ErrorCodes.RESOURCE_NOT_FOUND,
        `Ingest request not found for requestId '${requestId}'`,
        true,
        { requestId, userId }
      );
    }

    if (ingestRequest.userId !== userId) {
      recordRepositoryMetrics('error', { reason: 'USER_MISMATCH' });
      throw new AppError(
        403,
        ErrorCodes.FORBIDDEN,
        'Ingest request does not belong to authenticated user',
        true,
        { requestId, userId }
      );
    }

    if (ingestRequest.payloadHash !== payloadHash) {
      recordRepositoryMetrics('payload_mismatch', { idempotencyStatus: 'PAYLOAD_MISMATCH' });
      throw new AppError(
        400,
        ErrorCodes.INVALID_INPUT,
        `Request ID '${requestId}' was already used with different payload.`,
        true,
        { requestId }
      );
    }

    if (ingestRequest.status === 'completed' || ingestRequest.status === 'partial') {
      if (ingestRequest.responseJson) {
        recordRepositoryMetrics('cached', { idempotencyStatus: 'CACHED' });
        return {
          ...(ingestRequest.responseJson as unknown as BatchUpsertResult),
          idempotencyStatus: 'CACHED',
        };
      }
      // Invariant violation - reset to failed and allow reprocess
      await this.prisma.healthIngestRequest.update({
        where: { id: ingestRequest.id },
        data: {
          status: 'failed',
          responseJson: {
            error: 'Invariant violation: completed without responseJson',
            recoveredAt: new Date().toISOString(),
          } as unknown as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });
      ingestRequest = await this.reactivateFailedIngestRequest(
        userId,
        requestId,
        payloadHash,
        samples.length
      );
      if (!ingestRequest) {
        recordRepositoryMetrics('error', { reason: 'INVARIANT_RECOVERY_FAILED' });
        throw new AppError(
          409,
          ErrorCodes.CONFLICT,
          `Request '${requestId}' is not ready for reprocessing`,
          true,
          { requestId, retryAfterMs: STILL_PROCESSING_RETRY_AFTER_MS }
        );
      }
    }

    if (ingestRequest.status === 'failed') {
      const reactivated = await this.reactivateFailedIngestRequest(
        userId,
        requestId,
        payloadHash,
        samples.length
      );
      if (reactivated) {
        ingestRequest = reactivated;
      }
    }

    let result: BatchUpsertResult;
    try {
      result = await this.processIngestRequest(
        userId,
        requestId,
        ingestRequest,
        samples,
        deletions,
        timings,
        (metrics) => {
          dbMetrics = metrics;
        },
        outboxCallback,
      );
    } catch (error) {
      recordRepositoryMetrics('error', {
        idempotencyStatus: 'NEW',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    recordRepositoryMetrics('new', {
      idempotencyStatus: 'NEW',
      successCount: result.metrics.successfulCount,
      failedCount: result.metrics.failedCount,
      deletedCount: result.metrics.deletedCount ?? 0,
      processingMode: 'queued',
    });

    return {
      ...result,
      idempotencyStatus: 'NEW',
    };
  }

  // Stale Processing Recovery (Proactive Reaper)

  /**
   * Result of reaping stale processing ingest requests.
   */
  public static ReapStaleResult = class {
    /** Number of requests marked as failed */
    reapedCount: number = 0;
    /** List of reaped requestIds for logging */
    reapedRequestIds: string[] = [];
    /** Detailed info for each reaped request */
    reapedRequests: Array<{
      id: string;
      requestId: string;
      userId: string;
    }> = [];
  };

  /**
   * Reap stale processing ingest requests by marking them as failed.
   *
   * PROACTIVE RECOVERY:
   * This method is called by a background job (HealthIngestReaper) to proactively
   * clean up requests that have been stuck in 'processing' status for too long.
   *
   * CONCURRENCY SAFETY:
   * Uses `FOR UPDATE SKIP LOCKED` to avoid racing with:
   * - Live requests still being processed
   * - Other reaper instances running concurrently
   *
   * IDEMPOTENCY:
   * Safe to call multiple times - already-failed requests are excluded by
   * the `WHERE status = 'processing'` clause.
   *
   * RATIONALE:
   * - Reactive recovery (in checkRequestIdempotency) only happens when clients retry
   * - If no client retries, stale requests remain 'processing' forever
   * - This job provides proactive cleanup for observability and operational health
   *
   * @param staleAfterMinutes - Mark requests older than this as failed (1-120)
   * @param maxRows - Maximum number of requests to reap per call (1-50000)
   * @returns Result with count and details of reaped requests
   */
  async reapStaleProcessingIngestRequests(
    staleAfterMinutes: number,
    maxRows: number
  ): Promise<{
    reapedCount: number;
    reapedRequestIds: string[];
    reapedRequests: Array<{ id: string; requestId: string; userId: string }>;
  }> {
    // FAIL-FAST VALIDATION (PRINCIPLES: Detect and report errors immediately)
    if (!Number.isInteger(staleAfterMinutes) || staleAfterMinutes < 1 || staleAfterMinutes > 120) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `staleAfterMinutes must be an integer between 1 and 120, got: ${staleAfterMinutes}`
      );
    }

    if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 50000) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `maxRows must be an integer between 1 and 50000, got: ${maxRows}`
      );
    }

    try {
      // CTE + FOR UPDATE SKIP LOCKED pattern
      // 1. CTE selects stale processing rows with row-level lock
      // 2. SKIP LOCKED avoids contention with live processing or other reapers
      // 3. UPDATE uses the locked rows from CTE
      // 4. RETURNING provides reaped request details for logging
      // Use INTERVAL with string concatenation to avoid Prisma template literal issues
      const result = await this.prisma.$queryRaw<
        Array<{
          id: string;
          request_id: string;
          user_id: string;
        }>
      >`
        WITH stale_requests AS (
          SELECT id
          FROM health_ingest_requests
          WHERE status = 'processing'
            AND created_at < (NOW() - (${staleAfterMinutes} || ' minutes')::interval)
          ORDER BY created_at ASC
          LIMIT ${maxRows}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE health_ingest_requests hir
        SET
          status = 'failed',
          response_json = jsonb_build_object(
            'error', 'Reaped stale processing request by background job',
            'reapedAt', to_char(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'staleAfterMinutes', ${staleAfterMinutes}
          ),
          completed_at = NOW()
        FROM stale_requests sr
        WHERE hir.id = sr.id
        RETURNING hir.id, hir.request_id AS request_id, hir.user_id AS user_id
      `;

      const reapResult = {
        reapedCount: result.length,
        reapedRequestIds: result.map(r => r.id),  // Return primary key `id`, not `request_id`
        reapedRequests: result.map(r => ({
          id: r.id,
          requestId: r.request_id,
          userId: r.user_id,
        })),
      };

      if (reapResult.reapedCount > 0) {
        this.logger.warn('Reaped stale processing ingest requests', {
          context: 'HealthSampleRepository.reapStaleProcessingIngestRequests',
          reapedCount: reapResult.reapedCount,
          staleAfterMinutes,
          requestIds: reapResult.reapedRequestIds,
        });
      } else {
        this.logger.debug('No stale processing requests to reap', {
          context: 'HealthSampleRepository.reapStaleProcessingIngestRequests',
          staleAfterMinutes,
          maxRows,
        });
      }

      return reapResult;
    } catch (error) {
      this.logger.error('Error reaping stale processing requests', {
        context: 'HealthSampleRepository.reapStaleProcessingIngestRequests',
        staleAfterMinutes,
        maxRows,
        error: error instanceof Error ? error.message : String(error),
      });
      throw this.handleError(error, 'reapStaleProcessingIngestRequests');
    }
  }

  // Ingest Request Cleanup

  /**
   * Purge old HealthIngestRequest records for cleanup.
   *
   * RETENTION POLICY: Ingest requests are kept for idempotency replay.
   * After the retention period, old requests can be safely purged.
   *
   * NOTE: Once purged, duplicate requests will be processed as new
   * (sample-level idempotency still applies via sourceRecordId).
   *
   * @param retentionDays - Days to keep ingest requests (default: 30)
   * @returns Number of records purged
   */
  async purgeOldIngestRequests(retentionDays: number = 30): Promise<number> {
    try {
      const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

      const result = await this.prisma.healthIngestRequest.deleteMany({
        where: {
          createdAt: { lt: cutoffDate },
        },
      });

      this.logger.info('Purged old ingest requests', {
        context: 'HealthSampleRepository.purgeOldIngestRequests',
        purgedCount: result.count,
        retentionDays,
        cutoffDate: cutoffDate.toISOString(),
      });

      return result.count;
    } catch (error) {
      this.logger.error('Error purging old ingest requests', {
        context: 'HealthSampleRepository.purgeOldIngestRequests',
        error: error instanceof Error ? error.message : String(error),
      });
      throw this.handleError(error, 'purgeOldIngestRequests');
    }
  }
}
