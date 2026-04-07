import { Request, Response, NextFunction } from 'express';
import { LoggerService, LogLevel, LogCategory } from '../../../services/logger.service';
import { PerformanceMonitoringService, PerformanceMetricType } from '../../../services/performanceMonitoring.service';
import { v4 as uuidv4 } from 'uuid';
import { getCorrelationContext, updateCorrelationUser } from './correlationContext.middleware';
import { AppError } from '../../../utils/AppError';

export interface LoggingRequest extends Request {
  requestId?: string;
  startTime?: number;
  logContext?: {
    userId?: string;
    ip: string;
    userAgent?: string;
  };
}

export class LoggingMiddleware {
  private logger: LoggerService;
  private performanceMonitoring: PerformanceMonitoringService;

  constructor(
    logger: LoggerService,
    performanceMonitoring: PerformanceMonitoringService,
  ) {
    this.logger = logger;
    this.performanceMonitoring = performanceMonitoring;
  }

  /**
   * Initialize request logging context
   */
  public initializeRequestLogging = (req: LoggingRequest, res: Response, next: NextFunction): void => {
    // Get correlation context if available, or use request properties
    const context = getCorrelationContext();
    
    // Use correlation ID from context or generate new one
    req.requestId = req.correlationId || context?.correlationId || uuidv4();
    req.startTime = req.requestStartTime || context?.startTime || Date.now();

    // Extract user context
    const userId = this.extractUserId(req);
    req.logContext = {
      userId,
      ip: this.getClientIP(req),
      userAgent: req.get('User-Agent'),
    };

    // Update correlation context with user info if available
    if (userId && context) {
      updateCorrelationUser(userId);
    }

    // Add request ID to response headers for tracing
    res.setHeader('X-Request-ID', req.requestId);

    // Log the incoming request with correlation ID
    this.logger.logAPIRequest(req, req.requestId);

    next();
  };

  /**
   * Log request completion
   */
  public logRequestCompletion = (req: LoggingRequest, res: Response, next: NextFunction): void => {
    const context = getCorrelationContext();
    const originalSend = res.send;
    const originalJson = res.json;
    const originalEnd = res.end;

    // Type-safe response body tracking
    let responseBody: unknown;
    let responseSent = false;

    // Intercept response methods to capture response data
    // Using unknown for body parameters as Express accepts any serializable data
    res.send = function(body: unknown) {
      if (!responseSent) {
        responseBody = body;
        responseSent = true;
        logResponse();
      }
      // SAFETY CHECK: Only call original if headers not already sent
      if (!res.headersSent) {
        return originalSend.call(this, body);
      }
      return res;
    };

    res.json = function(body: unknown) {
      if (!responseSent) {
        responseBody = body;
        responseSent = true;
        logResponse();
      }
      // SAFETY CHECK: Only call original if headers not already sent
      if (!res.headersSent) {
        return originalJson.call(this, body);
      }
      return res;
    };

    // Type-safe end method with proper chunk typing
    res.end = function(chunk?: unknown) {
      if (!responseSent) {
        responseBody = chunk;
        responseSent = true;
        logResponse();
      }
      // SAFETY CHECK: Only call original if headers not already sent
      if (!res.headersSent) {
        return originalEnd.call(this, chunk, 'utf8');
      }
      return res;
    };

    const logger = this.logger;
    const performanceMonitoring = this.performanceMonitoring;
    const requestId = req.requestId || context?.correlationId || uuidv4();
    const startTime = req.startTime || context?.startTime || Date.now();

    function logResponse() {
      const duration = Date.now() - startTime;
      
      // Log API response
      logger.logAPIResponse(res, requestId, startTime, responseBody);
      
      // Record performance metrics
      performanceMonitoring.recordAPIResponseTime(
        req.path,
        req.method,
        duration,
        res.statusCode,
        requestId,
      );
      
      // Record error rate if this is an error response
      if (res.statusCode >= 400) {
        performanceMonitoring.recordMetric(
          PerformanceMetricType.ERROR_RATE,
          'api_error_rate',
          1,
          'count',
          {
            endpoint: req.path,
            method: req.method,
            status_code: res.statusCode.toString(),
          },
          { requestId },
        );
      }
    }

    next();
  };

  /**
   * Log errors
   */
  public logError = (error: unknown, req: LoggingRequest, res: Response, next: NextFunction): void => {
    const context = getCorrelationContext();
    const correlationId = req.requestId || context?.correlationId;
    const userId = req.logContext?.userId || context?.userId;
    const appError = error instanceof AppError ? error : null;
    const requestWithBody = req as LoggingRequest & {
      rawBodyBytes?: number;
      rawBodyLimitBytes?: number;
    };

    if (appError && appError.statusCode === 413 && req.path.includes('/health/samples')) {
      this.performanceMonitoring.recordMetric(
        PerformanceMetricType.NETWORK_IO,
        'health.ingest.request.body_too_large',
        requestWithBody.rawBodyBytes ?? 0,
        'bytes',
        {
          endpoint: req.path,
          method: req.method,
          content_encoding: String(req.headers['content-encoding'] ?? 'identity'),
          status_code: String(appError.statusCode),
        },
        {
          inflatedBytes: requestWithBody.rawBodyBytes,
          inflatedLimitBytes: requestWithBody.rawBodyLimitBytes,
          contentLength: req.headers['content-length'],
        }
      );
    }

    // Type-safe error handling with proper type guards
    const err = error instanceof Error ? error : new Error(String(error));

    this.logger.log(
      LogLevel.ERROR,
      LogCategory.ERROR,
      `Request error: ${err.message}`,
      {
        path: req.path,
        method: req.method,
        statusCode: res.statusCode,
        stack: err.stack,
      },
      correlationId,
      userId,
      err,
    );

    // Log the error response
    if (req.startTime) {
      this.logger.logAPIResponse(res, req.requestId!, req.startTime, undefined, err);
    }

    next(error);
  };

  /**
   * Log performance metrics for slow requests
   */
  public logPerformanceMetrics = (req: LoggingRequest, res: Response, next: NextFunction): void => {
    const originalEnd = res.end;
    const context = getCorrelationContext();

    // Type-safe end method with proper chunk typing
    res.end = function(chunk?: unknown) {
      const startTime = req.startTime || context?.startTime || Date.now();
      const duration = Date.now() - startTime;
      const correlationId = req.requestId || context?.correlationId;

      // Note: Performance logging has been moved to factory functions
      // This method is deprecated and should use createLogPerformanceMetrics instead

      return originalEnd.call(this, chunk, 'utf8');
    };

    next();
  };

  /**
   * Log database operations - DEPRECATED
   * Use factory functions with explicit dependency injection instead
   */
  public static logDatabaseOperation(
    operation: string,
    table?: string,
    duration?: number,
    error?: Error,
    requestId?: string,
  ): void {
    throw new Error('DEPRECATED: Use factory functions with explicit LoggerService and PerformanceMonitoringService dependencies instead of static getInstance() calls');
  }

  /**
   * Log external API calls - DEPRECATED
   * Use factory functions with explicit dependency injection instead
   */
  public static logExternalAPICall(
    service: string,
    endpoint: string,
    method: string,
    duration: number,
    statusCode?: number,
    error?: Error,
    requestId?: string,
  ): void {
    throw new Error('DEPRECATED: Use factory functions with explicit LoggerService and PerformanceMonitoringService dependencies instead of static getInstance() calls');
  }

  /**
   * Log authentication events - DEPRECATED
   * Use factory functions with explicit dependency injection instead
   */
  public static logAuthenticationEvent(
    success: boolean,
    userId?: string,
    ip?: string,
    userAgent?: string,
    requestId?: string,
    details?: Record<string, unknown>,
  ): void {
    throw new Error('DEPRECATED: Use factory functions with explicit LoggerService dependency instead of static getInstance() calls');
  }

  /**
   * Log authorization events - DEPRECATED
   * Use factory functions with explicit dependency injection instead
   */
  public static logAuthorizationEvent(
    success: boolean,
    userId?: string,
    resource?: string,
    action?: string,
    requestId?: string,
  ): void {
    throw new Error('DEPRECATED: Use factory functions with explicit LoggerService dependency instead of static getInstance() calls');
  }

  /**
   * Create a child logger with request context - DEPRECATED
   * Use factory functions with explicit dependency injection instead
   */
  public static createRequestLogger(req: LoggingRequest) {
    throw new Error('DEPRECATED: Use factory functions with explicit LoggerService dependency instead of static getInstance() calls');
  }

  // Private helper methods

  private extractUserId(req: Request): string | undefined {
    return req.user?.id || req.userId;
  }

  private getClientIP(req: Request): string {
    return (req.headers['x-forwarded-for'] as string)?.split(',')[0] ||
           req.connection.remoteAddress ||
           req.socket.remoteAddress ||
           'unknown';
  }
}

// Factory function to create LoggingMiddleware with explicit dependencies
export function createLoggingMiddleware(
  logger: LoggerService,
  performanceMonitoring: PerformanceMonitoringService,
): LoggingMiddleware {
  return new LoggingMiddleware(logger, performanceMonitoring);
}

// Factory functions for middleware creation with dependency injection
export function createInitializeRequestLogging(
  logger: LoggerService,
  performanceMonitoring: PerformanceMonitoringService,
): (req: LoggingRequest, res: Response, next: NextFunction) => void {
  const middleware = createLoggingMiddleware(logger, performanceMonitoring);
  return middleware.initializeRequestLogging;
}

export function createLogRequestCompletion(
  logger: LoggerService,
  performanceMonitoring: PerformanceMonitoringService,
): (req: LoggingRequest, res: Response, next: NextFunction) => void {
  const middleware = createLoggingMiddleware(logger, performanceMonitoring);
  return middleware.logRequestCompletion;
}

export function createLogPerformanceMetrics(
  logger: LoggerService,
  performanceMonitoring: PerformanceMonitoringService,
): (req: LoggingRequest, res: Response, next: NextFunction) => void {
  const middleware = createLoggingMiddleware(logger, performanceMonitoring);
  return middleware.logPerformanceMetrics;
}

export function createLogError(
  logger: LoggerService,
  performanceMonitoring: PerformanceMonitoringService,
): (err: unknown, req: LoggingRequest, res: Response, next: NextFunction) => void {
  const middleware = createLoggingMiddleware(logger, performanceMonitoring);
  return middleware.logError;
}

// Legacy exports - DEPRECATED - Use factory functions above
// These will throw errors to encourage migration to explicit DI
export const initializeRequestLogging = (req: LoggingRequest, res: Response, next: NextFunction): void => {
  throw new Error('DEPRECATED: Use createInitializeRequestLogging factory function with explicit dependencies');
};

export const logRequestCompletion = (req: LoggingRequest, res: Response, next: NextFunction): void => {
  throw new Error('DEPRECATED: Use createLogRequestCompletion factory function with explicit dependencies');
};

export const logError = (err: unknown, req: LoggingRequest, res: Response, next: NextFunction): void => {
  throw new Error('DEPRECATED: Use createLogError factory function with explicit dependencies');
};

export const logPerformanceMetrics = (req: LoggingRequest, res: Response, next: NextFunction): void => {
  throw new Error('DEPRECATED: Use createLogPerformanceMetrics factory function with explicit dependencies');
};

// Export factory function as default for DI
export { createLoggingMiddleware as default };
