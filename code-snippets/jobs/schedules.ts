/**
 * Job Scheduling Configuration
 *
 * Defines recurring jobs and their schedules for the AppPlatform backend system.
 * This module sets up automated materialized view refreshes and other maintenance tasks.
 *
 * @module jobs/schedules
 */

import { JobManagerService } from './job-manager.service';
import {
  JobNames,
  JobPriority,
  RefreshAnalyticsMVsJobData,
  HealthIngestReaperJobData,
  HealthSampleSoftDeletePurgerJobData,
  SessionTelemetryLockReaperJobData,
  InventoryReconciliationJobData,
  StaleSessionReconciliationJobData,
} from './job.types';
import { LoggerService } from '../services/logger.service';

/**
 * Schedule daily analytics materialized view refresh
 *
 * This job refreshes all analytics materialized views to ensure dashboard performance
 * and data freshness. Runs daily at 3 AM UTC during low usage hours.
 *
 * @param logger - LoggerService instance for structured logging (injected dependency)
 * @param jobManager - JobManagerService instance (injected dependency)
 */
export async function scheduleAnalyticsMVsRefresh(
  logger: LoggerService,
  jobManager: JobManagerService,
): Promise<void> {
  try {
    // JobManagerService must be initialized before calling this function
    if (!jobManager) {
      throw new Error('JobManagerService instance not provided. Must be initialized before scheduling jobs.');
    }

    const jobData: RefreshAnalyticsMVsJobData = {
      userId: 'system', // System-level job, no specific user
      timestamp: new Date().toISOString(),
      useConcurrently: true,
      viewNames: [], // Refresh all analytics MVs
      correlationId: `mv_refresh_${Date.now()}`,
    };

    await jobManager.enqueueJob(
      JobNames.REFRESH_ANALYTICS_MVS,
      jobData,
      {
        jobId: 'system_refresh_analytics_mvs_daily',
        priority: JobPriority.HIGH,
        config: {
          repeat: {
            cron: '0 3 * * *', // Every day at 3 AM UTC
          },
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
          delay: 60000, // Wait 1 minute before first execution attempt
        },
      },
    );

    logger.info('Scheduled daily analytics materialized views refresh job.', {
      context: 'JobScheduler',
      schedule: '0 3 * * *',
      priority: JobPriority.HIGH,
    });
  } catch (error) {
    logger.error('Failed to schedule analytics materialized views refresh job.', { 
      context: 'JobScheduler',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Schedule weekly analytics materialized view refresh
 *
 * Additional weekly refresh to ensure data consistency and handle any missed daily refreshes
 * Runs on Sundays at 2 AM UTC
 *
 * @param logger - LoggerService instance for structured logging (injected dependency)
 * @param jobManager - JobManagerService instance (injected dependency)
 */
export async function scheduleWeeklyAnalyticsMVsRefresh(
  logger: LoggerService,
  jobManager: JobManagerService,
): Promise<void> {
  try {
    // JobManagerService must be initialized before calling this function
    if (!jobManager) {
      throw new Error('JobManagerService instance not provided. Must be initialized before scheduling jobs.');
    }

    const jobData: RefreshAnalyticsMVsJobData = {
      userId: 'system',
      timestamp: new Date().toISOString(),
      useConcurrently: false, // Use non-concurrent refresh for full consistency
      viewNames: [], // Refresh all analytics MVs
      correlationId: `mv_refresh_weekly_${Date.now()}`,
    };

    await jobManager.enqueueJob(
      JobNames.REFRESH_ANALYTICS_MVS,
      jobData,
      {
        jobId: 'system_refresh_analytics_mvs_weekly',
        priority: JobPriority.HIGH,
        config: {
          repeat: {
            cron: '0 2 * * 0', // Every Sunday at 2 AM UTC
          },
          attempts: 5,
          backoff: {
            type: 'exponential',
            delay: 10000,
          },
          delay: 120000, // Wait 2 minutes before first execution attempt
        },
      },
    );

    logger.info('Scheduled weekly analytics materialized views refresh job.', {
      context: 'JobScheduler',
      schedule: '0 2 * * 0',
      priority: JobPriority.HIGH,
    });
  } catch (error) {
    logger.error('Failed to schedule weekly analytics materialized views refresh job.', { 
      context: 'JobScheduler',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Schedule high-priority materialized view refresh
 *
 * For immediate refresh needs during high-traffic periods or after system maintenance
 * Can be called programmatically when needed
 *
 * @param logger - LoggerService instance for structured logging (injected dependency)
 * @param jobManager - JobManagerService instance (injected dependency)
 * @param viewNames - Optional array of specific materialized view names to refresh
 */
export async function scheduleImmediateMVsRefresh(
  logger: LoggerService,
  jobManager: JobManagerService,
  viewNames?: string[],
): Promise<string> {
  try {
    // JobManagerService must be initialized before calling this function
    if (!jobManager) {
      throw new Error('JobManagerService instance not provided. Must be initialized before scheduling jobs.');
    }

    const jobData: RefreshAnalyticsMVsJobData = {
      userId: 'system',
      timestamp: new Date().toISOString(),
      useConcurrently: true,
      viewNames: viewNames || [], // Specific views or all if empty
      correlationId: `mv_refresh_immediate_${Date.now()}`,
    };

    const jobId = await jobManager.enqueueJob(
      JobNames.REFRESH_ANALYTICS_MVS,
      jobData,
      {
        priority: JobPriority.CRITICAL,
        config: {
          attempts: 2,
          backoff: {
            type: 'fixed',
            delay: 2000,
          },
        },
      },
    );

    logger.info('Scheduled immediate analytics materialized views refresh job.', {
      context: 'JobScheduler',
      jobId,
      viewNames: viewNames || 'all',
      priority: JobPriority.CRITICAL,
    });

    return jobId;
  } catch (error) {
    logger.error('Failed to schedule immediate analytics materialized views refresh job.', { 
      context: 'JobScheduler',
      error: error instanceof Error ? error.message : String(error),
      viewNames: viewNames || 'all',
    });
    throw error;
  }
}

/**
 * Initialize all scheduled jobs
 *
 * This function should be called during application bootstrap to set up
 * all recurring background jobs for analytics maintenance
 *
 * @param logger - LoggerService instance for structured logging (injected dependency)
 * @param jobManager - JobManagerService instance (injected dependency)
 */
export async function initializeAnalyticsSchedules(
  logger: LoggerService,
  jobManager: JobManagerService,
): Promise<void> {
  try {
    logger.info('Initializing analytics job schedules...', { context: 'JobScheduler' });

    await Promise.all([
      scheduleAnalyticsMVsRefresh(logger, jobManager),
      scheduleWeeklyAnalyticsMVsRefresh(logger, jobManager),
    ]);

    logger.info(' Analytics job schedules initialized successfully.', {
      context: 'JobScheduler',
      scheduledJobs: ['daily_mv_refresh', 'weekly_mv_refresh'],
    });
  } catch (error) {
    logger.error(' Failed to initialize analytics job schedules.', {
      context: 'JobScheduler',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Schedule health ingest reaper job
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
 * STALE THRESHOLD: 5 minutes (matches STALE_PROCESSING_TIMEOUT_MS in repository)
 * MAX ROWS: 1000 per job run (prevents runaway cleanup)
 *
 * @param logger - LoggerService instance for structured logging (injected dependency)
 * @param jobManager - JobManagerService instance (injected dependency)
 */
export async function scheduleHealthIngestReaper(
  logger: LoggerService,
  jobManager: JobManagerService,
): Promise<void> {
  try {
    // FAIL-FAST: Validate dependencies
    if (!jobManager) {
      throw new Error('JobManagerService instance not provided. Must be initialized before scheduling jobs.');
    }

    const jobData: HealthIngestReaperJobData = {
      userId: 'system', // System-level job, no specific user
      timestamp: new Date().toISOString(),
      staleAfterMinutes: 5, // Match STALE_PROCESSING_TIMEOUT_MS (5 minutes) in repository
      maxRows: 1000, // Process up to 1000 stale requests per run
      correlationId: `health_ingest_reaper_${Date.now()}`,
    };

    await jobManager.enqueueJob(
      JobNames.HEALTH_INGEST_REAPER,
      jobData,
      {
        jobId: 'system_health_ingest_reaper',
        priority: JobPriority.MEDIUM, // Lower than analytics MVs refresh
        config: {
          repeat: {
            cron: '*/15 * * * *', // Every 15 minutes
          },
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
          // Allow 2 minutes for services to fully initialize
          delay: 120000,
        },
      },
    );

    logger.info('Scheduled health ingest reaper job.', {
      context: 'JobScheduler',
      schedule: '*/15 * * * *',
      staleAfterMinutes: 5,
      maxRows: 1000,
      priority: JobPriority.MEDIUM,
    });
  } catch (error) {
    logger.error('Failed to schedule health ingest reaper job.', {
      context: 'JobScheduler',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Schedule health sample soft-delete purger job
 *
 * CLEANUP OPERATION:
 * Periodically purges (hard-deletes) soft-deleted health samples that have
 * exceeded the retention period. This reclaims storage while preserving
 * audit trail for the defined retention period.
 *
 * WHY NOT use TimescaleDB add_retention_policy:
 * - add_retention_policy drops ENTIRE chunks by time
 * - It cannot filter by is_deleted=true
 * - Using it would delete ALL data older than threshold, not just soft-deleted
 *
 * SCHEDULE: Daily at 4 AM UTC (during low usage hours, after MV refresh)
 * RETENTION: 30 days (configurable - minimum 30 enforced by repository)
 * MAX ROWS: 10000 per job run (prevents runaway cleanup)
 *
 * @param logger - LoggerService instance for structured logging (injected dependency)
 * @param jobManager - JobManagerService instance (injected dependency)
 */
export async function scheduleHealthSampleSoftDeletePurger(
  logger: LoggerService,
  jobManager: JobManagerService,
): Promise<void> {
  try {
    // FAIL-FAST: Validate dependencies
    if (!jobManager) {
      throw new Error('JobManagerService instance not provided. Must be initialized before scheduling jobs.');
    }

    const jobData: HealthSampleSoftDeletePurgerJobData = {
      userId: 'system', // System-level job, no specific user
      timestamp: new Date().toISOString(),
      retentionDays: 30, // Keep soft-deleted samples for 30 days before hard delete
      maxRows: 10000, // Process up to 10000 per run to prevent runaway cleanup
      adminReason: 'Scheduled soft-delete purge job - daily cleanup',
      correlationId: `health_soft_delete_purger_${Date.now()}`,
    };

    await jobManager.enqueueJob(
      JobNames.HEALTH_SAMPLE_SOFT_DELETE_PURGER,
      jobData,
      {
        jobId: 'system_health_sample_soft_delete_purger',
        priority: JobPriority.LOW, // Lower priority than other health jobs
        config: {
          repeat: {
            cron: '0 4 * * *', // Daily at 4 AM UTC (after MV refresh at 3 AM)
          },
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 10000,
          },
          // Allow 3 minutes for services to fully initialize
          delay: 180000,
        },
      },
    );

    logger.info('Scheduled health sample soft-delete purger job.', {
      context: 'JobScheduler',
      schedule: '0 4 * * *',
      retentionDays: 30,
      maxRows: 10000,
      priority: JobPriority.LOW,
    });
  } catch (error) {
    logger.error('Failed to schedule health sample soft-delete purger job.', {
      context: 'JobScheduler',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Schedule session telemetry lock reaper job
 *
 * PROACTIVE STALE RECOVERY:
 * This job finds COMPUTING rows that have been stuck for too long and marks them
 * as FAILED, allowing the system to recompute them on the next request.
 *
 * RATIONALE:
 * - A crashed worker or network failure can leave COMPUTING rows forever
 * - Thundering herd protection (only one compute at a time) works against us
 * - Without reaper, stuck COMPUTING rows permanently block future computations
 *
 * SCHEDULE: Every 5 minutes via cron
 * STALE THRESHOLD: 10 minutes (reasonable timeout for telemetry computation)
 * MAX ROWS: 100 per job run (prevents runaway cleanup)
 *
 * @param logger - LoggerService instance for structured logging (injected dependency)
 * @param jobManager - JobManagerService instance (injected dependency)
 */
export async function scheduleSessionTelemetryLockReaper(
  logger: LoggerService,
  jobManager: JobManagerService,
): Promise<void> {
  try {
    // FAIL-FAST: Validate dependencies
    if (!jobManager) {
      throw new Error('JobManagerService instance not provided. Must be initialized before scheduling jobs.');
    }

    const jobData: SessionTelemetryLockReaperJobData = {
      userId: 'system', // System-level job, no specific user
      timestamp: new Date().toISOString(),
      staleAfterMinutes: 10, // COMPUTING rows older than 10 minutes are stale
      maxRows: 100, // Process up to 100 stale rows per run
      correlationId: `session_telemetry_lock_reaper_${Date.now()}`,
    };

    await jobManager.enqueueJob(
      JobNames.SESSION_TELEMETRY_LOCK_REAPER,
      jobData,
      {
        jobId: 'system_session_telemetry_lock_reaper',
        priority: JobPriority.MEDIUM, // Same as health ingest reaper
        config: {
          repeat: {
            cron: '*/5 * * * *', // Every 5 minutes
          },
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
          // Allow 2 minutes for services to fully initialize
          delay: 120000,
        },
      },
    );

    logger.info('Scheduled session telemetry lock reaper job.', {
      context: 'JobScheduler',
      schedule: '*/5 * * * *',
      staleAfterMinutes: 10,
      maxRows: 100,
      priority: JobPriority.MEDIUM,
    });
  } catch (error) {
    logger.error('Failed to schedule session telemetry lock reaper job.', {
      context: 'JobScheduler',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Schedule inventory reconciliation job
 *
 * BACKGROUND RECONCILIATION:
 * Finds consumptions that were created without corresponding inventory adjustments
 * (e.g., offline-first sync, out-of-order sync) and creates the missing adjustments.
 *
 * RATIONALE:
 * - consumption.service.ts:306 logs INVENTORY_RECONCILIATION_NEEDED but takes no action
 * - This job provides eventual consistency for inventory tracking
 * - Idempotent via InventoryAdjustment.@@unique([consumptionId])
 *
 * SCHEDULE: Every 30 minutes via cron
 * MAX ROWS: 100 per job run (conservative batch sizing)
 * LOOKBACK: 7 days (consumptions older than this are unlikely to find matching inventory)
 *
 * @param logger - LoggerService instance for structured logging (injected dependency)
 * @param jobManager - JobManagerService instance (injected dependency)
 */
export async function scheduleInventoryReconciliation(
  logger: LoggerService,
  jobManager: JobManagerService,
): Promise<void> {
  try {
    // FAIL-FAST: Validate dependencies
    if (!jobManager) {
      throw new Error('JobManagerService instance not provided. Must be initialized before scheduling jobs.');
    }

    const jobData: InventoryReconciliationJobData = {
      userId: 'system', // System-level job, no specific user
      timestamp: new Date().toISOString(),
      maxRows: 100, // Conservative batch sizing to prevent excessive DB load
      lookbackDays: 7, // Look back 7 days for unlinked consumptions
      correlationId: `inventory_reconciliation_${Date.now()}`,
    };

    await jobManager.enqueueJob(
      JobNames.INVENTORY_RECONCILIATION,
      jobData,
      {
        jobId: 'system_inventory_reconciliation',
        priority: JobPriority.LOW, // Lower priority than health and analytics jobs
        config: {
          repeat: {
            cron: '*/30 * * * *', // Every 30 minutes
          },
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 10000,
          },
          // Allow 3 minutes for services to fully initialize
          delay: 180000,
        },
      },
    );

    logger.info('Scheduled inventory reconciliation job.', {
      context: 'JobScheduler',
      schedule: '*/30 * * * *',
      maxRows: 100,
      lookbackDays: 7,
      priority: JobPriority.LOW,
    });
  } catch (error) {
    logger.error('Failed to schedule inventory reconciliation job.', {
      context: 'JobScheduler',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Schedule stale session reconciliation job
 *
 * PROACTIVE STALE RECOVERY:
 * This job globally sweeps for ACTIVE/PAUSED sessions whose sessionEndTimestamp
 * has passed and durably completes them via completeSession() (with outbox events).
 *
 * RATIONALE:
 * - Sessions become stale when clients disconnect without completing
 * - createSession() only closes prior sessions for the SAME user starting a new one
 * - getActiveSessions() only does reactive cleanup when explicitly called
 * - This job provides proactive global cleanup on a schedule
 *
 * SCHEDULE: Every 10 minutes via cron
 * MAX USERS: 100 per job run
 * MAX SESSIONS PER USER: 20 per job run
 *
 * @param logger - LoggerService instance for structured logging (injected dependency)
 * @param jobManager - JobManagerService instance (injected dependency)
 */
export async function scheduleStaleSessionReconciliation(
  logger: LoggerService,
  jobManager: JobManagerService,
): Promise<void> {
  try {
    if (!jobManager) {
      throw new Error('JobManagerService instance not provided. Must be initialized before scheduling jobs.');
    }

    jobManager.ensureQueueExists(JobNames.STALE_SESSION_RECONCILIATION);

    const jobData: StaleSessionReconciliationJobData = {
      userId: 'system',
      timestamp: new Date().toISOString(),
      maxUsers: 100,
      maxSessionsPerUser: 20,
      correlationId: `stale_session_reconciliation_${Date.now()}`,
    };

    await jobManager.enqueueJob(
      JobNames.STALE_SESSION_RECONCILIATION,
      jobData,
      {
        jobId: 'system_stale_session_reconciliation',
        priority: JobPriority.MEDIUM,
        config: {
          repeat: {
            cron: '*/10 * * * *', // Every 10 minutes
          },
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
          // Delay initial execution to prevent startup job processing
          delay: 120000, // Wait 2 minutes for services to fully initialize
        },
      },
    );

    logger.info('Scheduled stale session reconciliation job.', {
      context: 'JobScheduler',
      schedule: '*/10 * * * *',
      maxUsers: 100,
      maxSessionsPerUser: 20,
      priority: JobPriority.MEDIUM,
    });
  } catch (error) {
    logger.error('Failed to schedule stale session reconciliation job.', {
      context: 'JobScheduler',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Initialize all health-related scheduled jobs
 *
 * This function should be called during application bootstrap to set up
 * all recurring background jobs for health data maintenance
 *
 * @param logger - LoggerService instance for structured logging (injected dependency)
 * @param jobManager - JobManagerService instance (injected dependency)
 */
export async function initializeHealthSchedules(
  logger: LoggerService,
  jobManager: JobManagerService,
): Promise<void> {
  try {
    logger.info('Initializing health job schedules...', { context: 'JobScheduler' });

    // Initialize health job schedules in parallel
    await Promise.all([
      scheduleHealthIngestReaper(logger, jobManager),
      scheduleHealthSampleSoftDeletePurger(logger, jobManager),
      scheduleSessionTelemetryLockReaper(logger, jobManager),
    ]);

    logger.info('✓ Health job schedules initialized successfully.', {
      context: 'JobScheduler',
      scheduledJobs: ['health_ingest_reaper', 'health_sample_soft_delete_purger', 'session_telemetry_lock_reaper'],
    });
  } catch (error) {
    logger.error('✗ Failed to initialize health job schedules.', {
      context: 'JobScheduler',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Initialize ALL scheduled jobs (analytics + health)
 *
 * This is the main entry point for initializing all background job schedules.
 * Call this during application bootstrap after JobManagerService is initialized.
 *
 * @param logger - LoggerService instance for structured logging (injected dependency)
 * @param jobManager - JobManagerService instance (injected dependency)
 */
export async function initializeAllSchedules(
  logger: LoggerService,
  jobManager: JobManagerService,
): Promise<void> {
  try {
    logger.info('Initializing all job schedules...', { context: 'JobScheduler' });

    // Initialize all schedule categories in parallel
    await Promise.all([
      initializeAnalyticsSchedules(logger, jobManager),
      initializeHealthSchedules(logger, jobManager),
      scheduleInventoryReconciliation(logger, jobManager),
      scheduleStaleSessionReconciliation(logger, jobManager),
    ]);

    logger.info('✓ All job schedules initialized successfully.', {
      context: 'JobScheduler',
      scheduledCategories: ['analytics', 'health', 'inventory', 'session'],
    });
  } catch (error) {
    logger.error('✗ Failed to initialize all job schedules.', {
      context: 'JobScheduler',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
