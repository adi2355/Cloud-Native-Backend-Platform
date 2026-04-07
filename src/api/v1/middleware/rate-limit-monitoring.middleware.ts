/**
 * Rate Limit Monitoring Middleware
 *
 * Provides comprehensive rate limiting monitoring, headers, and health checks
 * for production-grade rate limiting with observability and client transparency.
 *
 * Features:
 * - Real-time monitoring and metrics recording
 * - RFC 6585 compliant rate limit headers
 * - Proactive health monitoring and alerting
 *
 * @see https://tools.ietf.org/rfc/rfc6585.txt (RFC 6585 - Additional HTTP Status Codes)
 */

import { Request, Response, NextFunction } from 'express';
import { RateLimitingQueueService } from '../../../services/rateLimitingQueue.service';
import { PerformanceMonitoringService, PerformanceMetricType } from '../../../services/performanceMonitoring.service';
import { LoggerService } from '../../../services/logger.service';

/**
 * Request with correlation ID for tracking
 */
interface RequestWithCorrelation extends Request {
  correlationId?: string;
  rateLimitMonitoringStart?: number;
}

/**
 * Extended request interface with rate limit monitoring information
 */
export interface RateLimitMonitoredRequest extends Request {
  rateLimitMetrics?: {
    queuePosition?: number;
    estimatedWaitTime?: number;
    healthStatus?: boolean;
    rateLimitInfo?: {
      remainingRequests: number;
      resetTime: number;
      retryAfter?: number;
    };
  };
}

/**
 * Rate limit monitoring configuration
 */
export interface RateLimitMonitoringConfig {
  enableMetrics: boolean;
  enableHeaders: boolean;
  enableHealthCheck: boolean;
  healthCheckThresholds: {
    maxQueueLength: number;
    maxProcessingCount: number;
    maxAverageWaitTime: number; // milliseconds
  };
  headerPrefix?: string; // Default: 'X-RateLimit-'
}

/**
 * Default monitoring configuration
 */
const DEFAULT_MONITORING_CONFIG: RateLimitMonitoringConfig = {
  enableMetrics: true,
  enableHeaders: true,
  enableHealthCheck: true,
  healthCheckThresholds: {
    maxQueueLength: 1000,
    maxProcessingCount: 100,
    maxAverageWaitTime: 5000, // 5 seconds
  },
  headerPrefix: 'X-RateLimit-',
};

/**
 * Create rate limit monitoring middleware
 *
 * Records comprehensive metrics about rate limiting behavior including
 * queue statistics, hit/miss ratios, and processing times.
 *
 * @param rateLimitService RateLimitingQueueService instance
 * @param performanceService PerformanceMonitoringService instance
 * @param logger LoggerService instance
 * @param config Optional monitoring configuration
 * @returns Express middleware function
 */
export function createRateLimitMonitoring(
  rateLimitService: RateLimitingQueueService,
  performanceService: PerformanceMonitoringService,
  logger: LoggerService,
  config: Partial<RateLimitMonitoringConfig> = {},
) {
  const finalConfig = { ...DEFAULT_MONITORING_CONFIG, ...config };

  return (req: RateLimitMonitoredRequest, res: Response, next: NextFunction): void => {
    if (!finalConfig.enableMetrics) {
      return next();
    }

    const startTime = Date.now();

    try {
      // Get current queue statistics
      const queueStats = rateLimitService.getQueueStatistics();
      const rateLimitInfo = rateLimitService.getRateLimitInfo(req);

      // Record baseline metrics
      performanceService.recordMetric(
        PerformanceMetricType.THROUGHPUT,
        'rate_limit_queue_length',
        queueStats.queueLength,
        'count',
        { category: 'rate_limiting' },
        { correlationId: (req as RequestWithCorrelation).correlationId || 'unknown' },
      );

      performanceService.recordMetric(
        PerformanceMetricType.THROUGHPUT,
        'rate_limit_processing_count',
        queueStats.processing,
        'count',
        { category: 'rate_limiting' },
        { correlationId: (req as RequestWithCorrelation).correlationId || 'unknown' },
      );

      // Record rate limit status metrics
      if (rateLimitInfo) {
        performanceService.recordMetric(
          PerformanceMetricType.THROUGHPUT,
          'rate_limit_remaining_requests',
          rateLimitInfo.count,
          'count',
          { category: 'rate_limiting' },
          { correlationId: (req as RequestWithCorrelation).correlationId || 'unknown' },
        );
      }

      // Store monitoring start time
      (req as RequestWithCorrelation).rateLimitMonitoringStart = startTime;

      // Attach monitoring data to request
      req.rateLimitMetrics = {
        queuePosition: queueStats.queueLength,
        estimatedWaitTime: queueStats.averageWaitTime,
        healthStatus: queueStats.queueLength < finalConfig.healthCheckThresholds.maxQueueLength,
        rateLimitInfo: rateLimitInfo ? {
          remainingRequests: rateLimitInfo.count,
          resetTime: rateLimitInfo.resetTime,
        } : undefined,
      };

      // Hook into response to record completion metrics
      const originalSend = res.send;
      res.send = function(body: unknown) {
        const processingTime = Date.now() - startTime;

        try {
          // Record processing time for rate limit monitoring
          performanceService.recordMetric(
            PerformanceMetricType.RESPONSE_TIME,
            'rate_limit_monitoring_duration',
            processingTime,
            'milliseconds',
            { category: 'rate_limiting' },
            { correlationId: (req as RequestWithCorrelation).correlationId || 'unknown' },
          );

          logger.debug('Rate limit monitoring completed', {
            context: 'RateLimitMonitoring',
            processingTime,
            queueLength: queueStats.queueLength,
            remainingRequests: rateLimitInfo?.count || 'unknown',
            statusCode: res.statusCode,
          });
        } catch (error) {
          logger.warn('Failed to record rate limit monitoring metrics', {
            context: 'RateLimitMonitoring',
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }

        // SAFETY CHECK: Only call original if headers not already sent
        if (!res.headersSent) {
          return originalSend.call(this, body);
        }
        return res;
      };

      next();
    } catch (error) {
      logger.error('Rate limit monitoring middleware error', {
        context: 'RateLimitMonitoring',
        error: error instanceof Error ? error.message : 'Unknown error',
        path: req.path,
        method: req.method,
      });

      // Continue without monitoring if there's an error
      next();
    }
  };
}

/**
 * Create rate limit headers middleware
 *
 * Adds RFC 6585 compliant rate limiting headers to responses
 * providing transparent rate limit information to clients.
 *
 * @param rateLimitService RateLimitingQueueService instance
 * @param logger LoggerService instance
 * @param config Optional monitoring configuration
 * @returns Express middleware function
 */
export function createRateLimitHeaders(
  rateLimitService: RateLimitingQueueService,
  logger: LoggerService,
  config: Partial<RateLimitMonitoringConfig> = {},
) {
  const finalConfig = { ...DEFAULT_MONITORING_CONFIG, ...config };

  return (req: RateLimitMonitoredRequest, res: Response, next: NextFunction): void => {
    if (!finalConfig.enableHeaders) {
      return next();
    }

    try {
      const rateLimitConfig = rateLimitService.getConfigForRequest(req);
      const rateLimitInfo = rateLimitService.getRateLimitInfo(req);
      const remaining = rateLimitInfo
        ? Math.max(0, rateLimitConfig.maxRequests - rateLimitInfo.count)
        : rateLimitConfig.maxRequests;
      const resetTime = rateLimitInfo?.resetTime ?? Date.now() + rateLimitConfig.windowMs;
      const isLimited = rateLimitInfo ? rateLimitInfo.count >= rateLimitConfig.maxRequests : false;
      const retryAfterSeconds = isLimited
        ? Math.max(1, Math.ceil((resetTime - Date.now()) / 1000))
        : undefined;
      const queueStats = rateLimitService.getQueueStatistics();

      // Standard RFC 6585 headers
      const prefix = finalConfig.headerPrefix || 'X-RateLimit-';

      res.setHeader(`${prefix}Limit`, rateLimitConfig.maxRequests);
      res.setHeader(`${prefix}Remaining`, remaining);
      res.setHeader(`${prefix}Reset`, new Date(resetTime).toISOString());

      // Additional informative headers
      if (retryAfterSeconds) {
        res.setHeader(`${prefix}Retry-After`, retryAfterSeconds); // seconds
        res.setHeader('Retry-After', retryAfterSeconds); // Standard header
      }

      // Queue health indicators
      res.setHeader(`${prefix}Queue-Length`, queueStats.queueLength);
      res.setHeader(`${prefix}Processing-Count`, queueStats.processing);

      // Window information
      res.setHeader(`${prefix}Window`, Math.ceil(rateLimitConfig.windowMs / 1000)); // seconds

      logger.debug('Rate limit headers added', {
        context: 'RateLimitHeaders',
        remaining,
        resetTime,
        path: req.path,
      });

      next();
    } catch (error) {
      logger.error('Rate limit headers middleware error', {
        context: 'RateLimitHeaders',
        error: error instanceof Error ? error.message : 'Unknown error',
        path: req.path,
        method: req.method,
      });

      // Continue without headers if there's an error
      next();
    }
  };
}

/**
 * Create rate limit health check middleware
 *
 * Monitors rate limiter health and triggers alerts when
 * unhealthy conditions are detected.
 *
 * @param rateLimitService RateLimitingQueueService instance
 * @param logger LoggerService instance
 * @param config Optional monitoring configuration
 * @returns Express middleware function
 */
export function createRateLimitHealthCheck(
  rateLimitService: RateLimitingQueueService,
  logger: LoggerService,
  config: Partial<RateLimitMonitoringConfig> = {},
) {
  const finalConfig = { ...DEFAULT_MONITORING_CONFIG, ...config };
  let lastHealthStatus = true;
  let unhealthyStartTime: number | null = null;

  return (req: RateLimitMonitoredRequest, res: Response, next: NextFunction): void => {
    if (!finalConfig.enableHealthCheck) {
      return next();
    }

    try {
      const healthStatus = rateLimitService.getHealthStatus();
      const thresholds = finalConfig.healthCheckThresholds;

      // Evaluate health conditions
      const isHealthy = healthStatus.healthy &&
                       healthStatus.queueLength < thresholds.maxQueueLength &&
                       healthStatus.processing < thresholds.maxProcessingCount &&
                       healthStatus.averageWaitTime < thresholds.maxAverageWaitTime;

      // Track health status changes
      if (isHealthy !== lastHealthStatus) {
        if (!isHealthy) {
          unhealthyStartTime = Date.now();
          logger.warn('Rate limiter health check failed', {
            context: 'RateLimitHealthCheck',
            queueLength: healthStatus.queueLength,
            processing: healthStatus.processing,
            averageWaitTime: healthStatus.averageWaitTime,
            thresholds,
            path: req.path,
          });
        } else {
          const unhealthyDuration = unhealthyStartTime ? Date.now() - unhealthyStartTime : 0;
          logger.info('Rate limiter health restored', {
            context: 'RateLimitHealthCheck',
            unhealthyDuration: `${unhealthyDuration}ms`,
            queueLength: healthStatus.queueLength,
            processing: healthStatus.processing,
          });
          unhealthyStartTime = null;
        }

        lastHealthStatus = isHealthy;
      }

      // Add health check result to response headers for monitoring
      res.setHeader('X-RateLimit-Health', isHealthy ? 'healthy' : 'unhealthy');

      if (!isHealthy) {
        res.setHeader('X-RateLimit-Health-Issues', JSON.stringify({
          queueOverloaded: healthStatus.queueLength >= thresholds.maxQueueLength,
          processingOverloaded: healthStatus.processing >= thresholds.maxProcessingCount,
          highWaitTime: healthStatus.averageWaitTime >= thresholds.maxAverageWaitTime,
        }));
      }

      // Attach health status to request for downstream middleware
      if (!req.rateLimitMetrics) {
        req.rateLimitMetrics = {};
      }
      req.rateLimitMetrics.healthStatus = isHealthy;

      next();
    } catch (error) {
      logger.error('Rate limit health check middleware error', {
        context: 'RateLimitHealthCheck',
        error: error instanceof Error ? error.message : 'Unknown error',
        path: req.path,
        method: req.method,
      });

      // Continue with unknown health status
      next();
    }
  };
}

/**
 * Create combined rate limit monitoring middleware
 *
 * Convenience function that combines all three middleware functions
 * for complete rate limiting observability.
 *
 * @param rateLimitService RateLimitingQueueService instance
 * @param performanceService PerformanceMonitoringService instance
 * @param logger LoggerService instance
 * @param config Optional monitoring configuration
 * @returns Array of Express middleware functions
 */
export function createRateLimitObservability(
  rateLimitService: RateLimitingQueueService,
  performanceService: PerformanceMonitoringService,
  logger: LoggerService,
  config: Partial<RateLimitMonitoringConfig> = {},
) {
  return [
    createRateLimitMonitoring(rateLimitService, performanceService, logger, config),
    createRateLimitHeaders(rateLimitService, logger, config),
    createRateLimitHealthCheck(rateLimitService, logger, config),
  ];
}
