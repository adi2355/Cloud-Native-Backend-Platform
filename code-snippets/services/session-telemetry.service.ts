/**
 * Session Telemetry Service
 * Computes and caches downsampled health data for session visualization
 *
 * PURPOSE:
 * - Precompute session telemetry for historical sessions
 * - Provide efficient API responses for session vitals charts
 * - Handle blended local/API data sourcing strategy
 *
 * ARCHITECTURE:
 * - Uses SHARED CONTRACT types (no local duplicates)
 * - Queries HealthSample table for raw data
 * - Applies ValueKind-aware downsampling
 * - Stores results in SessionTelemetryCache
 * - Serves cached data for API requests
 *
 * COMPUTATION MODEL:
 * - Time window: sessionStart - 60min to sessionEnd + 60min (configurable)
 * - Resolution: 1-minute buckets (default), 5-minute for historical views
 * - Bucket alignment: relative to windowStart for consistency
 * - ValueKind-aware aggregation per SESSIONHEALTHKITUI.md
 * - Gap detection on RAW timestamps BEFORE downsampling
 *
 * ERROR HANDLING:
 * - Explicit error states (never swallow errors)
 * - Returns TelemetryQueryResult with success/error/computing states
 * - Distinguishes "no data" vs "error" vs "computing"
 *
 * @see SESSIONHEALTHKITUI.md for complete implementation plan
 * @see packages/shared/src/contracts/session-telemetry.contract.ts for types
 */

import { LoggerService } from './logger.service';
import { HealthSampleRepository } from '../repositories/health-sample.repository';
import { SessionTelemetryCacheRepository, CreateSessionTelemetryCacheInput } from '../repositories/session-telemetry-cache.repository';
import { SessionRepository } from '../repositories/session.repository';
import { UserHealthWatermarkRepository } from '../repositories/user-health-watermark.repository';
import { AppError, ErrorCodes } from '../utils/AppError';
import { Session, Prisma } from '@prisma/client';

// HealthSample type from the health sample repository
// NOTE: We don't import the Prisma type directly because we use the repository pattern
interface HealthSampleRow {
  id: string;
  userId: string;
  sourceId: string;
  sourceRecordId: string;
  metricCode: string;
  value: number | null;
  startAt: Date;
  endAt: Date;
  unit: string | null;
  metadata: Prisma.JsonValue | null;
}
import {
  // Types from shared contract
  SessionTelemetryPayload,
  SessionTelemetryWindow,
  MetricSeriesData,
  ChartPoint,
  DataGap,
  MetricStats,
  TelemetryResolution,
  TelemetryFreshnessMeta,
  // Constants from shared contract
  CURRENT_SCHEMA_VERSION,
  CURRENT_COMPUTE_VERSION,
  SESSION_TELEMETRY_DEFAULT_METRICS,
  SESSION_TELEMETRY_SECONDARY_METRICS,
  RESOLUTION_BUCKET_MS,
  // Utilities from shared contract
  chooseResolution,
  getMetricDisplayConfig,
  HEALTH_METRIC_DEFINITIONS,
  type HealthMetricCode,
  getValueKind,
  isHealthMetricCode,
  FreshnessStatus,
  type StaleReason,
} from '@shared/contracts';

// Status enum (matches Prisma enum - will be generated after `npx prisma generate`)
type SessionTelemetryCacheStatus = 'PENDING' | 'COMPUTING' | 'READY' | 'FAILED' | 'NO_DATA' | 'STALE';

// Type for cached entry (until Prisma generates SessionTelemetryCache)
interface CachedTelemetryEntry {
  id: string;
  sessionId: string;
  userId: string;
  windowMinutes: number;
  resolution: string;
  windowStartMs: bigint;
  windowEndMs: bigint;
  sessionStartMs: bigint;
  sessionEndMs: bigint;
  metricsJson: Prisma.JsonValue;
  schemaVersion: number;
  computeVersion: number;
  computedAt: Date;
  computationDurationMs: number | null;
  rawSampleCount: number;
  status: SessionTelemetryCacheStatus;
  errorMessage: string | null;
  // P0-G.1: Watermark-based staleness tracking
  sourceWatermark: bigint | null;
  staleReason: string | null;
  // P0-G.1 ADDITIONS:
  staleSinceWatermark: bigint | null;
  attempts: number;
  // Timestamps for error tracking
  updatedAt: Date;
}

// Types

/**
 * Options for telemetry computation.
 */
export interface ComputeTelemetryOptions {
  windowMinutes?: number;   // Default: 60
  resolution?: TelemetryResolution;  // '1m' | '5m'
  metricCodes?: readonly HealthMetricCode[];  // Specific metrics to compute
}

/**
 * Result of a telemetry query operation.
 * INVARIANT: Explicitly tracks success/error/computing states
 */
export interface TelemetryQueryResult {
  /** Whether the query succeeded */
  success: boolean;
  /** Telemetry payload (null if error or computing) */
  payload: SessionTelemetryPayload | null;
  /**
   * Current state of the query.
   *
   * P0-G.1: Added 'stale' state for watermark-based staleness detection.
   * GAP 1a: Added 'failed' state for infrastructure failures (watermark unavailable).
   *
   * State semantics:
   * - 'ready': Data is fresh and available
   * - 'computing': Computation in progress, retry after delay
   * - 'no_data': No health data exists for this session
   * - 'error': Query/computation failed (check errorMessage/errorSource)
   * - 'stale': Data is available but outdated (watermark mismatch), recompute triggered
   * - 'failed': Infrastructure failure — last-known data returned but freshness unknown
   *             (e.g., watermark DB unavailable). Distinct from 'error' (which means no data
   *             at all) and 'stale' (which means we KNOW data is outdated).
   */
  state: 'ready' | 'computing' | 'no_data' | 'error' | 'stale' | 'failed';
  /** Error message if state is 'error' or 'failed' */
  errorMessage?: string;
  /** Error source for debugging */
  errorSource?: 'query' | 'computation' | 'validation' | 'authorization';
  /**
   * Structured error code for 'failed' state.
   * GAP 1a: Enables the frontend to distinguish infrastructure failure reasons
   * (e.g., 'WATERMARK_UNAVAILABLE') without parsing error message strings.
   */
  errorCode?: string;
  /** Computation duration in milliseconds */
  durationMs: number;
  /** Retry-after hint in seconds (only meaningful for computing/stale/failed states) */
  retryAfterSeconds?: number;
}

/**
 * Result of a telemetry computation execution (worker-facing).
 */
export interface TelemetryComputeResult extends TelemetryQueryResult {
  /** Whether this call actually performed computation */
  wasComputed: boolean;
}

/**
 * Scheduler interface for enqueueing telemetry computation.
 * Implemented by SessionTelemetryQueueService to avoid tight coupling.
 */
export interface ScheduleTelemetryComputeParams {
  sessionId: string;
  userId: string;
  sessionStartMs: number;
  sessionEndMs: number;
  windowMinutes: number;
  resolution: TelemetryResolution;
  reason: 'session_completed' | 'cache_miss' | 'late_ingest' | 'backfill';
  correlationId?: string;
  delayMs?: number;
  forceRecompute?: boolean;
  dedupeKey?: string;
  computeVersion?: number;
}

export interface ScheduleTelemetryComputeResult {
  queued: boolean;
  /**
   * Result state of the scheduling attempt.
   *
   * P0-G.1: Added 'failed' state to distinguish infrastructure failures (Redis down)
   * from intentional skips (queue disabled). This allows the client to show
   * appropriate error messaging and retry behavior.
   *
   * - 'scheduled': Job successfully queued
   * - 'already_cached': Cache entry exists, no need to compute
   * - 'already_computing': Computation already in progress
   * - 'skipped': Intentionally skipped (queue disabled, invalid params)
   * - 'failed': Infrastructure failure (Redis unavailable, etc.)
   */
  state: 'scheduled' | 'already_cached' | 'already_computing' | 'skipped' | 'failed';
  retryAfterSeconds: number;
  jobId?: string;
  reason?: string;
}

export interface TelemetryComputeScheduler {
  scheduleTelemetryCompute(params: ScheduleTelemetryComputeParams): Promise<ScheduleTelemetryComputeResult>;
  getRetryAfterSeconds?(): number;
}

/**
 * Default metrics returned when metricCodes is not specified.
 */
const DEFAULT_METRIC_CODES: readonly HealthMetricCode[] = SESSION_TELEMETRY_DEFAULT_METRICS as unknown as readonly HealthMetricCode[];

// P0-G FIX: Timeout constants for hot path latency budget

/**
 * Timeout for inline computation on cache miss.
 *
 * P0-G FIX: Ensures hot path meets P99 latency budget (200ms).
 * If computation takes longer, we return 'computing' state with retryAfterSeconds.
 *
 * 150ms allows ~50ms overhead for response serialization and network.
 * Can be overridden via SESSION_TELEMETRY_INLINE_TIMEOUT_MS environment variable.
 */
const INLINE_COMPUTE_TIMEOUT_MS = parseInt(
  process.env.SESSION_TELEMETRY_INLINE_TIMEOUT_MS ?? '150',
  10
);

/**
 * Sentinel value for computation timeout.
 */
const TIMEOUT_SENTINEL = Symbol('COMPUTATION_TIMEOUT');

// Phase 0.5: Freshness SLA & Bounded Compute Constants

/**
 * Freshness SLA targets for telemetry recomputation.
 *
 * Defines the expected time from stale detection to fresh cache under
 * normal load. Instrumented via structured logging for monitoring/alerting.
 *
 * - p95: 95th percentile target (30 seconds)
 * - p99: 99th percentile target (2 minutes)
 */
const FRESHNESS_SLA = {
  p95TargetMs: 30_000,
  p99TargetMs: 120_000,
} as const;

/**
 * Maximum number of concurrent in-process telemetry computations.
 *
 * Bounds the CPU and DB query load from async recomputation.
 * Each compute issues O(metrics * pages) DB queries — unbounded concurrency
 * can saturate the connection pool under thundering herd.
 *
 * Default: 3. Configurable via SESSION_TELEMETRY_MAX_CONCURRENT_COMPUTES.
 */
const MAX_CONCURRENT_COMPUTES = parseInt(
  process.env.SESSION_TELEMETRY_MAX_CONCURRENT_COMPUTES ?? '3',
  10
);

/**
 * Maximum number of pending compute tasks in the in-process queue.
 *
 * When the queue is full, new tasks are shed (rejected) with a
 * 'backpressure_shed' log event. The caller returns 'computing' state
 * to the UI, which will retry after the Retry-After hint.
 *
 * Default: 50. Configurable via SESSION_TELEMETRY_MAX_PENDING_COMPUTES.
 */
const MAX_PENDING_COMPUTE_DEPTH = parseInt(
  process.env.SESSION_TELEMETRY_MAX_PENDING_COMPUTES ?? '50',
  10
);

// Phase 0.5: BoundedComputeCoordinator

/**
 * Represents a pending telemetry compute task.
 */
interface ComputeTask {
  readonly sessionId: string;
  readonly userId: string;
  readonly windowMinutes: number;
  readonly resolution: TelemetryResolution;
  /** Timestamp when the task was enqueued (for SLA tracking) */
  readonly enqueuedAtMs: number;
}

/**
 * Result of attempting to enqueue a compute task.
 *
 * - 'queued': Task accepted into the pending queue
 * - 'deduped': Identical task already in-flight or pending (no-op)
 * - 'shed': Queue is full, task rejected (backpressure)
 */
type ComputeEnqueueResult = 'queued' | 'deduped' | 'shed';

/**
 * Snapshot of coordinator state for observability.
 */
interface ComputeCoordinatorStats {
  readonly inflight: number;
  readonly pending: number;
  readonly maxConcurrency: number;
  readonly maxPending: number;
  readonly totalCompleted: number;
  readonly totalFailed: number;
  readonly totalShed: number;
}

/**
 * Bounded in-process coordinator for telemetry recomputation.
 *
 * Phase 0.5 FIX: Replaces unbounded fire-and-forget promises with a
 * bounded concurrent work pool that provides:
 *
 * 1. **Bounded concurrency**: At most `maxConcurrency` computes run in parallel.
 *    Prevents connection pool saturation under thundering herd.
 *
 * 2. **Bounded queue depth**: At most `maxPending` tasks wait in queue.
 *    When full, new tasks are shed (rejected) — caller returns 'computing'
 *    to the UI, which retries via Retry-After hint.
 *
 * 3. **Deduplication**: Tasks are keyed by `${sessionId}:${resolution}`.
 *    Duplicate requests for the same session are no-ops.
 *
 * 4. **SLA instrumentation**: Tracks enqueue-to-complete duration and logs
 *    warnings when FRESHNESS_SLA thresholds are exceeded.
 *
 * NON-DURABLE: In-process only. Process restart loses all pending/in-flight tasks.
 * This is acceptable because the cache lock system handles crash recovery:
 * stale COMPUTING rows are taken over after 5 minutes by the next request.
 *
 * INVARIANT: The coordinator does NOT hold references to SessionTelemetryService.
 * Compute functions are passed at enqueue time to avoid circular dependencies.
 */
class BoundedComputeCoordinator {
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly pending: Array<{ task: ComputeTask; computeFn: () => Promise<unknown> }> = [];
  private readonly pendingKeys = new Set<string>();

  // Counters for observability
  private totalCompleted = 0;
  private totalFailed = 0;
  private totalShed = 0;

  constructor(
    private readonly maxConcurrency: number,
    private readonly maxPending: number,
    private readonly logger: LoggerService,
  ) {
    if (maxConcurrency < 1) {
      throw new Error(`BoundedComputeCoordinator: maxConcurrency must be >= 1 (got ${maxConcurrency})`);
    }
    if (maxPending < 0) {
      throw new Error(`BoundedComputeCoordinator: maxPending must be >= 0 (got ${maxPending})`);
    }
  }

  /**
   * Enqueue a telemetry compute task.
   *
   * @param task - The compute task metadata
   * @param computeFn - The function to execute (closure capturing service method)
   * @returns 'queued', 'deduped', or 'shed'
   */
  enqueue(task: ComputeTask, computeFn: () => Promise<unknown>): ComputeEnqueueResult {
    const key = this.taskKey(task);

    // Dedup: already in-flight or pending
    if (this.inflight.has(key) || this.pendingKeys.has(key)) {
      this.logger.debug('telemetry.compute.deduped', {
        context: 'BoundedComputeCoordinator.enqueue',
        sessionId: task.sessionId,
        resolution: task.resolution,
        inflight: this.inflight.size,
        pending: this.pending.length,
      });
      return 'deduped';
    }

    // Backpressure: queue full
    if (this.pending.length >= this.maxPending) {
      this.totalShed++;
      this.logger.warn('telemetry.compute.backpressure_shed', {
        context: 'BoundedComputeCoordinator.enqueue',
        sessionId: task.sessionId,
        resolution: task.resolution,
        inflight: this.inflight.size,
        pending: this.pending.length,
        maxPending: this.maxPending,
        totalShed: this.totalShed,
      });
      return 'shed';
    }

    // Accept task
    this.pending.push({ task, computeFn });
    this.pendingKeys.add(key);
    this.logger.debug('telemetry.compute.queued', {
      context: 'BoundedComputeCoordinator.enqueue',
      sessionId: task.sessionId,
      resolution: task.resolution,
      inflight: this.inflight.size,
      pending: this.pending.length,
    });

    // Attempt to start work immediately (non-blocking)
    this.drain();
    return 'queued';
  }

  /**
   * Get current coordinator state for observability.
   */
  getStats(): ComputeCoordinatorStats {
    return {
      inflight: this.inflight.size,
      pending: this.pending.length,
      maxConcurrency: this.maxConcurrency,
      maxPending: this.maxPending,
      totalCompleted: this.totalCompleted,
      totalFailed: this.totalFailed,
      totalShed: this.totalShed,
    };
  }

  /**
   * Drain pending tasks up to concurrency limit.
   * Called after enqueue and after each task completes.
   */
  private drain(): void {
    while (this.inflight.size < this.maxConcurrency && this.pending.length > 0) {
      const item = this.pending.shift()!;
      const key = this.taskKey(item.task);
      this.pendingKeys.delete(key);

      const promise = this.executeTask(item.task, item.computeFn, key);
      this.inflight.set(key, promise);
    }
  }

  /**
   * Execute a single compute task with SLA tracking and error handling.
   */
  private async executeTask(
    task: ComputeTask,
    computeFn: () => Promise<unknown>,
    key: string
  ): Promise<void> {
    const computeStartMs = Date.now();
    const queueDurationMs = computeStartMs - task.enqueuedAtMs;

    this.logger.info('telemetry.compute.started', {
      context: 'BoundedComputeCoordinator.executeTask',
      sessionId: task.sessionId,
      resolution: task.resolution,
      queueDurationMs,
      inflight: this.inflight.size,
      pending: this.pending.length,
    });

    try {
      await computeFn();

      const computeDurationMs = Date.now() - computeStartMs;
      const totalDurationMs = Date.now() - task.enqueuedAtMs;
      this.totalCompleted++;

      // SLA instrumentation
      this.logger.info('telemetry.compute.completed', {
        context: 'BoundedComputeCoordinator.executeTask',
        sessionId: task.sessionId,
        resolution: task.resolution,
        computeDurationMs,
        totalDurationMs,
        queueDurationMs,
        slaP95Met: totalDurationMs <= FRESHNESS_SLA.p95TargetMs,
        slaP99Met: totalDurationMs <= FRESHNESS_SLA.p99TargetMs,
      });

      if (totalDurationMs > FRESHNESS_SLA.p99TargetMs) {
        this.logger.warn('telemetry.freshness.sla_p99_violated', {
          context: 'BoundedComputeCoordinator.executeTask',
          sessionId: task.sessionId,
          resolution: task.resolution,
          totalDurationMs,
          targetMs: FRESHNESS_SLA.p99TargetMs,
        });
      } else if (totalDurationMs > FRESHNESS_SLA.p95TargetMs) {
        this.logger.warn('telemetry.freshness.sla_p95_violated', {
          context: 'BoundedComputeCoordinator.executeTask',
          sessionId: task.sessionId,
          resolution: task.resolution,
          totalDurationMs,
          targetMs: FRESHNESS_SLA.p95TargetMs,
        });
      }
    } catch (error) {
      this.totalFailed++;
      this.logger.error('telemetry.compute.failed', {
        context: 'BoundedComputeCoordinator.executeTask',
        sessionId: task.sessionId,
        resolution: task.resolution,
        error: error instanceof Error ? error.message : String(error),
        computeDurationMs: Date.now() - computeStartMs,
      });
    } finally {
      this.inflight.delete(key);
      // Process next pending task (if any)
      this.drain();
    }
  }

  private taskKey(task: ComputeTask): string {
    return `${task.sessionId}:${task.resolution}`;
  }
}

/**
 * ALL metrics to compute and cache.
 * This keeps cache key stable at (sessionId, windowMinutes, resolution, computeVersion).
 * Individual requests can filter the response to requested metrics.
 */
const ALL_TELEMETRY_METRICS: readonly HealthMetricCode[] = [
  ...SESSION_TELEMETRY_DEFAULT_METRICS,
  ...SESSION_TELEMETRY_SECONDARY_METRICS,
] as unknown as readonly HealthMetricCode[];

// Service

/**
 * Service for session telemetry computation and caching.
 */
export class SessionTelemetryService {
  /**
   * Phase 0.5: Bounded compute coordinator for async recomputation.
   * Replaces unbounded fire-and-forget promises with a concurrent work pool
   * that provides backpressure, dedup, and SLA tracking.
   */
  private readonly computeCoordinator: BoundedComputeCoordinator;

  constructor(
    private healthSampleRepo: HealthSampleRepository,
    private cacheRepo: SessionTelemetryCacheRepository,
    private sessionRepo: SessionRepository,
    private logger: LoggerService,
    private watermarkRepo?: UserHealthWatermarkRepository
  ) {
    if (!healthSampleRepo) {
      throw new Error('SessionTelemetryService: HealthSampleRepository is required');
    }
    if (!cacheRepo) {
      throw new Error('SessionTelemetryService: SessionTelemetryCacheRepository is required');
    }
    if (!sessionRepo) {
      throw new Error('SessionTelemetryService: SessionRepository is required');
    }
    if (!logger) {
      throw new Error('SessionTelemetryService: LoggerService is required');
    }
    // Note: watermarkRepo is optional for backward compatibility during rollout
    // When not provided, falls back to time-based TTL staleness detection

    // Phase 0.5: Create bounded compute coordinator
    this.computeCoordinator = new BoundedComputeCoordinator(
      MAX_CONCURRENT_COMPUTES,
      MAX_PENDING_COMPUTE_DEPTH,
      logger,
    );
  }

  // P0-G FIX: Helper methods for timeout-bounded computation

  /**
   * Execute a computation with timeout guard.
   *
   * P0-G FIX: Ensures hot path meets P99 latency budget.
   * If computation exceeds timeout, returns TIMEOUT_SENTINEL.
   *
   * IMPORTANT: The original promise continues running even after timeout.
   * This is acceptable because the computation will still update the cache,
   * making the next request faster.
   *
   * @param promise - The computation promise
   * @param timeoutMs - Timeout in milliseconds
   * @returns The computation result or TIMEOUT_SENTINEL
   */
  private async withComputeTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<T | typeof TIMEOUT_SENTINEL> {
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
      clearTimeout(timeoutId!);
    }
  }

  /**
   * Trigger async recomputation via bounded compute coordinator.
   *
   * Phase 0.5 FIX: Replaces unbounded fire-and-forget promises with a
   * bounded concurrent work pool that provides:
   * - Bounded concurrency (MAX_CONCURRENT_COMPUTES)
   * - Bounded queue depth (MAX_PENDING_COMPUTE_DEPTH)
   * - Deduplication by (sessionId, resolution)
   * - SLA instrumentation (stale→ready timing)
   *
   * The computation will:
   * 1. Be enqueued in the coordinator (with dedup and backpressure)
   * 2. When a slot opens, acquire compute lock (prevents thundering herd)
   * 3. If lock acquired, recompute and update cache
   * 4. If lock not acquired (concurrent request), no-op
   *
   * Errors are handled by the coordinator (logged, not thrown).
   *
   * @param sessionId - Session to recompute
   * @param userId - User ID for authorization
   * @param windowMinutes - Window size in minutes
   * @param resolution - Resolution string
   */
  private triggerAsyncRecompute(
    sessionId: string,
    userId: string,
    windowMinutes: number,
    resolution: TelemetryResolution
  ): void {
    const result = this.computeCoordinator.enqueue(
      {
        sessionId,
        userId,
        windowMinutes,
        resolution,
        enqueuedAtMs: Date.now(),
      },
      () => this.computeTelemetryForSession({
        sessionId,
        userId,
        options: { windowMinutes, resolution },
        forceRecompute: true,
      }),
    );

    if (result === 'shed') {
      this.logger.warn('telemetry.freshness.backpressure_shed', {
        context: 'SessionTelemetryService.triggerAsyncRecompute',
        sessionId,
        resolution,
        ...this.computeCoordinator.getStats(),
      });
    } else if (result === 'deduped') {
      this.logger.debug('Async recompute deduped (already in-flight/pending)', {
        context: 'SessionTelemetryService.triggerAsyncRecompute',
        sessionId,
        resolution,
      });
    }
    // 'queued' is the normal case — no special logging needed (coordinator logs it)
  }

  /**
   * Get or compute session telemetry.
   * Returns cached data if available and valid, otherwise computes and caches.
   *
   * INVARIANTS:
   * - Returns explicit TelemetryQueryResult with state
   * - state: 'computing' means client should retry with Retry-After
   * - state: 'no_data' means computation succeeded but no health data exists
   * - state: 'error' means query failed (check errorMessage/errorSource)
   *
   * @param sessionId - Session ID
   * @param userId - User ID (for authorization check)
   * @param options - Computation options
   * @returns Query result with payload, state, and error info
   */
  async getSessionTelemetry(
    sessionId: string,
    userId: string,
    options: ComputeTelemetryOptions = {},
    context?: {
      /** @deprecated No longer used - inline compute is now the default */
      scheduler?: TelemetryComputeScheduler;
      correlationId?: string;
      /**
       * Force inline recomputation on cache miss (default: false).
       *
       * Without force=true, cache miss triggers async compute and returns
       * 'computing' state immediately (meets P99 latency budget).
       *
       * With force=true, blocks on inline compute bounded by INLINE_COMPUTE_TIMEOUT_MS.
       * Intended for dev tools and explicit user-triggered refresh.
       */
      force?: boolean;
    }
  ): Promise<TelemetryQueryResult> {
    const startTime = Date.now();
    const { windowMinutes = 60, metricCodes: requestedMetrics } = options;
    const explicitResolution = options.resolution;

    try {
      // 1. Fetch session and validate ownership
      const session = await this.sessionRepo.findById(sessionId, userId);
      if (!session) {
        return {
          success: false,
          payload: null,
          state: 'error',
          errorMessage: `Session ${sessionId} not found`,
          errorSource: 'query',
          durationMs: Date.now() - startTime,
        };
      }
      if (session.userId !== userId) {
        return {
          success: false,
          payload: null,
          state: 'error',
          errorMessage: 'Not authorized to access this session',
          errorSource: 'authorization',
          durationMs: Date.now() - startTime,
        };
      }

      // 2. Session must be completed to compute (active sessions have no stable end time)
      if (!session.sessionEndTimestamp) {
        this.logger.debug('Session is active, cannot compute stable telemetry', {
          context: 'SessionTelemetryService.getSessionTelemetry',
          sessionId,
          status: session.status,
        });
        return {
          success: true,
          payload: null,
          state: 'no_data',  // Active session = no cached data available
          durationMs: Date.now() - startTime,
        };
      }

      const sessionStartMs = session.sessionStartTimestamp.getTime();
      const sessionEndMs = session.sessionEndTimestamp!.getTime();
      const windowDurationMs = (sessionEndMs - sessionStartMs) + (windowMinutes * 60 * 1000 * 2);
      const resolvedResolution = explicitResolution ?? chooseResolution(windowDurationMs);

      // 3. Check cache (using resolved resolution to avoid mismatch)
      // P0-G.1: Pass userId for watermark-based staleness detection
      const cacheResult = await this.checkCache(sessionId, userId, windowMinutes, resolvedResolution);
      if (cacheResult) {
        // Cache stores ALL metrics (default + secondary), but API may request a subset
        const filteredPayload = cacheResult.payload
          ? this.filterPayloadMetrics(cacheResult.payload, requestedMetrics)
          : null;

        // P0-G FIX: For stale data, trigger async recompute then return immediately
        // This meets P99 latency budget while ensuring eventual consistency
        if (cacheResult.state === 'stale') {
          this.logger.info('Returning stale data, triggering async recompute', {
            context: 'SessionTelemetryService.getSessionTelemetry',
            sessionId,
            windowMinutes,
            resolution: resolvedResolution,
          });
          this.triggerAsyncRecompute(
            sessionId,
            userId,
            windowMinutes,
            resolvedResolution
          );
        }

        return {
          ...cacheResult,
          payload: filteredPayload,
          durationMs: Date.now() - startTime,
        };
      }

      // 4. CACHE MISS: Route based on `force` parameter
      //
      // ARCHITECTURAL DECISION (Phase 0.4, 2026-02-04):
      // - DEFAULT (force=false): Fire-and-forget async compute → return 'computing' immediately
      // - FORCE (force=true): Inline compute bounded by INLINE_COMPUTE_TIMEOUT_MS
      //
      // This ensures:
      // - P99 latency budget (200ms) is met on the read path (no blocking by default)
      // - Explicit force=true allows dev tools / user-triggered refresh to block
      // - No thundering herd (compute lock prevents duplicate computation)
      // - First async request triggers compute; subsequent requests hit cache

      const forceInline = context?.force ?? false;

      if (!forceInline) {
        // ── DEFAULT PATH: Async compute → return 'computing' immediately ──
        //
        // triggerAsyncRecompute is fire-and-forget: it calls computeTelemetryForSession
        // with forceRecompute=true (required for expired NO_DATA/READY entries) and
        // handles errors internally. The next request will hit the freshly computed cache.
        this.logger.info('Cache miss - triggering async compute (force=false)', {
          context: 'SessionTelemetryService.getSessionTelemetry',
          sessionId,
          windowMinutes,
          resolution: resolvedResolution,
          correlationId: context?.correlationId,
        });

        this.triggerAsyncRecompute(
          sessionId,
          userId,
          windowMinutes,
          resolvedResolution
        );

        return {
          success: true,
          payload: null,
          state: 'computing',
          retryAfterSeconds: 3,
          durationMs: Date.now() - startTime,
        };
      }

      // ── FORCE PATH: Inline compute with timeout guard ──
      //
      // Used for explicit user-triggered refresh (force=true query param).
      // Bounded by INLINE_COMPUTE_TIMEOUT_MS to prevent unbounded blocking.
      this.logger.info('Computing session telemetry inline (force=true, cache miss)', {
        context: 'SessionTelemetryService.getSessionTelemetry',
        sessionId,
        windowMinutes,
        resolution: resolvedResolution,
        timeoutMs: INLINE_COMPUTE_TIMEOUT_MS,
        correlationId: context?.correlationId,
      });

      //
      // When checkCache() returns null, the entry could be in any non-serveable state:
      // STALE, PENDING, FAILED (>5min), expired NO_DATA (>2min), expired READY (>5min),
      // or COMPUTING (falling through for stale lock recovery).
      //
      // For STALE/PENDING/FAILED: tryAcquireComputeLock handles them regardless of forceRecompute.
      // For NO_DATA/READY (expired by TTL): tryAcquireComputeLock REQUIRES forceRecompute=true
      // to update these "already computed" statuses to COMPUTING.
      const computePromise = this.computeTelemetryForSession({
        sessionId,
        userId,
        options: {
          windowMinutes,
          resolution: resolvedResolution,
          metricCodes: requestedMetrics,
        },
        forceRecompute: true,
      });

      // Apply timeout to computation
      const computeResultOrTimeout = await this.withComputeTimeout(
        computePromise,
        INLINE_COMPUTE_TIMEOUT_MS
      );

      // Handle timeout case
      if (computeResultOrTimeout === TIMEOUT_SENTINEL) {
        this.logger.info('Inline compute timed out (force=true), returning computing state', {
          context: 'SessionTelemetryService.getSessionTelemetry',
          sessionId,
          timeoutMs: INLINE_COMPUTE_TIMEOUT_MS,
        });
        return {
          success: true,
          payload: null,
          state: 'computing',
          retryAfterSeconds: 2,
          durationMs: Date.now() - startTime,
        };
      }

      const computeResult = computeResultOrTimeout;

      // Log computation result for observability
      this.logger.info('Session telemetry computed inline (force=true)', {
        context: 'SessionTelemetryService.getSessionTelemetry',
        sessionId,
        state: computeResult.state,
        wasComputed: computeResult.wasComputed,
        durationMs: computeResult.durationMs,
        metricCount: computeResult.payload ? Object.keys(computeResult.payload.metrics).length : 0,
      });

      // Filter payload to requested metrics and return
      const filteredPayload = computeResult.payload
        ? this.filterPayloadMetrics(computeResult.payload, requestedMetrics)
        : null;

      return {
        success: computeResult.success,
        payload: filteredPayload,
        state: computeResult.state,
        errorMessage: computeResult.errorMessage,
        errorSource: computeResult.errorSource,
        durationMs: Date.now() - startTime,
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.logger.error('Telemetry computation failed', {
        context: 'SessionTelemetryService.getSessionTelemetry',
        sessionId,
        error: error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : String(error),
      });

      return {
        success: false,
        payload: null,
        state: 'error',
        errorMessage,
        errorSource: 'computation',
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Compute telemetry for a session (worker/internal use).
   * Respects compute locks and returns explicit state.
   *
   * and compute directly against that row. This fixes the worker/lock deadlock
   * where the scheduler pre-creates a COMPUTING row and the worker would exit
   * without computing because it sees COMPUTING status.
   *
   * @param params.lockRowId - Pre-created lock row ID from scheduler (skip lock acquisition)
   * @param params.computeVersion - Version to use for cache key (defaults to CURRENT_COMPUTE_VERSION)
   */
  async computeTelemetryForSession(params: {
    sessionId: string;
    userId: string;
    options?: ComputeTelemetryOptions;
    forceRecompute?: boolean;
    /** Pre-created lock row ID from scheduler - skip lock acquisition when provided */
    lockRowId?: string;
    /** Compute version for backfills - defaults to CURRENT_COMPUTE_VERSION */
    computeVersion?: number;
  }): Promise<TelemetryComputeResult> {
    const startTime = Date.now();
    const { windowMinutes = 60 } = params.options ?? {};
    const explicitResolution = params.options?.resolution;
    const targetComputeVersion = params.computeVersion ?? CURRENT_COMPUTE_VERSION;

    try {
      const session = await this.sessionRepo.findById(params.sessionId, params.userId);
      if (!session) {
        return {
          success: false,
          payload: null,
          state: 'error',
          errorMessage: `Session ${params.sessionId} not found`,
          errorSource: 'query',
          durationMs: Date.now() - startTime,
          wasComputed: false,
        };
      }

      if (!session.sessionEndTimestamp) {
        return {
          success: true,
          payload: null,
          state: 'no_data',
          durationMs: Date.now() - startTime,
          wasComputed: false,
        };
      }

      const sessionStartMs = session.sessionStartTimestamp.getTime();
      const sessionEndMs = session.sessionEndTimestamp.getTime();
      const windowDurationMs = (sessionEndMs - sessionStartMs) + (windowMinutes * 60 * 1000 * 2);
      const resolvedResolution = explicitResolution ?? chooseResolution(windowDurationMs);

      // The scheduler already created a COMPUTING row; we must compute against it.
      if (params.lockRowId) {
        this.logger.debug('Using pre-created lock row from scheduler', {
          context: 'SessionTelemetryService.computeTelemetryForSession',
          sessionId: params.sessionId,
          lockRowId: params.lockRowId,
          computeVersion: targetComputeVersion,
        });

        const result = await this.computeAndCacheTelemetry(
          session,
          {
            ...params.options,
            resolution: resolvedResolution,
          },
          startTime,
          params.lockRowId,
          targetComputeVersion
        );

        return {
          ...result,
          wasComputed: true,
        };
      }

      // No lockRowId provided - standard path with cache check and lock acquisition
      if (!params.forceRecompute) {
        const cached = await this.checkCache(params.sessionId, params.userId, windowMinutes, resolvedResolution, targetComputeVersion);
        if (cached) {
          return {
            ...cached,
            durationMs: Date.now() - startTime,
            wasComputed: false,
          };
        }
      }

      // STALE LOCK RECOVERY: Pass staleAfterMinutes to allow inline recovery of abandoned locks.
      // Without workers, COMPUTING rows can become permanently stuck. This threshold determines
      // when a COMPUTING lock is considered abandoned and can be taken over.
      // 5 minutes is conservative - typical inline compute takes <1 second.
      const STALE_LOCK_THRESHOLD_MINUTES = 5;

      const lockResult = await this.cacheRepo.tryAcquireComputeLock(
        params.sessionId,
        params.userId,
        sessionStartMs,
        sessionEndMs,
        windowMinutes,
        resolvedResolution as string,
        targetComputeVersion,
        undefined,
        params.forceRecompute ?? false,
        STALE_LOCK_THRESHOLD_MINUTES
      );

      // Log if we recovered a stale lock (observability for diagnosing stuck states)
      if (lockResult.recoveredStaleLock) {
        this.logger.warn('Recovered stale telemetry lock during inline compute', {
          context: 'SessionTelemetryService.computeTelemetryForSession',
          sessionId: params.sessionId,
          lockRowId: lockResult.lockRowId,
          staleAfterMinutes: STALE_LOCK_THRESHOLD_MINUTES,
        });
      }

      if (!lockResult.shouldCompute) {
        if (lockResult.existingStatus === 'COMPUTING') {
          // If we get here after stale recovery attempt, it means there's a legitimate
          // in-flight compute (fresh lock). Return computing state with retry hint.
          return {
            success: true,
            payload: null,
            state: 'computing',
            durationMs: Date.now() - startTime,
            wasComputed: false,
            retryAfterSeconds: 2, // Hint to retry shortly - in-flight compute should finish quickly
          };
        }

        const cached = await this.checkCache(params.sessionId, params.userId, windowMinutes, resolvedResolution, targetComputeVersion);
        if (cached) {
          return {
            ...cached,
            durationMs: Date.now() - startTime,
            wasComputed: false,
          };
        }

        return {
          success: true,
          payload: null,
          state: 'computing',
          durationMs: Date.now() - startTime,
          wasComputed: false,
        };
      }

      const result = await this.computeAndCacheTelemetry(
        session,
        {
          ...params.options,
          resolution: resolvedResolution,
        },
        startTime,
        lockResult.lockRowId,
        targetComputeVersion
      );

      return {
        ...result,
        wasComputed: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        payload: null,
        state: 'error',
        errorMessage,
        errorSource: 'computation',
        durationMs: Date.now() - startTime,
        wasComputed: false,
      };
    }
  }

  /**
   * Check cache and return result if available.
   *
   * P0-G.1: Watermark-based staleness detection.
   * If cache.sourceWatermark < currentWatermark, cache is stale.
   * Falls back to time-based TTL if watermarkRepo is not available.
   *
   * @param sessionId - Session ID
   * @param userId - User ID (for watermark lookup)
   * @param windowMinutes - Window size in minutes
   * @param resolution - Resolution string ('1m' or '5m')
   * @param computeVersion - Compute version to check (defaults to CURRENT_COMPUTE_VERSION)
   */
  private async checkCache(
    sessionId: string,
    userId: string,
    windowMinutes: number,
    resolution: string,
    computeVersion: number = CURRENT_COMPUTE_VERSION
  ): Promise<Omit<TelemetryQueryResult, 'durationMs'> | null> {
    const cached = await this.cacheRepo.findByKey({
      sessionId,
      windowMinutes,
      resolution,
      computeVersion,
    }) as CachedTelemetryEntry | null;

    if (!cached) {
      return null;
    }

    // Phase 0.5: Get current watermark for staleness detection.
    // Watermark read is CONTRACTUAL when watermarkRepo is injected.
    // Failure returns 'failed' state — no silent TTL fallback.
    let currentWatermark: bigint | null = null;
    if (this.watermarkRepo) {
      try {
        currentWatermark = await this.watermarkRepo.getSequenceNumber(userId);
      } catch (error) {
        // Phase 0.5 FIX: Watermark read is part of the freshness contract.
        // Do NOT fall back to TTL — return 'failed' state with last-known data.
        // The UI shows a degraded badge and retries.
        this.logger.error('Watermark read failed — freshness unknown, returning failed state', {
          context: 'SessionTelemetryService.checkCache',
          sessionId,
          userId,
          cachedStatus: cached.status,
          error: error instanceof Error ? error.message : String(error),
        });

        // Return last-known data with explicit 'failed' state (freshness unknown)
        // matches the envelope state. Without this, cached READY entries would return
        // freshness.status='READY' even though the query state is 'failed'.
        if (cached.status === 'READY') {
          return {
            success: true,
            payload: this.deserializePayload(cached, resolution as TelemetryResolution, 'FAILED'),
            state: 'failed',
            errorMessage: 'Watermark unavailable — data freshness unknown',
            errorCode: 'WATERMARK_UNAVAILABLE',
            retryAfterSeconds: 5,
          };
        }
        if (cached.status === 'NO_DATA') {
          return {
            success: true,
            payload: this.createEmptyPayload(cached, resolution as TelemetryResolution, 'FAILED'),
            state: 'failed',
            errorMessage: 'Watermark unavailable — data freshness unknown',
            errorCode: 'WATERMARK_UNAVAILABLE',
            retryAfterSeconds: 5,
          };
        }
        // For non-serveable statuses (COMPUTING, STALE, PENDING, FAILED):
        // return null to trigger recompute via standard path
        return null;
      }
    }

    switch (cached.status) {
      case 'READY': {
        // P0-G.1: Watermark-based staleness detection (PRIMARY)
        // If we have watermarks, use them for precise staleness detection
        if (currentWatermark !== null && cached.sourceWatermark !== null) {
          if (currentWatermark > cached.sourceWatermark) {
            // P0-G FIX: Return STALE data instead of null
            // This allows the frontend to show stale data with a badge while
            // async recompute runs in background. Meets P99 latency budget.
            //
            // DESIGN DECISION: Return stale data immediately vs blocking on recompute
            // - Stale data is STILL VALID (just not latest) - acceptable UX
            // - Async recompute updates cache for next request
            // - Prevents P99 latency spikes from blocking on recomputation
            this.logger.info('READY cache entry stale (watermark mismatch) - returning stale data', {
              context: 'SessionTelemetryService.checkCache',
              sessionId,
              userId,
              cacheWatermark: cached.sourceWatermark.toString(),
              currentWatermark: currentWatermark.toString(),
              watermarkDelta: (currentWatermark - cached.sourceWatermark).toString(),
              rawSampleCount: cached.rawSampleCount,
              staleReason: cached.staleReason ?? 'WATERMARK_MISMATCH',
            });
            // matches the envelope state. The cached entry still has status='READY' because
            // staleness was detected via watermark comparison, not cache status.
            return {
              success: true,
              payload: this.deserializePayload(cached, resolution as TelemetryResolution, 'STALE'),
              state: 'stale',
              retryAfterSeconds: 2,
            };
          }
          // Watermarks match - cache is fresh, return it
          return {
            success: true,
            payload: this.deserializePayload(cached, resolution as TelemetryResolution),
            state: 'ready',
          };
        }

        // DEGRADED MODE: Time-based TTL when watermarkRepo is NOT injected.
        //
        // Phase 0.5: This path is ONLY reached when watermarkRepo is not configured
        // (explicit backward-compatible deployment). When watermarkRepo IS injected:
        // - Successful watermark read → handled above (watermark comparison)
        // - Failed watermark read → early return with state: 'failed' (no TTL fallback)
        // - User has no watermark (null) → falls through here (acceptable: no health data = no staleness)
        //
        // CACHE FRESHNESS: READY entries expire after 5 minutes.
        // Trade-off: ~1 unnecessary recompute per 5 minutes per active session.
        const READY_TTL_MS = 5 * 60 * 1000; // 5 minutes
        const readyAgeMs = Date.now() - cached.computedAt.getTime();

        if (readyAgeMs > READY_TTL_MS) {
          this.logger.info('READY cache entry expired (TTL, no watermark configured) - triggering recompute', {
            context: 'SessionTelemetryService.checkCache',
            sessionId,
            ageMinutes: Math.round(readyAgeMs / 60000),
            ttlMinutes: READY_TTL_MS / 60000,
            rawSampleCount: cached.rawSampleCount,
            reason: 'ttl_expired_no_watermark',
            hasWatermarkRepo: !!this.watermarkRepo,
          });
          return null; // Trigger inline recomputation
        }

        return {
          success: true,
          payload: this.deserializePayload(cached, resolution as TelemetryResolution),
          state: 'ready',
        };
      }

      case 'COMPUTING':
        //
        // Previously, this returned `state: 'computing'` which caused getSessionTelemetry() to
        // return 202 immediately WITHOUT reaching the inline compute path. Since workers are
        // now disabled, this created an infinite 202 loop:
        // - COMPUTING row exists (from crashed/old request)
        // - checkCache() returns 'computing' → early return → 202
        // - No worker to clear it → repeat forever
        //
        // Now: We return null, which makes getSessionTelemetry() fall through to
        // computeTelemetryForSession(). That function has stale lock recovery logic
        // (tryAcquireComputeLock with staleAfterMinutes) which will:
        // - If lock is stale (>5min): take over and compute inline
        // - If lock is fresh: return 'computing' (legitimate in-flight)
        this.logger.debug('Found COMPUTING cache entry - falling through to inline compute', {
          context: 'SessionTelemetryService.checkCache',
          sessionId,
          cacheComputedAt: cached.computedAt?.toISOString(),
        });
        return null;

      case 'NO_DATA': {
        // P0-G.1: Watermark-based staleness detection for NO_DATA (PRIMARY)
        // NO_DATA means "no health samples existed at compute time".
        // If watermark has increased since then, new samples may exist.
        if (currentWatermark !== null && cached.sourceWatermark !== null) {
          if (currentWatermark > cached.sourceWatermark) {
            // P0-G.1 FIX: Return null to trigger inline recomputation
            // Since background workers are disabled, we must recompute inline.
            // New samples may have arrived since NO_DATA was computed.
            this.logger.info('NO_DATA cache entry stale (watermark mismatch) - triggering inline recompute', {
              context: 'SessionTelemetryService.checkCache',
              sessionId,
              userId,
              cacheWatermark: cached.sourceWatermark.toString(),
              currentWatermark: currentWatermark.toString(),
            });
            return null; // Trigger inline recomputation
          }
          // Watermarks match - no new data since last check
          return {
            success: true,
            payload: this.createEmptyPayload(cached, resolution as TelemetryResolution),
            state: 'no_data',
          };
        }

        // DEGRADED MODE: Time-based TTL when watermarkRepo is NOT injected.
        // Same reasoning as READY case above.
        // NO_DATA entries expire after 2 minutes (health data may arrive late).
        const NO_DATA_TTL_MS = 2 * 60 * 1000; // 2 minutes
        const noDataAgeMs = Date.now() - cached.computedAt.getTime();

        if (noDataAgeMs > NO_DATA_TTL_MS) {
          this.logger.info('NO_DATA cache entry expired (TTL, no watermark configured) - triggering recompute', {
            context: 'SessionTelemetryService.checkCache',
            sessionId,
            ageMinutes: Math.round(noDataAgeMs / 60000),
            ttlMinutes: NO_DATA_TTL_MS / 60000,
            reason: 'ttl_expired_no_watermark',
            hasWatermarkRepo: !!this.watermarkRepo,
          });
          return null; // Trigger inline recomputation
        }

        return {
          success: true,
          payload: this.createEmptyPayload(cached, resolution as TelemetryResolution),
          state: 'no_data',
        };
      }

      case 'FAILED': {
        // RECOVERY PATH: Allow recomputation for FAILED entries older than 5 minutes.
        // This handles transient failures (Redis timeout, network issues) by giving them
        // a chance to recover instead of permanently returning 500.
        // Fresh failures (< 5 min) still return error to prevent retry storms.
        const failedAgeMs = Date.now() - cached.computedAt.getTime();
        const FAILED_RETRY_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

        if (failedAgeMs > FAILED_RETRY_THRESHOLD_MS) {
          this.logger.info('Allowing recomputation for stale FAILED cache entry', {
            context: 'SessionTelemetryService.checkCache',
            sessionId,
            failedAgeMinutes: Math.round(failedAgeMs / 60000),
            previousError: cached.errorMessage,
          });
          return null; // Trigger recomputation
        }

        // Recent failure - return error to avoid retry storm
        return {
          success: false,
          payload: null,
          state: 'error',
          errorMessage: cached.errorMessage ?? 'Previous computation failed',
          errorSource: 'computation',
        };
      }

      case 'STALE':
      case 'PENDING':
        // Need recomputation
        return null;

      default:
        return null;
    }
  }

  // P0-G.1: Freshness Metadata Helpers

  /**
   * Map cache status to freshness status.
   * Used for building TelemetryFreshnessMeta from cached entries.
   */
  private mapCacheStatusToFreshness(status: SessionTelemetryCacheStatus): FreshnessStatus {
    const mapping: Record<SessionTelemetryCacheStatus, FreshnessStatus> = {
      'PENDING': 'NO_DATA',
      'COMPUTING': 'COMPUTING',
      'READY': 'READY',
      'FAILED': 'FAILED',
      'NO_DATA': 'NO_DATA',
      'STALE': 'STALE',
    };
    return mapping[status] ?? 'NO_DATA';
  }

  /**
   * Build TelemetryFreshnessMeta from a cached entry.
   *
   * P0-G.1 FIX: API responses MUST include freshness field.
   * The frontend uses data.freshness.status for UI state decisions.
   *
   * @param cached - Cached telemetry entry
   * @param overrideStatus - Optional override for status (e.g., when returning stale data)
   * @returns Freshness metadata for the API response
   */
  private buildFreshnessMeta(
    cached: CachedTelemetryEntry,
    overrideStatus?: FreshnessStatus
  ): TelemetryFreshnessMeta {
    return {
      status: overrideStatus ?? this.mapCacheStatusToFreshness(cached.status),
      computedAtMs: cached.computedAt?.getTime() ?? null,
      sourceWatermark: (cached.sourceWatermark ?? BigInt(0)).toString(),
      computeVersion: cached.computeVersion ?? CURRENT_COMPUTE_VERSION,
      staleReason: cached.staleReason as StaleReason | undefined,
      lastErrorAtMs: cached.status === 'FAILED' ? cached.updatedAt?.getTime() ?? null : null,
      lastErrorCode: cached.status === 'FAILED' ? cached.errorMessage ?? null : null,
      attempts: cached.attempts ?? 0,
    };
  }

  /**
   * Build freshness metadata for freshly computed telemetry.
   * Used when inline computation succeeds and we don't have a cached entry.
   *
   * @param computedAtMs - When the computation completed
   * @param sourceWatermark - Current user health watermark
   * @param computeVersion - Compute version used
   * @returns Freshness metadata indicating READY status
   */
  private buildFreshFreshnessMeta(
    computedAtMs: number,
    sourceWatermark: bigint | null,
    computeVersion: number
  ): TelemetryFreshnessMeta {
    return {
      status: 'READY',
      computedAtMs,
      sourceWatermark: (sourceWatermark ?? BigInt(0)).toString(),
      computeVersion,
      attempts: 0,
    };
  }

  /**
   * Deserialize cached payload from database.
   */
  private deserializePayload(
    cached: CachedTelemetryEntry,
    resolution: TelemetryResolution,
    overrideFreshnessStatus?: FreshnessStatus
  ): SessionTelemetryPayload {
    const metricsJson = cached.metricsJson as Record<string, unknown>;
    const bucketSizeMs = RESOLUTION_BUCKET_MS[resolution];

    // Convert stored metrics to contract format (add resolution/bucketSizeMs if missing)
    const metrics: Record<string, MetricSeriesData> = {};
    for (const [code, data] of Object.entries(metricsJson)) {
      const metricData = data as MetricSeriesData;
      metrics[code] = {
        ...metricData,
        resolution: metricData.resolution ?? resolution,
        bucketSizeMs: metricData.bucketSizeMs ?? bucketSizeMs,
      };
    }

    return {
      sessionId: cached.sessionId,
      schemaVersion: cached.schemaVersion,
      computeVersion: cached.computeVersion,
      computedAtMs: cached.computedAt.getTime(),
      window: {
        windowStartMs: Number(cached.windowStartMs),
        windowEndMs: Number(cached.windowEndMs),
        sessionStartMs: Number(cached.sessionStartMs),
        sessionEndMs: Number(cached.sessionEndMs),
        windowMinutes: cached.windowMinutes,
      },
      resolution,
      metrics,
      source: 'api',
      // P0-G.1 FIX: Include freshness metadata in API responses
      // envelope state (e.g., 'STALE'/'FAILED') rather than the cache entry's stored status
      // which may be 'READY' for a stale-by-watermark or failed-watermark-read entry.
      freshness: this.buildFreshnessMeta(cached, overrideFreshnessStatus),
    };
  }

  /**
   * Create empty payload for NO_DATA cache entries.
   */
  private createEmptyPayload(
    cached: CachedTelemetryEntry,
    resolution: TelemetryResolution,
    overrideFreshnessStatus?: FreshnessStatus
  ): SessionTelemetryPayload {
    return {
      sessionId: cached.sessionId,
      schemaVersion: cached.schemaVersion,
      computeVersion: cached.computeVersion,
      computedAtMs: cached.computedAt.getTime(),
      window: {
        windowStartMs: Number(cached.windowStartMs),
        windowEndMs: Number(cached.windowEndMs),
        sessionStartMs: Number(cached.sessionStartMs),
        sessionEndMs: Number(cached.sessionEndMs),
        windowMinutes: cached.windowMinutes,
      },
      resolution,
      metrics: {},
      source: 'api',
      // P0-G.1 FIX: Include freshness metadata in API responses
      // Override defaults to 'NO_DATA' for empty payloads, but callers can pass
      // 'FAILED' when watermark read failed on a NO_DATA cache entry.
      freshness: this.buildFreshnessMeta(cached, overrideFreshnessStatus ?? 'NO_DATA'),
    };
  }

  /**
   * Compute telemetry for a session and store in cache.
   * 
   * @param session - Session to compute telemetry for
   * @param options - Computation options
   * @param startTime - Start time for duration calculation
   * @param lockRowId - ID of pre-created COMPUTING lock row (if any)
   * @param computeVersion - Compute version for cache key (defaults to CURRENT_COMPUTE_VERSION)
   */
  private async computeAndCacheTelemetry(
    session: Session,
    options: ComputeTelemetryOptions,
    startTime: number,
    lockRowId?: string,
    computeVersion: number = CURRENT_COMPUTE_VERSION
  ): Promise<TelemetryQueryResult> {
    const { windowMinutes = 60 } = options;
    // This keeps cache key stable at (sessionId, windowMinutes, resolution, computeVersion)
    // and ensures any API request (including metricCodes=all) can be satisfied from cache.
    // The API layer filters the response to requested metrics before returning.
    const metricCodesToCompute = ALL_TELEMETRY_METRICS;

    // Calculate time window
    const sessionStartMs = session.sessionStartTimestamp.getTime();
    const sessionEndMs = session.sessionEndTimestamp!.getTime();
    const windowMs = windowMinutes * 60 * 1000;
    const windowStartMs = sessionStartMs - windowMs;
    const windowEndMs = sessionEndMs + windowMs;
    const windowDurationMs = windowEndMs - windowStartMs;

    // All metrics must use the SAME resolution to match the cache key
    // Do NOT use sample count - it would cause different resolutions per metric
    const resolvedResolution = options.resolution ?? chooseResolution(windowDurationMs);

    this.logger.debug('Computing session telemetry', {
      context: 'SessionTelemetryService.computeAndCacheTelemetry',
      sessionId: session.id,
      windowMinutes,
      windowDurationMs,
      resolution: resolvedResolution,
      lockRowId,
    });

    try {
      // Query raw health samples for all metrics
      let totalSampleCount = 0;
      const metrics: Record<string, MetricSeriesData> = {};
      const queryErrors: string[] = [];

      for (const metricCode of metricCodesToCompute) {
        try {
          const samples = await this.queryHealthSamples(
            session.userId,
            metricCode,
            new Date(windowStartMs),
            new Date(windowEndMs)
          );

          if (samples.length === 0) {
            continue;
          }

          totalSampleCount += samples.length;

          // Compute metric series with the SHARED resolution (not per-metric)
          const metricData = this.computeMetricSeries(
            metricCode,
            samples,
            { windowStartMs, windowEndMs, sessionStartMs, sessionEndMs, windowMinutes },
            resolvedResolution
          );

          if (metricData.series.length > 0) {
            metrics[metricCode] = metricData;
          }
        } catch (metricError) {
          // Log but track errors - don't silently swallow
          const errorMsg = metricError instanceof Error ? metricError.message : String(metricError);
          queryErrors.push(`${metricCode}: ${errorMsg}`);
          this.logger.warn('Failed to query metric', {
            context: 'SessionTelemetryService.computeAndCacheTelemetry',
            metricCode,
            sessionId: session.id,
            error: errorMsg,
          });
        }
      }

      // If ALL metrics failed, this is an error state
      if (queryErrors.length === metricCodesToCompute.length && queryErrors.length > 0) {
        const errorMessage = `All metric queries failed: ${queryErrors.join('; ')}`;
        await this.saveCacheEntry(session, options, windowStartMs, windowEndMs, sessionStartMs, sessionEndMs,
          {}, 0, 'FAILED', errorMessage, Date.now() - startTime, lockRowId, computeVersion);

        return {
          success: false,
          payload: null,
          state: 'error',
          errorMessage,
          errorSource: 'query',
          durationMs: Date.now() - startTime,
        };
      }

      const computationDurationMs = Date.now() - startTime;
      const status = (Object.keys(metrics).length > 0 ? 'READY' : 'NO_DATA') as SessionTelemetryCacheStatus;
      // Note: resolvedResolution is already defined above and used for all metrics

      // Store in cache with the same resolution used for computation
      const cacheOptions = { ...options, resolution: resolvedResolution };
      await this.saveCacheEntry(session, cacheOptions, windowStartMs, windowEndMs, sessionStartMs, sessionEndMs,
        metrics, totalSampleCount, status, null, computationDurationMs, lockRowId, computeVersion);

      this.logger.info('Session telemetry computed and cached', {
        context: 'SessionTelemetryService.computeAndCacheTelemetry',
        sessionId: session.id,
        metricCount: Object.keys(metrics).length,
        rawSampleCount: totalSampleCount,
        computationDurationMs,
        status,
        queryErrorCount: queryErrors.length,
        lockRowId,
      });

      // Phase 0.5: Get current watermark for freshness metadata.
      // If this fails, the response payload has sourceWatermark='0' in freshness,
      // which is technically correct (no watermark available) but degrades observability.
      let sourceWatermark: bigint | null = null;
      if (this.watermarkRepo) {
        try {
          sourceWatermark = await this.watermarkRepo.getSequenceNumber(session.userId);
        } catch (error) {
          // Phase 0.5: Escalated from warn to error for visibility.
          this.logger.error('Watermark read failed during compute — freshness metadata degraded', {
            context: 'SessionTelemetryService.computeAndCacheTelemetry',
            sessionId: session.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const computedAtMs = Date.now();
      const hasMetrics = Object.keys(metrics).length > 0;

      // Build payload with P0-G.1 freshness metadata
      const payload: SessionTelemetryPayload = {
        sessionId: session.id,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        computeVersion,  // Use provided computeVersion (not hardcoded CURRENT_COMPUTE_VERSION)
        computedAtMs,
        window: {
          windowStartMs,
          windowEndMs,
          sessionStartMs,
          sessionEndMs,
          windowMinutes,  // Echo for validation/debugging
        },
        resolution: resolvedResolution,  // Payload-level resolution for cache key consistency
        metrics,
        source: 'api',
        // P0-G.1 FIX: Include freshness metadata in API responses
        freshness: this.buildFreshFreshnessMeta(
          computedAtMs,
          sourceWatermark,
          computeVersion
        ),
      };

      return {
        success: true,
        payload,
        state: hasMetrics ? 'ready' : 'no_data',
        durationMs: computationDurationMs,
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const computationDurationMs = Date.now() - startTime;

      // Save error state to cache (or release lock if lockRowId provided)
      if (lockRowId) {
        // Lock row exists - release it by updating to FAILED
        await this.cacheRepo.releaseComputeLock(lockRowId, errorMessage);
      } else {
        // No lock row - create FAILED entry via upsert
        await this.saveCacheEntry(session, options, windowStartMs, windowEndMs, sessionStartMs, sessionEndMs,
          {}, 0, 'FAILED', errorMessage, computationDurationMs);
      }

      this.logger.error('Telemetry computation failed', {
        context: 'SessionTelemetryService.computeAndCacheTelemetry',
        sessionId: session.id,
        lockRowId,
        error: error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : String(error),
      });

      return {
        success: false,
        payload: null,
        state: 'error',
        errorMessage,
        errorSource: 'computation',
        durationMs: computationDurationMs,
      };
    }
  }

  /**
   * Save cache entry to database.
   * 
   * @param session - Session being computed
   * @param options - Computation options
   * @param windowStartMs - Window start time
   * @param windowEndMs - Window end time
   * @param sessionStartMs - Session start time
   * @param sessionEndMs - Session end time
   * @param metrics - Computed metrics data
   * @param totalSampleCount - Total raw samples processed
   * @param status - Final status
   * @param errorMessage - Error message if failed
   * @param computationDurationMs - Time taken to compute
   * @param lockRowId - ID of pre-created lock row to update (if any)
   * @param computeVersion - Compute version for cache key (defaults to CURRENT_COMPUTE_VERSION)
   */
  private async saveCacheEntry(
    session: Session,
    options: ComputeTelemetryOptions,
    windowStartMs: number,
    windowEndMs: number,
    sessionStartMs: number,
    sessionEndMs: number,
    metrics: Record<string, MetricSeriesData>,
    totalSampleCount: number,
    status: SessionTelemetryCacheStatus,
    errorMessage: string | null,
    computationDurationMs: number,
    lockRowId?: string,
    computeVersion: number = CURRENT_COMPUTE_VERSION
  ): Promise<void> {
    const { windowMinutes = 60, resolution = '1m' } = options;

    // Phase 0.5: Get current watermark to store with cache entry.
    // Enables watermark-based staleness detection on read.
    // If this fails, the cache entry has sourceWatermark=null, which means
    // ALL future reads will see watermark=null and use TTL fallback.
    // This is an error condition, not a warning.
    let sourceWatermark: bigint | null = null;
    if (this.watermarkRepo) {
      try {
        sourceWatermark = await this.watermarkRepo.getSequenceNumber(session.userId);
      } catch (error) {
        // Phase 0.5: Escalated from warn to error.
        // Cache entry saved with null watermark → future reads degrade to TTL.
        // This is not silent (logged at error level), but the save still proceeds
        // to avoid wasting the computation. Future reads will detect the null
        // watermark and use TTL mode with explicit logging.
        this.logger.error('Watermark read failed during cache save — entry will lack watermark', {
          context: 'SessionTelemetryService.saveCacheEntry',
          sessionId: session.id,
          userId: session.userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // If we have a lockRowId, the row was pre-created with COMPUTING status
    // Update it instead of upserting to avoid race conditions
    if (lockRowId) {
      await this.cacheRepo.update(lockRowId, {
        metricsJson: metrics as Prisma.InputJsonValue,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        computeVersion,  // Use parameter, not hardcoded CURRENT_COMPUTE_VERSION
        computedAt: new Date(),
        computationDurationMs,
        rawSampleCount: totalSampleCount,
        status,
        errorMessage: errorMessage ?? null,
        // P0-G.1: Store watermark for staleness detection
        sourceWatermark,
        staleReason: null, // Clear stale reason on successful recompute
      });
      return;
    }

    // No lock row - use upsert (legacy path for backward compatibility)
    const cacheInput: CreateSessionTelemetryCacheInput = {
      sessionId: session.id,
      userId: session.userId,
      windowMinutes,
      resolution,
      windowStartMs: BigInt(windowStartMs),
      windowEndMs: BigInt(windowEndMs),
      sessionStartMs: BigInt(sessionStartMs),
      sessionEndMs: BigInt(sessionEndMs),
      metricsJson: metrics as Prisma.InputJsonValue,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      computeVersion,  // Use parameter, not hardcoded CURRENT_COMPUTE_VERSION
      computationDurationMs,
      rawSampleCount: totalSampleCount,
      status,
      errorMessage: errorMessage ?? undefined,
      // P0-G.1: Store watermark for staleness detection
      sourceWatermark,
    };

    await this.cacheRepo.upsert(cacheInput);
  }

  /**
   * Query health samples from the repository with full pagination.
   *
   * PERFORMANCE NOTE: For very long sessions (>100k samples), this may be slow.
   * Consider SQL bucket aggregation at the database level for extreme cases.
   */
  private async queryHealthSamples(
    userId: string,
    metricCode: string,
    startTime: Date,
    endTime: Date
  ): Promise<HealthSampleRow[]> {
    const PAGE_SIZE = 10000;
    const MAX_PAGES = 20;  // Safety limit: 200k samples max
    const allSamples: HealthSampleRow[] = [];
    let page = 1;

    while (page <= MAX_PAGES) {
      const result = await this.healthSampleRepo.queryByUserAndTimeRange(
        userId,
        startTime,
        endTime,
        metricCode,
        { pageSize: PAGE_SIZE, page }
      );

      const normalized = result.items.map(item => ({
        id: item.id,
        userId: item.userId,
        sourceId: item.sourceId,
        sourceRecordId: item.sourceRecordId,
        metricCode: item.metricCode,
        value: item.value === null
          ? null
          : (typeof item.value === 'number' ? item.value : Number(item.value)),
        startAt: item.startAt,
        endAt: item.endAt,
        unit: item.unit,
        metadata: item.metadata,
      }));

      allSamples.push(...normalized);

      // Check if we've fetched all pages (using top-level pagination fields)
      if (result.items.length < PAGE_SIZE || page >= result.totalPages) {
        break;
      }

      page++;
    }

    // Log a warning if we hit the safety limit (potential data loss)
    if (page > MAX_PAGES) {
      this.logger.warn('Reached maximum pagination limit for health samples', {
        context: 'SessionTelemetryService.queryHealthSamples',
        userId,
        metricCode,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        fetchedSamples: allSamples.length,
        maxSamples: PAGE_SIZE * MAX_PAGES,
      });
    }

    return allSamples;
  }

  /**
   * Compute downsampled series for a single metric.
   * Implements ValueKind-aware aggregation per SESSIONHEALTHKITUI.md.
   *
   * INVARIANTS:
   * - Gap detection from RAW timestamps BEFORE downsampling
   * - Bucket alignment relative to windowStart
   * - ValueKind determines aggregation strategy
   */
  private computeMetricSeries(
    metricCode: string,
    samples: HealthSampleRow[],
    window: SessionTelemetryWindow,
    resolution: TelemetryResolution
  ): MetricSeriesData {
    const definition = HEALTH_METRIC_DEFINITIONS[metricCode as HealthMetricCode];
    const displayConfig = getMetricDisplayConfig(metricCode);
    const displayName = displayConfig.label;
    const unit = definition?.canonicalUnit ?? '';
    const valueKind = isHealthMetricCode(metricCode)
      ? getValueKind(metricCode as HealthMetricCode)
      : 'SCALAR_NUM';
    const bucketSizeMs = RESOLUTION_BUCKET_MS[resolution];

    // Filter to valid numeric samples
    const validSamples = samples.filter(
      (s): s is HealthSampleRow & { value: number } =>
        s.value !== null && typeof s.value === 'number' && !Number.isNaN(s.value)
    );

    if (validSamples.length === 0) {
      return {
        metricCode,
        displayName,
        unit,
        resolution,
        bucketSizeMs,
        series: [],
        gaps: [],
        stats: { min: 0, max: 0, avg: 0, sampleCount: 0 },
      };
    }

    // Gap threshold is resolution-aware (2x bucket size)
    const rawTimestamps = validSamples.map(s => s.startAt.getTime()).sort((a, b) => a - b);
    const gaps = this.detectGapsFromRawTimestamps(rawTimestamps, bucketSizeMs);

    // Group samples into buckets (aligned to windowStart)
    const buckets = new Map<number, number[]>();

    for (const sample of validSamples) {
      const sampleTime = sample.startAt.getTime();
      const bucketKey = Math.floor((sampleTime - window.windowStartMs) / bucketSizeMs);

      if (!buckets.has(bucketKey)) {
        buckets.set(bucketKey, []);
      }
      buckets.get(bucketKey)!.push(sample.value);
    }

    // Aggregate buckets based on ValueKind
    const series: ChartPoint[] = [];
    const allValues: number[] = [];

    const sortedKeys = Array.from(buckets.keys()).sort((a, b) => a - b);

    for (const key of sortedKeys) {
      const values = buckets.get(key)!;
      if (values.length === 0) continue;

      let aggregatedValue: number;
      const minVal = Math.min(...values);
      const maxVal = Math.max(...values);
      
      switch (valueKind) {
        case 'CUMULATIVE_NUM':
          // For cumulative metrics (e.g., steps): use DELTA per bucket (max - min)
          // This represents the increment during this bucket, not the raw cumulative value
          // Per SESSIONHEALTHKITUI.md: "CUMULATIVE_NUM: delta per bucket (max - min) or rate/min"
          aggregatedValue = maxVal - minVal;
          break;
        case 'INTERVAL_NUM':
          // For interval metrics: use sum (total duration/count in bucket)
          aggregatedValue = values.reduce((a, b) => a + b, 0);
          break;
        case 'SCALAR_NUM':
        default:
          // Mean for scalar metrics (heart rate, HRV, etc.)
          aggregatedValue = values.reduce((a, b) => a + b, 0) / values.length;
          break;
      }

      // Timestamp is center of bucket
      const timestamp = Math.round(window.windowStartMs + (key * bucketSizeMs) + (bucketSizeMs / 2));

      series.push({
        timestamp,
        value: aggregatedValue,
        min: values.length > 1 ? Math.min(...values) : undefined,
        max: values.length > 1 ? Math.max(...values) : undefined,
      });

      allValues.push(aggregatedValue);
    }

    // Compute statistics from raw samples (not downsampled)
    const rawValues = validSamples.map(s => s.value);
    const stats: MetricStats = {
      min: Math.min(...rawValues),
      max: Math.max(...rawValues),
      avg: rawValues.reduce((a, b) => a + b, 0) / rawValues.length,
      sampleCount: validSamples.length,
    };

    return {
      metricCode,
      displayName,
      unit,
      resolution,
      bucketSizeMs,
      series,
      gaps,
      stats,
    };
  }

  /**
   * Detect gaps from raw timestamps BEFORE downsampling.
   *
   * @param sortedTimestamps - Sorted array of timestamps (ascending)
   * @param bucketSizeMs - Bucket size in milliseconds for resolution-aware threshold
   */
  private detectGapsFromRawTimestamps(sortedTimestamps: number[], bucketSizeMs: number): DataGap[] {
    if (sortedTimestamps.length < 2) {
      return [];
    }

    // Gap threshold is 2x the bucket size (resolution-aware)
    // For 1m resolution: 2 * 60000 = 120000 (2 minutes)
    // For 5m resolution: 2 * 300000 = 600000 (10 minutes)
    const gapThresholdMs = bucketSizeMs * 2;

    const gaps: DataGap[] = [];

    for (let i = 1; i < sortedTimestamps.length; i++) {
      const current = sortedTimestamps[i];
      const previous = sortedTimestamps[i - 1];
      if (current === undefined || previous === undefined) continue;
      
      const delta = current - previous;
      if (delta > gapThresholdMs) {
        gaps.push({
          startMs: previous,
          endMs: current,
        });
      }
    }

    return gaps;
  }

  /**
   * Batch compute telemetry for multiple sessions.
   * Used by background worker for backfill.
   */
  async batchComputeTelemetry(
    sessionIds: string[],
    options: ComputeTelemetryOptions = {}
  ): Promise<{ success: number; failed: number; skipped: number }> {
    let success = 0;
    let failed = 0;
    let skipped = 0;

    for (const sessionId of sessionIds) {
      try {
        // Use system-internal method for background worker (no user context)
        const session = await this.sessionRepo.findByIdSystemInternal(sessionId);
        if (!session) {
          this.logger.warn('Session not found for telemetry computation', {
            context: 'SessionTelemetryService.batchComputeTelemetry',
            sessionId,
          });
          skipped++;
          continue;
        }

        if (!session.sessionEndTimestamp) {
          this.logger.debug('Skipping active session', {
            context: 'SessionTelemetryService.batchComputeTelemetry',
            sessionId,
          });
          skipped++;
          continue;
        }

        const result = await this.computeTelemetryForSession({
          sessionId,
          userId: session.userId,
          options,
        });

        if (result.state === 'error') {
          failed++;
        } else if (result.wasComputed) {
          success++;
        } else {
          skipped++;
        }
      } catch (error) {
        this.logger.error('Failed to compute telemetry for session', {
          context: 'SessionTelemetryService.batchComputeTelemetry',
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        failed++;
      }
    }

    return { success, failed, skipped };
  }

  /**
   * Find sessions that need telemetry computation.
   * Used by background worker to discover work.
   *
   * @param options.limit - Max sessions to return (default 100)
   * @param options.resolution - Resolution to check for (default '1m')
   * @param options.windowMinutes - Window size to check for (default 60)
   *
   * Worker can call this with different params to pre-warm both 1m and 5m caches.
   */
  async findSessionsNeedingComputation(options: {
    limit?: number;
    resolution?: TelemetryResolution;
    windowMinutes?: number;
  } = {}): Promise<string[]> {
    const {
      limit = 100,
      resolution = '1m',
      windowMinutes = 60,
    } = options;
    return this.cacheRepo.findSessionsNeedingComputation(limit, CURRENT_COMPUTE_VERSION, windowMinutes, resolution);
  }

  /**
   * Invalidate cache for a session (e.g., when health data is updated).
   */
  async invalidateCache(sessionId: string): Promise<void> {
    const count = await this.cacheRepo.markStale(sessionId);
    this.logger.debug('Invalidated session telemetry cache', {
      context: 'SessionTelemetryService.invalidateCache',
      sessionId,
      entriesMarkedStale: count,
    });
  }

  /**
   * Get compute coordinator stats for observability.
   *
   * Phase 0.5: Exposes bounded compute coordinator state for health checks,
   * admin endpoints, and structured logging.
   */
  getComputeCoordinatorStats(): ComputeCoordinatorStats {
    return this.computeCoordinator.getStats();
  }

  /**
   * Check if telemetry cache exists for a session.
   */
  async hasCachedTelemetry(
    sessionId: string,
    windowMinutes: number = 60,
    resolution: TelemetryResolution = '1m'
  ): Promise<boolean> {
    const cached = await this.cacheRepo.findByKey({
      sessionId,
      windowMinutes,
      resolution,
      computeVersion: CURRENT_COMPUTE_VERSION,
    });
    return cached !== null && (cached.status === 'READY' || cached.status === 'NO_DATA');
  }

  /**
   * Filter payload to only include requested metrics.
   *
   * INVARIANT: Cache stores ALL metrics (default + secondary), but API can request a subset.
   * This method filters the payload to only include the requested metrics.
   *
   * @param payload - Full telemetry payload from cache
   * @param requestedMetrics - Metrics to include (if undefined, return all/default)
   * @returns Filtered payload with only requested metrics
   */
  private filterPayloadMetrics(
    payload: SessionTelemetryPayload,
    requestedMetrics?: readonly HealthMetricCode[]
  ): SessionTelemetryPayload {
    // If no filter specified or empty, return full payload (for backwards compatibility)
    if (!requestedMetrics || requestedMetrics.length === 0) {
      return payload;
    }

    // Create filtered metrics object
    const filteredMetrics: Record<string, MetricSeriesData> = {};
    const requestedSet = new Set(requestedMetrics as readonly string[]);

    for (const [metricCode, metricData] of Object.entries(payload.metrics)) {
      if (requestedSet.has(metricCode)) {
        filteredMetrics[metricCode] = metricData;
      }
    }

    // Return new payload with filtered metrics
    return {
      ...payload,
      metrics: filteredMetrics,
    };
  }
}
