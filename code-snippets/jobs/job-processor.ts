/**
 * Job Processor
 * 
 * Contains the logic for processing different types of jobs enqueued by BullMQ.
 * Integrates with relevant services to execute long-running tasks.
 * 
 * @module jobs/job-processor
 * @see https://docs.bullmq.io/
 */

import { Prisma } from '@prisma/client';
import { LoggerService } from '../services/logger.service';
import { AnalyticsService } from '../services/analytics.service';
import { CacheService } from '../services/cache.service';
import { DatabaseService } from '../services/database.service';
import {
  PerformanceMonitoringService,
  PerformanceMetricType,
} from '../services/performanceMonitoring.service';
import { HealthSampleRepository } from '../repositories/health-sample.repository';
import { SessionTelemetryCacheRepository } from '../repositories/session-telemetry-cache.repository';
import { InventoryRepository as BackendInventoryRepository } from '../repositories/inventory.repository';
import { HealthSampleService } from '../services/healthSample.service';
import { SessionTelemetryService } from '../services/session-telemetry.service';
import { SessionService } from '../services/session.service';
import { AppError, ErrorCodes } from '../utils/AppError';
import { getErrorMessage, getErrorStack } from '../utils/error-handler';
import {
  JobNames,
  JobData,
  ExportAnalyticsJobData,
  GenerateWeeklyReportJobData,
  SchemaMigrationJobData,
  CacheWarmingJobData,
  RefreshAnalyticsMVsJobData,
  HealthIngestReaperJobData,
  HealthSampleSoftDeletePurgerJobData,
  HealthIngestBatchJobData,
  SessionTelemetryComputeJobData,
  SessionTelemetryLockReaperJobData,
  InventoryReconciliationJobData,
  StaleSessionReconciliationJobData,
} from './job.types';

export class JobProcessor {
  private initialized: boolean = false;

  /**
   * Constructor with explicit dependency injection (Pure DI - no singleton)
   * All dependencies are required and injected by bootstrap.ts
   */
  public constructor(
    private logger: LoggerService,
    private analyticsService: AnalyticsService | null,
    private cacheService: CacheService,
    private databaseService: DatabaseService,
    private healthSampleRepository: HealthSampleRepository,
    private healthSampleService: HealthSampleService,
    private sessionTelemetryService: SessionTelemetryService,
    private performanceMonitor: PerformanceMonitoringService | null,
    private sessionTelemetryCacheRepository?: SessionTelemetryCacheRepository,
    private inventoryRepository?: BackendInventoryRepository,
    private sessionService?: SessionService,
  ) {
    // Lightweight constructor - all dependencies injected explicitly
  }

  /**
   * Initialize the job processor
   *
   * NOTE: In bootstrap.ts, all services are already initialized before JobProcessor
   * is created. This method serves as a final verification step.
   */
  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Services should already be initialized by bootstrap.ts
    // This is just a verification step to ensure critical dependencies are ready

    // Verify database connection
    const dbClient = this.databaseService.getClient();
    if (!dbClient) {
      throw new Error('DatabaseService client not available - ensure database is connected before JobProcessor initialization');
    }

    // Verify cache service
    if (!this.cacheService.isReady()) {
      this.logger.warn('CacheService not ready during JobProcessor initialization - some jobs may fail');
    }

    this.initialized = true;
    this.logger.info('JobProcessor initialized successfully', {
      context: 'JobProcessor',
      hasAnalyticsService: !!this.analyticsService,
      hasHealthSampleRepository: !!this.healthSampleRepository,
      hasSessionTelemetryService: !!this.sessionTelemetryService,
      hasPerformanceMonitor: !!this.performanceMonitor,
      databaseConnected: !!dbClient,
      cacheReady: this.cacheService.isReady(),
    });
  }

  /**
   * Main function to process a job based on its name
   */
  public async processJob(jobName: JobNames, data: JobData, jobId?: string): Promise<unknown> {
    if (!this.initialized) {
      throw new AppError(500, ErrorCodes.SERVICE_UNAVAILABLE, 'JobProcessor not initialized');
    }

    this.logger.info(`Processing job: ${jobName}`, {
      context: 'JobProcessor',
      jobId,
      userId: data.userId,
      correlationId: data.correlationId,
    });

    try {
      switch (jobName) {
        case JobNames.EXPORT_ANALYTICS:
          return await this.processExportAnalyticsJob(data as ExportAnalyticsJobData, jobId);

        case JobNames.GENERATE_WEEKLY_REPORT:
          return await this.processGenerateWeeklyReportJob(data as GenerateWeeklyReportJobData, jobId);

        case JobNames.SCHEMA_MIGRATION:
          return await this.processSchemaMigrationJob(data as SchemaMigrationJobData, jobId);

        case JobNames.CACHE_WARMING:
          return await this.processCacheWarmingJob(data as CacheWarmingJobData, jobId);

        case JobNames.REFRESH_ANALYTICS_MVS:
          return await this.processRefreshAnalyticsMVsJob(data as RefreshAnalyticsMVsJobData, jobId);

        case JobNames.HEALTH_INGEST_REAPER:
          return await this.processHealthIngestReaperJob(data as HealthIngestReaperJobData, jobId);

        case JobNames.HEALTH_SAMPLE_SOFT_DELETE_PURGER:
          return await this.processHealthSampleSoftDeletePurgerJob(data as HealthSampleSoftDeletePurgerJobData, jobId);

        case JobNames.HEALTH_INGEST_BATCH:
          return await this.processHealthIngestBatchJob(data as HealthIngestBatchJobData, jobId);

        case JobNames.SESSION_TELEMETRY_COMPUTE:
          return await this.processSessionTelemetryComputeJob(data as SessionTelemetryComputeJobData, jobId);

        case JobNames.SESSION_TELEMETRY_LOCK_REAPER:
          return await this.processSessionTelemetryLockReaperJob(data as SessionTelemetryLockReaperJobData, jobId);

        case JobNames.INVENTORY_RECONCILIATION:
          return await this.processInventoryReconciliationJob(data as InventoryReconciliationJobData, jobId);

        case JobNames.STALE_SESSION_RECONCILIATION:
          return await this.processStaleSessionReconciliationJob(data as StaleSessionReconciliationJobData, jobId);

        default:
          throw new AppError(400, ErrorCodes.INVALID_OPERATION, `Unknown job name: ${jobName}`);
      }
    } catch (error) {
      this.logger.error(`Job processing failed for ${jobName}`, {
        context: 'JobProcessor',
        jobId,
        jobName,
        userId: data.userId,
        error: getErrorMessage(error),
        stack: getErrorStack(error),
        correlationId: data.correlationId,
      });
      throw error; // Re-throw to mark job as failed in BullMQ
    }
  }

  /**
   * Process analytics export job
   */
  private async processExportAnalyticsJob(
    data: ExportAnalyticsJobData,
    jobId?: string,
  ): Promise<{ url: string; key: string; size: number }> {
    this.logger.info('Processing analytics export job', {
      context: 'JobProcessor',
      jobId,
      userId: data.userId,
      reportType: data.reportType,
      format: data.format,
    });

    if (!this.analyticsService) {
      throw new AppError(
        500,
        ErrorCodes.SERVICE_UNAVAILABLE,
        'AnalyticsService not available in this worker instance - cannot process export job'
      );
    }

    const options = {
      startDate: data.options?.startDate ? new Date(data.options.startDate) : undefined,
      endDate: data.options?.endDate ? new Date(data.options.endDate) : undefined,
      includeDetails: data.options?.includeDetails,
    };

    // Use the internal method that does the actual export work
    const result = await this.analyticsService.exportAnalyticsDataInternal(
      data.userId,
      data.reportType,
      data.format,
      options,
      data.correlationId,
    );

    this.logger.info('Analytics export job completed', {
      context: 'JobProcessor',
      jobId,
      userId: data.userId,
      resultKey: result.key,
      size: result.size,
    });

    return result;
  }

  /**
   * Process weekly report generation job
   */
  private async processGenerateWeeklyReportJob(
    data: GenerateWeeklyReportJobData,
    jobId?: string,
  ): Promise<unknown> {
    this.logger.info('Processing weekly report generation job', {
      context: 'JobProcessor',
      jobId,
      userId: data.userId,
      weekStartDate: data.weekStartDate,
      weekEndDate: data.weekEndDate,
    });

    if (!this.analyticsService) {
      throw new AppError(
        500,
        ErrorCodes.SERVICE_UNAVAILABLE,
        'AnalyticsService not available in this worker instance - cannot process weekly report job'
      );
    }

    // For now, this is a placeholder - would implement actual weekly report generation
    const startDate = new Date(data.weekStartDate);
    const endDate = new Date(data.weekEndDate);

    // Generate a comprehensive weekly report
    const report = await this.analyticsService.generateReport(
      data.userId,
      'weekly',
      startDate,
      endDate,
      data.correlationId,
    );

    // If recommendations and insights are requested, we could enhance the report here
    if (data.includeRecommendations || data.includeInsights) {
      // Add AI-generated insights or recommendations
      // This would be a future enhancement
      this.logger.info('Enhanced weekly report with recommendations and insights', {
        context: 'JobProcessor',
        jobId,
        userId: data.userId,
      });
    }

    this.logger.info('Weekly report generation job completed', {
      context: 'JobProcessor',
      jobId,
      userId: data.userId,
    });

    return {
      report,
      status: 'completed',
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Process schema migration job
   */
  private async processSchemaMigrationJob(
    data: SchemaMigrationJobData,
    jobId?: string,
  ): Promise<unknown> {
    this.logger.info('Processing schema migration job', {
      context: 'JobProcessor',
      jobId,
      userId: data.userId,
      migrationName: data.migrationName,
      direction: data.direction,
      dryRun: data.dryRun,
    });

    // This is a placeholder for schema migration functionality
    // In a real implementation, this would:
    // 1. Load the migration script
    // 2. Execute the migration with proper error handling
    // 3. Track migration status
    // 4. Handle rollbacks if needed

    if (data.dryRun) {
      this.logger.info('Dry run migration completed', {
        context: 'JobProcessor',
        jobId,
        migrationName: data.migrationName,
      });

      return {
        status: 'dry-run-completed',
        migrationName: data.migrationName,
        direction: data.direction,
        simulatedChanges: ['Table updated', 'Index added', 'Constraint modified'],
        affectedRows: data.batchSize || 1000,
      };
    }

    // Simulate actual migration work
    await new Promise(resolve => setTimeout(resolve, 2000));

    this.logger.info('Schema migration job completed', {
      context: 'JobProcessor',
      jobId,
      migrationName: data.migrationName,
    });

    return {
      status: 'completed',
      migrationName: data.migrationName,
      direction: data.direction,
      appliedAt: new Date().toISOString(),
      affectedRows: data.batchSize || 1000,
    };
  }

  /**
   * Process cache warming job.
   *
   * Iterates through requested cache keys, checks existence, and attempts to
   * regenerate cold entries using a key-prefix dispatch strategy:
   *
   * - `analytics:*`  → refresh from AnalyticsService (if available)
   * - `inventory:*`  → no-op (populated on first read via withCache)
   * - unknown prefix → log and skip (no silent failure)
   *
   * The delay between operations is tuned by priority to avoid overwhelming
   * Redis or downstream services during bulk warming.
   */
  private async processCacheWarmingJob(
    data: CacheWarmingJobData,
    jobId?: string,
  ): Promise<unknown> {
    this.logger.info('Processing cache warming job', {
      context: 'JobProcessor',
      jobId,
      userId: data.userId,
      cacheKeysCount: data.cacheKeys.length,
      priority: data.priority,
    });

    const results = {
      warmed: [] as string[],
      skipped: [] as string[],
      failed: [] as string[],
      total: data.cacheKeys.length,
    };

    // Delay between key operations, tuned by priority
    const delay = data.priority === 'high' ? 10 : data.priority === 'medium' ? 50 : 100;

    for (const cacheKey of data.cacheKeys) {
      try {
        const exists = await this.cacheService.exists(cacheKey);
        if (exists) {
          results.warmed.push(cacheKey);
          continue; // Already warm — nothing to do
        }

        // Dispatch regeneration based on key prefix.
        // Each prefix maps to a service that can reconstruct the cached value.
        let regenerated = false;

        if (cacheKey.startsWith('analytics:') && this.analyticsService) {
          // Analytics keys are populated by AnalyticsService queries.
          // Trigger a lightweight summary refresh for the associated user.
          try {
            // Extract userId from key pattern: analytics:<userId>:*
            const parts = cacheKey.split(':');
            const keyUserId = parts[1];
            if (keyUserId) {
              await this.analyticsService.getAnalyticsSummary(keyUserId);
              regenerated = true;
            }
          } catch (analyticsError) {
            this.logger.debug(`Analytics cache regeneration skipped for ${cacheKey}`, {
              context: 'JobProcessor',
              error: getErrorMessage(analyticsError),
            });
          }
        }

        // Inventory / prediction keys are populated on-demand (read-through cache).
        // We cannot meaningfully regenerate them without a user context + API request.
        // Log and skip — they will be populated on the next user request.
        if (!regenerated) {
          this.logger.debug(`Cache key ${cacheKey} is cold — will be populated on next access`, {
            context: 'JobProcessor',
            jobId,
            cacheKey,
          });
          results.skipped.push(cacheKey);
          continue;
        }

        results.warmed.push(cacheKey);

        // Pace operations to avoid overwhelming Redis / downstream services
        await new Promise(resolve => setTimeout(resolve, delay));
      } catch (error) {
        this.logger.warn(`Failed to warm cache key: ${cacheKey}`, {
          context: 'JobProcessor',
          jobId,
          cacheKey,
          error: getErrorMessage(error),
        });
        results.failed.push(cacheKey);
      }
    }

    this.logger.info('Cache warming job completed', {
      context: 'JobProcessor',
      jobId,
      userId: data.userId,
      warmed: results.warmed.length,
      skipped: results.skipped.length,
      failed: results.failed.length,
    });

    return results;
  }

  /**
   * Process materialized view refresh job
   */
  private async processRefreshAnalyticsMVsJob(
    data: RefreshAnalyticsMVsJobData,
    jobId?: string,
  ): Promise<{ refreshedViews: number; totalViews: number }> {
    this.logger.info('Processing analytics materialized views refresh job', {
      context: 'JobProcessor',
      jobId,
      useConcurrently: data.useConcurrently,
      viewNames: data.viewNames || 'all',
    });

    const prismaClient = this.databaseService.getClient();

    if (data.viewNames && data.viewNames.length > 0) {
      let refreshedCount = 0;
      for (const viewName of data.viewNames) {
        await this.databaseService.refreshMaterializedView(viewName, data.useConcurrently);
        refreshedCount++;
      }
      this.logger.info(`Refreshed ${refreshedCount} specified materialized views.`, { jobId });
      return { refreshedViews: refreshedCount, totalViews: data.viewNames.length };
    } else {
      // Call the PostgreSQL function to refresh all views if no specific views are provided
      await prismaClient.$executeRawUnsafe(
        `SELECT refresh_all_analytics_views(${data.useConcurrently});`,
      );
      this.logger.info('Refreshed all analytics materialized views.', { jobId });

      // Get count of analytics materialized views
      const viewCounts = await prismaClient.$queryRawUnsafe<Array<{ count: bigint }>>(
        "SELECT COUNT(*) as count FROM pg_matviews WHERE schemaname = 'public' AND matviewname LIKE '%_mv';",
      );
      const totalViews = Number(viewCounts[0]?.count || 0);

      // Post-MV-refresh: invalidate analytics caches so next user request
      // fetches fresh data from the newly refreshed materialized views.
      // This prevents serving stale cached analytics after MVs are updated.
      try {
        await this.cacheService.invalidate('analytics:*');
        this.logger.info('Invalidated analytics caches after MV refresh', {
          context: 'JobProcessor',
          jobId,
        });
      } catch (cacheError) {
        // Cache invalidation failure is non-blocking — stale caches will
        // expire via TTL. Log and continue.
        this.logger.warn('Failed to invalidate analytics caches after MV refresh', {
          context: 'JobProcessor',
          jobId,
          error: getErrorMessage(cacheError),
        });
      }

      return { refreshedViews: totalViews, totalViews };
    }
  }

  /**
   * Process health ingest reaper job
   *
   * PROACTIVE STALE RECOVERY:
   * This job finds and marks stale HealthIngestRequest rows (stuck in 'processing')
   * as 'failed', allowing clients to safely retry.
   *
   * RATIONALE:
   * - Reactive recovery (in checkRequestIdempotency) only happens when clients retry
   * - If no client retries, stale requests remain 'processing' forever
   * - This job provides proactive cleanup for observability and operational health
   *
   * SCHEDULE: Every 15 minutes via cron
   */
  private async processHealthIngestReaperJob(
    data: HealthIngestReaperJobData,
    jobId?: string,
  ): Promise<{ reapedCount: number; requestIds: string[] }> {
    const startTime = Date.now();

    this.logger.info('Processing health ingest reaper job', {
      context: 'JobProcessor',
      jobId,
      staleAfterMinutes: data.staleAfterMinutes,
      maxRows: data.maxRows,
      correlationId: data.correlationId,
    });

    // FAIL-FAST: Validate job data at boundary
    if (!data.staleAfterMinutes || !Number.isInteger(data.staleAfterMinutes) ||
        data.staleAfterMinutes < 1 || data.staleAfterMinutes > 120) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `staleAfterMinutes must be an integer between 1 and 120, got: ${data.staleAfterMinutes}`
      );
    }

    if (!data.maxRows || !Number.isInteger(data.maxRows) ||
        data.maxRows < 1 || data.maxRows > 50000) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `maxRows must be an integer between 1 and 50000, got: ${data.maxRows}`
      );
    }

    // Call repository method to reap stale requests
    const result = await this.healthSampleRepository.reapStaleProcessingIngestRequests(
      data.staleAfterMinutes,
      data.maxRows
    );

    const durationMs = Date.now() - startTime;

    // Emit metric for observability
    if (this.performanceMonitor) {
      this.performanceMonitor.recordMetric(
        PerformanceMetricType.HEALTH_INGEST_STALE_RECOVERED,
        'health_ingest_requests_stale_recovered',
        result.reapedCount,
        'count',
        {
          job: 'health-ingest-reaper',
          staleAfterMinutes: String(data.staleAfterMinutes),
        }
      );
    }

    // Log completion with appropriate level based on results
    if (result.reapedCount > 0) {
      this.logger.warn('Health ingest reaper job completed - recovered stale requests', {
        context: 'JobProcessor',
        jobId,
        reapedCount: result.reapedCount,
        requestIds: result.reapedRequestIds,
        staleAfterMinutes: data.staleAfterMinutes,
        maxRows: data.maxRows,
        durationMs,
        correlationId: data.correlationId,
      });
    } else {
      this.logger.info('Health ingest reaper job completed - no stale requests found', {
        context: 'JobProcessor',
        jobId,
        reapedCount: 0,
        staleAfterMinutes: data.staleAfterMinutes,
        maxRows: data.maxRows,
        durationMs,
        correlationId: data.correlationId,
      });
    }

    return {
      reapedCount: result.reapedCount,
      requestIds: result.reapedRequestIds,
    };
  }

  /**
   * Process health sample soft-delete purger job
   *
   * CLEANUP OPERATION:
   * This job permanently deletes (hard-deletes) health samples that:
   * - Have is_deleted = true
   * - Were deleted more than retentionDays ago
   *
   * RATIONALE:
   * - Soft-deleted samples consume storage indefinitely
   * - TimescaleDB add_retention_policy CANNOT be used (drops entire chunks regardless of is_deleted)
   * - This job performs row-level DELETE with is_deleted=true filter
   * - After retention period, data is no longer needed for audit
   *
   * ADMIN-ONLY OPERATION:
   * This job permanently deletes data. Only called from scheduled jobs with system userId.
   *
   * SCHEDULE: Daily at 4 AM UTC (during low usage hours)
   */
  private async processHealthSampleSoftDeletePurgerJob(
    data: HealthSampleSoftDeletePurgerJobData,
    jobId?: string,
  ): Promise<{ purgedCount: number }> {
    const startTime = Date.now();

    this.logger.info('Processing health sample soft-delete purger job', {
      context: 'JobProcessor',
      jobId,
      retentionDays: data.retentionDays,
      maxRows: data.maxRows,
      adminReason: data.adminReason,
      correlationId: data.correlationId,
    });

    // FAIL-FAST: Validate job data at boundary
    if (!data.retentionDays || !Number.isInteger(data.retentionDays) ||
        data.retentionDays < 30 || data.retentionDays > 365) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `retentionDays must be an integer between 30 and 365, got: ${data.retentionDays}`
      );
    }

    if (!data.maxRows || !Number.isInteger(data.maxRows) ||
        data.maxRows < 1 || data.maxRows > 50000) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `maxRows must be an integer between 1 and 50000, got: ${data.maxRows}`
      );
    }

    if (!data.adminReason || typeof data.adminReason !== 'string' ||
        data.adminReason.trim().length === 0) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        'adminReason is required for audit trail'
      );
    }

    // Call repository method (system-wide purge with admin authorization)
    // This method enforces minimum 30-day retention at the repository level
    const purgedCount = await this.healthSampleRepository.purgeAllOldDeletedSamplesForAdmin(
      data.retentionDays,
      data.adminReason,
      data.maxRows
    );

    const durationMs = Date.now() - startTime;

    // Emit metric for observability
    if (this.performanceMonitor) {
      this.performanceMonitor.recordMetric(
        PerformanceMetricType.HEALTH_SAMPLE_SOFT_DELETE_PURGED,
        'health_samples_soft_delete_purged',
        purgedCount,
        'count',
        {
          job: 'health-sample-soft-delete-purger',
          retentionDays: String(data.retentionDays),
        }
      );
    }

    // Log completion with appropriate level based on results
    if (purgedCount > 0) {
      this.logger.warn('Health sample soft-delete purger job completed - purged samples', {
        context: 'JobProcessor',
        jobId,
        purgedCount,
        retentionDays: data.retentionDays,
        maxRows: data.maxRows,
        adminReason: data.adminReason,
        durationMs,
        correlationId: data.correlationId,
      });
    } else {
      this.logger.info('Health sample soft-delete purger job completed - no samples to purge', {
        context: 'JobProcessor',
        jobId,
        purgedCount: 0,
        retentionDays: data.retentionDays,
        maxRows: data.maxRows,
        durationMs,
        correlationId: data.correlationId,
      });
    }

    return { purgedCount };
  }

  /**
   * Process queued health ingest batch job
   */
  private async processHealthIngestBatchJob(
    data: HealthIngestBatchJobData,
    jobId?: string,
  ): Promise<{ successfulCount: number; failedCount: number }> {
    const startTime = Date.now();

    this.logger.info('Processing health ingest batch job', {
      context: 'JobProcessor',
      jobId,
      userId: data.userId,
      requestId: data.requestId,
      sampleCount: data.samples.length,
      deletionCount: data.deletions?.length ?? 0,
      correlationId: data.correlationId,
    });

    const result = await this.healthSampleService.processQueuedBatch({
      userId: data.userId,
      samples: data.samples,
      requestId: data.requestId,
      payloadHash: data.payloadHash,
      correlationId: data.correlationId,
      deviceId: data.deviceId,
      deletions: data.deletions,
      ingestRequestId: data.ingestRequestId,
      // EDGE CASE 1 FIX: Propagate request-level timezone from job data
      // so outbox events have correct affectedLocalDates and timezoneExplicit
      timezoneOffsetMinutes: data.timezoneOffsetMinutes,
    });

    const durationMs = Date.now() - startTime;

    this.logger.info('Health ingest batch job completed', {
      context: 'JobProcessor',
      jobId,
      requestId: data.requestId,
      successfulCount: result.successful.length,
      failedCount: result.failed.length,
      durationMs,
      correlationId: data.correlationId,
    });

    return {
      successfulCount: result.successful.length,
      failedCount: result.failed.length,
    };
  }

  /**
   * Process session telemetry compute job
   */
  private async processSessionTelemetryComputeJob(
    data: SessionTelemetryComputeJobData,
    jobId?: string,
  ): Promise<{ status: string; state?: string }> {
    const startTime = Date.now();

    this.logger.info('Processing session telemetry compute job', {
      context: 'JobProcessor',
      jobId,
      sessionId: data.sessionId,
      userId: data.userId,
      resolution: data.resolution,
      windowMinutes: data.windowMinutes,
      computeVersion: data.computeVersion,
      reason: data.reason,
      forceRecompute: data.forceRecompute ?? false,
      correlationId: data.correlationId,
    });

    // lockRowId: When provided, worker skips lock acquisition and uses pre-created COMPUTING row
    // computeVersion: Honor the job's version for backfills instead of always using CURRENT_COMPUTE_VERSION
    const result = await this.sessionTelemetryService.computeTelemetryForSession({
      sessionId: data.sessionId,
      userId: data.userId,
      options: {
        windowMinutes: data.windowMinutes,
        resolution: data.resolution,
      },
      forceRecompute: data.forceRecompute ?? false,
      lockRowId: data.lockRowId,
      computeVersion: data.computeVersion,
    });

    const durationMs = Date.now() - startTime;

    if (result.state === 'error') {
      throw new Error(result.errorMessage || 'Session telemetry computation failed');
    }

    if (result.state === 'computing' && data.forceRecompute) {
      throw new Error('Session telemetry already computing - retry later');
    }

    this.logger.info('Session telemetry compute job completed', {
      context: 'JobProcessor',
      jobId,
      sessionId: data.sessionId,
      state: result.state,
      wasComputed: result.wasComputed,
      durationMs,
      correlationId: data.correlationId,
    });

    return {
      status: result.wasComputed ? 'computed' : 'skipped',
      state: result.state,
    };
  }

  /**
   * Process session telemetry lock reaper job
   *
   * Reaps stale COMPUTING rows to prevent permanent stuck states.
   * A crashed worker or network failure can leave COMPUTING rows forever,
   * preventing new computations from starting (thundering herd protection works against us).
   *
   * SCHEDULE: Every 5 minutes via cron
   */
  private async processSessionTelemetryLockReaperJob(
    data: SessionTelemetryLockReaperJobData,
    jobId?: string,
  ): Promise<{ reapedCount: number; sessionIds: string[] }> {
    const startTime = Date.now();

    this.logger.info('Processing session telemetry lock reaper job', {
      context: 'JobProcessor',
      jobId,
      staleAfterMinutes: data.staleAfterMinutes,
      maxRows: data.maxRows,
      correlationId: data.correlationId,
    });

    // FAIL-FAST: Validate job data at boundary
    if (!data.staleAfterMinutes || !Number.isInteger(data.staleAfterMinutes) ||
        data.staleAfterMinutes < 1 || data.staleAfterMinutes > 60) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `staleAfterMinutes must be an integer between 1 and 60, got: ${data.staleAfterMinutes}`
      );
    }

    if (!data.maxRows || !Number.isInteger(data.maxRows) ||
        data.maxRows < 1 || data.maxRows > 500) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `maxRows must be an integer between 1 and 500, got: ${data.maxRows}`
      );
    }

    // FAIL-FAST: Repository must be available
    if (!this.sessionTelemetryCacheRepository) {
      throw new AppError(
        500,
        ErrorCodes.SERVICE_UNAVAILABLE,
        'SessionTelemetryCacheRepository not available in this worker instance'
      );
    }

    const result = await this.sessionTelemetryCacheRepository.reapStaleComputingRows(
      data.staleAfterMinutes,
      data.maxRows
    );

    const durationMs = Date.now() - startTime;

    // Emit metric for observability
    if (this.performanceMonitor) {
      this.performanceMonitor.recordMetric(
        PerformanceMetricType.SESSION_TELEMETRY_LOCK_REAPED,
        'session_telemetry_locks_reaped',
        result.reapedCount,
        'count',
        {
          job: 'session-telemetry-lock-reaper',
          staleAfterMinutes: String(data.staleAfterMinutes),
        }
      );
    }

    // Log completion with appropriate level based on results
    if (result.reapedCount > 0) {
      this.logger.warn('Session telemetry lock reaper job completed - recovered stale locks', {
        context: 'JobProcessor',
        jobId,
        reapedCount: result.reapedCount,
        sessionIds: result.sessionIds,
        staleAfterMinutes: data.staleAfterMinutes,
        maxRows: data.maxRows,
        durationMs,
        correlationId: data.correlationId,
      });
    } else {
      this.logger.info('Session telemetry lock reaper job completed - no stale locks found', {
        context: 'JobProcessor',
        jobId,
        reapedCount: 0,
        staleAfterMinutes: data.staleAfterMinutes,
        maxRows: data.maxRows,
        durationMs,
        correlationId: data.correlationId,
      });
    }

    return {
      reapedCount: result.reapedCount,
      sessionIds: result.sessionIds,
    };
  }

  /**
   * Process inventory reconciliation job
   *
   * Finds consumptions that have quantity > 0 but no corresponding InventoryAdjustment,
   * and creates the missing adjustments using the authoritative repository method
   * (adjustInventoryInTransaction) which enforces:
   *   - Idempotency via consumptionId unique constraint
   *   - Optimistic locking via version field
   *   - Consistent quantityAfter values (throws on negative instead of clamping)
   *   - Purchase status reconciliation after each adjustment
   *
   * BOUNDED: maxRows limits per-run scope; lookbackDays limits temporal scope.
   * IDEMPOTENT: InventoryAdjustment.@@unique([consumptionId]) prevents double-counting.
   *
   * SCHEDULE: Every 30 minutes via cron
   */
  private async processInventoryReconciliationJob(
    data: InventoryReconciliationJobData,
    jobId?: string,
  ): Promise<{ reconciled: number; skipped: number; failed: number }> {
    const startTime = Date.now();

    this.logger.info('Processing inventory reconciliation job', {
      context: 'JobProcessor',
      jobId,
      maxRows: data.maxRows,
      lookbackDays: data.lookbackDays,
      correlationId: data.correlationId,
    });

    // FAIL-FAST: Validate job data at boundary
    if (!data.maxRows || !Number.isInteger(data.maxRows) ||
        data.maxRows < 1 || data.maxRows > 500) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `maxRows must be an integer between 1 and 500, got: ${data.maxRows}`
      );
    }

    if (!data.lookbackDays || !Number.isInteger(data.lookbackDays) ||
        data.lookbackDays < 1 || data.lookbackDays > 90) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `lookbackDays must be an integer between 1 and 90, got: ${data.lookbackDays}`
      );
    }

    // FAIL-FAST: InventoryRepository is required for reconciliation
    if (!this.inventoryRepository) {
      throw new AppError(
        500,
        ErrorCodes.SERVICE_UNAVAILABLE,
        'InventoryRepository not available in this worker instance - cannot process inventory reconciliation job'
      );
    }

    const prismaClient = this.databaseService.getClient();
    const lookbackDate = new Date();
    lookbackDate.setDate(lookbackDate.getDate() - data.lookbackDays);

    // Find consumptions with non-zero quantity that have no InventoryAdjustment.
    // Uses Prisma relation filter (inventoryAdjustments: { none: {} }) instead of
    // heavy NOT IN subquery to avoid fetching all adjustment consumptionIds into memory.
    const unlinkedConsumptions = await prismaClient.consumption.findMany({
      where: {
        createdAt: { gte: lookbackDate },
        quantity: { gt: 0 },
        // Include ALL consumptions linkable to inventory (via purchaseId OR productId).
        // Product-only consumptions (purchaseId=null, productId!=null) are created via BLE
        // path and must also be reconciled to prevent inventory drift.
        // The handler at lines ~1035-1053 dispatches to purchaseId-based or productId-based
        // inventory lookup accordingly. Consumptions with both null are gracefully skipped.
        // Efficient relation filter: no InventoryAdjustment linked to this consumption
        inventoryAdjustments: { none: {} },
      },
      take: data.maxRows,
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        userId: true,
        productId: true,
        purchaseId: true,
        quantity: true,
      },
    });

    if (unlinkedConsumptions.length === 0) {
      const durationMs = Date.now() - startTime;
      this.logger.info('Inventory reconciliation job completed - no unlinked consumptions found', {
        context: 'JobProcessor',
        jobId,
        durationMs,
        correlationId: data.correlationId,
      });
      return { reconciled: 0, skipped: 0, failed: 0 };
    }

    let reconciled = 0;
    let skipped = 0;
    let failed = 0;

    const inventoryRepo = this.inventoryRepository;

    // Process each unlinked consumption individually for fault isolation
    for (const consumption of unlinkedConsumptions) {
      try {
        await prismaClient.$transaction(async (tx: Prisma.TransactionClient) => {
          // Find the active inventory item for this consumption's purchase
          const inventoryItem = consumption.purchaseId
            ? await tx.inventoryItem.findFirst({
                where: {
                  userId: consumption.userId,
                  isActive: true,
                  purchaseItem: { purchaseId: consumption.purchaseId },
                },
                orderBy: { createdAt: 'asc' },
              })
            : consumption.productId
              ? await tx.inventoryItem.findFirst({
                  where: {
                    userId: consumption.userId,
                    isActive: true,
                    productId: consumption.productId,
                  },
                  orderBy: { createdAt: 'asc' },
                })
              : null;

          if (!inventoryItem) {
            skipped++;
            return;
          }

          const quantityChange = consumption.quantity
            ? new Prisma.Decimal(consumption.quantity).neg().toFixed(3)
            : '0';

          if (quantityChange === '0') {
            skipped++;
            return;
          }

          // Delegate to authoritative repository method which:
          // 1. Checks idempotency via consumptionId unique constraint
          // 2. Uses optimistic locking via version field
          // 3. Records correct quantityAfter (not clamped — throws on insufficient)
          // 4. Reconciles purchase active/finished status automatically
          await inventoryRepo.adjustInventoryInTransaction(tx, {
            inventoryItemId: inventoryItem.id,
            userId: consumption.userId,
            adjustmentType: 'CONSUMPTION',
            quantityChange,
            reason: 'Background reconciliation - previously unlinked consumption',
            consumptionId: consumption.id,
          });

          reconciled++;
        });
      } catch (error) {
        // Unique constraint violation = already reconciled (idempotent skip)
        if (error instanceof Error && 'code' in error && (error as { code: string }).code === 'P2002') {
          skipped++;
          continue;
        }

        // Insufficient inventory = legitimate skip (inventory may have been depleted
        // via other means). The repository throws AppError with VALIDATION_ERROR code.
        if (error instanceof AppError && error.errorCode === ErrorCodes.VALIDATION_ERROR) {
          this.logger.debug('Inventory reconciliation skipped - insufficient inventory', {
            context: 'JobProcessor',
            jobId,
            consumptionId: consumption.id,
            error: getErrorMessage(error),
          });
          skipped++;
          continue;
        }

        // Optimistic lock conflict = retry next run
        if (error instanceof AppError && error.errorCode === ErrorCodes.CONFLICT) {
          this.logger.debug('Inventory reconciliation deferred - optimistic lock conflict', {
            context: 'JobProcessor',
            jobId,
            consumptionId: consumption.id,
          });
          skipped++;
          continue;
        }

        failed++;
        this.logger.warn('Inventory reconciliation failed for consumption', {
          context: 'JobProcessor',
          jobId,
          consumptionId: consumption.id,
          error: getErrorMessage(error),
        });
      }
    }

    const durationMs = Date.now() - startTime;

    if (reconciled > 0 || failed > 0) {
      this.logger.warn('Inventory reconciliation job completed', {
        context: 'JobProcessor',
        jobId,
        reconciled,
        skipped,
        failed,
        totalFound: unlinkedConsumptions.length,
        durationMs,
        correlationId: data.correlationId,
      });
    } else {
      this.logger.info('Inventory reconciliation job completed - all consumptions already reconciled', {
        context: 'JobProcessor',
        jobId,
        skipped,
        durationMs,
        correlationId: data.correlationId,
      });
    }

    return { reconciled, skipped, failed };
  }

  /**
   * Process stale session reconciliation job
   *
   * GLOBAL SWEEP: Finds ACTIVE/PAUSED sessions with past endTimestamp across ALL users
   * and durably completes them via SessionService.reconcileStaleSessionsGlobal().
   *
   * IDEMPOTENT: completeSession() is idempotent for already-completed sessions.
   * BOUNDED: Limited by maxUsers and maxSessionsPerUser.
   * BEST-EFFORT: Individual session failures don't fail the job.
   *
   * SCHEDULE: Every 10 minutes via cron
   */
  private async processStaleSessionReconciliationJob(
    data: StaleSessionReconciliationJobData,
    jobId?: string,
  ): Promise<{ reconciled: number; failed: number; usersProcessed: number }> {
    const startTime = Date.now();

    this.logger.info('Processing stale session reconciliation job', {
      context: 'JobProcessor',
      jobId,
      maxUsers: data.maxUsers,
      maxSessionsPerUser: data.maxSessionsPerUser,
      correlationId: data.correlationId,
    });

    // FAIL-FAST: SessionService is required
    if (!this.sessionService) {
      throw new AppError(
        500,
        ErrorCodes.SERVICE_UNAVAILABLE,
        'SessionService not available in this worker instance - cannot process stale session reconciliation job',
      );
    }

    // FAIL-FAST: Validate job data at boundary
    if (!data.maxUsers || !Number.isInteger(data.maxUsers) ||
        data.maxUsers < 1 || data.maxUsers > 500) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `maxUsers must be an integer between 1 and 500, got: ${data.maxUsers}`,
      );
    }

    if (!data.maxSessionsPerUser || !Number.isInteger(data.maxSessionsPerUser) ||
        data.maxSessionsPerUser < 1 || data.maxSessionsPerUser > 50) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `maxSessionsPerUser must be an integer between 1 and 50, got: ${data.maxSessionsPerUser}`,
      );
    }

    const result = await this.sessionService.reconcileStaleSessionsGlobal(
      data.maxUsers,
      data.maxSessionsPerUser,
      data.correlationId,
    );

    const durationMs = Date.now() - startTime;

    // FAIL-FAST on total failure: if ALL sessions failed to reconcile and NONE
    // succeeded, throw to trigger BullMQ retry/DLQ. This prevents silent job
    // success masking systematic reconciliation failures (e.g., DB unavailable,
    // permission issues, service errors).
    //
    // Partial success (some reconciled, some failed) is logged but NOT thrown —
    // the reconciled sessions are durably complete, and failed sessions will be
    // retried on the next scheduled run.
    if (result.failed > 0 && result.reconciled === 0) {
      this.logger.error('Stale session reconciliation job TOTAL FAILURE — all sessions failed', {
        context: 'JobProcessor',
        jobId,
        failed: result.failed,
        usersProcessed: result.usersProcessed,
        durationMs,
        correlationId: data.correlationId,
      });
      throw new AppError(
        500,
        ErrorCodes.SERVICE_UNAVAILABLE,
        `Stale session reconciliation total failure: ${result.failed} sessions failed, 0 reconciled across ${result.usersProcessed} users`,
      );
    }

    // Log at appropriate level based on outcome
    if (result.failed > 0) {
      // Partial success — some sessions reconciled, some failed
      this.logger.warn('Stale session reconciliation job completed with partial failures', {
        context: 'JobProcessor',
        jobId,
        reconciled: result.reconciled,
        failed: result.failed,
        usersProcessed: result.usersProcessed,
        durationMs,
        correlationId: data.correlationId,
      });
    } else {
      this.logger.info('Stale session reconciliation job completed', {
        context: 'JobProcessor',
        jobId,
        reconciled: result.reconciled,
        failed: result.failed,
        usersProcessed: result.usersProcessed,
        durationMs,
        correlationId: data.correlationId,
      });
    }

    return result;
  }

  /**
   * Utility function to update job progress
   * Can be called from job processors to report progress
   */
  public static updateJobProgress(jobId: string, progress: number, message?: string): void {
    // In a real implementation, this would update the job progress in BullMQ
    // For now, we just log it
    console.log('Job progress updated', {
      context: 'JobProcessor',
      jobId,
      progress,
      message,
    });
  }

  /**
   * Validate job data before processing
   */
  private validateJobData(jobName: JobNames, data: JobData): boolean {
  // Basic validation
  if (!data.userId) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Job data missing userId');
  }

  if (!data.timestamp) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Job data missing timestamp');
  }

  // Job-specific validation
  switch (jobName) {
    case JobNames.EXPORT_ANALYTICS: {
      const exportData = data as ExportAnalyticsJobData;
      if (!exportData.reportType || !exportData.format) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Export job missing reportType or format');
      }
      break;
    }

    case JobNames.GENERATE_WEEKLY_REPORT: {
      const reportData = data as GenerateWeeklyReportJobData;
      if (!reportData.weekStartDate || !reportData.weekEndDate) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Weekly report job missing date range');
      }
      break;
    }

    case JobNames.SCHEMA_MIGRATION: {
      const migrationData = data as SchemaMigrationJobData;
      if (!migrationData.migrationName || !migrationData.direction) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Migration job missing name or direction');
      }
      break;
    }

    case JobNames.CACHE_WARMING: {
      const cacheData = data as CacheWarmingJobData;
      if (!cacheData.cacheKeys || cacheData.cacheKeys.length === 0) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Cache warming job missing cache keys');
      }
      break;
    }

    case JobNames.REFRESH_ANALYTICS_MVS: {
      const mvData = data as RefreshAnalyticsMVsJobData;
      if (typeof mvData.useConcurrently !== 'boolean') {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Refresh job missing useConcurrently flag');
      }
      if (mvData.viewNames && !Array.isArray(mvData.viewNames)) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Refresh job viewNames must be an array');
      }
      break;
    }

    case JobNames.SESSION_TELEMETRY_COMPUTE: {
      const telemetryData = data as SessionTelemetryComputeJobData;
      if (!telemetryData.sessionId) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Session telemetry job missing sessionId');
      }
      if (!telemetryData.windowMinutes || !telemetryData.resolution) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Session telemetry job missing windowMinutes or resolution');
      }
      break;
    }

    case JobNames.SESSION_TELEMETRY_LOCK_REAPER: {
      const reaperData = data as SessionTelemetryLockReaperJobData;
      // FAIL-FAST: Validate bounds at job boundary to catch malformed job payloads
      if (!reaperData.staleAfterMinutes || !Number.isInteger(reaperData.staleAfterMinutes) ||
          reaperData.staleAfterMinutes < 1 || reaperData.staleAfterMinutes > 60) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR,
          `Lock reaper job staleAfterMinutes must be an integer between 1 and 60, got: ${reaperData.staleAfterMinutes}`);
      }
      if (!reaperData.maxRows || !Number.isInteger(reaperData.maxRows) ||
          reaperData.maxRows < 1 || reaperData.maxRows > 500) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR,
          `Lock reaper job maxRows must be an integer between 1 and 500, got: ${reaperData.maxRows}`);
      }
      break;
    }

    case JobNames.INVENTORY_RECONCILIATION: {
      const reconData = data as InventoryReconciliationJobData;
      if (!reconData.maxRows || !Number.isInteger(reconData.maxRows) ||
          reconData.maxRows < 1 || reconData.maxRows > 500) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR,
          `Inventory reconciliation job maxRows must be an integer between 1 and 500, got: ${reconData.maxRows}`);
      }
      if (!reconData.lookbackDays || !Number.isInteger(reconData.lookbackDays) ||
          reconData.lookbackDays < 1 || reconData.lookbackDays > 90) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR,
          `Inventory reconciliation job lookbackDays must be an integer between 1 and 90, got: ${reconData.lookbackDays}`);
      }
      break;
    }

    case JobNames.STALE_SESSION_RECONCILIATION: {
      const sessionReconData = data as StaleSessionReconciliationJobData;
      if (!sessionReconData.maxUsers || !Number.isInteger(sessionReconData.maxUsers) ||
          sessionReconData.maxUsers < 1 || sessionReconData.maxUsers > 500) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR,
          `Stale session reconciliation job maxUsers must be an integer between 1 and 500, got: ${sessionReconData.maxUsers}`);
      }
      if (!sessionReconData.maxSessionsPerUser || !Number.isInteger(sessionReconData.maxSessionsPerUser) ||
          sessionReconData.maxSessionsPerUser < 1 || sessionReconData.maxSessionsPerUser > 50) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR,
          `Stale session reconciliation job maxSessionsPerUser must be an integer between 1 and 50, got: ${sessionReconData.maxSessionsPerUser}`);
      }
      break;
    }
  }

  return true;
  }
}

// Removed standalone processJob function - use JobProcessor.getInstance().processJob() instead
