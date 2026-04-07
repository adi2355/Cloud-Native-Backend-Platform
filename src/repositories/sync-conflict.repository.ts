/**
 * Sync Conflict Repository
 *
 * Manages conflict resolution for synchronization in the AppPlatform application.
 * Implements conflict detection and resolution patterns for offline-first sync.
 *
 * Key responsibilities:
 * - Track data conflicts between local and remote versions
 * - Support different conflict resolution strategies
 * - Maintain conflict history for auditing
 * - Handle batch conflict resolution
 *
 * @see https://martinfowler.com/articles/patterns-of-distributed-systems/conflict-resolution.html
 */

import { PrismaClient, SyncConflict, ConflictResolution, Prisma } from '@prisma/client';
import { BaseRepository, PaginatedResponse, PaginationParams } from './base.repository';
import { AppError, ErrorCodes } from '../utils/AppError';
import { LoggerService } from '../services/logger.service';

/**
 * Input for creating a conflict
 * Uses Prisma.InputJsonValue for JSONB fields going into the database
 */
export interface CreateConflictInput {
  userId: string;
  entityType: string;
  entityId: string;
  localVersion: Prisma.InputJsonValue;
  remoteVersion: Prisma.InputJsonValue;
  syncOperationId?: string;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Input for resolving a conflict
 * Uses Prisma.InputJsonValue for JSONB resolved data
 */
export interface ResolveConflictInput {
  conflictId: string;
  resolution: ConflictResolution;
  resolvedBy: string;
  resolvedData?: Prisma.InputJsonValue;
}

/**
 * Input for batch conflict processing
 */
export interface BatchConflictInput {
  userId: string;
  conflicts: Array<{
    entityType: string;
    entityId: string;
    resolution: ConflictResolution;
  }>;
  resolvedBy: string;
}

/**
 * Filter for conflict history
 */
export interface ConflictHistoryFilter {
  userId: string;
  entityType?: string;
  entityId?: string;
  resolution?: ConflictResolution;
  fromDate?: Date;
  toDate?: Date;
}

/**
 * Repository for managing sync conflicts in the AppPlatform system
 * Handles conflict detection, resolution, and history tracking for offline-first sync
 */
export class SyncConflictRepository extends BaseRepository<SyncConflict> {
  constructor(prisma: PrismaClient, entityName: string, logger: LoggerService) {
    super(prisma, entityName, logger);
  }

  /**
   * Create a new conflict record
   *
   * @param input - Conflict creation parameters
   * @returns Created conflict record
   */
  async createConflict(input: CreateConflictInput): Promise<SyncConflict> {
    try {
      this.logger.debug('Creating sync conflict', {
        context: 'SyncConflictRepository.createConflict',
        userId: input.userId,
        entityType: input.entityType,
        entityId: input.entityId,
      });

      // Check for existing unresolved conflict for the same entity
      const existingConflict = await this.prisma.syncConflict.findUnique({
        where: {
          user_entity_unique: {
            userId: input.userId,
            entityType: input.entityType,
            entityId: input.entityId,
          },
        },
      });

      if (existingConflict && !existingConflict.resolution) {
        // Update existing unresolved conflict with new data
        const updatedConflict = await this.prisma.syncConflict.update({
          where: { id: existingConflict.id },
          data: {
            localVersion: input.localVersion,
            remoteVersion: input.remoteVersion,
            syncOperationId: input.syncOperationId,
            metadata: input.metadata,
          },
        });

        this.logger.info('Updated existing conflict', {
          context: 'SyncConflictRepository.createConflict',
          conflictId: updatedConflict.id,
          userId: input.userId,
        });

        return updatedConflict;
      }

      // Delete any resolved conflicts for this entity to prevent duplicates
      if (existingConflict?.resolution) {
        await this.prisma.syncConflict.delete({
          where: { id: existingConflict.id },
        });
      }

      const conflict = await this.prisma.syncConflict.create({
        data: {
          userId: input.userId,
          entityType: input.entityType,
          entityId: input.entityId,
          localVersion: input.localVersion,
          remoteVersion: input.remoteVersion,
          syncOperationId: input.syncOperationId,
          metadata: input.metadata,
        },
      });

      this.logger.info('Sync conflict created', {
        context: 'SyncConflictRepository.createConflict',
        conflictId: conflict.id,
        userId: input.userId,
        entityType: input.entityType,
        entityId: input.entityId,
      });

      return conflict;
    } catch (error) {
      throw this.handleError(error, 'createConflict');
    }
  }

  /**
   * Resolve a conflict
   *
   * @param input - Conflict resolution parameters
   * @returns Resolved conflict record
   */
  async resolveConflict(input: ResolveConflictInput): Promise<SyncConflict> {
    try {
      this.logger.debug('Resolving sync conflict', {
        context: 'SyncConflictRepository.resolveConflict',
        conflictId: input.conflictId,
        resolution: input.resolution,
        resolvedBy: input.resolvedBy,
      });

      const conflict = await this.prisma.syncConflict.update({
        where: { id: input.conflictId },
        data: {
          resolution: input.resolution,
          resolvedAt: new Date(),
          resolvedBy: input.resolvedBy,
          ...(input.resolvedData && {
            metadata: {
              ...(typeof input.resolvedData === 'object' ? input.resolvedData : {}),
              resolvedData: input.resolvedData,
            },
          }),
        },
      });

      this.logger.info('Sync conflict resolved', {
        context: 'SyncConflictRepository.resolveConflict',
        conflictId: conflict.id,
        resolution: input.resolution,
        resolvedBy: input.resolvedBy,
      });

      return conflict;
    } catch (error) {
      throw this.handleError(error, 'resolveConflict');
    }
  }

  /**
   * Get unresolved conflicts for a user
   *
   * @param userId - User ID
   * @param entityType - Optional entity type filter
   * @param params - Pagination parameters
   * @returns Paginated list of unresolved conflicts
   */
  async getUnresolvedConflicts(
    userId: string,
    entityType?: string,
    params?: PaginationParams
  ): Promise<PaginatedResponse<SyncConflict>> {
    try {
      this.logger.debug('Fetching unresolved conflicts', {
        context: 'SyncConflictRepository.getUnresolvedConflicts',
        userId,
        entityType,
      });

      const where: Prisma.SyncConflictWhereInput = {
        userId,
        resolution: null,
        ...(entityType && { entityType }),
      };

      // Type-safe Prisma query functions for pagination
      return await this.findManyWithPagination<
        Prisma.SyncConflictFindManyArgs,
        Prisma.SyncConflictCountArgs
      >(
        (args: Prisma.SyncConflictFindManyArgs) => this.prisma.syncConflict.findMany(args),
        (args: Prisma.SyncConflictCountArgs) => this.prisma.syncConflict.count(args),
        {
          ...params,
          where,
          orderBy: params?.orderBy || { createdAt: 'desc' },
        }
      );
    } catch (error) {
      throw this.handleError(error, 'getUnresolvedConflicts');
    }
  }

  /**
   * Get count of pending (unresolved) conflicts for a user
   *
   * @param userId - User ID
   * @param deviceId - Optional device ID filter
   * @returns Number of pending conflicts
   */
  async getPendingConflictsCount(userId: string, deviceId?: string): Promise<number> {
    try {
      this.logger.debug('Getting pending conflicts count', {
        context: 'SyncConflictRepository.getPendingConflictsCount',
        userId,
        deviceId,
      });

      const count = await this.prisma.syncConflict.count({
        where: {
          userId,
          resolution: null, // Unresolved conflicts
        },
      });

      return count;
    } catch (error) {
      throw this.handleError(error, 'getPendingConflictsCount');
    }
  }

  /**
   * Get conflict by ID (user-scoped for security)
   *
   * @param id - Conflict ID
   * @param userId - User ID for ownership verification
   * @returns Conflict record or null
   */
  async findById(
    id: string,
    userId: string
  ): Promise<SyncConflict | null> {
    try {
      this.logger.debug('Fetching conflict by ID', {
        context: 'SyncConflictRepository.findById',
        id,
        userId,
      });

      const conflict = await this.prisma.syncConflict.findFirst({
        where: {
          id,
          userId,
        },
      });

      return conflict;
    } catch (error) {
      throw this.handleError(error, 'findById');
    }
  }

  /**
   * Get conflict by entity
   *
   * @param userId - User ID
   * @param entityType - Entity type
   * @param entityId - Entity ID
   * @returns Conflict record or null
   */
  async getConflictByEntity(
    userId: string,
    entityType: string,
    entityId: string
  ): Promise<SyncConflict | null> {
    try {
      this.logger.debug('Fetching conflict by entity', {
        context: 'SyncConflictRepository.getConflictByEntity',
        userId,
        entityType,
        entityId,
      });

      const conflict = await this.prisma.syncConflict.findUnique({
        where: {
          user_entity_unique: {
            userId,
            entityType,
            entityId,
          },
        },
      });

      return conflict;
    } catch (error) {
      throw this.handleError(error, 'getConflictByEntity');
    }
  }

  /**
   * Batch resolve conflicts
   *
   * @param input - Batch resolution parameters
   * @returns Number of resolved conflicts
   */
  async batchResolveConflicts(input: BatchConflictInput): Promise<number> {
    try {
      this.logger.debug('Batch resolving conflicts', {
        context: 'SyncConflictRepository.batchResolveConflicts',
        userId: input.userId,
        conflictCount: input.conflicts.length,
        resolvedBy: input.resolvedBy,
      });

      let resolvedCount = 0;

      // Process conflicts in transaction with proper Prisma.TransactionClient typing
      await this.prisma.$transaction(async (tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>) => {
        for (const conflictInput of input.conflicts) {
          try {
            const conflict = await tx.syncConflict.findUnique({
              where: {
                user_entity_unique: {
                  userId: input.userId,
                  entityType: conflictInput.entityType,
                  entityId: conflictInput.entityId,
                },
              },
            });

            if (conflict && !conflict.resolution) {
              await tx.syncConflict.update({
                where: { id: conflict.id },
                data: {
                  resolution: conflictInput.resolution,
                  resolvedAt: new Date(),
                  resolvedBy: input.resolvedBy,
                },
              });
              resolvedCount++;
            }
          } catch (error) {
            this.logger.warn('Failed to resolve conflict in batch', {
              context: 'SyncConflictRepository.batchResolveConflicts',
              entityType: conflictInput.entityType,
              entityId: conflictInput.entityId,
              error: error instanceof Error ? error.message : 'Unknown error',
            });
          }
        }
      });

      this.logger.info('Batch conflict resolution completed', {
        context: 'SyncConflictRepository.batchResolveConflicts',
        userId: input.userId,
        resolvedCount,
        totalRequested: input.conflicts.length,
      });

      return resolvedCount;
    } catch (error) {
      throw this.handleError(error, 'batchResolveConflicts');
    }
  }

  /**
   * Get conflict history
   *
   * @param filter - History filter parameters
   * @param params - Pagination parameters
   * @returns Paginated conflict history
   */
  async getConflictHistory(
    filter: ConflictHistoryFilter,
    params?: PaginationParams
  ): Promise<PaginatedResponse<SyncConflict>> {
    try {
      this.logger.debug('Fetching conflict history', {
        context: 'SyncConflictRepository.getConflictHistory',
        filter,
      });

      const where: Prisma.SyncConflictWhereInput = {
        userId: filter.userId,
        ...(filter.entityType && { entityType: filter.entityType }),
        ...(filter.entityId && { entityId: filter.entityId }),
        ...(filter.resolution && { resolution: filter.resolution }),
        ...(filter.fromDate || filter.toDate) && {
          createdAt: {
            ...(filter.fromDate && { gte: filter.fromDate }),
            ...(filter.toDate && { lte: filter.toDate }),
          },
        },
      };

      // Type-safe Prisma query functions for conflict history pagination
      return await this.findManyWithPagination<
        Prisma.SyncConflictFindManyArgs,
        Prisma.SyncConflictCountArgs
      >(
        (args: Prisma.SyncConflictFindManyArgs) => this.prisma.syncConflict.findMany(args),
        (args: Prisma.SyncConflictCountArgs) => this.prisma.syncConflict.count(args),
        {
          ...params,
          where,
          orderBy: params?.orderBy || { createdAt: 'desc' },
        }
      );
    } catch (error) {
      throw this.handleError(error, 'getConflictHistory');
    }
  }

  /**
   * Get conflict statistics for a user
   *
   * @param userId - User ID
   * @param days - Number of days to include (default: 30)
   * @returns Conflict statistics
   */
  async getConflictStatistics(userId: string, days: number = 30): Promise<{
    total: number;
    unresolved: number;
    resolved: number;
    byResolution: Record<string, number>;
    byEntity: Record<string, number>;
    averageResolutionTime: number;
  }> {
    try {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      const baseWhere = {
        userId,
        createdAt: { gte: startDate },
      };

      const [total, unresolved, resolved, byResolution, byEntity, resolvedConflicts] = await Promise.all([
        // Total conflicts
        this.prisma.syncConflict.count({ where: baseWhere }),

        // Unresolved conflicts
        this.prisma.syncConflict.count({
          where: { ...baseWhere, resolution: null },
        }),

        // Resolved conflicts
        this.prisma.syncConflict.count({
          where: { ...baseWhere, resolution: { not: null } },
        }),

        // Group by resolution type
        this.prisma.syncConflict.groupBy({
          by: ['resolution'],
          where: { ...baseWhere, resolution: { not: null } },
          _count: true,
        }),

        // Group by entity type
        this.prisma.syncConflict.groupBy({
          by: ['entityType'],
          where: baseWhere,
          _count: true,
        }),

        // Get resolved conflicts for timing analysis
        this.prisma.syncConflict.findMany({
          where: {
            ...baseWhere,
            resolution: { not: null },
            resolvedAt: { not: null },
          },
          select: {
            createdAt: true,
            resolvedAt: true,
          },
        }),
      ]);

      // Calculate average resolution time
      const averageResolutionTime = resolvedConflicts.length > 0
        ? resolvedConflicts.reduce((sum, conflict) => {
            const resolutionTime = conflict.resolvedAt!.getTime() - conflict.createdAt.getTime();
            return sum + resolutionTime;
          }, 0) / resolvedConflicts.length
        : 0;

      return {
        total,
        unresolved,
        resolved,
        byResolution: byResolution.reduce((acc, item) => {
          if (item.resolution) {
            acc[item.resolution] = item._count;
          }
          return acc;
        }, {} as Record<string, number>),
        byEntity: byEntity.reduce((acc, item) => {
          acc[item.entityType] = item._count;
          return acc;
        }, {} as Record<string, number>),
        averageResolutionTime: Math.round(averageResolutionTime / 1000), // Convert to seconds
      };
    } catch (error) {
      throw this.handleError(error, 'getConflictStatistics');
    }
  }

  /**
   * Clean up old resolved conflicts
   *
   * @param userId - User ID
   * @param olderThan - Delete conflicts resolved before this date
   * @returns Number of deleted conflicts
   */
  async cleanupResolvedConflicts(userId: string, olderThan: Date): Promise<number> {
    try {
      this.logger.debug('Cleaning up resolved conflicts', {
        context: 'SyncConflictRepository.cleanupResolvedConflicts',
        userId,
        olderThan: olderThan.toISOString(),
      });

      const result = await this.prisma.syncConflict.deleteMany({
        where: {
          userId,
          resolution: { not: null },
          resolvedAt: {
            lt: olderThan,
          },
        },
      });

      this.logger.info('Resolved conflicts cleaned up', {
        context: 'SyncConflictRepository.cleanupResolvedConflicts',
        userId,
        deletedCount: result.count,
      });

      return result.count;
    } catch (error) {
      throw this.handleError(error, 'cleanupResolvedConflicts');
    }
  }
}