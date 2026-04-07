import type { HealthSample as HealthSampleContract, DeletionItem } from '@shared/contracts';
import { HealthSampleRepository, type BatchUpsertResult } from '../repositories/health-sample.repository';
import { JobManagerService } from '../jobs/job-manager.service';
import { LoggerService } from './logger.service';
import { AppError, ErrorCodes } from '../utils/AppError';
import { JobNames, JobPriority, type HealthIngestBatchJobData } from '../jobs/job.types';
import { PerformanceMonitoringService, PerformanceMetricType } from './performanceMonitoring.service';
import { HealthSampleService } from './healthSample.service';

export interface HealthIngestQueueConfig {
  enabled: boolean;
  minBatchSize: number;
  maxQueueDepth: number;
  retryAfterMs: number;
}

export type HealthIngestQueueDecision =
  | { action: 'SKIP' }
  | { action: 'CACHED'; result: BatchUpsertResult }
  | { action: 'QUEUED'; retryAfterMs: number };

export class HealthIngestQueueService {
  /**
   * Maximum job payload size in bytes (5MB).
   *
   * BullMQ stores job data as JSON in Redis. Oversized payloads can:
   * 1. Exceed Redis maxmemory limits (causing OOM evictions)
   * 2. Cause ioredis socket write failures (EPIPE/ECONNRESET)
   * 3. Wedge ingest requests in PROCESSING state if enqueue fails
   *    after the request record is created but before job is queued
   *
   * 5MB is conservative — Redis default proto-max-bulk-len is 512MB,
   * but practical limits are much lower due to single-threaded I/O.
   */
  private static readonly MAX_JOB_PAYLOAD_BYTES = 5 * 1024 * 1024;

  private readonly config: HealthIngestQueueConfig;

  constructor(
    private repository: HealthSampleRepository,
    private healthSampleService: HealthSampleService,
    private jobManagerService: JobManagerService,
    private logger: LoggerService,
    private performanceMonitoring?: PerformanceMonitoringService,
  ) {
    if (!repository || !healthSampleService || !jobManagerService || !logger) {
      throw new Error('HealthIngestQueueService requires repository, healthSampleService, jobManagerService, and logger');
    }

    this.config = {
      enabled: process.env.FF_HEALTH_INGEST_QUEUE === 'true',
      minBatchSize: parseInt(process.env.HEALTH_INGEST_QUEUE_MIN_BATCH || '400', 10),
      maxQueueDepth: parseInt(process.env.HEALTH_INGEST_QUEUE_MAX_DEPTH || '2000', 10),
      retryAfterMs: parseInt(process.env.HEALTH_INGEST_QUEUE_RETRY_AFTER_MS || '60000', 10),
    };
  }

  public isEnabled(): boolean {
    return this.config.enabled;
  }

  public async maybeQueueBatch(params: {
    userId: string;
    requestId: string;
    payloadHash: string;
    samples: HealthSampleContract[];
    deletions?: DeletionItem[];
    correlationId?: string;
    deviceId?: string;
    /**
     * Request-level timezone offset from X-Timezone-Offset header.
     * Propagated to job data so async workers can compute correct
     * affectedLocalDates in the outbox event.
     */
    timezoneOffsetMinutes?: number;
  }): Promise<HealthIngestQueueDecision> {
    if (!this.config.enabled) {
      return { action: 'SKIP' };
    }

    const totalCount = params.samples.length + (params.deletions?.length ?? 0);
    if (totalCount < this.config.minBatchSize) {
      return { action: 'SKIP' };
    }

    await this.healthSampleService.assertHealthUploadAllowed(
      params.userId,
      params.requestId,
      params.samples.length
    );

    const idempotencyCheck = await this.repository.checkRequestIdempotency(
      params.userId,
      params.requestId,
      params.payloadHash
    );

    switch (idempotencyCheck.status) {
      case 'CACHED_RESPONSE':
        return { action: 'CACHED', result: idempotencyCheck.cachedResult };

      case 'PAYLOAD_MISMATCH':
        throw new AppError(
          400,
          ErrorCodes.INVALID_INPUT,
          `Request ID '${params.requestId}' was already used with different payload.`,
          true,
          { requestId: params.requestId }
        );

      case 'STILL_PROCESSING':
        throw new AppError(
          409,
          ErrorCodes.CONFLICT,
          `Request '${params.requestId}' is still being processed. Please retry later.`,
          true,
          { requestId: params.requestId, retryAfterMs: this.config.retryAfterMs }
        );

      case 'NEW_REQUEST':
        break;

      default: {
        const _exhaustive: never = idempotencyCheck;
        throw new Error(`Unknown idempotency status: ${JSON.stringify(_exhaustive)}`);
      }
    }

    const queueDepth = await this.jobManagerService.getQueueDepth(JobNames.HEALTH_INGEST_BATCH);
    if (queueDepth >= this.config.maxQueueDepth) {
      throw new AppError(
        429,
        ErrorCodes.RATE_LIMIT_EXCEEDED,
        'Health ingest queue is full. Please retry later.',
        true,
        { retryAfterMs: this.config.retryAfterMs, queueDepth }
      );
    }

    // Create or reactivate the ingest request record.
    //
    // failed requests (allowing retry). But createIngestRequest is a plain CREATE
    // that fails with P2002 (unique constraint) because the row already exists.
    //
    // Fix: Try CREATE first (common case for truly new requests). On P2002,
    // fall back to reactivateFailedIngestRequest which atomically UPDATEs the
    // existing failed row back to 'processing'. This handles both:
    // - Truly new requests: CREATE succeeds
    // - Retry of failed requests: CREATE fails → reactivate succeeds
    let ingestRequest;
    try {
      ingestRequest = await this.repository.createIngestRequest({
        userId: params.userId,
        requestId: params.requestId,
        payloadHash: params.payloadHash,
        sampleCount: params.samples.length,
      });
    } catch (createError) {
      // P2002 = unique constraint violation → row exists (likely from a failed previous attempt)
      const isUniqueViolation =
        createError instanceof AppError && createError.errorCode === ErrorCodes.DUPLICATE_REQUEST;

      if (!isUniqueViolation) {
        throw createError; // Not a duplicate — propagate original error
      }

      this.logger.info('Ingest request row already exists (previous failure), reactivating for retry', {
        context: 'HealthIngestQueueService.maybeQueueBatch',
        userId: params.userId,
        requestId: params.requestId,
      });

      const reactivated = await this.repository.reactivateFailedIngestRequest(
        params.userId,
        params.requestId,
        params.payloadHash,
        params.samples.length
      );

      if (!reactivated) {
        // Reactivation failed — row exists but is not in 'failed' status or payloadHash mismatch.
        // This is a legitimate conflict (e.g., another worker just reactivated it).
        throw new AppError(
          409,
          ErrorCodes.CONFLICT,
          `Request '${params.requestId}' already exists and could not be reactivated. ` +
          `It may be currently processing or has a different payload.`,
          true,
          { requestId: params.requestId, retryAfterMs: this.config.retryAfterMs }
        );
      }

      ingestRequest = reactivated;
    }

    const jobData: HealthIngestBatchJobData = {
      userId: params.userId,
      requestId: params.requestId,
      payloadHash: params.payloadHash,
      samples: params.samples,
      deletions: params.deletions,
      correlationId: params.correlationId,
      deviceId: params.deviceId,
      ingestRequestId: ingestRequest.id,
      timestamp: new Date().toISOString(),
      // Propagate request-level timezone so async workers can compute
      // correct affectedLocalDates and timezoneExplicit in outbox events
      timezoneOffsetMinutes: params.timezoneOffsetMinutes,
    };

    // BLOCKER C FIX: Validate payload size before enqueue.
    // BullMQ stores job data as JSON in Redis. Oversized payloads can
    // exceed Redis limits and wedge ingest requests in PROCESSING state.
    const payloadBytes = Buffer.byteLength(JSON.stringify(jobData), 'utf-8');

    if (payloadBytes > HealthIngestQueueService.MAX_JOB_PAYLOAD_BYTES) {
      this.logger.error('Health ingest batch payload exceeds size limit', {
        context: 'HealthIngestQueueService.maybeQueueBatch',
        userId: params.userId,
        requestId: params.requestId,
        ingestRequestId: ingestRequest.id,
        payloadBytes,
        maxBytes: HealthIngestQueueService.MAX_JOB_PAYLOAD_BYTES,
        sampleCount: params.samples.length,
        deletionCount: params.deletions?.length ?? 0,
      });

      await this.repository.failIngestRequest(
        ingestRequest.id,
        `Payload size ${payloadBytes} bytes exceeds ${HealthIngestQueueService.MAX_JOB_PAYLOAD_BYTES} byte limit`
      );

      throw new AppError(
        413,
        ErrorCodes.INVALID_INPUT,
        `Health ingest batch payload too large (${Math.round(payloadBytes / 1024)}KB). ` +
        `Maximum is ${Math.round(HealthIngestQueueService.MAX_JOB_PAYLOAD_BYTES / 1024)}KB. ` +
        `Reduce batch size and retry.`,
        true,
        { payloadBytes, maxBytes: HealthIngestQueueService.MAX_JOB_PAYLOAD_BYTES, requestId: params.requestId }
      );
    }

    try {
      await this.jobManagerService.enqueueJob(
        JobNames.HEALTH_INGEST_BATCH,
        jobData,
        {
          jobId: `${params.userId}_${params.requestId}`,
          priority: JobPriority.HIGH,
        }
      );
    } catch (error) {
      // The underlying error contains the actual Redis/BullMQ failure reason
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      // Log the FULL error details before wrapping
      // This ensures we can diagnose Redis/BullMQ issues even if the error is further wrapped
      this.logger.error('Failed to enqueue health ingest batch - FULL ERROR DETAILS', {
        context: 'HealthIngestQueueService.maybeQueueBatch',
        userId: params.userId,
        requestId: params.requestId,
        ingestRequestId: ingestRequest.id,
        errorMessage,
        errorStack,
        errorName: error instanceof Error ? error.name : 'Unknown',
        // If this is an AppError, log its code too
        errorCode: error instanceof AppError ? error.errorCode : undefined,
        originalErrorDetails: error instanceof AppError ? error.details : undefined,
      });

      await this.repository.failIngestRequest(
        ingestRequest.id,
        errorMessage
      );

      // AND pass the original error for full stack trace preservation
      throw new AppError(
        503,
        ErrorCodes.SERVICE_UNAVAILABLE,
        `Failed to enqueue health ingest batch: ${errorMessage}`,
        true,
        { requestId: params.requestId, originalErrorMessage: errorMessage },
        error // Preserve original error for full diagnostics
      );
    }

    this.performanceMonitoring?.recordMetric(
      PerformanceMetricType.QUEUE_SIZE,
      'health.ingest.queue.depth',
      queueDepth,
      'count',
      { queue: 'health_ingest', queued: 'true' },
      {
        batchSize: totalCount,
        requestId: params.requestId,
      }
    );

    this.logger.info('Health ingest batch queued', {
      context: 'HealthIngestQueueService',
      userId: params.userId,
      requestId: params.requestId,
      batchSize: totalCount,
      queueDepth,
      ingestRequestId: ingestRequest.id,
    });

    return { action: 'QUEUED', retryAfterMs: this.config.retryAfterMs };
  }
}
