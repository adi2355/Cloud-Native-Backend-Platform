/**
 * App.ts - Express Application Configuration Module
 * 
 * This module encapsulates all Express application configuration and middleware setup,
 * following the Single Responsibility Principle. It manages the Express instance,
 * middleware pipeline, and route registration.
 * 
 * @module app
 * @see https://expressjs.com/en/4x/api.html
 */

import express, { Application, RequestHandler, ErrorRequestHandler } from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import swaggerUI from 'swagger-ui-express';
import { ConfigSecurityService } from './services/configSecurity.service';
import { LoggerService } from './services/logger.service';
import { swaggerSpec } from './swagger';
import { createJsonBodyParser } from './api/v1/middleware/jsonBodyParser.middleware';

export interface MiddlewareConfig {
  cors: cors.CorsOptions;
  helmet: Parameters<typeof helmet>[0];
  bodyParser: {
    jsonLimit: string;
    jsonInflatedLimit: string;
    urlencodedLimit: string;
  };
}

export interface RouteConfig {
  path: string;
  middleware: RequestHandler[];
  router: RequestHandler;
}

/**
 * App class - Express application configuration with dependency injection
 *
 *  MODERN DI PATTERN: Pure constructor injection (no singleton)
 * - Instantiated once in bootstrap.ts (composition root)
 * - All dependencies injected via constructor
 * - No internal getInstance() calls for dependencies
 *
 * Responsibilities:
 * - Express application instance management
 * - Middleware configuration and setup
 * - Route registration with proper middleware chains
 * - Security header configuration
 */
export class App {
  private app: Application;
  private initialized: boolean = false;

  /**
   * Constructor with pure dependency injection
   * @param logger - LoggerService for structured logging
   * @param securityConfigService - ConfigSecurityService for secure configuration access
   */
  constructor(
    private logger: LoggerService,
    private securityConfigService: ConfigSecurityService,
  ) {
    if (!logger) {
      throw new Error('App: LoggerService dependency is required');
    }
    if (!securityConfigService) {
      throw new Error('App: ConfigSecurityService dependency is required');
    }

    // Lightweight constructor - only create Express instance
    this.app = express();
  }

  /**
   * Initialize and setup all middleware
   * This method configures the entire middleware pipeline in the correct order
   *
   *  MODERN DI PATTERN: Uses injected securityConfigService instead of config parameter
   */
  public async setupMiddleware(
    middleware: {
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
    },
  ): Promise<void> {
    if (this.initialized) return;

    //  MODERN DI: Get configuration from injected service (no parameter needed)
    const secureConfig = await this.securityConfigService.getSecureConfig();

    //  EXTERNALIZED CONFIG: Security headers from ConfigSecurityService
    const helmetConfig = secureConfig.security.helmet;

    this.app.use(helmet({
      contentSecurityPolicy: helmetConfig.contentSecurityPolicy.enabled ? {
        directives: helmetConfig.contentSecurityPolicy.directives,
      } : false,
      crossOriginEmbedderPolicy: helmetConfig.crossOriginEmbedderPolicy,
      crossOriginOpenerPolicy: helmetConfig.crossOriginOpenerPolicy === 'same-origin' ? { policy: 'same-origin' } :
                               helmetConfig.crossOriginOpenerPolicy === 'same-origin-allow-popups' ? { policy: 'same-origin-allow-popups' } :
                               helmetConfig.crossOriginOpenerPolicy === 'unsafe-none' ? { policy: 'unsafe-none' } : false,
      crossOriginResourcePolicy: helmetConfig.crossOriginResourcePolicy ? { policy: 'cross-origin' } : false,
      hsts: helmetConfig.hsts.enabled ? {
        maxAge: helmetConfig.hsts.maxAge,
        includeSubDomains: helmetConfig.hsts.includeSubDomains,
        preload: helmetConfig.hsts.preload,
      } : false,
      noSniff: helmetConfig.noSniff,
    }));

    //  PERFORMANCE: Enable gzip/brotli compression for responses
    // Reduces payload size by 60-80% for JSON/text responses
    this.app.use(compression({
      level: 6, // Balanced compression level (1-9, higher = more CPU, smaller output)
      threshold: 1024, // Only compress responses > 1KB
      filter: (req, res) => {
        // Don't compress if client doesn't accept it
        if (req.headers['x-no-compression']) {
          return false;
        }
        // Use default filter (compresses text-based content types)
        return compression.filter(req, res);
      },
    }));

    //  MODERN DI: Enhanced CORS configuration from secureConfig
    const allowedOrigins = secureConfig.cors.allowedOrigins;
    const corsConfig = {
      origin: allowedOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type', 
        'Authorization', 
        'X-Requested-With',
        'X-Correlation-ID',
        'X-Request-ID',
        'X-Device-ID',
        'Cache-Control',
        'Pragma',
        'Expires',
        'If-None-Match',
        'Content-Encoding',
        'Accept-Encoding'
      ],
      exposedHeaders: ['X-Correlation-ID', 'Server-Time', 'Retry-After', 'ETag'] // Allow frontend to read these
    };

    //  TYPE SAFETY: Use secureConfig.nodeEnv instead of process.env.NODE_ENV
    if (secureConfig.nodeEnv === 'production') {
      const hasWildcards = allowedOrigins.some((origin: string) =>
        origin.includes('*') || origin === '*',
      );
      if (hasWildcards) {
        throw new Error('CRITICAL SECURITY ISSUE: CORS wildcards detected in production environment.');
      }
    }

    this.app.use(cors(corsConfig));

    // Validate CORS configuration manually
    const corsValidation = {
      isSecure: !allowedOrigins.includes('*'),
      warnings: allowedOrigins.includes('*') ? ['Wildcard CORS origin detected'] : [],
      recommendations: allowedOrigins.includes('*') ? ['Use specific origins instead of wildcards'] : [],
    };
    if (!corsValidation.isSecure || corsValidation.warnings.length > 0) {
      try {
        this.logger.warn('CORS Configuration Warnings', {
          warnings: corsValidation.warnings,
          recommendations: corsValidation.recommendations,
        });
      } catch {
        console.warn('CORS Configuration Warnings:', corsValidation.warnings);
        console.log('CORS Recommendations:', corsValidation.recommendations);
      }
    }

    // HTTPS enforcement and security validation (must be early in middleware chain)
    this.app.use(middleware.httpsEnforcement);
    this.app.use(middleware.requestSecurity);
    this.app.use(middleware.securityHeaders);

    // Initialize correlation context FIRST (before any logging)
    this.app.use(middleware.correlationContext);

    // BACKEND FIX #5: Add Server-Time header for frontend clock offset calculation
    // Must be early in middleware chain to capture server time at request start
    this.app.use(middleware.serverTime);

    // Initialize API Gateway functionality
    this.app.use(middleware.apiGateway);

    // Initialize comprehensive request logging (after correlation context)
    this.app.use(middleware.requestLogging);

    // Initialize security logging context
    this.app.use(middleware.securityContext);

    // Detect suspicious patterns in requests
    this.app.use(middleware.suspiciousPatterns);

    //  EXTERNALIZED CONFIG: Body parsing middleware limits from secureConfig
    this.app.use(createJsonBodyParser({
      jsonLimit: secureConfig.request.bodyParser.jsonLimit,
      inflatedJsonLimit: secureConfig.request.bodyParser.jsonInflatedLimit,
      logger: this.logger,
    }));
    this.app.use(express.urlencoded({ extended: true, limit: secureConfig.request.bodyParser.urlencodedLimit }));

    // Request sanitization (after body parsing)
    this.app.use(middleware.requestValidation);

    // Initialize user context middleware
    this.app.use(middleware.userContext);

    // Log performance metrics
    this.app.use(middleware.performanceMetrics);

    // Log request completion
    this.app.use(middleware.requestCompletion);

    // Log security request completion
    this.app.use(middleware.securityCompletion);

    // Malformed request handler
    this.app.use(middleware.malformedRequest);

    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.status(200).json({ status: 'ok' });
    });

    this.initialized = true;
  }

  /**
   * Register API documentation routes
   */
  public setupDocumentation(): void {
    // API Documentation
    this.app.use('/api-docs', swaggerUI.serve, swaggerUI.setup(swaggerSpec, {
      customCss: '.swagger-ui .topbar { display: none }',
      customSiteTitle: 'AppPlatform API Documentation',
    }));

    // Serve OpenAPI spec
    this.app.get('/api-docs.json', (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.send(swaggerSpec);
    });
  }

  /**
   * Register a single route with its middleware chain
   */
  public registerRoute(config: RouteConfig): void {
    const middleware = [...config.middleware, config.router];
    this.app.use(config.path, ...middleware);
  }

  /**
   * Register multiple routes
   */
  public registerRoutes(configs: RouteConfig[]): void {
    for (const config of configs) {
      this.registerRoute(config);
    }
  }

  /**
   * Setup error handlers - must be called after all routes
   */
  public setupErrorHandlers(
    notFoundHandler: RequestHandler,
    errorLoggingHandler: ErrorRequestHandler,
    errorHandler: ErrorRequestHandler,
  ): void {
    this.app.use(notFoundHandler);
    this.app.use(errorLoggingHandler);
    this.app.use(errorHandler);
  }

  /**
   * Get the Express application instance
   */
  public getExpressApp(): Application {
    return this.app;
  }

  /**
   * Check if the app is initialized
   */
  public isInitialized(): boolean {
    return this.initialized;
  }
}
