/**
 * Base Repository Pattern Implementation
 * 
 * Provides abstraction layer between business logic (services) and data access (Prisma)
 * All repositories extend this base class to inherit common functionality:
 * - Transaction management
 * - Error handling with AppError
 * - Pagination support
 * - Input validation
 * - Common CRUD operations
 * 
 * Architecture: Controller → Service → Repository → Prisma → Database
 * 
 * @see https://docs.microsoft.com/en-us/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/infrastructure-persistence-layer-design
 */

import { PrismaClient } from '@prisma/client';
import { LoggerService } from '../services/logger.service';
import { AppError, ErrorCodes } from '../utils/AppError';
import {
  getErrorMessage,
  getErrorStack,
  isPrismaError,
  isError,
} from '../utils/error-handler';
import type { ZodError } from 'zod';

/**
 * Prisma error interface with code and meta properties
 */
interface PrismaErrorWithCode {
  code: string;
  meta?: Record<string, unknown>;
  message: string;
  clientVersion?: string;
}

/**
 * Type for Prisma transaction client (used in executeTransaction method)
 * Using Prisma.TransactionClient for the correct transaction client type
 */
type TransactionClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

/**
 * Zod schema interface for validation
 * Properly typed with ZodError instead of any
 */
interface ValidationSchema<T> {
  safeParse: (data: unknown) => {
    success: boolean;
    data?: T;
    error?: ZodError;
  };
}

/**
 * Pagination parameters for list operations
 */
export interface PaginationParams {
  page?: number;
  pageSize?: number;
  orderBy?: Record<string, 'asc' | 'desc'>;
}

/**
 * Standardized paginated response structure
 */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  totalPages: number;
}

/**
 * Cursor-based paginated response structure.
 *
 * DESIGN DIFFERENCES FROM PaginatedResponse:
 * - No `total` or `page` number (avoids expensive COUNT(*))
 * - Uses `hasMore` flag determined by limit+1 technique
 * - `nextCursor` is the opaque token for fetching next page
 *
 * PERFORMANCE:
 * - O(log n) via B-tree index traversal regardless of page depth
 * - No COUNT(*) query (which scales O(n) with table size)
 *
 * USAGE:
 * - Client sends `cursor` param to get next page
 * - Client loops until `hasMore` is false
 * - `nextCursor` is null when no more pages
 *
 * @see https://use-the-index-luke.com/no-offset for keyset pagination rationale
 */
export interface CursorPaginatedResponse<T> {
  /** Array of items for current page */
  items: T[];
  /** Cursor pagination metadata */
  pagination: {
    /** Number of items requested per page */
    limit: number;
    /** Whether there are more items after this page */
    hasMore: boolean;
    /** Cursor to fetch next page (null if no more pages) */
    nextCursor: string | null;
  };
}

/**
 * Configuration for repository-level retry behavior
 */
interface RepositoryRetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Default retry configuration for repository operations
 * Used for handling transient Neon database failures
 */
const DEFAULT_REPOSITORY_RETRY_CONFIG: RepositoryRetryConfig = {
  maxRetries: 2, // Fewer retries at repository level (service layer may also retry)
  baseDelayMs: 500,
  maxDelayMs: 5000,
};

/**
 * Error codes that indicate transient database failures
 * These errors are safe to retry automatically
 */
const RETRYABLE_PRISMA_ERROR_CODES = new Set([
  'P1001', // Can't reach database server
  'P1002', // Connection timed out
  'P1008', // Operations timed out
  'P1017', // Server has closed the connection
  'P2024', // Connection pool timeout
]);

/**
 * Base repository class providing common database operations
 * All domain-specific repositories must extend this class
 */
export abstract class BaseRepository<T> {
  protected prisma: PrismaClient;
  protected logger: LoggerService;
  protected entityName: string;
  protected retryConfig: RepositoryRetryConfig;

  /**
   * Initialize base repository with Prisma client and entity name
   * @param prisma - Prisma client instance from DatabaseService
   * @param entityName - Name of the entity for logging (e.g., 'User', 'Consumption')
   * @param logger - Logger service instance
   * @param retryConfig - Optional retry configuration for transient failures
   */
  constructor(
    prisma: PrismaClient,
    entityName: string,
    logger: LoggerService,
    retryConfig?: Partial<RepositoryRetryConfig>,
  ) {
    this.prisma = prisma;
    this.logger = logger;
    this.entityName = entityName;
    this.retryConfig = { ...DEFAULT_REPOSITORY_RETRY_CONFIG, ...retryConfig };
  }

  /**
   * Handle database errors and convert to AppError
   * Provides consistent error handling across all repositories
   *
   * @param error - Unknown error from database operation
   * @param methodName - Name of the method where error occurred
   * @param options - Optional error handling options
   * @param options.isOptimisticUpdate - If true, P2025 errors are treated as version conflicts (409) instead of not found (404)
   * @throws AppError with appropriate status code and message
   */
  protected handleError(error: unknown, methodName: string, options?: { isOptimisticUpdate?: boolean }): never {
    this.logger.error(`Repository error in ${methodName} for ${this.entityName}`, {
      context: `${this.entityName}Repository.${methodName}`,
      error: getErrorMessage(error),
      stack: getErrorStack(error),
      entityName: this.entityName,
    });

    // If already an AppError, re-throw it
    if (error instanceof AppError) {
      throw error;
    }

    // Handle Prisma-specific errors
    if (isPrismaError(error)) {
      // Type guard to ensure error has Prisma-specific properties
      const prismaError = error as unknown as PrismaErrorWithCode;

      // Handle common Prisma error codes
      switch (prismaError.code) {
        case 'P2002': // Unique constraint violation
          throw new AppError(
            409,
            ErrorCodes.DUPLICATE_ENTRY,
            `${this.entityName} with these details already exists`,
            true,
            { prismaCode: prismaError.code, meta: prismaError.meta, methodName },
            prismaError,
          );

        case 'P2025': // Record not found OR optimistic locking version conflict
          // Context-aware handling: P2025 during optimistic updates means version mismatch (409 CONFLICT)
          if (options?.isOptimisticUpdate) {
            throw new AppError(
              409,
              ErrorCodes.CONFLICT,
              `${this.entityName} was modified by another request. Please refresh and try again.`,
              true,
              { prismaCode: prismaError.code, meta: prismaError.meta, methodName },
              prismaError,
            );
          }
          // Default: P2025 means resource not found (404 NOT_FOUND)
          throw new AppError(
            404,
            ErrorCodes.NOT_FOUND,
            `${this.entityName} not found`,
            true,
            { prismaCode: prismaError.code, meta: prismaError.meta, methodName },
            prismaError,
          );

        case 'P2003': // Foreign key constraint violation
          throw new AppError(
            400,
            ErrorCodes.VALIDATION_ERROR,
            `Invalid reference in ${this.entityName}`,
            true,
            { prismaCode: prismaError.code, meta: prismaError.meta, methodName },
            prismaError,
          );

        case 'P2004': // Database constraint failed
          throw new AppError(
            400,
            ErrorCodes.VALIDATION_ERROR,
            `Database constraint failed for ${this.entityName}`,
            true,
            { prismaCode: prismaError.code, meta: prismaError.meta, methodName },
            prismaError,
          );

        case 'P2011': // Null constraint violation
          throw new AppError(
            400,
            ErrorCodes.VALIDATION_ERROR,
            `Null constraint violation in ${this.entityName}`,
            true,
            { prismaCode: prismaError.code, meta: prismaError.meta, methodName },
            prismaError,
          );

        case 'P2014': // Required relation violation
          throw new AppError(
            400,
            ErrorCodes.VALIDATION_ERROR,
            `Missing required relation for ${this.entityName}`,
            true,
            { prismaCode: prismaError.code, meta: prismaError.meta, methodName },
            prismaError,
          );

        // CONNECTION ERRORS (P1xxx) - Transient, Retryable
        // These indicate infrastructure/network issues, not application bugs
        // Mark as operational (true) to allow retry logic
        case 'P1001': // Can't reach database server
          throw new AppError(
            503,
            ErrorCodes.SERVICE_UNAVAILABLE,
            `Database server unreachable while processing ${this.entityName}. This is a transient error.`,
            true, // Operational - safe to retry
            { prismaCode: prismaError.code, meta: prismaError.meta, methodName, retryable: true },
            prismaError,
          );

        case 'P1002': // Database connection timed out
          throw new AppError(
            503,
            ErrorCodes.SERVICE_UNAVAILABLE,
            `Database connection timed out while processing ${this.entityName}. This is a transient error.`,
            true, // Operational - safe to retry
            { prismaCode: prismaError.code, meta: prismaError.meta, methodName, retryable: true },
            prismaError,
          );

        case 'P1008': // Database operation timed out
          throw new AppError(
            503,
            ErrorCodes.SERVICE_UNAVAILABLE,
            `Database operation timed out while processing ${this.entityName}. This is a transient error.`,
            true, // Operational - safe to retry
            { prismaCode: prismaError.code, meta: prismaError.meta, methodName, retryable: true },
            prismaError,
          );

        case 'P1017': // Server has closed the connection
          throw new AppError(
            503,
            ErrorCodes.SERVICE_UNAVAILABLE,
            `Database connection closed unexpectedly while processing ${this.entityName}. This is a transient error.`,
            true, // Operational - safe to retry
            { prismaCode: prismaError.code, meta: prismaError.meta, methodName, retryable: true },
            prismaError,
          );

        case 'P2024': // Connection pool timeout
          throw new AppError(
            503,
            ErrorCodes.SERVICE_UNAVAILABLE,
            `Database connection pool exhausted while processing ${this.entityName}. This is a transient error.`,
            true, // Operational - safe to retry
            { prismaCode: prismaError.code, meta: prismaError.meta, methodName, retryable: true },
            prismaError,
          );

        // SCHEMA DRIFT ERRORS (P2021, P2022) - Deployment Bugs
        // These indicate the Prisma schema is out of sync with the physical database.
        // Typically caused by a pending migration that hasn't been applied via
        // `npx prisma migrate deploy`. NOT operational — requires deployment action.
        case 'P2021': // Table does not exist in the database
        case 'P2022': // Column does not exist in the database
          {
            const missingEntity = prismaError.code === 'P2021' ? 'table' : 'column';
            this.logger.error(`Schema drift detected for ${this.entityName}.${methodName}: ${missingEntity} does not exist (${prismaError.code})`, {
              context: `${this.entityName}Repository.${methodName}`,
              prismaCode: prismaError.code,
              meta: prismaError.meta,
              message: prismaError.message,
              hint: 'The Prisma schema references a table/column that does not exist in the database. Run `npx prisma migrate deploy` to apply pending migrations.',
            });
            throw new AppError(
              500,
              ErrorCodes.DATABASE_ERROR,
              `Schema drift: a ${missingEntity} referenced by ${this.entityName} does not exist in the database. A pending migration may need to be applied.`,
              false, // NOT operational — deployment bug, not user error
              { prismaCode: prismaError.code, meta: prismaError.meta, methodName, hint: 'Run npx prisma migrate deploy' },
              prismaError,
            );
          }

        case 'P2010': // Raw query failed (wraps underlying DB error)
          // P2010 typically indicates a bug in raw SQL (wrong column name, syntax error,
          // missing type). Surface the underlying PostgreSQL error for diagnostics.
          this.logger.error(`Raw query failed for ${this.entityName}.${methodName}`, {
            context: `${this.entityName}Repository.${methodName}`,
            prismaCode: prismaError.code,
            meta: prismaError.meta,
            message: prismaError.message,
            hint: 'Check raw SQL for column name mismatches (@map directives), missing enum types, or syntax errors',
          });
          throw new AppError(
            500,
            ErrorCodes.DATABASE_ERROR,
            `Raw query failed for ${this.entityName}: ${prismaError.meta && typeof prismaError.meta === 'object' && 'message' in prismaError.meta ? (prismaError.meta as Record<string, unknown>).message : prismaError.message}`,
            false,
            { prismaCode: prismaError.code, meta: prismaError.meta, methodName },
            prismaError,
          );

        default:
          // Log the unhandled Prisma error code for observability
          this.logger.warn(`Unhandled Prisma error code: ${prismaError.code}`, {
            context: `${this.entityName}Repository.${methodName}`,
            prismaCode: prismaError.code,
            meta: prismaError.meta,
          });
          throw new AppError(
            500,
            ErrorCodes.DATABASE_ERROR,
            `Database error (${prismaError.code}) while processing ${this.entityName}`,
            false,
            { prismaCode: prismaError.code, meta: prismaError.meta, methodName },
            prismaError,
          );
      }
    }

    // Handle generic errors
    if (isError(error)) {
      throw new AppError(
        500,
        ErrorCodes.INTERNAL_SERVER_ERROR,
        `Failed to ${methodName} ${this.entityName}: ${error.message}`,
        false,
        { errorName: error.name, errorMessage: error.message },
        error,
      );
    }

    // Unknown error type
    throw new AppError(
      500,
      ErrorCodes.INTERNAL_SERVER_ERROR,
      `An unexpected error occurred while processing ${this.entityName}`,
      false,
      { methodName, entityName: this.entityName, errorType: typeof error },
      error,
    );
  }

  /**
   * Calculate pagination parameters for database queries
   * 
   * @param page - Page number (1-indexed)
   * @param pageSize - Number of items per page
   * @returns Skip and take values for Prisma query
   */
  protected getPaginationParams(page: number = 1, pageSize: number = 20): { skip: number; take: number } {
    // Ensure valid page and pageSize
    const validPage = Math.max(1, page);
    const validPageSize = Math.min(100, Math.max(1, pageSize)); // Cap at 100 items per page
    
    const skip = (validPage - 1) * validPageSize;
    return { skip, take: validPageSize };
  }

  /**
   * Execute a database operation within a transaction
   * Provides automatic rollback on error
   *
   * @param operation - Async function containing database operations
   * @returns Result of the transaction
   * @throws AppError if transaction fails
   */
  protected async executeTransaction<R>(
    operation: (tx: TransactionClient) => Promise<R>,
  ): Promise<R> {
    try {
      this.logger.debug(`Starting transaction for ${this.entityName}`, {
        context: `${this.entityName}Repository.executeTransaction`,
      });

      // Prisma.$transaction provides a transaction client that matches TransactionClient type
      // The type assertion is necessary due to Prisma's complex conditional types
      const result = await this.prisma.$transaction(async (tx) => {
        return await operation(tx as TransactionClient);
      });

      this.logger.debug(`Transaction completed successfully for ${this.entityName}`, {
        context: `${this.entityName}Repository.executeTransaction`,
      });

      return result;
    } catch (error) {
      this.logger.error(`Transaction failed for ${this.entityName}`, {
        context: `${this.entityName}Repository.executeTransaction`,
        error: getErrorMessage(error),
      });

      throw this.handleError(error, 'executeTransaction');
    }
  }

  /**
   * Generic paginated query execution
   * Handles both data fetching and total count in a single transaction
   *
   * @param findManyFn - Function to fetch paginated data
   * @param countFn - Function to count total records
   * @param params - Pagination parameters with optional Prisma query options
   * @returns Paginated response with metadata
   */
  protected async findManyWithPagination<Q extends Record<string, unknown>, C extends Record<string, unknown>>(
    findManyFn: (args: Q) => Promise<T[]>,
    countFn: (args: C) => Promise<number>,
    params: PaginationParams & {
      where?: unknown;
      include?: unknown;
      select?: unknown;
    },
  ): Promise<PaginatedResponse<T>> {
    try {
      const { page = 1, pageSize = 20, orderBy, where = {}, include, select } = params;
      const paginationParams = this.getPaginationParams(page, pageSize);

      // Execute count and data fetch in parallel for better performance
      // Build query args object with type-safe spreading
      const queryArgs: Record<string, unknown> = {
        where,
        ...paginationParams,
      };

      if (orderBy) {
        queryArgs.orderBy = orderBy;
      }
      if (include !== undefined) {
        queryArgs.include = include;
      }
      if (select !== undefined) {
        queryArgs.select = select;
      }

      const [items, total] = await Promise.all([
        findManyFn(queryArgs as Q),
        countFn({ where } as unknown as C),
      ]);

      return {
        items,
        total,
        page,
        pageSize,
        hasMore: page * pageSize < total,
        totalPages: Math.ceil(total / pageSize),
      };
    } catch (error) {
      throw this.handleError(error, 'findManyWithPagination');
    }
  }

  /**
   * Validate input data using Zod schema
   *
   * @param data - Data to validate
   * @param schema - Zod schema for validation (properly typed with ZodError)
   * @param operation - Operation name for error messages
   * @returns Validated data
   * @throws AppError if validation fails
   */
  protected validateInput<V>(
    data: unknown,
    schema: ValidationSchema<V>,
    operation: string,
  ): V {
    const result = schema.safeParse(data);

    if (!result.success) {
      // Extract Zod error details for logging and error response
      const errorDetails = result.error?.errors
        ? result.error.errors.map(err => ({
            path: err.path.join('.'),
            message: err.message,
            code: err.code,
          }))
        : undefined;

      this.logger.warn(`Validation failed for ${operation} in ${this.entityName}`, {
        context: `${this.entityName}Repository.validateInput`,
        errors: errorDetails,
      });

      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `Invalid data provided for ${operation}`,
        true,
        errorDetails,
      );
    }

    return result.data as V;
  }

  /**
   * Build a WHERE clause with soft delete support
   * Automatically filters out soft-deleted records unless explicitly included
   *
   * @param where - Original where clause (Prisma where object)
   * @param includeSoftDeleted - Whether to include soft-deleted records
   * @returns Modified where clause with soft delete filter if applicable
   */
  protected buildWhereClause(
    where: Record<string, unknown> = {},
    includeSoftDeleted: boolean = false,
  ): Record<string, unknown> {
    if (!includeSoftDeleted && this.supportsSoftDelete()) {
      return {
        ...where,
        deletedAt: null,
      };
    }
    return where;
  }

  /**
   * Enforce user ownership by merging userId into where clause
   * SECURITY: Ensures all queries for user-owned entities are scoped to the requesting user
   * This prevents accidental cross-user data exposure when userId is omitted from queries
   *
   * @param where - Prisma where clause (can be empty object)
   * @param userId - User ID to enforce (must be non-empty)
   * @returns Where clause with userId enforced
   * @throws AppError if userId is missing or invalid
   *
   * @example
   * // Usage in findById method
   * async findById(id: string, userId: string): Promise<Entity | null> {
   *   const where = this._enforceUserOwnership({ id }, userId);
   *   return await this.prisma.entity.findFirst({ where });
   * }
   *
   * @example
   * // Usage with additional filters
   * async findByStatus(status: string, userId: string): Promise<Entity[]> {
   *   const where = this._enforceUserOwnership({ status }, userId);
   *   return await this.prisma.entity.findMany({ where });
   * }
   */
  protected _enforceUserOwnership<W extends Record<string, unknown>>(
    where: W,
    userId: string
  ): W & { userId: string } {
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        'userId is required for user-owned entity operations',
        true,
        { entityName: this.entityName, providedUserId: userId }
      );
    }

    return { ...where, userId } as W & { userId: string };
  }

  /**
   * Check if the entity supports soft delete
   * Override in child classes if entity has deletedAt field
   *
   * @returns Whether the entity supports soft delete
   */
  protected supportsSoftDelete(): boolean {
    return false; // Override in child classes if needed
  }

  /**
   * Format entity for response
   * Can be overridden in child classes to customize response format
   * 
   * @param entity - Raw entity from database
   * @returns Formatted entity
   */
  protected formatEntity(entity: T): T {
    return entity;
  }

  /**
   * Log successful operation
   * Provides consistent logging across all repositories
   *
   * @param operation - Operation name
   * @param details - Additional details to log (arbitrary key-value pairs)
   */
  protected logSuccess(operation: string, details?: Record<string, unknown>): void {
    this.logger.info(`${this.entityName} ${operation} successful`, {
      context: `${this.entityName}Repository.${operation}`,
      entityName: this.entityName,
      ...details,
    });
  }

  /**
   * Get current timestamp for createdAt/updatedAt fields
   * Ensures consistent timestamp format across all repositories
   * 
   * @returns Current timestamp
   */
  protected getCurrentTimestamp(): Date {
    return new Date();
  }

  /**
   * Build select clause for optimized queries
   * Helps prevent over-fetching data
   * 
   * @param fields - Fields to select
   * @returns Select clause for Prisma query
   */
  protected buildSelectClause(fields: string[]): Record<string, boolean> {
    return fields.reduce((acc, field) => {
      acc[field] = true;
      return acc;
    }, {} as Record<string, boolean>);
  }

  /**
   * Check if an error is a retryable transient database error
   * 
   * @param error - Error to check
   * @returns true if the error is transient and safe to retry
   */
  protected isRetryableError(error: unknown): boolean {
    // Check for Prisma error codes
    if (error && typeof error === 'object' && 'code' in error) {
      const prismaError = error as { code: string };
      if (RETRYABLE_PRISMA_ERROR_CODES.has(prismaError.code)) {
        return true;
      }
    }

    // Check for connection-related error messages
    const errorMessage = getErrorMessage(error).toLowerCase();
    const retryablePatterns = [
      'connection',
      'timeout',
      'pool',
      'econnreset',
      'etimedout',
      'socket',
      'network',
      'closed',
      'terminated',
      'can\'t reach',
    ];

    return retryablePatterns.some(pattern => errorMessage.includes(pattern));
  }

  /**
   * Execute a database operation with automatic retry for transient failures
   * Optimized for Neon serverless database characteristics (cold starts, pool exhaustion)
   * 
   * @param operation - Async function containing the database operation
   * @param operationName - Name of operation for logging
   * @returns Result of the operation
   * @throws Original error if not retryable or all retries exhausted
   */
  protected async executeWithRetry<R>(
    operation: () => Promise<R>,
    operationName: string,
  ): Promise<R> {
    let lastError: unknown;
    
    for (let attempt = 1; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        const result = await operation();
        
        // Log recovery from transient failure
        if (attempt > 1) {
          this.logger.info(`${this.entityName} ${operationName} succeeded after retry`, {
            context: `${this.entityName}Repository.${operationName}`,
            attempt,
            recoveredFromTransientError: true,
          });
        }
        
        return result;
      } catch (error) {
        lastError = error;
        const isRetryable = this.isRetryableError(error);
        const isLastAttempt = attempt === this.retryConfig.maxRetries;
        
        if (!isRetryable || isLastAttempt) {
          // Non-retryable or exhausted retries - let handleError process it
          throw error;
        }
        
        // Calculate delay with exponential backoff + jitter
        const baseDelay = Math.min(
          this.retryConfig.baseDelayMs * Math.pow(2, attempt - 1),
          this.retryConfig.maxDelayMs,
        );
        const jitter = Math.random() * 0.3 * baseDelay;
        const delay = Math.floor(baseDelay + jitter);
        
        this.logger.warn(`${this.entityName} ${operationName} failed with transient error, retrying`, {
          context: `${this.entityName}Repository.${operationName}`,
          attempt,
          maxRetries: this.retryConfig.maxRetries,
          error: getErrorMessage(error),
          nextRetryInMs: delay,
          hint: 'Neon database may be waking up or connection pool recovering',
        });
        
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    // Should never reach here, but TypeScript requires it
    throw lastError;
  }
}
