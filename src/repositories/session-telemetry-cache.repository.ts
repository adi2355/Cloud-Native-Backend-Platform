/**
 * Session Telemetry Cache Repository
 * Handles precomputed telemetry data operations in PostgreSQL
 *
 * PURPOSE:
 * - CRUD operations for precomputed session health telemetry
 * - Fast lookups for session visualization
 * - Cache invalidation and status management
 *
 * ARCHITECTURE:
 * - Single entry per (sessionId, windowMinutes, resolution, computeVersion)
 * - JSON blob for metrics (efficient for read-heavy workload)
 * - Status tracking for async computation pipeline
 *
 * @see SESSIONHEALTHKITUI.md for complete implementation plan
 */

import { PrismaClient, SessionTelemetryCache, SessionTelemetryCacheStatus, Prisma } from '@prisma/client';
import { BaseRepository } from './base.repository';
import { LoggerService } from '../services/logger.service';
import { AppError, ErrorCodes } from '../utils/AppError';
import { CURRENT_SCHEMA_VERSION } from '@shared/contracts';

// Types

/**
 * Input for creating a telemetry cache entry.
 */
export interface CreateSessionTelemetryCacheInput {
  sessionId: string;
  userId: string;
  windowMinutes?: number;
  resolution?: string;
  windowStartMs: bigint;
  windowEndMs: bigint;
  sessionStartMs: bigint;
  sessionEndMs: bigint;
  metricsJson: Prisma.InputJsonValue;
  schemaVersion?: number;
  computeVersion?: number;
  computationDurationMs?: number;
  rawSampleCount: number;
  status?: SessionTelemetryCacheStatus;
  errorMessage?: string;
  /**
   * P0-G.1: UserHealthWatermark.sequenceNumber at compute time.
   * Used for staleness detection. NULL means legacy cache (treat as stale).
   */
  sourceWatermark?: bigint | null;
  /**
   * P0-G.1: Watermark when staleness was first detected.
   * Used for monitoring and alerting on stale caches.
   */
  staleSinceWatermark?: bigint | null;
  /**
   * P0-G.1: Retry count since last successful computation.
   * Used for exponential backoff and failure tracking.
   */
  attempts?: number;
}

/**
 * Input for updating an existing cache entry.
 */
export interface UpdateSessionTelemetryCacheInput {
  metricsJson?: Prisma.InputJsonValue;
  schemaVersion?: number;
  computeVersion?: number;
  computedAt?: Date;
  computationDurationMs?: number;
  rawSampleCount?: number;
  status?: SessionTelemetryCacheStatus;
  errorMessage?: string | null;
  /**
   * P0-G.1: UserHealthWatermark.sequenceNumber at compute time.
   * Used for staleness detection. NULL means legacy cache (treat as stale).
   */
  sourceWatermark?: bigint | null;
  /**
   * P0-G.1: Why this cache became stale (for debugging).
   * Values: 'NEW_SAMPLES', 'DELETIONS', 'CONFIG_CHANGE', 'VERSION_MISMATCH'
   */
  staleReason?: string | null;
  /**
   * P0-G.1: Watermark when staleness was first detected.
   * Used for monitoring and alerting on stale caches.
   */
  staleSinceWatermark?: bigint | null;
  /**
   * P0-G.1: Retry count since last successful computation.
   * Used for exponential backoff and failure tracking.
   */
  attempts?: number;
}

/**
 * Filters for querying cache entries.
 */
export interface SessionTelemetryCacheFilters {
  userId?: string;
  sessionId?: string;
  status?: SessionTelemetryCacheStatus;
  windowMinutes?: number;
  resolution?: string;
  computeVersion?: number;
  /** Filter by sessions after this timestamp (Unix ms) */
  sessionStartAfterMs?: bigint;
}

/**
 * Cache lookup key for unique identification.
 */
export interface SessionTelemetryCacheKey {
  sessionId: string;
  windowMinutes: number;
  resolution: string;
  computeVersion: number;
}

// Repository

/**
 * Repository for session telemetry cache operations.
 * Extends BaseRepository for standard patterns.
 */
export class SessionTelemetryCacheRepository extends BaseRepository<SessionTelemetryCache> {
  constructor(prisma: PrismaClient, entityName: string, logger: LoggerService) {
    super(prisma, entityName, logger);
  }

  /**
   * Find cache entry by composite key.
   *
   * @param key - Composite cache key
   * @returns Cache entry or null if not found
   */
  async findByKey(key: SessionTelemetryCacheKey): Promise<SessionTelemetryCache | null> {
    try {
      return await this.prisma.sessionTelemetryCache.findUnique({
        where: {
          session_telemetry_cache_key: {
            sessionId: key.sessionId,
            windowMinutes: key.windowMinutes,
            resolution: key.resolution,
            computeVersion: key.computeVersion,
          },
        },
      });
    } catch (error) {
      this.logger.error('Error finding session telemetry cache by key', {
        context: 'SessionTelemetryCacheRepository.findByKey',
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Find cache entry by session ID (uses latest compute version with default params).
   *
   * @param sessionId - Session ID
   * @param status - Optional status filter (default: READY)
   * @returns Cache entry or null if not found
   */
  async findBySessionId(
    sessionId: string,
    status: SessionTelemetryCacheStatus = 'READY'
  ): Promise<SessionTelemetryCache | null> {
    try {
      return await this.prisma.sessionTelemetryCache.findFirst({
        where: {
          sessionId,
          status,
        },
        orderBy: {
          computeVersion: 'desc',
        },
      });
    } catch (error) {
      this.logger.error('Error finding session telemetry cache by session ID', {
        context: 'SessionTelemetryCacheRepository.findBySessionId',
        sessionId,
        status,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Create a new cache entry.
   *
   * @param data - Cache creation data
   * @param tx - Optional transaction client
   * @returns Created cache entry
   */
  async create(
    data: CreateSessionTelemetryCacheInput,
    tx?: Prisma.TransactionClient
  ): Promise<SessionTelemetryCache> {
    const client = tx || this.prisma;
    try {
      return await client.sessionTelemetryCache.create({
        data: {
          sessionId: data.sessionId,
          userId: data.userId,
          windowMinutes: data.windowMinutes ?? 60,
          resolution: data.resolution ?? '1m',
          windowStartMs: data.windowStartMs,
          windowEndMs: data.windowEndMs,
          sessionStartMs: data.sessionStartMs,
          sessionEndMs: data.sessionEndMs,
          metricsJson: data.metricsJson,
          schemaVersion: data.schemaVersion ?? 1,
          computeVersion: data.computeVersion ?? 1,
          computationDurationMs: data.computationDurationMs,
          rawSampleCount: data.rawSampleCount,
          status: data.status ?? 'READY',
          errorMessage: data.errorMessage,
          // P0-G.1: Store watermark for staleness detection
          sourceWatermark: data.sourceWatermark,
        },
      });
    } catch (error) {
      this.logger.error('Error creating session telemetry cache', {
        context: 'SessionTelemetryCacheRepository.create',
        sessionId: data.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Update an existing cache entry.
   *
   * @param id - Cache entry ID
   * @param data - Update data
   * @param tx - Optional transaction client
   * @returns Updated cache entry
   */
  async update(
    id: string,
    data: UpdateSessionTelemetryCacheInput,
    tx?: Prisma.TransactionClient
  ): Promise<SessionTelemetryCache> {
    const client = tx || this.prisma;
    try {
      return await client.sessionTelemetryCache.update({
        where: { id },
        data: {
          ...(data.metricsJson !== undefined && { metricsJson: data.metricsJson }),
          ...(data.schemaVersion !== undefined && { schemaVersion: data.schemaVersion }),
          ...(data.computeVersion !== undefined && { computeVersion: data.computeVersion }),
          ...(data.computedAt !== undefined && { computedAt: data.computedAt }),
          ...(data.computationDurationMs !== undefined && { computationDurationMs: data.computationDurationMs }),
          ...(data.rawSampleCount !== undefined && { rawSampleCount: data.rawSampleCount }),
          ...(data.status !== undefined && { status: data.status }),
          ...(data.errorMessage !== undefined && { errorMessage: data.errorMessage }),
          // P0-G.1: Watermark and stale reason tracking
          ...(data.sourceWatermark !== undefined && { sourceWatermark: data.sourceWatermark }),
          ...(data.staleReason !== undefined && { staleReason: data.staleReason }),
        },
      });
    } catch (error) {
      this.logger.error('Error updating session telemetry cache', {
        context: 'SessionTelemetryCacheRepository.update',
        id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Upsert cache entry by session ID (for idempotent cache computation).
   * Updates existing or creates new entry.
   *
   * @param data - Cache data
   * @param tx - Optional transaction client
   * @returns Upserted cache entry
   */
  async upsert(
    data: CreateSessionTelemetryCacheInput,
    tx?: Prisma.TransactionClient
  ): Promise<SessionTelemetryCache> {
    const client = tx || this.prisma;
    const windowMinutes = data.windowMinutes ?? 60;
    const resolution = data.resolution ?? '1m';
    const computeVersion = data.computeVersion ?? 1;

    try {
      return await client.sessionTelemetryCache.upsert({
        where: {
          session_telemetry_cache_key: {
            sessionId: data.sessionId,
            windowMinutes,
            resolution,
            computeVersion,
          },
        },
        create: {
          sessionId: data.sessionId,
          userId: data.userId,
          windowMinutes,
          resolution,
          windowStartMs: data.windowStartMs,
          windowEndMs: data.windowEndMs,
          sessionStartMs: data.sessionStartMs,
          sessionEndMs: data.sessionEndMs,
          metricsJson: data.metricsJson,
          schemaVersion: data.schemaVersion ?? 1,
          computeVersion,
          computationDurationMs: data.computationDurationMs,
          rawSampleCount: data.rawSampleCount,
          status: data.status ?? 'READY',
          errorMessage: data.errorMessage,
          // P0-G.1: Store watermark for staleness detection
          sourceWatermark: data.sourceWatermark,
        },
        update: {
          metricsJson: data.metricsJson,
          windowStartMs: data.windowStartMs,
          windowEndMs: data.windowEndMs,
          sessionStartMs: data.sessionStartMs,
          sessionEndMs: data.sessionEndMs,
          computationDurationMs: data.computationDurationMs,
          rawSampleCount: data.rawSampleCount,
          status: data.status ?? 'READY',
          errorMessage: data.errorMessage,
          computedAt: new Date(),
          // P0-G.1: Update watermark and clear stale reason on recompute
          sourceWatermark: data.sourceWatermark,
          staleReason: null,
        },
      });
    } catch (error) {
      this.logger.error('Error upserting session telemetry cache', {
        context: 'SessionTelemetryCacheRepository.upsert',
        sessionId: data.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Mark cache entry as stale (needs recomputation).
   *
   * @param sessionId - Session ID
   * @param options - Optional behavior flags
   * @param tx - Optional transaction client
   * @returns Number of entries marked stale
   */
  async markStale(
    sessionId: string,
    options?: { excludeComputing?: boolean },
    tx?: Prisma.TransactionClient
  ): Promise<number> {
    const client = tx || this.prisma;
    try {
      const result = await client.sessionTelemetryCache.updateMany({
        where: {
          sessionId,
          status: options?.excludeComputing
            ? { notIn: ['STALE', 'COMPUTING'] }
            : { not: 'STALE' },
        },
        data: {
          status: 'STALE',
        },
      });
      return result.count;
    } catch (error) {
      this.logger.error('Error marking session telemetry cache as stale', {
        context: 'SessionTelemetryCacheRepository.markStale',
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Mark all cache entries for a session as STALE with a reason.
   *
   * P0-G.1: Used by TelemetryCacheProjectionHandler when health samples change.
   *
   * @param sessionId - The session ID
   * @param staleReason - Why the cache is stale ('NEW_SAMPLES', 'DELETIONS', etc.)
   * @param tx - Optional transaction client
   * @returns Number of cache entries marked as STALE
   */
  async markStaleBySession(
    sessionId: string,
    staleReason: string,
    tx?: Prisma.TransactionClient
  ): Promise<number> {
    const client = tx || this.prisma;
    try {
      const result = await client.sessionTelemetryCache.updateMany({
        where: {
          sessionId,
          // Don't overwrite COMPUTING status (avoids lock conflicts)
          status: { notIn: ['STALE', 'COMPUTING'] },
        },
        data: {
          status: 'STALE',
          staleReason,
        },
      });

      if (result.count > 0) {
        this.logger.debug('Marked session telemetry cache as STALE', {
          context: 'SessionTelemetryCacheRepository.markStaleBySession',
          sessionId,
          staleReason,
          count: result.count,
        });
      }

      return result.count;
    } catch (error) {
      this.logger.error('Error marking session telemetry cache as stale', {
        context: 'SessionTelemetryCacheRepository.markStaleBySession',
        sessionId,
        staleReason,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Mark all cache entries for a user as STALE (coarse-grained invalidation).
   *
   * GAP D FIX: O(1) bulk invalidation replacing O(N) per-session loop for wide
   * time ranges (e.g., 90-day health backfills) or degenerate ranges (0..0).
   *
   * When no time range is provided, ALL cache entries for the user are marked
   * stale. When a time range is provided, only overlapping session caches are
   * affected using session_start_ms / session_end_ms overlap semantics:
   *   sessionStart < rangeEnd AND sessionEnd > rangeStart
   *
   * INVARIANT: Never overwrites COMPUTING status (avoids lock conflicts).
   * INVARIANT: Never overwrites already-STALE entries (idempotent).
   * INVARIANT: userId scopes the update to a single tenant.
   *
   * @param userId - User ID to scope the update
   * @param staleReason - Why the cache is stale ('NEW_SAMPLES:MISSING_RANGE', etc.)
   * @param rangeStartMs - Optional start of affected range (BigInt, Unix ms)
   * @param rangeEndMs - Optional end of affected range (BigInt, Unix ms)
   * @param tx - Optional transaction client
   * @returns Number of cache entries marked as STALE
   */
  async markStaleByUser(
    userId: string,
    staleReason: string,
    rangeStartMs?: bigint,
    rangeEndMs?: bigint,
    tx?: Prisma.TransactionClient
  ): Promise<number> {
    const client = tx || this.prisma;
    try {
      const whereClause: Parameters<typeof client.sessionTelemetryCache.updateMany>[0]['where'] = {
        userId,
        // Don't overwrite COMPUTING or already-STALE status
        status: { notIn: ['STALE', 'COMPUTING'] },
      };

      // If time range is provided and valid, scope to overlapping sessions
      if (rangeStartMs !== undefined && rangeEndMs !== undefined &&
          rangeEndMs > rangeStartMs) {
        whereClause.sessionStartMs = { lt: rangeEndMs };
        whereClause.sessionEndMs = { gt: rangeStartMs };
      }
      // else: no range filter → mark ALL user caches stale (coarse invalidation)

      const result = await client.sessionTelemetryCache.updateMany({
        where: whereClause,
        data: {
          status: 'STALE',
          staleReason,
        },
      });

      this.logger.info('Marked session telemetry caches as STALE by user (coarse invalidation)', {
        context: 'SessionTelemetryCacheRepository.markStaleByUser',
        userId,
        staleReason,
        hasTimeRange: rangeStartMs !== undefined,
        rangeStartMs: rangeStartMs?.toString(),
        rangeEndMs: rangeEndMs?.toString(),
        count: result.count,
      });

      return result.count;
    } catch (error) {
      this.logger.error('Error marking session telemetry caches as stale by user', {
        context: 'SessionTelemetryCacheRepository.markStaleByUser',
        userId,
        staleReason,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Find sessions that need cache computation for a specific configuration.
   *
   * INVARIANT: Cache is keyed by (sessionId, windowMinutes, resolution, computeVersion).
   * So a session with only 1m cache will be returned if querying for 5m backfill.
   *
   * @param limit - Maximum number of sessions to return
   * @param computeVersion - Target compute version
   * @param windowMinutes - Window size in minutes (default: 60)
   * @param resolution - Resolution ('1m' or '5m') (default: '1m')
   * @returns List of session IDs needing computation
   */
  async findSessionsNeedingComputation(
    limit: number = 100,
    computeVersion: number = 1,
    windowMinutes: number = 60,
    resolution: string = '1m'
  ): Promise<string[]> {
    try {
      // Find completed sessions without cache for this specific (windowMinutes, resolution, computeVersion)
      const sessions = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT DISTINCT cs.id
        FROM consumption_sessions cs
        LEFT JOIN session_telemetry_cache stc
          ON stc.session_id = cs.id
          AND stc.window_minutes = ${windowMinutes}
          AND stc.resolution = ${resolution}
          AND stc.compute_version = ${computeVersion}
          AND stc.status IN ('READY', 'NO_DATA')
        WHERE cs.status = 'COMPLETED'
          AND cs.session_end_timestamp IS NOT NULL
          AND (stc.id IS NULL OR stc.status IN ('STALE', 'FAILED'))
        ORDER BY cs.session_end_timestamp DESC
        LIMIT ${limit}
      `;

      return sessions.map(s => s.id);
    } catch (error) {
      this.logger.error('Error finding sessions needing computation', {
        context: 'SessionTelemetryCacheRepository.findSessionsNeedingComputation',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  // NOTE: No delete methods per "no deletions" invariant (SESSIONHEALTHKITUI.md).
  // Session cache entries are cascade-deleted via the Prisma relation (onDelete: Cascade).

  /**
   * Atomically acquire compute lock for a session telemetry cache entry.
   *
   * when no entry exists. Uses unique constraint (sessionId, windowMinutes,
   * resolution, computeVersion) to ensure first-writer wins.
   *
   * Lock semantics:
   * - If no cache entry exists: atomically CREATE a COMPUTING row and return true
   * - If PENDING/STALE/FAILED: atomically UPDATE to COMPUTING and return true
   * - If COMPUTING and stale: atomically UPDATE to COMPUTING (takeover) and return true
   * - If COMPUTING and fresh: return false (another process is computing)
   * - If READY/NO_DATA: return false (already computed, use cached data)
   *
   * STALE LOCK RECOVERY (added 2026-01-28):
   * When workers are disabled (inline compute mode), COMPUTING rows can become
   * permanently stuck if a request crashes mid-computation. This method now
   * automatically recovers stale COMPUTING locks by taking them over.
   * A COMPUTING row is considered stale if updatedAt is older than staleAfterMinutes.
   *
   * @param sessionId - Session ID
   * @param userId - User ID (required to create lock row)
   * @param sessionStartMs - Session start time (Unix ms)
   * @param sessionEndMs - Session end time (Unix ms)
   * @param windowMinutes - Window size in minutes
   * @param resolution - Resolution ('1m' or '5m')
   * @param computeVersion - Compute version
   * @param tx - Optional transaction client
   * @param forceRecompute - Allow recompute even if cache is READY/NO_DATA
   * @param staleAfterMinutes - Consider COMPUTING rows stale after this many minutes (default: 5)
   * @returns Object with shouldCompute flag, lockRowId if created, and existingStatus
   */
  async tryAcquireComputeLock(
    sessionId: string,
    userId: string,
    sessionStartMs: number,
    sessionEndMs: number,
    windowMinutes: number = 60,
    resolution: string = '1m',
    computeVersion: number = 1,
    tx?: Prisma.TransactionClient,
    forceRecompute: boolean = false,
    staleAfterMinutes: number = 5
  ): Promise<{
    shouldCompute: boolean;
    lockRowId?: string;
    existingStatus?: SessionTelemetryCacheStatus;
    recoveredStaleLock?: boolean;
  }> {
    const client = tx || this.prisma;
    
    try {
      // First check if entry exists (include updatedAt for stale lock detection)
      const existing = await client.sessionTelemetryCache.findUnique({
        where: {
          session_telemetry_cache_key: {
            sessionId,
            windowMinutes,
            resolution,
            computeVersion,
          },
        },
        select: { id: true, status: true, updatedAt: true },
      });

      // Entry exists - check status
      if (existing) {
        switch (existing.status) {
          case 'READY':
          case 'NO_DATA':
            if (forceRecompute) {
              const updated = await client.sessionTelemetryCache.updateMany({
                where: {
                  id: existing.id,
                  status: { in: ['READY', 'NO_DATA'] },
                },
                data: {
                  status: 'COMPUTING',
                },
              });

              if (updated.count > 0) {
                return { shouldCompute: true, lockRowId: existing.id };
              }

              return { shouldCompute: false, existingStatus: 'COMPUTING' };
            }
            // Already computed, use cache
            return { shouldCompute: false, existingStatus: existing.status };

          case 'COMPUTING': {
            // STALE LOCK RECOVERY: Check if this COMPUTING row is stale
            // A stale lock means the previous compute request crashed or timed out.
            // Without workers, this would cause permanent stuck state.
            const staleThreshold = new Date(Date.now() - staleAfterMinutes * 60 * 1000);
            const isStale = existing.updatedAt < staleThreshold;

            if (isStale) {
              // Take over the stale lock atomically
              // Use updateMany with status check to prevent race condition
              const takenOver = await client.sessionTelemetryCache.updateMany({
                where: {
                  id: existing.id,
                  status: 'COMPUTING',
                  updatedAt: { lt: staleThreshold },
                },
                data: {
                  status: 'COMPUTING',  // Keep as COMPUTING (we're taking over)
                  updatedAt: new Date(), // Reset the timer
                  errorMessage: `Stale lock recovered after ${staleAfterMinutes} minutes (previous compute abandoned)`,
                },
              });

              if (takenOver.count > 0) {
                this.logger.warn('Recovered stale COMPUTING lock inline', {
                  context: 'SessionTelemetryCacheRepository.tryAcquireComputeLock',
                  sessionId,
                  lockRowId: existing.id,
                  staleAfterMinutes,
                  lockAgeMs: Date.now() - existing.updatedAt.getTime(),
                });
                return { shouldCompute: true, lockRowId: existing.id, recoveredStaleLock: true };
              }
              // Race: someone else took over between our check and update
              // Fall through to return computing (legitimate in-flight compute)
            }

            // Fresh COMPUTING lock - another process is legitimately computing
            return { shouldCompute: false, existingStatus: 'COMPUTING' };
          }

          case 'PENDING':
          case 'STALE':
          case 'FAILED':
            // Try to atomically update to COMPUTING
            const updated = await client.sessionTelemetryCache.updateMany({
              where: {
                id: existing.id,
                status: { in: ['PENDING', 'STALE', 'FAILED'] },
              },
              data: {
                status: 'COMPUTING',
              },
            });

            // If we updated 1 row, we got the lock
            if (updated.count > 0) {
              return { shouldCompute: true, lockRowId: existing.id };
            }

            // Someone else grabbed it between our check and update
            return { shouldCompute: false, existingStatus: 'COMPUTING' };

          default:
            // Unknown status - don't compute
            this.logger.warn('Unknown cache status', {
              context: 'SessionTelemetryCacheRepository.tryAcquireComputeLock',
              sessionId,
              status: existing.status,
            });
            return { shouldCompute: false, existingStatus: existing.status };
        }
      }

      // The unique constraint (sessionId, windowMinutes, resolution, computeVersion)
      // ensures only the first concurrent request wins; others get unique violation
      const windowMs = windowMinutes * 60 * 1000;
      const windowStartMs = sessionStartMs - windowMs;
      const windowEndMs = sessionEndMs + windowMs;

      try {
        const lockRow = await client.sessionTelemetryCache.create({
          data: {
            sessionId,
            userId,
            windowMinutes,
            resolution,
            windowStartMs: BigInt(windowStartMs),
            windowEndMs: BigInt(windowEndMs),
            sessionStartMs: BigInt(sessionStartMs),
            sessionEndMs: BigInt(sessionEndMs),
            metricsJson: {},  // Empty until computation completes
            schemaVersion: CURRENT_SCHEMA_VERSION,
            computeVersion,
            rawSampleCount: 0,
            status: 'COMPUTING',
            errorMessage: null,
          },
        });

        this.logger.debug('Acquired compute lock for new entry', {
          context: 'SessionTelemetryCacheRepository.tryAcquireComputeLock',
          sessionId,
          lockRowId: lockRow.id,
        });

        return { shouldCompute: true, lockRowId: lockRow.id };
      } catch (createError) {
        // Check if unique constraint violation (Prisma error P2002)
        if (
          createError instanceof Prisma.PrismaClientKnownRequestError &&
          createError.code === 'P2002'
        ) {
          // Another request already created the entry - race condition resolved
          this.logger.debug('Compute lock race lost - entry created by another request', {
            context: 'SessionTelemetryCacheRepository.tryAcquireComputeLock',
            sessionId,
          });
          return { shouldCompute: false, existingStatus: 'COMPUTING' };
        }
        // Other error - rethrow
        throw createError;
      }
    } catch (error) {
      this.logger.error('Error acquiring compute lock', {
        context: 'SessionTelemetryCacheRepository.tryAcquireComputeLock',
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      // On error, don't compute (fail-safe)
      return { shouldCompute: false };
    }
  }

  /**
   * Release a compute lock by updating status to FAILED.
   * Called when computation fails unexpectedly.
   *
   * @param lockRowId - ID of the lock row to release
   * @param errorMessage - Error message to store
   * @param tx - Optional transaction client
   */
  async releaseComputeLock(
    lockRowId: string,
    errorMessage: string,
    tx?: Prisma.TransactionClient
  ): Promise<void> {
    const client = tx || this.prisma;
    try {
      await client.sessionTelemetryCache.update({
        where: { id: lockRowId },
        data: {
          status: 'FAILED',
          errorMessage,
        },
      });
    } catch (error) {
      this.logger.error('Error releasing compute lock', {
        context: 'SessionTelemetryCacheRepository.releaseComputeLock',
        lockRowId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Reap stale COMPUTING rows that have been stuck for too long.
   *
   * RATIONALE:
   * - A crashed worker or network failure can leave COMPUTING rows forever
   * - This prevents new computations from starting (thundering herd protection works against us)
   * - By marking stale rows as STALE, we allow recomputation to be attempted
   *
   * @param staleAfterMinutes - Consider COMPUTING rows older than this as stale (default: 10)
   * @param maxRows - Maximum rows to reap per call (prevents long transactions)
   * @returns Count of reaped rows and their session IDs
   */
  async reapStaleComputingRows(
    staleAfterMinutes: number = 10,
    maxRows: number = 100
  ): Promise<{ reapedCount: number; sessionIds: string[] }> {
    try {
      const staleThreshold = new Date(Date.now() - staleAfterMinutes * 60 * 1000);

      // Find stale COMPUTING rows
      const staleRows = await this.prisma.sessionTelemetryCache.findMany({
        where: {
          status: 'COMPUTING',
          // updatedAt is automatically set by Prisma - if null/missing, use createdAt
          // COMPUTING rows that haven't been updated in staleAfterMinutes are stale
          updatedAt: {
            lt: staleThreshold,
          },
        },
        select: {
          id: true,
          sessionId: true,
        },
        take: maxRows,
      });

      if (staleRows.length === 0) {
        return { reapedCount: 0, sessionIds: [] };
      }

      const staleIds = staleRows.map(row => row.id);
      const sessionIds = staleRows.map(row => row.sessionId);

      // Mark as STALE to allow recomputation (not FAILED, since it wasn't a real failure)
      const result = await this.prisma.sessionTelemetryCache.updateMany({
        where: {
          id: { in: staleIds },
          status: 'COMPUTING',  // Double-check status to prevent race condition
        },
        data: {
          status: 'STALE',
          errorMessage: `Stale COMPUTING lock recovered after ${staleAfterMinutes} minutes`,
        },
      });

      this.logger.warn('Reaped stale COMPUTING rows', {
        context: 'SessionTelemetryCacheRepository.reapStaleComputingRows',
        reapedCount: result.count,
        sessionIds,
        staleAfterMinutes,
      });

      return {
        reapedCount: result.count,
        sessionIds,
      };
    } catch (error) {
      this.logger.error('Error reaping stale computing rows', {
        context: 'SessionTelemetryCacheRepository.reapStaleComputingRows',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
