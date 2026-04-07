/**
 * Sync Controller - Enhanced Cursor-Based Synchronization
 * Handles cursor-based incremental sync, batch push/pull operations, and conflict resolution
 *
 * API Endpoints:
 * - GET /api/v1/sync/changes?cursor=X&entityTypes[]=consumptions - Cursor-based incremental pull
 * - POST /api/v1/sync/push - Batch upload with idempotency
 * - POST /api/v1/sync/conflicts/resolve - Batch conflict resolution
 * - GET /api/v1/sync/status - Get cursor positions per entity
 * - GET /api/v1/sync/conflicts - Get pending conflicts
 * - POST /api/v1/sync/full - Manual full sync trigger
 */

import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../../types/authenticated-request.types';
import { getUserId, getRouteParam, getRequestId, getDeviceId } from '../../../utils/auth-guards';
import { SyncService } from '../../../services/sync.service';
import { LoggerService } from '../../../services/logger.service';
import { AppError } from '../../../utils/AppError';
import { SocketService } from '../../../websocket/socket.service';
import { SyncOperationRepository } from '../../../repositories/sync-operation.repository';
import { SyncConflictRepository } from '../../../repositories/sync-conflict.repository';
import { SyncType, SyncStatus } from '@prisma/client';
import { getErrorMessage, getErrorStack } from '../../../utils/error-handler';
import { SyncLeaseService } from '../../../services/syncLease.service';
import {
  computeSyncChangesEtag,
  parseProductSyncFields,
  type ProductSyncField,
  DEFAULT_PRODUCT_SYNC_FIELDS,
  type SyncLeaseRequest,
} from '@shared/contracts';
// Note: Validation schemas are defined in ../schemas/sync.schemas.ts
// Validation is handled at the route level via validate() middleware

export class SyncController {
  /**
   * Constructor with explicit dependency injection (Pure DI - no singleton)
   * All dependencies are required and injected by bootstrap.ts
   */
  public constructor(
    private syncService: SyncService,
    private socketService: SocketService,
    private logger: LoggerService,
    private syncOperationRepository: SyncOperationRepository,
    private syncConflictRepository: SyncConflictRepository,
    private syncLeaseService: SyncLeaseService,
  ) {
    // Pure constructor injection - all dependencies provided by bootstrap.ts
    if (!syncService || !socketService || !logger || !syncOperationRepository || !syncConflictRepository || !syncLeaseService) {
      throw new Error('SyncController: All dependencies (SyncService, SocketService, LoggerService, SyncOperationRepository, SyncConflictRepository, SyncLeaseService) must be provided');
    }
  }

  /**
   * Request a sync lease for bulk operations.
   * POST /api/v1/sync/lease
   */
  public async requestLease(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const request = req.body as SyncLeaseRequest;

      this.logger.info('Sync lease requested', {
        context: 'SyncController.requestLease',
        userId,
        kind: request.kind,
        requestedBatchSize: request.requestedBatchSize,
        requestedMaxRequests: request.requestedMaxRequests,
      });

      const decision = await this.syncLeaseService.requestLease({
        userId,
        kind: request.kind,
        requestedBatchSize: request.requestedBatchSize,
        requestedMaxRequests: request.requestedMaxRequests,
      });

      res.json({
        success: true,
        data: decision,
        metadata: {
          requestId: getRequestId(req),
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      this.logger.error('Sync lease request failed', {
        context: 'SyncController.requestLease',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  /**
   * Get incremental changes using cursor-based sync (NEW - Cursor-based approach)
   * GET /api/v1/sync/changes?cursor=X&entityTypes[]=consumptions&limit=100
   *
   * Note: Request validation handled by validate(syncChangesSchema) middleware at route level
   */
  public async getChanges(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const deviceId = getDeviceId(req);

      // Ensure deviceId is provided for incremental sync (required for lock management)
      if (!deviceId) {
        throw AppError.validation('deviceId is required for incremental sync operations');
      }

      // Extract validated parameters (validation already done by middleware)
      const cursor = req.query.cursor as string | undefined;
      const entityTypesParam = req.query.entityTypes as string | string[] | undefined;
      const entityTypes = Array.isArray(entityTypesParam)
        ? entityTypesParam
        : entityTypesParam
        ? entityTypesParam.split(',')
        : [];
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;
      // Extract productFields from query, ensuring we only accept string values
      // (Express ParsedQs can contain nested objects, so we must validate the type)
      const productFieldsParam = typeof req.query.productFields === 'string'
        ? req.query.productFields
        : Array.isArray(req.query.productFields) && typeof req.query.productFields[0] === 'string'
        ? req.query.productFields[0]
        : undefined;

      let productFields: ProductSyncField[] = [];
      if (productFieldsParam) {
        if (productFieldsParam === 'default') {
          productFields = [...DEFAULT_PRODUCT_SYNC_FIELDS];
        } else {
          productFields = parseProductSyncFields(productFieldsParam);
        }

        if (productFields.length === 0) {
          throw AppError.validation('productFields did not include any valid product fields');
        }

        const requiredFields: ProductSyncField[] = ['userId', 'name'];
        const missing = requiredFields.filter((field) => !productFields.includes(field));
        if (missing.length > 0) {
          throw AppError.validation('productFields missing required fields', { missing });
        }
      }

      this.logger.info('Fetching cursor-based incremental changes', {
        context: 'SyncController',
        userId,
        deviceId,
        cursor,
        entityTypes,
        limit,
        productFields: productFieldsParam,
      });

      const result = await this.syncService.getIncrementalChanges(
        userId,
        deviceId,
        entityTypes,
        cursor,
        limit,
      );

      const shapedChanges = productFields.length > 0
        ? result.changes.map((change) => {
            if (change.entityType !== 'products' || !change.data) {
              return change;
            }
            const shapedData: Record<string, unknown> = {};
            for (const field of productFields) {
              if (field in change.data) {
                shapedData[field] = change.data[field];
              }
            }
            return { ...change, data: shapedData };
          })
        : result.changes;

      const etag = computeSyncChangesEtag({
        cursor: result.cursor ?? cursor ?? null,
        entityTypes,
        limit,
        productFields: productFields.length > 0 ? productFields : undefined,
      });

      const ifNoneMatchHeader = req.headers['if-none-match'];
      const ifNoneMatch = Array.isArray(ifNoneMatchHeader)
        ? ifNoneMatchHeader[0]
        : ifNoneMatchHeader;

      res.setHeader('ETag', etag);
      res.setHeader('Vary', 'If-None-Match');

      if (ifNoneMatch && ifNoneMatch === etag && shapedChanges.length === 0) {
        res.status(304).end();
        return;
      }

      res.json({
        success: true,
        data: {
          ...result,
          changes: shapedChanges,
        },
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: getRequestId(req),
        },
      });
    } catch (error) {
      this.logger.error('Failed to get incremental changes', {
        context: 'SyncController',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }


  /**
   * Push local changes to server (ENHANCED - with WebSocket notifications)
   * POST /api/v1/sync/push
   *
   * Note: Request validation handled by validate(pushSyncCursorSchema) middleware at route level
   */
  public async push(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = getUserId(req);

      // Extract validated parameters (validation already done by middleware)
      const { deviceId, changes, syncOperationId, lastSyncCursor } = req.body;

      this.logger.info('Processing push sync', {
        context: 'SyncController',
        userId,
        deviceId,
        changeCount: changes.length,
        syncOperationId,
      });

      // Transform API contract (data → changeData) to match internal service interface
      // Frontend sends "data" per pushSyncCursorSchema validation
      // Backend service expects "changeData" per PendingChangeItem interface
      const transformedChanges = changes.map((change: {
        entityType: string;
        entityId: string;
        changeType: string;
        clientId?: string;
        requestId: string; // REQUIRED: precise per-command outbox tracking (validated by schema)
        data: Record<string, unknown>;
        version: number;
        timestamp: string;
      }) => ({
        entityType: change.entityType,
        entityId: change.entityId,
        changeType: change.changeType,
        clientId: change.clientId,
        requestId: change.requestId,
        changeData: change.data,
        syncVersion: change.version,
        timestamp: new Date(change.timestamp),
      }));

      // Process changes via SyncService (which uses repositories, not direct DB access)
      const result = await this.syncService.processPushSync(
        userId,
        deviceId,
        transformedChanges,
        syncOperationId,
      );

      // Get server changes since last cursor (if provided)
      let serverChanges = null;
      if (lastSyncCursor) {
        serverChanges = await this.syncService.getChangesSinceCursor(
          userId,
          deviceId,
          lastSyncCursor,
        );
      }

      res.json({
        success: true,
        data: {
          ...result,
          serverChanges,
        },
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: getRequestId(req),
        },
      });

      // Emit real-time sync completion event via WebSocket
      this.socketService.emitToUser(userId, 'sync:push:completed', {
        syncOperationId,
        successful: result.successful.length,
        failed: result.failed.length,
        conflicts: result.conflicts.length,
      });
    } catch (error) {
      this.logger.error('Sync push failed', {
        context: 'SyncController',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  /**
   * Pull server changes
   * GET /api/v1/sync/pull
   */
  public async pull(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = getUserId(req);
      const { lastSyncTimestamp, deviceId, entities, limit = 1000 } = req.query;

      this.logger.info(`Sync pull for user: ${userId}, device: ${deviceId}`, { context: 'SyncController' });

      // Get changes since last sync
      const changes = await this.syncService.getChangesSince(
        userId,
        lastSyncTimestamp as string || new Date(0).toISOString(),
        deviceId as string,
        entities ? (entities as string).split(',') : undefined,
        Number(limit),
      );

      // Record sync operation using repository (replaces direct DB access)
      await this.syncOperationRepository.create({
        userId,
        deviceId: deviceId as string | undefined,
        operationType: SyncType.PULL,
        status: SyncStatus.COMPLETED,
        lastSyncAt: new Date(),
        // Note: Raw SQL was using 'changes_count' which doesn't exist in Prisma schema
        // Schema only has conflictCount/resolvedCount - omitting for now
      });

      res.json({
        success: true,
        timestamp: new Date().toISOString(),
        changes,
        hasMore: changes.length >= Number(limit),
      });
    } catch (error) {
      this.logger.error('Sync pull failed:', { context: 'SyncController', error: getErrorMessage(error), stack: getErrorStack(error) });
      next(error);
    }
  }

  /**
   * Full sync - bidirectional sync
   * POST /api/v1/sync/full
   */
  public async fullSync(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = getUserId(req);
      const { lastSyncTimestamp, changes, deviceId, checksum } = req.body;

      this.logger.info(`Full sync for user: ${userId}, device: ${deviceId}`, { context: 'SyncController' });

      // Process incoming changes
      const pushResults = await this.syncService.processChanges(userId, changes || [], deviceId);

      // Get all server changes
      const serverChanges = await this.syncService.getChangesSince(
        userId,
        lastSyncTimestamp || new Date(0).toISOString(),
        deviceId,
      );

      // Verify data integrity if checksum provided
      let integrityCheck = null;
      if (checksum) {
        integrityCheck = await this.syncService.verifyIntegrity(userId, checksum);
      }

      // Record sync operation using repository (replaces direct DB access)
      // Note: dataHash field can store checksum information instead of non-existent metadata field
      // Repository auto-generates UUID, capture it for response
      const syncOperation = await this.syncOperationRepository.create({
        userId,
        deviceId,
        operationType: SyncType.FULL,
        status: SyncStatus.COMPLETED,
        lastSyncAt: new Date(),
        dataHash: checksum || undefined,
        // Note: Raw SQL was using 'metadata' field which doesn't exist in schema
        // Using dataHash for checksum; integrityCheck result logged separately if needed
      });

      res.json({
        success: true,
        syncId: syncOperation.id,
        timestamp: new Date().toISOString(),
        pushed: {
          applied: pushResults.applied,
          rejected: pushResults.rejected,
          conflicts: pushResults.conflicts,
        },
        pulled: {
          changes: serverChanges,
          count: serverChanges.length,
        },
        integrityCheck,
      });
    } catch (error) {
      this.logger.error('Full sync failed:', { context: 'SyncController', error: getErrorMessage(error), stack: getErrorStack(error) });
      next(error);
    }
  }

  /**
   * Resolve conflicts in batch (NEW - Batch conflict resolution)
   * POST /api/v1/sync/conflicts/batch-resolve
   *
   * Note: Request validation handled by validate(batchResolveConflictsSchema) middleware at route level
   */
  public async resolveConflicts(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);

      // Extract validated parameters (validation already done by middleware)
      const { resolutions } = req.body;

      this.logger.info('Resolving conflicts in batch', {
        context: 'SyncController',
        userId,
        conflictCount: resolutions.length,
      });

      const result = await this.syncService.resolveConflictsBatch(userId, resolutions);

      res.json({
        success: true,
        data: result,
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: getRequestId(req),
        },
      });

      // Emit real-time conflict resolution event
      this.socketService.emitToUser(userId, 'sync:conflicts:resolved', {
        resolved: result.resolved.length,
        failed: result.failed.length,
      });
    } catch (error) {
      this.logger.error('Failed to resolve conflicts', {
        context: 'SyncController',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  /**
   * Get sync status with cursor positions (ENHANCED - returns cursor positions)
   * GET /api/v1/sync/status
   */
  public async getStatus(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = getUserId(req);
      const deviceId = req.query.deviceId as string | undefined;

      this.logger.debug('Fetching sync status', {
        context: 'SyncController',
        userId,
        deviceId,
      });

      // Get sync status from SyncService (uses repositories, includes cursor positions)
      const status = await this.syncService.getSyncStatus(userId, deviceId);

      res.json({
        success: true,
        data: status,
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: getRequestId(req),
        },
      });
    } catch (error) {
      this.logger.error('Failed to get sync status', {
        context: 'SyncController',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  /**
   * Get sync health summary
   * GET /api/v1/sync/health
   */
  public async healthCheck(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = getUserId(req);
      const deviceId = req.query.deviceId as string | undefined;

      this.logger.debug('Fetching sync health', {
        context: 'SyncController',
        userId,
        deviceId,
      });

      const status = await this.syncService.getSyncStatus(userId, deviceId);

      res.json({
        success: true,
        data: {
          lastSyncAt: status.lastSyncTime,
          pendingChanges: status.pendingChanges,
          pendingConflicts: status.conflicts,
          cursorPositions: status.cursorPositions,
          syncInProgress: status.syncInProgress,
        },
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: getRequestId(req),
        },
      });
    } catch (error) {
      this.logger.error('Failed to get sync health', {
        context: 'SyncController',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  /**
   * Resolve sync conflict
   * POST /api/v1/sync/conflicts/:id/resolve
   */
  public async resolveConflict(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const id = getRouteParam(req, 'id');
      const { resolution, data } = req.body;

      // Verify conflict ownership using user-scoped repository method
      const conflict = await this.syncConflictRepository.findById(id, userId);

      if (!conflict) {
        throw AppError.notFound('Sync conflict');
      }

      // Resolve conflict using repository method
      const resolved = await this.syncConflictRepository.resolveConflict({
        conflictId: id,
        resolution: resolution,
        resolvedBy: userId,
        resolvedData: data,
      });

      res.json({
        success: true,
        data: resolved,
      });
    } catch (error) {
      this.logger.error('Failed to resolve conflict:', { context: 'SyncController', error: getErrorMessage(error), stack: getErrorStack(error) });
      next(error);
    }
  }

  /**
   * Get sync conflicts
   * GET /api/v1/sync/conflicts
   */
  public async getConflicts(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const { status = 'pending', limit = 50 } = req.query;

      // Note: Schema has 'resolution' field, not 'status'
      // 'pending' maps to unresolved conflicts (resolution: null)
      // Using repository method for proper pagination and type safety
      const result = await this.syncConflictRepository.getUnresolvedConflicts(
        userId,
        undefined, // entityType filter
        {
          page: 1,
          pageSize: Number(limit),
          orderBy: { createdAt: 'desc' },
        }
      );

      res.json({
        success: true,
        data: result.items,
        pagination: {
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
          hasMore: result.hasMore,
        },
      });
    } catch (error) {
      this.logger.error('Failed to get conflicts:', { context: 'SyncController', error: getErrorMessage(error), stack: getErrorStack(error) });
      next(error);
    }
  }

  /**
   * Reset sync state
   * POST /api/v1/sync/reset
   */
  public async resetSync(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const { deviceId, entities, force } = req.body;

      this.logger.warn(`Sync reset requested for user: ${userId}, device: ${deviceId}`, { context: 'SyncController' });

      // Require force flag for safety
      if (!force) {
        throw AppError.validation('Force flag required for sync reset');
      }

      // Reset sync state
      const result = await this.syncService.resetSyncState(userId, deviceId || '', entities);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      this.logger.error('Failed to reset sync:', { context: 'SyncController', error: getErrorMessage(error), stack: getErrorStack(error) });
      next(error);
    }
  }

  /**
   * Export data for backup
   * GET /api/v1/sync/export
   */
  public async exportData(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const { format = 'json', entities, compress } = req.query;

      const data = await this.syncService.exportUserData(
        userId,
        entities ? (entities as string).split(',') : undefined,
      );

      if (format === 'json') {
        if (compress === 'true') {
          res.setHeader('Content-Type', 'application/gzip');
          res.setHeader('Content-Disposition', 'attachment; filename="backup.json.gz"');
          // Compression would be handled by middleware
        } else {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Content-Disposition', 'attachment; filename="backup.json"');
        }
        res.json(data);
      } else {
        throw AppError.validation(`Format ${format} not supported`);
      }
    } catch (error) {
      this.logger.error('Failed to export data:', { context: 'SyncController', error: getErrorMessage(error), stack: getErrorStack(error) });
      next(error);
    }
  }

  /**
   * Import data from backup
   * POST /api/v1/sync/import
   */
  public async importData(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const { data, merge = false, validate = true } = req.body;

      const result = await this.syncService.importUserData(userId, data, {
        merge,
        validate,
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      this.logger.error('Failed to import data:', { context: 'SyncController', error: getErrorMessage(error), stack: getErrorStack(error) });
      next(error);
    }
  }

  /**
   * Get sync history
   * GET /api/v1/sync/history
   */
  public async getHistory(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const { deviceId, limit = 50, offset = 0 } = req.query;

      // Convert offset-based to page-based pagination
      const page = Math.floor(Number(offset) / Number(limit)) + 1;
      const result = await this.syncOperationRepository.findByUserId(userId, {
        page,
        pageSize: Number(limit),
        deviceId: deviceId as string | undefined,
      });

      res.json({
        success: true,
        data: result.items,
        pagination: {
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
          hasMore: result.hasMore,
        },
      });
    } catch (error) {
      this.logger.error('Failed to get sync history:', { context: 'SyncController', error: getErrorMessage(error), stack: getErrorStack(error) });
      next(error);
    }
  }
}
