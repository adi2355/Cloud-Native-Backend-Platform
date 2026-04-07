/**
 * Cache Service
 * Provides Redis-based caching for improved performance
 */

/* eslint-disable no-undef */
import Redis, { Redis as RedisClient } from 'ioredis';
import { LoggerService } from './logger.service';
import * as crypto from 'crypto';
import { AppError, ErrorCodes } from '../utils/AppError';
import { getErrorMessage } from '../utils/error-handler';

interface CacheOptions {
  ttl?: number;
  tags?: string[];
  compress?: boolean;
}

interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  errors: number;
}

interface CacheServiceConfig {
  // Option 1: Use Redis URL (preferred for Render/cloud deployments)
  url?: string;
  // Option 2: Use individual components (fallback)
  host?: string;
  port?: number;
  username?: string; // Redis 6+ ACL username (Render managed Redis)
  password?: string;
  db?: number;
  keyPrefix?: string;
}

export class CacheService {
  private redis: RedisClient | null = null;
  private stats: CacheStats;
  private isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private config: CacheServiceConfig | null = null;
  private isInitialized: boolean = false;

  // Circuit breaker state for preventing log flooding when Redis is down
  private circuitBreakerState: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  private consecutiveFailures: number = 0;
  private lastFailureTime: number = 0;
  private static readonly CIRCUIT_FAILURE_THRESHOLD = 3;
  private static readonly CIRCUIT_RESET_TIMEOUT_MS = 60000; // 1 minute
  private lastLoggedWarning: number = 0;
  private static readonly LOG_THROTTLE_MS = 30000; // Log "Redis not connected" at most every 30 seconds

  /**
   * Constructor with explicit dependency injection
   * @param logger - LoggerService instance for internal logging
   */
  public constructor(
    private logger: LoggerService,
  ) {
    // Lightweight constructor - initializes stats tracking
    // Async Redis connection happens in configure() method
    this.stats = {
      events: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      errors: 0,
    };
  }

  /**
   * Check if we should attempt Redis operation based on circuit breaker state
   * Prevents log flooding and unnecessary connection attempts when Redis is down
   */
  private shouldAttemptOperation(): boolean {
    if (this.circuitBreakerState === 'CLOSED') {
      return true;
    }

    if (this.circuitBreakerState === 'OPEN') {
      // Check if enough time has passed to try again
      const timeSinceLastFailure = Date.now() - this.lastFailureTime;
      if (timeSinceLastFailure >= CacheService.CIRCUIT_RESET_TIMEOUT_MS) {
        this.circuitBreakerState = 'HALF_OPEN';
        this.logger.info('Cache circuit breaker entering HALF_OPEN state, attempting reconnection');
        return true;
      }
      return false;
    }

    // HALF_OPEN - allow one attempt
    return true;
  }

  /**
   * Record success for circuit breaker
   */
  private recordSuccess(): void {
    if (this.circuitBreakerState !== 'CLOSED') {
      this.logger.info('Cache circuit breaker CLOSED - Redis connection restored');
    }
    this.circuitBreakerState = 'CLOSED';
    this.consecutiveFailures = 0;
  }

  /**
   * Record failure for circuit breaker
   */
  private recordFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.consecutiveFailures >= CacheService.CIRCUIT_FAILURE_THRESHOLD) {
      if (this.circuitBreakerState !== 'OPEN') {
        this.logger.warn(`Cache circuit breaker OPEN after ${this.consecutiveFailures} consecutive failures`);
      }
      this.circuitBreakerState = 'OPEN';
    }
  }

  /**
   * Log Redis not connected warning with throttling to prevent log flooding
   */
  private logNotConnectedWarning(operation: string): void {
    const now = Date.now();
    if (now - this.lastLoggedWarning >= CacheService.LOG_THROTTLE_MS) {
      this.logger.warn(`Redis not connected, skipping cache ${operation}`);
      this.lastLoggedWarning = now;
    }
  }

  /**
   * Configure the service with secure configuration
   * Must be called before any cache operations
   */
  public async configure(config: CacheServiceConfig): Promise<void> {
    // Logger is already injected via constructor

    this.logger.info(' CacheService.configure() received config:', {
      context: 'CacheService',
      hasUrl: !!config.url,
      urlProtocol: config.url?.split('://')[0],
      host: config.host,
      port: config.port,
      hasUsername: !!config.username,
      hasPassword: !!config.password,
      db: config.db,
      keyPrefix: config.keyPrefix
    });

    this.config = config;

    this.logger.info(' CacheService.configure() stored this.config:', {
      context: 'CacheService',
      hasUrl: !!this.config.url,
      urlProtocol: this.config.url?.split('://')[0],
      host: this.config.host,
      port: this.config.port,
      hasUsername: !!this.config.username,
      hasPassword: !!this.config.password,
      db: this.config.db,
      keyPrefix: this.config.keyPrefix
    });

    await this.connect();
  }

  /**
   * Connect to Redis
   */
  private async connect(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    if (!this.config) {
      throw new AppError(
        503,
        ErrorCodes.SERVICE_UNAVAILABLE,
        'Cache service not configured',
      );
    }

    try {
      // Determine if TLS should be enabled based on connection type
      // - rediss:// URLs require TLS (managed Redis services like Render, AWS ElastiCache)
      // - redis:// URLs and localhost do NOT require TLS
      const requiresTls = this.config.url
        ? this.config.url.startsWith('rediss://')
        : this.isRemoteHost(this.config.host);

      // Common connection options for both URL and component-based connections
      // Reference: https://render.com/docs/connecting-to-redis-with-ioredis
      const commonOptions = {
        // TLS: Only enable for secure connections (rediss:// or remote managed services)
        // ioredis requires tls as ConnectionOptions object, not boolean
        // Empty object {} enables TLS with default Node.js TLS settings
        ...(requiresTls ? { tls: {} } : {}),
        retryStrategy: (times: number) => {
          if (times > this.maxReconnectAttempts) {
            this.logger.error('Max Redis reconnection attempts reached');
            return null;
          }
          const delay = Math.min(times * 50, 2000);
          this.reconnectAttempts = times;
          return delay;
        },
        enableReadyCheck: true,
        maxRetriesPerRequest: 1, // Reduced from 3 — circuit breaker handles retries at higher level; prevents retry amplification (3 retries × commandTimeout = long per command)
        connectTimeout: 10000,
        disconnectTimeout: 2000,
        commandTimeout: 2000, // Reduced from 5000: 2s is generous for any single Redis command; prevents 5s request blocking when Redis is degraded
        enableOfflineQueue: true,
      };

      // Create Redis connection using URL if provided, otherwise use individual components
      if (this.config.url) {
        // Use URL directly - ioredis supports Redis URLs natively
        this.logger.info('Connecting to Redis using URL', {
          url: this.config.url.replace(/:\/\/[^:]*:[^@]*@/, '://***:***@'), // Mask credentials
          tlsEnabled: requiresTls,
        });

        this.logger.debug('ioredis client connection options (CacheService):', {
          context: 'CacheService',
          method: 'url-direct',
          urlProtocol: this.config.url.split('://')[0],
          tlsEnabled: requiresTls,
          hasCredentials: this.config.url.includes('@'),
        });

        this.redis = new Redis(this.config.url, commonOptions);
      } else {
        // Use individual connection components
        const host = this.config.host || 'localhost';
        const port = this.config.port || 6379;

        this.logger.info('Connecting to Redis using individual components', {
          host,
          port,
          db: this.config.db || 0,
          hasUsername: !!this.config.username,
          tlsEnabled: requiresTls,
        });

        this.redis = new Redis({
          host,
          port,
          username: this.config.username, // Redis 6+ ACL username (Render managed Redis)
          password: this.config.password,
          db: this.config.db || 0,
          ...commonOptions,
        });
      }

      // This ensures other services see CacheService.isReady() === true
      await new Promise<void>((resolve, reject) => {
        let connectionTimeout: NodeJS.Timeout;

        const cleanup = () => {
          if (connectionTimeout) {
            clearTimeout(connectionTimeout);
          }
          this.redis!.removeAllListeners('connect');
          this.redis!.removeAllListeners('error');
        };

        // Set up connection timeout (15 seconds)
        connectionTimeout = setTimeout(() => {
          cleanup();
          reject(new Error('Redis connection timeout after 15 seconds'));
        }, 15000);

        // Wait for successful connection
        this.redis!.once('connect', () => {
          this.logger.info('Redis connected');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          cleanup();
          resolve();
        });

        // Handle connection errors
        this.redis!.once('error', (error: NodeJS.ErrnoException & { address?: string; port?: number }) => {
          this.logger.error('Redis connection error:', {
            message: error.message,
            code: error.code,
            errno: error.errno,
            syscall: error.syscall,
            address: error.address,
            port: error.port,
          });
          this.stats.errors++;
          this.isConnected = false;
          cleanup();
          reject(error);
        });
      });

      // Set up permanent event handlers after successful connection
      this.redis.on('error', (error: NodeJS.ErrnoException & { address?: string; port?: number }) => {
        this.logger.error('Redis error:', {
          message: error.message,
          code: error.code,
          errno: error.errno,
          syscall: error.syscall,
          address: error.address,
          port: error.port,
        });
        this.stats.errors++;
        this.isConnected = false;
      });

      this.redis.on('close', () => {
        this.logger.warn('Redis connection closed');
        this.isConnected = false;
      });

      this.redis.on('reconnecting', () => {
        this.logger.info(`Redis reconnecting... Attempt ${this.reconnectAttempts}`);
      });

      // The initial .once('connect') only fires once. When ioredis automatically reconnects
      // after a disconnection, we need this permanent handler to restore service capability.
      this.redis.on('connect', () => {
        if (!this.isConnected) {
          this.logger.info('Redis reconnected successfully');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          // Reset circuit breaker on successful reconnection
          this.recordSuccess();
        }
      });

      // Add 'ready' handler for when Redis is fully ready to accept commands
      // This fires after 'connect' and indicates Redis has completed any AUTH/SELECT commands
      this.redis.on('ready', () => {
        if (!this.isConnected) {
          this.logger.info('Redis ready to accept commands');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.recordSuccess();
        }
      });

      // Only mark as initialized after successful connection
      this.isInitialized = true;
      this.logger.info(' Redis connection established and ready for other services');
    } catch (error) {
      this.logger.error(`Failed to initialize Redis: ${getErrorMessage(error)}`, {
        context: 'CacheService.connect',
        errorType: error instanceof Error ? error.name : typeof error,
      });
      this.isConnected = false;
      throw error;
    }
  }

  /**
   * Get value from cache
   * Uses circuit breaker pattern to prevent log flooding when Redis is unavailable
   */
  public async get<T>(key: string): Promise<T | null> {
    // Circuit breaker check - avoid repeated connection attempts when Redis is down
    if (!this.shouldAttemptOperation()) {
      return null;
    }

    if (!this.isConnected) {
      this.logNotConnectedWarning('get');
      return null;
    }

    try {
      const data = await this.redis!.get(this.prefixKey(key));
      
      // Record success for circuit breaker
      this.recordSuccess();
      
      if (data) {
        this.stats.hits++;
        this.logger.debug(`Cache hit: ${key}`);
        return this.deserialize<T>(data);
      } else {
        this.stats.misses++;
        this.logger.debug(`Cache miss: ${key}`);
        return null;
      }
    } catch (error) {
      this.logger.error(`Cache get error for key ${key}: ${getErrorMessage(error)}`, {
        context: 'CacheService.get',
        key,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      this.stats.errors++;
      this.recordFailure();
      return null;
    }
  }

  /**
   * Get value from cache with a fast timeout on the critical request path.
   *
   * Uses Promise.race between the normal get() and a short timer. If Redis
   * doesn't respond within timeoutMs, returns null (cache miss) so the request
   * can proceed to the database without blocking.
   *
   * The underlying get() continues running in the background — its success/failure
   * still feeds the circuit breaker for Redis health tracking. The fast timeout
   * is purely request-level protection, not a health signal.
   *
   * @param key - Cache key to look up
   * @param timeoutMs - Maximum time to wait before treating as cache miss
   * @returns Cached value or null (miss or timeout)
   */
  public async getWithFastTimeout<T>(key: string, timeoutMs: number): Promise<T | null> {
    // Short-circuit: if circuit breaker is open or Redis is disconnected,
    // get() returns null immediately — no need for the race.
    if (!this.shouldAttemptOperation() || !this.isConnected) {
      return null;
    }

    let timeoutHandle: NodeJS.Timeout | undefined;
    let didTimeout = false;

    const timeoutPromise = new Promise<null>((resolve) => {
      timeoutHandle = setTimeout(() => {
        didTimeout = true;
        resolve(null);
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([
        this.get<T>(key),
        timeoutPromise,
      ]);

      if (didTimeout) {
        // Log for observability. The underlying get() is still pending and will
        // eventually complete (success → recordSuccess, or commandTimeout → recordFailure).
        // We do NOT call recordFailure() here because slow != down.
        this.logger.warn(`Cache GET exceeded fast timeout (${timeoutMs}ms), treating as miss`, {
          context: 'CacheService.getWithFastTimeout',
          key: key.length > 40 ? `${key.substring(0, 40)}...` : key,
          timeoutMs,
        });
      }

      return result;
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /**
   * Set value in cache
   * Uses circuit breaker pattern to prevent log flooding when Redis is unavailable
   */
  public async set<T = unknown>(key: string, value: T, options: CacheOptions = {}): Promise<boolean> {
    // Circuit breaker check - avoid repeated connection attempts when Redis is down
    if (!this.shouldAttemptOperation()) {
      return false;
    }

    if (!this.isConnected) {
      this.logNotConnectedWarning('set');
      return false;
    }

    try {
      const { ttl = 3600, tags = [] } = options;
      const prefixedKey = this.prefixKey(key);
      const serialized = this.serialize(value);

      if (ttl > 0) {
        await this.redis!.setex(prefixedKey, ttl, serialized);
      } else {
        await this.redis!.set(prefixedKey, serialized);
      }

      // Handle tags for cache invalidation
      if (tags.length > 0) {
        await this.addToTags(prefixedKey, tags);
      }

      // Record success for circuit breaker
      this.recordSuccess();
      
      this.stats.sets++;
      this.logger.debug(`Cache set: ${key} (TTL: ${ttl}s)`);
      return true;
    } catch (error) {
      this.logger.error(`Cache set error for key ${key}: ${getErrorMessage(error)}`, {
        context: 'CacheService.set',
        key,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      this.stats.errors++;
      this.recordFailure();
      return false;
    }
  }

  /**
   * Delete value from cache
   */
  public async delete(key: string): Promise<boolean> {
    if (!this.isConnected) {
      this.logger.warn('Redis not connected, skipping cache delete');
      return false;
    }

    try {
      const result = await this.redis!.del(this.prefixKey(key));
      this.stats.deletes++;
      this.logger.debug(`Cache delete: ${key}`);
      return result > 0;
    } catch (error) {
      this.logger.error(`Cache delete error for key ${key}: ${getErrorMessage(error)}`, {
        context: 'CacheService.delete',
        key,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      this.stats.errors++;
      this.recordFailure();
      return false;
    }
  }

  /**
   * Delete multiple keys by pattern
   */
  public async invalidate(pattern: string): Promise<number> {
    if (!this.isConnected) {
      this.logger.warn('Redis not connected, skipping cache invalidation');
      return 0;
    }

    try {
      const keys = await this.redis!.keys(this.prefixKey(pattern));
      
      if (keys.length === 0) {
        return 0;
      }

      const result = await this.redis!.del(...keys);
      this.stats.deletes += result;
      this.logger.debug(`Cache invalidated ${result} keys matching: ${pattern}`);
      return result;
    } catch (error) {
      this.logger.error(`Cache invalidation error for pattern ${pattern}: ${getErrorMessage(error)}`, {
        context: 'CacheService.invalidatePattern',
        pattern,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      this.stats.errors++;
      this.recordFailure();
      return 0;
    }
  }

  /**
   * Invalidate cache by tags
   *
   * Timestamps should be set BEFORE cache storage completes to prevent stale data.
   *
   * @param tags - Cache tags to invalidate
   * @param options - Optional configuration
   * @param options.skipTimestampUpdate - If true, skips setting invalidation timestamps.
   *   Use this when timestamps have already been set by the middleware at request start.
   *   This prevents duplicate Redis writes and improves performance.
   */
  public async invalidateByTags(
    tags: string[],
    options?: { skipTimestampUpdate?: boolean }
  ): Promise<number> {
    if (!this.isConnected) {
      return 0;
    }

    try {
      let totalDeleted = 0;

      // Only set timestamps if not already done by middleware
      // The middleware (createInvalidationMiddleware) sets timestamps at request START
      // to prevent race conditions. When called from middleware cleanup, skip this.
      if (!options?.skipTimestampUpdate) {
        await this.setInvalidationTimestamps(tags);
      }

      // Pipeline optimization: batch all SMEMBERS in one round trip, then batch all DELs in another.
      // Reduces round trips from 3*N (sequential) to 2 (pipelined), preventing commandTimeout under load.
      const membersPipeline = this.redis!.pipeline();
      const tagKeys: string[] = [];
      for (const tag of tags) {
        const tagKey = this.getTagKey(tag);
        tagKeys.push(tagKey);
        membersPipeline.smembers(tagKey);
      }
      const membersResults = await membersPipeline.exec();

      // Collect all cache keys and tag keys to delete
      const cacheKeysToDelete: string[] = [];
      const tagKeysToDelete: string[] = [];

      if (membersResults) {
        for (let i = 0; i < membersResults.length; i++) {
          const [error, members] = membersResults[i] as [Error | null, string[]];
          if (error || !members || members.length === 0) continue;
          const correspondingTagKey = tagKeys[i];
          if (!correspondingTagKey) continue; // Guard: tagKeys and membersResults are same length, but TS needs the check
          cacheKeysToDelete.push(...members);
          tagKeysToDelete.push(correspondingTagKey);
        }
      }

      // Delete all collected keys in a single pipeline round trip
      if (cacheKeysToDelete.length > 0 || tagKeysToDelete.length > 0) {
        const deletePipeline = this.redis!.pipeline();
        if (cacheKeysToDelete.length > 0) {
          deletePipeline.del(...cacheKeysToDelete);
        }
        if (tagKeysToDelete.length > 0) {
          deletePipeline.del(...tagKeysToDelete);
        }
        const deleteResults = await deletePipeline.exec();
        // Count only cache key deletions (first DEL command result), not tag key deletions
        if (deleteResults?.[0]) {
          const [delError, count] = deleteResults[0] as [Error | null, number];
          if (!delError && typeof count === 'number') {
            totalDeleted = count;
          }
        }
      }

      this.logger.debug(`Invalidated ${totalDeleted} keys by tags: ${tags.join(', ')}`);
      return totalDeleted;
    } catch (error) {
      this.logger.error(`Cache invalidation by tags error: ${getErrorMessage(error)}`, {
        context: 'CacheService.invalidateByTags',
        tags,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      this.stats.errors++;
      this.recordFailure();
      return 0;
    }
  }

  // CACHE INVALIDATION TIMESTAMP TRACKING
  // These methods handle the race condition where:
  // 1. GET request triggers async cache storage
  // 2. POST request triggers invalidation BEFORE cache storage completes
  // 3. Cache storage completes with stale data
  //
  // Solution: Track invalidation timestamps per tag. Before storing cache,
  // check if any invalidation happened after the original request started.

  /**
   * TTL for invalidation timestamps (5 minutes)
   * Timestamps older than this are considered stale and can be ignored.
   */
  private static readonly INVALIDATION_TIMESTAMP_TTL_SECONDS = 300;

  /**
   * Set invalidation timestamp for tags
   * Called SYNCHRONOUSLY at the START of mutation handling to prevent race conditions.
   * 
   * @param tags - Cache tags being invalidated
   * @returns Promise that resolves when all timestamps are set
   */
  public async setInvalidationTimestamps(tags: string[]): Promise<void> {
    if (!this.isConnected || !this.redis) {
      return;
    }

    const timestamp = Date.now();
    const pipeline = this.redis.pipeline();

    for (const tag of tags) {
      const timestampKey = this.getInvalidationTimestampKey(tag);
      pipeline.set(timestampKey, timestamp.toString());
      pipeline.expire(timestampKey, CacheService.INVALIDATION_TIMESTAMP_TTL_SECONDS);
    }

    try {
      await pipeline.exec();
      this.logger.debug(`Set invalidation timestamps for tags: ${tags.join(', ')} at ${timestamp}`);
    } catch (error) {
      this.logger.error(`Failed to set invalidation timestamps: ${getErrorMessage(error)}`, {
        context: 'CacheService.setInvalidationTimestamps',
        tags,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      // Don't throw - this is a safety mechanism, not critical path
    }
  }

  /**
   * Get invalidation timestamp for a single tag
   * 
   * @param tag - Cache tag to check
   * @returns Timestamp when tag was last invalidated, or null if never/expired
   */
  public async getInvalidationTimestamp(tag: string): Promise<number | null> {
    if (!this.isConnected || !this.redis) {
      return null;
    }

    try {
      const timestampKey = this.getInvalidationTimestampKey(tag);
      const value = await this.redis.get(timestampKey);
      return value ? parseInt(value, 10) : null;
    } catch (error) {
      this.logger.error(`Failed to get invalidation timestamp for tag ${tag}: ${getErrorMessage(error)}`, {
        context: 'CacheService.getInvalidationTimestamp',
        tag,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return null;
    }
  }

  /**
   * Check if any of the given tags were invalidated after the specified timestamp
   * 
   * @param tags - Cache tags to check
   * @param requestStartTime - When the original request started
   * @returns true if any tag was invalidated after requestStartTime (cache would be stale)
   */
  public async wasInvalidatedAfter(tags: string[], requestStartTime: number): Promise<boolean> {
    if (!this.isConnected || !this.redis || !tags || tags.length === 0) {
      return false;
    }

    try {
      // Use pipeline for efficiency
      const pipeline = this.redis.pipeline();
      for (const tag of tags) {
        pipeline.get(this.getInvalidationTimestampKey(tag));
      }

      const results = await pipeline.exec();
      if (!results) return false;

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (!result) continue;
        
        const [error, value] = result;
        if (error) continue;
        
        const timestamp = value ? parseInt(value as string, 10) : null;
        if (timestamp && timestamp > requestStartTime) {
          this.logger.debug(`Tag '${tags[i]}' was invalidated at ${timestamp}, after request started at ${requestStartTime}`);
          return true;
        }
      }

      return false;
    } catch (error) {
      this.logger.error(`Failed to check invalidation timestamps: ${getErrorMessage(error)}`, {
        context: 'CacheService.wasInvalidatedAfter',
        tags,
        requestStartTime,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return false; // Fail open - allow caching on error
    }
  }

  /**
   * Get the Redis key for storing invalidation timestamp
   */
  private getInvalidationTimestampKey(tag: string): string {
    return this.prefixKey(`invalidation-ts:${tag}`);
  }

  // DISTRIBUTED LOCK PRIMITIVES
  // Simple Redis-based advisory lock using SET NX PX (atomic set-if-not-exists
  // with TTL). Suitable for single-Redis-instance deployments. For multi-instance
  // Redis (clustered), upgrade to Redlock algorithm.

  /**
   * Acquire a distributed advisory lock.
   *
   * Uses Redis SET key NX PX ttlMs — atomically sets the key only if it does
   * not exist, with a TTL to prevent deadlocks from crashed holders.
   *
   * @param key - Lock key (e.g., "ema-learning-lock:{userId}")
   * @param ttlMs - Lock TTL in milliseconds (prevents deadlock if holder crashes)
   * @returns true if lock was acquired, false if already held by another caller
   */
  public async acquireLock(key: string, ttlMs: number): Promise<boolean> {
    if (!this.isConnected || !this.redis) {
      // Redis unavailable — fail open (allow operation to proceed without lock)
      this.logNotConnectedWarning('acquireLock');
      return true;
    }

    try {
      const prefixedKey = this.prefixKey(`lock:${key}`);
      // SET key value NX PX ttlMs — atomic set-if-not-exists with TTL
      const result = await this.redis.set(prefixedKey, Date.now().toString(), 'PX', ttlMs, 'NX');
      const acquired = result === 'OK';

      if (acquired) {
        this.recordSuccess();
        this.logger.debug(`Lock acquired: ${key} (TTL: ${ttlMs}ms)`);
      } else {
        this.logger.debug(`Lock not acquired (held by another): ${key}`);
      }

      return acquired;
    } catch (error) {
      this.logger.error(`Failed to acquire lock ${key}: ${getErrorMessage(error)}`, {
        context: 'CacheService.acquireLock',
        key,
        ttlMs,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      this.stats.errors++;
      this.recordFailure();
      // Fail open: if Redis errors, allow the operation to proceed
      return true;
    }
  }

  /**
   * Release a distributed advisory lock.
   *
   * Deletes the lock key from Redis. Safe to call even if the lock was not
   * held (DEL on a non-existent key is a no-op).
   *
   * @param key - Lock key to release
   */
  public async releaseLock(key: string): Promise<void> {
    if (!this.isConnected || !this.redis) {
      return;
    }

    try {
      const prefixedKey = this.prefixKey(`lock:${key}`);
      await this.redis.del(prefixedKey);
      this.logger.debug(`Lock released: ${key}`);
    } catch (error) {
      // Lock release failure is non-critical — TTL will auto-expire the lock
      this.logger.warn(`Failed to release lock ${key} (will auto-expire via TTL): ${getErrorMessage(error)}`, {
        context: 'CacheService.releaseLock',
        key,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      this.stats.errors++;
    }
  }

  /**
   * Check if key exists
   */
  public async exists(key: string): Promise<boolean> {
    if (!this.isConnected) {
      return false;
    }

    try {
      const result = await this.redis!.exists(this.prefixKey(key));
      return result > 0;
    } catch (error) {
      this.logger.error(`Cache exists check error for key ${key}: ${getErrorMessage(error)}`, {
        context: 'CacheService.exists',
        key,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return false;
    }
  }

  /**
   * Get remaining TTL for a key
   */
  public async ttl(key: string): Promise<number> {
    if (!this.isConnected) {
      return -1;
    }

    try {
      return await this.redis!.ttl(this.prefixKey(key));
    } catch (error) {
      this.logger.error(`Cache TTL check error for key ${key}: ${getErrorMessage(error)}`, {
        context: 'CacheService.ttl',
        key,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return -1;
    }
  }

  /**
   * Cache wrapper with automatic fetch
   */
  public async withCache<T>(
    key: string,
    fetchFn: () => Promise<T>,
    options: CacheOptions = {},
  ): Promise<T> {
    // Try to get from cache first
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    // Fetch fresh data
    try {
      const fresh = await fetchFn();

      // Store in cache
      await this.set(key, fresh, options);

      return fresh;
    } catch (error) {
      this.logger.error(`Error fetching data for cache key ${key}: ${getErrorMessage(error)}`, {
        context: 'CacheService.withCache',
        key,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      throw error;
    }
  }

  /**
   * Increment counter
   */
  public async increment(key: string, amount: number = 1): Promise<number | null> {
    if (!this.isConnected) {
      return null;
    }

    try {
      const result = await this.redis!.incrby(this.prefixKey(key), amount);
      return result;
    } catch (error) {
      this.logger.error(`Cache increment error for key ${key}: ${getErrorMessage(error)}`, {
        context: 'CacheService.increment',
        key,
        amount,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return null;
    }
  }

  /**
   * Decrement counter
   */
  public async decrement(key: string, amount: number = 1): Promise<number | null> {
    if (!this.isConnected) {
      return null;
    }

    try {
      const result = await this.redis!.decrby(this.prefixKey(key), amount);
      return result;
    } catch (error) {
      this.logger.error(`Cache decrement error for key ${key}: ${getErrorMessage(error)}`, {
        context: 'CacheService.decrement',
        key,
        amount,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return null;
    }
  }

  /**
   * Set expiration time on existing key
   * @param key - Cache key
   * @param ttl - Time to live in seconds
   * @returns true if TTL was set, false otherwise
   */
  public async expire(key: string, ttl: number): Promise<boolean> {
    if (!this.isConnected) {
      return false;
    }

    try {
      const result = await this.redis!.expire(this.prefixKey(key), ttl);
      return result === 1;
    } catch (error) {
      this.logger.error(`Cache expire error for key ${key}: ${getErrorMessage(error)}`, {
        context: 'CacheService.expire',
        key,
        ttl,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return false;
    }
  }

  /**
   * Set hash field
   */
  public async hset<T = unknown>(key: string, field: string, value: T): Promise<boolean> {
    if (!this.isConnected) {
      return false;
    }

    try {
      await this.redis!.hset(this.prefixKey(key), field, this.serialize(value));
      return true;
    } catch (error) {
      this.logger.error(`Cache hset error for key ${key}: ${getErrorMessage(error)}`, {
        context: 'CacheService.hset',
        key,
        field,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return false;
    }
  }

  /**
   * Get hash field
   */
  public async hget<T>(key: string, field: string): Promise<T | null> {
    if (!this.isConnected) {
      return null;
    }

    try {
      const data = await this.redis!.hget(this.prefixKey(key), field);
      return data ? this.deserialize<T>(data) : null;
    } catch (error) {
      this.logger.error(`Cache hget error for key ${key}: ${getErrorMessage(error)}`, {
        context: 'CacheService.hget',
        key,
        field,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return null;
    }
  }

  /**
   * Get all hash fields
   */
  public async hgetall<T>(key: string): Promise<Record<string, T> | null> {
    if (!this.isConnected) {
      return null;
    }

    try {
      const data = await this.redis!.hgetall(this.prefixKey(key));
      
      if (!data || Object.keys(data).length === 0) {
        return null;
      }

      const result: Record<string, T> = {};
      for (const [field, value] of Object.entries(data)) {
        result[field] = this.deserialize<T>(value);
      }

      return result;
    } catch (error) {
      this.logger.error(`Cache hgetall error for key ${key}: ${getErrorMessage(error)}`, {
        context: 'CacheService.hgetall',
        key,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return null;
    }
  }

  /**
   * Add to set
   */
  public async sadd(key: string, members: string[]): Promise<number> {
    if (!this.isConnected) {
      return 0;
    }

    try {
      return await this.redis!.sadd(this.prefixKey(key), ...members);
    } catch (error) {
      this.logger.error(`Cache sadd error for key ${key}: ${getErrorMessage(error)}`, {
        context: 'CacheService.sadd',
        key,
        memberCount: members.length,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return 0;
    }
  }

  /**
   * Get set members
   */
  public async smembers(key: string): Promise<string[]> {
    if (!this.isConnected) {
      return [];
    }

    try {
      return await this.redis!.smembers(this.prefixKey(key));
    } catch (error) {
      this.logger.error(`Cache smembers error for key ${key}: ${getErrorMessage(error)}`, {
        context: 'CacheService.smembers',
        key,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return [];
    }
  }

  /**
   * Push to list
   */
  public async lpush<T = unknown>(key: string, values: T[]): Promise<number> {
    if (!this.isConnected) {
      return 0;
    }

    try {
      const serialized = values.map(v => this.serialize(v));
      return await this.redis!.lpush(this.prefixKey(key), ...serialized);
    } catch (error) {
      this.logger.error(`Cache lpush error for key ${key}: ${getErrorMessage(error)}`, {
        context: 'CacheService.lpush',
        key,
        valueCount: values.length,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return 0;
    }
  }

  /**
   * Get list range
   */
  public async lrange<T>(key: string, start: number, stop: number): Promise<T[]> {
    if (!this.isConnected) {
      return [];
    }

    try {
      const data = await this.redis!.lrange(this.prefixKey(key), start, stop);
      return data.map(item => this.deserialize<T>(item));
    } catch (error) {
      this.logger.error(`Cache lrange error for key ${key}: ${getErrorMessage(error)}`, {
        context: 'CacheService.lrange',
        key,
        start,
        stop,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return [];
    }
  }

  /**
   * Flush all cache
   */
  public async flush(): Promise<boolean> {
    if (!this.isConnected) {
      return false;
    }

    try {
      await this.redis!.flushdb();
      this.logger.warn('Cache flushed');
      return true;
    } catch (error) {
      this.logger.error(`Cache flush error: ${getErrorMessage(error)}`, {
        context: 'CacheService.flush',
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return false;
    }
  }

  /**
   * Get cache statistics
   */
  public getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Reset cache statistics
   */
  public resetStats(): void {
    this.stats = {
      events: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      errors: 0,
    };
  }

  /**
   * Get cache hit rate
   */
  public getHitRate(): number {
    const total = this.stats.hits + this.stats.misses;
    return total > 0 ? (this.stats.hits / total) * 100 : 0;
  }

  /**
   * Determine if a host is a remote managed Redis service requiring TLS
   * Local development (localhost, 127.0.0.1) does NOT require TLS
   * Remote managed services (Render, AWS, etc.) typically DO require TLS
   *
   * @param host - The Redis host to check
   * @returns true if the host is remote and likely requires TLS
   */
  private isRemoteHost(host: string | undefined): boolean {
    if (!host) return false;

    const localHosts = ['localhost', '127.0.0.1', '::1', '0.0.0.0'];
    const normalizedHost = host.toLowerCase().trim();

    // Local development hosts don't need TLS
    if (localHosts.includes(normalizedHost)) {
      return false;
    }

    // Docker internal hosts don't need TLS
    if (normalizedHost.includes('host.docker.internal')) {
      return false;
    }

    // Known managed Redis services that require TLS
    // (can be extended as needed)
    const tlsRequiredPatterns = [
      '.render.com',
      '.redis.cache.windows.net', // Azure
      '.cache.amazonaws.com',     // AWS ElastiCache
      '.upstash.io',              // Upstash
      '.redislabs.com',           // Redis Labs
    ];

    // Check if host matches any TLS-required pattern
    if (tlsRequiredPatterns.some(pattern => normalizedHost.includes(pattern))) {
      return true;
    }

    // Default: Assume non-local hosts might need TLS
    // But be conservative - only enable if explicitly known
    // This prevents accidental TLS failures on custom deployments
    return false;
  }

  /**
   * Create cache key with prefix
   */
  private prefixKey(key: string): string {
    const prefix = this.config?.keyPrefix || 'appplatform';
    return `${prefix}:${key}`;
  }

  /**
   * Create tag key
   */
  private getTagKey(tag: string): string {
    return this.prefixKey(`tag:${tag}`);
  }

  /**
   * Add key to tags for invalidation
   * 
   * With `allkeys-lru` policy, tag sets (which are rarely read) were being
   * evicted before cache entries, causing "Invalidated 0 keys" issues.
   * 
   * Tag TTL is set to 24 hours - much longer than any cache entry TTL.
   * This ensures tag sets survive long enough for invalidation to work.
   */
  private static readonly TAG_SET_TTL_SECONDS = 86400; // 24 hours

  private async addToTags(key: string, tags: string[]): Promise<void> {
    for (const tag of tags) {
      const tagKey = this.getTagKey(tag);
      // Add key to tag set
      await this.redis!.sadd(tagKey, key);
      // This ensures tag sets outlive their associated cache entries
      await this.redis!.expire(tagKey, CacheService.TAG_SET_TTL_SECONDS);
    }
  }

  /**
   * Serialize value for storage
   */
  private serialize(value: unknown): string {
    return JSON.stringify(value);
  }

  /**
   * Deserialize value from storage
   */
  private deserialize<T>(data: string): T {
    try {
      return JSON.parse(data) as T;
    } catch {
      return data as unknown as T;
    }
  }

  /**
   * Generate cache key from object
   */
  public generateKey(prefix: string, params: Record<string, unknown>): string {
    const hash = crypto
      .createHash('md5')
      .update(JSON.stringify(params))
      .digest('hex');
    return `${prefix}:${hash}`;
  }

  /**
   * Check Redis connection status
   */
  public isReady(): boolean {
    return this.isConnected && this.redis !== null;
  }

  /**
   * Get Redis configuration for other services (e.g., BullMQ)
   */
  public getRedisConfig(): CacheServiceConfig | null {
    this.logger.info(' CacheService.getRedisConfig() returning:', {
      context: 'CacheService',
      hasConfig: !!this.config,
      hasUrl: !!this.config?.url,
      urlProtocol: this.config?.url?.split('://')[0],
      host: this.config?.host,
      port: this.config?.port,
      hasUsername: !!this.config?.username,
      hasPassword: !!this.config?.password,
      db: this.config?.db,
      keyPrefix: this.config?.keyPrefix
    });

    return this.config;
  }

  /**
   * Close Redis connection
   */
  public async close(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
      this.isConnected = false;
      this.logger.info('Redis connection closed');
    }
  }
}