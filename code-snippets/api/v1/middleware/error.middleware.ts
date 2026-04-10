
import { Request, Response, NextFunction } from 'express';
import { getCorrelationId, getOptionalUser, getRequestId } from '../../../utils/auth-guards';
import { AppError, ErrorCodes } from '../../../utils/AppError';
import { LoggerService } from '../../../services/logger.service';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { handlePrismaError } from '../../../models';

/**
 * Route patterns that contain sensitive data (PHI, PII, credentials)
 * and should NEVER have their request body logged in plaintext.
 *
 * Auth data contains credentials and tokens.
 * Logging these violates privacy regulations and security best practices.
 */
const SENSITIVE_ROUTE_PATTERNS = [
  '/health/',
  '/auth/',
] as const;

/**
 * Redacts sensitive request body content for safe logging.
 *
 * For sensitive routes (health, auth), returns a safe summary:
 * - Health routes: { redacted: true, samplesCount, payloadHash, requestId }
 * - Auth routes: { redacted: true, hasPassword, hasToken }
 *
 * For non-sensitive routes, returns the original body.
 *
 * @param req - Express request object
 * @returns Redacted or original body for logging
 */
function redactSensitiveBody(req: Request): Record<string, unknown> {
  const isSensitiveRoute = SENSITIVE_ROUTE_PATTERNS.some(pattern =>
    req.path.includes(pattern)
  );

  if (!isSensitiveRoute) {
    // Non-sensitive route: return body as-is for debugging
    return req.body as Record<string, unknown>;
  }

  // Health routes: redact sample values but preserve debugging metadata
  if (req.path.includes('/health/samples') || req.path.includes('/health/')) {
    const body = req.body as Record<string, unknown> | undefined;
    const samples = body?.samples;

    return {
      redacted: true,
      route: 'health',
      samplesCount: Array.isArray(samples) ? samples.length : 0,
      payloadHash: typeof body?.payloadHash === 'string' ? body.payloadHash : 'N/A',
      requestId: typeof body?.requestId === 'string' ? body.requestId : 'N/A',
    };
  }

  // Auth routes: redact credentials but indicate presence
  if (req.path.includes('/auth/')) {
    const body = req.body as Record<string, unknown> | undefined;

    return {
      redacted: true,
      route: 'auth',
      hasPassword: body ? 'password' in body : false,
      hasIdToken: body ? 'idToken' in body : false,
      hasRefreshToken: body ? 'refreshToken' in body : false,
      hasAccessToken: body ? 'accessToken' in body : false,
    };
  }

  // Fallback for other sensitive routes: fully redacted
  return {
    redacted: true,
    route: 'unknown-sensitive',
  };
}

/**
 * Factory function to create error handler middleware with dependency injection
 */
export function createErrorHandler(logger: LoggerService) {
  return (err: Error, req: Request, res: Response, next: NextFunction) => {

  // Handle Zod validation errors
  if (err instanceof ZodError) {
    const requestId = getRequestId(req);
    logger.warn('Validation Error', {
      path: req.path,
      method: req.method,
      errors: err.errors,
      correlationId: getCorrelationId(req),
      requestId,
    });

    return res.status(400).json({
      success: false,
      error: {
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Validation failed',
        details: err.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message,
        })),
        requestId,
      },
    });
  }

  // Handle body-parser errors (e.g., from verify callback in jsonBodyParser)
  // Body-parser wraps errors and sets type: 'entity.verify.failed', 'entity.too.large', etc.
  const bodyParserError = err as Error & { type?: string; statusCode?: number; status?: number };
  if (bodyParserError.type === 'entity.verify.failed' ||
      bodyParserError.type === 'entity.too.large' ||
      bodyParserError.type === 'entity.parse.failed' ||
      bodyParserError.type === 'encoding.unsupported') {
    // Use appropriate default based on error type (body-parser usually sets statusCode)
    const defaultStatus = bodyParserError.type === 'encoding.unsupported' ? 415
      : bodyParserError.type === 'entity.parse.failed' ? 400
      : 413; // entity.too.large, entity.verify.failed
    const statusCode = bodyParserError.statusCode || bodyParserError.status || defaultStatus;
    const requestId = getRequestId(req);

    logger.warn('Body parser error', {
      type: bodyParserError.type,
      message: bodyParserError.message,
      path: req.path,
      method: req.method,
      correlationId: getCorrelationId(req),
      requestId,
    });

    return res.status(statusCode).json({
      success: false,
      error: {
        code: ErrorCodes.INVALID_INPUT,
        message: bodyParserError.message || 'Request body validation failed',
        requestId,
      },
    });
  }

  // Handle Prisma errors
  if (err instanceof Prisma.PrismaClientKnownRequestError ||
      err instanceof Prisma.PrismaClientValidationError ||
      err instanceof Prisma.PrismaClientInitializationError) {
    const appError = handlePrismaError(err);
    err = appError; // Convert to AppError for consistent handling
  }

  // Handle AppError (our custom errors)
  if (err instanceof AppError) {
    const baseLogData = {
      errorCode: err.errorCode,
      statusCode: err.statusCode,
      path: req.path,
      method: req.method,
      correlationId: getCorrelationId(req),
      userId: getOptionalUser(req)?.id,
    };

    // Include original error context for enhanced debugging
    const enhancedLogData: Record<string, unknown> = { ...baseLogData };
    if (err.originalError) {
      if (err.originalError instanceof Error) {
        enhancedLogData.originalError = {
          name: err.originalError.name,
          message: err.originalError.message,
          stack: err.originalError.stack,
        };

        // Include Prisma-specific details if available using proper type guards
        if (err.originalError instanceof Prisma.PrismaClientKnownRequestError) {
          (enhancedLogData.originalError as Record<string, unknown>).prismaCode = err.originalError.code;
          (enhancedLogData.originalError as Record<string, unknown>).prismaMeta = err.originalError.meta;
        }
      } else {
        enhancedLogData.originalError = {
          type: typeof err.originalError,
          value: String(err.originalError),
        };
      }
    }

    // Log operational errors as warnings, non-operational as errors
    if (err.isOperational) {
      logger.warn(`API Error: ${err.message}`, enhancedLogData);
    } else {
      logger.error('Non-operational Error', {
        error: err.message,
        stack: err.stack,
        ...enhancedLogData,
      });
    }

    return res.status(err.statusCode).json({
      success: false,
      error: {
        ...err.toJSON(),
        requestId: getRequestId(req),
      },
    });
  }

  // Handle unexpected errors (bugs)
  // Health sample values, auth credentials, etc. are NEVER logged in plaintext
  const unexpectedRequestId = getRequestId(req);
  logger.error('Unexpected Error', {
    error: err?.message || String(err),
    stack: err?.stack,
    path: req.path,
    method: req.method,
    correlationId: getCorrelationId(req),
    requestId: unexpectedRequestId,
    body: redactSensitiveBody(req),
    query: req.query,
    userId: getOptionalUser(req)?.id,
  });

  // Send generic response for unexpected errors (don't leak internals)
  return res.status(500).json({
    success: false,
    error: {
      code: ErrorCodes.INTERNAL_SERVER_ERROR,
      message: 'An unexpected error occurred. Please try again later.',
      requestId: unexpectedRequestId,
    },
  });
  };
}

/**
 * 404 Not Found handler
 */
export const notFoundHandler = (req: Request, res: Response, next: NextFunction) => {
  const error = new AppError(
    404, 
    ErrorCodes.NOT_FOUND, 
    `The requested endpoint ${req.path} does not exist.`,
  );
  next(error);
};

// Note: errorHandler export removed - Use createErrorHandler() factory function with dependency injection
