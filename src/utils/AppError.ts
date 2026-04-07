/**
 * AppError Class
 * Standardized error handling for API responses
 * 
 * This class extends Error to provide:
 * - HTTP status codes
 * - Application-specific error codes
 * - Operational vs programming error distinction
 * - Safe error messages for client responses
 */

export const ErrorCodes = {
  // Authentication & Authorization (4xx)
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
  INVALID_INPUT: 'INVALID_INPUT', // Invalid request payload

  // Resource Errors
  DUPLICATE_ENTRY: 'DUPLICATE_ENTRY',
  DUPLICATE_REQUEST: 'DUPLICATE_REQUEST', // Idempotency conflict
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  ACCESS_DENIED: 'ACCESS_DENIED',
  
  // Business Logic Errors
  INVALID_OPERATION: 'INVALID_OPERATION',
  INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',

  // Purchase & Inventory Pipeline Errors
  PREDICTION_INSUFFICIENT_DATA: 'PREDICTION_INSUFFICIENT_DATA',
  INVENTORY_NOT_FOUND: 'INVENTORY_NOT_FOUND',
  INVENTORY_DEPLETED: 'INVENTORY_DEPLETED',
  INVENTORY_MISSING: 'INVENTORY_MISSING', // Purchase has no inventory items (legacy data integrity)
  PURCHASE_ALREADY_FINISHED: 'PURCHASE_ALREADY_FINISHED',
  ACTIVE_PURCHASE_EXISTS: 'ACTIVE_PURCHASE_EXISTS', // Single-active-per-product enforcement

  // Google OAuth Token Validation Errors
  GOOGLE_TOKEN_EXPIRED: 'GOOGLE_TOKEN_EXPIRED',
  GOOGLE_TOKEN_TOO_OLD: 'GOOGLE_TOKEN_TOO_OLD',
  GOOGLE_TOKEN_INVALID_ISSUER: 'GOOGLE_TOKEN_INVALID_ISSUER',
  GOOGLE_TOKEN_AUDIENCE_MISMATCH: 'GOOGLE_TOKEN_AUDIENCE_MISMATCH',
  GOOGLE_TOKEN_VALIDATION_FAILED: 'GOOGLE_TOKEN_VALIDATION_FAILED',
  GOOGLE_TOKEN_NO_PAYLOAD: 'GOOGLE_TOKEN_NO_PAYLOAD',

  // Health Pipeline Validation Errors
  PAYLOAD_HASH_MISMATCH: 'PAYLOAD_HASH_MISMATCH',
  CONFIG_VERSION_TOO_NEW: 'CONFIG_VERSION_TOO_NEW',
  
  // Server Errors (5xx)
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
  DATABASE_ERROR: 'DATABASE_ERROR',
  EXTERNAL_SERVICE_ERROR: 'EXTERNAL_SERVICE_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  RATE_LIMITED: 'RATE_LIMITED', // Queue backpressure — caller should retry after delay
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

/**
 * Type for Prisma-specific errors that include code and meta properties
 */
type PrismaError = Error & { code?: string; meta?: unknown };

/**
 * Structure for original error information in development mode
 */
interface OriginalErrorInfo {
  name?: string;
  message?: string;
  stack?: string;
  code?: string;
  meta?: unknown;
  raw?: string;
}

/**
 * Structure for JSON error responses
 */
interface ErrorResponse {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown> | Array<unknown>;
  originalError?: OriginalErrorInfo;
}

/**
 * Custom error class for handling API-specific errors with status codes
 *
 * @example
 * throw new AppError(404, ErrorCodes.NOT_FOUND, 'Product not found');
 *
 * @example
 * throw new AppError(409, ErrorCodes.DUPLICATE_ENTRY, 'A product with this name already exists');
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: ErrorCode;
  public readonly isOperational: boolean;
  public readonly details?: Record<string, unknown> | Array<unknown>;
  public readonly originalError?: unknown;

  constructor(
    statusCode: number,
    errorCode: ErrorCode,
    message: string,
    isOperational: boolean = true,
    details?: Record<string, unknown> | Array<unknown>,
    originalError?: unknown,
  ) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.isOperational = isOperational;
    this.details = details;
    this.originalError = originalError;

    // Ensures the name of this error is the same as the class name
    this.name = this.constructor.name;

    // Captures the stack trace for debugging
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Factory method for validation errors
   */
  static validation(message: string, details?: Record<string, unknown> | Array<unknown>, originalError?: unknown): AppError {
    return new AppError(400, ErrorCodes.VALIDATION_ERROR, message, true, details, originalError);
  }

  /**
   * Factory method for authentication errors
   */
  static unauthorized(message: string = 'Unauthorized', originalError?: unknown): AppError {
    return new AppError(401, ErrorCodes.UNAUTHORIZED, message, true, undefined, originalError);
  }

  /**
   * Factory method for forbidden access errors
   */
  static forbidden(message: string = 'Forbidden', originalError?: unknown): AppError {
    return new AppError(403, ErrorCodes.FORBIDDEN, message, true, undefined, originalError);
  }

  /**
   * Factory method for not found errors
   */
  static notFound(resource: string, originalError?: unknown): AppError {
    return new AppError(404, ErrorCodes.NOT_FOUND, `${resource} not found`, true, undefined, originalError);
  }

  /**
   * Factory method for conflict errors
   */
  static conflict(message: string, originalError?: unknown): AppError {
    return new AppError(409, ErrorCodes.CONFLICT, message, true, undefined, originalError);
  }

  /**
   * Factory method for internal server errors
   */
  static internal(message: string = 'Internal server error', details?: Record<string, unknown> | Array<unknown>, originalError?: unknown): AppError {
    return new AppError(500, ErrorCodes.INTERNAL_SERVER_ERROR, message, false, details, originalError);
  }

  /**
   * Factory method for database errors
   */
  static database(message: string = 'Database operation failed', details?: Record<string, unknown> | Array<unknown>, originalError?: unknown): AppError {
    return new AppError(500, ErrorCodes.DATABASE_ERROR, message, false, details, originalError);
  }

  /**
   * Factory method for external service errors
   */
  static externalService(service: string, details?: Record<string, unknown> | Array<unknown>, originalError?: unknown): AppError {
    return new AppError(
      502,
      ErrorCodes.EXTERNAL_SERVICE_ERROR,
      `External service ${service} failed`,
      false,
      details,
      originalError,
    );
  }

  /**
   * Factory method for service unavailable errors
   */
  static serviceUnavailable(message: string = 'Service temporarily unavailable', originalError?: unknown): AppError {
    return new AppError(503, ErrorCodes.SERVICE_UNAVAILABLE, message, true, undefined, originalError);
  }

  /**
   * Factory method for configuration errors
   */
  static configuration(message: string, details?: Record<string, unknown> | Array<unknown>, originalError?: unknown): AppError {
    return new AppError(500, ErrorCodes.CONFIGURATION_ERROR, message, false, details, originalError);
  }

  /**
   * Factory method for precondition/validation failures
   * Used when a required condition or state is not met before an operation
   */
  static precondition(message: string, details?: Record<string, unknown> | Array<unknown>): AppError {
    return new AppError(400, ErrorCodes.VALIDATION_ERROR, message, true, details);
  }

  /**
   * Factory method for prediction insufficient data errors (422).
   * Used when ML prediction cannot be generated due to insufficient consumption history.
   */
  static predictionInsufficientData(
    message: string = 'Insufficient consumption data for prediction',
    details?: { requiredDataPoints?: number; availableDataPoints?: number; missingDataType?: string },
  ): AppError {
    return new AppError(422, ErrorCodes.PREDICTION_INSUFFICIENT_DATA, message, true, details);
  }

  /**
   * Factory method for inventory not found errors (404).
   * Used when no inventory item exists for a given purchase or product.
   */
  static inventoryNotFound(message: string = 'Inventory item not found'): AppError {
    return new AppError(404, ErrorCodes.INVENTORY_NOT_FOUND, message, true);
  }

  /**
   * Factory method for inventory depleted errors (422).
   * Used when inventory quantity is zero and cannot be decremented further.
   */
  static inventoryDepleted(message: string = 'Inventory is depleted'): AppError {
    return new AppError(422, ErrorCodes.INVENTORY_DEPLETED, message, true);
  }

  /**
   * Factory method for inventory missing errors (409).
   * Used when a purchase has no inventory items (legacy data integrity issue).
   */
  static inventoryMissing(
    message: string = 'Purchase inventory items are missing',
    details?: Record<string, unknown>,
  ): AppError {
    return new AppError(409, ErrorCodes.INVENTORY_MISSING, message, true, details);
  }

  /**
   * Factory method for purchase already finished errors (409).
   * Idempotent: returns conflict when trying to finish an already-finished purchase.
   * Details always sent to client so frontend can identify the purchase.
   */
  static purchaseAlreadyFinished(purchaseId: string): AppError {
    return new AppError(
      409,
      ErrorCodes.PURCHASE_ALREADY_FINISHED,
      `Purchase ${purchaseId} is already finished`,
      true,
      { purchaseId },
    );
  }

  /**
   * Factory method for active purchase exists errors (409).
   * Used when a user tries to create a second active purchase for the same product.
   * Details always sent to client so frontend can offer append/end workflow.
   */
  static activePurchaseExists(
    productId: string,
    existingPurchaseId: string,
    details: {
      existingPurchaseId: string;
      productId: string;
      quantityPurchased: string;
      costSpent: string;
      estimatedRemainingQuantity?: string;
      purchaseDate: string;
    },
  ): AppError {
    return new AppError(
      409,
      ErrorCodes.ACTIVE_PURCHASE_EXISTS,
      `An active purchase already exists for product ${productId}`,
      true,
      details,
    );
  }

  /**
   * Error codes whose details are ALWAYS included in the API response,
   * regardless of NODE_ENV. These carry data the frontend needs for
   * user-facing decisions (e.g., append-vs-end dialog, missing inventory UI).
   */
  private static readonly ALWAYS_INCLUDE_DETAILS_CODES: ReadonlySet<ErrorCode> = new Set([
    ErrorCodes.PREDICTION_INSUFFICIENT_DATA,
    ErrorCodes.ACTIVE_PURCHASE_EXISTS,
    ErrorCodes.INVENTORY_MISSING,
    ErrorCodes.PURCHASE_ALREADY_FINISHED,
    ErrorCodes.INVENTORY_DEPLETED,
    ErrorCodes.INVENTORY_NOT_FOUND,
  ]);

  /**
   * Convert AppError to JSON for API responses
   */
  toJSON(): ErrorResponse {
    const result: ErrorResponse = {
      code: this.errorCode,
      message: this.message,
    };

    // Always include details for user-facing errors where frontend needs actionable data
    if (AppError.ALWAYS_INCLUDE_DETAILS_CODES.has(this.errorCode) && this.details) {
      result.details = this.details;
    }

    // Include other details only in development mode
    if (process.env.NODE_ENV === 'development') {
      if (this.details && !AppError.ALWAYS_INCLUDE_DETAILS_CODES.has(this.errorCode)) {
        result.details = this.details;
      }

      // Include original error information for enhanced debugging
      if (this.originalError) {
        const originalErrorInfo: OriginalErrorInfo = {};

        if (this.originalError instanceof Error) {
          originalErrorInfo.name = this.originalError.name;
          originalErrorInfo.message = this.originalError.message;
          originalErrorInfo.stack = this.originalError.stack;

          // Include Prisma-specific error details if available
          if ('code' in this.originalError && 'meta' in this.originalError) {
            const prismaErr = this.originalError as PrismaError;
            originalErrorInfo.code = prismaErr.code;
            originalErrorInfo.meta = prismaErr.meta;
          }
        } else {
          // For non-Error objects, serialize as much as possible
          try {
            originalErrorInfo.raw = JSON.stringify(this.originalError);
          } catch {
            originalErrorInfo.raw = String(this.originalError);
          }
        }

        result.originalError = originalErrorInfo;
      }
    }

    return result;
  }
}

/**
 * Utility function to determine if an error is operational
 * Operational errors are expected errors that should be handled gracefully
 */
export function isOperationalError(error: Error): boolean {
  if (error instanceof AppError) {
    return error.isOperational;
  }
  return false;
}
