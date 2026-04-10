/**
 * WebSocket Management Routes
 * API endpoints for WebSocket service monitoring and management
 * 
 * Provides endpoints for:
 * - Health monitoring
 * - Connection statistics
 * - Active session management
 * - Admin broadcast capabilities
 */

import { Router, RequestHandler } from 'express';
import { WebSocketController } from '../controllers/websocket.controller';
import { createRequestValidationMiddleware } from '../middleware/requestValidation.middleware';
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

const router = Router();

// Service injection support
let routeServices: RouteServices | null = null;

/**
 * Initialize route services and register routes
 */
export function initializeRouteServices(services: RouteServices): void {
  routeServices = services;
  
  // Register all routes after services are initialized
  registerWebSocketRoutes();
}

/**
 * Get WebSocketController from ControllerRegistry with dependency injection
 */
const getWebSocketController = (): WebSocketController => {
  if (!routeServices) {
    throw new Error('Route services not initialized. Call initializeRouteServices() first.');
  }
  return routeServices.controllerRegistry.getController<WebSocketController>('websocket');
};

/**
 * Get rate limiter from MiddlewareFactory
 */
const getRateLimiter = (type: 'strict' | 'standard' | 'ai' | 'auth' = 'strict') => {
  if (!routeServices) {
    throw new Error('Route services not initialized');
  }
  return routeServices.middlewareFactory.getRateLimiter(type);
};

/**
 * Get validation middleware from MiddlewareFactory
 */
const getValidationMiddleware = () => {
  if (!routeServices) {
    throw new Error('Route services not initialized');
  }
  return createRequestValidationMiddleware(
    routeServices.services.requestValidationService,
    routeServices.services.logger,
  );
};

/**
 * Get authorization middleware from MiddlewareFactory
 */
const getAuthorizationMiddleware = (roles: string[]) => {
  if (!routeServices) {
    throw new Error('Route services not initialized');
  }
  return routeServices.middlewareFactory.getAuthorization(roles);
};

// Validation schemas
const BroadcastSchema = z.object({
  body: z.object({
    event: z.string().min(1).max(100),
    data: z.any(),
    target: z.enum(['all', 'authenticated', 'room']).default('authenticated'),
    roomId: z.string().optional(),
  }),
});

const MessageToUserSchema = z.object({
  body: z.object({
    userId: z.string().uuid(),
    event: z.string().min(1).max(100),
    data: z.any(),
  }),
});

const RoomManagementSchema = z.object({
  body: z.object({
    userId: z.string().uuid(),
    roomId: z.string().min(1).max(100),
    action: z.enum(['join', 'leave']),
  }),
});

/**
 * Register all WebSocket routes after services are initialized
 */
function registerWebSocketRoutes() {
  // Clear any existing routes first
  router.stack.length = 0;

  // Authentication now handled at application level in index.ts

  /**
 * @swagger
 * /api/v1/websocket/health:
 *   get:
 *     summary: Get WebSocket service health status
 *     tags: [WebSocket]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: WebSocket service health status
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
 *                     status:
 *                       type: string
 *                       enum: [healthy, degraded, unhealthy]
 *                     details:
 *                       type: object
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/health',
  getRateLimiter('standard'),
  getWebSocketController().getHealthStatus.bind(getWebSocketController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/websocket/connections:
 *   get:
 *     summary: Get active WebSocket connections count
 *     tags: [WebSocket]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Connection statistics
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
 *                     total:
 *                       type: number
 *                     authenticated:
 *                       type: number
 *                     anonymous:
 *                       type: number
 *                     byNamespace:
 *                       type: object
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/connections',
  getRateLimiter('standard'),
  getWebSocketController().getConnectionCount.bind(getWebSocketController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/websocket/sessions:
 *   get:
 *     summary: Get active WebSocket sessions
 *     tags: [WebSocket]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: userId
 *         schema:
 *           type: string
 *         description: Filter by user ID
 *       - in: query
 *         name: roomId
 *         schema:
 *           type: string
 *         description: Filter by room ID
 *     responses:
 *       200:
 *         description: Active sessions list
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
 *                       socketId:
 *                         type: string
 *                       userId:
 *                         type: string
 *                       connectedAt:
 *                         type: string
 *                         format: date-time
 *                       rooms:
 *                         type: array
 *                         items:
 *                           type: string
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - admin access required
 */
router.get(
  '/sessions',
  getRateLimiter('strict'),
  getAuthorizationMiddleware(['admin']),
  getWebSocketController().getActiveSessions.bind(getWebSocketController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/websocket/broadcast:
 *   post:
 *     summary: Broadcast message to WebSocket clients
 *     tags: [WebSocket]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - event
 *               - data
 *             properties:
 *               event:
 *                 type: string
 *                 description: Event name
 *               data:
 *                 type: object
 *                 description: Event data
 *               target:
 *                 type: string
 *                 enum: [all, authenticated, room]
 *                 default: authenticated
 *               roomId:
 *                 type: string
 *                 description: Room ID if target is 'room'
 *     responses:
 *       200:
 *         description: Broadcast sent successfully
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - admin access required
 */
router.post(
  '/broadcast',
  getRateLimiter('strict'),
  getAuthorizationMiddleware(['admin']),
  getValidationMiddleware().validateBody(BroadcastSchema),
  getWebSocketController().broadcastMessage.bind(getWebSocketController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/websocket/message/user:
 *   post:
 *     summary: Send message to specific user
 *     tags: [WebSocket]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *               - event
 *               - data
 *             properties:
 *               userId:
 *                 type: string
 *                 format: uuid
 *               event:
 *                 type: string
 *               data:
 *                 type: object
 *     responses:
 *       200:
 *         description: Message sent successfully
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: User not connected
 */
router.post(
  '/message/user',
  getRateLimiter('strict'),
  getAuthorizationMiddleware(['admin']),
  getValidationMiddleware().validateBody(MessageToUserSchema),
  getWebSocketController().sendUserMessage.bind(getWebSocketController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/websocket/room:
 *   post:
 *     summary: Manage room membership
 *     tags: [WebSocket]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *               - roomId
 *               - action
 *             properties:
 *               userId:
 *                 type: string
 *                 format: uuid
 *               roomId:
 *                 type: string
 *               action:
 *                 type: string
 *                 enum: [join, leave]
 *     responses:
 *       200:
 *         description: Room action completed
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
router.post(
  '/room',
  getRateLimiter('strict'),
  getAuthorizationMiddleware(['admin']),
  getValidationMiddleware().validateBody(RoomManagementSchema),
  getWebSocketController().manageRoom.bind(getWebSocketController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/websocket/disconnect:
 *   post:
 *     summary: Force disconnect a user
 *     tags: [WebSocket]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *             properties:
 *               userId:
 *                 type: string
 *                 format: uuid
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: User disconnected
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - admin access required
 *       404:
 *         description: User not connected
 */
router.post(
  '/disconnect',
  getRateLimiter('strict'),
  getAuthorizationMiddleware(['admin']),
  getWebSocketController().disconnectUser.bind(getWebSocketController()) as RequestHandler,
  );
}

export default router;