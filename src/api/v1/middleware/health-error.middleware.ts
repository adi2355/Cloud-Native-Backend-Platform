/**
 * Health-Specific Error Middleware
 *
 * PURPOSE: Transform errors from health batch endpoints to contract-compliant format.
 *
 * The generic error.middleware.ts returns { success, error: { code, message, requestId } }
 * but the BatchUpsertSamplesErrorResponseSchema contract requires:
 * - error.retryable: boolean
 * - error.retryAfterMs?: number
 * - error.code: BatchErrorCode enum (not generic ErrorCodes)
 *
 * This middleware MUST be used for health batch endpoints to ensure contract compliance.
 *
 * @module api/v1/middleware/health-error.middleware
 */

import { Request, Response, NextFunction } from 'express';
import { AppError, ErrorCodes, type ErrorCode } from '../../../utils/AppError';
import { LoggerService } from '../../../services/logger.service';
import { getRequestId, getCorrelationId } from '../../../utils/auth-guards';
import {
  type BatchErrorCode,
  BATCH_ERROR_RETRYABLE,
} from '@shared/contracts';

// Error Code Mapping

/**
 * Map AppError error codes to BatchErrorCode for contract compliance.
 *
 * BatchErrorCodeSchema enum values, not generic ErrorCodes.
 *
 * Unmapped codes default to 'SERVER_ERROR' (retryable) for safety.
 */
const ERROR_CODE_TO_BATCH_CODE: Partial<Record<ErrorCode, BatchErrorCode>> = {
  // Auth errors → Non-retryable
  [ErrorCodes.UNAUTHORIZED]: 'UNAUTHORIZED',
  [ErrorCodes.FORBIDDEN]: 'FORBIDDEN',
  [ErrorCodes.ACCESS_DENIED]: 'FORBIDDEN',
  [ErrorCodes.INSUFFICIENT_PERMISSIONS]: 'FORBIDDEN',

  // Validation errors → Non-retryable
  [ErrorCodes.VALIDATION_ERROR]: 'VALIDATION_ERROR',
  [ErrorCodes.INVALID_INPUT]: 'VALIDATION_ERROR',
  [ErrorCodes.BAD_REQUEST]: 'VALIDATION_ERROR',
  [ErrorCodes.PAYLOAD_HASH_MISMATCH]: 'VALIDATION_ERROR',
  [ErrorCodes.CONFIG_VERSION_TOO_NEW]: 'VALIDATION_ERROR',

  // Rate limiting → Retryable with delay
  [ErrorCodes.RATE_LIMIT_EXCEEDED]: 'RATE_LIMITED',

  // Server errors → Retryable
  // NOTE: 409 conflicts from ingest idempotency ("still processing") are transient and retryable.
  [ErrorCodes.CONFLICT]: 'SERVER_ERROR',
  [ErrorCodes.INTERNAL_SERVER_ERROR]: 'SERVER_ERROR',
  [ErrorCodes.DATABASE_ERROR]: 'SERVER_ERROR',
  [ErrorCodes.EXTERNAL_SERVICE_ERROR]: 'SERVER_ERROR',
  [ErrorCodes.SERVICE_UNAVAILABLE]: 'SERVICE_UNAVAILABLE',

  // Timeout → Retryable
  [ErrorCodes.REQUEST_TIMEOUT]: 'TIMEOUT',
};

/**
 * Map HTTP status codes to BatchErrorCode as fallback.
 *
 * Used when AppError code mapping doesn't match.
 */
const STATUS_CODE_TO_BATCH_CODE: Partial<Record<number, BatchErrorCode>> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  409: 'SERVER_ERROR',
  413: 'PAYLOAD_TOO_LARGE',
  429: 'RATE_LIMITED',
  500: 'SERVER_ERROR',
  502: 'SERVER_ERROR',
  503: 'SERVICE_UNAVAILABLE',
  504: 'GATEWAY_TIMEOUT',
};

/**
 * Get retry-after milliseconds from various sources.
 *
 * Checks:
 * 1. AppError details.retryAfterMs
 * 2. Response headers (Retry-After)
 * 3. Default based on error type
 *
 * @returns Milliseconds to wait before retry, or undefined if not applicable
 */
function getRetryAfterMs(
  error: AppError,
  res: Response,
  batchCode: BatchErrorCode
): number | undefined {
  // Check AppError details first
  if (error.details && typeof error.details === 'object' && 'retryAfterMs' in error.details) {
    const retryAfterMs = (error.details as Record<string, unknown>).retryAfterMs;
    if (typeof retryAfterMs === 'number' && retryAfterMs > 0) {
      return retryAfterMs;
    }
  }

  // Check response headers (from rate limiter middleware)
  const retryAfterHeader = res.getHeader('Retry-After');
  if (retryAfterHeader) {
    const seconds = parseInt(String(retryAfterHeader), 10);
    if (!isNaN(seconds) && seconds > 0) {
      return seconds * 1000; // Convert to milliseconds
    }
  }

  // Default delays for specific error types
  if (batchCode === 'RATE_LIMITED') {
    return 60000; // 1 minute default for rate limiting
  }

  if (batchCode === 'SERVICE_UNAVAILABLE') {
    return 30000; // 30 seconds for service unavailable
  }

  // No retry delay for other errors
  return undefined;
}

/**
 * Map an error to BatchErrorCode.
 *
 * Priority:
 * 1. AppError errorCode → BatchErrorCode mapping
 * 2. HTTP status code → BatchErrorCode mapping
 * 3. Default to 'SERVER_ERROR'
 */
function mapToBatchErrorCode(error: AppError): BatchErrorCode {
  // Try errorCode mapping first
  const fromErrorCode = ERROR_CODE_TO_BATCH_CODE[error.errorCode];
  if (fromErrorCode) {
    return fromErrorCode;
  }

  // Fall back to status code mapping
  const fromStatus = STATUS_CODE_TO_BATCH_CODE[error.statusCode];
  if (fromStatus) {
    return fromStatus;
  }

  // Default to SERVER_ERROR (retryable) for unknown errors
  return 'SERVER_ERROR';
}

// Health Error Handler Middleware

/**
 * Contract-compliant error response for health batch endpoints.
 *
 */
interface HealthBatchErrorResponse {
  success: false;
  error: {
    code: BatchErrorCode;
    message: string;
    retryable: boolean;
    retryAfterMs?: number;
    requestId?: string;
  };
}

/**
 * Factory function to create health-specific error handler middleware.
 *
 * This middleware transforms AppErrors into contract-compliant batch error responses.
 * It MUST be registered BEFORE the generic error handler for health routes.
 *
 * @param logger - LoggerService for structured logging
 * @returns Express error handler middleware
 *
 * @example
 * ```typescript
 * // In health.routes.ts
 * router.post('/samples/batch-upsert',
 *   validationMiddleware,
 *   controller.batchUpsert,
 * );
 *
 * // Apply health error handler for this router
 * router.use(createHealthErrorHandler(logger));
 * ```
 */
export function createHealthErrorHandler(logger: LoggerService) {
  return (err: Error, req: Request, res: Response, next: NextFunction): void => {
    // Only handle AppErrors - pass others to generic handler
    if (!(err instanceof AppError)) {
      return next(err);
    }

    const requestId = getRequestId(req);
    const correlationId = getCorrelationId(req);

    // Map to BatchErrorCode
    const batchCode = mapToBatchErrorCode(err);
    const retryable = BATCH_ERROR_RETRYABLE[batchCode];
    const retryAfterMs = getRetryAfterMs(err, res, batchCode);

    // Log with batch-specific context
    const logData = {
      context: 'health-error.middleware',
      path: req.path,
      method: req.method,
      statusCode: err.statusCode,
      appErrorCode: err.errorCode,
      batchErrorCode: batchCode,
      retryable,
      retryAfterMs,
      correlationId,
      requestId,
      isOperational: err.isOperational,
    };

    if (err.isOperational) {
      logger.warn(`Health API Error: ${err.message}`, logData);
    } else {
      logger.error('Health API Non-operational Error', {
        ...logData,
        stack: err.stack,
      });
    }

    // Build contract-compliant response
    const response: HealthBatchErrorResponse = {
      success: false,
      error: {
        code: batchCode,
        message: err.message,
        retryable,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        ...(requestId ? { requestId } : {}),
      },
    };

    // Set Retry-After header for rate limiting
    if (batchCode === 'RATE_LIMITED' && retryAfterMs) {
      res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000));
    }

    res.status(err.statusCode).json(response);
  };
}

/**
 * Export types for use in tests and other modules.
 */
export type { HealthBatchErrorResponse };
