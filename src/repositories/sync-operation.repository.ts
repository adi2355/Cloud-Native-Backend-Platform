/**
 * Sync Operation Repository
 * 
 * Handles all synchronization operation tracking database operations for the AppPlatform backend.
 * Extends BaseRepository to provide consistent error handling and transaction support.
 * 
 * @module SyncOperationRepository
 */

import { PrismaClient, SyncOperation, SyncStatus, SyncType, Prisma } from '@prisma/client';
import { BaseRepository, PaginatedResponse, PaginationParams } from './base.repository';
import { AppError, ErrorCodes } from '../utils/AppError';
import { LoggerService } from '../services/logger.service';

export interface CreateSyncOperationInput {
  userId: string;
  deviceId?: string;
  operationType: SyncType;
  status?: SyncStatus;
  lastSyncAt?: Date;
  dataHash?: string;
  conflictCount?: number;
  resolvedCount?: number;
  errorMessage?: string;
  clientSyncOperationId?: string;
}

/**
 * Stale lock timeout for IN_PROGRESS operations.
 * If a SyncOperation has been IN_PROGRESS for longer than this duration,
 * it is considered abandoned (e.g., process crash) and eligible for retry.
 *
 * Exported so the sync service can derive the heartbeat interval (DRY).
 */
export const STALE_OPERATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface SyncOperationUpdateInput {
  status?: SyncStatus;
  lastSyncAt?: Date;
  dataHash?: string;
  conflictCount?: number;
  resolvedCount?: number;
  errorMessage?: string | null; // null to clear on retry reset
}

export interface SyncConflict {
  entityType: string;
  entityId: string;
  localVersion: Prisma.JsonValue;
  remoteVersion: Prisma.JsonValue;
  resolution?: 'local' | 'remote' | 'merge' | 'manual';
  resolvedAt?: Date;
}

export interface SyncStatistics {
  totalSyncs: number;
  successfulSyncs: number;
  failedSyncs: number;
  averageDuration: number;
  totalRecordsProcessed: number;
  totalConflictsResolved: number;
  lastSuccessfulSync?: Date;
  syncsByType: Record<string, number>;
}

export class SyncOperationRepository extends BaseRepository<SyncOperation> {
  constructor(prisma: PrismaClient, entityName: string, logger: LoggerService) {
    super(prisma, entityName, logger);
  }

  /**
   * Creates a new sync operation
   */
  async create(data: CreateSyncOperationInput): Promise<SyncOperation> {
    try {
      const syncOperation = await this.prisma.syncOperation.create({
        data: {
          ...data,
          status: data.status || SyncStatus.PENDING,
          lastSyncAt: data.lastSyncAt,
          conflictCount: data.conflictCount || 0,
          resolvedCount: data.resolvedCount || 0,
          // NOTE: SyncOperation does NOT have a version field - status-based coordination
        },
      });

      return syncOperation;
    } catch (error) {
      throw this.handleError(error, 'create');
    }
  }

  /**
   * Finds a sync operation by client-provided syncOperationId (user-scoped).
   *
   * Used for push-level idempotency: before processing a push request,
   * check if the same clientSyncOperationId was already processed.
   *
   * @returns The existing SyncOperation if found, null otherwise.
   */
  async findByClientSyncOperationId(
    userId: string,
    clientSyncOperationId: string,
  ): Promise<SyncOperation | null> {
    try {
      const syncOperation = await this.prisma.syncOperation.findFirst({
        where: {
          userId,
          clientSyncOperationId,
        },
      });

      return syncOperation;
    } catch (error) {
      throw this.handleError(error, 'findByClientSyncOperationId');
    }
  }

  /**
   * Stores the cached result payload on a completed SyncOperation.
   * This enables idempotent retry responses without re-processing.
   *
   * @param id - SyncOperation DB ID
   * @param userId - User ID (ownership check)
   * @param resultPayload - Serializable PushSyncResult to cache
   */
  async storeResultPayload(
    id: string,
    userId: string,
    resultPayload: Prisma.InputJsonValue,
  ): Promise<void> {
    try {
      await this.prisma.syncOperation.update({
        where: { id, userId },
        data: {
          resultPayload,
          updatedAt: new Date(),
        },
      });
    } catch (error) {
      throw this.handleError(error, 'storeResultPayload');
    }
  }

  /**
   * Determines whether a stale IN_PROGRESS operation should be treated as abandoned.
   * A SyncOperation is stale if it has been IN_PROGRESS for longer than
   * STALE_OPERATION_TIMEOUT_MS (5 minutes), indicating a likely process crash.
   *
   * Uses `updatedAt` (not `createdAt`) because operations can be reset for retry
   * via update(), which refreshes `updatedAt`. Using `createdAt` would cause a
   * reset operation to be immediately detected as stale (since createdAt is immutable),
   * allowing concurrent duplicate processing — the exact scenario this guard prevents.
   *
   * @param operation - The SyncOperation to check
   * @returns true if the operation is stale and can be retried
   */
  isStaleInProgress(operation: SyncOperation): boolean {
    if (operation.status !== SyncStatus.IN_PROGRESS) {
      return false;
    }
    const elapsed = Date.now() - operation.updatedAt.getTime();
    return elapsed > STALE_OPERATION_TIMEOUT_MS;
  }

  /**
   * Refreshes the liveness timestamp (`updatedAt`) for an IN_PROGRESS operation.
   *
   * Called periodically during the processing loop of processPushSync to prevent
   * false stale detection by concurrent requests. Without this heartbeat, a
   * long-running but legitimate processing loop (>5 min) would appear stale,
   * allowing a concurrent request to reap and re-process the same operation —
   * causing duplicate writes.
   *
   * Dual-purpose:
   *   1. Refreshes `updatedAt` → extends liveness window
   *   2. Returns ownership status → if the operation is no longer IN_PROGRESS
   *      (reaped by another request, cancelled, etc.), the caller should abort.
   *
   * Uses `updateMany` (not `update`) to include `status: IN_PROGRESS` in the
   * WHERE clause. If the operation was transitioned out of IN_PROGRESS, the
   * update is a no-op (count=0) rather than an error.
   *
   * @param id - SyncOperation DB ID (caller already verified ownership at acquisition)
   * @param userId - User ID (scoped for safety)
   * @returns true if the operation is still IN_PROGRESS (alive), false if reaped
   */
  async heartbeat(id: string, userId: string): Promise<boolean> {
    try {
      const result = await this.prisma.syncOperation.updateMany({
        where: {
          id,
          userId,
          status: SyncStatus.IN_PROGRESS,
        },
        data: {
          updatedAt: new Date(),
        },
      });
      return result.count > 0;
    } catch (error) {
      throw this.handleError(error, 'heartbeat');
    }
  }

  /**
   * Finds a sync operation by ID (user-scoped for security)
   */
  async findById(id: string, userId: string): Promise<SyncOperation | null> {
    try {
      const syncOperation = await this.prisma.syncOperation.findFirst({
        where: { id, userId },
      });

      return syncOperation;
    } catch (error) {
      throw this.handleError(error, 'findById');
    }
  }

  /**
   * Finds sync operations by user ID with optional deviceId filter
   */
  async findByUserId(
    userId: string,
    options?: PaginationParams & { status?: SyncStatus; deviceId?: string },
  ): Promise<PaginatedResponse<SyncOperation>> {
    try {
      const where: Prisma.SyncOperationWhereInput = {
        userId,
        ...(options?.status && { status: options.status }),
        ...(options?.deviceId && { deviceId: options.deviceId }),
      };

      // Calculate skip/take from page/pageSize
      const page = options?.page || 1;
      const pageSize = options?.pageSize || 20;
      const skip = (page - 1) * pageSize;

      const [operations, total] = await Promise.all([
        this.prisma.syncOperation.findMany({
          where,
          skip,
          take: pageSize,
          orderBy: { createdAt: 'desc' },
        }),
        this.prisma.syncOperation.count({ where }),
      ]);

      return {
        items: operations,
        total,
        page,
        pageSize,
        hasMore: operations.length === pageSize && skip + operations.length < total,
        totalPages: Math.ceil(total / pageSize),
      };
    } catch (error) {
      throw this.handleError(error, 'findByUserId');
    }
  }

  /**
   * Finds pending sync operations
   */
  async findPendingSync(
    userId?: string,
    deviceId?: string,
  ): Promise<SyncOperation[]> {
    try {
      const where: Prisma.SyncOperationWhereInput = {
        status: { in: [SyncStatus.PENDING, SyncStatus.IN_PROGRESS] },
        ...(userId && { userId }),
        ...(deviceId && { deviceId }),
      };

      const operations = await this.prisma.syncOperation.findMany({
        where,
        orderBy: { createdAt: 'asc' },
      });

      return operations;
    } catch (error) {
      throw this.handleError(error, 'findPendingSync');
    }
  }

  /**
   * Finds the last successful sync operation for a user and device
   */
  async findLastSuccessful(
    userId: string,
    deviceId?: string,
  ): Promise<SyncOperation | null> {
    try {
      const where: Prisma.SyncOperationWhereInput = {
        userId,
        status: SyncStatus.COMPLETED,
        ...(deviceId && { deviceId }),
      };

      const syncOperation = await this.prisma.syncOperation.findFirst({
        where,
        orderBy: { updatedAt: 'desc' },
      });

      return syncOperation;
    } catch (error) {
      throw this.handleError(error, 'findLastSuccessful');
    }
  }

  /**
   * Updates a sync operation (user-scoped for security)
   */
  async update(
    id: string,
    userId: string,
    data: SyncOperationUpdateInput,
  ): Promise<SyncOperation> {
    try {
      // Verify ownership first
      const existing = await this.findById(id, userId);
      if (!existing) {
        throw new AppError(404, ErrorCodes.NOT_FOUND, 'Sync operation not found or access denied');
      }

      const syncOperation = await this.prisma.syncOperation.update({
        where: { id, userId },
        data: {
          ...data,
          updatedAt: new Date(),
        },
      });

      return syncOperation;
    } catch (error) {
      throw this.handleError(error, 'update');
    }
  }

  /**
   * Marks a sync operation as completed with optional result payload (user-scoped for security).
   *
   * This eliminates the window where a SyncOperation is COMPLETED but has no
   * cached result — which previously caused idempotent retries to return empty
   * results and lose server ID mappings (lost-ack scenario).
   *
   * @param id - SyncOperation DB ID
   * @param userId - User ID (ownership check)
   * @param recordsProcessed - Number of records successfully processed
   * @param conflictsResolved - Number of conflicts resolved (default: 0)
   * @param resultPayload - Serializable PushSyncResult to cache for idempotent retries
   */
  async markAsCompleted(
    id: string,
    userId: string,
    recordsProcessed: number,
    conflictsResolved: number = 0,
    resultPayload?: Prisma.InputJsonValue,
  ): Promise<SyncOperation> {
    try {
      // Verify ownership first
      const existing = await this.findById(id, userId);
      if (!existing) {
        throw new AppError(404, ErrorCodes.NOT_FOUND, 'Sync operation not found or access denied');
      }

      const now = new Date();
      const syncOperation = await this.prisma.syncOperation.update({
        where: { id, userId },
        data: {
          status: SyncStatus.COMPLETED,
          lastSyncAt: now,
          resolvedCount: conflictsResolved || 0,
          updatedAt: now,
          // Atomic: store result payload in the SAME write as status change.
          // Prevents COMPLETED-without-payload state that breaks idempotent retries.
          ...(resultPayload !== undefined ? { resultPayload } : {}),
        },
      });

      return syncOperation;
    } catch (error) {
      throw this.handleError(error, 'mark sync as completed');
    }
  }

  /**
   * Marks a sync operation as failed (user-scoped for security)
   */
  async markAsFailed(
    id: string,
    userId: string,
    errorMessage: string,
    recordsProcessed?: number,
    recordsFailed?: number,
  ): Promise<SyncOperation> {
    try {
      // Verify ownership first
      const existing = await this.findById(id, userId);
      if (!existing) {
        throw new AppError(404, ErrorCodes.NOT_FOUND, 'Sync operation not found or access denied');
      }

      const syncOperation = await this.prisma.syncOperation.update({
        where: { id, userId },
        data: {
          status: SyncStatus.FAILED,
          lastSyncAt: new Date(),
          errorMessage,
          updatedAt: new Date(),
        },
      });

      return syncOperation;
    } catch (error) {
      throw this.handleError(error, 'mark sync as failed');
    }
  }

  /**
   * Handles sync conflicts
   */
  async handleConflicts(
    syncOperationId: string,
    conflicts: SyncConflict[],
  ): Promise<boolean> {
    try {
      // Update sync operation with conflict counts
      const syncOperation = await this.prisma.syncOperation.findUnique({
        where: { id: syncOperationId },
      });

      if (!syncOperation) {
        throw new AppError(404, ErrorCodes.NOT_FOUND, 'Sync operation not found');
      }

      // Count resolved conflicts
      const resolvedCount = conflicts.filter(c => c.resolution).length;

      await this.prisma.syncOperation.update({
        where: { id: syncOperationId },
        data: {
          conflictCount: conflicts.length,
          resolvedCount,
          updatedAt: new Date(),
        },
      });

      return true;
    } catch (error) {
      throw this.handleError(error, 'handle sync conflicts');
    }
  }

  /**
   * Gets the last successful sync for a user
   */
  async getLastSuccessfulSync(
    userId: string,
    deviceId?: string,
  ): Promise<SyncOperation | null> {
    try {
      const syncOperation = await this.prisma.syncOperation.findFirst({
        where: {
          userId,
          status: SyncStatus.COMPLETED,
          ...(deviceId && { deviceId }),
        },
        orderBy: { updatedAt: 'desc' },
      });

      return syncOperation;
    } catch (error) {
      throw this.handleError(error, 'get last successful sync');
    }
  }

  /**
   * Gets sync statistics for a user
   */
  async getSyncStatistics(
    userId: string,
    days: number = 30,
  ): Promise<SyncStatistics> {
    try {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      const operations = await this.prisma.syncOperation.findMany({
        where: {
          userId,
          createdAt: { gte: startDate },
        },
      });

      const totalSyncs = operations.length;
      const successfulSyncs = operations.filter(op => op.status === SyncStatus.COMPLETED).length;
      const failedSyncs = operations.filter(op => op.status === SyncStatus.FAILED).length;

      const completedOps = operations.filter(op => op.status === SyncStatus.COMPLETED && op.lastSyncAt);
      const averageDuration = completedOps.length > 0
        ? completedOps.reduce((sum, op) => {
            const duration = op.lastSyncAt!.getTime() - op.createdAt.getTime();
            return sum + duration;
          }, 0) / completedOps.length
        : 0;

      const totalRecordsProcessed = operations.reduce((sum, op) => sum + (op.resolvedCount || 0), 0);
      const totalConflictsResolved = operations.reduce((sum, op) => sum + (op.resolvedCount || 0), 0);

      const lastSuccessful = operations
        .filter(op => op.status === SyncStatus.COMPLETED)
        .sort((a, b) => (b.lastSyncAt?.getTime() || 0) - (a.lastSyncAt?.getTime() || 0))[0];

      // Group by operation type
      const syncsByType: Record<string, number> = {};

      operations.forEach(op => {
        syncsByType[op.operationType] = (syncsByType[op.operationType] || 0) + 1;
      });

      return {
        totalSyncs,
        successfulSyncs,
        failedSyncs,
        averageDuration,
        totalRecordsProcessed,
        totalConflictsResolved,
        lastSuccessfulSync: lastSuccessful?.lastSyncAt || undefined,
        syncsByType,
      };
    } catch (error) {
      throw this.handleError(error, 'get sync statistics');
    }
  }

  /**
   * Cancels pending sync operations
   */
  async cancelPendingOperations(
    userId: string,
    deviceId?: string,
  ): Promise<number> {
    try {
      const result = await this.prisma.syncOperation.updateMany({
        where: {
          userId,
          status: { in: [SyncStatus.PENDING, SyncStatus.IN_PROGRESS] },
          ...(deviceId && { deviceId }),
        },
        data: {
          status: SyncStatus.CONFLICT,
          lastSyncAt: new Date(),
          errorMessage: 'Cancelled by user',
          updatedAt: new Date(),
        },
      });

      return result.count;
    } catch (error) {
      throw this.handleError(error, 'cancel pending sync operations');
    }
  }

  /**
   * Cleans up old sync operations
   */
  async cleanupOldOperations(
    daysToKeep: number = 90,
  ): Promise<number> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

      const result = await this.prisma.syncOperation.deleteMany({
        where: {
          updatedAt: {
            lt: cutoffDate,
          },
          status: {
            in: [SyncStatus.COMPLETED, SyncStatus.FAILED, SyncStatus.CONFLICT],
          },
        },
      });

      return result.count;
    } catch (error) {
      throw this.handleError(error, 'cleanup old sync operations');
    }
  }

  /**
   * Gets sync operation details with conflict information (user-scoped for security)
   */
  async getOperationWithConflicts(
    id: string,
    userId: string,
  ): Promise<SyncOperation & { conflicts?: SyncConflict[] }> {
    try {
      const operation = await this.prisma.syncOperation.findFirst({
        where: { id, userId },
      });

      if (!operation) {
        throw new AppError(404, ErrorCodes.NOT_FOUND, 'Sync operation not found or access denied');
      }

      // Since metadata field doesn't exist, we return empty conflicts array
      const conflicts: SyncConflict[] = [];

      return {
        ...operation,
        conflicts,
      };
    } catch (error) {
      throw this.handleError(error, 'get operation with conflicts');
    }
  }
}