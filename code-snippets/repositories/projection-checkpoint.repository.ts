/**
 * Projection Checkpoint Repository
 *
 * Handles per-projection checkpoint tracking for health event fanout pattern.
 * Enables independent retry: if 2/3 projections succeed, only retry the failed one.
 *
 * - (outboxEventId, projectionName) is UNIQUE
 * - Only one checkpoint per projection per event
 * - PROCESSING status should not persist >5 minutes (indicates crash)
 * - Completed checkpoints are skipped on retry (idempotent-replay semantics, at-least-once delivery)
 *
 * @module ProjectionCheckpointRepository
 */

import {
  PrismaClient,
  ProjectionCheckpoint,
  ProjectionCheckpointStatus,
  Prisma,
} from '@prisma/client';
import { BaseRepository } from './base.repository';
import { LoggerService } from '../services/logger.service';

/**
 * Input for creating or updating a projection checkpoint.
 */
export interface ProjectionCheckpointUpsertInput {
  outboxEventId: string;
  projectionName: string;
  status?: ProjectionCheckpointStatus;
  startedAt?: Date;
  error?: string;
}

/**
 * GAP E FIX: Result of attempting to acquire a projection lease.
 */
export interface LeaseAcquisitionResult {
  /** Whether the lease was successfully acquired */
  acquired: boolean;
  /** The checkpoint (always returned for context) */
  checkpoint?: ProjectionCheckpoint;
  /** Status of the existing checkpoint if lease was not acquired */
  existingStatus?: string;
}

/**
 * Summary of checkpoint statuses for an outbox event.
 */
export interface CheckpointSummary {
  outboxEventId: string;
  total: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  allCompleted: boolean;
  anyFailed: boolean;
}

/**
 * Repository for projection checkpoint operations.
 *
 * Implements the fanout checkpoint pattern for health event processing:
 * - One outbox event → multiple projections (health-rollup, sleep-summary, telemetry-cache)
 * - Each projection tracks its own status independently
 * - Failed projections can be retried without re-running successful ones
 */
export class ProjectionCheckpointRepository extends BaseRepository<ProjectionCheckpoint> {
  constructor(prisma: PrismaClient, logger: LoggerService) {
    super(prisma, 'ProjectionCheckpoint', logger);
  }

  /**
   * Find a checkpoint by outbox event ID and projection name.
   *
   * @param outboxEventId - The outbox event ID
   * @param projectionName - The projection name (e.g., 'health-rollup')
   * @returns The checkpoint or null if not found
   */
  async findByEventAndProjection(
    outboxEventId: string,
    projectionName: string
  ): Promise<ProjectionCheckpoint | null> {
    try {
      const checkpoint = await this.prisma.projectionCheckpoint.findUnique({
        where: {
          projection_checkpoint_unique: {
            outboxEventId,
            projectionName,
          },
        },
      });

      this.logSuccess('findByEventAndProjection', {
        outboxEventId,
        projectionName,
        found: !!checkpoint,
      });

      return checkpoint;
    } catch (error) {
      throw this.handleError(error, 'findByEventAndProjection');
    }
  }

  /**
   * Create or update a checkpoint (upsert).
   *
   * Used when starting projection processing:
   * - If checkpoint exists with COMPLETED status, returns existing (skip processing)
   * - If checkpoint exists with other status, updates to PROCESSING and increments retryCount
   * - If checkpoint doesn't exist, creates with PENDING or PROCESSING status
   *
   * @param input - Checkpoint data
   * @returns The created or updated checkpoint
   */
  async upsert(input: ProjectionCheckpointUpsertInput): Promise<ProjectionCheckpoint> {
    try {
      const checkpoint = await this.prisma.projectionCheckpoint.upsert({
        where: {
          projection_checkpoint_unique: {
            outboxEventId: input.outboxEventId,
            projectionName: input.projectionName,
          },
        },
        create: {
          outboxEventId: input.outboxEventId,
          projectionName: input.projectionName,
          status: input.status ?? 'PENDING',
          startedAt: input.startedAt,
          error: input.error,
          retryCount: 0,
        },
        update: {
          status: input.status,
          startedAt: input.startedAt,
          error: input.error,
          retryCount: { increment: 1 },
        },
      });

      this.logSuccess('upsert', {
        outboxEventId: input.outboxEventId,
        projectionName: input.projectionName,
        status: checkpoint.status,
      });

      return checkpoint;
    } catch (error) {
      throw this.handleError(error, 'upsert');
    }
  }

  /**
   * Mark a checkpoint as PROCESSING (starting execution).
   *
   * Called at the start of projection handler execution.
   *
   * @param outboxEventId - The outbox event ID
   * @param projectionName - The projection name
   * @returns Updated checkpoint
   */
  async markProcessing(
    outboxEventId: string,
    projectionName: string
  ): Promise<ProjectionCheckpoint> {
    try {
      // Generate UUID for the id field since dbgenerated() may not work in all Prisma contexts
      const { randomUUID } = await import('crypto');
      const checkpoint = await this.prisma.projectionCheckpoint.upsert({
        where: {
          projection_checkpoint_unique: {
            outboxEventId,
            projectionName,
          },
        },
        create: {
          id: randomUUID(),
          outboxEventId,
          projectionName,
          status: 'PROCESSING',
          startedAt: new Date(),
          retryCount: 0,
        },
        update: {
          status: 'PROCESSING',
          startedAt: new Date(),
          error: null,
          retryCount: { increment: 1 },
        },
      });

      this.logSuccess('markProcessing', {
        outboxEventId,
        projectionName,
        retryCount: checkpoint.retryCount,
      });

      return checkpoint;
    } catch (error) {
      throw this.handleError(error, 'markProcessing');
    }
  }

  /**
   * GAP E FIX: Attempt to acquire a lease for a projection checkpoint.
   *
   * Implements atomic lease-based concurrency control to prevent concurrent
   * duplicate execution of the same projection. Uses a conditional UPDATE
   * (CAS pattern) to atomically check and acquire the lease.
   *
   * Lease acquisition succeeds when:
   * - No existing checkpoint exists (creates one with lease)
   * - Existing checkpoint has status != PROCESSING (e.g., PENDING, FAILED)
   * - Existing checkpoint is PROCESSING with expired lease (takeover)
   * - Existing checkpoint is PROCESSING with NULL leaseExpiresAt (legacy)
   *
   * Lease acquisition fails when:
   * - Existing checkpoint has status COMPLETED (immutable)
   * - Existing checkpoint is PROCESSING with a fresh lease (another handler active)
   *
   * INVARIANTS:
   * - COMPLETED checkpoints are never re-acquired (immutable)
   * - Only one handler can hold a lease at a time (atomic CAS)
   * - Expired leases are treated as abandoned (takeover is safe)
   *
   * @param outboxEventId - The outbox event ID
   * @param projectionName - The projection name
   * @param leaseDurationMs - How long the lease should be held (default 60s)
   * @returns LeaseAcquisitionResult with `acquired` flag
   */
  async tryAcquireProjectionLease(
    outboxEventId: string,
    projectionName: string,
    leaseDurationMs: number = 60_000
  ): Promise<LeaseAcquisitionResult> {
    try {
      const now = new Date();
      const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);

      // Step 1: Check for existing checkpoint
      const existing = await this.prisma.projectionCheckpoint.findUnique({
        where: {
          projection_checkpoint_unique: {
            outboxEventId,
            projectionName,
          },
        },
      });

      // Step 2a: No existing checkpoint — create one with lease
      if (!existing) {
        try {
          const { randomUUID } = await import('crypto');
          const checkpoint = await this.prisma.projectionCheckpoint.create({
            data: {
              id: randomUUID(),
              outboxEventId,
              projectionName,
              status: 'PROCESSING',
              startedAt: now,
              leaseExpiresAt,
              retryCount: 0,
            },
          });

          this.logSuccess('tryAcquireProjectionLease:created', {
            outboxEventId,
            projectionName,
            leaseExpiresAt: leaseExpiresAt.toISOString(),
          });

          return { acquired: true, checkpoint };
        } catch (error) {
          // P2002 = unique constraint violation — another worker created it first
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            this.logger.info('Projection lease race lost on create (P2002)', {
              context: 'ProjectionCheckpointRepository.tryAcquireProjectionLease',
              outboxEventId,
              projectionName,
            });
            return { acquired: false, existingStatus: 'PROCESSING' };
          }
          throw error;
        }
      }

      // Step 2b: Existing checkpoint is COMPLETED — never re-acquire
      if (existing.status === 'COMPLETED') {
        return { acquired: false, checkpoint: existing, existingStatus: 'COMPLETED' };
      }

      // Step 2c: Existing checkpoint is PROCESSING with FRESH lease — skip
      if (
        existing.status === 'PROCESSING' &&
        existing.leaseExpiresAt &&
        existing.leaseExpiresAt > now
      ) {
        this.logger.info('Projection lease held by another handler (fresh)', {
          context: 'ProjectionCheckpointRepository.tryAcquireProjectionLease',
          outboxEventId,
          projectionName,
          existingLeaseExpiresAt: existing.leaseExpiresAt.toISOString(),
        });
        return { acquired: false, checkpoint: existing, existingStatus: 'PROCESSING' };
      }

      // Step 2d: Existing checkpoint is acquirable (PENDING, FAILED, or PROCESSING with expired/null lease)
      // Use updateMany with WHERE guard for atomic CAS.
      const result = await this.prisma.projectionCheckpoint.updateMany({
        where: {
          outboxEventId,
          projectionName,
          // Guard: only update if status is not COMPLETED AND
          // (status is not PROCESSING OR lease is expired/null)
          OR: [
            { status: { in: ['PENDING', 'FAILED'] } },
            {
              status: 'PROCESSING',
              leaseExpiresAt: { lt: now }, // expired lease
            },
            {
              status: 'PROCESSING',
              leaseExpiresAt: null, // legacy checkpoint without lease
            },
          ],
        },
        data: {
          status: 'PROCESSING',
          startedAt: now,
          leaseExpiresAt,
          error: null,
          retryCount: { increment: 1 },
        },
      });

      if (result.count > 0) {
        // Re-read for the updated checkpoint data
        const updated = await this.prisma.projectionCheckpoint.findUnique({
          where: {
            projection_checkpoint_unique: {
              outboxEventId,
              projectionName,
            },
          },
        });

        this.logSuccess('tryAcquireProjectionLease:acquired', {
          outboxEventId,
          projectionName,
          previousStatus: existing.status,
          retryCount: updated?.retryCount,
          leaseExpiresAt: leaseExpiresAt.toISOString(),
        });

        return { acquired: true, checkpoint: updated ?? undefined };
      }

      // CAS failed — another worker acquired the lease between our check and update
      this.logger.info('Projection lease CAS failed (concurrent acquisition)', {
        context: 'ProjectionCheckpointRepository.tryAcquireProjectionLease',
        outboxEventId,
        projectionName,
        existingStatus: existing.status,
      });
      return { acquired: false, checkpoint: existing, existingStatus: existing.status };
    } catch (error) {
      throw this.handleError(error, 'tryAcquireProjectionLease');
    }
  }

  /**
   * Mark a checkpoint as COMPLETED (successful execution).
   *
   * Called when projection handler finishes successfully.
   *
   * @param outboxEventId - The outbox event ID
   * @param projectionName - The projection name
   * @returns Updated checkpoint
   */
  async markCompleted(
    outboxEventId: string,
    projectionName: string
  ): Promise<ProjectionCheckpoint> {
    try {
      const checkpoint = await this.prisma.projectionCheckpoint.update({
        where: {
          projection_checkpoint_unique: {
            outboxEventId,
            projectionName,
          },
        },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          error: null,
          leaseExpiresAt: null, // GAP E: Release lease on completion
        },
      });

      this.logSuccess('markCompleted', {
        outboxEventId,
        projectionName,
      });

      return checkpoint;
    } catch (error) {
      throw this.handleError(error, 'markCompleted');
    }
  }

  /**
   * Mark a checkpoint as FAILED (execution error).
   *
   * Called when projection handler throws an error.
   *
   * @param outboxEventId - The outbox event ID
   * @param projectionName - The projection name
   * @param errorMessage - The error message
   * @returns Updated checkpoint
   */
  async markFailed(
    outboxEventId: string,
    projectionName: string,
    errorMessage: string
  ): Promise<ProjectionCheckpoint> {
    try {
      const checkpoint = await this.prisma.projectionCheckpoint.update({
        where: {
          projection_checkpoint_unique: {
            outboxEventId,
            projectionName,
          },
        },
        data: {
          status: 'FAILED',
          error: errorMessage.slice(0, 1000), // Truncate to prevent overflow
          leaseExpiresAt: null, // GAP E: Release lease on failure
        },
      });

      this.logSuccess('markFailed', {
        outboxEventId,
        projectionName,
        error: errorMessage.slice(0, 100),
      });

      return checkpoint;
    } catch (error) {
      throw this.handleError(error, 'markFailed');
    }
  }

  /**
   * Get all checkpoints for an outbox event.
   *
   * @param outboxEventId - The outbox event ID
   * @returns Array of checkpoints
   */
  async findByEvent(outboxEventId: string): Promise<ProjectionCheckpoint[]> {
    try {
      const checkpoints = await this.prisma.projectionCheckpoint.findMany({
        where: { outboxEventId },
        orderBy: { projectionName: 'asc' },
      });

      this.logSuccess('findByEvent', {
        outboxEventId,
        count: checkpoints.length,
      });

      return checkpoints;
    } catch (error) {
      throw this.handleError(error, 'findByEvent');
    }
  }

  /**
   * Get a summary of checkpoint statuses for an outbox event.
   *
   * @param outboxEventId - The outbox event ID
   * @returns Summary object with counts and boolean flags
   */
  async getSummary(outboxEventId: string): Promise<CheckpointSummary> {
    try {
      const checkpoints = await this.findByEvent(outboxEventId);

      const summary: CheckpointSummary = {
        outboxEventId,
        total: checkpoints.length,
        pending: checkpoints.filter((c) => c.status === 'PENDING').length,
        processing: checkpoints.filter((c) => c.status === 'PROCESSING').length,
        completed: checkpoints.filter((c) => c.status === 'COMPLETED').length,
        failed: checkpoints.filter((c) => c.status === 'FAILED').length,
        allCompleted: checkpoints.length > 0 && checkpoints.every((c) => c.status === 'COMPLETED'),
        anyFailed: checkpoints.some((c) => c.status === 'FAILED'),
      };

      return summary;
    } catch (error) {
      throw this.handleError(error, 'getSummary');
    }
  }

  /**
   * Find checkpoints that have been stuck in PROCESSING for too long.
   *
   * These are likely from crashed workers and should be reset to PENDING.
   *
   * @param staleThresholdMinutes - Minutes after which PROCESSING is considered stale (default 5)
   * @returns Array of stale checkpoints
   */
  async findStaleProcessing(staleThresholdMinutes: number = 5): Promise<ProjectionCheckpoint[]> {
    try {
      const cutoff = new Date(Date.now() - staleThresholdMinutes * 60 * 1000);

      const checkpoints = await this.prisma.projectionCheckpoint.findMany({
        where: {
          status: 'PROCESSING',
          startedAt: { lt: cutoff },
        },
        orderBy: { startedAt: 'asc' },
      });

      this.logSuccess('findStaleProcessing', {
        staleThresholdMinutes,
        count: checkpoints.length,
      });

      return checkpoints;
    } catch (error) {
      throw this.handleError(error, 'findStaleProcessing');
    }
  }

  /**
   * Reset stale PROCESSING checkpoints back to PENDING.
   *
   * Should be called periodically (e.g., before each outbox poll cycle)
   * to recover from worker crashes.
   *
   * @param staleThresholdMinutes - Minutes after which PROCESSING is considered stale (default 5)
   * @returns Number of recovered checkpoints
   */
  async recoverStaleProcessing(staleThresholdMinutes: number = 5): Promise<number> {
    try {
      const cutoff = new Date(Date.now() - staleThresholdMinutes * 60 * 1000);

      const result = await this.prisma.projectionCheckpoint.updateMany({
        where: {
          status: 'PROCESSING',
          startedAt: { lt: cutoff },
        },
        data: {
          status: 'PENDING',
          startedAt: null,
          leaseExpiresAt: null, // GAP E: Clear expired lease on recovery
          error: 'Recovered from stale PROCESSING state',
        },
      });

      if (result.count > 0) {
        this.logSuccess('recoverStaleProcessing', {
          staleThresholdMinutes,
          recovered: result.count,
        });
      }

      return result.count;
    } catch (error) {
      throw this.handleError(error, 'recoverStaleProcessing');
    }
  }

  /**
   * Find pending or failed checkpoints for retry.
   *
   * @param projectionName - Optional filter by projection name
   * @param limit - Maximum number of checkpoints to return (default 100)
   * @returns Array of checkpoints eligible for processing
   */
  async findPendingOrFailed(
    projectionName?: string,
    limit: number = 100
  ): Promise<ProjectionCheckpoint[]> {
    try {
      const where: Prisma.ProjectionCheckpointWhereInput = {
        status: { in: ['PENDING', 'FAILED'] },
        ...(projectionName && { projectionName }),
      };

      const checkpoints = await this.prisma.projectionCheckpoint.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { retryCount: 'asc' }],
        take: limit,
      });

      this.logSuccess('findPendingOrFailed', {
        projectionName,
        count: checkpoints.length,
      });

      return checkpoints;
    } catch (error) {
      throw this.handleError(error, 'findPendingOrFailed');
    }
  }

  /**
   * Create multiple checkpoints for an outbox event (one per projection).
   *
   * Used when initializing checkpoints for all projections when an event is first processed.
   *
   * @param outboxEventId - The outbox event ID
   * @param projectionNames - Array of projection names
   * @returns Number of checkpoints created
   */
  async createMany(
    outboxEventId: string,
    projectionNames: string[]
  ): Promise<number> {
    try {
      const result = await this.prisma.projectionCheckpoint.createMany({
        data: projectionNames.map((projectionName) => ({
          outboxEventId,
          projectionName,
          status: 'PENDING' as const,
          retryCount: 0,
        })),
        skipDuplicates: true, // Idempotent: skip if already exists
      });

      this.logSuccess('createMany', {
        outboxEventId,
        projectionNames,
        created: result.count,
      });

      return result.count;
    } catch (error) {
      throw this.handleError(error, 'createMany');
    }
  }

  /**
   * Delete all checkpoints for an outbox event.
   *
   * Called when cleaning up old events.
   *
   * @param outboxEventId - The outbox event ID
   * @returns Number of deleted checkpoints
   */
  async deleteByEvent(outboxEventId: string): Promise<number> {
    try {
      const result = await this.prisma.projectionCheckpoint.deleteMany({
        where: { outboxEventId },
      });

      this.logSuccess('deleteByEvent', {
        outboxEventId,
        deleted: result.count,
      });

      return result.count;
    } catch (error) {
      throw this.handleError(error, 'deleteByEvent');
    }
  }
}
