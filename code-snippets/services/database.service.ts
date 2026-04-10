/**
 * Database Service
 * Handles database connections, transactions, and common database operations
 *
 *  MODERN DI PATTERN: Pure constructor injection
 * - No singleton getInstance() pattern
 * - Instantiated once in bootstrap.ts (composition root)
 * - Injected as dependency where needed
 */

import { PrismaClient, Prisma } from '@prisma/client';
import { LoggerService } from './logger.service';
import { S3Service } from './s3.service';
import { spawn } from 'child_process';
import { promisify } from 'util';
import { getErrorMessage } from '../utils/error-handler';
import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * Configuration for retry behavior on transient database errors
 */
export interface DatabaseRetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableErrors: string[];
}

/**
 * Default retry configuration for Neon serverless database
 * Optimized for handling connection pool exhaustion and cold starts
 */
const DEFAULT_RETRY_CONFIG: DatabaseRetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  // Neon-specific and general PostgreSQL transient error codes
  retryableErrors: [
    'P1001', // Can't reach database server
    'P1002', // Connection timed out
    'P1008', // Operations timed out
    'P1017', // Server has closed the connection
    'P2024', // Connection pool timeout
    '57014', // Query cancelled due to statement_timeout
    '57P01', // Admin shutdown
    '57P02', // Crash shutdown
    '57P03', // Cannot connect now
    '08000', // Connection exception
    '08003', // Connection does not exist
    '08006', // Connection failure
    'ECONNRESET', // Connection reset by peer
    'ETIMEDOUT', // Connection timed out
    'ENOTFOUND', // DNS lookup failed
  ],
};

export class DatabaseService {
  private prisma: PrismaClient;
  private isConnected: boolean = false;
  private connectionHealthy: boolean = false;
  private lastHealthCheckTime: number = 0;
  private healthCheckIntervalMs: number = 30000; // 30 seconds
  private readonly retryConfig: DatabaseRetryConfig;

  /**
   * Constructor with pure dependency injection
   * @param logger - LoggerService instance for logging
   * @param s3Service - S3Service instance for backup operations
   * @param retryConfig - Optional retry configuration for transient failures
   */
  public constructor(
    private logger: LoggerService,
    private s3Service: S3Service,
    retryConfig?: Partial<DatabaseRetryConfig>,
  ) {
    if (!logger) {
      throw new Error('DatabaseService: LoggerService dependency is required');
    }
    if (!s3Service) {
      throw new Error('DatabaseService: S3Service dependency is required');
    }

    // Merge custom retry config with defaults
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };

    // Initialize PrismaClient with logging configuration
    this.prisma = new PrismaClient({
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'info' },
        { emit: 'event', level: 'warn' },
      ],
      errorFormat: 'pretty',
    });

    this.setupEventHandlers();
    
    this.logger.info('DatabaseService initialized with Neon-optimized retry config', {
      context: 'DatabaseService',
      retryConfig: this.retryConfig,
    });
  }

  private setupEventHandlers(): void {
    // Query logging in development
    if (process.env.NODE_ENV === 'development') {
      this.prisma.$on('query' as never, (e: Prisma.QueryEvent) => {
        this.logger.debug('Query', {
          query: e.query,
          params: e.params,
          duration: e.duration,
        });
      });
    }

    // Error logging
    this.prisma.$on('error' as never, (e: Prisma.LogEvent) => {
      this.logger.error('Database error', e);
    });

    // Warning logging
    this.prisma.$on('warn' as never, (e: Prisma.LogEvent) => {
      this.logger.warn('Database warning', e);
    });
  }

  public async connect(): Promise<void> {
    const maxRetries = 3;
    const retryDelay = 2000; // 2 seconds base delay

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.logger.info('Attempting database connection', {
          attempt,
          maxRetries,
          note: attempt === 1 ? 'Neon database may be waking from suspended state' : undefined
        });

        // Neon databases can take 5-10 seconds to wake from suspension
        // Using $connect with retry logic to handle wake-up delay
        await this.prisma.$connect();

        this.isConnected = true;
        this.logger.info('Database connected successfully', {
          attempt,
          connectionStatus: 'active'
        });
        return;
      } catch (error: unknown) {
        const isLastAttempt = attempt === maxRetries;
        const waitTime = retryDelay * attempt; // Exponential backoff

        this.logger.warn('Database connection attempt failed', {
          attempt,
          maxRetries,
          error: getErrorMessage(error),
          willRetry: !isLastAttempt,
          nextRetryIn: !isLastAttempt ? `${waitTime}ms` : undefined,
          hint: 'Neon database may be suspended - waiting for wake-up'
        });

        if (isLastAttempt) {
          this.logger.error('Failed to connect to database after all retries', {
            attempts: maxRetries,
            error: getErrorMessage(error),
            troubleshooting: [
              'Check if DATABASE_URL is correct',
              'Verify Neon database is active (may be suspended)',
              'Check network connectivity',
              'Review Neon dashboard for database status'
            ]
          });
          throw error;
        }

        // Wait before retry with exponential backoff
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }

  public async disconnect(): Promise<void> {
    try {
      await this.prisma.$disconnect();
      this.isConnected = false;
      this.logger.info('Database disconnected successfully');
    } catch (error) {
      this.logger.error('Failed to disconnect from database', error);
      throw error;
    }
  }

  public getClient(): PrismaClient {
    if (!this.isConnected) {
      throw new AppError(
        500,
        ErrorCodes.DATABASE_ERROR,
        'Database is not connected',
      );
    }
    return this.prisma;
  }

  public async transaction<T>(
    fn: (prisma: PrismaClient) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(
        async (tx) => fn(tx as PrismaClient),
        {
          maxWait: options?.maxWait || 5000,
          timeout: options?.timeout || 10000,
        },
      );
    } catch (error) {
      this.logger.error('Transaction failed', error);
      throw error;
    }
  }

  public async healthCheck(): Promise<boolean> {
    try {
      const startTime = Date.now();
      await this.prisma.$queryRaw`SELECT 1`;
      const duration = Date.now() - startTime;
      
      this.connectionHealthy = true;
      this.lastHealthCheckTime = Date.now();
      
      // Log slow health checks (potential connection issues)
      if (duration > 1000) {
        this.logger.warn('Database health check slow', {
          context: 'DatabaseService',
          durationMs: duration,
          warning: 'Connection may be degraded - Neon may be waking up',
        });
      }
      
      return true;
    } catch (error) {
      this.connectionHealthy = false;
      this.logger.error('Health check failed', {
        context: 'DatabaseService',
        error: getErrorMessage(error),
        hint: 'Neon database may be suspended or connection pool exhausted',
      });
      return false;
    }
  }

  /**
   * Check if an error is retryable (transient)
   * @param error - The error to check
   * @returns true if the error is retryable
   */
  public isRetryableError(error: unknown): boolean {
    const errorMessage = getErrorMessage(error);
    const errorCode = this.extractErrorCode(error);
    
    // Check if error code matches any retryable error
    for (const retryableCode of this.retryConfig.retryableErrors) {
      if (errorCode === retryableCode || errorMessage.includes(retryableCode)) {
        return true;
      }
    }
    
    // Additional heuristic checks for connection-related errors
    const connectionErrorPatterns = [
      'connection',
      'timeout',
      'pool',
      'ECONNRESET',
      'ETIMEDOUT',
      'socket',
      'network',
      'can\'t reach',
      'closed',
      'terminated',
    ];
    
    const lowerMessage = errorMessage.toLowerCase();
    return connectionErrorPatterns.some(pattern => lowerMessage.includes(pattern));
  }

  /**
   * Extract error code from various error types
   * @private
   */
  private extractErrorCode(error: unknown): string {
    if (error && typeof error === 'object') {
      const errorObj = error as Record<string, unknown>;
      // Prisma error code
      if ('code' in errorObj && typeof errorObj.code === 'string') {
        return errorObj.code;
      }
      // PostgreSQL error code
      if ('errorCode' in errorObj && typeof errorObj.errorCode === 'string') {
        return errorObj.errorCode;
      }
      // Node.js error code
      if ('errno' in errorObj && typeof errorObj.errno === 'string') {
        return errorObj.errno;
      }
    }
    return '';
  }

  /**
   * Execute a database operation with retry logic for transient failures
   * Optimized for Neon serverless database characteristics
   * 
   * @param operation - Async function containing the database operation
   * @param operationName - Name of operation for logging
   * @param customRetryConfig - Optional custom retry config for this operation
   * @returns Result of the operation
   */
  public async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    customRetryConfig?: Partial<DatabaseRetryConfig>,
  ): Promise<T> {
    const config = { ...this.retryConfig, ...customRetryConfig };
    let lastError: unknown;
    
    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
      try {
        const result = await operation();
        
        // Log recovery if this wasn't the first attempt
        if (attempt > 1) {
          this.logger.info('Database operation succeeded after retry', {
            context: 'DatabaseService',
            operation: operationName,
            attempt,
            recoveredFromTransientError: true,
          });
        }
        
        return result;
      } catch (error) {
        lastError = error;
        const isRetryable = this.isRetryableError(error);
        const isLastAttempt = attempt === config.maxRetries;
        
        if (!isRetryable || isLastAttempt) {
          // Non-retryable error or exhausted retries - fail fast
          this.logger.error('Database operation failed', {
            context: 'DatabaseService',
            operation: operationName,
            attempt,
            maxRetries: config.maxRetries,
            isRetryable,
            error: getErrorMessage(error),
            errorCode: this.extractErrorCode(error),
            failedPermanently: true,
          });
          throw error;
        }
        
        // Calculate delay with exponential backoff + jitter
        const baseDelay = Math.min(
          config.baseDelayMs * Math.pow(2, attempt - 1),
          config.maxDelayMs,
        );
        const jitter = Math.random() * 0.3 * baseDelay; // ±15% jitter
        const delay = Math.floor(baseDelay + jitter);
        
        this.logger.warn('Database operation failed, retrying', {
          context: 'DatabaseService',
          operation: operationName,
          attempt,
          maxRetries: config.maxRetries,
          error: getErrorMessage(error),
          errorCode: this.extractErrorCode(error),
          nextRetryInMs: delay,
          hint: 'Neon database may be waking up or connection pool recovering',
        });
        
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    // Should never reach here, but TypeScript requires it
    throw lastError;
  }

  /**
   * Get connection health status without performing a query
   * Uses cached health check result for performance
   */
  public getConnectionStatus(): { healthy: boolean; lastCheckTime: number; stale: boolean } {
    const now = Date.now();
    const stale = now - this.lastHealthCheckTime > this.healthCheckIntervalMs;
    
    return {
      healthy: this.connectionHealthy,
      lastCheckTime: this.lastHealthCheckTime,
      stale,
    };
  }

  // Raw SQL query method for compatibility with existing controllers
  public async query<T = unknown>(sql: string, params?: unknown[]): Promise<T> {
    try {
      // Convert parameterized query to Prisma raw query format
      if (params && params.length > 0) {
        // Replace $1, $2, etc. with actual values for Prisma
        let processedSql = sql;
        params.forEach((param, index) => {
          const placeholder = `$${index + 1}`;
          // Properly escape and format the parameter
          const value = param === null ? 'NULL' :
                       typeof param === 'string' ? `'${String(param).replace(/'/g, "''")}'` :
                       typeof param === 'object' ? `'${JSON.stringify(param).replace(/'/g, "''")}'` :
                       String(param);
          processedSql = processedSql.replace(placeholder, String(value));
        });
        return await this.prisma.$queryRawUnsafe(processedSql) as T;
      } else {
        return await this.prisma.$queryRawUnsafe(sql) as T;
      }
    } catch (error) {
      this.logger.error('Query execution failed', { sql, params, error });
      throw error;
    }
  }

  // Utility method for pagination
  public getPaginationParams(page: number = 1, pageSize: number = 20) {
    const skip = (page - 1) * pageSize;
    return {
      skip,
      take: pageSize,
    };
  }

  // Utility method for handling soft deletes
  public getSoftDeleteFilter(includeDeleted: boolean = false) {
    if (includeDeleted) {
      return {};
    }
    return {
      deletedAt: null,
    };
  }

  // Utility method for search queries
  public getSearchFilter(searchTerm?: string, fields: string[] = []) {
    if (!searchTerm || fields.length === 0) {
      return {};
    }

    return {
      OR: fields.map((field) => ({
        [field]: {
          contains: searchTerm,
          mode: 'insensitive',
        },
      })),
    };
  }

  // Utility method for date range filters
  public getDateRangeFilter(
    field: string,
    startDate?: Date,
    endDate?: Date,
  ) {
    const filter: Record<string, unknown> = {};

    if (startDate && endDate) {
      filter[field] = {
        gte: startDate,
        lte: endDate,
      };
    } else if (startDate) {
      filter[field] = {
        gte: startDate,
      };
    } else if (endDate) {
      filter[field] = {
        lte: endDate,
      };
    }

    return filter;
  }

  // Performance monitoring
  public async getConnectionPoolStats(): Promise<unknown> {
    // Prisma metrics API - may not be available in all versions
    const prismaWithMetrics = this.prisma as PrismaClient & {
      $metrics?: { json: () => unknown }
    };
    return prismaWithMetrics.$metrics?.json();
  }

  // Migration helpers
  public async runMigrations(): Promise<void> {
    this.logger.info('Running database migrations...');
    // This would typically be run via CLI: npx prisma migrate deploy
    // Keeping this as a placeholder for programmatic migration if needed
  }

  public async seed(): Promise<void> {
    this.logger.info('Seeding database...');
    // Implement database seeding logic here
  }

  /**
   * Refresh a materialized view in PostgreSQL
   * Used for analytics performance optimization
   * 
   * @param viewName - Name of the materialized view to refresh
   * @param concurrently - Whether to refresh concurrently (default: true)
   * @returns Promise resolving when refresh is complete
   */
  public async refreshMaterializedView(
    viewName: string, 
    concurrently: boolean = true,
  ): Promise<void> {
    try {
      this.logger.info('Refreshing materialized view', {
        context: 'DatabaseService',
        viewName,
        concurrently,
      });

      // Validate view name to prevent SQL injection
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(viewName)) {
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          'Invalid materialized view name format',
        );
      }

      const refreshCommand = concurrently 
        ? `REFRESH MATERIALIZED VIEW CONCURRENTLY "${viewName}"`
        : `REFRESH MATERIALIZED VIEW "${viewName}"`;

      const startTime = Date.now();
      await this.prisma.$executeRawUnsafe(refreshCommand);
      const duration = Date.now() - startTime;

      this.logger.info('Materialized view refreshed successfully', {
        context: 'DatabaseService',
        viewName,
        concurrently,
        durationMs: duration,
      });

    } catch (error) {
      this.logger.error('Failed to refresh materialized view', {
        context: 'DatabaseService',
        viewName,
        concurrently,
        error: getErrorMessage(error),
        stack: (error as Error).stack,
      });

      throw new AppError(
        500,
        ErrorCodes.DATABASE_ERROR,
        `Failed to refresh materialized view ${viewName}: ${getErrorMessage(error)}`,
      );
    }
  }

  /**
   * Create a materialized view in PostgreSQL
   * Used for analytics performance optimization
   * 
   * @param viewName - Name of the materialized view to create
   * @param query - SQL query for the materialized view
   * @param createUniqueIndex - Whether to create a unique index for concurrent refreshes
   * @returns Promise resolving when view is created
   */
  public async createMaterializedView(
    viewName: string,
    query: string,
    createUniqueIndex?: { columns: string[]; indexName?: string },
  ): Promise<void> {
    try {
      this.logger.info('Creating materialized view', {
        context: 'DatabaseService',
        viewName,
        withIndex: !!createUniqueIndex,
      });

      // Validate view name to prevent SQL injection
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(viewName)) {
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          'Invalid materialized view name format',
        );
      }

      // Create materialized view
      const createCommand = `CREATE MATERIALIZED VIEW "${viewName}" AS ${query}`;
      await this.prisma.$executeRawUnsafe(createCommand);

      // Create unique index for concurrent refreshes if requested
      if (createUniqueIndex && createUniqueIndex.columns.length > 0) {
        const indexName = createUniqueIndex.indexName || `${viewName}_unique_idx`;
        const columns = createUniqueIndex.columns.join(', ');
        const indexCommand = `CREATE UNIQUE INDEX "${indexName}" ON "${viewName}" (${columns})`;
        await this.prisma.$executeRawUnsafe(indexCommand);
      }

      this.logger.info('Materialized view created successfully', {
        context: 'DatabaseService',
        viewName,
        withIndex: !!createUniqueIndex,
      });

    } catch (error) {
      this.logger.error('Failed to create materialized view', {
        context: 'DatabaseService',
        viewName,
        error: getErrorMessage(error),
        stack: (error as Error).stack,
      });

      throw new AppError(
        500,
        ErrorCodes.DATABASE_ERROR,
        `Failed to create materialized view ${viewName}: ${getErrorMessage(error)}`,
      );
    }
  }

  /**
   * Drop a materialized view in PostgreSQL
   * 
   * @param viewName - Name of the materialized view to drop
   * @param ifExists - Whether to use IF EXISTS clause (default: true)
   * @returns Promise resolving when view is dropped
   */
  public async dropMaterializedView(
    viewName: string,
    ifExists: boolean = true,
  ): Promise<void> {
    try {
      this.logger.info('Dropping materialized view', {
        context: 'DatabaseService',
        viewName,
        ifExists,
      });

      // Validate view name to prevent SQL injection
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(viewName)) {
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          'Invalid materialized view name format',
        );
      }

      const dropCommand = ifExists
        ? `DROP MATERIALIZED VIEW IF EXISTS "${viewName}"`
        : `DROP MATERIALIZED VIEW "${viewName}"`;

      await this.prisma.$executeRawUnsafe(dropCommand);

      this.logger.info('Materialized view dropped successfully', {
        context: 'DatabaseService',
        viewName,
      });

    } catch (error) {
      this.logger.error('Failed to drop materialized view', {
        context: 'DatabaseService',
        viewName,
        error: getErrorMessage(error),
        stack: (error as Error).stack,
      });

      throw new AppError(
        500,
        ErrorCodes.DATABASE_ERROR,
        `Failed to drop materialized view ${viewName}: ${getErrorMessage(error)}`,
      );
    }
  }

  /**
   * Performs a PostgreSQL database backup using pg_dump and uploads to S3
   * Uses the existing S3Service.uploadDatabaseBackup() method
   * 
   * @param options Backup options
   * @returns S3 URL of the backup file
   */
  public async performPgDumpBackup(options?: {
    correlationId?: string;
    customFormat?: boolean;
    compress?: boolean;
    includeData?: boolean;
  }): Promise<string> {
    const correlationId = options?.correlationId || `backup_${Date.now()}`;
    
    try {
      this.logger.info('Starting PostgreSQL database backup', {
        context: 'DatabaseService',
        correlationId,
      });

      // Validate environment variables
      const dbUrl = process.env.DATABASE_URL;
      if (!dbUrl) {
        throw new AppError(
          500,
          ErrorCodes.CONFIGURATION_ERROR,
          'DATABASE_URL environment variable not configured',
        );
      }

      // Parse DATABASE_URL to extract connection details
      const url = new URL(dbUrl);
      const dbConfig = {
        host: url.hostname,
        port: url.port || '5432',
        database: url.pathname.slice(1), // Remove leading '/'
        username: url.username,
        password: url.password,
      };

      // Build pg_dump command arguments (secure - no command injection)
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `pg_backup_${timestamp}`;
      const tempFilePath = `/tmp/${filename}.dump`;
      
      // Build arguments array - prevents command injection
      const pgDumpArgs = [
        '--host', dbConfig.host,
        '--port', dbConfig.port,
        '--username', dbConfig.username,
        '--dbname', dbConfig.database,
        '--file', tempFilePath,
        '--no-password', // Don't prompt for password (use PGPASSWORD env var)
        '--verbose',
        '--no-owner',
        '--no-privileges', // Avoid ownership issues
      ];
      
      // Add format options
      if (options?.customFormat !== false) {
        pgDumpArgs.push('--format=custom'); // Custom format (compressed by default)
      }
      
      if (options?.includeData !== false) {
        pgDumpArgs.push('--data-only', '--inserts'); // Include data with INSERT statements
      } else {
        pgDumpArgs.push('--schema-only'); // Schema only
      }

      // Log command for debugging (safely - no password exposure)
      this.logger.info('Executing pg_dump command', {
        context: 'DatabaseService',
        correlationId,
        args: pgDumpArgs.map(arg => arg.includes(dbConfig.password || '') ? '***' : arg),
      });

      // Set password environment variable for pg_dump
      const env = { 
        ...process.env, 
        PGPASSWORD: dbConfig.password, 
      };

      // Execute pg_dump securely using spawn (prevents command injection)
      const stderr = await this.executeSecurePgDump('pg_dump', pgDumpArgs, {
        env,
        timeout: 30 * 60 * 1000, // 30 minutes
      });

      if (stderr) {
        this.logger.warn('pg_dump produced stderr output', {
          context: 'DatabaseService',
          correlationId,
          stderr: stderr.substring(0, 1000), // First 1000 chars only
        });
      }

      // Read the backup file
      const fs = require('fs').promises;
      let backupBuffer = await fs.readFile(tempFilePath);

      // Compress if requested
      if (options?.compress) {
        const zlib = require('zlib');
        backupBuffer = zlib.gzipSync(backupBuffer);
      }

      // Clean up temp file
      await fs.unlink(tempFilePath).catch(() => {}); // Ignore errors

      this.logger.info('Database backup completed, uploading to S3', {
        context: 'DatabaseService',
        correlationId,
        backupSize: backupBuffer.length,
        compressed: !!options?.compress,
      });

      // Upload to S3 using existing S3Service
      const backupResult = await this.s3Service.uploadDatabaseBackup({
        backupType: 'postgresql',
        data: backupBuffer,
        filename: `${filename}${options?.compress ? '.gz' : ''}.dump`,
        metadata: {
          correlationId,
          pgVersion: 'latest',
          customFormat: String(options?.customFormat !== false),
          compressed: String(!!options?.compress),
          includeData: String(options?.includeData !== false),
          backupDate: new Date().toISOString(),
        },
        retention: 30, // Keep for 30 days
      });

      // Prune old backups (keep last 7)
      await this.s3Service.pruneOldBackups('postgresql', 7);

      this.logger.info('Database backup completed successfully', {
        context: 'DatabaseService',
        correlationId,
        s3Key: backupResult.key,
        s3Size: backupResult.size,
      });

      return backupResult.url;

    } catch (error) {
      this.logger.error('Database backup failed', {
        context: 'DatabaseService',
        correlationId,
        error: getErrorMessage(error),
        stack: (error as Error).stack,
      });
      throw new AppError(
        500,
        ErrorCodes.DATABASE_ERROR,
        `Database backup failed: ${getErrorMessage(error)}`,
      );
    }
  }

  /**
   * Test backup functionality with a small schema-only backup
   * Use this for validation during deployment
   */
  public async testBackupFunctionality(): Promise<{ success: boolean; url?: string; error?: string }> {
    try {
      const url = await this.performPgDumpBackup({
        correlationId: `test_${Date.now()}`,
        includeData: false, // Schema only for test
        compress: true,
        customFormat: true,
      });
      
      return { success: true, url };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  }

  /**
   * Execute pg_dump securely using spawn to prevent command injection
   * @private
   */
  private executeSecurePgDump(
    command: string, 
    args: string[], 
    options: { env: NodeJS.ProcessEnv; timeout: number },
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let stderrData = '';
      let timeoutId: NodeJS.Timeout;

      // Create spawn process with argument array (secure)
      const pgDumpProcess = spawn(command, args, {
        env: options.env,
        stdio: ['device', 'device', 'device'], // stdin, stdout, stderr
      });

      // Set up timeout
      timeoutId = setTimeout(() => {
        pgDumpProcess.kill('SIGTERM');
        reject(new Error(`pg_dump process timed out after ${options.timeout}ms`));
      }, options.timeout);

      // Collect stderr output
      pgDumpProcess.stderr?.on('data', (data: Buffer) => {
        stderrData += data.toString();
      });

      // Handle process completion
      pgDumpProcess.on('close', (code: number, signal: string) => {
        clearTimeout(timeoutId);
        
        if (signal) {
          reject(new Error(`pg_dump process was killed with signal: ${signal}`));
        } else if (code !== 0) {
          reject(new Error(`pg_dump process exited with code: ${code}\nStderr: ${stderrData}`));
        } else {
          resolve(stderrData); // Success - return stderr (warnings/info)
        }
      });

      // Handle process errors
      pgDumpProcess.on('error', (error: Error) => {
        clearTimeout(timeoutId);
        reject(new Error(`Failed to start pg_dump process: ${error.message}`));
      });

      // Handle spawn errors (e.g., command not found)
      pgDumpProcess.on('spawn', () => {
        // Process started successfully
      });
    });
  }
}