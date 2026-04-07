/**
 * Session Controller
 * Handles HTTP requests for consumption sessions
 */

import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../../types/authenticated-request.types';
import { getUserId, getRequestId, getRouteParam } from '../../../utils/auth-guards';
import { SessionService } from '../../../services/session.service';
import { SessionTelemetryService, TelemetryComputeScheduler } from '../../../services/session-telemetry.service';
import { LoggerService } from '../../../services/logger.service';
import { 
  CreateSessionSchema, 
  UpdateSessionSchema, 
} from '../../../models';
import { getErrorMessage, getErrorStack } from '../../../utils/error-handler';
import { AppError, ErrorCodes } from '../../../utils/AppError';
import { z } from 'zod';
import { ListSessionsQuery, SessionStatsQuery, GetSessionQuery, SessionTelemetryQuery } from '../schemas/session.schemas';
import {
  CURRENT_SCHEMA_VERSION,
  CURRENT_COMPUTE_VERSION,
  SESSION_TELEMETRY_DEFAULT_METRICS,
  SESSION_TELEMETRY_SECONDARY_METRICS,
  type HealthMetricCode,
  isHealthMetricCode,
} from '@shared/contracts';

export class SessionController {
  /**
   * Constructor with explicit dependency injection (Pure DI - no singleton)
   * All dependencies are required and injected by bootstrap.ts
   */
  public constructor(
    private sessionService: SessionService,
    private logger: LoggerService,
    private telemetryService?: SessionTelemetryService,
    private telemetryScheduler?: TelemetryComputeScheduler,
  ) {
    // Pure constructor injection - all dependencies provided by bootstrap.ts
    if (!sessionService || !logger) {
      throw new Error('SessionController: All dependencies (SessionService, LoggerService) must be provided');
    }
  }

  /**
   * Start a new consumption session
   * POST /api/v1/sessions
   */
  public async startSession(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const correlationId = req.headers['x-correlation-id'] as string;

      // Validate request body
      const validationResult = CreateSessionSchema.safeParse(req.body);
      
      if (!validationResult.success) {
        throw AppError.validation('Invalid session data', validationResult.error.errors);
      }

      const session = await this.sessionService.createSession(userId, validationResult.data, correlationId);

      res.status(201).json({
        success: true,
        data: session,
        metadata: { requestId: correlationId },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update active session
   * PUT /api/v1/sessions/:id
   */
  public async updateSession(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const correlationId = req.headers['x-correlation-id'] as string;
      const id = getRouteParam(req, 'id');

      // FIX: Use UpdateSessionSchema (not CreateSessionSchema) for PUT endpoint.
      // CreateSessionSchema requires sessionStartTimestamp which isn't needed for updates.
      // UpdateSessionSchema makes all fields optional, matching PUT partial-update semantics.
      const validationResult = UpdateSessionSchema.safeParse(req.body);

      if (!validationResult.success) {
        throw AppError.validation('Invalid session update data', validationResult.error.errors);
      }

      const session = await this.sessionService.patchSession(id, userId, validationResult.data, correlationId);

      res.json({
        success: true,
        data: session,
        metadata: { requestId: correlationId },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Partially update session
   * PATCH /api/v1/sessions/:id
   */
  public async patchSession(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const correlationId = req.headers['x-correlation-id'] as string;
      const id = getRouteParam(req, 'id');

      // Validate request body
      const validationResult = UpdateSessionSchema.safeParse(req.body);
      
      if (!validationResult.success) {
        throw AppError.validation('Invalid session update data', validationResult.error.errors);
      }

      const session = await this.sessionService.patchSession(id, userId, validationResult.data, correlationId);

      res.json({
        success: true,
        data: session,
        metadata: { requestId: correlationId },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * End active session / Complete session
   * POST /api/v1/sessions/:id/end
   * POST /api/v1/sessions/:id/complete
   */
  public async endSession(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const correlationId = req.headers['x-correlation-id'] as string;
      const id = getRouteParam(req, 'id');

      const session = await this.sessionService.completeSession(id, userId, correlationId);

      res.json({
        success: true,
        data: session,
        metadata: { requestId: correlationId },
      });
    } catch (error) {
      next(error);
    }
  }

  // Alias for endSession to support both endpoints
  public completeSession = this.endSession;

  /**
   * Get active session
   * GET /api/v1/sessions/active
   */
  public async getActiveSession(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const correlationId = req.headers['x-correlation-id'] as string;

      const sessions = await this.sessionService.getActiveSessions(userId, correlationId);

      if (!sessions || sessions.length === 0) {
        throw AppError.notFound('Active session');
      }

      // Return the most recent active session
      res.json({
        success: true,
        data: sessions[0],
        metadata: { requestId: correlationId },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * List sessions
   * GET /api/v1/sessions
   */
  public async listSessions(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const correlationId = req.headers['x-correlation-id'] as string;
      
      // Use pre-validated query parameters from middleware
      const validatedQuery = req.query as unknown as ListSessionsQuery;

      const options = {
        page: validatedQuery.page,
        pageSize: validatedQuery.pageSize,
        limit: validatedQuery.limit,
        offset: validatedQuery.offset,
        status: validatedQuery.status,
        startDate: validatedQuery.startDate ? new Date(validatedQuery.startDate) : undefined,
        endDate: validatedQuery.endDate ? new Date(validatedQuery.endDate) : undefined,
        sessionType: validatedQuery.sessionType,
        purchaseId: validatedQuery.purchaseId,
        includeRelations: validatedQuery.includeRelations || !!validatedQuery.include,
        sortBy: validatedQuery.sortBy,
        sortOrder: validatedQuery.sortOrder,
      };

      const result = await this.sessionService.listSessions(userId, options, correlationId);

      res.json({
        success: true,
        data: result.items,
        pagination: {
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
          hasMore: result.hasMore,
          totalPages: result.totalPages,
        },
        metadata: { requestId: correlationId },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get session by ID
   * GET /api/v1/sessions/:id
   */
  public async getSession(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const correlationId = req.headers['x-correlation-id'] as string;
      const id = getRouteParam(req, 'id');
      
      const validatedQuery = req.query as unknown as GetSessionQuery;
      const includeRelations = validatedQuery.includeRelations || !!validatedQuery.include;

      const session = await this.sessionService.getSessionById(id, userId, correlationId, {
        includeRelations,
      });

      if (!session) {
        throw AppError.notFound('Session');
      }

      res.json({
        success: true,
        data: session,
        metadata: { requestId: correlationId },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Delete session
   * DELETE /api/v1/sessions/:id
   */
  public async deleteSession(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const correlationId = req.headers['x-correlation-id'] as string;
      const id = getRouteParam(req, 'id');

      await this.sessionService.deleteSession(id, userId, correlationId);

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }

  // Note: Advanced features like addParticipant and shareSession
  // would need additional implementation in SessionService
  // For now, focusing on core CRUD operations

  /**
   * Pause active session
   * POST /api/v1/sessions/:id/pause
   *
   * State machine: ACTIVE → PAUSED (idempotent if already PAUSED).
   * Returns 409 CONFLICT if session is in a terminal state (COMPLETED, CANCELLED).
   * Uses transactional outbox for durable session.paused domain event.
   */
  public async pauseSession(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const correlationId = req.headers['x-correlation-id'] as string;
      const id = getRouteParam(req, 'id');

      const session = await this.sessionService.pauseSession(id, userId, correlationId);

      res.json({
        success: true,
        data: session,
        metadata: { requestId: correlationId },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Resume paused session
   * POST /api/v1/sessions/:id/resume
   *
   * State machine: PAUSED → ACTIVE (idempotent if already ACTIVE).
   * Returns 409 CONFLICT if session is in a terminal state (COMPLETED, CANCELLED).
   * Uses transactional outbox for durable session.resumed domain event.
   */
  public async resumeSession(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const correlationId = req.headers['x-correlation-id'] as string;
      const id = getRouteParam(req, 'id');

      const session = await this.sessionService.resumeSession(id, userId, correlationId);

      res.json({
        success: true,
        data: session,
        metadata: { requestId: correlationId },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Cancel an active or paused session
   * POST /api/v1/sessions/:id/cancel
   *
   * State machine: ACTIVE/PAUSED → CANCELLED (idempotent if already CANCELLED).
   * Returns 409 CONFLICT if session is COMPLETED (terminal).
   * Uses transactional outbox for durable session.cancelled domain event.
   */
  public async cancelSession(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const correlationId = req.headers['x-correlation-id'] as string;
      const id = getRouteParam(req, 'id');

      const session = await this.sessionService.cancelSession(id, userId, correlationId);

      res.json({
        success: true,
        data: session,
        metadata: { requestId: correlationId },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get session analytics
   * GET /api/v1/sessions/analytics
   */
  public async getSessionAnalytics(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const correlationId = req.headers['x-correlation-id'] as string;
      
      // Use pre-validated query parameters from middleware
      const validatedQuery = req.query as unknown as SessionStatsQuery;

      const options = {
        startDate: validatedQuery.startDate ? new Date(validatedQuery.startDate) : undefined,
        endDate: validatedQuery.endDate ? new Date(validatedQuery.endDate) : undefined,
        period: validatedQuery.period,
        groupBy: validatedQuery.groupBy,
      };

      // Get detailed session statistics for analytics
      const stats = await this.sessionService.getSessionStats(userId, options, correlationId);

      // Enhance stats with additional analytics calculations
      const analytics = {
        ...stats,
        averageSessionDuration: stats.totalDurationMs / Math.max(stats.totalSessions, 1),
        sessionsPerDay: stats.totalSessions / Math.max(this.getDaysBetween(options.startDate, options.endDate), 1),
        peakUsageHour: this.calculatePeakUsageHour(stats as Record<string, unknown>),
        completionRate: stats.totalSessions > 0 ? 100 : 0, // All returned sessions are considered completed
      };

      res.json({
        success: true,
        data: analytics,
        metadata: { requestId: correlationId },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get session statistics
   * GET /api/v1/sessions/stats
   */
  public async getSessionStats(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const correlationId = req.headers['x-correlation-id'] as string;
      
      // Use pre-validated query parameters from middleware
      const validatedQuery = req.query as unknown as SessionStatsQuery;

      const options = {
        startDate: validatedQuery.startDate ? new Date(validatedQuery.startDate) : undefined,
        endDate: validatedQuery.endDate ? new Date(validatedQuery.endDate) : undefined,
        period: validatedQuery.period,
      };

      const stats = await this.sessionService.getSessionStats(userId, options, correlationId);

      res.json({
        success: true,
        data: stats,
        metadata: { requestId: correlationId },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Helper method to calculate days between two dates
   */
  private getDaysBetween(startDate?: Date, endDate?: Date): number {
    if (!startDate || !endDate) {
      // Default to 30 days if no dates provided
      return 30;
    }
    const timeDiff = endDate.getTime() - startDate.getTime();
    return Math.ceil(timeDiff / (1000 * 3600 * 24));
  }

  /**
   * Helper method to calculate peak usage hour from stats
   */
  private calculatePeakUsageHour(stats: {
    totalSessions?: number;
    totalDuration?: number;
    completedSessions?: number;
    [key: string]: unknown;
  }): number {
    // This would need to be implemented based on the actual stats structure
    // For now, return a default value
    return 20; // 8 PM as default peak hour
  }

  /**
   * Get session telemetry (health vitals data for visualization)
   * GET /api/v1/sessions/:id/telemetry
   *
   * Response codes per SESSIONHEALTHKITUI.md:
   * - 200: Telemetry data ready (returns payload) OR no_data state (data:null with state:'no_data')
   * - 202: Telemetry is being computed (client should retry with Retry-After)
   * - 403: Not authorized to access this session
   * - 404: Session not found
   * - 429: Queue saturated (rate limit exceeded)
   * - 500: Query/computation error
   * - 503: Telemetry service unavailable
   *
   * NOTE: no_data returns 200 (not 204) with state:'no_data' because BackendAPIClient.get()
   * throws on empty body, making 204 problematic for JSON API clients.
   */
  public async getSessionTelemetry(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      // Check if telemetry service is available
      // NOTE: Scheduler is no longer required - telemetry is computed inline (2026-01-28)
      if (!this.telemetryService) {
        this.logger.warn('Session telemetry service not available', {
          context: 'SessionController.getSessionTelemetry',
        });
        res.status(503).json({
          success: false,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'Telemetry service is not available',
          },
        });
        return;
      }

      const userId = getUserId(req);
      const correlationId = req.headers['x-correlation-id'] as string;
      const sessionId = getRouteParam(req, 'id');

      // Parse query parameters
      const query = req.query as unknown as SessionTelemetryQuery;
      // based on window duration per SESSIONHEALTHKITUI.md. Defaulting to '1m' would bypass
      // intelligent resolution selection and over-compute for long sessions.
      //
      // METRIC CODES: Parse comma-separated list or 'all' keyword for secondary metrics
      // If omitted, service defaults to SESSION_TELEMETRY_DEFAULT_METRICS
      const metricCodes = query.metricCodes
        ? this.parseMetricCodes(query.metricCodes)
        : undefined;

      const options = {
        windowMinutes: query.windowMinutes ? parseInt(String(query.windowMinutes), 10) : 60,
        resolution: query.resolution as ('1m' | '5m' | undefined),
        metricCodes,
      };

      // Phase 0.4: Parse force parameter for explicit inline recomputation.
      // Handles both pre-validated (boolean from Zod transform) and raw query string cases.
      const force = String(query.force) === 'true';

      // ARCHITECTURAL DECISION (2026-02-04, Phase 0.4): Cache miss returns 202 immediately by default.
      // Inline compute only runs when force=true (explicit user refresh / dev tools).
      // This meets P99 latency budget on the read path without blocking on computation.
      const result = await this.telemetryService.getSessionTelemetry(
        sessionId,
        userId,
        options,
        {
          correlationId,
          force,
        }
      );

      // ALWAYS set version headers for diagnostics/caching (per SESSIONHEALTHKITUI.md)
      res.setHeader('X-Telemetry-Schema-Version', String(result.payload?.schemaVersion ?? CURRENT_SCHEMA_VERSION));
      res.setHeader('X-Telemetry-Compute-Version', String(result.payload?.computeVersion ?? CURRENT_COMPUTE_VERSION));

      // Handle response based on state (explicit state machine per SESSIONHEALTHKITUI.md)
      switch (result.state) {
        case 'ready':
          // 200: Telemetry data ready
          res.json({
            success: true,
            data: result.payload,
            metadata: {
              requestId: correlationId,
              state: 'ready',
              source: result.payload?.source ?? 'api',
              computedAtMs: result.payload?.computedAtMs,
              schemaVersion: result.payload?.schemaVersion,
              computeVersion: result.payload?.computeVersion,
              durationMs: result.durationMs,
            },
          });
          return;

        case 'computing':
          // NOTE: This case can still occur briefly during race conditions:
          // 1. Two requests arrive simultaneously for the same uncached session
          // 2. First request acquires lock and starts computing (~100-500ms)
          // 3. Second request sees COMPUTING lock that's fresh (not stale)
          // 4. Second request returns 'computing' state (client retries after ~2s)
          //
          // Stale locks (>5 min) are automatically recovered inline via tryAcquireComputeLock().
          // This means clients will only see 'computing' for fresh in-flight computations.
          // 202: Still computing - client should retry
          res.setHeader('Retry-After', String(result.retryAfterSeconds ?? 2));  // Retry quickly - in-flight compute is fast
          res.status(202).json({
            success: true,
            data: null,
            metadata: {
              requestId: correlationId,
              state: 'computing',
              retryAfterSeconds: result.retryAfterSeconds ?? 5,
              message: 'Telemetry is being computed. Please retry.',
            },
          });
          return;

        case 'no_data':
          // 200 with state:no_data (NOT 204, because BackendAPIClient.get() throws on empty body)
          // Computation succeeded but no health data exists for this session
          res.json({
            success: true,
            data: null,
            metadata: {
              requestId: correlationId,
              state: 'no_data',
              message: 'No health telemetry data available for this session.',
            },
          });
          return;

        case 'stale':
          // P0-G.1: Stale data available but needs recomputation
          // Currently, stale caches trigger inline recomputation (returns 'ready').
          // This case is reserved for future use when we may want to return
          // stale data immediately while recomputing in background.
          // For now, treat same as 'computing' - ask client to retry.
          res.setHeader('Retry-After', String(result.retryAfterSeconds ?? 2));
          res.status(200).json({
            success: true,
            data: result.payload, // Return stale data if available
            metadata: {
              requestId: correlationId,
              state: 'stale',
              retryAfterSeconds: result.retryAfterSeconds ?? 5,
              message: 'Telemetry data is stale. Recomputation triggered. Refresh for updated data.',
              computedAtMs: result.payload?.computedAtMs,
              schemaVersion: result.payload?.schemaVersion,
              computeVersion: result.payload?.computeVersion,
            },
          });
          return;

        case 'failed':
          // P0-G.1: Infrastructure failure (e.g., watermark DB unavailable)
          // Return last-known data with explicit 'failed' state so frontend
          // can show degraded badge + retry. NOT a 500 — data IS available,
          // freshness is unknown.
          res.setHeader('Retry-After', String(result.retryAfterSeconds ?? 5));
          res.status(200).json({
            success: true,
            data: result.payload, // Last-known cached data (may be stale)
            metadata: {
              requestId: correlationId,
              state: 'failed',
              retryAfterSeconds: result.retryAfterSeconds ?? 5,
              errorCode: result.errorCode ?? 'INFRASTRUCTURE_FAILURE',
              message: result.errorMessage ?? 'Data freshness unknown due to infrastructure issue.',
              computedAtMs: result.payload?.computedAtMs,
              schemaVersion: result.payload?.schemaVersion,
              computeVersion: result.payload?.computeVersion,
            },
          });
          return;

        case 'error':
          // Handle specific error sources
          if (result.errorSource === 'authorization') {
            res.status(403).json({
              success: false,
              error: {
                code: 'FORBIDDEN',
                message: result.errorMessage ?? 'Not authorized to access this session',
              },
              metadata: { requestId: correlationId },
            });
            return;
          }

          // Check for not found in error message
          if (result.errorMessage?.includes('not found')) {
            res.status(404).json({
              success: false,
              error: {
                code: 'NOT_FOUND',
                message: result.errorMessage,
              },
              metadata: { requestId: correlationId },
            });
            return;
          }

          // Generic error
          res.status(500).json({
            success: false,
            error: {
              code: 'INTERNAL_ERROR',
              message: result.errorMessage ?? 'Failed to fetch telemetry',
              source: result.errorSource,
            },
            metadata: { requestId: correlationId, durationMs: result.durationMs },
          });
          return;

        default: {
          // Exhaustiveness check: compile error if new state added to service but not handled
          const _exhaustive: never = result.state;
          this.logger.error('Unexpected telemetry result state', {
            context: 'SessionController.getSessionTelemetry',
            sessionId,
            state: _exhaustive,
          });
          res.status(500).json({
            success: false,
            error: {
              code: 'INTERNAL_ERROR',
              message: `Unexpected telemetry state: ${String(_exhaustive)}`,
            },
            metadata: { requestId: correlationId },
          });
          return;
        }
      }
    } catch (error) {
      // Log and pass to error handler
      // NOTE: 429 queue saturation handling removed - inline compute doesn't use queue (2026-01-28)
      this.logger.error('Unexpected error in getSessionTelemetry', {
        context: 'SessionController.getSessionTelemetry',
        error: error instanceof Error
          ? { name: error.name, message: error.message }
          : String(error),
      });
      next(error);
    }
  }

  /**
   * Parse metricCodes query parameter into validated metric code array.
   *
   * Supports:
   * - 'all' keyword: returns combined DEFAULT + SECONDARY metrics
   * - Comma-separated list: e.g., 'heart_rate,blood_oxygen'
   * - Uses isHealthMetricCode for type-safe validation
   *
   * @param metricCodesParam - Raw query parameter value
   * @returns Parsed and validated HealthMetricCode array
   */
  private parseMetricCodes(metricCodesParam: string): readonly HealthMetricCode[] {
    // Handle 'all' keyword - return combined DEFAULT + SECONDARY metrics
    if (metricCodesParam.trim().toLowerCase() === 'all') {
      return [
        ...SESSION_TELEMETRY_DEFAULT_METRICS,
        ...SESSION_TELEMETRY_SECONDARY_METRICS,
      ] as readonly HealthMetricCode[];
    }

    // Parse comma-separated list and validate each metric using type guard
    const requestedMetrics = metricCodesParam
      .split(',')
      .map(code => code.trim().toLowerCase())
      .filter((code): code is HealthMetricCode => isHealthMetricCode(code));

    // If no valid metrics found, fall back to defaults
    if (requestedMetrics.length === 0) {
      this.logger.warn('No valid metrics in metricCodes param, falling back to defaults', {
        context: 'SessionController.parseMetricCodes',
        requested: metricCodesParam,
      });
      return [...SESSION_TELEMETRY_DEFAULT_METRICS] as readonly HealthMetricCode[];
    }

    return requestedMetrics;
  }
}
