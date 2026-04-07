/**
 * Database Type Definitions
 * 
 * Common types used across all repositories for database operations.
 * These types provide a consistent interface for:
 * - Database operation responses
 * - Pagination parameters
 * - Error handling
 * - Transaction management
 * 
 * @module DatabaseTypes
 */


/**
 * Pagination options for list operations
 * Used to control result set size and ordering
 */
export interface PaginationOptions {
  page?: number;
  pageSize?: number;
  offset?: number;  // Starting position for query results
  limit?: number;   // Maximum number of results to return
  orderBy?: Record<string, 'asc' | 'desc'>;
  where?: Record<string, unknown>;
}

/**
 * Paginated response structure
 * Wraps paginated data with metadata about the result set
 * 
 * @template T - The type of items in the result set
 */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  totalPages: number;
  offset?: number;
}

/**
 * Database transaction options
 * Controls transaction behavior and isolation levels
 */
export interface TransactionOptions {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: 'ReadUncommitted' | 'ReadCommitted' | 'RepeatableRead' | 'Serializable';
}

/**
 * Bulk operation result
 * Reports success/failure counts for batch operations
 */
export interface BulkOperationResult<T> {
  successful: T[];
  failed: Array<{
    item: Partial<T>;
    error: string;
  }>;
  totalProcessed: number;
  successCount: number;
  failureCount: number;
}

/**
 * Query filter options
 * Common filtering parameters for database queries
 */
export interface QueryFilter {
  startDate?: Date;
  endDate?: Date;
  userId?: string;
  deviceId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

/**
 * Sort options for queries
 */
export interface SortOptions {
  field: string;
  direction: 'asc' | 'desc';
}

/**
 * Aggregation result structure
 */
export interface AggregationResult {
  count?: number;
  sum?: number;
  avg?: number;
  min?: number;
  max?: number;
  groupBy?: Record<string, unknown>;
}

/**
 * Database connection status
 */
export interface ConnectionStatus {
  connected: boolean;
  database: string;
  host?: string;
  port?: number;
  poolSize?: number;
  activeConnections?: number;
}

/**
 * Repository operation metadata
 * Tracks performance and debugging information
 */
export interface OperationMetadata {
  executionTime: number;
  affectedRows?: number;
  query?: string;
  params?: unknown[];
  cached?: boolean;
}