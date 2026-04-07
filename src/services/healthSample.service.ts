/**
 * Health Sample Service
 * Business logic for health data operations
 *
 * ARCHITECTURE:
 * - Separate from entity sync (no OutboxRepository, no CursorRepository)
 * - Push-only sync with batch upsert
 * - Two-layer idempotency handling:
 *   1. Request-level: HealthIngestRequest table with payload hash verification
 *   2. Sample-level: (userId, sourceId, sourceRecordId) unique constraint
 *
 * IDEMPOTENCY GUARANTEES:
 * - Duplicate requests with same payload: return cached response instantly
 * - Duplicate requests with different payload: reject with error (tampering)
 * - Duplicate samples: ON CONFLICT DO UPDATE (metadata updates allowed)
 *
 * @see HEALTHKITPLANFINAL.md for architectural decisions
 */

import type { HealthSample, Prisma } from '@prisma/client';
import {
  HealthSampleRepository,
  BatchUpsertResult,
  CreateHealthSampleInput,
  HealthIngestOutboxCallback,
} from '../repositories/health-sample.repository';
import { OutboxEventRepository } from '../repositories/outbox-event.repository';
import { UserRepository } from '../repositories/user.repository';
import { LoggerService } from './logger.service';
import { PerformanceMonitoringService, PerformanceMetricType } from './performanceMonitoring.service';
import { AppError, ErrorCodes } from '../utils/AppError';
import { DomainEventService } from '../events/domain-event.service';
import {
  isHealthMetricCode,
  tryNormalizeToCanonicalUnit,
  isCategorySample,
  isNumericSample,
  HEALTH_METRIC_CODES,
  SESSION_TELEMETRY_DEFAULT_METRICS,
  SESSION_TELEMETRY_SECONDARY_METRICS,
  type SampleErrorCode,
  type HealthMetricCode,
  toLocalDate,
  getAffectedLocalDates,
  getMetricCategory,
} from '@shared/contracts';
import type { HealthSample as HealthSampleContract } from '@shared/contracts';
import type { PaginatedResponse, CursorPaginatedResponse } from '../repositories/base.repository';
import type { HealthSampleCursor, DeletionItem } from '@shared/contracts';
import { getHealthMetricsTags, shouldEmitHealthMetrics } from '../utils/healthMetrics';
import {
  ExtendedUserPrivacySettingsSchema,
  type HealthPrivacySettings,
} from '../models';
import { createHash } from 'crypto';

/**
 * Extended result type that includes idempotency status.
 */
export interface BatchUpsertResultWithIdempotency extends BatchUpsertResult {
  /** Whether this was a new request or a cached replay */
  idempotencyStatus: 'NEW' | 'CACHED';
}

/**
 * Result of batch deletion processing.
 *
 * PHASE 5 CHANGE: Added optional `startAt` field to successful and failed arrays
 * for precise deletion mapping on the client side.
 *
 * P0-G FIX: Added optional `endAt` and `metricCode` fields to successful array
 * for precise cache invalidation by downstream projections.
 */
export interface BatchDeletionResult {
  /** Successfully processed deletions */
  successful: Array<{
    sourceId: string;
    sourceRecordId: string;
    /** Sample start timestamp (ISO 8601). Present when request included startAt. */
    startAt?: string;
    /**
     * P0-G FIX: Sample end timestamp (ISO 8601).
     * Present when the deleted sample had endAt in the database.
     */
    endAt?: string;
    /**
     * P0-G FIX: Metric code of the deleted sample.
     * Present when the deletion was successfully processed.
     */
    metricCode?: string;
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
  /** Total deleted count (excluding already deleted) */
  deletedCount: number;
  /** Count of samples that were already deleted */
  alreadyDeletedCount: number;
  /** Count of samples not found */
  notFoundCount: number;
}

/**
 * Service for health sample operations
 *
 * DEPENDENCY INJECTION:
 * - Repository is injected via constructor (Pure DI, no service locator)
 * - Bootstrap.ts is the single composition root
 * - This enables easy mocking for unit tests
 *
 * PHASE 6 ADDITION: UserRepository for privacy gating
 */
export class HealthSampleService {
  /**
   * Constructor with explicit dependency injection
   *
   * @param repository - HealthSampleRepository instance from RepositoryFactory
   * @param logger - LoggerService for structured logging
   * @param performanceMonitoring - PerformanceMonitoringService for metrics (optional)
   * @param userRepository - UserRepository for privacy settings lookup (PHASE 6)
   * @param domainEventService - DomainEventService for legacy in-memory events (deprecated)
   * @param outboxRepository - OutboxEventRepository for transactional outbox pattern (P0-A)
   */
  constructor(
    private repository: HealthSampleRepository,
    private logger: LoggerService,
    private performanceMonitoring?: PerformanceMonitoringService,
    private userRepository?: UserRepository,
    private domainEventService?: DomainEventService,
    private outboxRepository?: OutboxEventRepository,
  ) {
    if (!repository) {
      throw new Error('HealthSampleService: HealthSampleRepository is required');
    }
    if (!logger) {
      throw new Error('HealthSampleService: LoggerService is required');
    }
    // userRepository is optional for backward compatibility during rollout
    // outboxRepository is optional for backward compatibility - will be required after full rollout
  }

  // P0-A: TRANSACTIONAL OUTBOX PATTERN

  /**
   * Compute affected local dates from samples and deletions.
   *
   * This is used for the health.samples.changed event payload to enable
   * date-scoped cache invalidation and projection targeting.
   *
   * @param samples - Samples that were successfully upserted
   * @param result - Batch upsert result (includes deletion info)
   * @param timezoneOffsetMinutes - Timezone offset in minutes from UTC
   *   (positive = east, negative = west; e.g., -300 for EST, +330 for IST)
   * @returns Array of unique local date strings (YYYY-MM-DD)
   */
  private computeAffectedLocalDates(
    samples: CreateHealthSampleInput[],
    result: BatchUpsertResult,
    timezoneOffsetMinutes: number
  ): string[] {
    const dates = new Set<string>();

    // GAP A FIX: Use getAffectedLocalDates() for ALL samples (startAt AND endAt)
    // Previous bug: only used sample.startAt → missed dates for interval samples
    // spanning midnight (e.g., sleep stage 11pm → 7am next day).
    // Now: getAffectedLocalDates() enumerates every local date overlapped by
    // [startAt, endAt], capped at MAX_AFFECTED_LOCAL_DATES for safety.
    for (const sample of samples) {
      // Use per-sample TZ if available, otherwise fall back to request-level offset
      const effectiveOffset = sample.timezoneOffsetMin ?? timezoneOffsetMinutes;
      const sampleDates = getAffectedLocalDates(sample.startAt, sample.endAt, effectiveOffset);
      for (const d of sampleDates) {
        dates.add(d);
      }
    }

    // Add dates from successful deletions (BOTH startAt AND endAt)
    if (result.deletions?.successful) {
      for (const deletion of result.deletions.successful) {
        // Build start/end dates for getAffectedLocalDates()
        let startDate: Date | null = null;
        let endDate: Date | null = null;

        if (deletion.startAt) {
          try {
            const parsed = new Date(deletion.startAt);
            if (!isNaN(parsed.getTime())) startDate = parsed;
          } catch (e) {
            this.logger.warn('Failed to parse deletion startAt for local date computation', {
              context: 'HealthSampleService.computeAffectedLocalDates',
              rawStartAt: deletion.startAt,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }

        if (deletion.endAt) {
          try {
            const parsed = new Date(deletion.endAt);
            if (!isNaN(parsed.getTime())) endDate = parsed;
          } catch (e) {
            this.logger.warn('Failed to parse deletion endAt for local date computation', {
              context: 'HealthSampleService.computeAffectedLocalDates',
              rawEndAt: deletion.endAt,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }

        // EDGE CASE 2 FIX: Use per-sample TZ from DB when available, falling
        // back to request-level offset. This ensures correct date bucketing
        // for deleted interval samples when the user has traveled or DST changed.
        const deletionOffset = deletion.timezoneOffsetMin ?? timezoneOffsetMinutes;

        // Use getAffectedLocalDates if both are available, otherwise fall back to individual dates
        if (startDate && endDate) {
          const deletionDates = getAffectedLocalDates(startDate, endDate, deletionOffset);
          for (const d of deletionDates) {
            dates.add(d);
          }
        } else if (startDate) {
          dates.add(toLocalDate(startDate, deletionOffset));
        } else if (endDate) {
          dates.add(toLocalDate(endDate, deletionOffset));
        }
      }
    }

    return Array.from(dates).sort();
  }

  /**
   * Create a callback that writes the health.samples.changed outbox event
   * within the same transaction as the sample upsert.
   *
   * dual-write inconsistencies. The outbox event is committed in the SAME
   * transaction as the data mutation, guaranteeing at-least-once delivery.
   *
   * @param userId - User ID
   * @param requestId - Client request ID (idempotency key)
   * @param correlationId - Correlation ID for tracing
   * @param deviceId - Device ID (optional)
   * @param transformedSamples - Samples that passed validation
   * @param timezoneOffsetMinutes - Timezone offset for local date computation
   * @param timezoneExplicit - Whether the timezone offset was explicitly provided (not defaulted to UTC)
   * @returns Callback function to be executed within the transaction
   */
  private createOutboxCallback(
    userId: string,
    requestId: string,
    correlationId: string | undefined,
    deviceId: string | undefined,
    transformedSamples: CreateHealthSampleInput[],
    timezoneOffsetMinutes: number = 0,
    timezoneExplicit: boolean = false
  ): HealthIngestOutboxCallback {
    // FAIL-FAST: The transactional outbox is the canonical event delivery path.
    // If OutboxEventRepository is not injected, health mutations would commit
    // without projection triggers — a dual-write correctness break causing
    // permanently stale derived state. Throw to surface the bootstrap
    // misconfiguration immediately rather than silently degrading.
    if (!this.outboxRepository) {
      throw new Error(
        'MISCONFIGURATION: OutboxEventRepository not injected into HealthSampleService. ' +
        'Health mutations cannot commit without outbox events — projection triggers would be lost. ' +
        'Ensure bootstrap.ts provides OutboxEventRepository to HealthSampleService.'
      );
    }

    return async (tx: Prisma.TransactionClient, result: BatchUpsertResult, watermarkAfter: bigint) => {
      // Only emit if there are actual data changes
      const successfulCount = result.metrics.successfulCount;
      const deletedCount = result.metrics.deletedCount ?? 0;
      const hasDataChanges = successfulCount > 0 || deletedCount > 0;

      if (!hasDataChanges) {
        this.logger.debug('No data changes, skipping outbox event', {
          context: 'HealthSampleService.createOutboxCallback',
          userId,
          requestId,
        });
        return;
      }

      // Compute time range from samples and deletions
      let minStartMs = Number.POSITIVE_INFINITY;
      let maxEndMs = 0;
      const metricCodes = new Set<string>();

      // Process successful samples for time range and metric codes
      for (const sample of transformedSamples) {
        metricCodes.add(sample.metricCode);
        const startMs = sample.startAt.getTime();
        const endMs = sample.endAt.getTime();
        if (startMs < minStartMs) minStartMs = startMs;
        if (endMs > maxEndMs) maxEndMs = endMs;
      }

      // P0-G FIX: Include deletions in time range AND collect deletion metricCodes
      // Previous bug: used startMs for maxEndMs comparison, ignored deletion metricCodes
      if (result.deletions?.successful) {
        for (const deletion of result.deletions.successful) {
          // Add deletion metricCode to the set for accurate projection targeting
          if (deletion.metricCode) {
            metricCodes.add(deletion.metricCode);
          }

          // Handle startAt for time range
          if (deletion.startAt) {
            try {
              const startMs = new Date(deletion.startAt).getTime();
              if (!isNaN(startMs)) {
                if (startMs < minStartMs) minStartMs = startMs;
              }
            } catch (e) {
              this.logger.warn('Failed to parse deletion startAt for time range computation', {
                context: 'HealthSampleService.createOutboxCallback',
                userId,
                requestId,
                rawStartAt: deletion.startAt,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }

          // Previous bug at line 250: used startMs for maxEndMs, which was incorrect
          if (deletion.endAt) {
            try {
              const endMs = new Date(deletion.endAt).getTime();
              if (!isNaN(endMs)) {
                if (endMs > maxEndMs) maxEndMs = endMs;
              }
            } catch (e) {
              this.logger.warn('Failed to parse deletion endAt for time range computation', {
                context: 'HealthSampleService.createOutboxCallback',
                userId,
                requestId,
                rawEndAt: deletion.endAt,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          } else if (deletion.startAt) {
            // Fallback: If no endAt, use startAt as a minimum bound
            try {
              const startMs = new Date(deletion.startAt).getTime();
              if (!isNaN(startMs) && startMs > maxEndMs) {
                maxEndMs = startMs;
              }
            } catch (e) {
              this.logger.warn('Failed to parse deletion startAt (fallback) for time range computation', {
                context: 'HealthSampleService.createOutboxCallback',
                userId,
                requestId,
                rawStartAt: deletion.startAt,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }
        }
      }

      // Compute affected local dates for projection targeting
      const affectedLocalDates = this.computeAffectedLocalDates(
        transformedSamples,
        result,
        timezoneOffsetMinutes
      );

      // MULTI-OFFSET FIX: Compute offsetRange from ALL per-sample offsets.
      //
      // The payload's single timezoneOffsetMinutes is the request-level
      // header value (or 0). But individual samples may carry different
      // per-sample offsets (travel, DST transitions, multi-device).
      //
      // offsetRange.min/max enables projection handlers to widen their UTC
      // query window when offsets differ, then filter in-memory by per-sample
      // TZ. When min === max (common case), handlers use the fast path.
      const allOffsets: number[] = [];

      // Include request-level offset as baseline
      allOffsets.push(timezoneOffsetMinutes);

      // Collect per-sample offsets from transformed samples
      for (const sample of transformedSamples) {
        if (sample.timezoneOffsetMin != null) {
          allOffsets.push(sample.timezoneOffsetMin);
        }
      }

      // Collect per-sample offsets from successful deletions
      if (result.deletions?.successful) {
        for (const deletion of result.deletions.successful) {
          if (deletion.timezoneOffsetMin != null) {
            allOffsets.push(deletion.timezoneOffsetMin);
          }
        }
      }

      // Compute min/max (allOffsets always has at least one entry: timezoneOffsetMinutes)
      const offsetRange = {
        min: Math.min(...allOffsets),
        max: Math.max(...allOffsets),
      };

      // GAP C FIX: Extract range values for invariant validation before payload construction
      const rangeStartMs = Number.isFinite(minStartMs) ? minStartMs : 0;
      const rangeEndMs = maxEndMs;

      // GAP C FIX: Fail-fast invariant validation — degenerate range detection.
      // When we reach this point, hasDataChanges is true (gated at line 249).
      // A [0, 0] range means no valid timestamps were extracted from either
      // transformedSamples or deletion results. This causes downstream
      // TelemetryCacheProjectionHandler to query sessions around Unix epoch,
      // find nothing, and silently skip cache invalidation.
      //
      // Root cause: repository processIngestRequest did not enrich deletion
      // success entries with endAt/metricCode from deletedSampleDetails.
      // When a batch has only deletions (no upserted samples), the range collapses.
      //
      // This guard converts a silent data corruption into a loud failure.
      // The transaction rolls back, ingest request is marked failed, and
      // the client can retry. After the repository enrichment fix (also in
      // this commit), this guard acts as a permanent safety net.
      if (rangeStartMs === 0 && rangeEndMs === 0) {
        const errorContext = {
          context: 'HealthSampleService.createOutboxCallback',
          userId,
          requestId,
          correlationId,
          sampleCount: successfulCount,
          deletedCount,
          metricCodesCollected: Array.from(metricCodes),
          transformedSamplesCount: transformedSamples.length,
          deletionSuccessfulCount: result.deletions?.successful?.length ?? 0,
          deletionFailedCount: result.deletions?.failed?.length ?? 0,
        };
        this.logger.error(
          'INVARIANT VIOLATION: rangeStartMs=0 and rangeEndMs=0 despite hasDataChanges=true. ' +
          'Deletion entries likely missing endAt/metricCode from repository mapping. ' +
          'Aborting outbox event creation to prevent silent cache invalidation failure downstream.',
          errorContext
        );
        throw new Error(
          `Health outbox range invariant violated: [0, 0] with ` +
          `${successfulCount} upserts, ${deletedCount} deletions ` +
          `(userId=${userId}, requestId=${requestId})`
        );
      }

      // Build event payload matching OutboxEventPayloadSchema
      // Note: The event is created with eventType, aggregateId, aggregateType, version
      // as required by the schema. The actual business data goes in the 'data' field.
      const eventPayload = {
        eventType: 'health.samples.changed',
        aggregateId: userId,
        aggregateType: 'health',
        version: 1,
        data: {
          userId,
          requestId,
          correlationId: correlationId ?? requestId,
          deviceId,
          sampleCount: successfulCount,
          deletedCount,
          hasDeletions: deletedCount > 0,
          metricCodes: Array.from(metricCodes),
          affectedLocalDates,
          rangeStartMs,
          rangeEndMs,
          timezoneOffsetMinutes,
          // GAP B FIX: Flag indicating whether timezone was explicitly provided
          // (per-sample or request-level), not silently defaulted to UTC.
          // Downstream projections (especially sleep) can use this to assess
          // local date confidence.
          timezoneExplicit,
          // MULTI-OFFSET FIX: Carry the min/max of all per-sample offsets
          // so projection handlers can widen UTC query ranges when offsets differ.
          // When min === max (common case), handlers use existing fast path unchanged.
          offsetRange,
          // GAP A FIX: Carry the exact post-bump watermark sequence number so
          // consumers (projectors) can detect out-of-order or stale events.
          // Serialized as string for BigInt precision safety (Number() loses
          // precision beyond 2^53). Consumers MUST use BigInt() for comparison.
          // A value of "0" means no data changes occurred (no watermark bump).
          minRequiredSeq: watermarkAfter.toString(),
        },
        metadata: {
          timestamp: new Date().toISOString(),
          userId,
          correlationId: correlationId ?? requestId,
        },
      };

      // Create deterministic event hash for deduplication
      const eventHash = createHash('sha256')
        .update(JSON.stringify({
          userId,
          requestId,
          sampleCount: successfulCount,
          deletedCount,
        }))
        .digest('hex');

      // Write outbox event within the transaction.
      // GAP A FIX: dedupeKey prevents duplicate in-flight outbox events for the
      // same request. The partial unique index on OutboxEvent only enforces
      // uniqueness while events are PENDING or PROCESSING — once
      // COMPLETED/FAILED/DEAD_LETTER, the slot is released for future events.
      await this.outboxRepository!.createInTransaction(tx, {
        aggregateId: userId,
        aggregateType: 'health',
        eventType: 'health.samples.changed',
        payload: eventPayload,
        eventHash,
        maxRetries: 5, // Health events are critical, allow more retries
        // Phase 6A FIX: Tenant-scoped dedupe key. Previous format `health-ingest:${requestId}`
        // was globally indexed and could collide cross-tenant if two users generated the same
        // client UUID. Including userId as namespace prevents false dedupe conflicts.
        // No migration needed: old-format and new-format keys coexist safely. Primary dedup
        // relies on eventHash (which already includes userId via SHA-256).
        dedupeKey: `health-ingest:${userId}:${requestId}`,
      });

      this.logger.info('Created health.samples.changed outbox event in transaction', {
        context: 'HealthSampleService.createOutboxCallback',
        userId,
        requestId,
        sampleCount: successfulCount,
        deletedCount,
        metricCodes: Array.from(metricCodes),
        affectedLocalDates,
        rangeStartMs,
        rangeEndMs,
      });
    };
  }

  /**
   * Check if health data upload is allowed for a user based on their privacy settings.
   *
   * PHASE 6 ADDITION: Server-side privacy gating.
   *
   * This method:
   * 1. Fetches the user's privacy settings from the database
   * 2. Parses health-specific privacy settings if present
   * 3. Returns whether upload is allowed and any blocked metrics
   *
   * DEFAULT BEHAVIOR (if settings not configured or userRepository not provided):
   * - allowHealthDataUpload: true (backward compatible - uploads allowed by default)
   * - blockedMetrics: [] (no metrics blocked)
   *
   * @param userId - User ID to check privacy settings for
   * @returns Health privacy settings with defaults applied
   */
  private async getHealthPrivacySettings(userId: string): Promise<HealthPrivacySettings> {
    // Default settings: allow all (backward compatible)
    const defaults: HealthPrivacySettings = {
      allowHealthDataUpload: true,
      blockedMetrics: [],
      allowAggregation: true,
    };

    // If no userRepository, return defaults (backward compatible)
    if (!this.userRepository) {
      this.logger.debug('No UserRepository available, using default health privacy settings', {
        context: 'HealthSampleService.getHealthPrivacySettings',
        userId,
        usingDefaults: true,
      });
      return defaults;
    }

    try {
      // Fetch user's privacy settings (use admin method since this is internal service call)
      // Note: findByIdAdmin accepts options that get merged with { where: { id } }
      const user = await this.userRepository.findByIdAdmin(userId);

      if (!user || !user.privacySettings) {
        this.logger.debug('No privacy settings found for user, using defaults', {
          context: 'HealthSampleService.getHealthPrivacySettings',
          userId,
          usingDefaults: true,
        });
        return defaults;
      }

      // Parse extended privacy settings (includes health sub-object)
      const parsed = ExtendedUserPrivacySettingsSchema.safeParse(user.privacySettings);
      if (!parsed.success) {
        this.logger.warn('Failed to parse privacy settings, using defaults', {
          context: 'HealthSampleService.getHealthPrivacySettings',
          userId,
          error: parsed.error.message,
          usingDefaults: true,
        });
        return defaults;
      }

      // Extract health privacy settings with defaults
      // When health is undefined, use empty defaults
      const healthSettings = parsed.data.health;
      if (!healthSettings) {
        return defaults;
      }

      return {
        allowHealthDataUpload: healthSettings.allowHealthDataUpload ?? true,
        blockedMetrics: healthSettings.blockedMetrics ?? [],
        allowAggregation: healthSettings.allowAggregation ?? true,
      };

    } catch (error) {
      // On any error, log and return defaults (fail-open for privacy check)
      // This ensures service degradation doesn't block health uploads
      this.logger.error('Error fetching health privacy settings, using defaults', {
        context: 'HealthSampleService.getHealthPrivacySettings',
        userId,
        error: error instanceof Error ? error.message : String(error),
        usingDefaults: true,
      });
      return defaults;
    }
  }

  /**
   * Ensure health uploads are allowed for a user and return privacy settings.
   */
  public async assertHealthUploadAllowed(
    userId: string,
    requestId: string,
    sampleCount: number,
  ): Promise<HealthPrivacySettings> {
    const privacySettings = await this.getHealthPrivacySettings(userId);

    if (!privacySettings.allowHealthDataUpload) {
      this.logger.info('Health data upload blocked by user privacy settings', {
        context: 'HealthSampleService.assertHealthUploadAllowed',
        userId,
        requestId,
        sampleCount,
      });

      throw new AppError(
        403,
        ErrorCodes.FORBIDDEN,
        'Health data upload is disabled by user privacy settings',
        true,
        { requestId, userId, reason: 'HEALTH_UPLOAD_DISABLED' }
      );
    }

    return privacySettings;
  }

  /**
   * Filter samples based on blocked metrics from privacy settings.
   *
   * @param samples - Samples to filter
   * @param blockedMetrics - Metric codes that are blocked
   * @returns Object with allowed samples and blocked samples
   */
  private filterBlockedMetrics(
    samples: HealthSampleContract[],
    blockedMetrics: string[]
  ): {
    allowed: HealthSampleContract[];
    blocked: Array<{ sample: HealthSampleContract; reason: string }>;
  } {
    if (blockedMetrics.length === 0) {
      return { allowed: samples, blocked: [] };
    }

    const blockedSet = new Set(blockedMetrics);
    const allowed: HealthSampleContract[] = [];
    const blocked: Array<{ sample: HealthSampleContract; reason: string }> = [];

    for (const sample of samples) {
      if (blockedSet.has(sample.metricCode)) {
        blocked.push({
          sample,
          reason: `Metric '${sample.metricCode}' is blocked by user privacy settings`,
        });
      } else {
        allowed.push(sample);
      }
    }

    return { allowed, blocked };
  }

  /**
   * Batch upsert health samples with TRUE request-level idempotency.
   *
   * This method provides complete idempotency at two levels:
   * 1. REQUEST-LEVEL: Same requestId + payload = cached response (via HealthIngestRequest)
   * 2. SAMPLE-LEVEL: Same sourceRecordId = ON CONFLICT DO UPDATE (metadata updates allowed)
   *
   * IDEMPOTENCY BEHAVIOR:
   * - First request: Processes samples, caches response in HealthIngestRequest
   * - Duplicate request (same payload): Returns cached response instantly
   * - Duplicate request (different payload): Rejects with error (tampering detection)
   * - Concurrent duplicate: Second request gets "still processing" error
   *
   * @param userId - User ID
   * @param samples - Samples from request
   * @param requestId - Client-generated idempotency key (REQUIRED, UUID format)
   * @param payloadHash - Pre-validated SHA-256 hash from middleware (REQUIRED)
   * @param correlationId - Optional correlation ID for tracing
   * @param deviceId - Optional device ID for audit trail (from X-Device-ID header)
   * @param deletions - Optional array of deletion items (STOP-SHIP #1 FIX: now inside idempotency boundary)
   * @returns Batch result with successful/failed samples, deletion results, and idempotency status
   * @throws AppError(INVALID_INPUT) if payload hash mismatch detected
   * @throws AppError(CONFLICT) if request is still being processed
   *
   * STOP-SHIP #1 FIX:
   * Deletions are now processed INSIDE the idempotency boundary. The cached responseJson
   * includes both sample results AND deletion results, ensuring retries with the same
   * requestId return byte-for-byte identical responses.
   *
   * TRUST BOUNDARY:
   * The payloadHash MUST be validated by middleware (validateBatchUpsertRequestWithHash)
   * BEFORE reaching this method. This service TRUSTS the validated hash and passes it
   * through to the repository without recomputation.
   */
  async batchUpsertSamples(
    userId: string,
    samples: HealthSampleContract[],
    requestId: string,
    payloadHash: string,
    correlationId?: string,
    deviceId?: string,
    deletions?: DeletionItem[],
    options?: {
      mode?: 'new' | 'existing';
      ingestRequestId?: string;
      requestMeta?: {
        contentEncoding?: string;
        contentLengthBytes?: number;
        uncompressedBytes?: number;
      };
      /**
       * P0-E: Timezone offset in minutes from UTC for local date computation.
       *
       * CONVENTION (consistent across codebase):
       *   Positive = east of UTC  (e.g., +330 for IST = UTC+5:30)
       *   Negative = west of UTC  (e.g., -300 for EST = UTC-5)
       *   Zero     = UTC
       *
       * Formula: localMs = utcMs + (offsetMinutes * 60000)
       *
       * Source: X-Timezone-Offset header extracted by health controller.
       * Used to compute affectedLocalDates for targeted cache invalidation.
       * If not provided, defaults to 0 (UTC).
       */
      timezoneOffsetMinutes?: number;
    }
  ): Promise<BatchUpsertResultWithIdempotency> {
    this.logger.debug('Processing batch upsert with idempotency', {
      context: 'HealthSampleService.batchUpsertSamples',
      userId,
      requestId,
      payloadHash: payloadHash.substring(0, 16) + '...', // Log prefix only for security
      correlationId,
      deviceId, // Include device ID for audit trail
      sampleCount: samples.length,
    });

    const metricsEnabled = shouldEmitHealthMetrics(userId);
    const metricsTags = getHealthMetricsTags(userId);
    const requestMeta = options?.requestMeta;
    const totalStartTime = Date.now();

    // PHASE 6: PRIVACY GATING
    // Check user's health privacy settings before processing any samples.
    // This is a server-side enforcement of user privacy preferences.
    const privacyStartTime = Date.now();
    const privacySettings = await this.assertHealthUploadAllowed(userId, requestId, samples.length);
    const privacyDurationMs = Date.now() - privacyStartTime;

    // Filter out samples for blocked metrics
    let samplesToProcess = samples;
    const privacyBlockedFailures: Array<{
      sourceId: string;
      sourceRecordId: string;
      startAt: string;
      error: string;
      errorCode: SampleErrorCode;
      retryable: boolean;
    }> = [];

    if (privacySettings.blockedMetrics && privacySettings.blockedMetrics.length > 0) {
      const filterResult = this.filterBlockedMetrics(samples, privacySettings.blockedMetrics);
      samplesToProcess = filterResult.allowed;

      // Convert blocked samples to failures
      for (const { sample, reason } of filterResult.blocked) {
        privacyBlockedFailures.push({
          sourceId: sample.sourceId,
          sourceRecordId: sample.sourceRecordId,
          startAt: sample.startAt,
          error: reason,
          errorCode: 'PRIVACY_BLOCKED',
          retryable: false, // Cannot retry - user must change privacy settings
        });
      }

      if (privacyBlockedFailures.length > 0) {
        this.logger.info('Some samples blocked by metric privacy settings', {
          context: 'HealthSampleService.batchUpsertSamples',
          userId,
          requestId,
          blockedCount: privacyBlockedFailures.length,
          allowedCount: samplesToProcess.length,
          blockedMetrics: privacySettings.blockedMetrics,
        });
      }
    }

    // Validate and transform samples
    // and return them as explicit failures (no silent fallbacks)
    const transformStartTime = Date.now();
    const transformedSamples: CreateHealthSampleInput[] = [];
    // Use SampleErrorCode from shared contract to ensure type alignment with BatchUpsertResult
    const preValidationFailures: Array<{
      sourceId: string;
      sourceRecordId: string;
      startAt: string;
      error: string;
      errorCode: SampleErrorCode;
      retryable: boolean;
    }> = [];

    // GAP B FIX: Extract request-level timezone offset BEFORE the sample loop
    // Per-sample timezoneOffsetMinutes takes priority → request-level fallback → null.
    // Sleep metrics REQUIRE a timezone; non-sleep metrics fall back to UTC (0).
    const requestLevelTzOffset: number | undefined = options?.timezoneOffsetMinutes;

    // Process samples that passed privacy filtering
    for (const sample of samplesToProcess) {
      // Validate metric code
      // FAIL FAST: Reject unknown metric codes as sample-level failures
      if (!isHealthMetricCode(sample.metricCode)) {
        preValidationFailures.push({
          sourceId: sample.sourceId,
          sourceRecordId: sample.sourceRecordId,
          startAt: sample.startAt,
          error: `Invalid metric code: "${sample.metricCode}". Valid codes: ${HEALTH_METRIC_CODES.join(', ')}`,
          errorCode: 'INVALID_METRIC_CODE',
          retryable: false, // Client must fix the metric code
        });
        continue;
      }

      // GAP B FIX: Per-sample timezone resolution with sleep metric enforcement
      // Resolution order: per-sample TZ → request-level TZ → null
      // Sleep metrics (category 'sleep') REQUIRE a timezone offset.
      // Non-sleep metrics fall through to UTC (0) for backward compatibility.
      const perSampleTz: number | undefined = sample.timezoneOffsetMinutes;
      const resolvedTzOffset: number | null = perSampleTz ?? requestLevelTzOffset ?? null;

      const metricCategory = getMetricCategory(sample.metricCode as HealthMetricCode);
      const isSleepMetric = metricCategory === 'sleep';

      if (isSleepMetric && resolvedTzOffset === null) {
        // FAIL FAST: Sleep metrics without timezone → reject, don't silently default to UTC
        this.logger.warn('Sleep metric missing timezone offset - rejecting sample', {
          context: 'HealthSampleService.batchUpsertSamples',
          userId,
          metricCode: sample.metricCode,
          sourceRecordId: sample.sourceRecordId,
          action: 'REJECTING_SAMPLE_TIMEZONE_REQUIRED',
        });

        preValidationFailures.push({
          sourceId: sample.sourceId,
          sourceRecordId: sample.sourceRecordId,
          startAt: sample.startAt,
          error: `Sleep metric "${sample.metricCode}" requires a timezone offset. ` +
                 `Provide timezoneOffsetMinutes per-sample or X-Timezone-Offset header per-request.`,
          errorCode: 'TIMEZONE_REQUIRED',
          retryable: true, // Client can retry with timezone offset
        });
        continue;
      }

      // Persist per-sample TZ to database (null if only request-level was used)
      // Repository already handles this field as the 16th parameter in SQL
      const timezoneOffsetMin: number | null = resolvedTzOffset;

      // Base fields common to all sample types
      // DEFENSIVE: Lowercase sourceRecordId as second line of defense.
      // Primary normalization is in the Zod schema (health.contract.ts).
      // This ensures correctness even if a non-Zod-validated path is added.
      const baseSample = {
        userId,
        sourceId: sample.sourceId,
        sourceRecordId: sample.sourceRecordId.toLowerCase(),
        metricCode: sample.metricCode,
        startAt: new Date(sample.startAt),
        endAt: new Date(sample.endAt),
        durationSeconds: sample.durationSeconds ?? null,
        deviceId: sample.deviceId ?? null,
        externalUuid: sample.externalUuid ?? null,
        metadata: sample.metadata ?? undefined,
        requestId,
        // GAP B FIX: Persist resolved timezone offset per-sample
        // The repository SQL already has this as the 16th parameter with COALESCE
        timezoneOffsetMin,
      };

      // Handle category samples (sleep stages, etc.)
      // Schema now allows NULL for value/unit (migration 20260123000000)
      // valueKind discriminator enforced at DB level (migration 20260123200000)
      if (isCategorySample(sample)) {
        transformedSamples.push({
          ...baseSample,
          // valueKind discriminator - enforced by DB CHECK constraint
          valueKind: 'CATEGORY',
          // NULL for CATEGORY samples (no numeric value)
          // This is the correct representation per the discriminated union in health.contract.ts
          value: null,
          unit: null,
          // Pass through the category code
          categoryCode: sample.categoryCode,
        });
        continue;
      }

      // Handle numeric samples (heart rate, steps, etc.)
      // valueKind discriminator enforced at DB level (migration 20260123200000)
      if (isNumericSample(sample)) {
        // Get the valueKind from the contract sample (preserves SCALAR_NUM vs CUMULATIVE_NUM vs INTERVAL_NUM)
        const valueKind = sample.valueKind;

        // Try to normalize unit to canonical (returns null on failure)
        const normalized = tryNormalizeToCanonicalUnit(
          sample.metricCode,
          sample.value,
          sample.unit
        );

        // NO SILENT FALLBACKS - if normalization fails, reject the sample explicitly
        if (normalized === null) {
          this.logger.warn('Unit normalization failed - rejecting sample', {
            context: 'HealthSampleService.batchUpsertSamples',
            userId,
            metricCode: sample.metricCode,
            unit: sample.unit,
            sourceRecordId: sample.sourceRecordId,
            action: 'REJECTING_SAMPLE', // Clear action for observability
          });

          preValidationFailures.push({
            sourceId: sample.sourceId,
            sourceRecordId: sample.sourceRecordId,
            startAt: sample.startAt,
            error: `Unit normalization failed for metric "${sample.metricCode}" with unit "${sample.unit}". ` +
                   `Ensure the unit is valid for this metric type.`,
            errorCode: 'UNIT_NORMALIZATION_FAILED',
            retryable: false, // Client must fix the unit
          });
          continue;
        }

        // Normalization succeeded - use normalized values
        transformedSamples.push({
          ...baseSample,
          valueKind: valueKind,
          value: normalized.value,
          unit: normalized.unit,
          categoryCode: null, // Explicit null for numeric samples
        });
        continue;
      }

      // TypeScript exhaustiveness check - should never reach here
      // If we get here, the discriminated union is not exhaustive
      // This indicates a programming error (missing case in discriminated union)
      const exhaustiveCheck: never = sample;
      preValidationFailures.push({
        sourceId: (exhaustiveCheck as HealthSampleContract).sourceId,
        sourceRecordId: (exhaustiveCheck as HealthSampleContract).sourceRecordId,
        startAt: (exhaustiveCheck as HealthSampleContract).startAt,
        error: 'Unknown sample type encountered. This is a programming error.',
        errorCode: 'SERVER_ERROR',
        retryable: false,
      });
    }

    // Log pre-validation failures if any
    if (preValidationFailures.length > 0) {
      this.logger.warn('Pre-validation failures detected', {
        context: 'HealthSampleService.batchUpsertSamples',
        userId,
        requestId,
        preValidationFailureCount: preValidationFailures.length,
        validSampleCount: transformedSamples.length,
      });
    }

    const transformDurationMs = Date.now() - transformStartTime;

    // Use the new idempotency-aware method that tracks requests in HealthIngestRequest
    // TRUST BOUNDARY: payloadHash has already been validated by middleware
    // (validateBatchUpsertRequestWithHash), so we pass it through without recomputation.
    //
    // Previously, when all samples failed pre-validation, we returned a "virtual" result without
    // calling the repository. This broke request-level idempotency because no HealthIngestRequest
    // was created, meaning retry requests were not detected as duplicates.
    //
    // Now: Repository creates HealthIngestRequest for ALL requests (including empty batches)
    // and caches the response for replay. This ensures true request-level idempotency.
    //
    // NOTE: We pass only transformedSamples to the repository. Pre-validation failures are
    // merged with repository failures AFTER the call to ensure consistent response structure.

    if (transformedSamples.length === 0) {
      this.logger.warn('All samples failed pre-validation, proceeding with empty batch for idempotency tracking', {
        context: 'HealthSampleService.batchUpsertSamples',
        userId,
        requestId,
        totalSamples: samples.length,
        preValidationFailures: preValidationFailures.length,
      });
    }

    // STOP-SHIP #1 FIX: Convert deletions to PreciseDeletionInput for repository
    // Deletions are now passed to the repository and processed INSIDE the idempotency
    // boundary. The cached responseJson includes both sample results AND deletion results.
    // DEFENSIVE: Lowercase sourceRecordId for consistent DB lookups.
    // Primary normalization is in DeletionItemSchema (health.contract.ts).
    const precisionDeletions = deletions?.map(d =>
      new HealthSampleRepository.PreciseDeletionInput(
        d.sourceId,
        d.sourceRecordId.toLowerCase(),
        d.startAt ? new Date(d.startAt) : null,
        d.deletedAt ? new Date(d.deletedAt) : null
      )
    );

    // P0-A: TRANSACTIONAL OUTBOX PATTERN
    // Create callback that writes health.samples.changed event to outbox table
    // INSIDE the same transaction as the sample upsert. This prevents dual-write
    // inconsistencies where data is committed but the event is lost.
    //
    // The callback is only invoked for NEW requests (not cached replays) and
    // only when there are actual data changes. The event will be processed by
    // OutboxService → HealthProjectionCoordinatorService → projection handlers.
    // GAP B FIX: Explicit timezone offset handling — NO silent UTC fallback
    // Request-level offset from X-Timezone-Offset header (may be undefined).
    // Per-sample offsets are resolved earlier and stored in each sample's
    // timezoneOffsetMin field. This request-level value is used as the
    // fallback for samples that don't carry their own offset, and for
    // computing affected local dates in the outbox event payload.
    //
    // For non-sleep metrics: undefined request offset → use 0 (UTC) for backward compat.
    // For sleep metrics: both per-sample and request offset must be provided
    //   (enforced in the sample loop above via TIMEZONE_REQUIRED rejection).
    const requestTimezoneOffset = options?.timezoneOffsetMinutes;
    const timezoneOffsetMinutes = requestTimezoneOffset ?? 0;
    const timezoneExplicit = requestTimezoneOffset !== undefined;
    const outboxCallback = this.createOutboxCallback(
      userId,
      requestId,
      correlationId,
      deviceId,
      transformedSamples,
      timezoneOffsetMinutes,
      timezoneExplicit
    );

    const repoStartTime = Date.now();
    const repoResult = options?.mode === 'existing'
      ? await this.repository.batchUpsertWithExistingRequest(
          userId,
          transformedSamples,
          requestId,
          payloadHash,
          options.ingestRequestId,
          precisionDeletions,
          outboxCallback, // GAP A FIX: Queue workers now get atomic outbox events too
        )
      : await this.repository.batchUpsertWithIdempotency(
          userId,
          transformedSamples, // May be empty array - repository handles this correctly
          requestId,
          payloadHash,
          precisionDeletions, // STOP-SHIP #1 FIX: Pass deletions for unified idempotency
          outboxCallback // P0-A: Transactional outbox callback
        );
    const repoDurationMs = Date.now() - repoStartTime;

    // Merge all failures: privacy-blocked + pre-validation + repository failures
    // This ensures the complete set of failures is returned to the client
    // Order: privacy blocked first (user-controlled), then validation, then server errors
    const result: BatchUpsertResultWithIdempotency = {
      ...repoResult,
      failed: [...privacyBlockedFailures, ...preValidationFailures, ...repoResult.failed],
    };

    const totalDurationMs = Date.now() - totalStartTime;

    if (metricsEnabled) {
      const compressedBytes = requestMeta?.contentLengthBytes;
      const uncompressedBytes = requestMeta?.uncompressedBytes;
      const compressionRatio =
        compressedBytes !== undefined && uncompressedBytes
          ? Number((compressedBytes / uncompressedBytes).toFixed(4))
          : undefined;

      this.performanceMonitoring?.recordMetric(
        PerformanceMetricType.RESPONSE_TIME,
        'health.ingest.request.total_ms',
        totalDurationMs,
        'ms',
        metricsTags,
        {
          samplesReceived: samples.length,
          samplesAllowed: transformedSamples.length,
          privacyBlocked: privacyBlockedFailures.length,
          preValidationFailed: preValidationFailures.length,
          deletionsReceived: deletions?.length ?? 0,
          idempotencyStatus: repoResult.idempotencyStatus,
          privacyMs: privacyDurationMs,
          transformMs: transformDurationMs,
          repositoryMs: repoDurationMs,
          contentEncoding: requestMeta?.contentEncoding ?? 'identity',
          contentLengthBytes: compressedBytes,
          uncompressedBytes,
          compressionRatio,
        }
      );

      if (compressedBytes !== undefined) {
        this.performanceMonitoring?.recordMetric(
          PerformanceMetricType.NETWORK_IO,
          'health.ingest.request.body_bytes',
          compressedBytes,
          'bytes',
          metricsTags,
          {
            contentEncoding: requestMeta?.contentEncoding ?? 'identity',
            uncompressedBytes,
            compressionRatio,
          }
        );
      }

      this.logger.info('Health ingest request metrics', {
        context: 'HealthSampleService.batchUpsertSamples',
        event: 'health_ingest_request',
        totalMs: totalDurationMs,
        privacyMs: privacyDurationMs,
        transformMs: transformDurationMs,
        repositoryMs: repoDurationMs,
        samplesReceived: samples.length,
        samplesAllowed: transformedSamples.length,
        privacyBlocked: privacyBlockedFailures.length,
        preValidationFailed: preValidationFailures.length,
        deletionsReceived: deletions?.length ?? 0,
        successfulCount: result.metrics.successfulCount,
        failedCount: result.metrics.failedCount,
        deletedCount: result.metrics.deletedCount ?? 0,
        idempotencyStatus: result.idempotencyStatus,
        contentEncoding: requestMeta?.contentEncoding ?? 'identity',
        contentLengthBytes: compressedBytes,
        uncompressedBytes,
        compressionRatio,
        ...metricsTags,
      });
    }

    // Log based on whether this was a cached response or new processing
    // STOP-SHIP #1 FIX: Now includes deletion metrics in cached and new responses
    if (result.idempotencyStatus === 'CACHED') {
      this.logger.info('Returned cached response for duplicate request', {
        context: 'HealthSampleService.batchUpsertSamples',
        userId,
        requestId,
        correlationId,
        deviceId,
        idempotencyStatus: 'CACHED',
        // Include deletion info if present in cached response
        hasDeletions: !!result.deletions,
        deletedCount: result.metrics.deletedCount ?? 0,
      });
    } else {
      this.logger.info('Processed new request', {
        context: 'HealthSampleService.batchUpsertSamples',
        userId,
        requestId,
        correlationId,
        deviceId,
        idempotencyStatus: 'NEW',
        successCount: result.successful.length,
        failedCount: result.failed.length,
        // STOP-SHIP #1 FIX: Include deletion metrics
        deletionCount: deletions?.length ?? 0,
        deletedCount: result.metrics.deletedCount ?? 0,
      });
    }

    // P0-A COMPLETE: Legacy in-memory event emission has been removed.
    // All health events now go through transactional outbox (see createOutboxCallback above).
    // This ensures at-least-once delivery with idempotent processing (checkpoint + natural key upsert).

    return result;
  }

  // P0-A COMPLETE: maybeEmitHealthSamplesIngestedEvent() has been removed.
  // All health events now flow through the transactional outbox pattern.

  /**
   * Process a queued health ingest batch using an existing ingest request.
   *
   * Used by async worker jobs to reuse the request-level idempotency record.
   *
   * EDGE CASE 1 FIX: Now accepts timezoneOffsetMinutes propagated from the
   * original HTTP request's X-Timezone-Offset header through the BullMQ job
   * data. Without this, queued batches lose the request-level timezone context,
   * causing affectedLocalDates and timezoneExplicit in the outbox event to be
   * computed with UTC (offset 0) for non-sleep metrics.
   */
  async processQueuedBatch(params: {
    userId: string;
    samples: HealthSampleContract[];
    requestId: string;
    payloadHash: string;
    correlationId?: string;
    deviceId?: string;
    deletions?: DeletionItem[];
    ingestRequestId?: string;
    /** Request-level timezone offset propagated through queue job data */
    timezoneOffsetMinutes?: number;
  }): Promise<BatchUpsertResultWithIdempotency> {
    return this.batchUpsertSamples(
      params.userId,
      params.samples,
      params.requestId,
      params.payloadHash,
      params.correlationId,
      params.deviceId,
      params.deletions,
      {
        mode: 'existing',
        ingestRequestId: params.ingestRequestId,
        timezoneOffsetMinutes: params.timezoneOffsetMinutes,
      }
    );
  }

  /**
   * Get health samples for a user (excludes soft-deleted samples).
   *
   * Uses queryActiveByUserAndTimeRange which filters isDeleted=false.
   * This prevents soft-deleted samples from leaking into GET /samples responses.
   *
   * @param userId - User ID
   * @param startTime - Range start
   * @param endTime - Range end
   * @param metricCode - Optional metric filter
   * @param pagination - Pagination options
   * @returns Paginated samples (excludes soft-deleted)
   */
  async getSamples(
    userId: string,
    startTime: Date,
    endTime: Date,
    metricCode?: string,
    pagination?: { page: number; pageSize: number },
  ): Promise<PaginatedResponse<HealthSample>> {
    // to exclude soft-deleted samples from the response
    return this.repository.queryActiveByUserAndTimeRange(
      userId,
      startTime,
      endTime,
      metricCode,
      pagination,
    );
  }

  /**
   * Get health samples using cursor-based (keyset) pagination.
   *
   * PERFORMANCE:
   * - O(log n) via B-tree index traversal regardless of page depth
   * - No COUNT(*) query (uses limit+1 technique for hasMore detection)
   *
   * USAGE:
   * - First request: No cursor, returns first page
   * - Subsequent requests: Pass nextCursor from previous response
   * - Loop until hasMore is false
   *
   * @param userId - User ID (tenant isolation enforced via JWT)
   * @param startTime - Range start (inclusive)
   * @param endTime - Range end (inclusive)
   * @param limit - Maximum items per page (1-500, default 100)
   * @param cursor - Optional decoded cursor from previous page
   * @param metricCode - Optional metric code filter
   * @returns Cursor-paginated response with items and pagination metadata
   *
   * @example
   * ```typescript
   * // First page
   * const page1 = await service.getSamplesCursor(userId, start, end, 100);
   *
   * // Next page (if hasMore)
   * if (page1.pagination.hasMore && page1.pagination.nextCursor) {
   *   const decodedCursor = decodeHealthSampleCursor(page1.pagination.nextCursor);
   *   const page2 = await service.getSamplesCursor(userId, start, end, 100, decodedCursor);
   * }
   * ```
   */
  async getSamplesCursor(
    userId: string,
    startTime: Date,
    endTime: Date,
    limit: number = 100,
    cursor?: HealthSampleCursor,
    metricCode?: string,
  ): Promise<CursorPaginatedResponse<HealthSample>> {
    this.logger.debug('Getting samples with cursor pagination', {
      context: 'HealthSampleService.getSamplesCursor',
      userId,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      limit,
      hasCursor: !!cursor,
      metricCode,
    });

    return this.repository.querySamplesCursor(
      userId,
      startTime,
      endTime,
      limit,
      cursor,
      metricCode,
    );
  }

  /**
   * Get distinct metric codes for a user
   *
   * @param userId - User ID
   * @returns Array of metric codes
   */
  async getDistinctMetricCodes(userId: string): Promise<string[]> {
    return this.repository.getDistinctMetricCodes(userId);
  }

  /**
   * Get aggregated data for a metric
   *
   * @param userId - User ID
   * @param metricCode - Metric code
   * @param startTime - Range start
   * @param endTime - Range end
   * @param aggregationType - Aggregation type
   * @returns Aggregated result or null
   */
  async getAggregatedMetric(
    userId: string,
    metricCode: string,
    startTime: Date,
    endTime: Date,
    aggregationType: 'sum' | 'avg' | 'min' | 'max' | 'count',
  ) {
    return this.repository.aggregateSamples(
      userId,
      metricCode,
      startTime,
      endTime,
      aggregationType,
    );
  }

  /**
   * Process batch deletions from client.
   *
   * When HealthKit/Health Connect reports sample deletions, clients send the
   * deleted sourceRecordIds in the batch request's `deleted` array.
   *
   * ARCHITECTURE:
   * - Deletions are soft-deleted (isDeleted=true, deletedAt=now)
   * - Deletions are scoped by (userId, sourceId, sourceRecordId) to prevent cross-source contamination
   * - Idempotent: deleting an already-deleted sample is a no-op (success with alreadyDeleted flag)
   * - Not-found samples are reported but don't cause the entire batch to fail
   *
   * PRECISE DELETION MODE (new - recommended):
   * - When startAt is provided in deletion items, uses precise 4-column identity
   *   matching the DB unique constraint: (user_id, source_id, source_record_id, start_at)
   * - This ensures unambiguous deletion when multiple samples share (sourceId, sourceRecordId)
   *
   * LEGACY MODE (backward compatible):
   * - When startAt is NOT provided, deletes ALL samples matching (sourceId, sourceRecordId)
   * - Logs warning about potential over-deletion
   *
   * @param userId - User ID to scope deletions
   * @param deletions - Array of deletion items with sourceId, sourceRecordId, and optional startAt
   * @returns Batch deletion result with success/failure counts
   */
  async processDeletions(
    userId: string,
    deletions: DeletionItem[],
  ): Promise<BatchDeletionResult> {
    if (deletions.length === 0) {
      return {
        successful: [],
        failed: [],
        deletedCount: 0,
        alreadyDeletedCount: 0,
        notFoundCount: 0,
      };
    }

    // Count deletions with and without startAt for logging
    const withStartAt = deletions.filter(d => d.startAt).length;
    const withoutStartAt = deletions.length - withStartAt;

    this.logger.debug('Processing batch deletions', {
      context: 'HealthSampleService.processDeletions',
      userId,
      deletionCount: deletions.length,
      withPreciseStartAt: withStartAt,
      withLegacyMode: withoutStartAt,
    });

    // Convert to precise deletion inputs using repository's static class
    // PHASE 5 FIX: Pass client-supplied deletedAt for audit accuracy
    // DEFENSIVE: Lowercase sourceRecordId for consistent DB lookups.
    // Primary normalization is in DeletionItemSchema (health.contract.ts).
    const precisionDeletions = deletions.map(d =>
      new HealthSampleRepository.PreciseDeletionInput(
        d.sourceId,
        d.sourceRecordId.toLowerCase(),
        d.startAt ? new Date(d.startAt) : null,
        d.deletedAt ? new Date(d.deletedAt) : null
      )
    );

    const successful: BatchDeletionResult['successful'] = [];
    const failed: BatchDeletionResult['failed'] = [];
    let totalDeleted = 0;
    let totalAlreadyDeleted = 0;
    let totalNotFound = 0;

    try {
      // Use the precise deletion method that supports optional startAt
      const result = await this.repository.markSamplesDeletedPrecise(userId, precisionDeletions);

      totalDeleted = result.deletedCount;
      totalAlreadyDeleted = result.alreadyDeletedCount;
      totalNotFound = result.notFoundRecordIds.length;

      // Map results back to individual deletion items
      // The repository returns composite IDs with startAt when provided
      const notFoundSet = new Set(result.notFoundRecordIds);
      const alreadyDeletedSet = new Set(result.alreadyDeletedRecordIds);

      // P0-G FIX: Build lookup map for deleted sample details
      // This enables enriching successful responses with endAt and metricCode
      const deletedDetailsMap = new Map<string, { endAt: Date; metricCode: string }>();
      for (const detail of result.deletedSampleDetails) {
        deletedDetailsMap.set(detail.compositeId, {
          endAt: detail.endAt,
          metricCode: detail.metricCode,
        });
      }

      for (const deletion of deletions) {
        // Build composite ID matching the repository's format
        // DEFENSIVE: Lowercase sourceRecordId for consistent key matching.
        // Primary normalization is in the Zod schema (DeletionItemSchema).
        const normalizedRecordId = deletion.sourceRecordId.toLowerCase();
        const compositeId = `${deletion.sourceId}:${normalizedRecordId}` +
          (deletion.startAt ? `:${new Date(deletion.startAt).toISOString()}` : '');

        if (notFoundSet.has(compositeId)) {
          // Include startAt in failed response for precise client-side mapping
          failed.push({
            sourceId: deletion.sourceId,
            sourceRecordId: deletion.sourceRecordId,
            // PHASE 5: Include startAt when present for precise deletion queue mapping
            ...(deletion.startAt ? { startAt: deletion.startAt } : {}),
            error: 'Sample not found (may have been purged)',
            errorCode: 'DELETE_NOT_FOUND',
            retryable: false,
          });
        } else {
          // P0-G FIX: Look up deletion details to include endAt and metricCode
          const details = deletedDetailsMap.get(compositeId);

          // Include startAt in successful response for precise client-side mapping
          successful.push({
            sourceId: deletion.sourceId,
            sourceRecordId: deletion.sourceRecordId,
            // PHASE 5: Include startAt when present for precise deletion queue mapping
            // This enables the client to map results using the 4-column composite key
            // (sourceId, sourceRecordId, startAt) when available
            ...(deletion.startAt ? { startAt: deletion.startAt } : {}),
            // P0-G FIX: Include endAt and metricCode for precise cache invalidation
            ...(details ? {
              endAt: details.endAt.toISOString(),
              metricCode: details.metricCode,
            } : {}),
            alreadyDeleted: alreadyDeletedSet.has(compositeId),
          });
        }
      }

    } catch (error) {
      this.logger.error('Error processing batch deletions', {
        context: 'HealthSampleService.processDeletions',
        userId,
        count: deletions.length,
        error: error instanceof Error ? error.message : String(error),
      });

      // Mark all deletions as failed
      for (const deletion of deletions) {
        failed.push({
          sourceId: deletion.sourceId,
          sourceRecordId: deletion.sourceRecordId,
          // PHASE 5: Include startAt when present for precise deletion queue mapping
          ...(deletion.startAt ? { startAt: deletion.startAt } : {}),
          error: `Deletion failed: ${error instanceof Error ? error.message : String(error)}`,
          errorCode: 'DELETE_FAILED',
          retryable: true,
        });
      }
    }

    this.logger.info('Batch deletions processed', {
      context: 'HealthSampleService.processDeletions',
      userId,
      requested: deletions.length,
      deleted: totalDeleted,
      alreadyDeleted: totalAlreadyDeleted,
      notFound: totalNotFound,
      failed: failed.length,
      preciseMode: withStartAt,
      legacyMode: withoutStartAt,
    });

    return {
      successful,
      failed,
      deletedCount: totalDeleted,
      alreadyDeletedCount: totalAlreadyDeleted,
      notFoundCount: totalNotFound,
    };
  }
}
