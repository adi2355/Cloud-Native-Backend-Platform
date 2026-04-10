/**
 * Sync Routes
 * Defines API endpoints for data synchronization
 * 
 * @swagger
 * tags:
 *   name: Sync
 *   description: Data synchronization endpoints
 */

import { Router, RequestHandler, Request } from 'express';
import { SyncController } from '../controllers/sync.controller';
import { z } from 'zod';
import {
  syncSchemas,
  pushSyncSchema,
  pullSyncSchema,
  fullSyncSchema,
  syncStatusSchema,
  syncHealthSchema,
  resolveConflictSchema,
  getConflictsSchema,
  resetSyncSchema,
  exportDataSchema,
  importDataSchema,
  syncHistorySchema,
  syncChangesSchema,
  syncLeaseSchema,
  pushSyncCursorSchema,
  batchResolveConflictsSchema,
} from '../schemas/sync.schemas';
import type { MiddlewareFactory } from '../../../core/middleware-factory';
import type { InitializedServices } from '../../../bootstrap';
import { ControllerRegistry } from '../../../core/controller-registry';
import { requireDeviceId, deviceIdMiddleware } from '../middleware/deviceId.middleware';
import { createSyncLeaseMiddleware } from '../middleware/sync-lease.middleware';

// Route services interface
export interface RouteServices {
  middlewareFactory: MiddlewareFactory;
  controllerRegistry: ControllerRegistry;
  services: InitializedServices;
}

const router = Router();

// Service injection support
let routeServices: RouteServices | null = null;

/**
 * Initialize route services and register routes
 */
export function initializeRouteServices(services: RouteServices): void {
  routeServices = services;
  
  // Register all routes after services are initialized
  registerSyncRoutes();
}

/**
 * Get SyncController from ControllerRegistry with dependency injection
 */
const getSyncController = (): SyncController => {
  if (!routeServices) {
    throw new Error('Route services not initialized. Call initializeRouteServices() first.');
  }
  return routeServices.controllerRegistry.getController<SyncController>('sync');
};

/**
 * Get cache middleware from MiddlewareFactory
 */
const getCacheMiddleware = (invalidationKeys?: string[]) => {
  if (!routeServices) {
    throw new Error('Route services not initialized');
  }
  return routeServices.middlewareFactory.createCachingMiddleware(invalidationKeys);
};

/**
 * Register all sync routes after services are initialized
 */

/**
 * Get validation middleware from MiddlewareFactory
 */
const getValidation = (schema: z.AnyZodObject) => {
  if (!routeServices) {
    throw new Error('Route services not initialized');
  }
  return routeServices.middlewareFactory.getValidation(schema);
};

/**
 * Get sync lease middleware (admission control)
 */
const getSyncLeaseMiddleware = (options: { kind: 'health_upload' | 'catalog_sync'; getLeaseId: (req: Request) => string | undefined; shouldRequire?: (req: Request) => boolean }) => {
  if (!routeServices) {
    throw new Error('Route services not initialized');
  }
  return createSyncLeaseMiddleware(
    routeServices.services.syncLeaseService,
    routeServices.services.logger,
    options
  );
};

/**
 * Get deviceId middleware (required mode for sync endpoints)
 */
const getRequireDeviceId = () => {
  if (!routeServices) {
    throw new Error('Route services not initialized');
  }
  return requireDeviceId(routeServices.services.logger);
};

/**
 * Get deviceId middleware (optional mode for non-sync endpoints)
 */
const getDeviceIdMiddleware = () => {
  if (!routeServices) {
    throw new Error('Route services not initialized');
  }
  return deviceIdMiddleware(routeServices.services.logger);
};

function registerSyncRoutes() {
  // Clear any existing routes first
  router.stack.length = 0;

  // Apply middleware stack to all routes - handled by RouteRegistry via MiddlewareFactory
  // Global middleware like authentication, correlation context, and user context are now handled centrally

  /**
 * @swagger
 * /api/v1/sync/push:
 *   post:
 *     summary: Push local changes to server
 *     tags: [Sync]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - deviceId
 *             properties:
 *               lastSyncTimestamp:
 *                 type: string
 *                 format: date-time
 *               changes:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     entity:
 *                       type: string
 *                     entityId:
 *                       type: string
 *                     operation:
 *                       type: string
 *                       enum: [create, update, delete]
 *                     data:
 *                       type: object
 *                     timestamp:
 *                       type: string
 *                       format: date-time
 *               deviceId:
 *                 type: string
 *               clientVersion:
 *                 type: string
 *     responses:
 *       200:
 *         description: Changes pushed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 applied:
 *                   type: array
 *                 rejected:
 *                   type: array
 *                 conflicts:
 *                   type: array
 *                 serverChanges:
 *                   type: array
 */
router.post(
  '/push',
  getValidation(pushSyncCursorSchema),
  // Sync operations can modify any entity type (consumptions, sessions, journals, etc.).
  // We must invalidate all downstream read caches (stats, lists, analytics) to prevent
  // serving stale data after a sync operation completes.
  // See: https://github.com/... (tag mismatch root cause analysis)
  ...getCacheMiddleware([
    'sync-data',
    'consumptions',
    'sessions',
    'journal-data',
    'user-stats',
    'analytics',
    'goals',
    'achievements',
    'inventory',
    'products',
    'devices',
    'user-profile',
  ]),
  getSyncController().push.bind(getSyncController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/sync/pull:
 *   get:
 *     summary: Pull server changes
 *     tags: [Sync]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: lastSyncTimestamp
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Last sync timestamp
 *       - in: query
 *         name: deviceId
 *         schema:
 *           type: string
 *         description: Device identifier
 *       - in: query
 *         name: entities
 *         schema:
 *           type: string
 *         description: Comma-separated entity types to sync
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Maximum number of changes to return
 *     responses:
 *       200:
 *         description: Changes pulled successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 changes:
 *                   type: array
 *                 hasMore:
 *                   type: boolean
 */
router.get(
  '/pull',
  getValidation(pullSyncSchema),
  getSyncController().pull.bind(getSyncController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/sync/full:
 *   post:
 *     summary: Perform full bidirectional sync
 *     tags: [Sync]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - deviceId
 *             properties:
 *               lastSyncTimestamp:
 *                 type: string
 *                 format: date-time
 *               changes:
 *                 type: array
 *               deviceId:
 *                 type: string
 *               checksum:
 *                 type: string
 *               forceOverwrite:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Full sync completed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 syncId:
 *                   type: string
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 pushed:
 *                   type: object
 *                 pulled:
 *                   type: object
 *                 integrityCheck:
 *                   type: object
 */
router.post(
  '/full',
  getValidation(fullSyncSchema),
  // Must invalidate all entity caches to ensure fresh data after sync.
  ...getCacheMiddleware([
    'sync-data',
    'consumptions',
    'sessions',
    'journal-data',
    'user-stats',
    'analytics',
    'goals',
    'achievements',
    'inventory',
    'products',
    'devices',
    'user-profile',
  ]),
  getSyncController().fullSync.bind(getSyncController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/sync/status:
 *   get:
 *     summary: Get sync status
 *     tags: [Sync]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: deviceId
 *         schema:
 *           type: string
 *         description: Device identifier
 *       - in: query
 *         name: includeMetrics
 *         schema:
 *           type: boolean
 *         description: Include sync metrics
 *     responses:
 *       200:
 *         description: Sync status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     lastSync:
 *                       type: object
 *                     pendingChanges:
 *                       type: integer
 *                     health:
 *                       type: object
 *                     serverTime:
 *                       type: string
 *                       format: date-time
 */
router.get(
  '/status',
  getValidation(syncStatusSchema),
  getSyncController().getStatus.bind(getSyncController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/sync/health:
 *   get:
 *     summary: Get sync health summary
 *     tags: [Sync]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: deviceId
 *         schema:
 *           type: string
 *         description: Device identifier
 *     responses:
 *       200:
 *         description: Sync health retrieved successfully
 */
router.get(
  '/health',
  getValidation(syncHealthSchema),
  getSyncController().healthCheck.bind(getSyncController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/sync/conflicts:
 *   get:
 *     summary: Get sync conflicts
 *     tags: [Sync]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, resolved, ignored]
 *         description: Conflict status
 *       - in: query
 *         name: entity
 *         schema:
 *           type: string
 *         description: Entity type
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Maximum conflicts to return
 *     responses:
 *       200:
 *         description: Conflicts retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       entity:
 *                         type: string
 *                       entityId:
 *                         type: string
 *                       clientData:
 *                         type: object
 *                       serverData:
 *                         type: object
 *                       status:
 *                         type: string
 */
router.get(
  '/conflicts',
  getValidation(getConflictsSchema),
  getSyncController().getConflicts.bind(getSyncController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/sync/conflicts/{id}/resolve:
 *   post:
 *     summary: Resolve sync conflict
 *     tags: [Sync]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Conflict ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - resolution
 *             properties:
 *               resolution:
 *                 type: string
 *                 enum: [client, server, merge, custom]
 *               data:
 *                 type: object
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Conflict resolved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 */
router.post(
  '/conflicts/:id/resolve',
  getValidation(resolveConflictSchema),
  // Conflict resolution can modify entity data (choosing client/server/merge).
  // Must invalidate all entity caches to ensure fresh data after resolution.
  ...getCacheMiddleware([
    'sync-data',
    'consumptions',
    'sessions',
    'journal-data',
    'user-stats',
    'analytics',
    'goals',
    'achievements',
    'inventory',
    'products',
    'devices',
    'user-profile',
  ]),
  getSyncController().resolveConflict.bind(getSyncController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/sync/reset:
 *   post:
 *     summary: Reset sync state
 *     tags: [Sync]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - force
 *             properties:
 *               deviceId:
 *                 type: string
 *               entities:
 *                 type: array
 *                 items:
 *                   type: string
 *               force:
 *                 type: boolean
 *               clearConflicts:
 *                 type: boolean
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Sync state reset successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 */
router.post(
  '/reset',
  getValidation(resetSyncSchema),
  // Sync reset affects sync metadata and potentially triggers re-sync.
  // Invalidate sync-related caches to ensure fresh state.
  ...getCacheMiddleware(['sync-data']),
  getSyncController().resetSync.bind(getSyncController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/sync/export:
 *   get:
 *     summary: Export user data
 *     tags: [Sync]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: format
 *         schema:
 *           type: string
 *           enum: [json, csv, sqlite]
 *         description: Export format
 *       - in: query
 *         name: entities
 *         schema:
 *           type: string
 *         description: Comma-separated entity types to export
 *       - in: query
 *         name: compress
 *         schema:
 *           type: boolean
 *         description: Compress export file
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Export start date
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Export end date
 *     responses:
 *       200:
 *         description: Data exported successfully
 *         content:
 *           application/octet-stream:
 *             schema:
 *               type: string
 *               format: binary
 */
router.get(
  '/export',
  getValidation(exportDataSchema),
  getSyncController().exportData.bind(getSyncController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/sync/import:
 *   post:
 *     summary: Import user data
 *     tags: [Sync]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - data
 *             properties:
 *               data:
 *                 type: object
 *               format:
 *                 type: string
 *                 enum: [json, csv, sqlite]
 *               merge:
 *                 type: boolean
 *               validate:
 *                 type: boolean
 *               overwriteExisting:
 *                 type: boolean
 *               dryRun:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Data imported successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     imported:
 *                       type: integer
 *                     skipped:
 *                       type: integer
 *                     errors:
 *                       type: array
 */
router.post(
  '/import',
  getValidation(importDataSchema),
  // Must invalidate all entity caches to ensure fresh data after import.
  ...getCacheMiddleware([
    'sync-data',
    'consumptions',
    'sessions',
    'journal-data',
    'user-stats',
    'analytics',
    'goals',
    'achievements',
    'inventory',
    'products',
    'devices',
    'user-profile',
  ]),
  getSyncController().importData.bind(getSyncController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/sync/history:
 *   get:
 *     summary: Get sync history
 *     tags: [Sync]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: deviceId
 *         schema:
 *           type: string
 *         description: Device identifier
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Maximum records to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *         description: Number of records to skip
 *       - in: query
 *         name: operationType
 *         schema:
 *           type: string
 *           enum: [push, pull, full]
 *         description: Sync operation type
 *     responses:
 *       200:
 *         description: Sync history retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       operationType:
 *                         type: string
 *                       deviceId:
 *                         type: string
 *                       changesCount:
 *                         type: integer
 *                       status:
 *                         type: string
 *                       timestamp:
 *                         type: string
 *                         format: date-time
 *                 pagination:
 *                   type: object
 */
router.get(
  '/history',
  getValidation(syncHistorySchema),
  getSyncController().getHistory.bind(getSyncController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/sync/lease:
 *   post:
 *     summary: Request a sync lease for bulk operations
 *     tags: [Sync]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Lease decision returned
 */
router.post(
  '/lease',
  getValidation(syncLeaseSchema),
  getSyncController().requestLease.bind(getSyncController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/sync/changes:
 *   get:
 *     summary: Get incremental changes using cursor-based pagination
 *     tags: [Sync]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *         description: Base64-encoded cursor for pagination
 *       - in: query
 *         name: entityTypes
 *         schema:
 *           type: string
 *         description: Comma-separated entity types to sync (consumptions,sessions,journal_entries,goals,purchases,inventory_items)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 1000
 *         description: Maximum number of changes to return
 *       - in: query
 *         name: productFields
 *         schema:
 *           type: string
 *         description: Optional comma-separated product field mask for catalog shaping
 *     responses:
 *       200:
 *         description: Incremental changes retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     changes:
 *                       type: array
 *                     nextCursor:
 *                       type: string
 *                       nullable: true
 *                     hasMore:
 *                       type: boolean
 *                     entityCursors:
 *                       type: object
 */
/**
 *
 * This endpoint now receives ALL entity types in a single request (batched),
 * reducing network calls from 7 per sync cycle to 1. Therefore, it requires
 * a more lenient rate limit to accommodate frequent legitimate sync operations
 * across thousands of users.
 *
 * Old: 7 requests per sync cycle × 2 syncs/min = ~14 req/min per user
 * New: 1 request per sync cycle × 2 syncs/min = ~2 req/min per user
 *
 * Rate limit: Sync bucket (per user+device). Defaults to 200 requests / 15 minutes.
 * See SYNC_RATE_LIMIT_MAX_REQUESTS and SYNC_RATE_LIMIT_WINDOW_MS.
 */
router.get(
  '/changes',
  getRequireDeviceId(), // Extract and validate X-Device-ID header (REQUIRED for distributed locks)
  getValidation(syncChangesSchema),
  getSyncLeaseMiddleware({
    kind: 'catalog_sync',
    getLeaseId: (req) => (req.query.leaseId as string | undefined),
    shouldRequire: (req) => {
      const entityTypesParam = req.query.entityTypes;
      if (!entityTypesParam) {
        return true;
      }
      const raw = Array.isArray(entityTypesParam)
        ? entityTypesParam.join(',')
        : String(entityTypesParam);
      const entityTypes = raw.split(',').map((t) => t.trim()).filter(Boolean);
      return entityTypes.length === 0 || entityTypes.includes('products');
    },
  }),
  getSyncController().getChanges.bind(getSyncController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/sync/conflicts/batch-resolve:
 *   post:
 *     summary: Resolve multiple sync conflicts in batch
 *     tags: [Sync]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - resolutions
 *             properties:
 *               resolutions:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required:
 *                     - conflictId
 *                     - strategy
 *                   properties:
 *                     conflictId:
 *                       type: string
 *                       format: uuid
 *                     strategy:
 *                       type: string
 *                       enum: [LOCAL_WINS, REMOTE_WINS, MERGE, MANUAL]
 *                     mergedData:
 *                       type: object
 *                       description: Required when strategy is MERGE or MANUAL
 *     responses:
 *       200:
 *         description: Conflicts resolved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     successful:
 *                       type: array
 *                     failed:
 *                       type: array
 */
router.post(
  '/conflicts/batch-resolve',
  getValidation(batchResolveConflictsSchema),
  // Batch conflict resolution can modify multiple entities.
  // Must invalidate all entity caches to ensure fresh data after resolution.
  ...getCacheMiddleware([
    'sync-data',
    'consumptions',
    'sessions',
    'journal-data',
    'user-stats',
    'analytics',
    'goals',
    'achievements',
    'inventory',
    'products',
    'devices',
    'user-profile',
  ]),
  getSyncController().resolveConflicts.bind(getSyncController()) as RequestHandler,
);
}

export default router;
