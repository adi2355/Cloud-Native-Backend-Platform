/**
 * Session Routes
 * Defines API endpoints for consumption session management
 * 
 * @swagger
 * tags:
 *   name: Sessions
 *   description: Consumption session management endpoints
 */

import { Router, RequestHandler } from 'express';
import { SessionController } from '../controllers/session.controller';
import { z } from 'zod';
import type { MiddlewareFactory } from '../../../core/middleware-factory';
import type { InitializedServices } from '../../../bootstrap';
import { ControllerRegistry } from '../../../core/controller-registry';

// Route services interface
export interface RouteServices {
  middlewareFactory: MiddlewareFactory;
  controllerRegistry: ControllerRegistry;
  services: InitializedServices;
}
import {
  sessionSchemas,
  startSessionSchema,
  updateSessionSchema,
  endSessionSchema,
  listSessionsSchema,
  getSessionSchema,
  addParticipantSchema,
  sessionStatsSchema,
  shareSessionSchema,
  joinSessionSchema,
  sessionTelemetrySchema,
  pauseSessionSchema,
  resumeSessionSchema,
  cancelSessionSchema,
} from '../schemas/session.schemas';

const router = Router();
// Service injection support
let routeServices: RouteServices | null = null;

/**
 * Initialize route services and register routes
 */
export function initializeRouteServices(services: RouteServices): void {
  routeServices = services;
  
  // Register all routes after services are initialized
  registerSessionRoutes();
}

/**
 * Get SessionController from ControllerRegistry with dependency injection
 */
const getSessionController = (): SessionController => {
  if (!routeServices) {
    throw new Error('Route services not initialized. Call initializeRouteServices() first.');
  }
  return routeServices.controllerRegistry.getController<SessionController>('session');
};

/**
 * Get rate limiter from MiddlewareFactory
 */
const getRateLimiter = (type: 'strict' | 'standard' | 'ai' | 'auth' = 'standard') => {
  if (!routeServices) {
    throw new Error('Route services not initialized');
  }
  return routeServices.middlewareFactory.getRateLimiter(type);
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
 * Get validation middleware from MiddlewareFactory
 */
const getValidation = (schema: z.AnyZodObject) => {
  if (!routeServices) {
    throw new Error('Route services not initialized');
  }
  return routeServices.middlewareFactory.getValidation(schema);
};

/**
 * Register all session routes after services are initialized
 */
function registerSessionRoutes() {
  // Clear any existing routes first
  router.stack.length = 0;

  // Apply middleware stack to all routes - handled by RouteRegistry via MiddlewareFactory

  /**
 * @swagger
 * /api/v1/sessions:
 *   get:
 *     summary: List all sessions
 *     tags: [Sessions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Maximum number of sessions
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *         description: Number of sessions to skip
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [active, paused, completed, cancelled]
 *         description: Filter by session status
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Filter by start date
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Filter by end date
 *     responses:
 *       200:
 *         description: List of sessions retrieved successfully
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
 *                     $ref: '#/components/schemas/Session'
 *                 pagination:
 *                   type: object
 */
router.get(
  '/',
  getValidation(listSessionsSchema),
  getRateLimiter('standard'),
  getSessionController().listSessions.bind(getSessionController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/sessions/active:
 *   get:
 *     summary: Get current active session
 *     tags: [Sessions]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Active session retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Session'
 *       404:
 *         description: No active session found
 */
router.get(
  '/active',
  getRateLimiter('standard'),
  getSessionController().getActiveSession.bind(getSessionController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/sessions/stats:
 *   get:
 *     summary: Get session statistics
 *     tags: [Sessions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: period
 *         schema:
 *           type: string
 *           enum: [day, week, month, quarter, year, all]
 *         description: Statistics period
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Start date for custom period
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date-time
 *         description: End date for custom period
 *       - in: query
 *         name: groupBy
 *         schema:
 *           type: string
 *           enum: [day, week, month, dayOfWeek, hour]
 *         description: Group statistics by
 *     responses:
 *       200:
 *         description: Statistics retrieved successfully
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
 *                     totalSessions:
 *                       type: integer
 *                     avgDuration:
 *                       type: number
 *                     avgRating:
 *                       type: number
 *                     topSessionTimes:
 *                       type: array
 */
router.get(
  '/stats',
  getValidation(sessionStatsSchema),
  getRateLimiter('standard'),
  getSessionController().getSessionStats.bind(getSessionController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/sessions/{id}:
 *   get:
 *     summary: Get session by ID
 *     tags: [Sessions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Session ID
 *       - in: query
 *         name: includeConsumptions
 *         schema:
 *           type: boolean
 *         description: Include consumptions in response
 *       - in: query
 *         name: includeParticipants
 *         schema:
 *           type: boolean
 *         description: Include participants in response
 *       - in: query
 *         name: includeStats
 *         schema:
 *           type: boolean
 *         description: Include statistics in response
 *     responses:
 *       200:
 *         description: Session retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Session'
 *       404:
 *         description: Session not found
 */
router.get(
  '/:id',
  getValidation(getSessionSchema),
  getSessionController().getSession.bind(getSessionController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/sessions/{id}/telemetry:
 *   get:
 *     summary: Get session telemetry (health vitals data for visualization)
 *     description: |
 *       Returns precomputed, downsampled health metrics for session visualization.
 *       Window includes 60 minutes before session start through 60 minutes after end.
 *       
 *       RESPONSE STATES (via metadata.state):
 *       - ready: 200 - Data available in response.data
 *       - computing: 202 - Still being computed (retry after Retry-After header delay)
 *       - no_data: 200 - Computed but no health data exists for this session
 *       
 *       NOTE: 'ready' and 'no_data' return 200 with body to avoid empty response issues.
 *       'computing' returns 202 to indicate processing is ongoing.
 *     tags: [Sessions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Session ID
 *       - in: query
 *         name: windowMinutes
 *         schema:
 *           type: integer
 *           minimum: 15
 *           maximum: 180
 *           default: 60
 *         description: Time window in minutes before/after session
 *       - in: query
 *         name: resolution
 *         schema:
 *           type: string
 *           enum: ['1m', '5m']
 *           default: '1m'
 *         description: Data resolution (1 or 5 minute buckets)
 *     responses:
 *       200:
 *         description: Telemetry response (check metadata.state for actual status)
 *         headers:
 *           X-Telemetry-Schema-Version:
 *             schema:
 *               type: string
 *             description: Schema version for cache invalidation
 *           X-Telemetry-Compute-Version:
 *             schema:
 *               type: string
 *             description: Compute version for recomputation tracking
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   nullable: true
 *                   description: Telemetry payload (null if no_data or computing)
 *                   properties:
 *                     sessionId:
 *                       type: string
 *                     window:
 *                       type: object
 *                       properties:
 *                         windowStartMs:
 *                           type: number
 *                         windowEndMs:
 *                           type: number
 *                         sessionStartMs:
 *                           type: number
 *                         sessionEndMs:
 *                           type: number
 *                         windowMinutes:
 *                           type: number
 *                     metrics:
 *                       type: object
 *                       additionalProperties:
 *                         type: object
 *                     computedAtMs:
 *                       type: number
 *                     schemaVersion:
 *                       type: number
 *                     computeVersion:
 *                       type: number
 *                 metadata:
 *                   type: object
 *                   properties:
 *                     state:
 *                       type: string
 *                       enum: ['ready', 'computing', 'no_data']
 *                       description: Explicit state indicator
 *                     retryAfterSeconds:
 *                       type: number
 *                       description: Seconds to wait before retry (for computing state)
 *       202:
 *         description: Telemetry is being computed (retry with Retry-After header)
 *         headers:
 *           Retry-After:
 *             schema:
 *               type: integer
 *             description: Seconds to wait before retry
 *       404:
 *         description: Session not found
 *       503:
 *         description: Telemetry service unavailable
 */
router.get(
  '/:id/telemetry',
  getValidation(sessionTelemetrySchema),
  getRateLimiter('standard'),
  getSessionController().getSessionTelemetry.bind(getSessionController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/sessions:
 *   post:
 *     summary: Start new session
 *     tags: [Sessions]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               participants:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     name:
 *                       type: string
 *                     role:
 *                       type: string
 *               location:
 *                 type: object
 *                 properties:
 *                   latitude:
 *                     type: number
 *                   longitude:
 *                     type: number
 *                   name:
 *                     type: string
 *               plannedDuration:
 *                 type: integer
 *               goals:
 *                 type: object
 *     responses:
 *       201:
 *         description: Session started successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Session'
 */
router.post(
  '/',
  getValidation(startSessionSchema),
  getRateLimiter('strict'),
  getSessionController().startSession.bind(getSessionController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/sessions/{id}:
 *   put:
 *     summary: Update session
 *     tags: [Sessions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Session ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               participants:
 *                 type: array
 *               location:
 *                 type: object
 *               goals:
 *                 type: object
 *               notes:
 *                 type: string
 *     responses:
 *       200:
 *         description: Session updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Session'
 *       404:
 *         description: Session not found
 */
router.put(
  '/:id',
  getValidation(updateSessionSchema),
  getRateLimiter('standard'),
  getSessionController().updateSession.bind(getSessionController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/sessions/{id}/end:
 *   post:
 *     summary: End active session
 *     tags: [Sessions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Session ID
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               summary:
 *                 type: object
 *                 properties:
 *                   highlights:
 *                     type: array
 *                     items:
 *                       type: string
 *                   lowlights:
 *                     type: array
 *                     items:
 *                       type: string
 *                   learnings:
 *                     type: array
 *                     items:
 *                       type: string
 *               rating:
 *                 type: number
 *                 minimum: 0
 *                 maximum: 5
 *               notes:
 *                 type: string
 *               wouldRepeat:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Session ended successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Session'
 *       404:
 *         description: Active session not found
 */
router.post(
  '/:id/end',
  getValidation(endSessionSchema),
  getRateLimiter('strict'),
  getSessionController().endSession.bind(getSessionController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/sessions/{id}/complete:
 *   post:
 *     summary: Complete/End an active session
 *     tags: [Sessions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Session ID
 *     responses:
 *       200:
 *         description: Session completed successfully
 *       404:
 *         description: Session not found
 */
router.post(
  '/:id/complete',
  getRateLimiter('strict'),
  getSessionController().completeSession.bind(getSessionController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/sessions/{id}:
 *   delete:
 *     summary: Delete session by ID
 *     tags: [Sessions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Session ID
 *     responses:
 *       204:
 *         description: Session deleted successfully
 *       404:
 *         description: Session not found
 */
router.delete(
  '/:id',
  getRateLimiter('strict'),
  getSessionController().deleteSession.bind(getSessionController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/sessions/{id}:
 *   patch:
 *     summary: Partially update session by ID
 *     tags: [Sessions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Session ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Session updated successfully
 *       404:
 *         description: Session not found
 */
router.patch(
  '/:id',
  getValidation(updateSessionSchema),
  getRateLimiter('standard'),
  ...getCacheMiddleware(['sessions', 'user-stats']),
  getSessionController().patchSession.bind(getSessionController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/sessions/{id}/pause:
 *   post:
 *     summary: Pause an active session
 *     tags: [Sessions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Session ID
 *     responses:
 *       200:
 *         description: Session paused successfully
 *       404:
 *         description: Session not found
 */
router.post(
  '/:id/pause',
  getValidation(pauseSessionSchema),
  getRateLimiter('standard'),
  ...getCacheMiddleware(['sessions']),
  getSessionController().pauseSession.bind(getSessionController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/sessions/{id}/resume:
 *   post:
 *     summary: Resume a paused session
 *     tags: [Sessions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Session ID
 *     responses:
 *       200:
 *         description: Session resumed successfully
 *       404:
 *         description: Session not found
 */
router.post(
  '/:id/resume',
  getValidation(resumeSessionSchema),
  getRateLimiter('standard'),
  ...getCacheMiddleware(['sessions']),
  getSessionController().resumeSession.bind(getSessionController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/sessions/{id}/cancel:
 *   post:
 *     summary: Cancel an active or paused session
 *     tags: [Sessions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Session ID
 *     responses:
 *       200:
 *         description: Session cancelled successfully
 *       404:
 *         description: Session not found
 *       409:
 *         description: Session is in COMPLETED terminal state
 */
router.post(
  '/:id/cancel',
  getValidation(cancelSessionSchema),
  getRateLimiter('standard'),
  ...getCacheMiddleware(['sessions']),
  getSessionController().cancelSession.bind(getSessionController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/sessions/analytics:
 *   get:
 *     summary: Get session analytics
 *     tags: [Sessions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Analytics start date
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Analytics end date
 *     responses:
 *       200:
 *         description: Session analytics retrieved successfully
 */
router.get(
  '/analytics',
  getValidation(sessionStatsSchema),
  getRateLimiter('strict'),
  ...getCacheMiddleware(['sessions', 'analytics']),
  getSessionController().getSessionAnalytics.bind(getSessionController()) as RequestHandler,
);
}

export default router;
