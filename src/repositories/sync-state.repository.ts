/**
 * Sync State Repository
 * 
 * Manages device synchronization state for the AppPlatform application.
 * Implements distributed locking and state management for offline-first sync.
 * 
 * Key responsibilities:
 * - Track sync state per user/device combination
 * - Implement distributed sync locks to prevent concurrent syncs
 * - Maintain sync tokens for delta synchronization
 * - Monitor sync progress and health metrics
 * 
 * @see https://martinfowler.com/articles/patterns-of-distributed-systems/state-watch.html
 */

import { PrismaClient, SyncState, Prisma } from '@prisma/client';
import { BaseRepository, PaginatedResponse, PaginationParams } from './base.repository';
import { LoggerService } from '../services/logger.service';

/**
 * Input for creating or updating sync state
 */
export interface SyncStateInput {
  userId: string;
  deviceId: string;
  lastSyncToken?: string;
  lastCursor?: string; // Cursor-based approach for incremental sync
  lastSyncAt?: Date;
  pendingChanges?: number;
  syncVersion?: number;
  metadata?: Prisma.JsonValue;
}

/**
 * Input for updating sync progress
 */
export interface UpdateSyncProgressInput {
  userId: string;
  deviceId: string;
  pendingChanges: number;
  lastSyncToken?: string;
}

/**
 * Sync lock acquisition result
 */
export interface SyncLockResult {
  acquired: boolean;
  syncState: SyncState | null;
  reason?: string;
}

/**
 * Sync status summary
 */
export interface SyncStatusSummary {
  isInProgress: boolean;
  lastSyncAt: Date | null;
  pendingChanges: number;
  syncVersion: number;
  deviceCount: number;
  healthStatus: 'healthy' | 'warning' | 'critical';
}

/**
 * Repository for managing sync state in the AppPlatform system
 */
export class SyncStateRepository extends BaseRepository<SyncState> {
  private readonly SYNC_LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  constructor(prisma: PrismaClient, entityName: string, logger: LoggerService) {
    super(prisma, entityName, logger);
  }

  /**
   * Get or create sync state for a user/device combination
   * 
   * @param userId - User ID
   * @param deviceId - Device ID
   * @returns Sync state record
   */
  async getOrCreateSyncState(userId: string, deviceId: string): Promise<SyncState> {
    try {
      this.logger.debug('Getting or creating sync state', {
        context: 'SyncStateRepository.getOrCreateSyncState',
        userId,
        deviceId,
      });

      // Try to find existing sync state
      let syncState = await this.prisma.syncState.findUnique({
        where: {
          userId_deviceId: {
            userId,
            deviceId,
          },
        },
      });

      if (!syncState) {
        // Create new sync state with explicit version for optimistic locking
        syncState = await this.prisma.syncState.create({
          data: {
            userId,
            deviceId,
            pendingChanges: 0,
            syncInProgress: false,
            syncVersion: 1,
            version: 1, // Explicit initial version for optimistic locking
          },
        });

        this.logger.info('New sync state created', {
          context: 'SyncStateRepository.getOrCreateSyncState',
          syncStateId: syncState.id,
          userId,
          deviceId,
        });
      }

      return syncState;
    } catch (error) {
      this.handleError(error, 'getOrCreateSyncState');
    }
  }

  /**
   * Update sync state after successful sync
   *
   * @param input - Sync state update parameters
   * @returns Updated sync state
   */
  async updateSyncState(input: SyncStateInput): Promise<SyncState> {
    try {
      this.logger.debug('Updating sync state', {
        context: 'SyncStateRepository.updateSyncState',
        userId: input.userId,
        deviceId: input.deviceId,
      });

      // First try to find existing record for optimistic locking
      const existing = await this.prisma.syncState.findUnique({
        where: {
          userId_deviceId: {
            userId: input.userId,
            deviceId: input.deviceId,
          },
        },
      });

      const syncState = await this.prisma.syncState.upsert({
        where: {
          userId_deviceId: {
            userId: input.userId,
            deviceId: input.deviceId,
          },
          // Optimistic lock: include version if record exists
          ...(existing && { version: existing.version }),
        },
        update: {
          lastSyncToken: input.lastSyncToken,
          lastCursor: input.lastCursor,
          lastSyncAt: input.lastSyncAt || new Date(),
          pendingChanges: input.pendingChanges ?? 0,
          syncVersion: input.syncVersion,
          metadata: input.metadata ?? Prisma.DbNull,
          syncInProgress: false, // Clear sync lock
          lockOwner: null, // Clear lock owner
          lockAcquiredAt: null, // Clear lock timestamp
          version: { increment: 1 }, // Atomic version increment on update
        },
        create: {
          userId: input.userId,
          deviceId: input.deviceId,
          lastSyncToken: input.lastSyncToken,
          lastCursor: input.lastCursor,
          lastSyncAt: input.lastSyncAt || new Date(),
          pendingChanges: input.pendingChanges ?? 0,
          syncVersion: input.syncVersion ?? 1,
          metadata: input.metadata ?? Prisma.DbNull,
          syncInProgress: false,
          lockOwner: null,
          lockAcquiredAt: null,
          version: 1, // Explicit initial version for optimistic locking
        },
      });

      this.logger.info('Sync state updated', {
        context: 'SyncStateRepository.updateSyncState',
        syncStateId: syncState.id,
        userId: input.userId,
        deviceId: input.deviceId,
        lastSyncToken: input.lastSyncToken,
        lastCursor: input.lastCursor,
      });

      return syncState;
    } catch (error) {
      throw this.handleError(error, 'updateSyncState', { isOptimisticUpdate: true });
    }
  }

  /**
   * Acquire sync lock for a device (distributed lock pattern)
   * Prevents concurrent sync operations using lockOwner and lockAcquiredAt
   *
   * @param userId - User ID
   * @param deviceId - Device ID
   * @param lockOwner - Identifier for the process acquiring the lock
   * @param force - Force acquire even if locked
   * @returns Lock acquisition result
   */
  async acquireSyncLock(
    userId: string,
    deviceId: string,
    lockOwner: string,
    force: boolean = false,
  ): Promise<SyncLockResult> {
    try {
      this.logger.debug('Attempting to acquire sync lock', {
        context: 'SyncStateRepository.acquireSyncLock',
        userId,
        deviceId,
        lockOwner,
        force,
      });

      // Get current sync state
      const currentState = await this.getOrCreateSyncState(userId, deviceId);

      // Check if sync is already in progress
      if (currentState.syncInProgress && !force) {
        // Check if lock is stale (older than timeout)
        const lockAge = currentState.lockAcquiredAt
          ? Date.now() - currentState.lockAcquiredAt.getTime()
          : Date.now() - currentState.updatedAt.getTime();

        if (lockAge < this.SYNC_LOCK_TIMEOUT_MS) {
          this.logger.warn('Sync lock already held', {
            context: 'SyncStateRepository.acquireSyncLock',
            userId,
            deviceId,
            currentLockOwner: currentState.lockOwner,
            lockAge,
          });

          return {
            acquired: false,
            syncState: currentState,
            reason: `Sync already in progress for this device (owner: ${currentState.lockOwner})`,
          };
        }

        // Stale lock detected - force acquisition by skipping syncInProgress check
        this.logger.warn('Stale sync lock detected, forcing acquisition', {
          context: 'SyncStateRepository.acquireSyncLock',
          userId,
          deviceId,
          staleLockOwner: currentState.lockOwner,
          lockAge,
        });
        force = true; // Enable forced acquisition to bypass syncInProgress check
      }

      const now = new Date();

      // Try to acquire lock atomically with enhanced locking fields + optimistic locking
      const updatedState = await this.prisma.syncState.update({
        where: {
          id: currentState.id,
          // Optimistic locking - check version and syncInProgress state
          version: currentState.version,
          ...(force ? {} : { syncInProgress: false }),
        },
        data: {
          syncInProgress: true,
          lockOwner,
          lockAcquiredAt: now,
          version: { increment: 1 }, // Atomic version increment
        },
      }).catch((error) => {
        // Handle race condition where another process acquired the lock
        if (error.code === 'P2025') {
          return null;
        }
        throw error;
      });

      if (!updatedState) {
        return {
          acquired: false,
          syncState: currentState,
          reason: 'Failed to acquire lock - another sync may be in progress',
        };
      }

      this.logger.info('Sync lock acquired', {
        context: 'SyncStateRepository.acquireSyncLock',
        syncStateId: updatedState.id,
        userId,
        deviceId,
        lockOwner,
        lockAcquiredAt: now,
      });

      return {
        acquired: true,
        syncState: updatedState,
      };
    } catch (error) {
      this.handleError(error, 'acquireSyncLock');
    }
  }

  /**
   * Release sync lock for a device
   *
   * @param userId - User ID
   * @param deviceId - Device ID
   * @param lockOwner - Identifier for the process releasing the lock
   * @param updateToken - Optional new sync token
   * @param lastCursor - Optional new cursor position
   * @returns Updated sync state
   */
  async releaseSyncLock(
    userId: string,
    deviceId: string,
    lockOwner: string,
    updateToken?: string,
    lastCursor?: string,
  ): Promise<SyncState> {
    try {
      this.logger.debug('Releasing sync lock', {
        context: 'SyncStateRepository.releaseSyncLock',
        userId,
        deviceId,
        lockOwner,
      });

      // Get current state for optimistic locking
      const currentState = await this.prisma.syncState.findUnique({
        where: {
          userId_deviceId: {
            userId,
            deviceId,
          },
        },
      });

      if (!currentState || currentState.lockOwner !== lockOwner) {
        throw new Error('Cannot release lock: not the lock owner');
      }

      const syncState = await this.prisma.syncState.update({
        where: {
          userId_deviceId: {
            userId,
            deviceId,
          },
          // Ensure only the lock owner can release the lock
          lockOwner,
          version: currentState.version, // Optimistic lock check
        },
        data: {
          syncInProgress: false,
          lockOwner: null,
          lockAcquiredAt: null,
          ...(updateToken && { lastSyncToken: updateToken }),
          ...(lastCursor && { lastCursor }),
          lastSyncAt: new Date(),
          version: { increment: 1 }, // Atomic version increment
        },
      });

      this.logger.info('Sync lock released', {
        context: 'SyncStateRepository.releaseSyncLock',
        syncStateId: syncState.id,
        userId,
        deviceId,
        lockOwner,
        updateToken,
        lastCursor,
      });

      return syncState;
    } catch (error) {
      throw this.handleError(error, 'releaseSyncLock', { isOptimisticUpdate: true });
    }
  }

  /**
   * Get sync status summary for a user
   * 
   * @param userId - User ID
   * @returns Sync status summary
   */
  async getSyncStatus(userId: string): Promise<SyncStatusSummary> {
    try {
      this.logger.debug('Getting sync status', {
        context: 'SyncStateRepository.getSyncStatus',
        userId,
      });

      const syncStates = await this.prisma.syncState.findMany({
        where: { userId },
        orderBy: { lastSyncAt: 'desc' },
      });

      if (syncStates.length === 0) {
        return {
          isInProgress: false,
          lastSyncAt: null,
          pendingChanges: 0,
          syncVersion: 1,
          deviceCount: 0,
          healthStatus: 'healthy',
        };
      }

      const isInProgress = syncStates.some(s => s.syncInProgress);
      const totalPendingChanges = syncStates.reduce((sum, s) => sum + s.pendingChanges, 0);
      const firstSyncState = syncStates[0];
      const lastSyncAt = firstSyncState?.lastSyncAt || null;
      const maxSyncVersion = Math.max(...syncStates.map(s => s.syncVersion));

      // Calculate health status
      let healthStatus: 'healthy' | 'warning' | 'critical' = 'healthy';
      if (totalPendingChanges > 1000) {
        healthStatus = 'critical';
      } else if (totalPendingChanges > 100) {
        healthStatus = 'warning';
      } else if (lastSyncAt) {
        const hoursSinceSync = (Date.now() - lastSyncAt.getTime()) / (1000 * 60 * 60);
        if (hoursSinceSync > 24) {
          healthStatus = 'warning';
        }
        if (hoursSinceSync > 72) {
          healthStatus = 'critical';
        }
      }

      return {
        isInProgress,
        lastSyncAt,
        pendingChanges: totalPendingChanges,
        syncVersion: maxSyncVersion,
        deviceCount: syncStates.length,
        healthStatus,
      };
    } catch (error) {
      this.handleError(error, 'getSyncStatus');
    }
  }

  /**
   * Get all sync states for a user
   * 
   * @param userId - User ID
   * @param params - Pagination parameters
   * @returns Paginated list of sync states
   */
  async getUserSyncStates(
    userId: string,
    params?: PaginationParams,
  ): Promise<PaginatedResponse<SyncState>> {
    try {
      this.logger.debug('Fetching user sync states', {
        context: 'SyncStateRepository.getUserSyncStates',
        userId,
      });

      const where: Prisma.SyncStateWhereInput = { userId };

      return await this.findManyWithPagination(
        (args: Prisma.SyncStateFindManyArgs) => this.prisma.syncState.findMany(args),
        (args: Prisma.SyncStateCountArgs) => this.prisma.syncState.count(args),
        {
          ...params,
          where,
          orderBy: params?.orderBy || { lastSyncAt: 'desc' },
        },
      );
    } catch (error) {
      this.handleError(error, 'getUserSyncStates');
    }
  }

  /**
   * Update pending changes count
   * 
   * @param input - Update parameters
   * @returns Updated sync state
   */
  async updatePendingChanges(input: UpdateSyncProgressInput): Promise<SyncState> {
    try {
      this.logger.debug('Updating pending changes', {
        context: 'SyncStateRepository.updatePendingChanges',
        userId: input.userId,
        deviceId: input.deviceId,
        pendingChanges: input.pendingChanges,
      });

      const syncState = await this.prisma.syncState.update({
        where: {
          userId_deviceId: {
            userId: input.userId,
            deviceId: input.deviceId,
          },
        },
        data: {
          pendingChanges: input.pendingChanges,
          ...(input.lastSyncToken && { lastSyncToken: input.lastSyncToken }),
        },
      });

      this.logger.info('Pending changes updated', {
        context: 'SyncStateRepository.updatePendingChanges',
        syncStateId: syncState.id,
        pendingChanges: input.pendingChanges,
      });

      return syncState;
    } catch (error) {
      this.handleError(error, 'updatePendingChanges');
    }
  }

  /**
   * Clean up stale sync locks across all users (ADMIN ONLY)
   * Use this method for system-wide maintenance operations
   *
   * @param olderThan - Release locks older than this duration
   * @returns Number of locks released
   */
  async cleanupStaleLocksAdmin(olderThan: Date): Promise<number> {
    try {
      this.logger.debug('Cleaning up stale sync locks (admin operation)', {
        context: 'SyncStateRepository.cleanupStaleLocksAdmin',
        olderThan: olderThan.toISOString(),
      });

      const result = await this.prisma.syncState.updateMany({
        where: {
          syncInProgress: true,
          OR: [
            {
              lockAcquiredAt: {
                lt: olderThan,
              },
            },
            {
              // Fallback for records without lockAcquiredAt
              lockAcquiredAt: null,
              updatedAt: {
                lt: olderThan,
              },
            },
          ],
        },
        data: {
          syncInProgress: false,
          lockOwner: null,
          lockAcquiredAt: null,
        },
      });

      if (result.count > 0) {
        this.logger.warn('Stale sync locks cleaned up (admin)', {
          context: 'SyncStateRepository.cleanupStaleLocksAdmin',
          releasedCount: result.count,
          olderThan: olderThan.toISOString(),
        });
      }

      return result.count;
    } catch (error) {
      this.handleError(error, 'cleanupStaleLocksAdmin');
    }
  }

  /**
   * Clean up stale sync locks for a specific user
   *
   * @param userId - User ID
   * @param olderThan - Release locks older than this duration
   * @returns Number of locks released
   */
  async cleanupStaleLocks(userId: string, olderThan: Date): Promise<number> {
    try {
      this.logger.debug('Cleaning up stale sync locks for user', {
        context: 'SyncStateRepository.cleanupStaleLocks',
        userId,
        olderThan: olderThan.toISOString(),
      });

      const result = await this.prisma.syncState.updateMany({
        where: {
          userId, // SECURITY: User-scoped
          syncInProgress: true,
          OR: [
            {
              lockAcquiredAt: {
                lt: olderThan,
              },
            },
            {
              // Fallback for records without lockAcquiredAt
              lockAcquiredAt: null,
              updatedAt: {
                lt: olderThan,
              },
            },
          ],
        },
        data: {
          syncInProgress: false,
          lockOwner: null,
          lockAcquiredAt: null,
        },
      });

      if (result.count > 0) {
        this.logger.warn('Stale sync locks cleaned up', {
          context: 'SyncStateRepository.cleanupStaleLocks',
          userId,
          releasedCount: result.count,
          olderThan: olderThan.toISOString(),
        });
      }

      return result.count;
    } catch (error) {
      this.handleError(error, 'cleanupStaleLocks');
    }
  }

  /**
   * Reset sync state for a device
   * Used for troubleshooting or forced resync
   *
   * @param userId - User ID
   * @param deviceId - Device ID
   * @returns Reset sync state
   */
  async resetSyncState(userId: string, deviceId: string): Promise<SyncState> {
    try {
      this.logger.warn('Resetting sync state', {
        context: 'SyncStateRepository.resetSyncState',
        userId,
        deviceId,
      });

      const syncState = await this.prisma.syncState.update({
        where: {
          userId_deviceId: {
            userId,
            deviceId,
          },
        },
        data: {
          lastSyncToken: null,
          lastCursor: null,
          lastSyncAt: null,
          pendingChanges: 0,
          syncInProgress: false,
          syncVersion: 1,
          metadata: undefined,
          lockOwner: null,
          lockAcquiredAt: null,
        },
      });

      this.logger.info('Sync state reset', {
        context: 'SyncStateRepository.resetSyncState',
        syncStateId: syncState.id,
        userId,
        deviceId,
      });

      return syncState;
    } catch (error) {
      this.handleError(error, 'resetSyncState');
    }
  }

  /**
   * Get cursor position for a device
   * Used for cursor-based incremental sync
   *
   * @param userId - User ID
   * @param deviceId - Device ID
   * @returns Current cursor position or null if not set
   */
  async getCursorPosition(userId: string, deviceId: string): Promise<string | null> {
    try {
      this.logger.debug('Getting cursor position', {
        context: 'SyncStateRepository.getCursorPosition',
        userId,
        deviceId,
      });

      const syncState = await this.prisma.syncState.findUnique({
        where: {
          userId_deviceId: {
            userId,
            deviceId,
          },
        },
        select: {
          lastCursor: true,
        },
      });

      return syncState?.lastCursor || null;
    } catch (error) {
      this.handleError(error, 'getCursorPosition');
    }
  }

  /**
   * Update cursor position after incremental sync
   *
   * @param userId - User ID
   * @param deviceId - Device ID
   * @param cursor - New cursor position
   * @returns Updated sync state
   */
  async updateCursorPosition(
    userId: string,
    deviceId: string,
    cursor: string,
  ): Promise<SyncState> {
    try {
      this.logger.debug('Updating cursor position', {
        context: 'SyncStateRepository.updateCursorPosition',
        userId,
        deviceId,
        cursor,
      });

      const syncState = await this.prisma.syncState.update({
        where: {
          userId_deviceId: {
            userId,
            deviceId,
          },
        },
        data: {
          lastCursor: cursor,
        },
      });

      this.logger.info('Cursor position updated', {
        context: 'SyncStateRepository.updateCursorPosition',
        syncStateId: syncState.id,
        userId,
        deviceId,
        cursor,
      });

      return syncState;
    } catch (error) {
      this.handleError(error, 'updateCursorPosition');
    }
  }

  /**
   * Check if a sync lock is valid and not stale
   *
   * @param userId - User ID
   * @param deviceId - Device ID
   * @param lockOwner - Expected lock owner
   * @returns True if lock is valid and held by the specified owner
   */
  async isLockValid(
    userId: string,
    deviceId: string,
    lockOwner: string,
  ): Promise<boolean> {
    try {
      this.logger.debug('Checking lock validity', {
        context: 'SyncStateRepository.isLockValid',
        userId,
        deviceId,
        lockOwner,
      });

      const syncState = await this.prisma.syncState.findUnique({
        where: {
          userId_deviceId: {
            userId,
            deviceId,
          },
        },
        select: {
          syncInProgress: true,
          lockOwner: true,
          lockAcquiredAt: true,
        },
      });

      if (!syncState || !syncState.syncInProgress) {
        return false;
      }

      if (syncState.lockOwner !== lockOwner) {
        return false;
      }

      // Check if lock is stale
      if (syncState.lockAcquiredAt) {
        const lockAge = Date.now() - syncState.lockAcquiredAt.getTime();
        if (lockAge >= this.SYNC_LOCK_TIMEOUT_MS) {
          this.logger.warn('Lock is stale', {
            context: 'SyncStateRepository.isLockValid',
            userId,
            deviceId,
            lockOwner,
            lockAge,
          });
          return false;
        }
      }

      return true;
    } catch (error) {
      this.handleError(error, 'isLockValid');
    }
  }

  /**
   * Get sync states with active locks for a specific user
   *
   * @param userId - User ID
   * @returns Array of sync states with active locks owned by the user
   */
  async getActiveLocks(userId: string): Promise<SyncState[]> {
    try {
      this.logger.debug('Getting active locks for user', {
        context: 'SyncStateRepository.getActiveLocks',
        userId,
      });

      const activeLocks = await this.prisma.syncState.findMany({
        where: {
          userId, // SECURITY: User-scoped
          syncInProgress: true,
        },
        orderBy: {
          lockAcquiredAt: 'asc',
        },
      });

      return activeLocks;
    } catch (error) {
      this.handleError(error, 'getActiveLocks');
    }
  }

  /**
   * Get sync states with active locks across all users (ADMIN ONLY)
   * Use this method for system-wide monitoring and maintenance
   *
   * @returns Array of all sync states with active locks
   */
  async getActiveLocksAdmin(): Promise<SyncState[]> {
    try {
      this.logger.debug('Getting active locks (admin operation)', {
        context: 'SyncStateRepository.getActiveLocksAdmin',
      });

      const activeLocks = await this.prisma.syncState.findMany({
        where: {
          syncInProgress: true,
        },
        orderBy: {
          lockAcquiredAt: 'asc',
        },
      });

      this.logSuccess('getActiveLocksAdmin', {
        count: activeLocks.length,
      });

      return activeLocks;
    } catch (error) {
      this.handleError(error, 'getActiveLocksAdmin');
    }
  }
}