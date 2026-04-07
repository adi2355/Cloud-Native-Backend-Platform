/**
 * Correlation Context Middleware
 * Provides request tracing and correlation ID propagation throughout the application
 * Uses AsyncLocalStorage for context propagation without explicit passing
 */

import { Request, Response, NextFunction } from 'express';
import { AsyncLocalStorage } from 'async_hooks';
import { v4 as uuidv4 } from 'uuid';
import { LoggerService, LogCategory, LogLevel } from '../../../services/logger.service';

// Define correlation context structure
export interface CorrelationContext {
  correlationId: string;
  parentCorrelationId?: string;
  parentSpanId?: string;
  spanId: string;
  traceId: string;
  userId?: string;
  sessionId?: string;
  clientIp?: string;
  userAgent?: string;
  requestPath?: string;
  requestMethod?: string;
  startTime: number;
  attributes: Map<string, unknown>;
}

// Create AsyncLocalStorage instance for correlation context
const correlationStore = new AsyncLocalStorage<CorrelationContext>();

/**
 * Get current correlation context from AsyncLocalStorage
 */
export function getCorrelationContext(): CorrelationContext | undefined {
  return correlationStore.getStore();
}

/**
 * Run a function with a specific correlation context
 */
export function runWithCorrelation<T>(context: CorrelationContext, fn: () => T): T {
  return correlationStore.run(context, fn);
}

/**
 * Extract correlation ID from various standard headers
 */
function extractCorrelationId(req: Request): string | undefined {
  // Check standard correlation headers in priority order
  const headers = [
    'x-correlation-id',
    'x-request-id',
    'x-trace-id',
    'x-b3-traceid', // Zipkin B3 format
    'traceparent', // W3C Trace Context
  ];

  for (const header of headers) {
    const value = req.headers[header] as string;
    if (value) {
      // For W3C traceparent, extract trace-id portion
      if (header === 'traceparent') {
        const parts = value.split('-');
        if (parts.length >= 2) {
          return parts[1];
        }
      }
      return value;
    }
  }

  return undefined;
}

/**
 * Create a factory function for correlation context middleware with dependency injection
 */
export function createCorrelationContextMiddleware(logger: LoggerService) {
  return function initializeCorrelationContext(req: Request, res: Response, next: NextFunction) {
  // Extract or generate correlation ID
  const correlationId = extractCorrelationId(req) || uuidv4();
  const traceId = correlationId; // For simplicity, use same ID for trace
  const spanId = uuidv4().substring(0, 16); // Shorter span ID

  // Create correlation context
  const context: CorrelationContext = {
    correlationId,
    traceId,
    spanId,
    startTime: Date.now(),
    userId: undefined, // Will be populated by auth middleware
    sessionId: req.sessionID || undefined, // Optional session ID from express-session
    clientIp: req.ip || req.socket?.remoteAddress,
    userAgent: req.get('user-agent'),
    requestPath: req.path,
    requestMethod: req.method,
    attributes: new Map(),
  };

  // Attach to request for backward compatibility
  req.correlationId = correlationId;
  req.requestStartTime = context.startTime;

  // Set response headers for correlation
  res.setHeader('X-Correlation-ID', correlationId);
  res.setHeader('X-Trace-ID', traceId);
  res.setHeader('X-Span-ID', spanId);

  // Run the rest of the request in correlation context
  correlationStore.run(context, () => {
    logger.log(
      LogLevel.DEBUG,
      LogCategory.SYSTEM,
      'Correlation context initialized',
      {
        correlationId,
        traceId,
        spanId,
        method: req.method,
        path: req.path,
        userAgent: req.get('User-Agent'),
      },
      correlationId,
    );

    next();
  });
  };
}

/**
 * Update correlation context with user information after authentication
 */
export function updateCorrelationUser(userId: string, sessionId?: string) {
  const context = getCorrelationContext();
  if (context) {
    context.userId = userId;
    if (sessionId) {
      context.sessionId = sessionId;
    }
  }
}

/**
 * Add custom attributes to correlation context
 */
export function addCorrelationAttribute(key: string, value: unknown) {
  const context = getCorrelationContext();
  if (context) {
    context.attributes.set(key, value);
  }
}

/**
 * Create a child span for nested operations
 */
export function createChildSpan(name: string): string {
  const context = getCorrelationContext();
  if (context) {
    const childSpanId = uuidv4().substring(0, 16);
    addCorrelationAttribute(`span.${childSpanId}.name`, name);
    addCorrelationAttribute(`span.${childSpanId}.parentId`, context.spanId);
    return childSpanId;
  }
  return uuidv4().substring(0, 16);
}

/**
 * Get correlation headers for outgoing HTTP requests
 */
export function getCorrelationHeaders(): Record<string, string> {
  const context = getCorrelationContext();
  if (!context) {
    return {};
  }

  return {
    'X-Correlation-ID': context.correlationId,
    'X-Trace-ID': context.traceId,
    'X-Parent-Span-ID': context.spanId,
    'X-Span-ID': uuidv4().substring(0, 16), // New span for outgoing request
  };
}

/**
 * Create a factory function for correlation completion middleware with dependency injection
 */
export function createLogCorrelationCompletion(logger: LoggerService) {
  return function logCorrelationCompletion(req: Request, res: Response, next: NextFunction) {
  const context = getCorrelationContext();
  if (!context) {
    return next();
  }

  const duration = Date.now() - context.startTime;
  const level = res.statusCode >= 500 ? LogLevel.ERROR : 
                res.statusCode >= 400 ? LogLevel.WARN : 
                LogLevel.INFO;

  logger.log(
    level,
    LogCategory.API_RESPONSE,
    `Request completed: ${req.method} ${req.path}`,
    {
      correlationId: context.correlationId,
      traceId: context.traceId,
      spanId: context.spanId,
      statusCode: res.statusCode,
      durationMs: duration,
      userId: context.userId,
      attributes: Object.fromEntries(context.attributes),
    },
    context.correlationId,
    context.userId,
  );

  // Log slow requests
  if (duration > 1000) {
    logger.log(
      LogLevel.WARN,
      LogCategory.PERFORMANCE,
      `Slow request detected: ${req.method} ${req.path}`,
      {
        correlationId: context.correlationId,
        durationMs: duration,
        threshold: 1000,
      },
      context.correlationId,
      context.userId,
    );
  }

  next();
  };
}

/**
 * Create a factory function for correlation error handler with dependency injection
 */
export function createCorrelationErrorHandler(logger: LoggerService) {
  return function correlationErrorHandler(err: Error, req: Request, res: Response, next: NextFunction) {
  const context = getCorrelationContext();
  
  if (context) {
    logger.log(
      LogLevel.ERROR,
      LogCategory.ERROR,
      `Request error: ${err.message}`,
      {
        correlationId: context.correlationId,
        traceId: context.traceId,
        spanId: context.spanId,
        error: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method,
      },
      context.correlationId,
      context.userId,
      err,
    );
  }

  next(err);
  };
}

// Note: correlationContextMiddleware export has been removed - use createCorrelationContextMiddleware() factory function with dependency injection instead.

// Export additional functions for compatibility with existing code
export const getCurrentCorrelationId = (): string | undefined => {
  const context = getCorrelationContext();
  return context?.correlationId;
};

export const getCurrentTraceId = (): string | undefined => {
  const context = getCorrelationContext();
  return context?.traceId;
};

export const getCurrentUserId = (): string | undefined => {
  const context = getCorrelationContext();
  return context?.userId;
};

// Export CorrelationContextManager for compatibility
export const CorrelationContextManager = {
  getContext: getCorrelationContext,
  getCurrentContext: getCorrelationContext, // Alias for compatibility
  getCurrentCorrelationId,
  updateUser: updateCorrelationUser,
  addAttribute: addCorrelationAttribute,
  createChildSpan,
  getHeaders: getCorrelationHeaders,
  getOutgoingHeaders: getCorrelationHeaders, // Alias for compatibility
  runWithContext: runWithCorrelation,
  getAttribute: (key: string) => {
    const context = getCorrelationContext();
    return context?.attributes.get(key);
  },
};

// Note: Default export is deprecated - use factory functions with dependency injection
export default {
  createCorrelationContextMiddleware,
  createLogCorrelationCompletion,
  createCorrelationErrorHandler,
  updateCorrelationUser,
  addCorrelationAttribute,
  createChildSpan,
  getCorrelationContext,
  getCorrelationHeaders,
  runWithCorrelation,
};