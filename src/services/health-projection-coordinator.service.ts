/**
 * Health Projection Coordinator Service
 *
 * Implements the fanout pattern for health event processing with per-projection
 * checkpoint tracking. This service routes health.samples.changed events to
 * multiple projection handlers with independent retry capability.
 *
 * - Bypasses DomainEventService (which swallows errors) for at-least-once delivery
 * - Per-projection checkpoint tracking: completed projections skip on retry
 * - Synchronous execution: ordering guarantees, no race conditions
 * - Fail-fast: first handler failure throws, subsequent handlers run on retry
 *
 * PROJECTION HANDLERS:
 * - health-rollup: Updates daily/weekly numeric aggregates
 * - sleep-summary: Updates sleep stage analysis and scoring
 * - telemetry-cache: Invalidates session telemetry caches
 *
 * @module HealthProjectionCoordinatorService
 */

import { OutboxEvent, HealthSample } from '@prisma/client';
import { LoggerService } from './logger.service';
import {
  ProjectionCheckpointRepository,
  CheckpointSummary,
} from '../repositories/projection-checkpoint.repository';
import { SessionTelemetryCacheRepository } from '../repositories/session-telemetry-cache.repository';
import { SessionRepository } from '../repositories/session.repository';
import { HealthSamplesChangedEvent } from '../events/domain.events';
import { HealthRollupDayRepository } from '../repositories/health-rollup-day.repository';
import { SleepNightSummaryRepository } from '../repositories/sleep-night-summary.repository';
import { SessionImpactSummaryRepository } from '../repositories/session-impact-summary.repository';
import { HealthSampleRepository } from '../repositories/health-sample.repository';
import { UserHealthWatermarkRepository } from '../repositories/user-health-watermark.repository';
import { HealthAggregationService, AggregationInput } from './health-aggregation.service';
import { ProductImpactRollupRepository } from '../repositories/product-impact-rollup.repository';
import {
  computeProductImpactAggregate,
  type ReliableImpactInput,
} from './product-impact-compute';
import {
  getMetricDefinition,
  getValueKind,
  getExpectedSamplesPerHour,
  isHealthMetricCode,
  toLocalDate,
  getNightWindowUtc,
  getSleepNightAnchorDate,
  clusterSleepSamples,
  computeStageAvailability,
  getDurationByStage,
  selectCanonicalSource,
  computeDominantOffset,
  widenedLocalDateToUtcRange,
  widenedNightWindowUtc,
  type HealthMetricCode,
  type SleepSampleInput,
  type OffsetRange,
} from '@shared/contracts';

// Constants

/**
 * Default timeout for projection handlers in milliseconds.
 *
 * P0-G FIX: Prevents slow or stuck handlers from blocking the outbox poll loop.
 * Individual handlers can override via the optional timeoutMs field.
 *
 * 30 seconds is generous - most projections complete in <1s.
 * Can be overridden via HEALTH_PROJECTION_TIMEOUT_MS environment variable.
 */
const DEFAULT_PROJECTION_TIMEOUT_MS = parseInt(
  process.env.HEALTH_PROJECTION_TIMEOUT_MS ?? '30000',
  10
);

/**
 * Sentinel value returned when a projection times out.
 * Used by withTimeout helper to distinguish timeout from other errors.
 */
const TIMEOUT_SENTINEL = Symbol('PROJECTION_TIMEOUT');

/**
 * GAP D FIX: Threshold for switching from fine-grained (per-session) to
 * coarse-grained (per-user) telemetry cache invalidation.
 *
 * When the affected time range exceeds this threshold, the handler uses a
 * single O(1) bulk UPDATE instead of iterating O(N sessions) individually.
 * This prevents retry storms during 90-day health backfills.
 *
 * Default: 24 hours. Configurable via HEALTH_TELEMETRY_COARSE_THRESHOLD_HOURS.
 */
const COARSE_INVALIDATION_THRESHOLD_MS = parseInt(
  process.env.HEALTH_TELEMETRY_COARSE_THRESHOLD_HOURS ?? '24',
  10
) * 60 * 60 * 1000;

/**
 * GAP D FIX: Threshold for switching to coarse invalidation based on sample count.
 *
 * When sampleCount + deletedCount exceeds this threshold, the handler uses
 * coarse user-level invalidation regardless of time range width.
 * This prevents O(N sessions) iteration during large backfills that happen
 * to fall within a narrow time window (< COARSE_INVALIDATION_THRESHOLD_MS).
 *
 * Default: 5000. Configurable via HEALTH_TELEMETRY_COARSE_SAMPLE_THRESHOLD.
 */
const COARSE_INVALIDATION_SAMPLE_THRESHOLD = parseInt(
  process.env.HEALTH_TELEMETRY_COARSE_SAMPLE_THRESHOLD ?? '5000',
  10
);

/**
 * GAP E FIX: Default lease duration for projection checkpoints in milliseconds.
 *
 * A handler must complete within this window or the lease is considered expired
 * and can be taken over by a retry. This prevents a stale PROCESSING checkpoint
 * from blocking all retries permanently.
 *
 * Default: 60 seconds. Configurable via HEALTH_PROJECTION_LEASE_MS.
 * Should be >= DEFAULT_PROJECTION_TIMEOUT_MS (30s) to avoid premature lease expiry.
 */
const DEFAULT_PROJECTION_LEASE_MS = parseInt(
  process.env.HEALTH_PROJECTION_LEASE_MS ?? '60000',
  10
);

// Paging Helpers

/**
 * Maximum number of pages to fetch when iterating paginated sample queries.
 *
 * Each page is 10,000 rows, so this caps at 100,000 samples per query.
 * This prevents unbounded work during extreme backfills while supporting
 * dense users (e.g., 1-second heart rate over multiple days).
 *
 * If truncated, the handler logs a warning and proceeds with partial data.
 * This is a conscious trade-off: partial aggregation > no aggregation.
 */
const MAX_SAMPLE_PAGES = 10;

/**
 * Page size for sample fetch queries within projection handlers.
 */
const SAMPLE_PAGE_SIZE = 10_000;

/**
 * Result of a multi-page sample fetch.
 */
interface PaginatedFetchResult {
  readonly items: HealthSample[];
  /** True if more data exists beyond the max page budget */
  readonly truncated: boolean;
  readonly totalFetched: number;
}

/**
 * Fetch all active (non-deleted) samples across multiple pages.
 *
 * Iterates until hasMore=false or maxPages is reached. This prevents the
 * silent truncation bug where a single 10k-page query misses data for
 * dense users or backfill scenarios.
 *
 * SAFETY GUARDS:
 * - Bounded by MAX_SAMPLE_PAGES (default 10 → max 100k samples)
 * - Each page uses the repository's standard offset pagination
 * - If truncated, caller should log a warning (partial data, not wrong data)
 *
 * @param sampleRepo - HealthSampleRepository instance
 * @param userId - User ID for tenant isolation
 * @param startUtc - UTC range start (inclusive)
 * @param endUtc - UTC range end (exclusive, half-open)
 * @param metricCode - Optional metric code filter (single string, array for IN, or undefined for all)
 * @param maxPages - Maximum pages to fetch (default MAX_SAMPLE_PAGES)
 * @returns Items array, truncation flag, and total count
 */
async function fetchAllActivePages(
  sampleRepo: HealthSampleRepository,
  userId: string,
  startUtc: Date,
  endUtc: Date,
  metricCode?: string | readonly string[],
  maxPages: number = MAX_SAMPLE_PAGES
): Promise<PaginatedFetchResult> {
  const allItems: HealthSample[] = [];
  let page = 1;

  while (page <= maxPages) {
    const result = await sampleRepo.queryActiveByUserAndTimeRange(
      userId,
      startUtc,
      endUtc,
      metricCode,
      { page, pageSize: SAMPLE_PAGE_SIZE }
    );
    allItems.push(...result.items);

    if (!result.hasMore) {
      break;
    }
    page++;
  }

  return {
    items: allItems,
    truncated: page > maxPages,
    totalFetched: allItems.length,
  };
}

// Watermark Freshness Guard

/**
 * ISSUE 6 FIX: Assert that the handler's data view is at least as fresh as the
 * event's committed state. This prevents stale derived data when the handler
 * reads from a replica that hasn't caught up, or during split-brain scenarios.
 *
 * CONTRACT:
 *   currentWatermark >= payload.minRequiredSeq
 *     → Data includes at least the mutations from this event. Safe to proceed.
 *   currentWatermark < payload.minRequiredSeq
 *     → Stale data view. Throw to defer for outbox retry.
 *   minRequiredSeq is undefined or 0
 *     → Backward-compat (old events) or no-op ingest. Skip check.
 *   currentWatermark is null
 *     → Watermark row does not exist despite event claiming mutations committed.
 *       This is a consistency error — throw to surface it.
 *
 * @param currentWatermark - Latest watermark from getSequenceNumber()
 * @param payload - The event payload (contains minRequiredSeq)
 * @param handlerName - Handler name for error messages
 * @throws If watermark is stale or missing when expected
 */
function assertWatermarkFreshness(
  currentWatermark: bigint | null,
  payload: HealthSamplesChangedPayload,
  handlerName: string
): void {
  // Backward compat: old events without minRequiredSeq, or no-op ingests (seq=0/"0")
  if (payload.minRequiredSeq == null || payload.minRequiredSeq === 0 || payload.minRequiredSeq === '0') {
    return;
  }

  // Watermark row must exist if the event claims mutations committed
  if (currentWatermark == null) {
    throw new Error(
      `${handlerName}: WATERMARK_MISSING — event claims minRequiredSeq=${payload.minRequiredSeq} ` +
      `but no watermark row exists for userId=${payload.userId}. ` +
      `This indicates a data consistency issue. Will retry via outbox.`
    );
  }

  // Compare using BigInt for precision safety (Number() loses precision beyond 2^53).
  // BigInt() accepts both string and number inputs for backward compat with in-flight events.
  const requiredSeq = BigInt(payload.minRequiredSeq);
  if (currentWatermark < requiredSeq) {
    throw new Error(
      `${handlerName}: WATERMARK_STALE — currentWatermark=${currentWatermark} < ` +
      `minRequiredSeq=${payload.minRequiredSeq} for userId=${payload.userId}. ` +
      `Data view is behind the event's committed state (possible replica lag). Will retry via outbox.`
    );
  }
}

// Types

/**
 * Payload extracted from health.samples.changed outbox event.
 *
 * This interface represents the data passed to projection handlers.
 * It's extracted from the outbox event's payload.data field.
 */
export interface HealthSamplesChangedPayload {
  userId: string;
  requestId: string;
  correlationId: string;
  deviceId?: string;
  sampleCount: number;
  deletedCount: number;
  hasDeletions: boolean;
  metricCodes: string[];
  affectedLocalDates: string[];
  rangeStartMs: number;
  rangeEndMs: number;
  timezoneOffsetMinutes?: number;
  /**
   * Whether the timezone offset was explicitly provided (per-sample or request-level),
   * not silently defaulted to UTC (0).
   * Downstream sleep projections can use this to assess local date confidence.
   */
  timezoneExplicit?: boolean;
  /**
   * Range of per-sample timezone offsets in this batch.
   *
   * When min === max (common case), all samples share one offset — handlers
   * use the existing fast path with zero behavior change.
   *
   * When min !== max (travel, DST, multi-device), handlers widen their UTC
   * query range to cover all offsets, then filter in-memory by per-sample TZ.
   *
   * Optional for backward compatibility with in-flight outbox events.
   * Absent offsetRange is treated as { min: timezoneOffsetMinutes, max: timezoneOffsetMinutes }.
   */
  offsetRange?: { min: number; max: number };
  /**
   * Watermark sequence number after all mutations in this event committed.
   * Used by projectors for watermark-based staleness detection:
   * - If derivedRow.sourceSeq >= currentWatermarkSeq → already fresh, skip
   * - If derivedRow.sourceSeq < currentWatermarkSeq → stale, recompute
   *
   * Serialized as string for BigInt precision safety (JSON has no BigInt type).
   * Number values accepted for backward compatibility with in-flight events.
   * Comparison MUST use BigInt(): BigInt(minRequiredSeq) for correct ordering.
   *
   * Optional for backward compatibility with events emitted before this field existed.
   */
  minRequiredSeq?: number | string;
}

/**
 * Handler interface for health projections.
 *
 * Each projection implements this interface to receive health data changes.
 */
export interface HealthProjectionHandler {
  /**
   * Unique name for this projection (used as checkpoint key).
   * Must be stable across restarts.
   */
  name: string;

  /**
   * P0-G FIX: Optional per-handler timeout in milliseconds.
   * If not specified, uses DEFAULT_PROJECTION_TIMEOUT_MS (30s).
   * Set to 0 to disable timeout (not recommended in production).
   */
  timeoutMs?: number;

  /**
   * FINDING 2 FIX: Optional dependency declarations.
   *
   * Names of projections that MUST complete successfully (COMPLETED or SKIPPED)
   * in the current fanout before this handler is executed. If any dependency
   * is FAILED in the current fanout, this handler is skipped and marked FAILED
   * with reason "dependency_failed".
   *
   * This prevents stale-data consumption: e.g., product-impact depends on
   * session-impact and must not run when session-impact failed, because the
   * session-impact data it reads would be stale. On retry, both handlers
   * re-run in order.
   *
   * Optional for backward compatibility — handlers without dependsOn run
   * unconditionally (existing P0-B behavior preserved).
   */
  dependsOn?: readonly string[];

  /**
   * Process a health samples changed event.
   *
   * @param payload - The event payload
   * @throws If processing fails (will mark checkpoint as FAILED)
   */
  handle(payload: HealthSamplesChangedPayload): Promise<void>;
}

/**
 * Result of a single projection execution.
 */
export interface ProjectionExecutionResult {
  name: string;
  status: 'COMPLETED' | 'SKIPPED' | 'FAILED';
  error?: string;
  durationMs?: number;
}

/**
 * Result of processing all projections for an event.
 */
export interface ProjectionFanoutResult {
  eventId: string;
  allCompleted: boolean;
  anyFailed: boolean;
  failedProjections: string[];
  results: ProjectionExecutionResult[];
  totalDurationMs: number;
}

// Service Implementation

/**
 * Coordinator for health projection fanout.
 *
 * USAGE:
 * 1. Register projection handlers during bootstrap
 * 2. OutboxService routes health.samples.changed events to this service
 * 3. Service executes handlers with checkpoint tracking
 * 4. On retry, completed handlers are skipped
 */
export class HealthProjectionCoordinatorService {
  private readonly projections: HealthProjectionHandler[] = [];

  constructor(
    private readonly checkpointRepository: ProjectionCheckpointRepository,
    private readonly logger: LoggerService
  ) {}

  /**
   * Execute a promise with a timeout guard.
   *
   * P0-G FIX: Prevents stuck handlers from blocking the entire outbox poll loop.
   *
   * IMPORTANT: The original promise continues running even after timeout.
   * This is acceptable because:
   * - The checkpoint is marked FAILED, so the handler will be retried
   * - If the original handler eventually completes, the checkpoint status
   *   remains FAILED (no race condition with stale lock recovery)
   *
   * @param promise - The promise to execute
   * @param timeoutMs - Timeout in milliseconds
   * @returns The promise result or TIMEOUT_SENTINEL
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<T | typeof TIMEOUT_SENTINEL> {
    // If timeout is 0 or negative, don't apply timeout (for testing)
    if (timeoutMs <= 0) {
      return promise;
    }

    let timeoutId: NodeJS.Timeout;
    const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
      timeoutId = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
    });

    try {
      const result = await Promise.race([promise, timeoutPromise]);
      return result;
    } finally {
      // Clean up timeout to prevent memory leaks
      clearTimeout(timeoutId!);
    }
  }

  /**
   * Register a projection handler.
   *
   * Called during bootstrap to add projection handlers.
   * Handler names must be unique (duplicates are rejected).
   *
   * @param handler - The projection handler to register
   * @throws If handler with same name is already registered
   */
  registerProjection(handler: HealthProjectionHandler): void {
    const existing = this.projections.find((p) => p.name === handler.name);
    if (existing) {
      throw new Error(`Projection handler '${handler.name}' is already registered`);
    }

    this.projections.push(handler);
    this.logger.info('Registered health projection handler', {
      context: 'HealthProjectionCoordinatorService.registerProjection',
      projectionName: handler.name,
      totalRegistered: this.projections.length,
    });
  }

  /**
   * Get list of registered projection names.
   */
  getRegisteredProjections(): string[] {
    return this.projections.map((p) => p.name);
  }

  /**
   * Process a health.samples.changed event through all projections.
   *
   * EXECUTION MODEL:
   * - Projections are executed sequentially (ordering guarantees)
   * - Each projection has independent checkpoint tracking
   * - COMPLETED checkpoints are skipped (idempotent-replay semantics, at-least-once delivery)
   * - First FAILED checkpoint throws, stopping execution
   * - On retry, only PENDING/FAILED checkpoints are processed
   *
   * @param event - The outbox event
   * @param payload - The extracted event payload
   * @returns Fanout result with status of each projection
   * @throws If any projection fails (after updating checkpoint to FAILED)
   */
  async processHealthSamplesChanged(
    event: OutboxEvent,
    payload: HealthSamplesChangedPayload
  ): Promise<ProjectionFanoutResult> {
    const startTime = Date.now();
    const results: ProjectionExecutionResult[] = [];
    const failedProjections: string[] = [];

    this.logger.info('Processing health.samples.changed through projection coordinator', {
      context: 'HealthProjectionCoordinatorService.processHealthSamplesChanged',
      eventId: event.id,
      userId: payload.userId,
      requestId: payload.requestId,
      sampleCount: payload.sampleCount,
      deletedCount: payload.deletedCount,
      metricCodes: payload.metricCodes,
      affectedLocalDates: payload.affectedLocalDates,
      projectionCount: this.projections.length,
    });

    for (const projection of this.projections) {
      const projectionStartTime = Date.now();

      // FINDING 2 FIX: Dependency gating.
      // Before executing a handler, verify all declared dependencies completed
      // successfully in this fanout. If any dependency failed, skip this handler
      // and mark FAILED — the outbox retry will re-run both in order.
      // This prevents product-impact from reading stale session-impact data
      // when session-impact failed and hasn't been retried yet.
      if (projection.dependsOn && projection.dependsOn.length > 0) {
        const unsatisfiedDeps = projection.dependsOn.filter(
          (dep) => failedProjections.includes(dep)
        );

        if (unsatisfiedDeps.length > 0) {
          const errorMsg =
            `Projection '${projection.name}' skipped: dependency failed ` +
            `(${unsatisfiedDeps.join(', ')}). Will retry when dependencies succeed.`;

          this.logger.warn('Projection skipped: dependency failed in current fanout', {
            context: 'HealthProjectionCoordinatorService.processHealthSamplesChanged',
            eventId: event.id,
            projectionName: projection.name,
            declaredDependencies: projection.dependsOn,
            unsatisfiedDependencies: unsatisfiedDeps,
          });

          results.push({
            name: projection.name,
            status: 'FAILED',
            error: errorMsg,
            durationMs: Date.now() - projectionStartTime,
          });
          failedProjections.push(projection.name);
          continue;
        }
      }

      try {
        // GAP E FIX: Lease-based concurrency control.
        // Replaces the previous findByEventAndProjection + markProcessing two-step
        // with an atomic tryAcquireProjectionLease that prevents concurrent duplicate
        // handlers. If another worker is actively processing this projection (fresh
        // lease), we SKIP instead of racing.
        const leaseResult = await this.checkpointRepository.tryAcquireProjectionLease(
          event.id,
          projection.name,
          DEFAULT_PROJECTION_LEASE_MS
        );

        if (!leaseResult.acquired) {
          if (leaseResult.existingStatus === 'COMPLETED') {
            // Already done by a previous run — safe to skip
            this.logger.debug('Projection skipped: already completed', {
              context: 'HealthProjectionCoordinatorService.processHealthSamplesChanged',
              eventId: event.id,
              projectionName: projection.name,
              existingStatus: leaseResult.existingStatus,
            });
            results.push({
              name: projection.name,
              status: 'SKIPPED',
              durationMs: Date.now() - projectionStartTime,
            });
          } else {
            // This projection is NOT done — the lease holder may still be running
            // or may have crashed with a fresh lease. We MUST NOT treat this as
            // completed, otherwise the outbox event gets marked COMPLETED and
            // this projection will never run if the lease holder crashes.
            //
            // Report as FAILED in the fanout result to trigger outbox retry.
            // DO NOT call markFailed — that would clear the active lease.
            // The outbox retry (with exponential backoff) will re-attempt after
            // the lease expires, at which point tryAcquireProjectionLease will
            // either find COMPLETED (skip) or take over the expired lease.
            this.logger.warn('Projection deferred: lease held by another handler', {
              context: 'HealthProjectionCoordinatorService.processHealthSamplesChanged',
              eventId: event.id,
              projectionName: projection.name,
              existingStatus: leaseResult.existingStatus,
              leaseDurationMs: DEFAULT_PROJECTION_LEASE_MS,
            });
            results.push({
              name: projection.name,
              status: 'FAILED',
              error: `Projection '${projection.name}' deferred: lease held by another handler (status: ${leaseResult.existingStatus}). Will retry after lease expires.`,
              durationMs: Date.now() - projectionStartTime,
            });
            failedProjections.push(projection.name);
          }
          continue;
        }

        // Lease acquired — execute handler with timeout guard
        const timeoutMs = projection.timeoutMs ?? DEFAULT_PROJECTION_TIMEOUT_MS;
        const handleResult = await this.withTimeout(
          projection.handle(payload),
          timeoutMs
        );

        // GAP E FIX: On timeout, do NOT call markFailed.
        // Leave checkpoint in PROCESSING state with the lease. On retry,
        // tryAcquireProjectionLease will:
        // - SKIP if lease is fresh (original handler may still be running)
        // - TAKE OVER if lease expired (original handler crashed/hung)
        if (handleResult === TIMEOUT_SENTINEL) {
          this.logger.warn('Projection timed out, leaving lease active for concurrency guard', {
            context: 'HealthProjectionCoordinatorService.processHealthSamplesChanged',
            eventId: event.id,
            projectionName: projection.name,
            timeoutMs,
            leaseDurationMs: DEFAULT_PROJECTION_LEASE_MS,
          });
          results.push({
            name: projection.name,
            status: 'FAILED',
            error: `Projection '${projection.name}' timed out after ${timeoutMs}ms (handler may still be running, lease active)`,
            durationMs: Date.now() - projectionStartTime,
          });
          failedProjections.push(projection.name);
          // DO NOT call markFailed — checkpoint stays PROCESSING with active lease
          continue;
        }

        // Mark as COMPLETED (also clears lease)
        await this.checkpointRepository.markCompleted(event.id, projection.name);

        results.push({
          name: projection.name,
          status: 'COMPLETED',
          durationMs: Date.now() - projectionStartTime,
        });

        this.logger.info('Projection completed successfully', {
          context: 'HealthProjectionCoordinatorService.processHealthSamplesChanged',
          eventId: event.id,
          projectionName: projection.name,
          durationMs: Date.now() - projectionStartTime,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Mark as FAILED (also clears lease — allows retry to acquire new lease)
        try {
          await this.checkpointRepository.markFailed(event.id, projection.name, errorMessage);
        } catch (markFailedError) {
          // If markFailed itself fails (e.g., no existing checkpoint), log and continue.
          // The lease will eventually expire and recoverStaleProcessing will clean up.
          this.logger.error('Failed to mark projection as FAILED', {
            context: 'HealthProjectionCoordinatorService.processHealthSamplesChanged',
            eventId: event.id,
            projectionName: projection.name,
            originalError: errorMessage,
            markFailedError: markFailedError instanceof Error ? markFailedError.message : String(markFailedError),
          });
        }

        results.push({
          name: projection.name,
          status: 'FAILED',
          error: errorMessage,
          durationMs: Date.now() - projectionStartTime,
        });
        failedProjections.push(projection.name);

        this.logger.error('Projection failed', {
          context: 'HealthProjectionCoordinatorService.processHealthSamplesChanged',
          eventId: event.id,
          projectionName: projection.name,
          error: errorMessage,
          durationMs: Date.now() - projectionStartTime,
        });

        // P0-B COMPLIANCE: Continue to next projection even on failure.
        // Each projection has independent checkpoint tracking, so:
        // - Completed projections are skipped on retry (idempotent-replay semantics)
        // - Failed projections are retried independently
        // - This allows telemetry-cache invalidation to succeed even if rollup fails
        // DO NOT ADD break HERE - violates internal design spec P0-B independent retry requirement
      }
    }

    const totalDurationMs = Date.now() - startTime;
    const allCompleted = results.every((r) => r.status === 'COMPLETED' || r.status === 'SKIPPED');

    const result: ProjectionFanoutResult = {
      eventId: event.id,
      allCompleted,
      anyFailed: failedProjections.length > 0,
      failedProjections,
      results,
      totalDurationMs,
    };

    this.logger.info('Projection fanout completed', {
      context: 'HealthProjectionCoordinatorService.processHealthSamplesChanged',
      eventId: event.id,
      allCompleted,
      failedProjections,
      resultCount: results.length,
      totalDurationMs,
    });

    return result;
  }

  /**
   * Get checkpoint summary for an event.
   *
   * Useful for debugging and monitoring.
   *
   * @param eventId - The outbox event ID
   * @returns Summary of checkpoint statuses
   */
  async getEventStatus(eventId: string): Promise<CheckpointSummary> {
    return this.checkpointRepository.getSummary(eventId);
  }

  /**
   * Recover stale processing checkpoints.
   *
   * Should be called periodically (e.g., before each outbox poll cycle)
   * to recover from worker crashes.
   *
   * @param staleThresholdMinutes - Minutes after which PROCESSING is considered stale
   * @returns Number of recovered checkpoints
   */
  async recoverStaleCheckpoints(staleThresholdMinutes: number = 5): Promise<number> {
    const recovered = await this.checkpointRepository.recoverStaleProcessing(staleThresholdMinutes);

    if (recovered > 0) {
      this.logger.info('Recovered stale projection checkpoints', {
        context: 'HealthProjectionCoordinatorService.recoverStaleCheckpoints',
        recovered,
        staleThresholdMinutes,
      });
    }

    return recovered;
  }
}

// Placeholder Projection Handlers (No-Op for P0)

/**
 * Health Rollup Projection Handler (Phase 1 — Real Implementation)
 *
 * Synchronously computes daily numeric aggregates per metric when
 * health.samples.changed events arrive. Writes to user_health_rollup_day.
 *
 * AGGREGATION STRATEGY (delegated to HealthAggregationService.aggregate):
 *   SCALAR_NUM → avg/min/max/count, sumSq for variance
 *   CUMULATIVE_NUM → sum(delta)/count
 *   INTERVAL_NUM → sum/avg/min/max/count
 *   CATEGORY → skipped (handled by SleepSummaryProjectionHandler)
 *
 * INVARIANTS:
 *   - Idempotent: upsert on (userId, metricCode, dayUtc)
 *   - Empty day → status='NO_DATA'
 *   - Fail-fast on any DB/aggregation error
 */
export class HealthRollupProjectionHandler implements HealthProjectionHandler {
  readonly name = 'health-rollup';

  constructor(
    private readonly logger: LoggerService,
    private readonly aggregationService: HealthAggregationService,
    private readonly rollupRepo: HealthRollupDayRepository,
    private readonly sampleRepo: HealthSampleRepository,
    private readonly watermarkRepo: UserHealthWatermarkRepository
  ) {}

  async handle(payload: HealthSamplesChangedPayload): Promise<void> {
    // FAIL-FAST: Dependencies are required
    if (!this.rollupRepo || !this.sampleRepo || !this.watermarkRepo || !this.aggregationService) {
      throw new Error(
        'HealthRollupProjectionHandler: MISCONFIGURATION — registered without required dependencies'
      );
    }

    const startTime = Date.now();
    const offsetMinutes = payload.timezoneOffsetMinutes ?? 0;
    // Preserve null distinction: undefined = not provided (null in DB), 0 = explicit UTC
    const rollupTimezoneOffsetMin = payload.timezoneOffsetMinutes ?? null;

    // MULTI-OFFSET FIX: Extract offsetRange with backward-compat fallback.
    // When absent (old events), treat as uniform single-offset batch.
    const offsetRange: OffsetRange = payload.offsetRange ?? { min: offsetMinutes, max: offsetMinutes };
    const isMultiOffset = offsetRange.min !== offsetRange.max;

    // Read current watermark for sourceWatermark tagging
    const currentWatermark = await this.watermarkRepo.getSequenceNumber(payload.userId);

    // ISSUE 6 FIX: Enforce watermark freshness before computing derived data.
    // Throws if data view is behind the event's committed state.
    assertWatermarkFreshness(currentWatermark, payload, 'HealthRollupProjectionHandler');

    let processedCount = 0;
    let noDataCount = 0;
    let truncatedEmptyCount = 0;
    let globalFetchTruncated = false;
    let globalFetchedSamples = 0;
    let queriesEliminated = 0;

    const validMetricCodes: Array<{ metricCode: HealthMetricCode; valueKind: ReturnType<typeof getValueKind> }> = [];
    for (const metricCode of payload.metricCodes) {
      // Validate metric code
      if (!isHealthMetricCode(metricCode)) {
        this.logger.warn('HealthRollupProjectionHandler: unknown metric code, skipping', {
          context: 'HealthRollupProjectionHandler.handle',
          userId: payload.userId,
          metricCode,
        });
        continue;
      }

      // Skip CATEGORY metrics — they're handled by SleepSummaryProjectionHandler
      const valueKind = getValueKind(metricCode);
      if (valueKind === 'CATEGORY') {
        continue;
      }
      validMetricCodes.push({ metricCode, valueKind });
    }

    if (validMetricCodes.length === 0 || payload.affectedLocalDates.length === 0) {
      this.logger.info('HealthRollupProjectionHandler: completed', {
        context: 'HealthRollupProjectionHandler.handle',
        userId: payload.userId,
        processedCount,
        noDataCount,
        metricCount: payload.metricCodes.length,
        dateCount: payload.affectedLocalDates.length,
        isMultiOffset,
        durationMs: Date.now() - startTime,
      });
      return;
    }

    const dateWindows = payload.affectedLocalDates.map((dateStr) => {
      let rangeStartUtc: Date;
      let rangeEndUtc: Date;
      if (isMultiOffset) {
        const widened = widenedLocalDateToUtcRange(dateStr, offsetRange.min, offsetRange.max);
        rangeStartUtc = widened.rangeStartUtc;
        rangeEndUtc = widened.rangeEndUtc;
      } else {
        const range = this.localDateToUtcRange(dateStr, offsetMinutes);
        rangeStartUtc = range.rangeStartUtc;
        rangeEndUtc = range.rangeEndUtc;
      }
      return {
        dateStr,
        dayUtc: new Date(dateStr + 'T00:00:00Z'),
        rangeStartUtc,
        rangeEndUtc,
      };
    });

    const globalStartUtc = dateWindows.reduce(
      (min, current) => (current.rangeStartUtc < min ? current.rangeStartUtc : min),
      dateWindows[0]!.rangeStartUtc,
    );
    const globalEndUtc = dateWindows.reduce(
      (max, current) => (current.rangeEndUtc > max ? current.rangeEndUtc : max),
      dateWindows[0]!.rangeEndUtc,
    );

    // FINDING 1 FIX: Scope global fetch to only payload metric codes.
    // Previously passed `undefined` → fetched ALL metrics in the date range.
    // Under page budget (MAX_SAMPLE_PAGES), unrelated metrics consumed page slots,
    // causing false PARTIAL/NO_DATA for target metrics. Now only fetches what we need.
    const targetMetricCodes = validMetricCodes.map(v => v.metricCode);
    const globalFetchResult = await fetchAllActivePages(
      this.sampleRepo,
      payload.userId,
      globalStartUtc,
      globalEndUtc,
      targetMetricCodes,
    );
    globalFetchTruncated = globalFetchResult.truncated;
    globalFetchedSamples = globalFetchResult.totalFetched;
    queriesEliminated = Math.max((validMetricCodes.length * dateWindows.length) - 1, 0);

    if (globalFetchTruncated) {
      this.logger.warn('HealthRollupProjectionHandler: global sample fetch truncated at page budget — derived rows will be marked PARTIAL', {
        context: 'HealthRollupProjectionHandler.handle',
        userId: payload.userId,
        globalStartUtc: globalStartUtc.toISOString(),
        globalEndUtc: globalEndUtc.toISOString(),
        totalFetched: globalFetchResult.totalFetched,
        maxPages: MAX_SAMPLE_PAGES,
        pageSize: SAMPLE_PAGE_SIZE,
      });
    }

    const samplesByMetric = new Map<string, HealthSample[]>();
    for (const sample of globalFetchResult.items) {
      const existing = samplesByMetric.get(sample.metricCode);
      if (existing) {
        existing.push(sample);
      } else {
        samplesByMetric.set(sample.metricCode, [sample]);
      }
    }

    for (const { metricCode, valueKind } of validMetricCodes) {
      const metricSamples = samplesByMetric.get(metricCode) ?? [];

      for (const window of dateWindows) {
        const effectiveStatus = globalFetchTruncated ? 'PARTIAL' : 'READY';
        let samples = metricSamples.filter((s) =>
          s.startAt >= window.rangeStartUtc && s.startAt < window.rangeEndUtc
        );

        // MULTI-OFFSET FIX: In-memory filter when offsets differ.
        //
        // The widened UTC range may include samples that belong to adjacent local
        // dates (false positives). Filter: keep only samples where their per-sample
        // TZ places them on this exact local date.
        //
        // Example: User traveled EST→IST. Sample at 02:00Z with TZ=+330 → local
        // Jan 16 7:30am. Handler processing Jan 16: sample correctly kept.
        // Same query might also fetch a sample at 04:00Z with TZ=-300 → local
        // Jan 15 11pm. That sample belongs to Jan 15, not Jan 16 → filtered out.
        if (isMultiOffset) {
          samples = samples.filter((s) => {
            const sampleOffset = s.timezoneOffsetMin ?? offsetMinutes;
            return toLocalDate(s.startAt, sampleOffset) === window.dateStr;
          });
        }

        // Determine the dominant TZ offset for this rollup row.
        // For multi-offset batches, use the mode of filtered samples' offsets.
        // For uniform batches, use the original rollupTimezoneOffsetMin.
        let effectiveTzOffset: number | null;
        if (isMultiOffset && samples.length > 0) {
          effectiveTzOffset = computeDominantOffset(samples.map(s => s.timezoneOffsetMin)) ?? rollupTimezoneOffsetMin;
        } else {
          effectiveTzOffset = rollupTimezoneOffsetMin;
        }

        if (samples.length === 0) {
          // TRUNCATION FIX: When global fetch was truncated, empty in-memory
          // does NOT confirm no data exists — samples for this metric+date may
          // be beyond the page boundary. Write PARTIAL (not NO_DATA) so
          // downstream consumers know to retry.
          const emptyStatus = globalFetchTruncated ? 'PARTIAL' : 'NO_DATA';
          await this.rollupRepo.upsertRollup({
            userId: payload.userId,
            metricCode,
            dayUtc: window.dayUtc,
            valueKind,
            countVal: 0,
            timezoneOffsetMin: effectiveTzOffset,
            status: emptyStatus,
            sourceWatermark: currentWatermark,
          });
          if (globalFetchTruncated) {
            truncatedEmptyCount++;
          } else {
            noDataCount++;
          }
          continue;
        }

        // Convert to AggregationInput (filter out null values)
        const aggregationInputs: AggregationInput[] = samples
          .filter((s): s is typeof s & { value: NonNullable<typeof s.value> } => s.value !== null)
          .map((s) => ({
            value: Number(s.value),
            startAt: s.startAt,
            endAt: s.endAt,
          }));

        if (aggregationInputs.length === 0) {
          // TRUNCATION FIX: Same guard as above — null-valued samples don't
          // confirm absence when the global fetch was truncated.
          const nullEmptyStatus = globalFetchTruncated ? 'PARTIAL' : 'NO_DATA';
          await this.rollupRepo.upsertRollup({
            userId: payload.userId,
            metricCode,
            dayUtc: window.dayUtc,
            valueKind,
            countVal: 0,
            timezoneOffsetMin: effectiveTzOffset,
            status: nullEmptyStatus,
            sourceWatermark: currentWatermark,
          });
          if (globalFetchTruncated) {
            truncatedEmptyCount++;
          } else {
            noDataCount++;
          }
          continue;
        }

        // Aggregate using the pure method (ValueKind-aware strategy)
        const result = this.aggregationService.aggregateWithValueKind(
          aggregationInputs,
          valueKind,
          metricCode
        );

        // Compute sumSq for SCALAR_NUM variance support
        let sumSq: number | null = null;
        if (valueKind === 'SCALAR_NUM') {
          sumSq = 0;
          for (const input of aggregationInputs) {
            sumSq += input.value * input.value;
          }
        }

        // Determine which fields are meaningful per ValueKind
        //   SCALAR_NUM:      sumVal=sumValue (arithmetic sum of point readings)
        //                    While summing point-in-time values has no standalone clinical
        //                    meaning, the sum IS required by the read path to compute
        //                    avgVal = sumVal / countVal. Without it, avgVal is always null.
        //   CUMULATIVE_NUM:  sumVal=aggregatedValue (delta = max−min; raw sum is meaningless)
        //   INTERVAL_NUM:    sumVal=sumValue (raw sum IS the aggregation)
        let sumVal: number | null;
        switch (valueKind) {
          case 'SCALAR_NUM':
            sumVal = result.sumValue;
            break;
          case 'CUMULATIVE_NUM':
            sumVal = result.aggregatedValue; // delta (max - min)
            break;
          case 'INTERVAL_NUM':
            sumVal = result.sumValue; // raw sum
            break;
          default:
            sumVal = null;
        }
        const minVal = valueKind !== 'CUMULATIVE_NUM' ? result.minValue : null;
        const maxVal = valueKind !== 'CUMULATIVE_NUM' ? result.maxValue : null;

        await this.rollupRepo.upsertRollup({
          userId: payload.userId,
          metricCode,
          dayUtc: window.dayUtc,
          valueKind,
          sumVal,
          countVal: result.sampleCount,
          minVal,
          maxVal,
          sumSq,
          timezoneOffsetMin: effectiveTzOffset,
          status: effectiveStatus,
          sourceWatermark: currentWatermark,
        });

        processedCount++;
      }
    }

    this.logger.info('HealthRollupProjectionHandler: completed', {
      context: 'HealthRollupProjectionHandler.handle',
      userId: payload.userId,
      processedCount,
      noDataCount,
      truncatedEmptyCount,
      metricCount: payload.metricCodes.length,
      dateCount: payload.affectedLocalDates.length,
      globalFetchedSamples,
      globalFetchTruncated,
      queriesEliminated,
      isMultiOffset,
      durationMs: Date.now() - startTime,
    });
  }

  /**
   * Convert a local date string (YYYY-MM-DD) and offset to a UTC range.
   *
   * Uses offset-based conversion (NOT IANA timezone strings).
   * Returns half-open interval [start, end) for correct boundary handling.
   */
  private localDateToUtcRange(
    dateStr: string,
    offsetMinutes: number
  ): { rangeStartUtc: Date; rangeEndUtc: Date } {
    const [year, month, day] = dateStr.split('-').map(Number);
    // Local midnight → UTC
    const localMidnightMs = Date.UTC(year!, month! - 1, day!, 0, 0, 0, 0);
    const rangeStartUtc = new Date(localMidnightMs - offsetMinutes * 60_000);
    // Local end of day → UTC (exclusive end for half-open interval)
    const localEndOfDayMs = Date.UTC(year!, month! - 1, day! + 1, 0, 0, 0, 0);
    const rangeEndUtc = new Date(localEndOfDayMs - offsetMinutes * 60_000);
    return { rangeStartUtc, rangeEndUtc };
  }
}

/**
 * Sleep metric codes that trigger sleep summary computation.
 * If none of these are in payload.metricCodes, the handler skips early.
 */
const SLEEP_METRIC_CODES = new Set([
  'sleep_duration',
  'sleep_awake',
  'sleep_light',
  'sleep_deep',
  'sleep_rem',
  'time_in_bed',
  'sleep_stage',
]);

/**
 * Pre-bed session search window in milliseconds (4 hours).
 */
const PRE_BED_WINDOW_MS = 4 * 60 * 60 * 1000;

/**
 * Sleep Summary Projection Handler (Phase 1 — Real Implementation)
 *
 * Synchronously computes nightly sleep summaries when health.samples.changed
 * events contain sleep-related metrics. Writes to user_sleep_night_summary.
 *
 * KEY FEATURES:
 *   - Night anchoring: Uses getSleepNightAnchorDate for correct date assignment
 *   - Source dedup: selectCanonicalSource prevents double-counting from multiple devices
 *   - Stage availability: NULL fields when device doesn't report a stage (not 0)
 *   - Nap exclusion: Only NIGHT clusters go into the night summary
 *   - Pre-bed correlation: Links wellness sessions ending within 4h before sleep
 *
 * INVARIANTS:
 *   - Idempotent: upsert on (userId, nightLocalDate)
 *   - Fail-fast on any DB error
 */
export class SleepSummaryProjectionHandler implements HealthProjectionHandler {
  readonly name = 'sleep-summary';

  constructor(
    private readonly logger: LoggerService,
    private readonly summaryRepo: SleepNightSummaryRepository,
    private readonly sampleRepo: HealthSampleRepository,
    private readonly sessionRepo: SessionRepository,
    private readonly watermarkRepo: UserHealthWatermarkRepository
  ) {}

  async handle(payload: HealthSamplesChangedPayload): Promise<void> {
    // FAIL-FAST: Dependencies are required
    if (!this.summaryRepo || !this.sampleRepo || !this.sessionRepo || !this.watermarkRepo) {
      throw new Error(
        'SleepSummaryProjectionHandler: MISCONFIGURATION — registered without required dependencies'
      );
    }

    // Skip early if no sleep metrics in payload
    const hasSleepMetrics = payload.metricCodes.some((code) => SLEEP_METRIC_CODES.has(code));
    if (!hasSleepMetrics) {
      this.logger.debug('SleepSummaryProjectionHandler: no sleep metrics, skipping', {
        context: 'SleepSummaryProjectionHandler.handle',
        userId: payload.userId,
        metricCodes: payload.metricCodes,
      });
      return;
    }

    // ISSUE 4 FIX: Guard false NO_DATA writes from non-stage sleep triggers.
    const hasStageMetric = payload.metricCodes.includes('sleep_stage');

    const startTime = Date.now();
    const offsetMinutes = payload.timezoneOffsetMinutes ?? 0;

    // MULTI-OFFSET FIX: Extract offsetRange with backward-compat fallback.
    const offsetRange: OffsetRange = payload.offsetRange ?? { min: offsetMinutes, max: offsetMinutes };
    const isMultiOffset = offsetRange.min !== offsetRange.max;

    // Read current watermark
    const currentWatermark = await this.watermarkRepo.getSequenceNumber(payload.userId);

    // ISSUE 6 FIX: Enforce watermark freshness before computing derived data.
    assertWatermarkFreshness(currentWatermark, payload, 'SleepSummaryProjectionHandler');

    let processedCount = 0;
    let noDataCount = 0;
    let truncatedEmptyCount = 0;
    let globalFetchTruncated = false;
    let globalFetchedSamples = 0;
    let queriesEliminated = 0;

    // NIGHT ANCHOR FIX: Expand affectedLocalDates to cover adjacent nights.
    const affectedNights = new Set<string>();
    for (const dateStr of payload.affectedLocalDates) {
      affectedNights.add(dateStr);
      // Add previous day: samples at 0-6am local on dateStr belong to night of (dateStr - 1)
      const [y, m, d] = dateStr.split('-').map(Number);
      const prevDay = new Date(Date.UTC(y!, m! - 1, d! - 1));
      affectedNights.add(prevDay.toISOString().slice(0, 10));
    }

    const nightWindows = Array.from(affectedNights).map((nightDateStr) => {
      if (isMultiOffset) {
        const widened = widenedNightWindowUtc(nightDateStr, offsetRange.min, offsetRange.max);
        return {
          nightDateStr,
          startUtc: widened.startUtc,
          endUtc: widened.endUtc,
        };
      }
      const standard = getNightWindowUtc(nightDateStr, offsetMinutes);
      return {
        nightDateStr,
        startUtc: standard.startUtc,
        endUtc: standard.endUtc,
      };
    });

    let globalSleepStageSamples: HealthSample[] = [];
    if (nightWindows.length > 0) {
      const globalStartUtc = nightWindows.reduce(
        (min, current) => (current.startUtc < min ? current.startUtc : min),
        nightWindows[0]!.startUtc,
      );
      const globalEndUtc = nightWindows.reduce(
        (max, current) => (current.endUtc > max ? current.endUtc : max),
        nightWindows[0]!.endUtc,
      );

      const globalFetchResult = await fetchAllActivePages(
        this.sampleRepo,
        payload.userId,
        globalStartUtc,
        globalEndUtc,
        'sleep_stage',
      );

      globalFetchTruncated = globalFetchResult.truncated;
      globalFetchedSamples = globalFetchResult.totalFetched;
      queriesEliminated = Math.max(nightWindows.length - 1, 0);
      globalSleepStageSamples = globalFetchResult.items;

      if (globalFetchTruncated) {
        this.logger.warn('SleepSummaryProjectionHandler: global sample fetch truncated at page budget — derived rows will be marked PARTIAL', {
          context: 'SleepSummaryProjectionHandler.handle',
          userId: payload.userId,
          globalStartUtc: globalStartUtc.toISOString(),
          globalEndUtc: globalEndUtc.toISOString(),
          totalFetched: globalFetchResult.totalFetched,
          maxPages: MAX_SAMPLE_PAGES,
          pageSize: SAMPLE_PAGE_SIZE,
        });
      }
    }

    // Track nights we've already upserted data for (avoid redundant DB calls)
    const processedNights = new Set<string>();

    for (const window of nightWindows) {
      const sleepEffectiveStatus = globalFetchTruncated ? 'PARTIAL' : 'READY';
      const sleepStageSamples = globalSleepStageSamples.filter((sample) =>
        sample.startAt >= window.startUtc && sample.startAt < window.endUtc
      );
      const nightDateStr = window.nightDateStr;

      if (sleepStageSamples.length === 0) {
        // No sleep_stage data for this night.
        // ISSUE 4 FIX: Only write NO_DATA when the event explicitly included sleep_stage.
        // TRUNCATION FIX: When global fetch was truncated, empty in-memory does NOT
        // confirm no data exists — sleep_stage samples may be beyond the page boundary.
        if (hasStageMetric && !processedNights.has(nightDateStr)) {
          const emptyStatus = globalFetchTruncated ? 'PARTIAL' : 'NO_DATA';
          const nightLocalDate = new Date(nightDateStr + 'T00:00:00Z');
          await this.summaryRepo.upsertNightSummary({
            userId: payload.userId,
            nightLocalDate,
            timezoneOffsetMin: offsetMinutes,
            status: emptyStatus,
            sourceWatermark: currentWatermark,
          });
          processedNights.add(nightDateStr);
          if (globalFetchTruncated) {
            truncatedEmptyCount++;
          } else {
            noDataCount++;
          }
        } else if (!hasStageMetric) {
          this.logger.debug('SleepSummaryProjectionHandler: no sleep_stage samples and event did not include sleep_stage metric, skipping NO_DATA write', {
            context: 'SleepSummaryProjectionHandler.handle',
            userId: payload.userId,
            nightDateStr,
            metricCodes: payload.metricCodes,
          });
        }
        continue;
      }

      // Source dedup: select canonical source
      const sourceResult = selectCanonicalSource(
        sleepStageSamples.map((s) => ({
          sourceId: s.sourceId,
          startAt: s.startAt,
          endAt: s.endAt,
        }))
      );

      // Filter to canonical source samples only
      const canonicalSamples = sourceResult
        ? sleepStageSamples.filter((s) => s.sourceId === sourceResult.sourceId)
        : sleepStageSamples;

      // Convert to SleepSampleInput for clustering
      const clusterInputs: SleepSampleInput[] = canonicalSamples.map((s) => ({
        id: s.id,
        startAt: s.startAt,
        endAt: s.endAt,
        categoryCode: s.categoryCode ?? 'unknown',
        timezoneOffsetMinutes: s.timezoneOffsetMin ?? offsetMinutes,
      }));

      // Cluster into sleep sessions
      const clusters = clusterSleepSamples(clusterInputs);

      // Find the primary NIGHT cluster (not naps)
      const nightClusters = clusters.filter((c) => !c.isNap);

      if (nightClusters.length === 0) {
        // Only naps, no night sleep — upsert NO_DATA if not already processed.
        // ISSUE 4 FIX: Same guard as above — only write NO_DATA when event had sleep_stage.
        // TRUNCATION FIX: Under truncation, night clusters may exist beyond page boundary.
        if (hasStageMetric && !processedNights.has(nightDateStr)) {
          const napEmptyStatus = globalFetchTruncated ? 'PARTIAL' : 'NO_DATA';
          const nightLocalDate = new Date(nightDateStr + 'T00:00:00Z');
          await this.summaryRepo.upsertNightSummary({
            userId: payload.userId,
            nightLocalDate,
            timezoneOffsetMin: offsetMinutes,
            status: napEmptyStatus,
            sourceWatermark: currentWatermark,
          });
          processedNights.add(nightDateStr);
          if (globalFetchTruncated) {
            truncatedEmptyCount++;
          } else {
            noDataCount++;
          }
        }
        continue;
      }

      // Use the longest night cluster as the primary
      const primaryCluster = nightClusters.reduce((longest, current) =>
        current.durationMinutes > longest.durationMinutes ? current : longest
      );

      // NIGHT ANCHOR FIX (IMPROVED): Use the cluster's pre-computed
      // nightAnchorDate instead of re-calling getSleepNightAnchorDate()
      // with the request-level offset. The cluster's nightAnchorDate was
      // computed by clusterSleepSamples() using the FIRST SAMPLE's
      // per-sample TZ (clusterInputs[0].timezoneOffsetMinutes), which is
      // correct — the night anchor should use the TZ of the actual sleep
      // samples, not the request-level header.
      //
      // Previous code: getSleepNightAnchorDate(primaryCluster.startAt, offsetMinutes)
      // This was incorrect when per-sample TZ differed from request-level TZ.
      const anchorDate = primaryCluster.nightAnchorDate;

      if (anchorDate !== nightDateStr) {
        this.logger.info('SleepSummaryProjectionHandler: anchor date differs from candidate night', {
          context: 'SleepSummaryProjectionHandler.handle',
          userId: payload.userId,
          candidateNight: nightDateStr,
          anchorDate,
          clusterStartUtc: primaryCluster.startAt.toISOString(),
        });
      }

      // Skip if we already upserted data for this anchor date in a previous iteration
      if (processedNights.has(anchorDate)) {
        continue;
      }

      // Compute stage breakdowns
      const stageAvailability = computeStageAvailability(primaryCluster.samples);
      const stageDurations = getDurationByStage(primaryCluster.samples);

      const awakeMin = stageAvailability.hasAwake ? Math.round(stageDurations.get('awake') ?? 0) : null;
      const lightMin = stageAvailability.hasLight ? Math.round(stageDurations.get('light') ?? 0) : null;
      const deepMin = stageAvailability.hasDeep ? Math.round(stageDurations.get('deep') ?? 0) : null;
      const remMin = stageAvailability.hasREM ? Math.round(stageDurations.get('rem') ?? 0) : null;

      // Total sleep = cluster duration minus awake time
      const totalClusterMin = Math.round(primaryCluster.durationMinutes);
      const totalSleepMin = awakeMin != null
        ? Math.max(0, totalClusterMin - awakeMin)
        : totalClusterMin;

      // Sleep efficiency = totalSleep / totalInBed * 100
      const sleepEfficiency = totalClusterMin > 0
        ? Math.round((totalSleepMin / totalClusterMin) * 10000) / 100
        : null;

      // Wake events: count contiguous awake segments
      let wakeEvents: number | null = null;
      if (stageAvailability.hasAwake) {
        wakeEvents = 0;
        let inAwake = false;
        for (const sample of primaryCluster.samples) {
          const isAwake = sample.categoryCode.toLowerCase() === 'awake';
          if (isAwake && !inAwake) {
            wakeEvents++;
            inAwake = true;
          } else if (!isAwake) {
            inAwake = false;
          }
        }
      }

      // Find pre-bed session
      let hadSessionBefore = false;
      let sessionIdBefore: string | null = null;
      let hoursBeforeBed: number | null = null;

      const sleepStartUtc = primaryCluster.startAt;
      const preBedWindowStart = new Date(sleepStartUtc.getTime() - PRE_BED_WINDOW_MS);

      const preBedSessions = await this.sessionRepo.findByUserAndTimeRange(
        payload.userId,
        preBedWindowStart,
        sleepStartUtc
      );

      // Find the most recent completed session ending before sleep
      const completedPreBed = preBedSessions
        .filter((s) => s.sessionEndTimestamp && s.sessionEndTimestamp.getTime() <= sleepStartUtc.getTime())
        .sort((a, b) => b.sessionEndTimestamp!.getTime() - a.sessionEndTimestamp!.getTime());

      if (completedPreBed.length > 0) {
        const session = completedPreBed[0]!;
        hadSessionBefore = true;
        sessionIdBefore = session.id;
        hoursBeforeBed = Math.round(
          ((sleepStartUtc.getTime() - session.sessionEndTimestamp!.getTime()) / (60 * 60 * 1000)) * 10
        ) / 10;
      }

      // MULTI-OFFSET FIX: Use the per-sample TZ from the cluster's first
      // sample for the upsert's timezoneOffsetMin. The cluster already groups
      // samples by proximity, and all samples in a cluster share the same TZ
      // context (they are from the same sleep session). This is more accurate
      // than using the request-level offset for multi-device/travel scenarios.
      const clusterTzOffset = clusterInputs[0]?.timezoneOffsetMinutes ?? offsetMinutes;

      // Upsert the night summary using the ANCHOR date (not the loop variable).
      const nightLocalDate = new Date(anchorDate + 'T00:00:00Z');
      await this.summaryRepo.upsertNightSummary({
        userId: payload.userId,
        nightLocalDate,
        timezoneOffsetMin: clusterTzOffset,
        sleepStartTs: primaryCluster.startAt,
        sleepEndTs: primaryCluster.endAt,
        inBedStartTs: primaryCluster.startAt,
        inBedEndTs: primaryCluster.endAt,
        totalSleepMin,
        inBedMin: totalClusterMin,
        awakeMin,
        remMin,
        deepMin,
        lightMin,
        sleepEfficiency,
        wakeEvents,
        sleepLatencyMin: null, // Would require sleep_onset data
        hadSessionBefore,
        sessionIdBefore,
        hoursBeforeBed,
        hasRemData: stageAvailability.hasREM,
        hasDeepData: stageAvailability.hasDeep,
        hasLightData: stageAvailability.hasLight,
        hasAwakeData: stageAvailability.hasAwake,
        canonicalSourceId: sourceResult?.sourceId ?? null,
        sourceCount: sourceResult?.sourceCount ?? 1,
        sourceCoverage: sourceResult?.coverage ?? null,
        dataQualityScore: null, // Future: compute from coverage + completeness
        status: sleepEffectiveStatus,
        sourceWatermark: currentWatermark,
      });

      processedNights.add(anchorDate);
      processedCount++;
    }

    this.logger.info('SleepSummaryProjectionHandler: completed', {
      context: 'SleepSummaryProjectionHandler.handle',
      userId: payload.userId,
      processedCount,
      noDataCount,
      truncatedEmptyCount,
      dateCount: payload.affectedLocalDates.length,
      affectedNightCount: affectedNights.size,
      globalFetchedSamples,
      globalFetchTruncated,
      queriesEliminated,
      isMultiOffset,
      durationMs: Date.now() - startTime,
    });
  }
}

/**
 * Minimum coverage threshold for a bucket to be considered reliable.
 * If any bucket's coverage falls below this, the impact is marked isReliable=false.
 */
const SESSION_IMPACT_MIN_COVERAGE = 0.6;

/**
 * Session Impact Projection Handler (Phase 1 — New)
 *
 * Computes before/during/after health metric deltas around consumption sessions.
 * Writes to user_session_impact_summary for instant rendering of impact cards.
 *
 * BUCKETING:
 *   before = [sessionStart - windowMinutes, sessionStart)
 *   during = [sessionStart, sessionEnd]
 *   after  = (sessionEnd, sessionEnd + windowMinutes]
 *
 * Only processes:
 *   - Completed sessions (sessionEndTimestamp exists)
 *   - SCALAR_NUM and INTERVAL_NUM metrics (not CUMULATIVE_NUM or CATEGORY)
 *
 * INVARIANTS:
 *   - Idempotent: upsert on (sessionId, metricCode, windowMinutes, resolution)
 *   - isReliable=false when coverage < 0.6 in any bucket
 *   - Fail-fast on any DB error
 */
export class SessionImpactProjectionHandler implements HealthProjectionHandler {
  readonly name = 'session-impact';

  constructor(
    private readonly logger: LoggerService,
    private readonly impactRepo: SessionImpactSummaryRepository,
    private readonly sampleRepo: HealthSampleRepository,
    private readonly sessionRepo: SessionRepository,
    private readonly aggregationService: HealthAggregationService,
    private readonly watermarkRepo: UserHealthWatermarkRepository
  ) {}

  async handle(payload: HealthSamplesChangedPayload): Promise<void> {
    // FAIL-FAST: Dependencies are required
    if (!this.impactRepo || !this.sampleRepo || !this.sessionRepo || !this.aggregationService || !this.watermarkRepo) {
      throw new Error(
        'SessionImpactProjectionHandler: MISCONFIGURATION — registered without required dependencies'
      );
    }

    const startTime = Date.now();

    // Find sessions that overlap the affected time range (with buffer)
    if (payload.rangeStartMs === 0 && payload.rangeEndMs === 0) {
      this.logger.debug('SessionImpactProjectionHandler: missing range, skipping', {
        context: 'SessionImpactProjectionHandler.handle',
        userId: payload.userId,
      });
      return;
    }

    const windowMinutes = 60;
    const windowMs = windowMinutes * 60 * 1000;
    const bufferStart = new Date(payload.rangeStartMs - windowMs);
    const bufferEnd = new Date(payload.rangeEndMs + windowMs);

    const sessions = await this.sessionRepo.findByUserAndTimeRange(
      payload.userId,
      bufferStart,
      bufferEnd
    );

    // Only completed sessions
    const completedSessions = sessions.filter((s) => s.sessionEndTimestamp != null);

    if (completedSessions.length === 0) {
      this.logger.debug('SessionImpactProjectionHandler: no completed sessions in range', {
        context: 'SessionImpactProjectionHandler.handle',
        userId: payload.userId,
        rangeStartMs: payload.rangeStartMs,
        rangeEndMs: payload.rangeEndMs,
      });
      return;
    }

    // Read current watermark
    const currentWatermark = await this.watermarkRepo.getSequenceNumber(payload.userId);

    // ISSUE 6 FIX: Enforce watermark freshness before computing derived data.
    assertWatermarkFreshness(currentWatermark, payload, 'SessionImpactProjectionHandler');

    // Filter to numeric, non-cumulative metrics
    const impactMetrics = payload.metricCodes.filter((code) => {
      if (!isHealthMetricCode(code)) return false;
      const vk = getValueKind(code);
      // SCALAR_NUM (heart_rate, hrv) and INTERVAL_NUM (active_energy) make sense for impact
      // CUMULATIVE_NUM (steps) doesn't produce meaningful before/during/after averages
      return vk === 'SCALAR_NUM' || vk === 'INTERVAL_NUM';
    });

    if (impactMetrics.length === 0) {
      return;
    }

    let processedCount = 0;

    for (const session of completedSessions) {
      const sessionStartMs = session.sessionStartTimestamp.getTime();
      const sessionEndMs = session.sessionEndTimestamp!.getTime();
      const beforeStartMs = sessionStartMs - windowMs;
      const afterEndMs = sessionEndMs + windowMs;

      for (const metricCode of impactMetrics) {
        // Query ALL samples in the full window [beforeStart, afterEnd].
        // Uses paging loop to prevent silent truncation at 10k rows.
        const fetchResult = await fetchAllActivePages(
          this.sampleRepo,
          payload.userId,
          new Date(beforeStartMs),
          new Date(afterEndMs),
          metricCode
        );

        if (fetchResult.truncated) {
          this.logger.warn('SessionImpactProjectionHandler: sample fetch truncated at page budget — derived row will be marked PARTIAL', {
            context: 'SessionImpactProjectionHandler.handle',
            userId: payload.userId,
            sessionId: session.id,
            metricCode,
            totalFetched: fetchResult.totalFetched,
            maxPages: MAX_SAMPLE_PAGES,
            pageSize: SAMPLE_PAGE_SIZE,
          });
        }

        const allSamples = fetchResult.items
          .filter((s): s is typeof s & { value: NonNullable<typeof s.value> } => s.value !== null);

        // Bucket samples into before/during/after
        const beforeSamples: AggregationInput[] = [];
        const duringSamples: AggregationInput[] = [];
        const afterSamples: AggregationInput[] = [];

        for (const s of allSamples) {
          const sampleMidpoint = (s.startAt.getTime() + s.endAt.getTime()) / 2;
          const input: AggregationInput = {
            value: Number(s.value),
            startAt: s.startAt,
            endAt: s.endAt,
          };

          if (sampleMidpoint < sessionStartMs) {
            beforeSamples.push(input);
          } else if (sampleMidpoint <= sessionEndMs) {
            duringSamples.push(input);
          } else {
            afterSamples.push(input);
          }
        }

        // Compute stats for each bucket
        const beforeStats = this.computeBucketStats(beforeSamples);
        const duringStats = this.computeBucketStats(duringSamples);
        const afterStats = this.computeBucketStats(afterSamples);

        // Compute deltas (relative to before baseline)
        const deltaDuringAbs = (beforeStats.avg != null && duringStats.avg != null)
          ? duringStats.avg - beforeStats.avg
          : null;
        const deltaDuringPct = (beforeStats.avg != null && beforeStats.avg !== 0 && deltaDuringAbs != null)
          ? (deltaDuringAbs / beforeStats.avg) * 100
          : null;
        const deltaAfterAbs = (beforeStats.avg != null && afterStats.avg != null)
          ? afterStats.avg - beforeStats.avg
          : null;
        const deltaAfterPct = (beforeStats.avg != null && beforeStats.avg !== 0 && deltaAfterAbs != null)
          ? (deltaAfterAbs / beforeStats.avg) * 100
          : null;

        // Compute cadence-aware coverage.
        // Expected samples per minute is derived from the metric's declared cadence.
        // Without cadence normalization, low-frequency metrics (HRV at 4/hr, SpO2 at 4/hr)
        // are penalized as "unreliable" even when data quality matches the device's actual
        // reporting cadence. Normalizing by expected cadence makes the 0.6 threshold
        // meaningful across all metric types.
        const expectedPerHour = getExpectedSamplesPerHour(metricCode as HealthMetricCode);
        const expectedPerMin = expectedPerHour != null ? expectedPerHour / 60 : 1; // default: 1/min

        const beforeDurationMin = windowMinutes;
        const duringDurationMin = (sessionEndMs - sessionStartMs) / 60_000;
        const afterDurationMin = windowMinutes;

        const beforeCoverage = beforeDurationMin > 0
          ? Math.min(1.0, beforeStats.count / (beforeDurationMin * expectedPerMin))
          : null;
        const duringCoverage = duringDurationMin > 0
          ? Math.min(1.0, duringStats.count / (duringDurationMin * expectedPerMin))
          : null;
        const afterCoverage = afterDurationMin > 0
          ? Math.min(1.0, afterStats.count / (afterDurationMin * expectedPerMin))
          : null;

        // Total sample count MUST be computed before reliability check (avoids TDZ).
        const totalSampleCount = beforeStats.count + duringStats.count + afterStats.count;

        // Determine reliability
        // FIX: Null coverages (from 0-sample buckets) must NOT pass as reliable.
        // A session impact is reliable ONLY when:
        // 1. There is actual sample data (totalSampleCount > 0)
        // 2. At least one coverage value is measurable (non-null)
        // 3. ALL non-null coverages meet the minimum threshold
        const nonNullCoverages = [beforeCoverage, duringCoverage, afterCoverage]
          .filter((c): c is number => c != null);
        const isReliable = totalSampleCount > 0 &&
          nonNullCoverages.length > 0 &&
          nonNullCoverages.every((c) => c >= SESSION_IMPACT_MIN_COVERAGE);
        const hasSignificantGaps = !isReliable;

        // Determine status: NO_DATA when all buckets are empty (no samples to derive
        // meaningful impact from), READY when at least one bucket has data.
        // ISSUE 5 FIX: Use PARTIAL when sample fetch was truncated.
        // TRUNCATION FIX: Truncation takes priority — can't confirm NO_DATA when
        // more samples may exist beyond the page boundary.
        const effectiveStatus = fetchResult.truncated
          ? 'PARTIAL'
          : totalSampleCount === 0
            ? 'NO_DATA'
            : 'READY';

        await this.impactRepo.upsertImpact({
          sessionId: session.id,
          userId: payload.userId,
          metricCode,
          windowMinutes,
          resolution: '1min',
          avgBefore: beforeStats.avg,
          minBefore: beforeStats.min,
          maxBefore: beforeStats.max,
          countBefore: beforeStats.count,
          avgDuring: duringStats.avg,
          minDuring: duringStats.min,
          maxDuring: duringStats.max,
          countDuring: duringStats.count,
          avgAfter: afterStats.avg,
          minAfter: afterStats.min,
          maxAfter: afterStats.max,
          countAfter: afterStats.count,
          deltaDuringAbs,
          deltaDuringPct,
          deltaAfterAbs,
          deltaAfterPct,
          beforeCoverage,
          duringCoverage,
          afterCoverage,
          hasSignificantGaps,
          isReliable,
          status: effectiveStatus,
          sourceWatermark: currentWatermark,
        });

        processedCount++;
      }
    }

    this.logger.info('SessionImpactProjectionHandler: completed', {
      context: 'SessionImpactProjectionHandler.handle',
      userId: payload.userId,
      sessionCount: completedSessions.length,
      metricCount: impactMetrics.length,
      processedCount,
      durationMs: Date.now() - startTime,
    });
  }

  /**
   * Compute simple stats (avg, min, max, count) for a bucket of samples.
   */
  private computeBucketStats(
    samples: readonly AggregationInput[]
  ): { avg: number | null; min: number | null; max: number | null; count: number } {
    if (samples.length === 0) {
      return { avg: null, min: null, max: null, count: 0 };
    }

    let sum = 0;
    let min = samples[0]!.value;
    let max = samples[0]!.value;

    for (const s of samples) {
      sum += s.value;
      if (s.value < min) min = s.value;
      if (s.value > max) max = s.value;
    }

    return {
      avg: sum / samples.length,
      min,
      max,
      count: samples.length,
    };
  }
}

/**
 * Product Impact Projection Handler (Phase E — New)
 *
 * 5th handler in the coordinator. Aggregates per-session health deltas
 * (from SessionImpactProjectionHandler) into per-product impact rollups.
 *
 * COMPUTE FLOW:
 * 1. Assert watermark freshness
 * 2. Find completed sessions in event time range (with 60min buffer)
 * 3. Filter to sessions with primaryProductId != null
 * 4. Collect unique affected product IDs
 * 5. Filter metric codes to SCALAR_NUM and INTERVAL_NUM only
 * 6. For each (productId × metricCode):
 *    a. Query ALL session impacts via sessionImpactRepo
 *    b. Call computeProductImpactAggregate() (pure function)
 *    c. Determine status: NO_DATA (0 impacts), READY (>= minSessions), PARTIAL (< minSessions)
 *    d. Upsert via productImpactRepo
 *
 * KEY INVARIANT: Runs AFTER SessionImpactProjectionHandler in coordinator sequence.
 * This is guaranteed by registration order in bootstrap.ts.
 *
 * IDEMPOTENT: Full re-aggregation per product (not incremental). Bounded by
 * sessions-per-product (typically < 200). Upsert on natural key.
 */
export class ProductImpactProjectionHandler implements HealthProjectionHandler {
  readonly name = 'product-impact';

  // FINDING 2 FIX: Explicit dependency on session-impact.
  // Coordinator will skip this handler if session-impact failed in the current fanout,
  // preventing stale session-impact data from being baked into product rollups.
  readonly dependsOn = ['session-impact'] as const;

  constructor(
    private readonly logger: LoggerService,
    private readonly productImpactRepo: ProductImpactRollupRepository,
    private readonly sessionImpactRepo: SessionImpactSummaryRepository,
    private readonly sessionRepo: SessionRepository,
    private readonly watermarkRepo: UserHealthWatermarkRepository,
  ) {}

  async handle(payload: HealthSamplesChangedPayload): Promise<void> {
    // FAIL-FAST: Dependencies are required
    if (!this.productImpactRepo || !this.sessionImpactRepo || !this.sessionRepo || !this.watermarkRepo) {
      throw new Error(
        'ProductImpactProjectionHandler: MISCONFIGURATION — registered without required dependencies'
      );
    }

    const startTime = Date.now();

    // Skip if no time range
    if (payload.rangeStartMs === 0 && payload.rangeEndMs === 0) {
      this.logger.debug('ProductImpactProjectionHandler: missing range, skipping', {
        context: 'ProductImpactProjectionHandler.handle',
        userId: payload.userId,
      });
      return;
    }

    // Read current watermark
    const currentWatermark = await this.watermarkRepo.getSequenceNumber(payload.userId);

    // Enforce watermark freshness
    assertWatermarkFreshness(currentWatermark, payload, 'ProductImpactProjectionHandler');

    // Find sessions in the affected time range (with 60min buffer)
    const windowMs = 60 * 60 * 1000;
    const bufferStart = new Date(payload.rangeStartMs - windowMs);
    const bufferEnd = new Date(payload.rangeEndMs + windowMs);

    const sessions = await this.sessionRepo.findByUserAndTimeRange(
      payload.userId,
      bufferStart,
      bufferEnd,
    );

    // Only completed sessions with a primary product
    const affectedSessions = sessions.filter(
      (s) => s.sessionEndTimestamp != null && s.primaryProductId != null,
    );

    if (affectedSessions.length === 0) {
      this.logger.debug('ProductImpactProjectionHandler: no completed sessions with products in range', {
        context: 'ProductImpactProjectionHandler.handle',
        userId: payload.userId,
        totalSessions: sessions.length,
      });
      return;
    }

    // Collect unique affected product IDs
    const affectedProductIds = new Set<string>();
    for (const session of affectedSessions) {
      affectedProductIds.add(session.primaryProductId!);
    }

    // Filter metric codes to SCALAR_NUM and INTERVAL_NUM only
    const impactMetrics = payload.metricCodes.filter((code) => {
      if (!isHealthMetricCode(code)) return false;
      const vk = getValueKind(code);
      return vk === 'SCALAR_NUM' || vk === 'INTERVAL_NUM';
    });

    if (impactMetrics.length === 0) {
      this.logger.debug('ProductImpactProjectionHandler: no impact-eligible metrics', {
        context: 'ProductImpactProjectionHandler.handle',
        userId: payload.userId,
        metricCodes: payload.metricCodes,
      });
      return;
    }

    let processedCount = 0;
    let deferredDueToUpstream = 0;
    const minSessionsRequired = 3;

    // MULTI-PERIOD COMPUTATION: Compute rollups for 7d, 30d, and 90d windows.
    // Users get product-impact data as soon as they have 7 days of sessions —
    // they don't have to wait 90 days. Each period filters the same session
    // impacts by sessionStartTs cutoff (single DB query, in-memory filtering).
    const IMPACT_PERIOD_DAYS = [7, 30, 90] as const;
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const nowMs = Date.now();

    // BOUNDED PROCESSING CONTROLS: Time budget is the sole safety valve.
    // When time budget is exceeded, the handler throws → outbox retries →
    // previously-upserted rows are idempotent → remaining products get
    // processed on retry (progressive completion).
    //
    // WARN thresholds (not caps — NO truncation): Log when product/metric
    // counts exceed monitoring thresholds so operators can track fan-out.
    // All products and metrics are processed; the time budget bounds
    // wall-clock cost per invocation.
    const PRODUCT_WARN_THRESHOLD = 100;
    const METRIC_WARN_THRESHOLD = 15;
    const MAX_TIME_BUDGET_MS = 25_000; // 25s hard ceiling — 5s below coordinator timeout to avoid race

    const productArray = Array.from(affectedProductIds);
    const productsExceedThreshold = productArray.length > PRODUCT_WARN_THRESHOLD;
    if (productsExceedThreshold) {
      this.logger.warn('ProductImpactProjectionHandler: product count exceeds monitoring threshold', {
        context: 'ProductImpactProjectionHandler.handle',
        userId: payload.userId,
        totalProducts: productArray.length,
        threshold: PRODUCT_WARN_THRESHOLD,
      });
      // NO truncation — all products will be processed within time budget.
      // Time-budget-exceeded throws → retry → idempotent progressive completion.
    }

    const metricsExceedThreshold = impactMetrics.length > METRIC_WARN_THRESHOLD;
    if (metricsExceedThreshold) {
      this.logger.warn('ProductImpactProjectionHandler: metric count exceeds monitoring threshold', {
        context: 'ProductImpactProjectionHandler.handle',
        userId: payload.userId,
        totalMetrics: impactMetrics.length,
        threshold: METRIC_WARN_THRESHOLD,
      });
    }

    let timeBudgetExceeded = false;

    for (const productId of productArray) {
      // Time-budget guard: bail early if approaching the ceiling
      if (Date.now() - startTime > MAX_TIME_BUDGET_MS) {
        timeBudgetExceeded = true;
        this.logger.warn('ProductImpactProjectionHandler: time budget exceeded, stopping early', {
          context: 'ProductImpactProjectionHandler.handle',
          userId: payload.userId,
          processedCount,
          remainingProducts: productArray.length - productArray.indexOf(productId),
          elapsedMs: Date.now() - startTime,
          budgetMs: MAX_TIME_BUDGET_MS,
        });
        break;
      }

      for (const metricCode of impactMetrics) {
        // Query ALL session impacts for this product×metric (all-time).
        // Single DB query per combo — period filtering happens in-memory below.
        const sessionImpacts = await this.sessionImpactRepo.findByUserProductAndMetricForAggregation(
          payload.userId,
          productId,
          metricCode,
          60,     // windowMinutes
          '1min', // resolution
        );

        if (sessionImpacts.length === 0) {
          // Before writing NO_DATA, verify upstream session-impacts are in a terminal
          // state. If any are STALE/COMPUTING/PENDING, the absence is due to upstream
          // still processing — NOT actual data absence. Writing NO_DATA would be
          // incorrect and mask the real state (upstream pending).
          const nonTerminalUpstream = await this.sessionImpactRepo.countNonTerminalByUserProductAndMetric(
            payload.userId,
            productId,
            metricCode,
            60,     // windowMinutes
            '1min', // resolution
          );

          if (nonTerminalUpstream > 0) {
            // Upstream computation is pending — defer this combination.
            // The outbox retry will re-process once upstream reaches terminal state.
            this.logger.debug('ProductImpactProjectionHandler: upstream session-impacts not yet terminal, deferring', {
              context: 'ProductImpactProjectionHandler.handle',
              userId: payload.userId,
              productId,
              metricCode,
              nonTerminalUpstreamCount: nonTerminalUpstream,
            });
            deferredDueToUpstream++;
            continue;
          }

          // Upstream is fully terminal (READY/PARTIAL/NO_DATA/FAILED) with no
          // READY/PARTIAL rows → truly no usable session-impact data.
          // Write NO_DATA for ALL period windows so every period query returns
          // a definitive NO_DATA instead of an ambiguous empty response.
          for (const periodDays of IMPACT_PERIOD_DAYS) {
            await this.productImpactRepo.upsertImpact({
              userId: payload.userId,
              productId,
              metricCode,
              periodDays,
              sessionCount: 0,
              minSessionsRequired,
              status: 'NO_DATA',
              isReliable: false, // NO_DATA is by definition not reliable
              sourceWatermark: currentWatermark,
            });
            processedCount++;
          }
          continue;
        }

        // Convert to ReliableImpactInput ONCE for the pure compute function.
        // Decimal→Number conversion is done here; period filtering below operates
        // on the pre-converted array (no repeated conversion per period).
        const allInputs: ReliableImpactInput[] = sessionImpacts.map((si) => ({
          sessionId: si.sessionId,
          deltaDuringAbs: si.deltaDuringAbs != null ? Number(si.deltaDuringAbs) : null,
          deltaDuringPct: si.deltaDuringPct != null ? Number(si.deltaDuringPct) : null,
          deltaAfterAbs: si.deltaAfterAbs != null ? Number(si.deltaAfterAbs) : null,
          deltaAfterPct: si.deltaAfterPct != null ? Number(si.deltaAfterPct) : null,
          avgBefore: si.avgBefore != null ? Number(si.avgBefore) : null,
          beforeCoverage: si.beforeCoverage != null ? Number(si.beforeCoverage) : null,
          duringCoverage: si.duringCoverage != null ? Number(si.duringCoverage) : null,
          afterCoverage: si.afterCoverage != null ? Number(si.afterCoverage) : null,
          isReliable: si.isReliable,
          status: si.status,
          sessionStartTs: si.session.sessionStartTimestamp,
        }));

        // MULTI-PERIOD LOOP: For each lookback window (7d, 30d, 90d), filter
        // impacts by session start time and compute an independent aggregate.
        // This gives users data from day 7 — they don't wait 90 days.
        for (const periodDays of IMPACT_PERIOD_DAYS) {
          const cutoffMs = nowMs - periodDays * MS_PER_DAY;
          const periodInputs = allInputs.filter(
            (input) => input.sessionStartTs.getTime() >= cutoffMs,
          );

          if (periodInputs.length === 0) {
            // No sessions within this period window — write NO_DATA.
            // Other periods may still have data (e.g., 90d has sessions, 7d does not).
            await this.productImpactRepo.upsertImpact({
              userId: payload.userId,
              productId,
              metricCode,
              periodDays,
              sessionCount: 0,
              minSessionsRequired,
              status: 'NO_DATA',
              isReliable: false, // NO_DATA is by definition not reliable
              sourceWatermark: currentWatermark,
            });
            processedCount++;
            continue;
          }

          // Compute aggregate using pure function (per-period)
          const aggregate = computeProductImpactAggregate(periodInputs, minSessionsRequired);

          // Determine status using MEANINGFUL delta evidence, not just reliability flags.
          // A session can be "reliable" (good coverage) yet have all-null deltas.
          //
          // STATUS SEMANTICS (aligned with shared contract):
          // - READY: At least one session has a meaningful delta. Evidence level is
          //   conveyed via isReliable, confidenceTier, and qualityFlags — NOT via status.
          // - NO_DATA: Zero sessions with non-null deltas (no usable impact evidence).
          //
          // NOTE: We intentionally do NOT use PARTIAL here. In the shared contract,
          // PARTIAL means "source data was truncated by paging limits" (terminal state).
          // Product-impact insufficient-evidence is a different semantic — it's conveyed
          // by isReliable=false + confidenceTier='INSUFFICIENT'/'LOW' + LOW_SESSION_COUNT
          // quality flag. Using PARTIAL here would cause the app to treat insufficient
          // evidence as truncation → incorrect dirty-key clearing.
          const { meaningfulDeltaCount } = aggregate;
          const status = meaningfulDeltaCount > 0
            ? 'READY'
            : 'NO_DATA'; // All sessions had null deltas — no usable impact evidence

          await this.productImpactRepo.upsertImpact({
            userId: payload.userId,
            productId,
            metricCode,
            periodDays,
            sessionCount: aggregate.sessionCount,
            minSessionsRequired,
            periodStart: aggregate.periodStart,
            periodEnd: aggregate.periodEnd,
            avgDeltaDuringAbs: aggregate.avgDeltaDuringAbs,
            avgDeltaDuringPct: aggregate.avgDeltaDuringPct,
            avgDeltaAfterAbs: aggregate.avgDeltaAfterAbs,
            avgDeltaAfterPct: aggregate.avgDeltaAfterPct,
            medianDeltaAfterPct: aggregate.medianDeltaAfterPct,
            baselineValue: aggregate.baselineValue,
            baselineMethod: aggregate.baselineMethod,
            baselineN: aggregate.baselineN,
            baselineWindow: aggregate.baselineWindow,
            coverageScore: aggregate.coverageScore,
            isReliable: aggregate.isReliable,
            qualityFlags: aggregate.qualityFlags,
            exactness: aggregate.exactness,
            confidenceTier: aggregate.confidenceTier,
            confidenceScore: aggregate.confidenceScore,
            ciLow: aggregate.ciLow,
            ciHigh: aggregate.ciHigh,
            status,
            sourceWatermark: currentWatermark,
            evidenceSessionCount: aggregate.sessionCount,
            evidenceSessionIds: aggregate.evidenceSessionIds,
          });

          processedCount++;
        }
      }
    }

    const durationMs = Date.now() - startTime;
    // totalExpected accounts for all 3 period variants per product×metric combo
    const totalExpected = affectedProductIds.size * impactMetrics.length * IMPACT_PERIOD_DAYS.length;

    // --- Failure mode classification ---
    // Time budget exceeded is POTENTIALLY TRANSIENT: DB load varies, so the same
    // work may complete within budget on retry. Throw so the coordinator marks
    // FAILED → outbox retries with exponential backoff. Previously-upserted rows
    // are idempotent (upsert on natural key), so retries make forward progress —
    // only unprocessed products incur real work (progressive completion).
    //
    // Upstream deferred is GENUINELY TRANSIENT: upstream session-impact projections
    // are still computing. Throw so the outbox retries once upstream completes.

    // FAIL-LOUD on time budget exceeded.
    if (timeBudgetExceeded) {
      const reasons: string[] = [
        `time_budget_exceeded (${durationMs}ms > ${MAX_TIME_BUDGET_MS}ms)`,
      ];
      if (productsExceedThreshold) {
        reasons.push(
          `products_above_threshold (${affectedProductIds.size} > ${PRODUCT_WARN_THRESHOLD})`
        );
      }
      if (metricsExceedThreshold) {
        reasons.push(
          `metrics_above_threshold (${impactMetrics.length} > ${METRIC_WARN_THRESHOLD})`
        );
      }

      this.logger.warn('ProductImpactProjectionHandler: INCOMPLETE (transient) — triggering retry', {
        context: 'ProductImpactProjectionHandler.handle',
        userId: payload.userId,
        processedCount,
        deferredDueToUpstream,
        totalExpected,
        timeBudgetExceeded,
        durationMs,
        reasons,
      });

      throw new Error(
        `ProductImpactProjectionHandler: INCOMPLETE — ${reasons.join('; ')}. ` +
        `Processed ${processedCount}/${totalExpected} combinations. ` +
        `Retrying (time budget may be transient).`
      );
    }

    // FAIL-LOUD on deferred upstream.
    // If any combinations were skipped because upstream session-impact projections
    // are non-terminal (STALE/COMPUTING/PENDING), throw so the outbox retries
    // once upstream reaches terminal state.
    if (deferredDueToUpstream > 0) {
      this.logger.warn('ProductImpactProjectionHandler: DEFERRED — upstream not terminal', {
        context: 'ProductImpactProjectionHandler.handle',
        userId: payload.userId,
        processedCount,
        deferredDueToUpstream,
        totalExpected,
        durationMs,
      });

      throw new Error(
        `ProductImpactProjectionHandler: deferred ${deferredDueToUpstream} product×metric combinations ` +
        `because upstream session-impact projections are non-terminal (STALE/COMPUTING/PENDING). ` +
        `Processed ${processedCount}/${totalExpected}. ` +
        `Outbox retry will re-process once upstream completes.`
      );
    }

    this.logger.info('ProductImpactProjectionHandler: completed', {
      context: 'ProductImpactProjectionHandler.handle',
      userId: payload.userId,
      affectedProductCount: affectedProductIds.size,
      processedProductCount: productArray.length,
      metricCount: impactMetrics.length,
      periodCount: IMPACT_PERIOD_DAYS.length,
      totalExpected,
      processedCount,
      durationMs,
    });
  }
}

/**
 * Telemetry cache projection handler.
 *
 * P0-G.1 IMPLEMENTATION: Marks session telemetry caches as STALE when health samples change.
 *
 * TRIGGER: health.samples.changed event (new samples ingested or samples deleted)
 *
 * LOGIC:
 * 1. Find sessions for this user that overlap the affected sample time range
 * 2. Mark those sessions' telemetry caches as STALE with appropriate reason
 * 3. On next getSessionTelemetry() call, watermark-based staleness detection
 *    will trigger recomputation (this handler sets staleReason for observability)
 *
 * INVARIANTS:
 * - Only marks caches STALE, never COMPUTING (avoids lock conflicts)
 * - idempotent: marking already-STALE cache has no effect
 * - Does NOT trigger recomputation - that happens lazily on read
 *
 * DESIGN DECISION: Mark STALE vs trigger recomputation
 * - STALE marking is fast (single UPDATE per session)
 * - Lazy recomputation avoids thundering herd on bulk ingests
 * - Watermark-based staleness detection handles edge cases
 */
export class TelemetryCacheProjectionHandler implements HealthProjectionHandler {
  readonly name = 'telemetry-cache';

  constructor(
    private readonly logger: LoggerService,
    private readonly cacheRepo?: SessionTelemetryCacheRepository,
    private readonly sessionRepo?: SessionRepository
  ) {}

  async handle(payload: HealthSamplesChangedPayload): Promise<void> {
    // FAIL-FAST: Dependencies are required when handler is registered.
    // If the handler was registered without its dependencies, that's a
    // bootstrap misconfiguration — throw to surface it immediately.
    // The checkpoint will be marked FAILED, triggering outbox retry.
    // This prevents the silent no-op where the event is marked COMPLETED
    // but no cache invalidation occurred (hidden stale reads).
    if (!this.cacheRepo || !this.sessionRepo) {
      const missingDeps = [
        !this.cacheRepo ? 'SessionTelemetryCacheRepository' : null,
        !this.sessionRepo ? 'SessionRepository' : null,
      ].filter(Boolean).join(', ');

      this.logger.error('TelemetryCacheProjectionHandler: MISCONFIGURATION — registered without required dependencies', {
        context: 'TelemetryCacheProjectionHandler.handle',
        userId: payload.userId,
        hasCacheRepo: !!this.cacheRepo,
        hasSessionRepo: !!this.sessionRepo,
        missingDeps,
      });

      throw new Error(
        `TelemetryCacheProjectionHandler requires ${missingDeps} but was registered without them. ` +
        `Do not register this handler unless all dependencies are available.`
      );
    }

    const startTime = Date.now();

    // Determine stale reason based on event type
    const staleReason = payload.hasDeletions ? 'DELETIONS' : 'NEW_SAMPLES';

    // GAP D FIX: Threshold-based invalidation strategy.
    // For wide time ranges (backfills) or degenerate ranges (0..0 from Gap C),
    // use O(1) coarse user-level invalidation instead of O(N) per-session iteration.
    const rangeSpanMs = payload.rangeEndMs - payload.rangeStartMs;
    const isMissingRange = payload.rangeStartMs === 0 && payload.rangeEndMs === 0;
    const isRangeInvalid = payload.rangeStartMs > payload.rangeEndMs;
    const exceedsThreshold = rangeSpanMs > COARSE_INVALIDATION_THRESHOLD_MS;
    // GAP D FIX: Also check total mutation count for narrow-but-large batches.
    // A backfill of 10k samples within a 2-hour window would pass the time threshold
    // but still cause O(N sessions) iteration, melting under load.
    const totalMutations = payload.sampleCount + payload.deletedCount;
    const exceedsSampleThreshold = totalMutations > COARSE_INVALIDATION_SAMPLE_THRESHOLD;

    if (isMissingRange || isRangeInvalid || exceedsThreshold || exceedsSampleThreshold) {
      const reason = isMissingRange
        ? 'MISSING_RANGE'
        : isRangeInvalid
          ? 'INVALID_RANGE'
          : exceedsThreshold
            ? 'RANGE_EXCEEDS_THRESHOLD'
            : 'SAMPLE_COUNT_EXCEEDS_THRESHOLD';

      this.logger.warn('TelemetryCacheProjectionHandler: using coarse user-level invalidation', {
        context: 'TelemetryCacheProjectionHandler.handle',
        userId: payload.userId,
        rangeStartMs: payload.rangeStartMs,
        rangeEndMs: payload.rangeEndMs,
        rangeSpanHours: rangeSpanMs / (60 * 60 * 1000),
        thresholdHours: COARSE_INVALIDATION_THRESHOLD_MS / (60 * 60 * 1000),
        totalMutations,
        sampleThreshold: COARSE_INVALIDATION_SAMPLE_THRESHOLD,
        reason,
        staleReason,
        sampleCount: payload.sampleCount,
        deletedCount: payload.deletedCount,
      });

      // Coarse path: single bulk UPDATE for all user caches.
      // Use time-scoped invalidation when we have a valid range (regardless of
      // whether coarse was triggered by time threshold or sample count threshold).
      // Only mark ALL caches stale when range is missing or invalid.
      const coarseStaleReason = `${staleReason}:${reason}`;
      const hasValidRange = !isMissingRange && !isRangeInvalid;
      const markedCount = hasValidRange
        ? await this.cacheRepo.markStaleByUser(
            payload.userId,
            coarseStaleReason,
            BigInt(payload.rangeStartMs),
            BigInt(payload.rangeEndMs)
          )
        : await this.cacheRepo.markStaleByUser(
            payload.userId,
            coarseStaleReason
          );

      this.logger.info('TelemetryCacheProjectionHandler: coarse invalidation completed', {
        context: 'TelemetryCacheProjectionHandler.handle',
        userId: payload.userId,
        markedCount,
        staleReason: coarseStaleReason,
        durationMs: Date.now() - startTime,
      });
      return;
    }

    // Fine-grained path: per-session invalidation for narrow, valid ranges.
    // Extend time range by window buffer (60 min before/after) to catch sessions
    // whose telemetry windows overlap the affected sample range
    const WINDOW_BUFFER_MS = 60 * 60 * 1000; // 60 minutes
    const rangeStartWithBuffer = new Date(payload.rangeStartMs - WINDOW_BUFFER_MS);
    const rangeEndWithBuffer = new Date(payload.rangeEndMs + WINDOW_BUFFER_MS);

    this.logger.info('TelemetryCacheProjectionHandler: finding affected sessions (fine-grained)', {
      context: 'TelemetryCacheProjectionHandler.handle',
      userId: payload.userId,
      rangeStartMs: payload.rangeStartMs,
      rangeEndMs: payload.rangeEndMs,
      bufferedRangeStart: rangeStartWithBuffer.toISOString(),
      bufferedRangeEnd: rangeEndWithBuffer.toISOString(),
      sampleCount: payload.sampleCount,
      deletedCount: payload.deletedCount,
      staleReason,
    });

    // Find sessions that overlap the affected range
    // Session overlaps if: sessionStart < rangeEnd AND sessionEnd > rangeStart
    const affectedSessions = await this.sessionRepo.findByUserAndTimeRange(
      payload.userId,
      rangeStartWithBuffer,
      rangeEndWithBuffer
    );

    if (affectedSessions.length === 0) {
      this.logger.debug('TelemetryCacheProjectionHandler: no affected sessions', {
        context: 'TelemetryCacheProjectionHandler.handle',
        userId: payload.userId,
        rangeStartMs: payload.rangeStartMs,
        rangeEndMs: payload.rangeEndMs,
      });
      return;
    }

    // Mark telemetry caches as STALE for each affected session
    let markedCount = 0;
    let skippedCount = 0;
    const errors: string[] = [];

    for (const session of affectedSessions) {
      try {
        // Only mark completed sessions (active sessions have no cached telemetry)
        if (!session.sessionEndTimestamp) {
          skippedCount++;
          continue;
        }

        // Mark all cache entries for this session as STALE
        // This uses a bulk update (efficient for multiple resolution/window variants)
        const updated = await this.cacheRepo.markStaleBySession(
          session.id,
          staleReason
        );

        if (updated > 0) {
          markedCount += updated;
          this.logger.debug('Marked session telemetry cache as STALE', {
            context: 'TelemetryCacheProjectionHandler.handle',
            sessionId: session.id,
            updatedCount: updated,
            staleReason,
          });
        }
      } catch (error) {
        // Log but continue - don't let one session failure stop others
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push(`${session.id}: ${errorMsg}`);
        this.logger.warn('Failed to mark session telemetry cache as STALE', {
          context: 'TelemetryCacheProjectionHandler.handle',
          sessionId: session.id,
          error: errorMsg,
        });
      }
    }

    const durationMs = Date.now() - startTime;

    this.logger.info('TelemetryCacheProjectionHandler: completed', {
      context: 'TelemetryCacheProjectionHandler.handle',
      userId: payload.userId,
      affectedSessionCount: affectedSessions.length,
      markedCount,
      skippedCount,
      errorCount: errors.length,
      durationMs,
      staleReason,
    });

    // P0 FIX: Fail-fast on ANY failure (per PRINCIPLES.md - no silent failures)
    // Previously only threw if ALL sessions failed, silently swallowing partial failures.
    // This ensures outbox retry and eventual consistency for all sessions.
    if (errors.length > 0) {
      throw new Error(
        `${errors.length}/${affectedSessions.length} sessions failed to invalidate: ${errors.slice(0, 3).join('; ')}`
      );
    }
  }
}
