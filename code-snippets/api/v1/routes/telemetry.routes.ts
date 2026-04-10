/**
 * Device Telemetry Routes
 * API endpoints for device telemetry data management
 * 
 * All routes require authentication
 */

import { Router, RequestHandler } from 'express';
import { TelemetryController } from '../controllers/telemetry.controller';
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
  registerTelemetryRoutes();
}

/**
 * Get TelemetryController from ControllerRegistry with dependency injection
 */
const getTelemetryController = () => {
  if (!routeServices) {
    throw new Error('Route services not initialized. Call initializeRouteServices() first.');
  }
  return routeServices.controllerRegistry.getController<TelemetryController>('telemetry');
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

// Validation schemas for route-specific validation
const TelemetryIngestionSchema = z.object({
  body: z.object({
    deviceId: z.string().min(1).max(128),
    timestamp: z.string().datetime().optional(),
    metrics: z.record(z.number()),
    metadata: z.record(z.any()).optional(),
    firmwareVersion: z.string().optional(),
    batteryLevel: z.number().min(0).max(100).optional(),
  }),
});

const BatchTelemetrySchema = z.object({
  body: z.array(z.object({
    deviceId: z.string().min(1).max(128),
    timestamp: z.string().datetime().optional(),
    metrics: z.record(z.number()),
    metadata: z.record(z.any()).optional(),
    firmwareVersion: z.string().optional(),
    batteryLevel: z.number().min(0).max(100).optional(),
  })).min(1).max(100),
});

const TelemetryQuerySchema = z.object({
  query: z.object({
    startTime: z.string().datetime().optional(),
    endTime: z.string().datetime().optional(),
    limit: z.coerce.number().min(1).max(1000).default(100).optional(),
    nextToken: z.string().optional(),
  }),
});

const AggregationQuerySchema = z.object({
  query: z.object({
    startTime: z.string().datetime(),
    endTime: z.string().datetime(),
    interval: z.enum(['minute', 'hour', 'day', 'week']).default('hour').optional(),
    metrics: z.array(z.string()).optional(),
  }),
});

/**
 * Register all telemetry routes after services are initialized
 */
function registerTelemetryRoutes() {
  // Clear any existing routes first
  router.stack.length = 0;

  // Authentication now handled at application level in index.ts

  /**
 * @swagger
 * /api/v1/telemetry:
 *   post:
 *     summary: Ingest device telemetry data
 *     tags: [Telemetry]
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
 *               - metrics
 *             properties:
 *               deviceId:
 *                 type: string
 *               timestamp:
 *                 type: string
 *                 format: date-time
 *               metrics:
 *                 type: object
 *               metadata:
 *                 type: object
 *               firmwareVersion:
 *                 type: string
 *               batteryLevel:
 *                 type: number
 *     responses:
 *       201:
 *         description: Telemetry data ingested successfully
 *       400:
 *         description: Invalid telemetry data
 *       401:
 *         description: Unauthorized
 */
router.post(
  '/',
  getRateLimiter('standard'),
  getValidationMiddleware().validateBody(TelemetryIngestionSchema.shape.body),
  getTelemetryController().ingestTelemetry.bind(getTelemetryController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/telemetry/batch:
 *   post:
 *     summary: Batch ingest telemetry data
 *     tags: [Telemetry]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: array
 *             items:
 *               type: object
 *               required:
 *                 - deviceId
 *                 - metrics
 *     responses:
 *       201:
 *         description: Batch telemetry data ingested
 *       400:
 *         description: Invalid batch data
 *       401:
 *         description: Unauthorized
 */
router.post(
  '/batch',
  getRateLimiter('strict'),
  getValidationMiddleware().validateBody(BatchTelemetrySchema.shape.body),
  getTelemetryController().batchIngestTelemetry.bind(getTelemetryController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/telemetry/device/{deviceId}:
 *   get:
 *     summary: Get telemetry data for a device
 *     tags: [Telemetry]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: deviceId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: startTime
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: endTime
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 1000
 *           default: 100
 *       - in: query
 *         name: nextToken
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Telemetry data retrieved
 *       400:
 *         description: Invalid parameters
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Device not found
 */
router.get(
  '/device/:deviceId',
  getRateLimiter('standard'),
  getValidationMiddleware().validateQuery(TelemetryQuerySchema.shape.query),
  getTelemetryController().getDeviceTelemetry.bind(getTelemetryController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/telemetry/device/{deviceId}/health:
 *   get:
 *     summary: Get device health status
 *     tags: [Telemetry]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: deviceId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Device health status retrieved
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Device not found
 */
router.get(
  '/device/:deviceId/health',
  getRateLimiter('standard'),
  getTelemetryController().getDeviceHealth.bind(getTelemetryController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/telemetry/device/{deviceId}/aggregate:
 *   get:
 *     summary: Get aggregated telemetry metrics
 *     tags: [Telemetry]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: deviceId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: startTime
 *         required: true
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: endTime
 *         required: true
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: interval
 *         schema:
 *           type: string
 *           enum: [minute, hour, day, week]
 *           default: hour
 *       - in: query
 *         name: metrics
 *         schema:
 *           type: array
 *           items:
 *             type: string
 *     responses:
 *       200:
 *         description: Aggregated metrics retrieved
 *       400:
 *         description: Invalid parameters
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Device not found
 */
router.get(
  '/device/:deviceId/aggregate',
  getRateLimiter('standard'),
  getValidationMiddleware().validateQuery(AggregationQuerySchema.shape.query),
  getTelemetryController().getAggregatedMetrics.bind(getTelemetryController()) as RequestHandler,
  );
}

export default router;