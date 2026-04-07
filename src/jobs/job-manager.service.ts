/**
 * Job Manager Service
 * 
 * Singleton service for managing BullMQ job queues, allowing services to enqueue 
 * and process long-running tasks asynchronously. Follows AppPlatform singleton pattern.
 * 
 * @module jobs/job-manager.service
 * @see https://docs.bullmq.io/
 */

import { Queue, Worker, Job } from 'bullmq';
import type { RedisOptions } from 'ioredis';
import { LoggerService } from '../services/logger.service';
import { AppError, ErrorCodes } from '../utils/AppError';
import { getErrorMessage, getErrorStack, ExtendedError, getExtendedErrorCode } from '../utils/error-handler';
import { JobNames, JobData, JobConfig, JobPriority } from './job.types';
import { JobProcessor } from './job-processor';

interface JobManagerConfig {
  /**
   * Redis URL for BullMQ job queues.
   * 
   * BullMQ stores job data that must NEVER be evicted.
   * 
   * In production, use a SEPARATE Redis instance from the cache Redis:
   * - Cache Redis: volatile-ttl (for API response caching)
   * - BullMQ Redis: noeviction (for job queues)
   */
  redisUrl: string;
  queueNames: JobNames[];
  enableWorker?: boolean;
  workerConcurrency?: number;
}

// BullMQ connection: URL string is preferred for simplicity and proper TLS handling
type BullMQConnection = string;

/**
 * Per-queue configuration for bounded resource usage.
 *
 * Each queue gets tailored limits to prevent:
 * - Redis OOM from unbounded queue depth (maxQueueLen)
 * - Worker starvation from slow jobs monopolising the pool (concurrency)
 * - Excessive Redis memory from completed/failed job retention (removeOnComplete/Fail)
 *
 * Queues not listed use DEFAULT_QUEUE_PROFILE.
 */
interface QueueProfile {
  /** Hard cap on waiting + delayed job count.  New jobs are rejected when exceeded. */
  maxQueueLen: number;
  /** Worker concurrency override (parallel jobs per worker for this queue). */
  concurrency: number;
  /** How many completed jobs to retain in Redis (for introspection). */
  removeOnComplete: number;
  /** How many failed jobs to retain in Redis (for debugging). */
  removeOnFail: number;
  /** Max retry attempts. */
  attempts: number;
  /** Initial backoff delay in ms. */
  backoffDelay: number;
}

const DEFAULT_QUEUE_PROFILE: QueueProfile = {
  maxQueueLen: 10_000,
  concurrency: 5,
  removeOnComplete: 1_000,
  removeOnFail: 5_000,
  attempts: 3,
  backoffDelay: 1_000,
};

/**
 * Queue-specific overrides.  Only the fields that differ from DEFAULT need listing.
 *
 * Rationale per queue:
 * - healthIngestBatch: highest-volume queue from mobile sync — bounded tightly
 * - sessionTelemetryCompute: fast CPU jobs — higher concurrency, lower retention
 * - healthSampleSoftDeletePurger: long-running batch — concurrency 1 prevents lock contention
 * - refreshAnalyticsMVs: heavy MV refresh — concurrency 2, large queue unnecessary
 * - inventoryReconciliation: medium-frequency reconciliation — moderate limits
 */
const QUEUE_PROFILES: Partial<Record<JobNames, Partial<QueueProfile>>> = {
  [JobNames.HEALTH_INGEST_BATCH]: {
    maxQueueLen: 50_000,       // High volume from mobile sync bursts
    concurrency: 3,             // DB-heavy, avoid saturating connection pool
    removeOnComplete: 500,      // High volume → lower retention to save Redis memory
    removeOnFail: 2_000,
    attempts: 5,                // Transient failures more likely on batch ingestion
    backoffDelay: 500,
  },
  [JobNames.SESSION_TELEMETRY_COMPUTE]: {
    maxQueueLen: 5_000,
    concurrency: 8,             // Fast CPU-bound — parallelise aggressively
    removeOnComplete: 200,
    removeOnFail: 500,
    attempts: 2,                // Idempotent compute — few retries needed
  },
  [JobNames.HEALTH_SAMPLE_SOFT_DELETE_PURGER]: {
    maxQueueLen: 100,           // Scheduled cron only — never queued in bulk
    concurrency: 1,             // Long-running batch delete — single worker prevents lock contention
    removeOnComplete: 50,
    removeOnFail: 100,
  },
  [JobNames.REFRESH_ANALYTICS_MVS]: {
    maxQueueLen: 100,           // Scheduled cron only
    concurrency: 2,             // Heavy compute — avoid starving other queues
    removeOnComplete: 100,
    removeOnFail: 200,
    attempts: 5,                // MV refreshes can hit transient Neon timeouts
    backoffDelay: 2_000,
  },
  [JobNames.INVENTORY_RECONCILIATION]: {
    maxQueueLen: 500,
    concurrency: 2,
    removeOnComplete: 200,
    removeOnFail: 500,
  },
  [JobNames.STALE_SESSION_RECONCILIATION]: {
    maxQueueLen: 100,           // Scheduled cron only — never queued in bulk
    concurrency: 1,             // Single worker prevents lock contention on session updates
    removeOnComplete: 100,
    removeOnFail: 200,
  },
  [JobNames.HEALTH_INGEST_REAPER]: {
    maxQueueLen: 100,           // Scheduled cron only
    concurrency: 1,
    removeOnComplete: 100,
    removeOnFail: 200,
  },
  [JobNames.SESSION_TELEMETRY_LOCK_REAPER]: {
    maxQueueLen: 100,           // Scheduled cron only
    concurrency: 1,
    removeOnComplete: 100,
    removeOnFail: 200,
  },
  [JobNames.EXPORT_ANALYTICS]: {
    maxQueueLen: 200,           // User-triggered — moderate limit
    concurrency: 2,
    removeOnComplete: 500,
    removeOnFail: 1_000,
  },
  [JobNames.GENERATE_WEEKLY_REPORT]: {
    maxQueueLen: 100,
    concurrency: 2,
    removeOnComplete: 100,
    removeOnFail: 200,
  },
  [JobNames.CACHE_WARMING]: {
    maxQueueLen: 500,
    concurrency: 3,
    removeOnComplete: 200,
    removeOnFail: 500,
  },
  [JobNames.SCHEMA_MIGRATION]: {
    maxQueueLen: 10,            // Admin-only, extremely rare
    concurrency: 1,             // Migrations MUST be serial
    removeOnComplete: 50,
    removeOnFail: 100,
    attempts: 1,                // Migrations should not auto-retry
  },
};

/** Merge per-queue overrides with defaults. */
function resolveQueueProfile(jobName: JobNames): QueueProfile {
  const overrides = QUEUE_PROFILES[jobName] ?? {};
  return { ...DEFAULT_QUEUE_PROFILE, ...overrides };
}

export class JobManagerService {
  private initialized: boolean = false;
  private config: JobManagerConfig | null = null;
  private queues: Map<JobNames, Queue> = new Map();
  private workers: Map<JobNames, Worker> = new Map();

  /**
   * Constructor with explicit dependency injection (Pure DI - no singleton)
   * All dependencies are required and injected by bootstrap.ts
   * 
   * NOTE: CacheService is NOT a dependency because BullMQ uses a SEPARATE
   * Redis instance with `noeviction` policy (vs cache Redis with `volatile-ttl`).
   */
  public constructor(
    private logger: LoggerService,
    private jobProcessor: JobProcessor,
  ) {
    // Lightweight constructor - all dependencies injected explicitly
  }

  /**
   * Initialize the JobManagerService
   * Must be called once at application startup
   */
  public async initialize(config: JobManagerConfig): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Ensure JobProcessor is initialized first
    await this.jobProcessor.initialize();

    this.config = config;
    this.logger.info('Initializing JobManagerService...', { context: 'JobManagerService' });

    try {
      // Get Redis configuration from CacheService
      this.logger.info(' JobManagerService getting Redis config from CacheService...', {
        context: 'JobManagerService'
      });

      const redisConfig = this.getRedisConnectionOptions();

      this.logger.info('========== BULLMQ REDIS CONFIGURATION ==========', {
        context: 'JobManagerService',
        configType: typeof redisConfig,
        isString: typeof redisConfig === 'string',
        isObject: typeof redisConfig === 'object'
      });

      this.logger.info(' BullMQ using dedicated Redis URL', {
        context: 'JobManagerService',
        protocol: redisConfig.split('://')[0],
        urlRedacted: redisConfig.replace(/:[^:@]+@/, ':***@')
      });

      // Connection config for BullMQ - parse URL into individual components
      // When you pass an object with `url`, ioredis IGNORES IT and defaults to localhost:6379.
      // This caused all the "Command timed out" errors - we were connecting to non-existent localhost.
      //
      // SOLUTION: Parse the URL and pass host, port, password as separate properties.
      const parsedUrl = new URL(redisConfig);
      const requiresTls = parsedUrl.protocol === 'rediss:';

      this.logger.info('Parsed BullMQ Redis URL components', {
        context: 'JobManagerService',
        protocol: parsedUrl.protocol,
        host: parsedUrl.hostname,
        port: parsedUrl.port || '6379',
        hasPassword: !!parsedUrl.password,
        hasUsername: !!parsedUrl.username,
        requiresTls,
      });

      const connectionConfig: RedisOptions = {
        host: parsedUrl.hostname,
        port: parseInt(parsedUrl.port || '6379', 10),
        // Password and username from URL
        ...(parsedUrl.password ? { password: decodeURIComponent(parsedUrl.password) } : {}),
        ...(parsedUrl.username && parsedUrl.username !== 'default' ? { username: decodeURIComponent(parsedUrl.username) } : {}),
        // This is different from CacheService which uses maxRetriesPerRequest: 3
        maxRetriesPerRequest: null,
        // TLS: Enable for rediss:// URLs (Render, AWS ElastiCache, Upstash, etc.)
        // Empty object {} enables TLS with default Node.js TLS settings
        ...(requiresTls ? { tls: {} } : {}),
        // Connection timeouts - generous for cloud Redis cold starts
        connectTimeout: 30000, // 30s - cloud Redis can have cold start latency
        // NOTE: Do NOT set commandTimeout! BullMQ uses blocking commands (BRPOPLPUSH)
        // that legitimately wait for extended periods. Setting commandTimeout causes
        // spurious "Command timed out" errors when workers are idle waiting for jobs.
        disconnectTimeout: 5000, // 5s - graceful disconnect timeout
        // Connection health
        enableReadyCheck: true, // Verify Redis is ready before sending commands
        enableOfflineQueue: true, // Queue commands when disconnected (replayed on reconnect)
        keepAlive: 30000, // 30s keepalive to prevent idle disconnect from cloud providers
        // Retry strategy for connection recovery
        retryStrategy: (times: number) => {
          // Stop retrying after 20 attempts (about 1.5 minutes with exponential backoff)
          if (times > 20) {
            this.logger.error('BullMQ Redis max reconnection attempts reached', {
              context: 'JobManagerService',
              attempts: times,
            });
            return null; // Stop retrying
          }
          // Exponential backoff: 100ms, 200ms, 400ms... max 5s
          const delay = Math.min(times * 100, 5000);
          this.logger.warn(`BullMQ Redis reconnecting in ${delay}ms (attempt ${times})`, {
            context: 'JobManagerService',
            attempt: times,
            delay,
          });
          return delay;
        },
      };

      // Create queues for each job type
      // Creating all connections simultaneously causes "Too many requests" rate limiting
      let queueIndex = 0;
      for (const jobName of this.config.queueNames) {
        // Add delay between queue creations (except for the first one)
        if (queueIndex > 0) {
          this.logger.debug(`Delaying queue creation for ${jobName} to prevent connection storm`, {
            context: 'JobManagerService',
            delay: 200,
            queueIndex
          });
          await new Promise(resolve => setTimeout(resolve, 200));
        }

        const profile = resolveQueueProfile(jobName);

        const queue = new Queue(jobName, {
          connection: connectionConfig,
          defaultJobOptions: {
            attempts: profile.attempts,
            backoff: {
              type: 'exponential',
              delay: profile.backoffDelay,
            },
            removeOnComplete: profile.removeOnComplete,
            removeOnFail: profile.removeOnFail,
          },
        });
        this.queues.set(jobName, queue);

        // Attach event listeners for monitoring
        this.setupQueueEventListeners(jobName);

        // BullMQ Queue connections are LAZY - they don't connect until first use.
        // This ensures we catch connection errors at startup, not at first job enqueue.
        try {
          await queue.getJobCounts();
          this.logger.debug(`Queue ${jobName} connection verified`, {
            context: 'JobManagerService',
            jobName,
          });
        } catch (connectionError) {
          this.logger.error(`Queue ${jobName} failed to connect to Redis`, {
            context: 'JobManagerService',
            jobName,
            error: getErrorMessage(connectionError),
            stack: getErrorStack(connectionError),
          });
          throw connectionError;
        }

        // Optionally start workers on this instance
        if (this.config.enableWorker) {
          this.workers.set(jobName, new Worker(jobName, async (job) => {
            return this.jobProcessor.processJob(job.name as JobNames, job.data as JobData, job.id);
          }, {
            connection: connectionConfig,
            concurrency: profile.concurrency,
          }));

          // Setup worker event listeners
          this.setupWorkerEventListeners(jobName);
        }

        this.logger.info(`Initialized queue and worker for ${jobName}`, {
          context: 'JobManagerService',
          jobName,
          hasWorker: this.config.enableWorker
        });

        queueIndex++;
      }

      this.initialized = true;
      this.logger.info('JobManagerService initialized successfully', { 
        context: 'JobManagerService',
        queueCount: this.config.queueNames.length,
        workersEnabled: this.config.enableWorker,
      });

    } catch (error) {
      this.logger.error('Failed to initialize JobManagerService', {
        context: 'JobManagerService',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      throw new AppError(500, ErrorCodes.INTERNAL_SERVER_ERROR, 'JobManagerService initialization failed');
    }
  }

  /**
   * Enqueue a job for processing
   */
  public async enqueueJob<T extends JobData>(
    jobName: JobNames,
    data: T,
    options?: {
      jobId?: string;
      priority?: JobPriority;
      delay?: number;
      config?: JobConfig;
    },
  ): Promise<string> {
    if (!this.initialized) {
      throw new AppError(500, ErrorCodes.SERVICE_UNAVAILABLE, 'JobManagerService not initialized');
    }

    const queue = this.queues.get(jobName);
    if (!queue) {
      throw new AppError(400, ErrorCodes.INVALID_OPERATION, `Job queue '${jobName}' not found`);
    }

    // Backpressure gate: reject new jobs when queue depth exceeds the bounded limit.
    // This prevents unbounded Redis memory growth during traffic spikes.
    const profile = resolveQueueProfile(jobName);
    try {
      const counts = await queue.getJobCounts('waiting', 'delayed', 'active');
      const currentDepth = (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.active ?? 0);
      if (currentDepth >= profile.maxQueueLen) {
        this.logger.warn('Queue backpressure: rejecting job — queue at capacity', {
          context: 'JobManagerService',
          jobName,
          currentDepth,
          maxQueueLen: profile.maxQueueLen,
        });
        throw new AppError(
          429,
          ErrorCodes.RATE_LIMITED,
          `Queue '${jobName}' is at capacity (${currentDepth}/${profile.maxQueueLen}). Try again later.`,
        );
      }
    } catch (depthError) {
      // If the depth check itself fails (Redis issue), re-throw AppErrors but
      // allow the job to be enqueued on infrastructure errors (fail-open for
      // scheduled jobs, fail-closed for user-triggered).
      if (depthError instanceof AppError) throw depthError;
      this.logger.warn('Queue depth check failed — allowing job through', {
        context: 'JobManagerService',
        jobName,
        error: getErrorMessage(depthError),
      });
    }

    try {
      const job = await queue.add(jobName, data, {
        jobId: options?.jobId,
        priority: options?.priority || JobPriority.MEDIUM,
        delay: options?.delay,
        attempts: options?.config?.attempts,
        backoff: options?.config?.backoff,
        removeOnComplete: options?.config?.removeOnComplete,
        removeOnFail: options?.config?.removeOnFail,
        repeat: options?.config?.repeat,
      });

      this.logger.info(`Job enqueued: ${jobName}`, {
        context: 'JobManagerService',
        jobId: job.id,
        jobName,
        userId: data.userId,
        priority: options?.priority || JobPriority.MEDIUM,
      });

      return job.id!;
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      const errorStack = getErrorStack(error);
      console.error(`\n========== BULLMQ ENQUEUE ERROR: ${jobName} ==========`);
      console.error('Error Message:', errorMessage);
      console.error('Error Stack:', errorStack);
      console.error('Job Data:', JSON.stringify(data, null, 2));
      console.error('========================================\n');

      this.logger.error(`Failed to enqueue job: ${jobName}`, {
        context: 'JobManagerService',
        jobName,
        error: errorMessage,
        stack: errorStack,
      });
      throw new AppError(500, ErrorCodes.INTERNAL_SERVER_ERROR, `Failed to enqueue job '${jobName}': ${errorMessage}`);
    }
  }

  /**
   * Verify that a job queue exists before scheduling.
   * Use before enqueueing scheduled jobs to fail fast with a clear error if the queue
   * was not initialized (e.g., deployment asymmetry, init order issues).
   */
  public ensureQueueExists(jobName: JobNames): void {
    if (!this.initialized) {
      throw new AppError(500, ErrorCodes.SERVICE_UNAVAILABLE, 'JobManagerService not initialized');
    }
    const queue = this.queues.get(jobName);
    if (!queue) {
      const availableQueues = Array.from(this.queues.keys()).join(', ');
      throw new AppError(
        400,
        ErrorCodes.INVALID_OPERATION,
        `Job queue '${jobName}' not found. Available queues: [${availableQueues}]`,
      );
    }
  }

  /**
   * Get approximate queue depth (waiting + active + delayed) for a job type.
   */
  public async getQueueDepth(jobName: JobNames): Promise<number> {
    if (!this.initialized) {
      throw new AppError(500, ErrorCodes.SERVICE_UNAVAILABLE, 'JobManagerService not initialized');
    }

    const queue = this.queues.get(jobName);
    if (!queue) {
      throw new AppError(400, ErrorCodes.INVALID_OPERATION, `Job queue '${jobName}' not found`);
    }

    const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
    return (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
  }

  /**
   * Get job status and details
   */
  public async getJob(jobName: JobNames, jobId: string) {
    const queue = this.queues.get(jobName);
    if (!queue) {
      throw new AppError(400, ErrorCodes.INVALID_OPERATION, `Job queue '${jobName}' not found`);
    }

    try {
      const job = await queue.getJob(jobId);
      if (!job) {
        return null;
      }

      return {
        id: job.id,
        name: job.name,
        data: job.data,
        progress: job.progress,
        processedOn: job.processedOn,
        finishedOn: job.finishedOn,
        failedReason: job.failedReason,
        attemptsMade: job.attemptsMade,
        returnvalue: job.returnvalue,
      };
    } catch (error) {
      this.logger.error(`Failed to get job: ${jobId}`, {
        context: 'JobManagerService',
        jobName,
        jobId,
        error: getErrorMessage(error),
      });
      throw new AppError(500, ErrorCodes.INTERNAL_SERVER_ERROR, 'Failed to get job status');
    }
  }

  /**
   * Get queue statistics
   */
  public async getQueueStats(jobName: JobNames) {
    const queue = this.queues.get(jobName);
    if (!queue) {
      throw new AppError(400, ErrorCodes.INVALID_OPERATION, `Job queue '${jobName}' not found`);
    }

    try {
      const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');

      // Ensure all expected properties exist with defaults
      const safeCounts = {
        waiting: counts.waiting || 0,
        active: counts.active || 0,
        completed: counts.completed || 0,
        failed: counts.failed || 0,
        delayed: counts.delayed || 0,
      };

      return {
        queueName: jobName,
        ...safeCounts,
        total: safeCounts.waiting + safeCounts.active + safeCounts.completed + safeCounts.failed + safeCounts.delayed,
      };
    } catch (error) {
      this.logger.error(`Failed to get queue stats: ${jobName}`, {
        context: 'JobManagerService',
        error: getErrorMessage(error),
      });
      throw new AppError(500, ErrorCodes.INTERNAL_SERVER_ERROR, 'Failed to get queue statistics');
    }
  }

  /**
   * Get all queue statistics
   */
  public async getAllQueueStats() {
    const allStats = [];
    for (const jobName of this.config!.queueNames) {
      try {
        const stats = await this.getQueueStats(jobName);
        allStats.push(stats);
      } catch (error) {
        // Log error but continue with other queues
        this.logger.warn(`Failed to get stats for queue: ${jobName}`, {
          context: 'JobManagerService',
          error: getErrorMessage(error),
        });
      }
    }
    return allStats;
  }

  /**
   * Verify repeatable jobs are registered across all queues.
   * Logs a health summary showing which recurring jobs exist, their cron pattern,
   * and next scheduled run time. Call after initializeAllSchedules to confirm
   * that critical jobs (e.g., inventory reconciliation) are actually registered.
   *
   * @returns Summary of registered repeatable jobs per queue
   */
  public async verifyRepeatableJobs(): Promise<{ queueName: string; repeatableJobs: { name: string; pattern: string; next: string }[] }[]> {
    const results: { queueName: string; repeatableJobs: { name: string; pattern: string; next: string }[] }[] = [];

    for (const [jobName, queue] of this.queues.entries()) {
      try {
        const repeatableJobs = await queue.getRepeatableJobs();
        const jobs = repeatableJobs.map(rj => ({
          name: rj.name || rj.key || 'unknown',
          pattern: rj.pattern || 'none',
          next: rj.next ? new Date(rj.next).toISOString() : 'unknown',
        }));
        results.push({ queueName: jobName, repeatableJobs: jobs });

        if (jobs.length > 0) {
          this.logger.info(`Queue ${jobName}: ${jobs.length} repeatable job(s) registered`, {
            context: 'JobManagerService.verifyRepeatableJobs',
            queueName: jobName,
            jobs: jobs.map(j => `${j.name} [${j.pattern}] next: ${j.next}`),
          });
        }
      } catch (error) {
        this.logger.warn(`Failed to verify repeatable jobs for queue: ${jobName}`, {
          context: 'JobManagerService.verifyRepeatableJobs',
          error: getErrorMessage(error),
        });
      }
    }

    // Summary: count total repeatable jobs
    const totalRepeatable = results.reduce((sum, r) => sum + r.repeatableJobs.length, 0);
    this.logger.info(`Job health verification: ${totalRepeatable} repeatable job(s) across ${results.length} queue(s)`, {
      context: 'JobManagerService.verifyRepeatableJobs',
      totalQueues: results.length,
      totalRepeatableJobs: totalRepeatable,
    });

    return results;
  }

  /**
   * Pause a queue
   */
  public async pauseQueue(jobName: JobNames): Promise<void> {
    const queue = this.queues.get(jobName);
    if (!queue) {
      throw new AppError(400, ErrorCodes.INVALID_OPERATION, `Job queue '${jobName}' not found`);
    }

    await queue.pause();
    this.logger.info(`Queue paused: ${jobName}`, { context: 'JobManagerService' });
  }

  /**
   * Resume a queue
   */
  public async resumeQueue(jobName: JobNames): Promise<void> {
    const queue = this.queues.get(jobName);
    if (!queue) {
      throw new AppError(400, ErrorCodes.INVALID_OPERATION, `Job queue '${jobName}' not found`);
    }

    await queue.resume();
    this.logger.info(`Queue resumed: ${jobName}`, { context: 'JobManagerService' });
  }

  /**
   * Clean completed jobs from queue
   */
  public async cleanQueue(jobName: JobNames, grace: number = 5000): Promise<number> {
    const queue = this.queues.get(jobName);
    if (!queue) {
      throw new AppError(400, ErrorCodes.INVALID_OPERATION, `Job queue '${jobName}' not found`);
    }

    const cleaned = await queue.clean(grace, 100, 'completed');
    this.logger.info(`Queue cleaned: ${jobName}`, {
      context: 'JobManagerService',
      removedJobs: cleaned.length,
    });
    
    return cleaned.length;
  }

  /**
   * Setup queue event listeners for monitoring
   */
  private setupQueueEventListeners(jobName: JobNames): void {
    const queue = this.queues.get(jobName)!;

    queue.on('error', (error: Error) => {
      const extError = error as ExtendedError;
      const errorCode = getExtendedErrorCode(error);

      console.error(`\n========== BULLMQ QUEUE ERROR: ${jobName} ==========`);
      console.error('Error Name:', error.name);
      console.error('Error Message:', error.message);
      console.error('Error Code:', errorCode);
      console.error('Error Stack:', error.stack);
      console.error('Full Error Object:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
      if (extError.originalError) {
        console.error('Original Error:', JSON.stringify(extError.originalError, Object.getOwnPropertyNames(extError.originalError), 2));
      }
      console.error('========================================\n');

      this.logger.error(`BullMQ Queue Error for ${jobName}`, {
        context: 'JobManagerService',
        jobName,
        error: getErrorMessage(error),
        errorName: error.name,
        errorCode,
        stack: getErrorStack(error),
      });

      //  COMPREHENSIVE DEBUGGING: Capture underlying ioredis client errors
      if (extError.originalError) {
        this.logger.error(`Underlying Redis client error for queue ${jobName}:`, {
          context: 'JobManagerService',
          jobName,
          originalErrorMessage: extError.originalError.message,
          originalErrorName: extError.originalError.name,
          originalErrorCode: extError.originalError.code,
          originalErrorStack: extError.originalError.stack,
        });
      }
    });

    queue.on('waiting', (job: Job) => {
      this.logger.debug(`Job ${job.id} waiting in queue ${jobName}`, {
        context: 'JobManagerService',
        jobId: job.id,
        jobName,
      });
    });
  }

  /**
   * Setup worker event listeners for monitoring
   */
  private setupWorkerEventListeners(jobName: JobNames): void {
    const worker = this.workers.get(jobName)!;

    worker.on('error', (error: Error) => {
      const extError = error as ExtendedError;
      const errorCode = getExtendedErrorCode(error);

      console.error(`\n========== BULLMQ WORKER ERROR: ${jobName} ==========`);
      console.error('Error Name:', error.name);
      console.error('Error Message:', error.message);
      console.error('Error Code:', errorCode);
      console.error('Error Stack:', error.stack);
      console.error('Full Error Object:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
      if (extError.originalError) {
        console.error('Original Error:', JSON.stringify(extError.originalError, Object.getOwnPropertyNames(extError.originalError), 2));
      }
      console.error('==========================================\n');

      this.logger.error(`BullMQ Worker Error for ${jobName}`, {
        context: 'JobManagerService',
        jobName,
        error: getErrorMessage(error),
        errorName: error.name,
        errorCode,
        stack: getErrorStack(error),
      });

      //  COMPREHENSIVE DEBUGGING: Capture underlying ioredis client errors
      if (extError.originalError) {
        this.logger.error(`Underlying Redis client error for worker ${jobName}:`, {
          context: 'JobManagerService',
          jobName,
          originalErrorMessage: extError.originalError.message,
          originalErrorName: extError.originalError.name,
          originalErrorCode: extError.originalError.code,
          originalErrorStack: extError.originalError.stack,
        });
      }
    });

    worker.on('failed', (job: Job | undefined, error: Error) => {
      const extError = error as ExtendedError;
      const errorCode = getExtendedErrorCode(error);

      this.logger.error(`Worker job ${job?.id} failed in ${jobName}`, {
        context: 'JobManagerService',
        jobId: job?.id,
        jobName,
        error: getErrorMessage(error),
        errorName: error.name,
        errorCode,
        stack: getErrorStack(error),
      });

      //  COMPREHENSIVE DEBUGGING: Capture underlying ioredis client errors during job failure
      if (extError.originalError) {
        this.logger.error(`Underlying Redis client error during job failure for ${jobName}:`, {
          context: 'JobManagerService',
          jobName,
          jobId: job?.id,
          originalErrorMessage: extError.originalError.message,
          originalErrorName: extError.originalError.name,
          originalErrorCode: extError.originalError.code,
          originalErrorStack: extError.originalError.stack,
        });
      }
    });
  }

  /**
   * Get Redis connection options for BullMQ
   *
   * This is different from the cache Redis which uses `volatile-ttl`.
   * 
   * The redisUrl is provided via JobManagerConfig during initialization,
   * which should be set to BULLMQ_REDIS_URL (dedicated BullMQ Redis).
   */
  private getRedisConnectionOptions(): BullMQConnection {
    // Use the dedicated BullMQ Redis URL from config
    const redisUrl = this.config?.redisUrl;

    // FAIL-FAST: If no Redis URL configured, this is a critical failure
    if (!redisUrl) {
      const error = new AppError(
        500,
        ErrorCodes.SERVICE_UNAVAILABLE,
        'CRITICAL: No Redis URL configured for BullMQ. Set BULLMQ_REDIS_URL for production.'
      );
      this.logger.error('BullMQ initialization failed - no Redis URL in config', {
        context: 'JobManagerService',
        error: error.message
      });
      throw error;
    }

    this.logger.info(' BullMQ using dedicated Redis instance', {
      context: 'JobManagerService',
      urlProtocol: redisUrl.split('://')[0],
      hasCredentials: redisUrl.includes('@'),
      note: 'This Redis instance MUST use noeviction policy'
    });

    // Return URL as string - ioredis handles TLS automatically based on rediss:// protocol
    return redisUrl;
  }

  /**
   * Shutdown all queues and workers gracefully
   */
  public async shutdown(): Promise<void> {
    if (!this.initialized) return;

    this.logger.info('Shutting down JobManagerService...', { context: 'JobManagerService' });
    const shutdownPromises: Promise<void | unknown>[] = [];

    // Close all workers first
    for (const [name, worker] of this.workers.entries()) {
      shutdownPromises.push(
        worker.close().catch(err => 
          this.logger.error(`Failed to close worker ${name}: ${getErrorMessage(err)}`),
        ),
      );
    }

    // Note: QueueScheduler is no longer needed in BullMQ v5

    // Close all queues
    for (const [name, queue] of this.queues.entries()) {
      shutdownPromises.push(
        queue.close().catch(err => 
          this.logger.error(`Failed to close queue ${name}: ${getErrorMessage(err)}`),
        ),
      );
    }

    await Promise.allSettled(shutdownPromises);
    this.initialized = false;
    this.logger.info('JobManagerService shutdown complete', { context: 'JobManagerService' });
  }
}
