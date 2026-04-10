/**
 * API Gateway Caching Middleware
 * Provides intelligent response caching with automatic invalidation
 * 
 * @module apiCache.middleware
 * @description Implements gateway-level caching for API responses with support for
 * conditional requests, cache invalidation, and performance optimization.
 */

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { CacheService } from '../../../services/cache.service';
import { LoggerService } from '../../../services/logger.service';
import { PerformanceMonitoringService, PerformanceMetricType } from '../../../services/performanceMonitoring.service';
import { getCurrentCorrelationId, CorrelationContextManager } from './correlationContext.middleware';
import { getErrorMessage, getErrorStack } from '../../../utils/error-handler';

/**
 * Cache configuration for different endpoint patterns
 */
export interface CacheConfig {
  ttl: number; // Time to live in seconds
  tags?: string[]; // Cache tags for group invalidation
  varyBy?: string[]; // Headers to vary cache by
  invalidateOn?: string[]; // HTTP methods that invalidate this cache
  condition?: (req: Request, res: Response) => boolean; // Condition to cache
  keyGenerator?: (req: Request) => string; // Custom key generator
  compress?: boolean; // Whether to compress cached data
}

/**
 * Cache middleware options
 */
export interface CacheMiddlewareOptions {
  enabled?: boolean;
  defaultTTL?: number;
  maxCacheSize?: number;
  enableConditionalRequests?: boolean;
  enableCompression?: boolean;
  excludeHeaders?: string[];
  includeQueryParams?: boolean;
  cacheMethods?: string[];
}

/**
 * Cached response structure
 * 
 * This allows us to detect if a cache entry was created from a request
 * that started BEFORE a subsequent invalidation occurred.
 */
interface CachedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  etag: string;
  lastModified: string;
  timestamp: number;
  correlationId?: string;
  userId?: string;
  /**
   * When the original request that created this cache entry started.
   * Used to detect race conditions where invalidation runs BEFORE cache storage completes.
   */
  requestStartTime: number;
}

/**
 * API Cache Manager
 * Handles caching logic for API responses
 */
export class APICacheManager {
  private cacheConfigs: Map<RegExp, CacheConfig> = new Map();
  private defaultOptions: Required<CacheMiddlewareOptions>;

  /**
   * Fast timeout for cache GET on the critical request path.
   * If Redis can't respond within this time, treat as cache miss and proceed to DB.
   * This prevents slow Redis from adding seconds of latency to every API request.
   *
   * 500ms is generous for a single Redis GET (typical: 1-5ms local, 10-50ms cloud).
   * If Redis can't respond in 500ms, it's degraded and we're better off hitting DB.
   */
  private static readonly CACHE_CRITICAL_PATH_TIMEOUT_MS = 500;

  //  SECURITY: Adaptive Throttling for Cache-Busted Requests
  private static readonly CACHE_BUST_THROTTLE_WINDOW_MS = 60_000; // 1 minute
  private static readonly CACHE_BUST_THROTTLE_MAX_REQUESTS = 10; // Max 10 cache-busts per minute per user

  constructor(
    private cache: CacheService,
    private logger: LoggerService,
    private performanceMonitoring: PerformanceMonitoringService,
    options: CacheMiddlewareOptions = {},
  ) {
    this.defaultOptions = {
      enabled: true,
      defaultTTL: 300, // 5 minutes
      maxCacheSize: 100 * 1024 * 1024, // 100MB
      enableConditionalRequests: true,
      enableCompression: false,
      excludeHeaders: ['authorization', 'cookie', 'set-cookie'],
      includeQueryParams: true,
      cacheMethods: ['GET', 'HEAD'],
      ...options,
    };

    this.initializeDefaultConfigs();
  }

  /**
   * Initialize default cache configurations for common endpoints
   */
  private initializeDefaultConfigs(): void {
    //  FIX: Consumption endpoints - cache for 1 minute, invalidate on mutations
    this.registerCacheConfig(/^\/api\/v1\/consumptions/, {
      ttl: 60,
      tags: ['consumptions', 'user-data', 'user-stats'], // Multi-tag for broad invalidation
      varyBy: ['authorization'],
      invalidateOn: ['POST', 'PUT', 'DELETE'],
    });

    //  FIX: User stats endpoints - cache for 2 minutes
    this.registerCacheConfig(/^\/api\/v1\/users\/me\/stats/, {
      ttl: 120,
      tags: ['user-stats', 'user-data'],
      varyBy: ['authorization'],
      invalidateOn: ['POST', 'PUT', 'DELETE'],
    });

    //  FIX: Achievement endpoints - cache for 5 minutes
    this.registerCacheConfig(/^\/api\/v1\/achievements/, {
      ttl: 300,
      tags: ['achievements', 'user-data'],
      varyBy: ['authorization'],
      invalidateOn: ['POST'],
    });

    // Analytics endpoints - cache for 5 minutes
    // cache is invalidated when new consumptions are created
    this.registerCacheConfig(/^\/api\/v1\/analytics/, {
      ttl: 300,
      tags: ['analytics', 'consumptions', 'user-stats'],
      varyBy: ['authorization'],
      invalidateOn: ['POST', 'PUT', 'DELETE'],
    });

    // Product listings - cache for 10 minutes
    this.registerCacheConfig(/^\/api\/v1\/products$/, {
      ttl: 600,
      tags: ['products'],
      varyBy: ['accept-language'],
      invalidateOn: ['POST'],
    });

    // User profile - cache for 2 minutes
    this.registerCacheConfig(/^\/api\/v1\/users\/me$/, {
      ttl: 120,
      tags: ['user-profile'],
      varyBy: ['authorization'],
      invalidateOn: ['PUT', 'PATCH'],
    });

    // Session data - cache for 1 minute
    this.registerCacheConfig(/^\/api\/v1\/sessions/, {
      ttl: 60,
      tags: ['sessions', 'user-data'], // Also user-data for broad invalidation
      varyBy: ['authorization'],
      invalidateOn: ['POST', 'PUT', 'DELETE'],
    });

    // Static configuration - cache for 1 hour
    this.registerCacheConfig(/^\/api\/v1\/config/, {
      ttl: 3600,
      tags: ['config'],
      varyBy: ['accept-language'],
    });
  }

  /**
   * Register cache configuration for endpoint pattern
   */
  public registerCacheConfig(pattern: RegExp, config: CacheConfig): void {
    this.cacheConfigs.set(pattern, config);
  }

  /**
   * Get cache configuration for request
   *
   * correct pattern matching. When middleware runs after Express router mounting
   * (e.g., at /api/v1/consumptions), req.path is router-relative (/stats) while
   * req.originalUrl retains the full path (/api/v1/consumptions/stats).
   *
   * Cache config patterns are designed for full paths, so we must use originalUrl.
   */
  private getCacheConfig(req: Request): CacheConfig | null {
    // req.path = '/stats' (after mounting at /api/v1/consumptions)
    // req.originalUrl = '/api/v1/consumptions/stats' (full URL path)
    const path = req.originalUrl || req.path;

    for (const [pattern, config] of this.cacheConfigs) {
      if (pattern.test(path)) {
        return config;
      }
    }

    // Default configuration for GET requests
    if (this.defaultOptions.cacheMethods.includes(req.method)) {
      return {
        ttl: this.defaultOptions.defaultTTL,
        varyBy: ['authorization'],
      };
    }

    return null;
  }

  /**
   * Generate cache key for request
   *
   * When middleware runs at different levels (RouteRegistry vs route-level),
   * req.path varies (router-relative) but req.originalUrl is consistent.
   * This ensures the same request always generates the same cache key.
   */
  public generateCacheKey(req: Request, config?: CacheConfig): string {
    // Use custom key generator if provided
    if (config?.keyGenerator) {
      return config.keyGenerator(req);
    }

    // Extract path without query string (query params are handled separately below)
    const fullPath = req.originalUrl || req.path;
    const pathParts = fullPath.split('?');
    const pathWithoutQuery = pathParts[0] ?? fullPath;

    const parts: string[] = [
      'api-cache',
      req.method,
      pathWithoutQuery,
    ];

    // Include query parameters
    if (this.defaultOptions.includeQueryParams && Object.keys(req.query).length > 0) {
      const sortedQuery = Object.keys(req.query)
        .sort()
        .map(key => `${key}=${req.query[key]}`)
        .join('&');
      parts.push(sortedQuery);
    }

    // Include vary headers
    if (config?.varyBy) {
      config.varyBy.forEach(header => {
        const value = req.get(header);
        if (value) {
          parts.push(`${header}:${value}`);
        }
      });
    }

    // Include user ID for personalized caches
    const context = CorrelationContextManager.getCurrentContext();
    if (context?.userId) {
      parts.push(`user:${context.userId}`);
    }

    // Generate hash from parts
    const keyString = parts.join(':');
    const hash = crypto.createHash('sha256').update(keyString).digest('hex');
    
    return `${parts[0]}:${parts[1]}:${hash.substring(0, 16)}`;
  }

  /**
   * Generate ETag for response
   */
  private generateETag(data: unknown): string {
    const content = typeof data === 'string' ? data : JSON.stringify(data);
    return `"${crypto.createHash('md5').update(content).digest('hex')}"`;
  }

  /**
   *  SECURITY: Check if user has exceeded cache-bust throttle limit
   * Tracks cache-busted requests per user to prevent DDoS via spam
   * @returns true if user is throttled (should serve cached data), false otherwise
   */
  private async checkCacheBustThrottle(userId: string): Promise<boolean> {
    try {
      const throttleKey = `cache-bust-throttle:${userId}`;
      const currentCount = await this.cache.increment(throttleKey, 1);

      // Set TTL on first increment
      if (currentCount === 1) {
        await this.setTTL(throttleKey, Math.floor(APICacheManager.CACHE_BUST_THROTTLE_WINDOW_MS / 1000));
      }

      const isThrottled = (currentCount ?? 0) > APICacheManager.CACHE_BUST_THROTTLE_MAX_REQUESTS;

      if (isThrottled) {
        this.logger.warn('Cache-bust throttle triggered - forcing cached response', {
          userId,
          requestCount: currentCount,
          windowMs: APICacheManager.CACHE_BUST_THROTTLE_WINDOW_MS,
          maxRequests: APICacheManager.CACHE_BUST_THROTTLE_MAX_REQUESTS,
        });
      }

      return isThrottled;
    } catch (error: unknown) {
      // Fail open - if throttle check fails, allow cache-busting
      this.logger.error('Cache-bust throttle check failed', {
        userId,
        error: getErrorMessage(error),
      });
      return false;
    }
  }

  /**
   *  SECURITY: Set TTL on existing cache key
   * Helper for cache-bust throttle mechanism
   */
  private async setTTL(key: string, ttl: number): Promise<void> {
    try {
      await this.cache.expire(key, ttl);
    } catch (error: unknown) {
      this.logger.error('Failed to set TTL for throttle key', {
        key,
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Check if request has valid conditional headers
   */
  private checkConditionalHeaders(req: Request, cached: CachedResponse): boolean {
    // Check If-None-Match (ETag)
    const ifNoneMatch = req.get('If-None-Match');
    if (ifNoneMatch && ifNoneMatch === cached.etag) {
      return true;
    }

    // Check If-Modified-Since
    const ifModifiedSince = req.get('If-Modified-Since');
    if (ifModifiedSince) {
      const modifiedSinceTime = new Date(ifModifiedSince).getTime();
      const lastModifiedTime = new Date(cached.lastModified).getTime();
      if (modifiedSinceTime >= lastModifiedTime) {
        return true;
      }
    }

    return false;
  }

  /**
   * Serve cached response
   */
  private serveCachedResponse(req: Request, res: Response, cached: CachedResponse, isNotModified: boolean): void {
    const correlationId = getCurrentCorrelationId();
    
    if (isNotModified) {
      // Send 304 Not Modified
      res.status(304);
      res.set('ETag', cached.etag);
      res.set('Last-Modified', cached.lastModified);
      res.set('X-Cache', 'HIT-304');
      res.set('X-Cache-Key', 'hidden'); // Don't expose cache key
      res.end();
      
      this.logger.debug('Cache hit - 304 Not Modified', {
        correlationId,
        etag: cached.etag,
      });
    } else {
      // Send full cached response
      res.status(cached.statusCode);
      
      // Set cached headers (excluding sensitive ones)
      Object.entries(cached.headers).forEach(([key, value]) => {
        if (!this.defaultOptions.excludeHeaders.includes(key.toLowerCase())) {
          res.set(key, value);
        }
      });
      
      // Set cache metadata headers
      res.set('ETag', cached.etag);
      res.set('Last-Modified', cached.lastModified);
      res.set('X-Cache', 'HIT');
      res.set('X-Cache-Age', String(Math.floor((Date.now() - cached.timestamp) / 1000)));
      res.set('X-Cache-Correlation-ID', cached.correlationId || '');
      
      // Send cached body
      res.send(cached.body);
      
      this.logger.debug('Cache hit - full response', {
        correlationId,
        statusCode: cached.statusCode,
        cacheAge: Date.now() - cached.timestamp,
      });
    }

    // Record cache hit metric
    this.performanceMonitoring.recordMetric(
      PerformanceMetricType.CACHE_HIT_RATE,
      'api_cache_hit',
      1,
      'count',
      {
        endpoint: req.path,
        method: req.method,
        status: isNotModified ? '304' : String(cached.statusCode),
      },
      { correlationId },
    );
  }

  /**
   * Cache response
   * NOTE: This method runs asynchronously AFTER the response has been sent.
   * Do NOT attempt to set response headers here - they must be set BEFORE sending.
   * 
   * Before storing cache, we check if any relevant tags were invalidated AFTER
   * the original request started. If so, we skip caching to prevent storing stale data.
   */
  private async cacheResponse(
    req: Request,
    res: Response,
    body: unknown,
    config: CacheConfig,
    cacheKey: string,
    etag: string,
    lastModified: string,
    requestStartTime: number,
  ): Promise<void> {
    const correlationId = getCurrentCorrelationId();
    const context = CorrelationContextManager.getCurrentContext();

    try {
      // This prevents storing stale data when a mutation happens during cache population
      if (config.tags && config.tags.length > 0) {
        const wasInvalidated = await this.cache.wasInvalidatedAfter(config.tags, requestStartTime);
        if (wasInvalidated) {
          this.logger.info('Skipping cache storage - data invalidated after request started', {
            correlationId,
            cacheKey: `${cacheKey.substring(0, 20)}...`,
            tags: config.tags,
            requestStartTime,
            reason: 'RACE_CONDITION_PREVENTION',
          });
          return; // Don't cache stale data
        }
      }

      // Filter headers to avoid serialization issues with circular references
      const rawHeaders = res.getHeaders() as Record<string, unknown>;
      const safeHeaders: Record<string, string> = {};

      for (const [key, value] of Object.entries(rawHeaders)) {
        // Only include headers that can be safely serialized
        if (!this.defaultOptions.excludeHeaders.includes(key.toLowerCase())) {
          if (typeof value === 'string') {
            safeHeaders[key] = value;
          } else if (typeof value === 'number') {
            safeHeaders[key] = String(value);
          } else if (Array.isArray(value)) {
            safeHeaders[key] = value.join(', ');
          }
          // Skip functions, objects, and other non-serializable types
        }
      }

      const cachedResponse: CachedResponse = {
        statusCode: res.statusCode,
        headers: safeHeaders,
        body,
        etag,
        lastModified,
        timestamp: Date.now(),
        correlationId,
        userId: context?.userId,
        requestStartTime,
      };

      // Set cache with TTL and tags
      const cacheStored = await this.cache.set(cacheKey, cachedResponse, {
        ttl: config.ttl,
        tags: config.tags,
        compress: config.compress || this.defaultOptions.enableCompression,
      });

      if (!cacheStored) {
        this.logger.warn('Cache storage skipped or failed (non-fatal)', {
          correlationId,
          cacheKey: `${cacheKey.substring(0, 20)}...`,
          ttl: config.ttl,
          tags: config.tags,
          endpoint: req.path,
          method: req.method,
          reason: 'CACHE_SET_RETURNED_FALSE',
        });
        return;
      }

      this.logger.debug('Response cached successfully', {
        correlationId,
        cacheKey: `${cacheKey.substring(0, 20)}...`,
        ttl: config.ttl,
        tags: config.tags,
        bodySize: typeof body === 'string' ? body.length : JSON.stringify(body).length,
        requestStartTime,
      });

      // Record cache set metric
      this.performanceMonitoring.recordMetric(
        PerformanceMetricType.CACHE_SET,
        'api_cache_set',
        1,
        'count',
        {
          endpoint: req.path,
          method: req.method,
          ttl: String(config.ttl),
        },
        { correlationId },
      );
    } catch (error: unknown) {
      // Log error but don't throw - cache failures should not break requests
      this.logger.warn('Cache storage failed (non-fatal)', {
        correlationId,
        error: getErrorMessage(error),
        cacheKey: `${cacheKey.substring(0, 20)}...`,
        endpoint: req.path,
        method: req.method,
      });
    }
  }

  /**
   * Invalidate cache by tags
   *
   * @param tags - Cache tags to invalidate
   * @param options - Optional configuration
   * @param options.skipTimestampUpdate - If true, skips setting invalidation timestamps.
   *   Use this when timestamps have already been set (e.g., by createInvalidationMiddleware).
   */
  public async invalidateCacheByTags(
    tags: string[],
    options?: { skipTimestampUpdate?: boolean }
  ): Promise<number> {
    const correlationId = getCurrentCorrelationId();

    try {
      const count = await this.cache.invalidateByTags(tags, options);

      this.logger.info('Cache invalidated by tags', {
        correlationId,
        tags,
        count,
        skipTimestampUpdate: options?.skipTimestampUpdate ?? false,
      });

      return count;
    } catch (error) {
      this.logger.error('Failed to invalidate cache by tags', {
        correlationId,
        tags,
        error: (error as Error).message,
      });
      return 0;
    }
  }

  /**
   * Invalidate cache by pattern
   */
  public async invalidateCacheByPattern(pattern: string): Promise<number> {
    const correlationId = getCurrentCorrelationId();
    
    try {
      const count = await this.cache.invalidate(`api-cache:*${pattern}*`);
      
      this.logger.info('Cache invalidated by pattern', {
        correlationId,
        pattern,
        count,
      });
      
      return count;
    } catch (error) {
      this.logger.error('Failed to invalidate cache by pattern', {
        correlationId,
        pattern,
        error: (error as Error).message,
      });
      return 0;
    }
  }

  /**
   * Create cache invalidation middleware
   * Compatible with MiddlewareFactory's factory pattern
   * 
   * This ensures that any concurrent cache storage operations (from GET requests
   * that started before this mutation) will see the timestamp and skip caching.
   * 
   * Flow:
   * 1. Mutation request arrives
   * 2. IMMEDIATELY set invalidation timestamps (before controller runs)
   * 3. Controller processes mutation
   * 4. On success, trigger async cache cleanup
   * 
   * This prevents the race condition where:
   * - GET starts at T=0, triggers async cache storage
   * - POST arrives at T=50, sets invalidation timestamp immediately
   * - POST completes at T=100
   * - GET's cacheResponse() runs at T=150, sees timestamp > T=0, skips caching
   */
  public createInvalidationMiddleware(
    patterns: string[] | ((req: Request) => string[]),
  ): (req: Request, res: Response, next: NextFunction) => Promise<void> {
    return async (req: Request, res: Response, next: NextFunction) => {
      // Only invalidate on mutations
      if (req.method === 'GET' || req.method === 'HEAD') {
        return next();
      }

      const correlationId = getCurrentCorrelationId();
      const self = this;
      const tags = typeof patterns === 'function' ? patterns(req) : patterns;

      // This MUST happen BEFORE the controller runs to prevent race conditions
      try {
        await self.cache.setInvalidationTimestamps(tags);
        
        self.logger.debug('Invalidation timestamps set at mutation start', {
          tags,
          method: req.method,
          path: req.path,
          correlationId,
          timestamp: Date.now(),
        });
      } catch (error) {
        // Log but don't fail the request - this is a safety mechanism
        self.logger.error('Failed to set invalidation timestamps at mutation start', {
          error: (error as Error).message,
          tags,
          correlationId,
        });
      }

      const originalJson = res.json.bind(res);
      const originalSend = res.send.bind(res);

      /**
       * Cleanup: Actually delete cached entries (runs async after response)
       * This is safe because timestamps are already set, so any new GET requests
       * will see fresh data.
       *
       * PERFORMANCE FIX: Pass skipTimestampUpdate: true since timestamps were already
       * set at request start (line 612). This prevents duplicate Redis writes.
       */
      const cleanupCachedEntries = () => {
        // Only cleanup on successful mutations
        if (res.statusCode >= 200 && res.statusCode < 300) {
          // Fire-and-forget: Safe because timestamps are already set
          (async () => {
            try {
              for (const tag of tags) {
                // Skip timestamp update - already done at request start (line 612)
                await self.invalidateCacheByTags([tag], { skipTimestampUpdate: true });
                self.logger.debug('Cache entries cleaned up', {
                  tag,
                  method: req.method,
                  path: req.path,
                  correlationId,
                });
              }
            } catch (error) {
              self.logger.error('Cache cleanup failed (non-critical, timestamps already set)', {
                error: (error as Error).message,
                tags,
                correlationId,
              });
            }
          })();
        }
      };

      // Override res.json to trigger async cleanup after response
      res.json = function(data: unknown) {
        // Trigger async cleanup (fire-and-forget, timestamps already set)
        cleanupCachedEntries();
        return originalJson(data);
      };

      // Override res.send to trigger async cleanup after response
      res.send = function(data: unknown) {
        // Trigger async cleanup (fire-and-forget, timestamps already set)
        cleanupCachedEntries();
        return originalSend(data);
      };

      next();
    };
  }

  /**
   * Create cache middleware
   * 
   * - On cache MISS: Record when request started, pass to cacheResponse()
   * - On cache HIT: Validate cache isn't stale (invalidated after cache was created)
   */
  public createMiddleware(overrideConfig?: Partial<CacheConfig>) {
    return async (req: Request, res: Response, next: NextFunction) => {
      const requestStartTime = Date.now();

      // Skip if caching is disabled or cache service is not ready
      if (!this.defaultOptions.enabled || !this.cache.isReady()) {
        return next();
      }

      // Get cache configuration
      const baseConfig = this.getCacheConfig(req);
      if (!baseConfig) {
        return next();
      }
      
      const config: CacheConfig = overrideConfig ? 
        { ...baseConfig, ...overrideConfig } : 
        baseConfig;

      // Check if request method should be cached
      if (!this.defaultOptions.cacheMethods.includes(req.method)) {
        return next();
      }

      //  FIX: Check for cache-busting headers (pull-to-refresh support)
      const cacheControl = req.get('Cache-Control');
      const pragma = req.get('Pragma');
      const clientRequestedBust =
        cacheControl?.includes('no-cache') ||
        cacheControl?.includes('no-store') ||
        pragma === 'no-cache';

      //  SECURITY: Adaptive Throttling - Check if user has exceeded cache-bust limit
      const context = CorrelationContextManager.getCurrentContext();
      let bustCache = clientRequestedBust;

      if (clientRequestedBust && context?.userId) {
        const isThrottled = await this.checkCacheBustThrottle(context.userId);
        if (isThrottled) {
          // Force serve cached data even though client requested no-cache
          bustCache = false;
          res.setHeader('X-Cache-Throttled', 'true'); // Inform client they're throttled
          this.logger.warn('Cache-bust request throttled - serving cached response', {
            correlationId: getCurrentCorrelationId(),
            userId: context.userId,
            path: req.path,
          });
        }
      }

      if (bustCache) {
        this.logger.debug('Cache bypassed due to client request', {
          correlationId: getCurrentCorrelationId(),
          path: req.path,
          cacheControl,
          pragma,
        });
        return next(); // Skip cache, proceed to controller for fresh data
      }

      // Check custom condition
      if (config.condition && !config.condition(req, res)) {
        return next();
      }

      const correlationId = getCurrentCorrelationId();
      const cacheKey = this.generateCacheKey(req, config);

      try {
        // Try to get cached response with fast timeout protection.
        // If Redis is degraded, this returns null after 500ms instead of blocking
        // for the full commandTimeout (2s). The request proceeds to DB immediately.
        const cached = await this.cache.getWithFastTimeout<CachedResponse>(
          cacheKey,
          APICacheManager.CACHE_CRITICAL_PATH_TIMEOUT_MS,
        );

        if (cached) {
          // Check if any tag was invalidated AFTER this cache entry was created
          if (config.tags && config.tags.length > 0) {
            // Treat it as stale and regenerate to ensure we have the new tracking field
            if (!cached.requestStartTime) {
              this.logger.info('Cache hit rejected - entry missing requestStartTime (old format)', {
                correlationId,
                cacheKey: `${cacheKey.substring(0, 20)}...`,
                tags: config.tags,
                reason: 'MISSING_REQUEST_START_TIME',
              });
              
              // Delete old format cache entry
              await this.cache.delete(cacheKey);
              
              // Fall through to cache miss handling below
            } else {
              const wasInvalidated = await this.cache.wasInvalidatedAfter(
                config.tags,
                cached.requestStartTime,
              );
              
              if (wasInvalidated) {
                this.logger.info('Cache hit rejected - entry is stale due to subsequent invalidation', {
                  correlationId,
                  cacheKey: `${cacheKey.substring(0, 20)}...`,
                  tags: config.tags,
                  cachedRequestStartTime: cached.requestStartTime,
                  reason: 'STALE_CACHE_ENTRY',
                });
                
                // Delete stale cache entry
                await this.cache.delete(cacheKey);
                
                // Fall through to cache miss handling below
              } else {
                // Cache is valid - serve it
                if (this.defaultOptions.enableConditionalRequests) {
                  const isNotModified = this.checkConditionalHeaders(req, cached);
                  this.serveCachedResponse(req, res, cached, isNotModified);
                  return;
                } else {
                  this.serveCachedResponse(req, res, cached, false);
                  return;
                }
              }
            }
          } else {
            // No tags configured - serve cached response without staleness check
            // This is safe for endpoints that don't depend on other data
            if (this.defaultOptions.enableConditionalRequests) {
              const isNotModified = this.checkConditionalHeaders(req, cached);
              this.serveCachedResponse(req, res, cached, isNotModified);
              return;
            } else {
              this.serveCachedResponse(req, res, cached, false);
              return;
            }
          }
        }

        // Cache miss (or stale cache deleted above) - intercept response to cache it
        const originalSend = res.send;
        const originalJson = res.json;
        const self = this;

        // Guard flag to prevent duplicate caching if both send() and json() are called
        let cacheTriggered = false;

        // Wrap res.send to cache successful responses
        res.send = function(body: unknown) {
          // Only cache successful responses (once per request)
          if (res.statusCode >= 200 && res.statusCode < 300 && !cacheTriggered) {
            cacheTriggered = true;

            // Generate cache metadata BEFORE sending response
            const etag = self.generateETag(body);
            const lastModified = new Date().toUTCString();

            // Set cache-related headers BEFORE sending response
            res.set('ETag', etag);
            res.set('Last-Modified', lastModified);
            res.set('X-Cache', 'MISS');
            res.set('Cache-Control', `private, max-age=${config.ttl}`);

            // Trigger async cache storage (does NOT block response)
            void self.cacheResponse(req, res, body, config, cacheKey, etag, lastModified, requestStartTime);
          }

          // Send response immediately (don't wait for cache)
          return originalSend.call(this, body);
        };

        // Wrap res.json to cache successful responses
        res.json = function(body: unknown) {
          // Only cache successful responses (once per request)
          if (res.statusCode >= 200 && res.statusCode < 300 && !cacheTriggered) {
            cacheTriggered = true;

            // Generate cache metadata BEFORE sending response
            const etag = self.generateETag(body);
            const lastModified = new Date().toUTCString();

            // Set cache-related headers BEFORE sending response
            res.set('ETag', etag);
            res.set('Last-Modified', lastModified);
            res.set('X-Cache', 'MISS');
            res.set('Cache-Control', `private, max-age=${config.ttl}`);

            // Trigger async cache storage (does NOT block response)
            void self.cacheResponse(req, res, body, config, cacheKey, etag, lastModified, requestStartTime);
          }

          // Send response immediately (don't wait for cache)
          return originalJson.call(this, body);
        };

        // Record cache miss metric
        this.performanceMonitoring.recordMetric(
          PerformanceMetricType.CACHE_MISS,
          'api_cache_miss',
          1,
          'count',
          {
            endpoint: req.path,
            method: req.method,
          },
          { correlationId },
        );

        next();
      } catch (error) {
        this.logger.error('Cache middleware error', {
          correlationId,
          error: (error as Error).message,
          path: req.path,
        });
        
        // Continue without caching on error
        next();
      }
    };
  }
}

/**
 * Create API cache middleware with options
 */
export function createAPICacheMiddleware(
  cache: CacheService,
  logger: LoggerService,
  performanceMonitoring: PerformanceMonitoringService,
  options?: CacheMiddlewareOptions,
): (req: Request, res: Response, next: NextFunction) => void {
  const manager = new APICacheManager(cache, logger, performanceMonitoring, options);
  return manager.createMiddleware();
}

/**
 * Cache invalidation middleware for mutations
 * 
 * to prevent race conditions with concurrent cache storage operations.
 */
export function createCacheInvalidationMiddleware(
  cache: CacheService,
  logger: LoggerService,
  performanceMonitoring: PerformanceMonitoringService,
  tags?: string[],
  pattern?: string,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Only invalidate on mutation methods
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      return next();
    }

    // This must happen BEFORE the controller runs to prevent race conditions
    if (tags && tags.length > 0) {
      try {
        await cache.setInvalidationTimestamps(tags);
        logger.debug('Invalidation timestamps set at mutation start', {
          tags,
          method: req.method,
          path: req.path,
        });
      } catch (error) {
        logger.error('Failed to set invalidation timestamps', {
          error: (error as Error).message,
          tags,
        });
      }
    }

    const originalSend = res.send;
    const originalJson = res.json;

    const invalidateCache = () => {
      // Fire-and-forget: Safe because timestamps are already set
      (async () => {
        try {
          const manager = new APICacheManager(cache, logger, performanceMonitoring);

          // Invalidate by tags if provided
          if (tags && tags.length > 0) {
            await manager.invalidateCacheByTags(tags);
          }

          // Invalidate by pattern if provided
          if (pattern) {
            await manager.invalidateCacheByPattern(pattern);
          }

          // Auto-invalidate based on path
          if (!tags && !pattern) {
            const pathPattern = req.path.replace(/\/[0-9a-f-]+/g, '/*');
            await manager.invalidateCacheByPattern(pathPattern);
          }
        } catch (error) {
          logger.error('Cache cleanup failed (non-critical)', {
            error: (error as Error).message,
          });
        }
      })();
    };

    res.send = function(body: unknown) {
      // Only invalidate on successful mutations
      if (res.statusCode >= 200 && res.statusCode < 300) {
        invalidateCache();
      }
      return originalSend.call(this, body);
    };

    res.json = function(body: unknown) {
      // Only invalidate on successful mutations
      if (res.statusCode >= 200 && res.statusCode < 300) {
        invalidateCache();
      }
      return originalJson.call(this, body);
    };

    next();
  };
}

// Legacy export for backward compatibility - DEPRECATED
export function cacheInvalidationMiddleware(tags?: string[], pattern?: string) {
  throw new Error('DEPRECATED: Use createCacheInvalidationMiddleware factory function with explicit dependencies');
}

export default createAPICacheMiddleware;
