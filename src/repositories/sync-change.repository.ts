/**
 * Sync Change Repository
 *
 * Manages change tracking for synchronization in the AppPlatform application.
 * Implements change data capture (CDC) pattern for offline-first sync.
 *
 * Key responsibilities:
 * - Track all data changes per user and device
 * - Support batch processing of changes for performance
 * - Maintain change history with version control
 * - Handle change application and rejection tracking
 *
 * @see https://martinfowler.com/articles/patterns-of-distributed-systems/change-data-capture.html
 */

import { PrismaClient, SyncChange, ChangeType, Prisma } from '@prisma/client';
import { BaseRepository, PaginatedResponse, PaginationParams } from './base.repository';
import { AppError, ErrorCodes } from '../utils/AppError';
import { LoggerService } from '../services/logger.service';
/**
 * Input for tracking a change
 */
export interface TrackChangeInput {
  userId: string;
  deviceId: string;
  changeType: ChangeType;
  entityType: string;
  entityId: string;
  changeData: Prisma.InputJsonValue;
  syncVersion?: number;
}

/**
 * Input for marking change as applied
 */
export interface MarkAppliedInput {
  changeId: string;
  appliedAt?: Date;
}

/**
 * Input for rejecting a change
 */
export interface RejectChangeInput {
  changeId: string;
  reason: string;
}

/**
 * Filter options for pending changes
 */
export interface PendingChangesFilter {
  userId: string;
  deviceId?: string;
  entityType?: string;
  fromVersion?: number;
  includeRejected?: boolean;
}

/**
 * Batch change processing result
 */
export interface BatchProcessResult {
  processed: number;
  applied: number;
  rejected: number;
  errors: Array<{ changeId: string; error: string }>;
}

/**
 * Repository for managing sync changes in the AppPlatform system
 */
export class SyncChangeRepository extends BaseRepository<SyncChange> {
  constructor(prisma: PrismaClient, entityName: string, logger: LoggerService) {
    super(prisma, entityName, logger);
  }

  /**
   * Track a new change for synchronization
   *
   * @param input - Change tracking parameters
   * @returns Created change record
   */
  async trackChange(input: TrackChangeInput): Promise<SyncChange> {
    try {
      this.logger.debug('Tracking sync change', {
        context: 'SyncChangeRepository.trackChange',
        userId: input.userId,
        deviceId: input.deviceId,
        changeType: input.changeType,
        entityType: input.entityType,
        entityId: input.entityId,
      });

      // Check for duplicate change (idempotency)
      const existingChange = await this.prisma.syncChange.findUnique({
        where: {
          userId_deviceId_entityType_entityId_syncVersion: {
            userId: input.userId,
            deviceId: input.deviceId,
            entityType: input.entityType,
            entityId: input.entityId,
            syncVersion: input.syncVersion || 1,
          },
        },
      });

      if (existingChange) {
        this.logger.warn('Duplicate change detected, returning existing', {
          context: 'SyncChangeRepository.trackChange',
          changeId: existingChange.id,
        });
        return existingChange;
      }

      const change = await this.prisma.syncChange.create({
        data: {
          userId: input.userId,
          deviceId: input.deviceId,
          changeType: input.changeType,
          entityType: input.entityType,
          entityId: input.entityId,
          changeData: input.changeData,
          syncVersion: input.syncVersion || 1,
        },
      });

      this.logger.info('Sync change tracked', {
        context: 'SyncChangeRepository.trackChange',
        changeId: change.id,
        userId: input.userId,
        deviceId: input.deviceId,
        changeType: input.changeType,
      });

      return change;
    } catch (error) {
      throw this.handleError(error, 'trackChange');
    }
  }


  /**
   * Get unapplied changes for synchronization
   *
   * @param userId - User ID
   * @param deviceId - Optional device ID filter
   * @param params - Pagination parameters
   * @returns Paginated list of unapplied changes
   */
  async getUnappliedChanges(
    userId: string,
    deviceId?: string,
    params?: PaginationParams,
  ): Promise<PaginatedResponse<SyncChange>> {
    try {
      this.logger.debug('Fetching unapplied changes', {
        context: 'SyncChangeRepository.getUnappliedChanges',
        userId,
        deviceId,
      });

      const where: Prisma.SyncChangeWhereInput = {
        userId,
        ...(deviceId && { deviceId }),
        applied: false,
        rejected: false,
      };

      return await this.findManyWithPagination(
        (args: Prisma.SyncChangeFindManyArgs) => this.prisma.syncChange.findMany(args),
        (args: { where?: Prisma.SyncChangeWhereInput }) => this.prisma.syncChange.count(args),
        {
          ...params,
          where,
          orderBy: params?.orderBy || { createdAt: 'asc' }, // Process oldest first
        },
      );
    } catch (error) {
      throw this.handleError(error, 'getUnappliedChanges');
    }
  }

  /**
   * Mark a change as applied
   *
   * @param input - Mark applied parameters
   * @returns Updated change record
   */
  async markChangeApplied(input: MarkAppliedInput): Promise<SyncChange> {
    try {
      this.logger.debug('Marking change as applied', {
        context: 'SyncChangeRepository.markChangeApplied',
        changeId: input.changeId,
      });

      const change = await this.prisma.syncChange.update({
        where: { id: input.changeId },
        data: {
          applied: true,
          appliedAt: input.appliedAt || new Date(),
        },
      });

      this.logger.info('Change marked as applied', {
        context: 'SyncChangeRepository.markChangeApplied',
        changeId: change.id,
        userId: change.userId,
      });

      return change;
    } catch (error) {
      throw this.handleError(error, 'markChangeApplied');
    }
  }

  /**
   * Reject a change with reason
   *
   * @param input - Rejection parameters
   * @returns Updated change record
   */
  async rejectChange(input: RejectChangeInput): Promise<SyncChange> {
    try {
      this.logger.debug('Rejecting change', {
        context: 'SyncChangeRepository.rejectChange',
        changeId: input.changeId,
        reason: input.reason,
      });

      const change = await this.prisma.syncChange.update({
        where: { id: input.changeId },
        data: {
          rejected: true,
          rejectionReason: input.reason,
        },
      });

      this.logger.warn('Change rejected', {
        context: 'SyncChangeRepository.rejectChange',
        changeId: change.id,
        userId: change.userId,
        reason: input.reason,
      });

      return change;
    } catch (error) {
      throw this.handleError(error, 'rejectChange');
    }
  }

  /**
   * Get pending changes for a user/device
   *
   * @param filter - Filter parameters
   * @param params - Pagination parameters
   * @returns Paginated list of pending changes
   */
  async getPendingChanges(
    filter: PendingChangesFilter,
    params?: PaginationParams,
  ): Promise<PaginatedResponse<SyncChange>> {
    try {
      this.logger.debug('Fetching pending changes', {
        context: 'SyncChangeRepository.getPendingChanges',
        filter,
      });

      const where: Prisma.SyncChangeWhereInput = {
        userId: filter.userId,
        ...(filter.deviceId && { deviceId: filter.deviceId }),
        ...(filter.entityType && { entityType: filter.entityType }),
        ...(filter.fromVersion && { syncVersion: { gte: filter.fromVersion } }),
        applied: false,
        ...(filter.includeRejected === false && { rejected: false }),
      };

      return await this.findManyWithPagination(
        (args: Prisma.SyncChangeFindManyArgs) => this.prisma.syncChange.findMany(args),
        (args: { where?: Prisma.SyncChangeWhereInput }) => this.prisma.syncChange.count(args),
        {
          ...params,
          where,
          orderBy: params?.orderBy || { syncVersion: 'asc' },
        },
      );
    } catch (error) {
      throw this.handleError(error, 'getPendingChanges');
    }
  }

  /**
   * Get change statistics for a user
   *
   * @param userId - User ID
   * @param deviceId - Optional device ID filter
   * @returns Change statistics
   */
  async getChangeStatistics(userId: string, deviceId?: string): Promise<{
    total: number;
    pending: number;
    applied: number;
    rejected: number;
    byType: Record<string, number>;
    byEntity: Record<string, number>;
  }> {
    try {
      const baseWhere = {
        userId,
        ...(deviceId && { deviceId }),
      };

      const [total, pending, applied, rejected, byType, byEntity] = await Promise.all([
        // Total changes
        this.prisma.syncChange.count({ where: baseWhere }),

        // Pending changes
        this.prisma.syncChange.count({
          where: { ...baseWhere, applied: false, rejected: false },
        }),

        // Applied changes
        this.prisma.syncChange.count({
          where: { ...baseWhere, applied: true },
        }),

        // Rejected changes
        this.prisma.syncChange.count({
          where: { ...baseWhere, rejected: true },
        }),

        // Group by change type
        this.prisma.syncChange.groupBy({
          by: ['changeType'],
          where: baseWhere,
          _count: true,
        }),

        // Group by entity type
        this.prisma.syncChange.groupBy({
          by: ['entityType'],
          where: baseWhere,
          _count: true,
        }),
      ]);

      return {
        total,
        pending,
        applied,
        rejected,
        byType: byType.reduce((acc, item) => {
          acc[item.changeType] = item._count;
          return acc;
        }, {} as Record<string, number>),
        byEntity: byEntity.reduce((acc, item) => {
          acc[item.entityType] = item._count;
          return acc;
        }, {} as Record<string, number>),
      };
    } catch (error) {
      throw this.handleError(error, 'getChangeStatistics');
    }
  }

  /**
   * Get changes since a specific timestamp using composite cursor (createdAt, id)
   * Used by SyncService for delta synchronization
   *
   * Composite Cursor Pagination:
   * - Uses (createdAt, id) composite ordering for deterministic pagination
   * - Prevents duplicate/missing rows when multiple changes have same timestamp
   * - WHERE clause: (createdAt > lastCreatedAt) OR (createdAt = lastCreatedAt AND id > lastId)
   *
   * DESIGN: Only returns changes for the requesting user's own data.
   * Public catalog products are snapshot-only and do NOT produce SyncChanges,
   * so no CATALOG_USER_ID branch is needed here.
   *
   * @param userId - User ID
   * @param since - Changes since this date
   * @param deviceId - Optional device ID filter
   * @param entities - Optional entity types filter
   * @param limit - Maximum number of changes to return
   * @param lastId - Optional last change ID from previous page (for composite cursor)
   * @returns Array of changes
   */
  async getChangesSince(
    userId: string,
    since: Date,
    deviceId?: string,
    entities?: string[],
    limit: number = 1000,
    lastId?: string,
  ): Promise<SyncChange[]> {
    try {
      this.logger.debug('Getting changes since timestamp with composite cursor', {
        context: 'SyncChangeRepository.getChangesSince',
        userId,
        deviceId,
        since: since.toISOString(),
        lastId,
        entities,
        limit,
      });

      // Build the timestamp/cursor condition
      const cursorCondition: Prisma.SyncChangeWhereInput = lastId
        ? {
            OR: [
              // Case 1: createdAt > lastCreatedAt
              { createdAt: { gt: since } },
              // Case 2: createdAt = lastCreatedAt AND id > lastId
              { AND: [{ createdAt: since }, { id: { gt: lastId } }] },
            ],
          }
        : {
            // Simple case: no lastId, just createdAt >= since
            createdAt: { gte: since },
          };

      // Ownership: Only return changes belonging to the requesting user.
      // Public catalog products are snapshot-only (no SyncChange rows emitted),
      // so no CATALOG_USER_ID branch is needed.
      const ownershipCondition: Prisma.SyncChangeWhereInput = {
        userId: userId,
      };

      // BACKEND FIX #1: Composite cursor WHERE clause
      // Prevents duplicate/missing rows at page boundaries with identical timestamps
      // across all devices for proper cross-device synchronization
      const where: Prisma.SyncChangeWhereInput = {
        AND: [
          ownershipCondition,
          cursorCondition,
          { rejected: false },
          ...(entities && entities.length > 0 ? [{ entityType: { in: entities } }] : []),
        ],
      };

      const changes = await this.prisma.syncChange.findMany({
        where,
        // BACKEND FIX #1: Composite ordering (createdAt ASC, id ASC)
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit,
      });

      this.logger.info('Changes retrieved with composite cursor', {
        context: 'SyncChangeRepository.getChangesSince',
        userId,
        changeCount: changes.length,
        cursorUsed: !!lastId,
      });

      return changes;
    } catch (error) {
      throw this.handleError(error, 'getChangesSince');
    }
  }

  /**
   * Batch process changes for SyncService
   * Simplified version for SyncService compatibility
   *
   * @param userId - User ID
   * @param changes - Array of changes to process
   * @param deviceId - Device ID
   * @returns Processing result
   */
  async batchProcessChanges(
    userId: string,
    changes: Array<{
      changeType?: ChangeType;
      entityType: string;
      entityId: string;
      changeData?: Prisma.InputJsonValue;
      syncVersion?: number;
      id?: string;
    }>,
    deviceId: string,
  ): Promise<{
    applied: number;
    rejected: number;
    failed: number;
    conflicts: Array<{ id?: string; error: string }>;
  }> {
    try {
      this.logger.debug('Batch processing changes for sync service', {
        context: 'SyncChangeRepository.batchProcessChanges',
        userId,
        deviceId,
        changeCount: changes.length,
      });

      let applied = 0;
      const rejected = 0;
      let failed = 0;
      const conflicts: Array<{ id?: string; error: string }> = [];

      // Process changes sequentially for simplicity
      for (const change of changes) {
        try {
          // Track the change first
          const trackedChange = await this.trackChange({
            userId,
            deviceId,
            changeType: change.changeType || 'UPDATE',
            entityType: change.entityType,
            entityId: change.entityId,
            changeData: change.changeData || change,
            syncVersion: change.syncVersion || 1,
          });

          // Mark as applied immediately (simplified processing)
          await this.markChangeApplied({ changeId: trackedChange.id });
          applied++;
        } catch (error) {
          this.logger.warn('Failed to process change', {
            context: 'SyncChangeRepository.batchProcessChanges',
            changeId: change.id || 'unknown',
            error: error instanceof Error ? error.message : 'Unknown error',
          });
          failed++;
        }
      }

      const result = { applied, rejected, failed, conflicts };

      this.logger.info('Batch processing completed', {
        context: 'SyncChangeRepository.batchProcessChanges',
        userId,
        result,
      });

      return result;
    } catch (error) {
      throw this.handleError(error, 'batchProcessChanges');
    }
  }

  /**
   * Get pending changes count for a user and device
   * Used by SyncService for quick status checks
   *
   * @param userId - User ID
   * @param deviceId - Device ID
   * @returns Number of pending changes
   */
  async getPendingChangesCount(userId: string, deviceId?: string): Promise<number> {
    try {
      this.logger.debug('Getting pending changes count', {
        context: 'SyncChangeRepository.getPendingChangesCount',
        userId,
        deviceId,
      });

      const count = await this.prisma.syncChange.count({
        where: {
          userId,
          ...(deviceId && { deviceId }), // Only filter by deviceId if provided
          applied: false,
          rejected: false,
        },
      });

      this.logger.debug('Pending changes count retrieved', {
        context: 'SyncChangeRepository.getPendingChangesCount',
        userId,
        deviceId,
        count,
      });

      return count;
    } catch (error) {
      throw this.handleError(error, 'getPendingChangesCount');
    }
  }

  /**
   * Get the latest version number for a specific entity
   *
   * @param userId - User ID
   * @param entityType - Type of entity (consumptions, sessions, etc.)
   * @param entityId - Entity ID
   * @returns Latest version number or null if not found
   */
  async getLatestVersion(
    userId: string,
    entityType: string,
    entityId: string,
  ): Promise<number | null> {
    try {
      this.logger.debug('Getting latest version for entity', {
        context: 'SyncChangeRepository.getLatestVersion',
        userId,
        entityType,
        entityId,
      });

      const latestChange = await this.prisma.syncChange.findFirst({
        where: {
          userId,
          entityType,
          entityId,
        },
        orderBy: {
          syncVersion: 'desc',
        },
        select: {
          syncVersion: true,
        },
      });

      return latestChange?.syncVersion ?? null;
    } catch (error) {
      throw this.handleError(error, 'getLatestVersion');
    }
  }

  /**
   * Clean up old applied changes
   *
   * @param userId - User ID
   * @param olderThan - Delete changes applied before this date
   * @returns Number of deleted changes
   */
  async cleanupAppliedChanges(userId: string, olderThan: Date): Promise<number> {
    try {
      this.logger.debug('Cleaning up applied changes', {
        context: 'SyncChangeRepository.cleanupAppliedChanges',
        userId,
        olderThan: olderThan.toISOString(),
      });

      const result = await this.prisma.syncChange.deleteMany({
        where: {
          userId,
          applied: true,
          appliedAt: {
            lt: olderThan,
          },
        },
      });

      this.logger.info('Applied changes cleaned up', {
        context: 'SyncChangeRepository.cleanupAppliedChanges',
        userId,
        deletedCount: result.count,
      });

      return result.count;
    } catch (error) {
      throw this.handleError(error, 'cleanupAppliedChanges');
    }
  }
}