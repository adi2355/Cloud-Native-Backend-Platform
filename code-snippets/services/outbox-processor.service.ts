/**
 * Outbox Processor Service - Background Event Processing
 * Handles asynchronous processing of outbox events with scheduling and monitoring
 */

import { OutboxService } from './outbox.service';
import { LoggerService } from './logger.service';
import { ConfigSecurityService } from './configSecurity.service';
import { AppError, ErrorCodes } from '../utils/AppError';
import { getErrorMessage, getErrorStack } from '../utils/error-handler';

/**
 * Outbox event processing result
 */
export interface OutboxProcessingResult {
  processed: number;
  failed: number;
  deadLettered: number;
}

/**
 * Outbox statistics
 */
export interface OutboxStatistics {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  deadLetter: number;
}

export interface ProcessorConfig {
  enabled: boolean;
  intervalMs: number; // Processing interval in milliseconds
  batchSize: number;
  maxProcessingTime: number; // Max time per batch in milliseconds
  maxConcurrentBatches: number;
  autoStart: boolean; // Whether to start automatically during initialization
}

export interface ProcessorStatistics {
  isRunning: boolean;
  intervalId: ReturnType<typeof setInterval> | null;
  totalBatchesProcessed: number;
  totalEventsProcessed: number;
  totalEventsFailed: number;
  totalEventsDeadLettered: number;
  lastRunAt: Date | null;
  lastRunDurationMs: number;
  lastRunResults: OutboxProcessingResult | null;
  activeBatches: number;
  errors: Array<{
    timestamp: Date;
    error: string;
    batchNumber: number;
  }>;
}

export class OutboxProcessorService {
  private initialized: boolean = false;

  //  FIXED: Config loaded from ConfigSecurityService in initialize(), not process.env
  private config: ProcessorConfig = {
    enabled: true, // Default, will be overridden in initialize()
    intervalMs: 10000, // 10 seconds default
    batchSize: 50, // Default batch size
    maxProcessingTime: 30000, // 30 seconds default
    maxConcurrentBatches: 3, // Default concurrent batches
    autoStart: false, // Default: Don't auto-start during initialization (prevents race conditions)
  };

  private stats: ProcessorStatistics = {
    isRunning: false,
    intervalId: null,
    totalBatchesProcessed: 0,
    totalEventsProcessed: 0,
    totalEventsFailed: 0,
    totalEventsDeadLettered: 0,
    lastRunAt: null,
    lastRunDurationMs: 0,
    lastRunResults: null,
    activeBatches: 0,
    errors: [],
  };

  /**
   * Constructor with explicit dependency injection (Pure DI - no singleton)
   * All dependencies are required and injected by bootstrap.ts
   */
  public constructor(
    private outboxService: OutboxService,
    private logger: LoggerService,
    private configSecurityService: ConfigSecurityService,
  ) {
    // Lightweight constructor - all dependencies injected explicitly
    if (!outboxService || !logger || !configSecurityService) {
      throw new Error('OutboxProcessorService: All dependencies must be provided');
    }
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      //  FIXED: Load config from ConfigSecurityService instead of process.env
      const secureConfig = await this.configSecurityService.getSecureConfig();

      // Update config with values from secure config (with fallback to defaults)
      // NOTE: autoStart defaults to false to prevent race conditions during bootstrap
      // The processor should be started explicitly after all services are initialized
      this.config = {
        enabled: secureConfig.outboxProcessor?.enabled ?? true,
        intervalMs: secureConfig.outboxProcessor?.intervalMs ?? 10000,
        batchSize: secureConfig.outboxProcessor?.batchSize ?? 50,
        maxProcessingTime: secureConfig.outboxProcessor?.maxProcessingTime ?? 30000,
        maxConcurrentBatches: secureConfig.outboxProcessor?.maxConcurrentBatches ?? 3,
        autoStart: secureConfig.outboxProcessor?.autoStart ?? false, // Safe default
      };

      // Ensure outbox service is initialized
      await this.outboxService.initialize();

      this.initialized = true;
      this.logger.info('OutboxProcessorService initialized successfully', {
        context: 'OutboxProcessorService',
        config: this.config,
        note: 'Processor will be started explicitly after server is ready (autoStart=false)',
      });

      // Start processor only if autoStart is explicitly enabled
      // This prevents race conditions during bootstrap - events may be processed
      // before all subscribers/consumers are fully initialized
      if (this.config.enabled && this.config.autoStart) {
        await this.start();
      } else if (this.config.enabled) {
        this.logger.info('OutboxProcessor ready but not started (waiting for explicit start)', {
          context: 'OutboxProcessorService',
        });
      }
    } catch (error) {
      this.logger.error('Failed to initialize OutboxProcessorService', {
        context: 'OutboxProcessorService',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      throw new AppError(500, ErrorCodes.INTERNAL_SERVER_ERROR, 'OutboxProcessorService initialization failed');
    }
  }

  /**
   * Start the background processor
   */
  public async start(): Promise<void> {
    if (this.stats.isRunning) {
      this.logger.warn('Outbox processor is already running', { context: 'OutboxProcessorService' });
      return;
    }

    if (!this.config.enabled) {
      this.logger.info('Outbox processor is disabled by configuration', { context: 'OutboxProcessorService' });
      return;
    }

    try {
      this.stats.isRunning = true;
      this.stats.intervalId = setInterval(
        () => this.processBatch(),
        this.config.intervalMs,
      );

      // Process immediately on start
      setImmediate(() => this.processBatch());

      this.logger.info('Outbox processor started', { 
        context: 'OutboxProcessorService',
        intervalMs: this.config.intervalMs,
        batchSize: this.config.batchSize,
      });
    } catch (error) {
      this.stats.isRunning = false;
      this.logger.error('Failed to start outbox processor', {
        context: 'OutboxProcessorService',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      throw error;
    }
  }

  /**
   * Stop the background processor
   */
  public async stop(): Promise<void> {
    if (!this.stats.isRunning) {
      this.logger.warn('Outbox processor is not running', { context: 'OutboxProcessorService' });
      return;
    }

    try {
      this.stats.isRunning = false;
      
      if (this.stats.intervalId) {
        clearInterval(this.stats.intervalId);
        this.stats.intervalId = null;
      }

      // Wait for active batches to complete (with timeout)
      const stopTimeout = 30000; // 30 seconds
      const startTime = Date.now();
      
      while (this.stats.activeBatches > 0 && Date.now() - startTime < stopTimeout) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (this.stats.activeBatches > 0) {
        this.logger.warn('Stopped processor with active batches still running', {
          context: 'OutboxProcessorService',
          activeBatches: this.stats.activeBatches,
        });
      }

      this.logger.info('Outbox processor stopped', { 
        context: 'OutboxProcessorService',
        totalBatchesProcessed: this.stats.totalBatchesProcessed,
        totalEventsProcessed: this.stats.totalEventsProcessed,
      });
    } catch (error) {
      this.logger.error('Error stopping outbox processor', {
        context: 'OutboxProcessorService',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      throw error;
    }
  }

  /**
   * Process a batch of events
   */
  private async processBatch(): Promise<void> {
    if (!this.stats.isRunning) {
      return;
    }

    // Check concurrent batch limit
    if (this.stats.activeBatches >= this.config.maxConcurrentBatches) {
      this.logger.debug('Skipping batch due to concurrent limit', {
        context: 'OutboxProcessorService',
        activeBatches: this.stats.activeBatches,
        maxConcurrentBatches: this.config.maxConcurrentBatches,
      });
      return;
    }

    this.stats.activeBatches++;
    const batchStartTime = Date.now();
    const batchNumber = this.stats.totalBatchesProcessed + 1;

    try {
      this.logger.debug('Starting outbox batch processing', {
        context: 'OutboxProcessorService',
        batchNumber,
        batchSize: this.config.batchSize,
      });

      const results = await this.outboxService.processPendingEvents({
        batchSize: this.config.batchSize,
        maxProcessingTime: this.config.maxProcessingTime,
      });

      const batchDuration = Date.now() - batchStartTime;
      
      // Update statistics
      this.stats.totalBatchesProcessed++;
      this.stats.totalEventsProcessed += results.processed;
      this.stats.totalEventsFailed += results.failed;
      this.stats.totalEventsDeadLettered += results.deadLettered;
      this.stats.lastRunAt = new Date();
      this.stats.lastRunDurationMs = batchDuration;
      this.stats.lastRunResults = results;

      if (results.processed > 0 || results.failed > 0 || results.deadLettered > 0) {
        this.logger.info('Batch processing completed', {
          context: 'OutboxProcessorService',
          batchNumber,
          results,
          durationMs: batchDuration,
        });
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      
      // Track error
      this.stats.errors.push({
        timestamp: new Date(),
        error: errorMessage,
        batchNumber,
      });

      // Keep only last 10 errors
      if (this.stats.errors.length > 10) {
        this.stats.errors = this.stats.errors.slice(-10);
      }

      this.logger.error('Batch processing failed', {
        context: 'OutboxProcessorService',
        batchNumber,
        error: errorMessage,
        stack: getErrorStack(error),
      });
    } finally {
      this.stats.activeBatches--;
    }
  }

  /**
   * Force process events immediately (manual trigger)
   */
  public async processNow(): Promise<{
    processed: number;
    failed: number;
    deadLettered: number;
  }> {
    try {
      this.logger.info('Manual outbox processing triggered', { context: 'OutboxProcessorService' });
      
      const results = await this.outboxService.processPendingEvents({
        batchSize: this.config.batchSize * 2, // Process larger batch for manual trigger
        maxProcessingTime: this.config.maxProcessingTime * 2,
      });

      this.logger.info('Manual outbox processing completed', {
        context: 'OutboxProcessorService',
        results,
      });

      return results;
    } catch (error) {
      this.logger.error('Manual outbox processing failed', {
        context: 'OutboxProcessorService',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      
      throw new AppError(
        500,
        ErrorCodes.INTERNAL_SERVER_ERROR,
        'Failed to process outbox events',
      );
    }
  }

  /**
   * Update processor configuration
   */
  public updateConfig(newConfig: Partial<ProcessorConfig>): void {
    const wasRunning = this.stats.isRunning;
    
    // Stop if running
    if (wasRunning) {
      this.stop();
    }

    // Update config
    this.config = { ...this.config, ...newConfig };

    this.logger.info('Processor configuration updated', {
      context: 'OutboxProcessorService',
      newConfig: this.config,
    });

    // Restart if it was running and still enabled
    if (wasRunning && this.config.enabled) {
      this.start();
    }
  }

  /**
   * Get processor statistics
   */
  public getStatistics(): ProcessorStatistics & { outboxStats?: OutboxStatistics | null } {
    return {
      ...this.stats,
      outboxStats: null, // Will be populated by calling outboxService.getStatistics() if needed
    };
  }

  /**
   * Get detailed status including outbox statistics
   */
  public async getDetailedStatus(): Promise<ProcessorStatistics & { outboxStats: OutboxStatistics | null }> {
    try {
      const outboxStats = await this.outboxService.getStatistics();

      return {
        ...this.stats,
        outboxStats,
      };
    } catch (error: unknown) {
      this.logger.error('Failed to get detailed status', {
        context: 'OutboxProcessorService',
        error: getErrorMessage(error),
      });

      return {
        ...this.stats,
        outboxStats: null,
      };
    }
  }

  /**
   * Health check
   */
  public isHealthy(): boolean {
    if (!this.config.enabled) {
      return true; // Disabled processor is considered healthy
    }

    // Check if processor should be running but isn't
    if (this.config.enabled && !this.stats.isRunning) {
      return false;
    }

    // Check for recent errors
    const recentErrors = this.stats.errors.filter(
      error => Date.now() - error.timestamp.getTime() < 60000, // Last minute
    );

    if (recentErrors.length > 5) {
      return false; // Too many recent errors
    }

    // Check if last run was too long ago (if processor is running)
    if (this.stats.isRunning && this.stats.lastRunAt) {
      const timeSinceLastRun = Date.now() - this.stats.lastRunAt.getTime();
      const maxTimeBetweenRuns = this.config.intervalMs * 3; // Allow 3x interval
      
      if (timeSinceLastRun > maxTimeBetweenRuns) {
        return false;
      }
    }

    return true;
  }

  /**
   * Clean up old events and reset error history
   */
  public async performMaintenance(): Promise<{ cleanedEvents: number }> {
    try {
      this.logger.info('Starting outbox processor maintenance', { context: 'OutboxProcessorService' });
      
      // Clean up old completed events
      const cleanedEvents = await this.outboxService.cleanupOldEvents(7); // 7 days
      
      // Reset error history
      this.stats.errors = [];
      
      this.logger.info('Outbox processor maintenance completed', {
        context: 'OutboxProcessorService',
        cleanedEvents,
      });
      
      return { cleanedEvents };
    } catch (error) {
      this.logger.error('Outbox processor maintenance failed', {
        context: 'OutboxProcessorService',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      
      throw new AppError(
        500,
        ErrorCodes.INTERNAL_SERVER_ERROR,
        'Failed to perform maintenance',
      );
    }
  }
}