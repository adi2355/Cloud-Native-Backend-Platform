import { Request, Response } from 'express';
import { generateSecureId, generateSecureJitter } from '../utils/secure-id.utils';
import { LoggerService } from './logger.service';

/**
 * Rate limit configuration interface
 */
export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
  keyGenerator?: (req: Request) => string;
  onLimitReached?: (req: Request, res: Response) => void;
  backoffStrategy: BackoffStrategy;
}

export interface RateLimitOverride extends Partial<RateLimitConfig> {
  bucket?: string;
}

/**
 * Backoff strategy configuration
 */
export interface BackoffStrategy {
  type: 'exponential' | 'linear' | 'fixed';
  baseDelay: number;
  maxDelay: number;
  multiplier?: number;
  jitter?: boolean;
}

/**
 * Queue item interface
 */
export interface QueueItem {
  id: string;
  request: Request;
  response: Response;
  timestamp: number;
  priority: number;
  retryCount: number;
  maxRetries: number;
  resolve: (value: boolean) => void;
  reject: (reason: Error) => void;
}

/**
 * Rate limit status interface
 */
export interface RateLimitStatus {
  isLimited: boolean;
  remainingRequests: number;
  resetTime: number;
  retryAfter?: number;
  queuePosition?: number;
  estimatedWaitTime?: number;
}

/**
 * Queue statistics interface
 */
export interface QueueStatistics {
  totalQueued: number;
  processing: number;
  completed: number;
  failed: number;
  averageWaitTime: number;
  averageProcessingTime: number;
  queueLength: number;
}

/**
 * Rate Limiting and Queue Management Service
 * Provides intelligent rate limiting with request queuing and backoff strategies
 */
export class RateLimitingQueueService {
  private rateLimitStore: Map<string, { count: number; resetTime: number }> = new Map();
  private requestQueue: QueueItem[] = [];
  private processingQueue: Set<string> = new Set();
  private queueStats: QueueStatistics = {
    totalQueued: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    averageWaitTime: 0,
    averageProcessingTime: 0,
    queueLength: 0,
  };
  private config: RateLimitConfig;
  private isProcessing = false;

  private getRateLimitOverride(req?: Request): RateLimitOverride | undefined {
    if (!req) return undefined;
    return (req as Request & { rateLimitOverride?: RateLimitOverride }).rateLimitOverride;
  }

  private resolveConfig(req?: Request): { config: RateLimitConfig; bucket?: string } {
    const override = this.getRateLimitOverride(req);
    if (!override) {
      return { config: this.config };
    }

    const { bucket, ...configOverrides } = override;
    return {
      config: { ...this.config, ...configOverrides },
      bucket,
    };
  }

  public getConfigForRequest(req?: Request): RateLimitConfig {
    return this.resolveConfig(req).config;
  }

  public getRateLimitKey(req: Request): string {
    const { config, bucket } = this.resolveConfig(req);
    const baseKey = config.keyGenerator ? config.keyGenerator(req) : `ip:${req.ip || 'unknown'}`;
    return bucket ? `${bucket}:${baseKey}` : baseKey;
  }

  /**
   * Constructor with explicit dependency injection (Pure DI - no singleton)
   * All dependencies are required and injected by bootstrap.ts
   */
  public constructor(private logger: LoggerService) {
    // Pure constructor injection - all dependencies provided by bootstrap.ts
    if (!logger) {
      throw new Error('RateLimitingQueueService: LoggerService dependency must be provided');
    }
    // Default configuration - overridden by bootstrap.ts with environment config
    // IMPORTANT: Default increased from 100 to 500 to handle mobile app burst patterns
    // Mobile apps fire multiple parallel API calls during startup (~6-10 calls in <500ms)
    this.config = {
      windowMs: 15 * 60 * 1000, // 15 minutes
      maxRequests: 500, // Increased from 100 to handle app restart burst patterns
      skipSuccessfulRequests: false,
      skipFailedRequests: false,
      // - Uses userId (from req.user.id) if authenticated - each user gets their own rate limit bucket
      // - Falls back to IP for unauthenticated requests
      // This prevents:
      // 1. Multiple users on same network from sharing rate limits
      // 2. Unfair penalization of users behind NAT/proxy
      // 3. Rate limit exhaustion from one user affecting others
      keyGenerator: (req: Request) => {
        // Check for authenticated user first (req.user is set by userContext middleware)
        // userContext middleware runs BEFORE rate limiting in the middleware pipeline
        const userId = (req as Request & { user?: { id?: string } }).user?.id;
        if (userId) {
          return `user:${userId}`;
        }
        // Fall back to IP for unauthenticated requests
        return `ip:${req.ip || 'unknown'}`;
      },
      backoffStrategy: {
        type: 'exponential',
        baseDelay: 1000,
        maxDelay: 30000,
        multiplier: 2,
        jitter: true,
      },
    };

    // Start queue processor
    this.startQueueProcessor();

    // Clean up expired rate limit entries periodically
    setInterval(() => this.cleanupExpiredEntries(), 60000); // Every minute
  }

  /**
   * Check if request should be rate limited
   */
  public checkRateLimit(req: Request): RateLimitStatus {
    const { config } = this.resolveConfig(req);
    const key = this.getRateLimitKey(req);
    const now = Date.now();
    const entry = this.rateLimitStore.get(key);

    // Clean up expired entry
    if (entry && now > entry.resetTime) {
      this.rateLimitStore.delete(key);
    }

    const currentEntry = this.rateLimitStore.get(key);
    
    if (!currentEntry) {
      // First request in window
      this.rateLimitStore.set(key, {
        count: 1,
        resetTime: now + config.windowMs,
      });

      return {
        isLimited: false,
        remainingRequests: config.maxRequests - 1,
        resetTime: now + config.windowMs,
      };
    }

    if (currentEntry.count >= config.maxRequests) {
      // Rate limit exceeded
      const retryAfter = Math.ceil((currentEntry.resetTime - now) / 1000);
      const queuePosition = this.getQueuePosition(key);
      const estimatedWaitTime = this.calculateEstimatedWaitTime(queuePosition);

      return {
        isLimited: true,
        remainingRequests: 0,
        resetTime: currentEntry.resetTime,
        retryAfter,
        queuePosition,
        estimatedWaitTime,
      };
    }

    // Increment count
    currentEntry.count++;
    this.rateLimitStore.set(key, currentEntry);

    return {
      isLimited: false,
      remainingRequests: config.maxRequests - currentEntry.count,
      resetTime: currentEntry.resetTime,
    };
  }

  /**
   * Add request to queue when rate limited
   */
  public async queueRequest(
    req: Request,
    res: Response,
    priority: number = 1,
    maxRetries: number = 3,
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      // SAFETY: Check if response already sent before queuing
      if (res.headersSent) {
        this.logger.warn('Response already sent, cannot queue request', {
          url: req.url,
          method: req.method,
        });
        reject(new Error('Response already sent'));
        return;
      }

      const queueItem: QueueItem = {
        id: this.generateRequestId(),
        request: req,
        response: res,
        timestamp: Date.now(),
        priority,
        retryCount: 0,
        maxRetries,
        resolve,
        reject,
      };

      // Insert item in queue based on priority
      this.insertByPriority(queueItem);
      this.queueStats.totalQueued++;
      this.queueStats.queueLength = this.requestQueue.length;

      this.logger.info('Request queued', {
        id: queueItem.id,
        priority,
        queueLength: this.requestQueue.length,
        url: req.url,
        method: req.method,
      });

      // Set timeout for queued request
      setTimeout(() => {
        if (!this.processingQueue.has(queueItem.id)) {
          this.removeFromQueue(queueItem.id);
          // Only reject if we can still send a response
          if (!res.headersSent) {
            reject(new Error('Request timeout in queue'));
          } else {
            // Response already sent elsewhere, just resolve quietly
            this.logger.debug('Queue timeout but response already sent', { id: queueItem.id });
            resolve(false);
          }
        }
      }, 60000); // 1 minute timeout
    });
  }

  /**
   * Process queued requests
   */
  private async startQueueProcessor(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        if (this.requestQueue.length === 0) {
          await this.sleep(1000); // Wait 1 second before checking again
          continue;
        }

        const item = this.requestQueue.shift();
        if (!item) continue;

        this.processingQueue.add(item.id);
        this.queueStats.processing++;
        this.queueStats.queueLength = this.requestQueue.length;

        this.logger.info('Processing queued request', {
          id: item.id,
          waitTime: Date.now() - item.timestamp,
          queueLength: this.requestQueue.length,
        });

        try {
          // Check if rate limit has reset
          const rateLimitStatus = this.checkRateLimit(item.request);
          const effectiveConfig = this.getConfigForRequest(item.request);
          
          if (rateLimitStatus.isLimited) {
            // Still rate limited, calculate backoff delay
            const delay = this.calculateBackoffDelay(item.retryCount, effectiveConfig);
            
            if (item.retryCount < item.maxRetries) {
              this.logger.warn('Request still rate limited, retrying', {
                id: item.id,
                retryCount: item.retryCount,
                delay,
              });

              // Re-queue with increased retry count
              item.retryCount++;
              setTimeout(() => {
                this.insertByPriority(item);
              }, delay);
            } else {
              this.logger.error('Request exceeded max retries', { id: item.id });
              // This prevents "Cannot set headers after they are sent" errors
              if (!item.response.headersSent) {
                item.reject(new Error('Rate limit exceeded - max retries reached'));
              } else {
                // Response already sent, just log and resolve quietly
                this.logger.warn('Max retries reached but response already sent', { id: item.id });
                item.resolve(false);
              }
              this.queueStats.failed++;
            }
          } else {
            // Rate limit cleared, process request
            const processingStartTime = Date.now();
            const waitTime = processingStartTime - item.timestamp;
            
            // Update average wait time
            this.updateAverageWaitTime(waitTime);
            
            // Resolve the promise to continue request processing
            item.resolve(true);
            
            const processingTime = Date.now() - processingStartTime;
            this.updateAverageProcessingTime(processingTime);
            this.queueStats.completed++;
            
            this.logger.info('Request processed successfully', {
              id: item.id,
              waitTime,
              processingTime,
            });
          }
        } catch (error: unknown) {
          const err = error instanceof Error ? error : new Error(String(error));
          this.logger.error('Error processing queued request', {
            id: item.id,
            error: err.message,
          });

          item.reject(err);
          this.queueStats.failed++;
        } finally {
          this.processingQueue.delete(item.id);
          this.queueStats.processing--;
        }

        // Small delay between processing items
        await this.sleep(100);

      } catch (error) {
        this.logger.error('Queue processor error', { error: error instanceof Error ? error.message : String(error) });
        await this.sleep(5000); // Wait 5 seconds on error
      }
    }
  }

  /**
   * Calculate backoff delay based on retry count and strategy
   */
  private calculateBackoffDelay(retryCount: number, config: RateLimitConfig = this.config): number {
    const { type, baseDelay, maxDelay, multiplier = 2, jitter = false } = config.backoffStrategy;
    
    let delay: number;
    
    switch (type) {
      case 'exponential':
        delay = Math.min(baseDelay * Math.pow(multiplier, retryCount), maxDelay);
        break;
      case 'linear':
        delay = Math.min(baseDelay + (baseDelay * retryCount), maxDelay);
        break;
      case 'fixed':
      default:
        delay = baseDelay;
        break;
    }

    // Add jitter to prevent thundering herd
    if (jitter) {
      const jitterFactor = generateSecureJitter(50, 100) / 100; // 0.5 to 1.0
      delay = delay * jitterFactor;
    }

    return Math.floor(delay);
  }

  /**
   * Insert item in queue based on priority
   */
  private insertByPriority(item: QueueItem): void {
    let insertIndex = this.requestQueue.length;
    
    for (let i = 0; i < this.requestQueue.length; i++) {
      const queueItem = this.requestQueue[i];
      if (queueItem && queueItem.priority < item.priority) {
        insertIndex = i;
        break;
      }
    }
    
    this.requestQueue.splice(insertIndex, 0, item);
  }

  /**
   * Remove item from queue by ID
   */
  private removeFromQueue(id: string): boolean {
    const index = this.requestQueue.findIndex(item => item.id === id);
    if (index !== -1) {
      this.requestQueue.splice(index, 1);
      this.queueStats.queueLength = this.requestQueue.length;
      return true;
    }
    return false;
  }

  /**
   * Get queue position for a key
   */
  private getQueuePosition(key: string): number {
    let position = 0;
    for (const item of this.requestQueue) {
      position++;
      if (this.getRateLimitKey(item.request) === key) {
        return position;
      }
    }
    return 0;
  }

  /**
   * Calculate estimated wait time based on queue position
   */
  private calculateEstimatedWaitTime(queuePosition: number): number {
    if (queuePosition === 0) return 0;
    
    const averageProcessingTime = this.queueStats.averageProcessingTime || 1000;
    return queuePosition * averageProcessingTime;
  }

  /**
   * Update average wait time
   */
  private updateAverageWaitTime(waitTime: number): void {
    const totalCompleted = this.queueStats.completed + 1;
    this.queueStats.averageWaitTime = 
      (this.queueStats.averageWaitTime * this.queueStats.completed + waitTime) / totalCompleted;
  }

  /**
   * Update average processing time
   */
  private updateAverageProcessingTime(processingTime: number): void {
    const totalCompleted = this.queueStats.completed + 1;
    this.queueStats.averageProcessingTime = 
      (this.queueStats.averageProcessingTime * this.queueStats.completed + processingTime) / totalCompleted;
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return generateSecureId('req', 9);
  }

  /**
   * Clean up expired rate limit entries
   */
  private cleanupExpiredEntries(): void {
    const now = Date.now();
    const expiredKeys: string[] = [];

    for (const [key, entry] of this.rateLimitStore.entries()) {
      if (now > entry.resetTime) {
        expiredKeys.push(key);
      }
    }

    expiredKeys.forEach(key => this.rateLimitStore.delete(key));

    if (expiredKeys.length > 0) {
      this.logger.debug(`Cleaned up ${expiredKeys.length} expired rate limit entries`);
    }
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get queue statistics
   */
  public getQueueStatistics(): QueueStatistics {
    return { ...this.queueStats };
  }

  /**
   * Get rate limit information for a request
   */
  public getRateLimitInfo(req: Request): { count: number; resetTime: number } | null {
    const key = this.getRateLimitKey(req);
    return this.rateLimitStore.get(key) || null;
  }

  /**
   * Update configuration
   */
  public updateConfig(config: Partial<RateLimitConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  public getConfig(): RateLimitConfig {
    return { ...this.config };
  }

  /**
   * Clear rate limit for a specific key (admin function)
   */
  public clearRateLimit(key: string): boolean {
    return this.rateLimitStore.delete(key);
  }

  /**
   * Clear all rate limits (admin function)
   */
  public clearAllRateLimits(): void {
    this.rateLimitStore.clear();
  }

  /**
   * Get current queue length
   */
  public getQueueLength(): number {
    return this.requestQueue.length;
  }

  /**
   * Check if service is healthy
   */
  public getHealthStatus(): {
    healthy: boolean;
    queueLength: number;
    processing: number;
    rateLimitEntries: number;
    averageWaitTime: number;
  } {
    const queueLength = this.requestQueue.length;
    const processing = this.processingQueue.size;
    const rateLimitEntries = this.rateLimitStore.size;
    
    return {
      healthy: queueLength < 1000 && processing < 100, // Arbitrary health thresholds
      queueLength,
      processing,
      rateLimitEntries,
      averageWaitTime: this.queueStats.averageWaitTime,
    };
  }
}
