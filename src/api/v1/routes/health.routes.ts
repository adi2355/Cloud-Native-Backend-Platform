/**
 * Health Routes
 * API endpoints for health data operations (HealthKit/Health Connect)
 *
 * ARCHITECTURE:
 * - Separate from entity sync routes
 * - Push-only sync (batch upsert)
 * - Two-layer idempotency
 *
 * All routes require authentication
 */

import { Router, RequestHandler, Request, Response, NextFunction } from 'express';
import { HealthController } from '../controllers/health.controller';
import { createRequestValidationMiddleware } from '../middleware/requestValidation.middleware';
import { requireDeviceId } from '../middleware/deviceId.middleware';
import { createHealthErrorHandler } from '../middleware/health-error.middleware';
import { createSyncLeaseMiddleware } from '../middleware/sync-lease.middleware';
import { z } from 'zod';
import {
  validateBatchUpsertRequestWithHash,
  BatchValidationError,
  BATCH_VALIDATION_ERROR_CODES,
  // UNIFIED FIX: Import shared query schemas instead of defining local duplicates
  GetSamplesQuerySchema as SharedGetSamplesQuerySchema,
  GetSamplesCursorQuerySchema as SharedGetSamplesCursorQuerySchema,
  MAX_QUERY_WINDOW_MS,
  MAX_PAGE_NUMBER,
  // Phase 1: Health projection read schemas
  GetRollupsQuerySchema,
  GetSleepSummariesQuerySchema,
  GetSessionImpactQuerySchema,
  // Phase 6A: Recent session impact schema
  GetRecentSessionImpactQuerySchema,
  // Phase E: Product impact schema
  GetProductImpactQuerySchema,
  // Phase F: Health insights schema
  GetInsightsQuerySchema,
} from '@shared/contracts';
import type { MiddlewareFactory } from '../../../core/middleware-factory';
import type { InitializedServices } from '../../../bootstrap';
import { ControllerRegistry } from '../../../core/controller-registry';
import { AppError, ErrorCodes } from '../../../utils/AppError';

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
  registerHealthRoutes();
}

/**
 * Get HealthController from ControllerRegistry with dependency injection
 */
const getHealthController = () => {
  if (!routeServices) {
    throw new Error('Route services not initialized. Call initializeRouteServices() first.');
  }
  return routeServices.controllerRegistry.getController<HealthController>('health');
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

const getSyncLeaseMiddleware = () => {
  if (!routeServices) {
    throw new Error('Route services not initialized');
  }
  return createSyncLeaseMiddleware(
    routeServices.services.syncLeaseService,
    routeServices.services.logger,
    {
      kind: 'health_upload',
      getLeaseId: (req) => (req.body?.leaseId as string | undefined),
    }
  );
};

/**
 * Get device ID middleware that REQUIRES X-Device-ID header.
 *
 * 1. Audit trail: Track which device submitted health data
 * 2. Debugging: Device-specific issues are easier to isolate
 * 3. Consistency: Matches sync routes pattern (sync.routes.ts:861)
 *
 * Mobile clients send X-Device-ID via BackendAPIClient (documented in deviceId.middleware.ts).
 *
 * @returns Express middleware that requires X-Device-ID header (400 if missing/invalid)
 */
const getRequireDeviceId = () => {
  if (!routeServices) {
    throw new Error('Route services not initialized');
  }
  return requireDeviceId(routeServices.services.logger, { useAppError: true });
};

/**
 * Create async middleware for batch upsert request validation WITH payload hash verification.
 *
 * which performs BOTH schema validation AND payload hash verification. This ensures:
 * 1. Request body matches the schema
 * 2. payloadHash actually matches the computed hash of the samples array
 *
 * The hash verification prevents:
 * - Data tampering in transit
 * - Client bugs where samples are modified after hashing
 * - Request-level idempotency key reuse with different payloads
 *
 * @returns Express middleware that validates request and sets validated body
 */
const createBatchUpsertValidationMiddleware = (): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!routeServices) {
      // This ensures error.middleware.ts formats all responses consistently
      // with the standard envelope including requestId
      return next(new AppError(
        500,
        ErrorCodes.INTERNAL_SERVER_ERROR,
        'Route services not initialized',
        false // Not operational - this is a configuration bug
      ));
    }

    const logger = routeServices.services.logger;

    try {
      // validateBatchUpsertRequestWithHash performs:
      // 1. Schema validation (Zod)
      // 2. Config version compatibility check
      const validatedRequest = await validateBatchUpsertRequestWithHash(req.body);

      // Attach validated data to request for controller
      req.body = validatedRequest;

      next();
    } catch (error) {
      // Handle BatchValidationError with specific error codes
      // This ensures error.middleware.ts formats all responses consistently
      // with the standard envelope including requestId for observability
      if (error instanceof BatchValidationError) {
        // Without this, we can't see which field(s) failed validation
        const zodError = error.details as { errors?: Array<{ path: (string | number)[]; message: string; code: string }> } | undefined;
        const errorSummary = zodError?.errors?.slice(0, 5).map(e => ({
          path: e.path.join('.'),
          message: e.message,
          code: e.code,
        })) ?? [];
        const totalErrors = zodError?.errors?.length ?? 0;

        logger.warn('Batch upsert validation failed', {
          context: 'health.routes.batchUpsertValidation',
          errorCode: error.code,
          message: error.message,
          // Log first 5 validation errors for debugging (don't log all 500 samples' errors)
          validationErrors: errorSummary,
          totalValidationErrorCount: totalErrors,
          url: req.url,
          method: req.method,
        });

        // Map error codes to appropriate AppError
        switch (error.code) {
          case BATCH_VALIDATION_ERROR_CODES.SCHEMA_VALIDATION_FAILED:
            // Include human-readable error summary in message for debugging
            // Use optional chaining since TypeScript doesn't track .length > 0 guarantee
            const firstError = errorSummary[0];
            const errorHint = firstError
              ? ` First error at "${firstError.path}": ${firstError.message}`
              : '';
            return next(new AppError(
              400,
              ErrorCodes.VALIDATION_ERROR,
              `Invalid request body.${errorHint}`,
              true, // Operational - client can fix
              { validationDetails: error.details }
            ));

          case BATCH_VALIDATION_ERROR_CODES.PAYLOAD_HASH_MISMATCH:
            return next(new AppError(
              400,
              ErrorCodes.PAYLOAD_HASH_MISMATCH,
              'The payloadHash does not match the computed hash of the samples. ' +
                'Ensure you use computeSamplesPayloadHash() on the client.',
              true, // Operational - client can fix by computing correct hash
              error.details as Record<string, unknown> | undefined
            ));

          case BATCH_VALIDATION_ERROR_CODES.CONFIG_VERSION_TOO_NEW:
            return next(new AppError(
              400,
              ErrorCodes.CONFIG_VERSION_TOO_NEW,
              error.message,
              true, // Operational - client needs to update
              error.details as Record<string, unknown> | undefined
            ));

          default:
            // Unknown BatchValidationError code - treat as generic validation error
            return next(new AppError(
              400,
              ErrorCodes.VALIDATION_ERROR,
              error.message,
              true
            ));
        }
      }

      // Handle other errors - pass to error.middleware.ts
      logger.error('Unexpected error in batch upsert validation', {
        context: 'health.routes.batchUpsertValidation',
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        url: req.url,
        method: req.method,
      });

      // This ensures consistent error envelope with requestId
      return next(new AppError(
        500,
        ErrorCodes.INTERNAL_SERVER_ERROR,
        'Internal validation error',
        false, // Not operational - this is unexpected
        undefined,
        error instanceof Error ? error : undefined
      ));
    }
  };
};

// Query Validation Schemas (UNIFIED FIX)
// This ensures validation is consistent between contract and route layers.
//
// The shared schemas now include:
// - MAX_QUERY_WINDOW_MS (1 year max window)
// - MAX_PAGE_NUMBER (100 max page for offset pagination)
// - Both-or-none startTime/endTime rule
// - startTime <= endTime validation
//
// See: packages/shared/src/contracts/health.contract.ts

// Re-export for local use with clearer names
const GetSamplesQuerySchema = SharedGetSamplesQuerySchema;
const GetSamplesCursorQuerySchema = SharedGetSamplesCursorQuerySchema;

/**
 * Register all health routes after services are initialized
 *
 * ARCHITECTURE:
 * - Middleware handles validation (validateBody/validateQuery with Zod schemas)
 * - Controller is thin: extract params, call service, format response
 * - Handler binding: fetch controller ONCE, bind ONCE to avoid TOCTOU-like issues
 */
function registerHealthRoutes() {
  // Clear any existing routes first
  router.stack.length = 0;

  // DO NOT use getHealthController().method.bind(getHealthController())
  // That pattern fetches controller TWICE, creating potential inconsistency
  const healthController = getHealthController();
  const boundBatchUpsertSamples = healthController.batchUpsertSamples.bind(healthController);
  const boundGetSamples = healthController.getSamples.bind(healthController);
  const boundGetSamplesCursor = healthController.getSamplesCursor.bind(healthController);
  const boundGetMetricCodes = healthController.getMetricCodes.bind(healthController);
  const boundGetRollups = healthController.getRollups.bind(healthController);
  const boundGetSleepSummaries = healthController.getSleepSummaries.bind(healthController);
  const boundGetSessionImpact = healthController.getSessionImpact.bind(healthController);
  const boundGetRecentSessionImpact = healthController.getRecentSessionImpact.bind(healthController);
  const boundGetProductImpact = healthController.getProductImpact.bind(healthController);
  const boundGetInsights = healthController.getInsights.bind(healthController);

  /**
   * @swagger
   * /api/v1/health/samples/batch-upsert:
   *   post:
   *     summary: Batch upsert health samples
   *     description: |
   *       Upload health samples from HealthKit or Health Connect.
   *       Uses two-layer idempotency:
   *       - requestId + payloadHash: Request-level idempotency
   *       - (userId, sourceId, sourceRecordId): Sample-level deduplication
   *     tags: [Health]
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - requestId
   *               - payloadHash
   *               - samples
   *             properties:
   *               requestId:
   *                 type: string
   *                 format: uuid
   *                 description: Unique request ID for idempotency
   *               payloadHash:
   *                 type: string
   *                 pattern: ^[a-f0-9]{64}$
   *                 description: SHA-256 hash of canonicalized samples array
   *               samples:
   *                 type: array
   *                 minItems: 1
   *                 maxItems: 500
   *                 items:
   *                   type: object
   *                   required:
   *                     - sourceId
   *                     - sourceRecordId
   *                     - metricCode
   *                     - startAt
   *                     - endAt
   *                   properties:
   *                     sourceId:
   *                       type: string
   *                       description: Source identifier (healthkit, health_connect, manual)
   *                     sourceRecordId:
   *                       type: string
   *                       description: OS-assigned record ID (opaque)
   *                     metricCode:
   *                       type: string
   *                       description: Metric type code (e.g., heart_rate, steps)
   *                     valueKind:
   *                       type: string
   *                       enum: [SCALAR_NUM, CUMULATIVE_NUM, INTERVAL_NUM, CATEGORY]
   *                       description: Value kind discriminator
   *                     value:
   *                       type: number
   *                       description: Numeric value (for numeric samples)
   *                     unit:
   *                       type: string
   *                       description: Unit of measurement (for numeric samples)
   *                     categoryCode:
   *                       type: string
   *                       description: Category code (for category samples like sleep stages)
   *                     startAt:
   *                       type: string
   *                       format: date-time
   *                       description: Sample start time
   *                     endAt:
   *                       type: string
   *                       format: date-time
   *                       description: Sample end time
   *                     metadata:
   *                       type: object
   *                       description: Optional metadata (device info, etc.)
   *     responses:
   *       200:
   *         description: All samples processed successfully
   *       207:
   *         description: Partial success (some samples failed)
   *       400:
   *         description: Invalid request data
   *       401:
   *         description: Unauthorized
   */
  // validateBatchUpsertRequestWithHash() from shared contracts.
  // This VERIFIES the payloadHash matches the samples (not just schema validation).
  // This is essential for:
  // 1. Idempotency: Ensuring same requestId + payloadHash always means same data
  // 2. Integrity: Detecting tampering or client bugs
  // 3. Security: Preventing replay attacks with modified payloads
  //
  // MIDDLEWARE ORDER (critical for security):
  // 1. Rate limiter (applied at route registry) - prevent DoS before any processing
  // 2. Device ID - audit trail, matches sync.routes.ts pattern
  // 3. Validation - schema + payload hash verification
  // 4. Handler - actual business logic
  router.post(
    '/samples/batch-upsert',
    getRequireDeviceId(),
    createBatchUpsertValidationMiddleware(),
    getSyncLeaseMiddleware(),
    boundBatchUpsertSamples as RequestHandler,
  );

  /**
   * @swagger
   * /api/v1/health/samples:
   *   get:
   *     summary: Get health samples for authenticated user
   *     tags: [Health]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: startTime
   *         schema:
   *           type: string
   *           format: date-time
   *         description: "Range start (default: 24 hours ago)"
   *       - in: query
   *         name: endTime
   *         schema:
   *           type: string
   *           format: date-time
   *         description: "Range end (default: now)"
   *       - in: query
   *         name: metricCode
   *         schema:
   *           type: string
   *         description: Filter by metric type
   *       - in: query
   *         name: page
   *         schema:
   *           type: integer
   *           minimum: 1
   *           default: 1
   *       - in: query
   *         name: pageSize
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 500
   *           default: 100
   *     responses:
   *       200:
   *         description: Health samples retrieved
   *       400:
   *         description: Invalid parameters
   *       401:
   *         description: Unauthorized
   */
  router.get(
    '/samples',
    getValidationMiddleware().validateQuery(GetSamplesQuerySchema),
    boundGetSamples as RequestHandler,
  );

  /**
   * @swagger
   * /api/v1/health/samples/cursor:
   *   get:
   *     summary: Get health samples with cursor-based pagination
   *     description: |
   *       Retrieve health samples using efficient keyset pagination.
   *       This endpoint provides O(log n) performance regardless of page depth,
   *       unlike offset pagination which degrades at scale.
   *
   *       **Cursor Pagination:**
   *       - First request: Omit `cursor` parameter
   *       - Subsequent requests: Pass `nextCursor` from previous response
   *       - Loop until `hasMore` is false
   *
   *       **Performance:**
   *       - No COUNT(*) query (uses limit+1 technique)
   *       - B-tree index traversal regardless of page depth
   *     tags: [Health]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: startTime
   *         required: true
   *         schema:
   *           type: string
   *           format: date-time
   *         description: Start of time range (ISO 8601)
   *       - in: query
   *         name: endTime
   *         required: true
   *         schema:
   *           type: string
   *           format: date-time
   *         description: End of time range (ISO 8601)
   *       - in: query
   *         name: metricCode
   *         required: false
   *         schema:
   *           type: string
   *         description: Filter by metric code
   *       - in: query
   *         name: limit
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 500
   *           default: 100
   *         description: Items per page
   *       - in: query
   *         name: cursor
   *         required: false
   *         schema:
   *           type: string
   *         description: Base64url-encoded cursor from previous page
   *     responses:
   *       200:
   *         description: Samples retrieved successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                   example: true
   *                 data:
   *                   type: object
   *                   properties:
   *                     items:
   *                       type: array
   *                       items:
   *                         type: object
   *                     pagination:
   *                       type: object
   *                       properties:
   *                         limit:
   *                           type: integer
   *                         hasMore:
   *                           type: boolean
   *                         nextCursor:
   *                           type: string
   *                           nullable: true
   *       400:
   *         description: Invalid request (bad cursor, invalid params)
   *       401:
   *         description: Unauthorized
   */
  router.get(
    '/samples/cursor',
    getValidationMiddleware().validateQuery(GetSamplesCursorQuerySchema),
    boundGetSamplesCursor as RequestHandler,
  );

  /**
   * @swagger
   * /api/v1/health/metrics:
   *   get:
   *     summary: Get distinct metric codes for authenticated user
   *     tags: [Health]
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: Metric codes retrieved
   *       401:
   *         description: Unauthorized
   */
  router.get(
    '/metrics',
    boundGetMetricCodes as RequestHandler,
  );

  // Phase 1: Health Projection Read Endpoints

  /**
   * @swagger
   * /api/v1/health/rollups:
   *   get:
   *     summary: Get daily health rollups for a metric
   *     tags: [Health]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: metricCode
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: startDate
   *         required: true
   *         schema:
   *           type: string
   *           format: date
   *       - in: query
   *         name: endDate
   *         required: true
   *         schema:
   *           type: string
   *           format: date
   *     responses:
   *       200:
   *         description: Daily health rollups retrieved
   *       400:
   *         description: Invalid parameters
   *       401:
   *         description: Unauthorized
   */
  router.get(
    '/rollups',
    getValidationMiddleware().validateQuery(GetRollupsQuerySchema),
    boundGetRollups as RequestHandler,
  );

  /**
   * @swagger
   * /api/v1/health/sleep:
   *   get:
   *     summary: Get sleep night summaries
   *     tags: [Health]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: startDate
   *         required: true
   *         schema:
   *           type: string
   *           format: date
   *       - in: query
   *         name: endDate
   *         required: true
   *         schema:
   *           type: string
   *           format: date
   *     responses:
   *       200:
   *         description: Sleep night summaries retrieved
   *       400:
   *         description: Invalid parameters
   *       401:
   *         description: Unauthorized
   */
  router.get(
    '/sleep',
    getValidationMiddleware().validateQuery(GetSleepSummariesQuerySchema),
    boundGetSleepSummaries as RequestHandler,
  );

  /**
   * @swagger
   * /api/v1/health/session-impact/recent:
   *   get:
   *     summary: Get recent session impact summaries for a metric
   *     description: |
   *       Returns recent session impacts enriched with session timestamps
   *       and product context. Only includes COMPLETED sessions.
   *       Ordered by session start time (most recent first).
   *     tags: [Health]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: metricCode
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: limit
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 50
   *           default: 10
   *     responses:
   *       200:
   *         description: Recent session impact summaries retrieved
   *       400:
   *         description: Invalid parameters
   *       401:
   *         description: Unauthorized
   */
  // DEFENSIVE: Register /session-impact/recent BEFORE /session-impact
  // to prevent path shadowing in Express route matching.
  router.get(
    '/session-impact/recent',
    getValidationMiddleware().validateQuery(GetRecentSessionImpactQuerySchema),
    boundGetRecentSessionImpact as RequestHandler,
  );

  /**
   * @swagger
   * /api/v1/health/session-impact:
   *   get:
   *     summary: Get session impact summaries
   *     tags: [Health]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *           format: uuid
   *     responses:
   *       200:
   *         description: Session impact summaries retrieved
   *       400:
   *         description: Invalid parameters
   *       401:
   *         description: Unauthorized
   */
  router.get(
    '/session-impact',
    getValidationMiddleware().validateQuery(GetSessionImpactQuerySchema),
    boundGetSessionImpact as RequestHandler,
  );

  // Phase E: Product Impact Read Endpoint

  /**
   * @swagger
   * /api/v1/health/impact/by-product:
   *   get:
   *     summary: Get product impact rollups for a metric
   *     description: |
   *       Returns per-product health impact aggregates, ranked by impact magnitude.
   *       Answers "Which products affect my heart rate / HRV / sleep most?"
   *
   *       Three modes:
   *       1. **By metric** (default): Single metric, all products ranked by ABS(avgDeltaAfterPct) DESC
   *       2. **By metrics** (multi): Multiple metrics (max 6), per-metric ranking
   *       3. **By product**: Single product detail when `productId` is provided
   *
   *       `metricCode` and `metricCodes` are mutually exclusive — exactly one must be provided.
   *     tags: [Health]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: query
   *         name: metricCode
   *         required: false
   *         schema:
   *           type: string
   *         description: |
   *           Single metric code to query (validated against health-config registry).
   *           Required if `metricCodes` is not provided. Mutually exclusive with `metricCodes`.
   *       - in: query
   *         name: metricCodes
   *         required: false
   *         schema:
   *           type: string
   *         description: |
   *           Comma-separated list of metric codes (max 6).
   *           Required if `metricCode` is not provided. Mutually exclusive with `metricCode`.
   *           Example: `heart_rate_variability,heart_rate,blood_oxygen`
   *       - in: query
   *         name: period
   *         required: false
   *         schema:
   *           type: string
   *           enum: ['7d', '30d', '90d']
   *           default: '90d'
   *         description: Lookback period window. Defaults to 90 days.
   *       - in: query
   *         name: productId
   *         required: false
   *         schema:
   *           type: string
   *           format: uuid
   *         description: Optional single-product detail filter
   *       - in: query
   *         name: minSessions
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           default: 3
   *         description: Minimum session count for inclusion
   *       - in: query
   *         name: limit
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 50
   *           default: 20
   *         description: Maximum number of products to return
   *     responses:
   *       200:
   *         description: Product impact rollups retrieved
   *       400:
   *         description: Invalid parameters (missing metricCode/metricCodes, both provided, invalid period, etc.)
   *       401:
   *         description: Unauthorized
   */
  router.get(
    '/impact/by-product',
    getValidationMiddleware().validateQuery(GetProductImpactQuerySchema),
    boundGetProductImpact as RequestHandler,
  );

  // Phase F: GET /health/insights — deterministic, evidence-based insights

  /**
   * @swagger
   * /api/v1/health/insights:
   *   get:
   *     summary: Get deterministic health insights for a domain
   *     tags: [Health Projections]
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: domain
   *         in: query
   *         required: true
   *         schema:
   *           type: string
   *           enum: [hrv, sleep, respiratory]
   *       - name: startDate
   *         in: query
   *         required: true
   *         schema:
   *           type: string
   *           format: date
   *       - name: endDate
   *         in: query
   *         required: true
   *         schema:
   *           type: string
   *           format: date
   *       - name: limit
   *         in: query
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 20
   *           default: 5
   *     responses:
   *       200:
   *         description: Insights with response summary
   *       400:
   *         description: Invalid parameters
   *       401:
   *         description: Unauthorized
   */
  router.get(
    '/insights',
    getValidationMiddleware().validateQuery(GetInsightsQuerySchema),
    boundGetInsights as RequestHandler,
  );

  // STOP-SHIP #1 FIX: Register health-specific error handler
  // This error handler transforms AppErrors into contract-compliant batch
  // error responses with `retryable` and `retryAfterMs` fields as required
  // by BatchUpsertSamplesErrorResponseSchema.
  //
  // the generic error handler to intercept health-specific errors.
  if (routeServices) {
    router.use(createHealthErrorHandler(routeServices.services.logger));
  }
}

export default router;
