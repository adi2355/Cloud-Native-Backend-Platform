import { Request, Response, NextFunction } from 'express';
import {
  RateLimitingQueueService,
  RateLimitOverride,
  RateLimitStatus,
} from '../../../services/rateLimitingQueue.service';
import { LoggerService } from '../../../services/logger.service';

/**
 * Extended request interface with rate limit information
 */
export interface RateLimitedRequest extends Request {
  rateLimitInfo?: {
    remainingRequests: number;
    resetTime: number;
    retryAfter?: number;
  };
  rateLimitOverride?: RateLimitOverride;
}

/**
 * Rate Limiting Queue Middleware
 * Provides intelligent rate limiting with request queuing and user feedback
 */
export class RateLimitQueueMiddleware {
  constructor(
    private rateLimitService: RateLimitingQueueService,
    private logger?: LoggerService,
  ) {}

  /**
   * Create rate limiting middleware with custom configuration
   */
  public createRateLimiter = (config?: RateLimitOverride) => {
    const overrideConfig = config ? { ...config } as RateLimitOverride : undefined;

    return async (req: RateLimitedRequest, res: Response, next: NextFunction): Promise<void> => {
      try {
        if (overrideConfig) {
          req.rateLimitOverride = overrideConfig;
        }

        const rateLimitStatus = this.rateLimitService.checkRateLimit(req);
        const effectiveConfig = this.rateLimitService.getConfigForRequest(req);
        const rateLimitKey = this.rateLimitService.getRateLimitKey(req);

        // Add rate limit headers to response
        res.setHeader('X-RateLimit-Limit', effectiveConfig.maxRequests);
        res.setHeader('X-RateLimit-Remaining', rateLimitStatus.remainingRequests);
        res.setHeader('X-RateLimit-Reset', new Date(rateLimitStatus.resetTime).toISOString());

        // Attach rate limit info to request
        req.rateLimitInfo = {
          remainingRequests: rateLimitStatus.remainingRequests,
          resetTime: rateLimitStatus.resetTime,
          retryAfter: rateLimitStatus.retryAfter,
        };

        if (!rateLimitStatus.isLimited) {
          // Request is within rate limit, proceed normally
          next();
          return;
        }

        // Rate limit exceeded, add retry-after header
        if (rateLimitStatus.retryAfter) {
          res.setHeader('Retry-After', rateLimitStatus.retryAfter);
        }

        // Log rate limiting event
        try {
          if (this.logger) {
            this.logger.warn('Rate limit exceeded', {
              ip: req.ip,
              url: req.url,
              method: req.method,
              userAgent: req.get('User-Agent'),
              rateLimitKey,
              rateLimitBucket: overrideConfig?.bucket,
              rateLimitLimit: effectiveConfig.maxRequests,
              rateLimitWindowMs: effectiveConfig.windowMs,
              remainingRequests: rateLimitStatus.remainingRequests,
              retryAfter: rateLimitStatus.retryAfter,
              queuePosition: rateLimitStatus.queuePosition,
              estimatedWaitTime: rateLimitStatus.estimatedWaitTime,
              timestamp: new Date().toISOString(),
            });
          } else {
            console.warn('Rate limit exceeded', {
              ip: req.ip,
              url: req.url,
              method: req.method,
              userAgent: req.get('User-Agent'),
              rateLimitKey,
              rateLimitBucket: overrideConfig?.bucket,
              rateLimitLimit: effectiveConfig.maxRequests,
              rateLimitWindowMs: effectiveConfig.windowMs,
              remainingRequests: rateLimitStatus.remainingRequests,
              retryAfter: rateLimitStatus.retryAfter,
              queuePosition: rateLimitStatus.queuePosition,
              estimatedWaitTime: rateLimitStatus.estimatedWaitTime,
            });
          }
        } catch {
          console.warn('Rate limit exceeded', {
            ip: req.ip,
            url: req.url,
            method: req.method,
            userAgent: req.get('User-Agent'),
            rateLimitKey,
            rateLimitBucket: overrideConfig?.bucket,
            rateLimitLimit: effectiveConfig.maxRequests,
            rateLimitWindowMs: effectiveConfig.windowMs,
            remainingRequests: rateLimitStatus.remainingRequests,
            retryAfter: rateLimitStatus.retryAfter,
            queuePosition: rateLimitStatus.queuePosition,
            estimatedWaitTime: rateLimitStatus.estimatedWaitTime,
          });
        }

        // Check if request should be queued or rejected immediately
        const shouldQueue = this.shouldQueueRequest(req);

        if (shouldQueue) {
          // Queue the request with user feedback
          await this.handleQueuedRequest(req, res, rateLimitStatus);
        } else {
          // Reject immediately with rate limit response
          this.sendRateLimitResponse(res, rateLimitStatus);
        }

      } catch (error) {
        try {
          if (this.logger) {
            this.logger.error('Rate limiting middleware error', {
              error: (error as Error).message,
              url: req.url,
              method: req.method,
              ip: req.ip,
              timestamp: new Date().toISOString(),
            });
          } else {
            console.error('Rate limiting middleware error', {
              error: (error as Error).message,
              url: req.url,
              method: req.method,
              ip: req.ip,
            });
          }
        } catch {
          console.error('Rate limiting middleware error', {
            error: (error as Error).message,
            url: req.url,
            method: req.method,
            ip: req.ip,
          });
        }

        // On error, allow request to proceed to avoid blocking legitimate traffic
        next();
      }
    };
  };

  /**
   * Handle queued request with user feedback
   */
  private async handleQueuedRequest(
    req: Request,
    res: Response,
    rateLimitStatus: RateLimitStatus,
  ): Promise<void> {
    try {
      // Determine request priority based on endpoint
      const priority = this.getRequestPriority(req);

      // Send immediate response with queue information
      res.status(202).json({
        success: false,
        error: 'Rate limit exceeded - request queued',
        code: 'RATE_LIMIT_QUEUED',
        message: 'Your request has been queued due to high traffic. Please wait.',
        queueInfo: {
          position: rateLimitStatus.queuePosition || 1,
          estimatedWaitTime: rateLimitStatus.estimatedWaitTime || 30000,
          retryAfter: rateLimitStatus.retryAfter,
        },
        retryInstructions: {
          retryAfterSeconds: rateLimitStatus.retryAfter,
          exponentialBackoff: true,
          maxRetries: 3,
        },
      });

      // Queue the request for later processing
      await this.rateLimitService.queueRequest(req, res, priority);

    } catch (queueError) {
      try {
        if (this.logger) {
          this.logger.error('Error queuing request', {
            error: (queueError as Error).message,
            url: req.url,
            method: req.method,
            timestamp: new Date().toISOString(),
          });
        } else {
          console.error('Error queuing request', {
            error: (queueError as Error).message,
            url: req.url,
            method: req.method,
          });
        }
      } catch {
        console.error('Error queuing request', {
          error: (queueError as Error).message,
          url: req.url,
          method: req.method,
        });
      }

      // If queuing fails, send standard rate limit response
      this.sendRateLimitResponse(res, rateLimitStatus);
    }
  }

  /**
   * Send standard rate limit response
   */
  private sendRateLimitResponse(res: Response, rateLimitStatus: RateLimitStatus): void {
    res.status(429).json({
      success: false,
      error: 'Rate limit exceeded',
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests. Please try again later.',
      retryAfter: rateLimitStatus.retryAfter,
      retryInstructions: {
        retryAfterSeconds: rateLimitStatus.retryAfter,
        exponentialBackoff: true,
        maxRetries: 3,
        backoffStrategy: 'exponential',
      },
      rateLimitInfo: {
        windowMs: this.rateLimitService.getConfig().windowMs,
        maxRequests: this.rateLimitService.getConfig().maxRequests,
        resetTime: new Date(rateLimitStatus.resetTime).toISOString(),
      },
    });
  }

  /**
   * Determine if request should be queued or rejected immediately
   */
  private shouldQueueRequest(req: Request): boolean {
    // Don't queue health checks or static assets
    if (req.url.includes('/health') || req.url.includes('/static')) {
      return false;
    }

    // Don't queue if queue is too long
    const queueLength = this.rateLimitService.getQueueLength();
    if (queueLength > 100) {
      return false;
    }

    // Queue AI requests as they are high-value
    if (req.url.includes('/ai/')) {
      return true;
    }

    // Queue POST requests (likely more important than GET)
    if (req.method === 'POST') {
      return true;
    }

    return false;
  }

  /**
   * Get request priority based on endpoint and method
   */
  private getRequestPriority(req: Request): number {
    // Higher numbers = higher priority
    
    // Critical endpoints
    if (req.url.includes('/auth/') || req.url.includes('/security/')) {
      return 10;
    }

    // AI endpoints
    if (req.url.includes('/ai/')) {
      return 8;
    }

    // POST requests generally higher priority than GET
    if (req.method === 'POST' || req.method === 'PUT') {
      return 6;
    }

    // GET requests
    if (req.method === 'GET') {
      return 4;
    }

    // Default priority
    return 1;
  }

  /**
   * Middleware for monitoring rate limiting events
   */
  public rateLimitMonitoring = (req: Request, res: Response, next: NextFunction): void => {
    // Store original end method
    const originalEnd = res.end;
    // Capture logger instance from outer scope
    const logger = this.logger;

    // Override end method to log rate limiting metrics
    const endOverride: typeof originalEnd = function(this: Response, ...args: unknown[]): Response {
      const rateLimitInfo = this.getHeaders();

      // Log rate limiting metrics
      if (rateLimitInfo['x-ratelimit-remaining']) {
        const remaining = parseInt(rateLimitInfo['x-ratelimit-remaining'] as string);
        const limit = parseInt(rateLimitInfo['x-ratelimit-limit'] as string);
        const usagePercentage = ((limit - remaining) / limit) * 100;

        // Log high usage
        if (usagePercentage > 80) {
          try {
            if (logger) {
              logger.warn('High rate limit usage detected', {
                ip: req.ip,
                url: req.url,
                method: req.method,
                remaining,
                limit,
                usagePercentage: usagePercentage.toFixed(1),
                timestamp: new Date().toISOString(),
              });
            } else {
              console.warn('High rate limit usage detected', {
                ip: req.ip,
                url: req.url,
                method: req.method,
                remaining,
                limit,
                usagePercentage: usagePercentage.toFixed(1),
              });
            }
          } catch {
            console.warn('High rate limit usage detected', {
              ip: req.ip,
              url: req.url,
              method: req.method,
              remaining,
              limit,
              usagePercentage: usagePercentage.toFixed(1),
            });
          }
        }
      }

      // Call original end method with all arguments
      // @ts-expect-error - Complex overload signature, safe to spread args
      return originalEnd.call(this, ...args);
    };
    res.end = endOverride;

    next();
  };

  /**
   * Middleware to add rate limiting information to responses
   */
  public addRateLimitHeaders = (req: RateLimitedRequest, res: Response, next: NextFunction): void => {
    // Add standard rate limiting headers
    const config = this.rateLimitService.getConfigForRequest(req);
    const rateLimitInfo = this.rateLimitService.getRateLimitInfo(req);

    if (rateLimitInfo) {
      res.setHeader('X-RateLimit-Limit', config.maxRequests);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, config.maxRequests - rateLimitInfo.count));
      res.setHeader('X-RateLimit-Reset', new Date(rateLimitInfo.resetTime).toISOString());
      res.setHeader('X-RateLimit-Window', config.windowMs);
    }

    // Add queue information if available
    const queueStats = this.rateLimitService.getQueueStatistics();
    if (queueStats.queueLength > 0) {
      res.setHeader('X-Queue-Length', queueStats.queueLength);
      res.setHeader('X-Queue-Average-Wait', Math.round(queueStats.averageWaitTime));
    }

    next();
  };

  /**
   * Health check endpoint for rate limiting service
   */
  public healthCheck = (req: Request, res: Response): void => {
    const healthStatus = this.rateLimitService.getHealthStatus();
    const queueStats = this.rateLimitService.getQueueStatistics();

    res.status(healthStatus.healthy ? 200 : 503).json({
      success: healthStatus.healthy,
      service: 'rate-limiting-queue',
      status: healthStatus.healthy ? 'healthy' : 'degraded',
      metrics: {
        queueLength: healthStatus.queueLength,
        processing: healthStatus.processing,
        rateLimitEntries: healthStatus.rateLimitEntries,
        averageWaitTime: healthStatus.averageWaitTime,
        statistics: queueStats,
      },
      timestamp: new Date().toISOString(),
    });
  };

  /**
   * Admin endpoint to clear rate limits
   */
  public clearRateLimits = (req: Request, res: Response): void => {
    try {
      const { key } = req.body;

      if (key) {
        // Clear specific key
        const cleared = this.rateLimitService.clearRateLimit(key);
        res.json({
          success: true,
          message: cleared ? 'Rate limit cleared for key' : 'Key not found',
          key,
        });
      } else {
        // Clear all rate limits
        this.rateLimitService.clearAllRateLimits();
        res.json({
          success: true,
          message: 'All rate limits cleared',
        });
      }

      try {
        if (this.logger) {
          this.logger.info('Rate limits cleared', {
            key: key || 'all',
            admin: req.ip,
            timestamp: new Date().toISOString(),
          });
        } else {
          console.log('Rate limits cleared', { key: key || 'all', admin: req.ip });
        }
      } catch {
        console.log('Rate limits cleared', { key: key || 'all', admin: req.ip });
      }

    } catch (error) {
      try {
        if (this.logger) {
          this.logger.error('Error clearing rate limits', {
            error: (error as Error).message,
            timestamp: new Date().toISOString(),
          });
        } else {
          console.error('Error clearing rate limits', { error: (error as Error).message });
        }
      } catch {
        console.error('Error clearing rate limits', { error: (error as Error).message });
      }
      res.status(500).json({
        success: false,
        error: 'Failed to clear rate limits',
      });
    }
  };
}

// Factory function to create RateLimitQueueMiddleware with dependency injection
export function createRateLimitQueueMiddleware(
  rateLimitService: RateLimitingQueueService,
  logger?: LoggerService,
): RateLimitQueueMiddleware {
  return new RateLimitQueueMiddleware(rateLimitService, logger);
}

// Legacy exports - DEPRECATED - Use factory function above
export const createRateLimiter = () => {
  throw new Error('DEPRECATED: Use createRateLimitQueueMiddleware factory function with explicit dependencies');
};

export const rateLimitMonitoring = () => {
  throw new Error('DEPRECATED: Use createRateLimitQueueMiddleware factory function with explicit dependencies');
};

export const addRateLimitHeaders = () => {
  throw new Error('DEPRECATED: Use createRateLimitQueueMiddleware factory function with explicit dependencies');
};

export const rateLimitHealthCheck = () => {
  throw new Error('DEPRECATED: Use createRateLimitQueueMiddleware factory function with explicit dependencies');
};

export const clearRateLimits = () => {
  throw new Error('DEPRECATED: Use createRateLimitQueueMiddleware factory function with explicit dependencies');
};
