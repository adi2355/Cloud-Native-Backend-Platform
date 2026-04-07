/**
 * RouteRegistry.ts - Centralized Route Configuration Module
 *
 * This module manages all API route registration with proper security levels,
 * rate limiting, caching strategies, and middleware chains. It provides a
 * centralized location for route configuration.
 *
 * ARCHITECTURE COMPLIANCE:
 *  Pure constructor injection (no singleton getInstance())
 *  Zero 'any' type violations (ESLint: @typescript-eslint/no-explicit-any)
 *  Proper error handling with 'unknown' type in catch blocks
 *  Instantiated once in bootstrap.ts (composition root pattern)
 *
 * @module route-registry
 */

import { Application, RequestHandler } from 'express';
import { MiddlewareFactory } from './middleware-factory';
import type { InitializedServices } from '../bootstrap';
import { LoggerService } from '../services/logger.service';
import { ControllerRegistry } from './controller-registry';

// NOTE: Route imports redacted for public portfolio. Only kept routes shown.
// Full production version registers 25+ route modules here.
import authRoutes from '../api/v1/routes/auth.routes';
import userRoutes from '../api/v1/routes/user.routes';
import securityRoutes from '../api/v1/routes/security.routes';
import loggingRoutes from '../api/v1/routes/logging.routes';
import monitoringRoutes from '../api/v1/routes/monitoring.routes';
import performanceRoutes from '../api/v1/routes/performance.routes';
import telemetryRoutes from '../api/v1/routes/telemetry.routes';
import websocketRoutes from '../api/v1/routes/websocket.routes';
import sessionRoutes from '../api/v1/routes/session.routes';
import syncRoutes from '../api/v1/routes/sync.routes';
import deviceRoutes from '../api/v1/routes/device.routes';
import healthRoutes from '../api/v1/routes/health.routes';

export type SecurityLevel = 'public' | 'protected' | 'mixed';

export interface RouteDefinition {
  path: string;
  router: RequestHandler;
  security: SecurityLevel;
  rateLimiter: 'strict' | 'standard' | 'ai' | 'auth' | 'sync';
  cache?: {
    enabled: boolean;
    invalidationKeys?: string[];
  };
  description?: string;
}

export interface RateLimiters {
  strict: RequestHandler;
  standard: RequestHandler;
  ai: RequestHandler;
  auth: RequestHandler;
  sync: RequestHandler;
}

export interface Middleware {
  authMonitoring: RequestHandler;
  authenticate: RequestHandler;
  postAuthMonitoring: RequestHandler;
  apiCacheMiddleware: RequestHandler;
  cacheInvalidationMiddleware: (keys: string[]) => RequestHandler;
  rateLimitHealthCheck: RequestHandler;
}

// Interface for route services (new pattern)
export interface RouteServices {
  middlewareFactory: MiddlewareFactory;
  controllerRegistry: ControllerRegistry;
  services: InitializedServices;
}

/**
 * RouteRegistry - Manages all route configurations and registration
 *
 * This class centralizes route definitions, their security levels,
 * rate limiting strategies, and caching configurations.
 *
 *  MODERN DI PATTERN: Pure constructor injection
 * - No singleton getInstance() pattern
 * - Instantiated once in bootstrap.ts (composition root)
 * - Injected as dependency where needed
 */
export class RouteRegistry {
  private routes: RouteDefinition[] = [];

  /**
   * Constructor with pure dependency injection
   * @param logger - LoggerService instance for structured logging
   */
  constructor(private logger: LoggerService) {
    if (!logger) {
      throw new Error('RouteRegistry: LoggerService dependency is required');
    }
    this.initializeRoutes();
  }

  /**
   * Initialize all route definitions
   *
   * DESIGN DECISION: Centralized route definitions vs. dynamic discovery
   * - Current: Routes explicitly defined in this method (manageable for medium-large apps)
   * - Alternative: Dynamic route discovery by scanning directory (overkill for current scale)
   * - Trade-off: Explicit definitions provide better IDE support and compile-time safety
   *
   * For very large applications (100+ routes), consider:
   * 1. Route modules with auto-discovery pattern
   * 2. Convention-based routing (e.g., file-system routing)
   * 3. Modular route registration per domain
   */
  private initializeRoutes(): void {
    this.routes = [
      // AI routes
      {
        path: '/api/v1/ai',
        router: aiRoutes,
        security: 'protected',
        rateLimiter: 'ai',
        cache: { enabled: false }, // No caching for AI responses
        description: 'AI processing endpoints',
      },
      {
        path: '/api/v1/ai/admin',
        router: aiAdministrationRoutes,
        security: 'protected', // Admin-only endpoints
        rateLimiter: 'strict',
        cache: { enabled: true, invalidationKeys: ['ai-admin'] },
        description: 'AI administration and management endpoints',
      },
      {
        path: '/api/v1/ai/analysis',
        router: aiAnalysisRoutes,
        security: 'protected',
        rateLimiter: 'ai',
        cache: { enabled: false }, // No caching for AI analysis
        description: 'AI analysis endpoints (journal, product recommendations, weekly reports)',
      },
      {
        path: '/api/v1/ai/cache',
        router: aiCacheRoutes,
        security: 'protected',
        rateLimiter: 'standard',
        cache: { enabled: true, invalidationKeys: ['ai-cache'] },
        description: 'AI response cache management',
      },
      {
        path: '/api/v1/ai/chat',
        router: aiChatRoutes,
        security: 'protected',
        rateLimiter: 'ai',
        cache: { enabled: false }, // No caching for chat
        description: 'AI chat thread and message endpoints',
      },
      {
        path: '/api/v1/ai/usage',
        router: aiUsageRoutes,
        security: 'protected',
        rateLimiter: 'standard',
        cache: { enabled: true }, // Cacheable for analytics
        description: 'AI usage tracking and reporting',
      },

      // Authentication routes
      {
        path: '/api/v1/auth',
        router: authRoutes,
        security: 'public',
        rateLimiter: 'auth',
        cache: { enabled: false }, // No caching for auth
        description: 'Authentication endpoints',
      },

      // User routes
      {
        path: '/api/v1/users',
        router: userRoutes,
        security: 'protected',
        rateLimiter: 'standard',
        cache: {
          enabled: true,
          invalidationKeys: ['user-data', 'user-profile'],
        },
        description: 'User management endpoints',
      },

      // Security monitoring routes
      {
        path: '/api/v1/security',
        router: securityRoutes,
        security: 'protected',
        rateLimiter: 'strict',
        cache: { enabled: false }, // No caching for security
        description: 'Security monitoring endpoints',
      },

      // Logging routes
      {
        path: '/api/v1/logging',
        router: loggingRoutes,
        security: 'protected',
        rateLimiter: 'strict',
        cache: { enabled: false },
        description: 'Logging management endpoints',
      },

      // Monitoring routes
      {
        path: '/api/v1/monitoring',
        router: monitoringRoutes,
        security: 'protected',
        rateLimiter: 'strict',
        cache: { enabled: false },
        description: 'System monitoring endpoints',
      },

      // Performance monitoring
      {
        path: '/api/v1/performance',
        router: performanceRoutes,
        security: 'protected',
        rateLimiter: 'strict',
        cache: { enabled: true },
        description: 'Performance monitoring endpoints',
      },

      // Core application routes
      // Cache middleware is applied at ROUTE level (consumption.routes.ts) with fine-grained
      // invalidation tags per endpoint. Applying cache at BOTH levels causes:
      // 1. Two different cache keys (due to CorrelationContext timing)
      // 2. Path mismatch in getCacheConfig (req.path is router-relative, not full path)
      // 3. Stale cache not invalidated because tag sets are empty
      // See: STALE_CACHE_ROOT_CAUSE_ANALYSIS.md for full investigation.
      {
        path: '/api/v1/consumptions',
        router: consumptionRoutes,
        security: 'protected',
        rateLimiter: 'standard',
        cache: { enabled: false }, // Route-level caching handles this with proper tags
        description: 'Consumption tracking endpoints',
      },

      // Products (has public search)
      {
        path: '/api/v1/products',
        router: productRoutes,
        security: 'mixed',
        rateLimiter: 'standard',
        cache: {
          enabled: true,
          invalidationKeys: ['products'],
        },
        description: 'Product management endpoints',
      },

      // Inventory
      {
        path: '/api/v1/inventory',
        router: inventoryRoutes,
        security: 'protected',
        rateLimiter: 'standard',
        cache: {
          enabled: true,
          invalidationKeys: ['inventory', 'products'],
        },
        description: 'Inventory management endpoints',
      },

      // Analytics
      // Analytics data depends on DailyStat aggregates which are updated when consumptions are created.
      // The route-level cache in consumption.routes.ts invalidates with tags ['consumptions', 'user-stats', 'analytics'],
      // but if analytics cache was stored without proper tags (due to path mismatch bug), it can't be invalidated.
      // Disabling RouteRegistry-level caching ensures fresh data after consumption mutations.
      {
        path: '/api/v1/analytics',
        router: analyticsRoutes,
        security: 'protected',
        rateLimiter: 'standard',
        cache: { enabled: false }, // Disable - relies on database aggregates that update with consumptions
        description: 'Analytics endpoints',
      },

      // Sessions
      // Same issue as consumption routes - double caching causes stale data.
      {
        path: '/api/v1/sessions',
        router: sessionRoutes,
        security: 'protected',
        rateLimiter: 'standard',
        cache: { enabled: false }, // Route-level caching handles this with proper tags
        description: 'Session management endpoints',
      },

      // Sync
      {
        path: '/api/v1/sync',
        router: syncRoutes,
        security: 'protected',
        rateLimiter: 'sync',
        cache: { enabled: false }, // No caching for sync operations
        description: 'Data synchronization endpoints',
      },

      // Device management
      {
        path: '/api/v1/devices',
        router: deviceRoutes,
        security: 'protected',
        rateLimiter: 'standard',
        cache: {
          enabled: true,
          invalidationKeys: ['devices', 'device-telemetry'],
        },
        description: 'Device management endpoints',
      },

      // Device Telemetry
      {
        path: '/api/v1/telemetry',
        router: telemetryRoutes,
        security: 'protected',
        rateLimiter: 'standard',
        cache: { enabled: false }, // No cache for ingestion
        description: 'Device telemetry endpoints',
      },

      // WebSocket management
      {
        path: '/api/v1/websocket',
        router: websocketRoutes,
        security: 'protected',
        rateLimiter: 'strict',
        cache: { enabled: false },
        description: 'WebSocket management endpoints',
      },

      // Journal entries
      {
        path: '/api/v1/journal',
        router: journalRoutes,
        security: 'protected',
        rateLimiter: 'standard',
        cache: {
          enabled: true,
          invalidationKeys: ['journal-data'],
        },
        description: 'Journal entries endpoints',
      },

      // Purchases
      {
        path: '/api/v1/purchases',
        router: purchaseRoutes,
        security: 'protected',
        rateLimiter: 'standard',
        cache: {
          enabled: true,
          invalidationKeys: ['purchase-data'],
        },
        description: 'Purchase management endpoints',
      },

      // Goals
      {
        path: '/api/v1/goals',
        router: goalsRoutes,
        security: 'protected',
        rateLimiter: 'standard',
        cache: {
          enabled: true,
          invalidationKeys: ['goals', 'achievements', 'user-goals'],
        },
        description: 'Goals management endpoints',
      },

      // Achievements (has public endpoints)
      {
        path: '/api/v1/achievements',
        router: achievementsRoutes,
        security: 'mixed',
        rateLimiter: 'standard',
        cache: {
          enabled: true,
          invalidationKeys: ['achievements', 'user-achievements'],
        },
        description: 'Achievements endpoints',
      },

      // API Gateway management (public health checks)
      {
        path: '/api/v1/gateway',
        router: gatewayRoutes,
        security: 'public',
        rateLimiter: 'strict',
        cache: { enabled: false },
        description: 'API Gateway management endpoints',
      },

      // Storage management
      {
        path: '/api/v1/storage',
        router: storageRoutes,
        security: 'protected',
        rateLimiter: 'strict',
        cache: { enabled: false },
        description: 'Storage management endpoints',
      },

      // User Profiling (ML/AI-powered consumption and routine analysis)
      {
        path: '/api/v1/user-profiling',
        router: userProfilingRoutes,
        security: 'protected',
        rateLimiter: 'ai',
        cache: {
          enabled: true,
          invalidationKeys: ['user-profiling', 'consumption-profile', 'routine-profile', 'inventory-prediction'],
        },
        description: 'User profiling, consumption learning, and inventory prediction endpoints',
      },

      // Safety (Risk assessment and anomaly detection)
      {
        path: '/api/v1/safety',
        router: safetyRoutes,
        security: 'protected',
        rateLimiter: 'standard',
        cache: {
          enabled: true,
          invalidationKeys: ['safety', 'safety-records', 'user-data'],
        },
        description: 'Safety record management, risk assessment, and anomaly detection endpoints',
      },

      // Health (HealthKit/Health Connect data ingestion)
      {
        path: '/api/v1/health',
        router: healthRoutes,
        security: 'protected',
        rateLimiter: 'sync',  // Sync-specific limits for HealthKit/Health Connect ingestion
        cache: { enabled: false },  // No cache for write-heavy operations
        description: 'Health data ingestion from HealthKit/Health Connect',
      },
    ];
  }

  /**
   * Register all routes with the Express application
   * Updated to support both legacy and new MiddlewareFactory patterns
   */
  public registerAllRoutes(
    app: Application,
    rateLimiters: RateLimiters,
    middleware: Middleware
  ): void;
  public registerAllRoutes(
    app: Application,
    middlewareFactory: MiddlewareFactory,
    services: InitializedServices
  ): Promise<void>;
  public registerAllRoutes(
    app: Application,
    rateLimitersOrFactory: RateLimiters | MiddlewareFactory,
    middlewareOrServices: Middleware | InitializedServices,
  ): Promise<void> | void {
    try {
      // Use injected logger: this.logger
      this.logger.info('Registering API routes...');
    } catch {
      console.log('Registering API routes...'); // Fallback for early init
    }

    // Determine if we're using the new pattern or legacy pattern
    const isNewPattern = rateLimitersOrFactory instanceof MiddlewareFactory;

    if (isNewPattern) {
      const middlewareFactory = rateLimitersOrFactory as MiddlewareFactory;
      const services = middlewareOrServices as InitializedServices;

      return (async () => {
        // Initialize route services for each route module
        await this.initializeRouteServices(middlewareFactory, services);

        // Special handling for rate limit health check
        const authMiddleware = middlewareFactory.getAuthMiddleware();
        app.get('/health/rate-limit', authMiddleware.authMonitoring);

        // Special handling for storage health check (public)
        app.use('/health/storage', storageRoutes);

        // Register each route with middleware from MiddlewareFactory
        for (const routeDef of this.routes) {
          const middlewareChain = middlewareFactory.createRouteMiddleware({
            security: routeDef.security,
            rateLimiter: routeDef.rateLimiter,
            cache: routeDef.cache,
          });

          app.use(routeDef.path, ...middlewareChain, routeDef.router);

          try {
            // Use injected logger: this.logger
            this.logger.info(`Route registered: ${routeDef.path}`, {
              path: routeDef.path,
              description: routeDef.description || 'Registered',
              pattern: 'MiddlewareFactory',
            });
          } catch {
            console.log(`   ${routeDef.path} - ${routeDef.description || 'Registered'} (MiddlewareFactory)`);
          }
        }
      })();
    } else {
      // Legacy pattern
      const rateLimiters = rateLimitersOrFactory as RateLimiters;
      const middleware = middlewareOrServices as Middleware;

      // Special handling for rate limit health check
      app.get('/health/rate-limit', middleware.rateLimitHealthCheck);

      // Special handling for storage health check (public)
      app.use('/health/storage', storageRoutes);

      // Register each route with its middleware chain
      for (const routeDef of this.routes) {
        const middlewareChain = this.buildMiddlewareChain(
          routeDef,
          rateLimiters,
          middleware,
        );

        app.use(routeDef.path, ...middlewareChain, routeDef.router);

        try {
          // Use injected logger: this.logger
          this.logger.info(`Route registered: ${routeDef.path}`, {
            path: routeDef.path,
            description: routeDef.description || 'Registered',
            pattern: 'Legacy',
          });
        } catch {
          console.log(`   ${routeDef.path} - ${routeDef.description || 'Registered'} (Legacy)`);
        }
      }
    }
  }

  /**
   * Initialize route services for each route module
   */
  private async initializeRouteServices(middlewareFactory: MiddlewareFactory, services: InitializedServices): Promise<void> {
    const routeServices: RouteServices = {
      middlewareFactory,
      controllerRegistry: services.controllerRegistry,
      services,
    };

    // Initialize services for ALL route modules that support the new pattern
    try {
      const routeModules = [
        'user.routes', 'auth.routes', 'achievements.routes', 'analytics.routes',
        'ai.routes', 'ai-administration.routes', 'ai-analysis.routes', 'ai-cache.routes', 'ai-chat.routes', 'aiUsage.routes',
        'consumption.routes', 'device.routes', 'goals.routes', 'inventory.routes', 'journal.routes', 'product.routes',
        'purchase.routes', 'session.routes', 'sync.routes', 'telemetry.routes',
        'websocket.routes', 'monitoring.routes', 'security.routes', 'performance.routes',
        'storage.routes', 'logging.routes', 'gateway.routes', 'user-profiling.routes', 'safety.routes', 'health.routes',
      ];

      const initializationPromises = routeModules.map(async (routeModule) => {
        try {
          const module = await import(`../api/v1/routes/${routeModule}`);
          if (module.initializeRouteServices) {
            module.initializeRouteServices(routeServices);
            try {
              // Use injected logger: this.logger
              this.logger.info('Route module initialized', {
                module: routeModule,
                pattern: 'MiddlewareFactory',
              });
            } catch {
              console.log(`   ${routeModule} initialized with MiddlewareFactory`);
            }
            return { success: true, module: routeModule };
          } else {
            try {
              // Use injected logger: this.logger
              this.logger.warn('Route module missing initializeRouteServices export', {
                module: routeModule,
              });
            } catch {
              console.warn(`   ${routeModule} does not export initializeRouteServices`);
            }
            return { success: false, module: routeModule, reason: 'No initializeRouteServices export' };
          }
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          try {
            // Include module name in message for clear visibility in logs
            this.logger.warn(`Route module '${routeModule}' initialization failed: ${errorMessage}`, {
              module: routeModule,
              error: errorMessage,
              stack: error instanceof Error ? error.stack : undefined,
            });
          } catch {
            console.warn(`   ${routeModule} initialization failed:`, errorMessage);
          }
          return { success: false, module: routeModule, reason: errorMessage };
        }
      });

      // Wait for all initializations to complete
      const results = await Promise.all(initializationPromises);
      const successful = results.filter(r => r.success).length;
      const total = results.length;
      
      try {
        // Use injected logger: this.logger
        this.logger.info('Route services initialization complete', {
          successful,
          total,
          pattern: 'MiddlewareFactory',
        });
      } catch {
        console.log(`Route services initialization complete: ${successful}/${total} routes successfully initialized with MiddlewareFactory`);
      }
      
      if (successful < total) {
        const failed = results.filter(r => !r.success);
        const failedModulesList = failed.map(f => f.module).join(', ');
        try {
          // Include failed modules in message for clear visibility
          this.logger.warn(`Route initialization incomplete: ${failed.length} module(s) failed [${failedModulesList}]`, {
            failedCount: failed.length,
            failedModules: failedModulesList,
            failedRoutes: failed.map(f => ({ module: f.module, reason: f.reason })),
          });
        } catch {
          console.log('Failed routes:', failed.map(f => `${f.module}: ${f.reason}`).join(', '));
        }
      }
    } catch (error) {
      try {
        // Use injected logger: this.logger
        this.logger.error('Error initializing route services:', {
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        console.error('Error initializing route services:', error);
      }
    }
  }

  /**
   * Build middleware chain for a route based on its configuration
   */
  private buildMiddlewareChain(
    routeDef: RouteDefinition,
    rateLimiters: RateLimiters,
    middleware: Middleware,
  ): RequestHandler[] {
    const chain: RequestHandler[] = [];

    // Add auth monitoring for non-public routes
    if (routeDef.security !== 'public') {
      chain.push(middleware.authMonitoring);
    }

    // Add rate limiting
    chain.push(rateLimiters[routeDef.rateLimiter]);

    // Add authentication for protected routes
    if (routeDef.security === 'protected') {
      chain.push(middleware.authenticate);
      chain.push(middleware.postAuthMonitoring);
    }
    // Mixed routes handle auth at route level

    // Add caching if enabled
    if (routeDef.cache?.enabled) {
      chain.push(middleware.apiCacheMiddleware);
      
      if (routeDef.cache.invalidationKeys) {
        chain.push(middleware.cacheInvalidationMiddleware(routeDef.cache.invalidationKeys));
      }
    }

    return chain;
  }

  /**
   * Get all route definitions
   */
  public getRoutes(): RouteDefinition[] {
    return [...this.routes];
  }

  /**
   * Find a route by path
   */
  public findRoute(path: string): RouteDefinition | undefined {
    return this.routes.find(route => route.path === path);
  }
}
