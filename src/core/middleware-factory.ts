/**
 * MiddlewareFactory.ts - Middleware Composition and Creation Module
 * 
 * This module provides factory methods for creating and composing middleware
 * chains based on security levels and functional requirements.
 * 
 * @module middleware-factory
 */

import { RequestHandler, ErrorRequestHandler, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Config } from './types';
import { AuthenticationConfig } from '../types/auth.types';
import type { InitializedServices } from '../bootstrap';

// Import service types for class properties
import { CognitoService } from '../services/cognito.service';
import { RateLimitingQueueService } from '../services/rateLimitingQueue.service';
import { APICacheManager } from '../api/v1/middleware/apiCache.middleware';
import { AuthRateLimitService } from '../services/authRateLimit.service';

// Import middleware modules
import { createAuthenticate, createOptionalAuthenticate } from '../api/v1/middleware/auth.middleware';
import { SecurityLoggerService } from '../services/securityLogger.service';
import { LoggerService } from '../services/logger.service';
import { PerformanceMonitoringService } from '../services/performanceMonitoring.service';
import { createAuthMonitoring, createPostAuthMonitoring } from '../api/v1/middleware/auth-monitoring.middleware';
import { createHTTPSEnforcementMiddleware } from '../api/v1/middleware/httpsEnforcement.middleware';
import { createRequestValidationMiddleware } from '../api/v1/middleware/requestValidation.middleware';
import {
  createRateLimitQueueMiddleware,
} from '../api/v1/middleware/rateLimitQueue.middleware';
import { createCorrelationContextMiddleware } from '../api/v1/middleware/correlationContext.middleware';
// Cache middleware now uses APICacheManager from initialized services
import { createAPIGatewayMiddleware } from '../api/v1/middleware/apiGateway.middleware';
import { createInjectUserContext } from '../api/v1/middleware/userContext.middleware';
import { createUserContextService, UserContextService } from '../services/userContext.service';
import { serverTimeMiddleware } from '../api/v1/middleware/server-time.middleware'; // BACKEND FIX #5
import { 
  createInitializeSecurityContext, 
  createLogRequestCompletion as createLogSecurityRequestCompletion, 
  createLogMalformedRequest, 
  createDetectSuspiciousPatterns, 
} from '../api/v1/middleware/securityLogging.middleware';
import {
  createInitializeRequestLogging,
  createLogRequestCompletion,
  createLogError,
  createLogPerformanceMetrics,
} from '../api/v1/middleware/logging.middleware';
import {
  createRateLimitMonitoring,
  createRateLimitHeaders,
  createRateLimitHealthCheck,
} from '../api/v1/middleware/rate-limit-monitoring.middleware';

export interface RateLimiterConfig {
  windowMs: number;
  maxRequests: number;
  backoffStrategy?: {
    type: 'exponential' | 'linear';
    baseDelay: number;
    maxDelay: number;
    multiplier: number;
    jitter: boolean;
  };
}

export interface MiddlewareStack {
  correlationContext: RequestHandler;
  serverTime: RequestHandler; // BACKEND FIX #5
  apiGateway: RequestHandler;
  requestLogging: RequestHandler;
  securityContext: RequestHandler;
  suspiciousPatterns: RequestHandler;
  requestValidation: RequestHandler;
  userContext: RequestHandler;
  performanceMetrics: RequestHandler;
  requestCompletion: RequestHandler;
  securityCompletion: RequestHandler;
  malformedRequest: ErrorRequestHandler;
  rateLimiting: RequestHandler;
  rateLimitMonitoring: RequestHandler;
  rateLimitHeaders: RequestHandler;
  httpsEnforcement: RequestHandler;
  requestSecurity: RequestHandler;
  securityHeaders: RequestHandler;
  errorLogging: ErrorRequestHandler;
  rateLimitHealthCheck: RequestHandler;
}

/**
 * MiddlewareFactory - Creates and composes middleware chains
 *
 * This class provides factory methods for creating middleware stacks
 * with different security levels and functional requirements.
 *
 *  MODERN DI PATTERN: Pure constructor injection
 * - No singleton getInstance() pattern
 * - Instantiated once in bootstrap.ts (composition root)
 * - Injected as dependency where needed
 */
export class MiddlewareFactory {
  private config?: Config;
  private services?: InitializedServices;

  // Guaranteed-available services (set in initialize(), validated)
  private cognitoService!: CognitoService;
  private performanceMonitoringService!: PerformanceMonitoringService;
  private rateLimitingQueueService!: RateLimitingQueueService;
  private authRateLimitService!: AuthRateLimitService;
  private apiCacheManager!: APICacheManager;

  // Middleware collections
  private rateLimiters?: Map<string, RequestHandler>;
  private apiCacheMiddleware?: RequestHandler;
  private middlewareStack?: MiddlewareStack;
  private userContextService?: UserContextService;

  // Pre-created authentication middleware instances (created once in initialize())
  private authenticate!: RequestHandler;
  private optionalAuthenticate!: RequestHandler;
  private authMonitoring!: RequestHandler;
  private postAuthMonitoring!: RequestHandler;

  /**
   * Constructor with pure dependency injection
   * @param logger - LoggerService instance for structured logging
   * @param performanceMonitoring - PerformanceMonitoringService for metrics
   * @param securityLogger - SecurityLoggerService for security events
   */
  constructor(
    private logger: LoggerService,
    private performanceMonitoring: PerformanceMonitoringService,
    private securityLogger: SecurityLoggerService,
  ) {
    if (!logger || !performanceMonitoring || !securityLogger) {
      throw new Error('MiddlewareFactory: All dependencies (LoggerService, PerformanceMonitoringService, SecurityLoggerService) are required');
    }
    // Dependencies injected via constructor
  }

  /**
   * Initialize the factory with configuration and services
   * Validates all critical services and creates middleware instances once
   */
  public initialize(config: Config, services: InitializedServices): void {
    this.config = config;
    this.services = services;

    if (!services.cognitoService) {
      throw new Error('MiddlewareFactory.initialize: CognitoService is required');
    }
    if (!services.performanceMonitoringService) {
      throw new Error('MiddlewareFactory.initialize: PerformanceMonitoringService is required');
    }
    if (!services.rateLimitingQueueService) {
      throw new Error('MiddlewareFactory.initialize: RateLimitingQueueService is required');
    }
    if (!services.authRateLimitService) {
      throw new Error('MiddlewareFactory.initialize: AuthRateLimitService is required');
    }
    if (!services.apiCacheManager) {
      throw new Error('MiddlewareFactory.initialize: APICacheManager is required');
    }

    //  ASSIGN VALIDATED SERVICES: No more non-null assertions (!) needed
    this.cognitoService = services.cognitoService;
    this.performanceMonitoringService = services.performanceMonitoringService;
    this.rateLimitingQueueService = services.rateLimitingQueueService;
    this.authRateLimitService = services.authRateLimitService;
    this.apiCacheManager = services.apiCacheManager;

    const userRepository = services.repositoryFactory.getUserRepository();
    this.authenticate = createAuthenticate(
      this.cognitoService,
      userRepository,
      this.securityLogger,
      this.logger,
    );

    this.optionalAuthenticate = createOptionalAuthenticate(
      this.cognitoService,
      userRepository,
      this.securityLogger,
      this.logger,
    );

    this.authMonitoring = createAuthMonitoring(
      this.logger,
      this.securityLogger,
      this.authRateLimitService,
    );

    this.postAuthMonitoring = createPostAuthMonitoring(
      this.logger,
      this.securityLogger,
    );

    // Create rate limiters and cache middleware
    this.createRateLimiters();
    this.createCacheMiddleware();
    this.initializeUserContext(config, services);
  }

  /**
   * Initialize user context middleware with services
   * Creates UserContextService instance for dependency injection
   * 
   * ARCHITECTURE FIX: UserContextService no longer requires AuthenticationUtils.
   * Token validation is handled by authenticate middleware, not userContext middleware.
   */
  private initializeUserContext(_config: Config, _services: InitializedServices): void {
    // Create UserContextService instance - no dependencies needed
    // Token validation is handled by authenticate middleware, not this service
    this.userContextService = createUserContextService();
  }

  /**
   * Create all rate limiters based on configuration
   * Uses validated rateLimitingQueueService property (guaranteed non-null after initialize())
   */
  private createRateLimiters(): void {
    if (!this.config) {
      throw new Error('MiddlewareFactory not initialized');
    }

    this.rateLimiters = new Map();

    //  USE VALIDATED SERVICE: No non-null assertions needed
    const rateLimitingService = this.rateLimitingQueueService;

    // Strict rate limiter
    const strictRateLimitMiddleware = createRateLimitQueueMiddleware(rateLimitingService, this.logger);
    this.rateLimiters.set('strict', strictRateLimitMiddleware.createRateLimiter());

    // Standard rate limiter
    const standardRateLimitMiddleware = createRateLimitQueueMiddleware(rateLimitingService, this.logger);
    this.rateLimiters.set('standard', standardRateLimitMiddleware.createRateLimiter());

    // AI rate limiter
    const aiRateLimitMiddleware = createRateLimitQueueMiddleware(rateLimitingService, this.logger);
    this.rateLimiters.set('ai', aiRateLimitMiddleware.createRateLimiter());

    // Auth rate limiter
    const authRateLimitMiddleware = createRateLimitQueueMiddleware(rateLimitingService, this.logger);
    this.rateLimiters.set('auth', authRateLimitMiddleware.createRateLimiter());

    // Sync rate limiter (separate bucket, per user+device keying)
    const syncRateLimitMiddleware = createRateLimitQueueMiddleware(rateLimitingService, this.logger);
    const syncKeyGenerator = (req: Request) => {
      const userId = (req as Request & { user?: { id?: string } }).user?.id;
      const headerDeviceId = req.get('X-Device-ID') || req.get('x-device-id');
      const rawDeviceId = (req as Request & { deviceId?: string }).deviceId || headerDeviceId;
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const deviceId = rawDeviceId && uuidRegex.test(rawDeviceId) ? rawDeviceId : undefined;

      if (userId && deviceId) {
        return `user:${userId}:device:${deviceId}`;
      }

      if (userId) {
        return `user:${userId}`;
      }

      if (deviceId) {
        return `device:${deviceId}`;
      }

      return `ip:${req.ip || 'unknown'}`;
    };
    this.rateLimiters.set('sync', syncRateLimitMiddleware.createRateLimiter({
      bucket: 'sync',
      windowMs: this.config.syncRateLimit.windowMs,
      maxRequests: this.config.syncRateLimit.max,
      keyGenerator: syncKeyGenerator,
    }));
  }

  /**
   * Get a rate limiter by name (internal method)
   */
  private getRateLimiterInternal(name: string): RequestHandler {
    if (!this.rateLimiters?.has(name)) {
      throw new Error(`Rate limiter '${name}' not found. Available: ${Array.from(this.rateLimiters?.keys() || []).join(', ')}`);
    }
    return this.rateLimiters.get(name)!;
  }

  /**
   * Create cache middleware with dependency injection
   * Uses validated APICacheManager property (guaranteed non-null after initialize())
   */
  private createCacheMiddleware(): void {
    if (!this.apiCacheManager) {
      throw new Error('MiddlewareFactory not initialized with apiCacheManager');
    }

    //  USE VALIDATED SERVICE: No non-null assertions needed
    this.apiCacheMiddleware = this.apiCacheManager.createMiddleware({
      ttl: 300, // 5 minutes default
    });
  }

  /**
   * Get all rate limiters
   */
  public getRateLimiters(): Map<string, RequestHandler> {
    if (!this.rateLimiters) {
      throw new Error('Rate limiters not initialized');
    }
    return this.rateLimiters;
  }

  /**
   * Get a specific rate limiter
   */
  public getRateLimiter(type: 'strict' | 'standard' | 'ai' | 'auth' | 'sync'): RequestHandler {
    if (!this.rateLimiters) {
      throw new Error('Rate limiters not initialized');
    }
    const limiter = this.rateLimiters.get(type);
    if (!limiter) {
      throw new Error(`Rate limiter '${type}' not found`);
    }
    return limiter;
  }

  /**
   * Create a complete middleware stack
   * Uses validated services (guaranteed non-null after initialize())
   */
  public createMiddlewareStack(): MiddlewareStack {
    if (!this.config || !this.services) {
      throw new Error('MiddlewareFactory not initialized with config and services');
    }

    //  USE VALIDATED SERVICES: services is guaranteed non-null after initialize()
    const services = this.services;

    // Create HTTPS enforcement middleware once
    const httpsMiddleware = createHTTPSEnforcementMiddleware(services.httpsValidationService, services.logger);

    const rateLimitingMiddleware = this.getRateLimiterInternal('standard');

    const stack: MiddlewareStack = {
      correlationContext: createCorrelationContextMiddleware(services.logger),
      serverTime: serverTimeMiddleware, // BACKEND FIX #5: Add Server-Time header
      apiGateway: createAPIGatewayMiddleware(services.apiGatewayManager),
      requestLogging: createInitializeRequestLogging(services.logger, this.performanceMonitoringService),
      securityContext: createInitializeSecurityContext(this.securityLogger) as RequestHandler,
      suspiciousPatterns: createDetectSuspiciousPatterns(this.securityLogger) as RequestHandler,
      requestValidation: this.createRequestValidationMiddleware(),
      userContext: createInjectUserContext(services.logger, this.userContextService!), // userContextService is optional
      performanceMetrics: createLogPerformanceMetrics(services.logger, this.performanceMonitoringService),
      requestCompletion: createLogRequestCompletion(services.logger, this.performanceMonitoringService),
      securityCompletion: createLogSecurityRequestCompletion(this.securityLogger) as RequestHandler,
      malformedRequest: this.createMalformedRequestHandler(),
      rateLimiting: rateLimitingMiddleware,
      rateLimitMonitoring: this.createRateLimitMonitoringMiddleware(),
      rateLimitHeaders: this.createRateLimitHeadersMiddleware(),
      // Use the single HTTPS enforcement middleware instance
      httpsEnforcement: httpsMiddleware.enforceHTTPS.bind(httpsMiddleware),
      requestSecurity: httpsMiddleware.validateRequestSecurity.bind(httpsMiddleware),
      securityHeaders: httpsMiddleware.addSecurityHeaders.bind(httpsMiddleware),
      errorLogging: createLogError(services.logger, this.performanceMonitoringService) as ErrorRequestHandler,
      rateLimitHealthCheck: this.createRateLimitHealthCheckMiddleware(),
    };

    // Store the stack for later reference
    this.middlewareStack = stack;
    return stack;
  }

  /**
   * Create request validation middleware with dependency injection
   */
  private createRequestValidationMiddleware(): RequestHandler {
    if (!this.services) {
      throw new Error('MiddlewareFactory not initialized with services');
    }

    const requestValidationMiddleware = createRequestValidationMiddleware(
      this.services.requestValidationService,
      this.services.logger,
    );

    return requestValidationMiddleware.sanitizeRequest.bind(requestValidationMiddleware);
  }

  /**
   * Create malformed request handler with dependency injection
   */
  private createMalformedRequestHandler(): ErrorRequestHandler {
    if (!this.services) {
      throw new Error('MiddlewareFactory not initialized with services');
    }

    const logMalformedRequest = createLogMalformedRequest(this.securityLogger);

    // SecurityLoggingRequest extends Request with securityContext
    interface SecurityLoggingRequest extends Request {
      securityContext?: {
        startTime: number;
        ip: string;
        userAgent?: string;
        userId?: string;
      };
    }

    return ((err: Error & { type?: string }, req: Request, res: Response, next: NextFunction) => {
      if (err.type === 'entity.parse.failed') {
        logMalformedRequest(err, req as SecurityLoggingRequest, res, next);
        res.status(400).json({
          success: false,
          error: 'Malformed request body',
        });
        return;
      }
      next(err);
    }) as ErrorRequestHandler;
  }

  /**
   * Create rate limit monitoring middleware with dependency injection
   * Uses validated services (guaranteed non-null after initialize())
   */
  private createRateLimitMonitoringMiddleware(): RequestHandler {
    if (!this.services) {
      throw new Error('MiddlewareFactory not initialized with services');
    }

    //  USE VALIDATED SERVICES: No non-null assertions needed
    return createRateLimitMonitoring(
      this.rateLimitingQueueService,
      this.performanceMonitoringService,
      this.services.logger,
    );
  }

  /**
   * Create rate limit headers middleware with dependency injection
   * Uses validated services (guaranteed non-null after initialize())
   */
  private createRateLimitHeadersMiddleware(): RequestHandler {
    if (!this.services) {
      throw new Error('MiddlewareFactory not initialized with services');
    }

    //  USE VALIDATED SERVICES: No non-null assertions needed
    return createRateLimitHeaders(
      this.rateLimitingQueueService,
      this.services.logger,
    );
  }

  /**
   * Create rate limit health check middleware with dependency injection
   * Uses validated services (guaranteed non-null after initialize())
   */
  private createRateLimitHealthCheckMiddleware(): RequestHandler {
    if (!this.services) {
      throw new Error('MiddlewareFactory not initialized with services');
    }

    //  USE VALIDATED SERVICES: No non-null assertions needed
    return createRateLimitHealthCheck(
      this.rateLimitingQueueService,
      this.services.logger,
    );
  }

  /**
   * Create authentication middleware chain with dependency injection
   *  PERFORMANCE OPTIMIZATION: Reuses pre-created middleware instances instead of recreating them
   */
  public createAuthMiddleware(level: 'public' | 'protected' | 'mixed'): RequestHandler[] {
    if (!this.authenticate || !this.optionalAuthenticate || !this.authMonitoring || !this.postAuthMonitoring) {
      throw new Error('MiddlewareFactory not initialized - authentication middleware not created');
    }

    const middleware: RequestHandler[] = [];

    if (level !== 'public') {
      //  REUSE PRE-CREATED INSTANCE: No recreation overhead
      middleware.push(this.authMonitoring);
    }

    if (level === 'protected') {
      //  REUSE PRE-CREATED INSTANCES: No recreation overhead
      middleware.push(this.authenticate);
      middleware.push(this.postAuthMonitoring);
    } else if (level === 'mixed') {
      // Mixed routes handle auth at route level
      //  REUSE PRE-CREATED INSTANCE: No recreation overhead
      middleware.push(this.optionalAuthenticate);
    }

    return middleware;
  }

  /**
   * Create caching middleware with invalidation keys and dependency injection
   * Uses validated APICacheManager (guaranteed non-null after initialize())
   *
   * **DESIGN NOTE (Problem 2 - Spread Operator Pattern):**
   * This method returns `RequestHandler[]` (an array) by design, not a single RequestHandler.
   * Routes must use the spread operator: `...getCacheMiddleware(['keys'])`
   *
   * **Why an array?**
   * - First element (optional): Cache reading middleware (checks for cached response) - only for GET requests
   * - Second element (optional): Cache invalidation middleware (clears cache on write operations) - for POST/PUT/DELETE
   *
   * **Example usage in routes:**
   * ```typescript
   * router.get('/data', ...getCacheMiddleware(['data'], true)) // Cache response for GET
   * router.post('/data', ...getCacheMiddleware(['data', 'user-data'], false)) // Only invalidate, don't cache response
   * ```
   *
   * - `cacheResponse` parameter controls whether to cache the response (default: true for backward compatibility)
   * - For POST/PUT/DELETE operations, set `cacheResponse: false` to only invalidate cache, not cache the response
   * - This prevents stale cached responses for mutating operations
   *
   * @param invalidationKeys - Optional cache keys to invalidate on successful responses
   * @param cacheResponse - Whether to cache the response (default: true). Set to false for POST/PUT/DELETE operations.
   * @returns Array of middleware handlers [cacheMiddleware?, invalidationMiddleware?]
   */
  public createCachingMiddleware(invalidationKeys?: string[], cacheResponse: boolean = true): RequestHandler[] {
    if (!this.apiCacheMiddleware || !this.apiCacheManager) {
      throw new Error('Cache middleware not initialized');
    }

    const middleware: RequestHandler[] = [];

    // Only add cache middleware if cacheResponse is true (for GET requests)
    if (cacheResponse) {
      middleware.push(this.apiCacheMiddleware);
    }

    // Add invalidation middleware if keys are provided
    if (invalidationKeys && invalidationKeys.length > 0) {
      //  USE VALIDATED SERVICE: No non-null assertions needed
      middleware.push(this.apiCacheManager.createInvalidationMiddleware(invalidationKeys));
    }

    return middleware;
  }

  /**
   * Get cache invalidation middleware with dependency injection
   * Uses validated APICacheManager (guaranteed non-null after initialize())
   */
  public getCacheInvalidationMiddleware(keys: string[]): RequestHandler {
    if (!this.apiCacheManager) {
      throw new Error('MiddlewareFactory not initialized with apiCacheManager');
    }

    //  USE VALIDATED SERVICE: No non-null assertions needed
    return this.apiCacheManager.createInvalidationMiddleware(keys);
  }

  /**
   * Get API cache middleware
   */
  public getApiCacheMiddleware(): RequestHandler {
    if (!this.apiCacheMiddleware) {
      throw new Error('API cache middleware not initialized');
    }
    return this.apiCacheMiddleware;
  }

  /**
   * Create a complete middleware chain for a route
   */
  public createRouteMiddleware(options: {
    security: 'public' | 'protected' | 'mixed';
    rateLimiter: 'strict' | 'standard' | 'ai' | 'auth' | 'sync';
    cache?: {
      enabled: boolean;
      invalidationKeys?: string[];
    };
  }): RequestHandler[] {
    const middleware: RequestHandler[] = [];

    // Add auth middleware
    const authMiddleware = this.createAuthMiddleware(options.security);
    middleware.push(...authMiddleware);

    // Add rate limiting
    middleware.push(this.getRateLimiter(options.rateLimiter));
    middleware.push(this.createRateLimitMonitoringMiddleware());
    middleware.push(this.createRateLimitHeadersMiddleware());

    // Add caching if enabled
    if (options.cache?.enabled) {
      middleware.push(...this.createCachingMiddleware(options.cache.invalidationKeys));
    }

    return middleware;
  }

  /**
   * Get authentication middleware with dependency injection
   *  PERFORMANCE OPTIMIZATION: Returns pre-created middleware instances instead of recreating them
   */
  public getAuthMiddleware(): {
    authenticate: RequestHandler;
    optionalAuthenticate: RequestHandler;
    authMonitoring: RequestHandler;
    postAuthMonitoring: RequestHandler;
  } {
    if (!this.authenticate || !this.optionalAuthenticate || !this.authMonitoring || !this.postAuthMonitoring) {
      throw new Error('MiddlewareFactory not initialized - authentication middleware not created');
    }

    //  RETURN PRE-CREATED INSTANCES: No recreation overhead
    return {
      authenticate: this.authenticate,
      optionalAuthenticate: this.optionalAuthenticate,
      authMonitoring: this.authMonitoring,
      postAuthMonitoring: this.postAuthMonitoring,
    };
  }

  /**
   * Get authentication middleware (required authentication)
   *  PERFORMANCE OPTIMIZATION: Returns pre-created middleware instance instead of recreating it
   */
  public getAuthentication(): RequestHandler {
    if (!this.authenticate) {
      throw new Error('MiddlewareFactory not initialized - authenticate middleware not created');
    }

    //  RETURN PRE-CREATED INSTANCE: No recreation overhead
    return this.authenticate;
  }

  /**
   * Get optional authentication middleware (allows both authenticated and public access)
   *  PERFORMANCE OPTIMIZATION: Returns pre-created middleware instance instead of recreating it
   */
  public getOptionalAuthentication(): RequestHandler {
    if (!this.optionalAuthenticate) {
      throw new Error('MiddlewareFactory not initialized - optionalAuthenticate middleware not created');
    }

    //  RETURN PRE-CREATED INSTANCE: No recreation overhead
    return this.optionalAuthenticate;
  }

  /**
   * Get authorization middleware with role checking
   */
  public getAuthorization(roles: string[]): RequestHandler {
    if (!this.services) {
      throw new Error('MiddlewareFactory not initialized with services');
    }

    return (req: Request, res: Response, next: NextFunction) => {
      // Check if user is authenticated
      if (!req.user) {
        res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
        return;
      }

      // Check if user has required role
      const userRoles = req.user.roles || [];
      const hasRequiredRole = roles.some(role =>
        userRoles.includes(role) ||
        userRoles.includes(role.toLowerCase()) ||
        userRoles.includes(role.toUpperCase()),
      );

      if (!hasRequiredRole) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions',
          requiredRoles: roles,
        });
        return;
      }

      next();
    };
  }

  /**
   * Create validation middleware from Zod schema
   * Centralizes Zod validation pattern to eliminate manual validate() calls in routes
   *
   * @param schema - Zod schema for request validation (body, query, params)
   * @returns RequestHandler that validates request and sends 400 on failure
   *
   * @example
   * // In routes:
   * router.post('/', getValidation(CreateConsumptionSchema), controller.create);
   */
  public createValidation(schema: z.AnyZodObject): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
      try {
        // Parse the entire request object (body, query, params)
        // This allows schemas to validate query parameters for GET requests and body for POST/PUT
        const requestData = {
          body: req.body,
          query: req.query,
          params: req.params,
        };

        const validationResult = schema.safeParse(requestData);

        if (!validationResult.success) {
          res.status(400).json({
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Request validation failed',
              details: validationResult.error.flatten().fieldErrors,
            },
          });
          return;
        }

        // Update request with validated and possibly transformed data
        req.body = validationResult.data.body || req.body;
        req.query = validationResult.data.query || req.query;
        req.params = validationResult.data.params || req.params;

        next();
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.error('Validation middleware error', {
          error: err.message,
          stack: err.stack,
          path: req.path,
        });
        res.status(500).json({
          success: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Validation processing failed',
          },
        });
      }
    };
  }

  /**
   * Get validation middleware for a specific schema
   * Convenience method that returns pre-created validation middleware
   *
   * @param schema - Zod schema for validation
   * @returns RequestHandler for validation
   */
  public getValidation(schema: z.AnyZodObject): RequestHandler {
    return this.createValidation(schema);
  }

}
