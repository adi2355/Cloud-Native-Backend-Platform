/**
 * Job Types and Interfaces for BullMQ Integration
 * 
 * Defines all job data interfaces and types for the AppPlatform backend job queue system.
 * Follows AppPlatform standards for type safety and validation.
 * 
 * @module jobs/job.types
 * @see https://docs.bullmq.io/
 */

import type { HealthSample, DeletionItem } from '@shared/contracts';

// Generic Job Data Interface
export interface BaseJobData {
  userId: string;
  correlationId?: string;
  timestamp: string;
  [key: string]: unknown; // Allow additional data
}

// Export Analytics Data Job
export interface ExportAnalyticsJobData extends BaseJobData {
  reportType: 'analytics' | 'consumption' | 'costs' | 'full';
  format: 'csv' | 'json';
  options?: {
    startDate?: string;
    endDate?: string;
    includeDetails?: boolean;
    page?: number;
    pageSize?: number;
  };
}

// Weekly Report Generation Job
export interface GenerateWeeklyReportJobData extends BaseJobData {
  weekStartDate: string; // ISO string
  weekEndDate: string;   // ISO string
  includeRecommendations: boolean;
  includeInsights: boolean;
}

// Schema Migration Job
export interface SchemaMigrationJobData extends BaseJobData {
  migrationName: string;
  direction: 'up' | 'down';
  batchSize?: number;
  dryRun?: boolean;
}

// Cache Warming Job
export interface CacheWarmingJobData extends BaseJobData {
  cacheKeys: string[];
  priority: 'low' | 'medium' | 'high';
}

// Refresh Analytics Materialized Views Job
export interface RefreshAnalyticsMVsJobData extends BaseJobData {
  useConcurrently: boolean;
  viewNames?: string[]; // Optional: refresh specific views, or all if empty
}

/**
 * Health Ingest Reaper Job
 *
 * Proactively reaps stale HealthIngestRequest rows stuck in 'processing' status.
 * This prevents request deadlock when processes crash mid-processing.
 *
 * RATIONALE:
 * - Without this job, stale requests remain 'processing' forever if no client retries
 * - Reactive recovery (in checkRequestIdempotency) only happens on client retry
 * - This job provides proactive cleanup for observability and operational health
 *
 * SCHEDULE: Every 15 minutes via cron
 */
export interface HealthIngestReaperJobData extends BaseJobData {
  /** Timeout in minutes after which processing requests are considered stale (1-120) */
  staleAfterMinutes: number;
  /** Maximum rows to reap per job run (1-50000) */
  maxRows: number;
}

/**
 * Health Sample Soft-Delete Purger Job
 *
 * Periodically purges (hard-deletes) soft-deleted health samples that have
 * been in deleted state beyond the retention period.
 *
 * RATIONALE:
 * - Soft-deleted samples consume storage indefinitely
 * - TimescaleDB add_retention_policy CANNOT be used (drops entire chunks regardless of is_deleted)
 * - This job performs row-level DELETE with is_deleted=true filter
 * - After retention period, data is no longer needed for audit
 *
 * WHY NOT use TimescaleDB add_retention_policy:
 * - add_retention_policy drops ENTIRE chunks by time
 * - It cannot filter by is_deleted=true
 * - Using it would delete ALL data older than threshold, not just soft-deleted
 *
 * SCHEDULE: Daily at 4 AM UTC (during low usage hours)
 * RETENTION: 30 days minimum (enforced by repository)
 */
export interface HealthSampleSoftDeletePurgerJobData extends BaseJobData {
  /** Retention period in days - samples deleted older than this are purged (30-365) */
  retentionDays: number;
  /** Maximum rows to purge per job run (1-50000) */
  maxRows: number;
  /** Admin reason for audit trail */
  adminReason: string;
}

/**
 * Health Ingest Batch Job
 *
 * Processes a queued health upload batch asynchronously.
 */
export interface HealthIngestBatchJobData extends BaseJobData {
  requestId: string;
  payloadHash: string;
  ingestRequestId: string;
  samples: HealthSample[];
  deletions?: DeletionItem[];
  deviceId?: string;
  /**
   * Request-level timezone offset in minutes from UTC.
   * Propagated from X-Timezone-Offset header through the queue path.
   *
   * context, causing affectedLocalDates in the outbox event to be computed
   * with UTC (offset 0) for non-sleep metrics. Per-sample TZ on individual
   * sample objects is preserved regardless.
   *
   * undefined = header was not provided (service uses per-sample TZ or 0 fallback)
   * number = validated offset from X-Timezone-Offset header (-720..+840)
   */
  timezoneOffsetMinutes?: number;
}

/**
 * Session Telemetry Compute Job
 *
 * Computes and caches telemetry for a single session at a specific resolution.
 *
 * This prevents the worker from re-acquiring the lock and exiting without computing.
 */
export interface SessionTelemetryComputeJobData extends BaseJobData {
  sessionId: string;
  windowMinutes: number;
  resolution: '1m' | '5m';
  computeVersion: number;
  reason: 'session_completed' | 'cache_miss' | 'late_ingest' | 'backfill';
  forceRecompute?: boolean;
  dedupeKey?: string;
  /**
   * ID of pre-created COMPUTING lock row (from scheduler).
   * When provided, worker should skip lock acquisition and compute directly against this row.
   * This prevents the worker/lock deadlock where worker sees COMPUTING and exits.
   */
  lockRowId?: string;
}

/**
 * Inventory Reconciliation Job
 *
 * Background job that finds consumptions without corresponding inventory adjustments
 * and creates the missing adjustments. Targets consumptions flagged as
 * INVENTORY_RECONCILIATION_NEEDED in consumption.service.ts (line 306).
 *
 * RATIONALE:
 * - Offline-first sync can create consumptions before inventory items exist
 * - Out-of-order sync may process consumptions before their linked purchase
 * - This job provides eventual consistency for inventory tracking
 *
 * IDEMPOTENCY:
 * - InventoryAdjustment has @@unique([consumptionId]) constraint
 * - adjustInventoryInTransaction checks existing adjustment before creating
 * - Safe to run repeatedly without double-counting
 *
 * SCHEDULE: Every 30 minutes via cron
 */
export interface InventoryReconciliationJobData extends BaseJobData {
  /** Maximum consumptions to process per job run (1-500) */
  maxRows: number;
  /** How far back to look for unlinked consumptions in days (1-90) */
  lookbackDays: number;
}

/**
 * Session Telemetry Computing Lock Reaper Job
 *
 * Reaps stale COMPUTING rows that have been stuck for too long.
 * A crashed worker or network failure can leave COMPUTING rows forever,
 * preventing new computations from starting.
 *
 * SCHEDULE: Every 5 minutes via cron
 */
export interface SessionTelemetryLockReaperJobData extends BaseJobData {
  /** Minutes after which COMPUTING rows are considered stale (1-60, default: 10) */
  staleAfterMinutes: number;
  /** Maximum rows to reap per job run (1-500) */
  maxRows: number;
}

/**
 * Stale Session Reconciliation Job
 *
 * Globally sweeps for ACTIVE sessions whose sessionEndTimestamp has passed
 * and durably completes them via completeSession() (with outbox events).
 *
 * RATIONALE:
 * - Sessions can become stale when the client disconnects without completing
 * - createSession() closes prior active sessions for the SAME user, but this
 *   only fires when the user starts a NEW session
 * - getActiveSessions() does reactive cleanup, but only when explicitly called
 * - This job provides PROACTIVE global cleanup on a schedule
 *
 * SCHEDULE: Every 10 minutes via cron
 * MAX USERS: 100 per job run (prevents runaway queries)
 */
export interface StaleSessionReconciliationJobData extends BaseJobData {
  /** Maximum distinct users to process per job run (1-500) */
  maxUsers: number;
  /** Maximum stale sessions to reconcile per user (1-50) */
  maxSessionsPerUser: number;
}

// Define job names for type safety
export enum JobNames {
  EXPORT_ANALYTICS = 'exportAnalytics',
  GENERATE_WEEKLY_REPORT = 'generateWeeklyReport',
  SCHEMA_MIGRATION = 'schemaMigration',
  CACHE_WARMING = 'cacheWarming',
  REFRESH_ANALYTICS_MVS = 'refreshAnalyticsMVs',
  HEALTH_INGEST_REAPER = 'healthIngestReaper',
  HEALTH_SAMPLE_SOFT_DELETE_PURGER = 'healthSampleSoftDeletePurger',
  HEALTH_INGEST_BATCH = 'healthIngestBatch',
  SESSION_TELEMETRY_COMPUTE = 'sessionTelemetryCompute',
  SESSION_TELEMETRY_LOCK_REAPER = 'sessionTelemetryLockReaper',
  INVENTORY_RECONCILIATION = 'inventoryReconciliation',
  STALE_SESSION_RECONCILIATION = 'staleSessionReconciliation',
}

// Union type for all possible job data
export type JobData =
  | ExportAnalyticsJobData
  | GenerateWeeklyReportJobData
  | SchemaMigrationJobData
  | CacheWarmingJobData
  | RefreshAnalyticsMVsJobData
  | HealthIngestReaperJobData
  | HealthSampleSoftDeletePurgerJobData
  | HealthIngestBatchJobData
  | SessionTelemetryComputeJobData
  | SessionTelemetryLockReaperJobData
  | InventoryReconciliationJobData
  | StaleSessionReconciliationJobData;

// Job priority levels
export enum JobPriority {
  LOW = 1,
  MEDIUM = 5,
  HIGH = 10,
  CRITICAL = 15,
}

// Job status for monitoring
export enum JobStatus {
  WAITING = 'waiting',
  ACTIVE = 'active',
  COMPLETED = 'completed',
  FAILED = 'failed',
  DELAYED = 'delayed',
}

// Job configuration interface
export interface JobConfig {
  attempts?: number;
  backoff?: {
    type: 'exponential' | 'fixed';
    delay: number;
  };
  delay?: number;
  removeOnComplete?: number;
  removeOnFail?: number;
  repeat?: {
    cron: string;
    tz?: string;
  };
}
