/**
 * Error Handling Utilities
 *
 * Comprehensive type-safe error handling for TypeScript strict mode.
 * Provides utilities to safely extract error information from unknown error types
 * and specific checks for common error patterns (Anthropic API, Prisma, AbortError, etc.)
 */

// Type Definitions

/**
 * Error with a name property (most JavaScript errors)
 */
interface ErrorWithName {
  name: string;
  message?: string;
}

/**
 * Error with a code property (Anthropic API errors, Prisma errors)
 */
interface ErrorWithCode {
  code: string;
  message?: string;
}

/**
 * Error with HTTP status (API errors)
 */
interface ErrorWithStatus {
  status: number;
  message?: string;
}

/**
 * Error with constructor name (API errors)
 */
interface ErrorWithConstructor {
  constructor: {
    name: string;
  };
  message?: string;
}

/**
 * Extract error details for tracking
 */
export interface ErrorDetails {
  code: string;
  name: string;
  message: string;
  status?: number;
}

// Type Guards

/**
 * Type guard to check if an error is an Error instance
 */
export function isError(error: unknown): error is Error {
  return error instanceof Error;
}

/**
 * Type guard to check if an error has a message property
 */
export function hasMessage(error: unknown): error is { message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as Record<string, unknown>).message === 'string'
  );
}

/**
 * Type guard to check if an error has a stack property
 */
export function hasStack(error: unknown): error is { stack: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'stack' in error &&
    typeof (error as Record<string, unknown>).stack === 'string'
  );
}

/**
 * Type guard to check if an error has a code property (for Prisma errors)
 */
export function hasErrorCode(error: unknown): error is { code: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as Record<string, unknown>).code === 'string'
  );
}

/**
 * Check if an error is a Prisma error (has code starting with 'P')
 */
export function isPrismaError(error: unknown): error is { code: string } {
  return hasErrorCode(error) && error.code.startsWith('P');
}

/**
 * Extended error type with optional code and nested error properties
 * Used for BullMQ/ioredis errors that include additional error context
 */
export interface ExtendedError extends Error {
  code?: string;
  originalError?: Error & { code?: string };
}

/**
 * Type guard to check if an error has extended properties (code or originalError)
 */
export function isExtendedError(error: unknown): error is ExtendedError {
  return (
    isError(error) &&
    (hasErrorCode(error) || ('originalError' in error && isError((error as Record<string, unknown>).originalError)))
  );
}

/**
 * Safely extract error code from extended error or its nested originalError
 */
export function getExtendedErrorCode(error: unknown): string | undefined {
  if (!isError(error)) return undefined;

  const extError = error as ExtendedError;
  if (extError.code) return extError.code;
  if (extError.originalError?.code) return extError.originalError.code;

  return undefined;
}

/**
 * Check if error is an AbortError (timeout/cancellation)
 */
export function isAbortError(error: unknown): error is ErrorWithName {
  return getErrorName(error) === 'AbortError';
}

/**
 * Check if error is an Anthropic API Error
 */
export function isAnthropicAPIError(error: unknown): error is ErrorWithConstructor & ErrorWithStatus {
  return getErrorConstructorName(error) === 'APIError';
}

/**
 * Check if error is a rate limit error (429)
 */
export function isRateLimitError(error: unknown): error is ErrorWithStatus {
  return getErrorStatus(error, 0) === 429;
}

// Error Property Extractors

/**
 * Safely get error message from unknown error type
 */
export function getErrorMessage(error: unknown): string {
  if (isError(error)) {
    return error.message;
  }
  if (hasMessage(error)) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'An unknown error occurred';
}

/**
 * Safely get error stack from unknown error type
 */
export function getErrorStack(error: unknown): string | undefined {
  if (isError(error)) {
    return error.stack;
  }
  if (hasStack(error)) {
    return error.stack;
  }
  return undefined;
}

/**
 * Safely get error name from unknown error
 */
export function getErrorName(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error && typeof error.name === 'string') {
    return error.name;
  }
  return 'UnknownError';
}

/**
 * Safely get error code from unknown error
 */
export function getErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'UNKNOWN_ERROR';
}

/**
 * Safely get HTTP status from unknown error
 */
export function getErrorStatus(error: unknown, defaultStatus: number = 500): number {
  if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') {
    return error.status;
  }
  return defaultStatus;
}

/**
 * Safely get constructor name from unknown error
 */
export function getErrorConstructorName(error: unknown): string {
  if (error && typeof error === 'object' && 'constructor' in error && error.constructor && 'name' in error.constructor) {
    return String(error.constructor.name);
  }
  return 'Unknown';
}

// Error Conversion & Formatting

/**
 * Safely convert unknown error to Error instance
 */
export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(getErrorMessage(error));
}

/**
 * Format error for logging with safe property access
 */
export function formatErrorForLogging(error: unknown): {
  message: string;
  stack?: string;
  details?: unknown;
} {
  return {
    message: getErrorMessage(error),
    stack: getErrorStack(error),
    details: error,
  };
}

/**
 * Extract all available error details from unknown error
 */
export function extractErrorDetails(error: unknown): ErrorDetails {
  return {
    code: getErrorCode(error),
    name: getErrorName(error),
    message: getErrorMessage(error),
    status: error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
      ? error.status
      : undefined,
  };
}

// Error Handlers

/**
 * Handle catch block errors safely
 */
export function handleError(error: unknown, logger?: { error: (msg: string, data?: Record<string, unknown>) => void }): void {
  const errorInfo = formatErrorForLogging(error);
  if (logger) {
    logger.error('An error occurred', errorInfo);
  } else {
    console.error('An error occurred', errorInfo);
  }
}
