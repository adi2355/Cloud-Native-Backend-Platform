import { JobManagerService } from '../jobs/job-manager.service';
import { JobNames, JobPriority, type SessionTelemetryComputeJobData } from '../jobs/job.types';
import { SessionRepository } from '../repositories/session.repository';
import { SessionTelemetryCacheRepository } from '../repositories/session-telemetry-cache.repository';
import { LoggerService } from './logger.service';
import { AppError, ErrorCodes } from '../utils/AppError';
import {
  CURRENT_COMPUTE_VERSION,
  DEFAULT_WINDOW_MINUTES,
  type TelemetryResolution,
} from '@shared/contracts';
import type {
  ScheduleTelemetryComputeParams,
  ScheduleTelemetryComputeResult,
  TelemetryComputeScheduler,
} from './session-telemetry.service';

export interface SessionTelemetryQueueConfig {
  enabled: boolean;
  maxQueueDepth: number;
  retryAfterSeconds: number;
  defaultDelayMs: number;
  maxSessionsPerEvent: number;
}

export class SessionTelemetryQueueService implements TelemetryComputeScheduler {
  private readonly config: SessionTelemetryQueueConfig;

  constructor(
    private sessionRepository: SessionRepository,
    private cacheRepository: SessionTelemetryCacheRepository,
    private jobManagerService: JobManagerService,
    private logger: LoggerService,
  ) {
    if (!sessionRepository || !cacheRepository || !jobManagerService || !logger) {
      throw new Error('SessionTelemetryQueueService requires sessionRepository, cacheRepository, jobManagerService, and logger');
    }

    this.config = {
      enabled: process.env.FF_SESSION_TELEMETRY_QUEUE !== 'false',
      maxQueueDepth: parseInt(process.env.SESSION_TELEMETRY_QUEUE_MAX_DEPTH || '3000', 10),
      retryAfterSeconds: parseInt(process.env.SESSION_TELEMETRY_QUEUE_RETRY_AFTER_SECONDS || '5', 10),
      defaultDelayMs: parseInt(process.env.SESSION_TELEMETRY_QUEUE_DEFAULT_DELAY_MS || '5000', 10),
      maxSessionsPerEvent: parseInt(process.env.SESSION_TELEMETRY_QUEUE_MAX_SESSIONS || '200', 10),
    };
  }

  public getRetryAfterSeconds(): number {
    return this.config.retryAfterSeconds;
  }

  public async scheduleTelemetryCompute(
    params: ScheduleTelemetryComputeParams
  ): Promise<ScheduleTelemetryComputeResult> {
    if (!this.config.enabled) {
      this.logger.warn('Session telemetry queue disabled - skipping schedule', {
        context: 'SessionTelemetryQueueService.scheduleTelemetryCompute',
        sessionId: params.sessionId,
        reason: params.reason,
      });
      return {
        queued: false,
        state: 'skipped',
        retryAfterSeconds: this.config.retryAfterSeconds,
        reason: 'queue_disabled',
      };
    }

    // P0-G.1 FIX: Infrastructure failures return 'failed', not 'skipped'
    // This allows the client to distinguish between intentional skips (queue disabled)
    // and actual failures (Redis down) for appropriate error handling.
    let queueDepth: number;
    try {
      queueDepth = await this.jobManagerService.getQueueDepth(JobNames.SESSION_TELEMETRY_COMPUTE);
    } catch (queueError) {
      // P0-G.1: Log as ERROR (not warn) since this is an infrastructure failure
      this.logger.error('Failed to check queue depth - Redis may be unavailable', {
        context: 'SessionTelemetryQueueService.scheduleTelemetryCompute',
        sessionId: params.sessionId,
        error: queueError instanceof Error ? queueError.message : String(queueError),
        stack: queueError instanceof Error ? queueError.stack : undefined,
      });
      // P0-G.1: Return 'failed' (not 'skipped') to signal infrastructure failure
      // Client should retry after retryAfterSeconds and show appropriate error UI
      return {
        queued: false,
        state: 'failed',
        retryAfterSeconds: this.config.retryAfterSeconds,
        reason: 'queue_unavailable',
      };
    }

    if (queueDepth >= this.config.maxQueueDepth) {
      throw new AppError(
        429,
        ErrorCodes.RATE_LIMIT_EXCEEDED,
        'Session telemetry queue is full. Please retry later.',
        true,
        { queueDepth, maxQueueDepth: this.config.maxQueueDepth }
      );
    }

    if (!Number.isFinite(params.sessionStartMs) || !Number.isFinite(params.sessionEndMs) || params.sessionEndMs <= params.sessionStartMs) {
      this.logger.warn('Invalid session timestamps for telemetry scheduling', {
        context: 'SessionTelemetryQueueService.scheduleTelemetryCompute',
        sessionId: params.sessionId,
        sessionStartMs: params.sessionStartMs,
        sessionEndMs: params.sessionEndMs,
      });
      return {
        queued: false,
        state: 'skipped',
        retryAfterSeconds: this.config.retryAfterSeconds,
        reason: 'invalid_session_range',
      };
    }

    const lockResult = await this.cacheRepository.tryAcquireComputeLock(
      params.sessionId,
      params.userId,
      params.sessionStartMs,
      params.sessionEndMs,
      params.windowMinutes,
      params.resolution,
      params.computeVersion ?? CURRENT_COMPUTE_VERSION,
      undefined,
      params.forceRecompute ?? false,
    );

    if (!lockResult.shouldCompute) {
      if (lockResult.existingStatus === 'COMPUTING') {
        if (params.forceRecompute) {
          // Enqueue a retry job even if a compute is already in progress
          await this.enqueueJob(params, undefined);
          return {
            queued: true,
            state: 'scheduled',
            retryAfterSeconds: this.config.retryAfterSeconds,
          };
        }
        return {
          queued: false,
          state: 'already_computing',
          retryAfterSeconds: this.config.retryAfterSeconds,
        };
      }

      return {
        queued: false,
        state: 'already_cached',
        retryAfterSeconds: this.config.retryAfterSeconds,
      };
    }

    try {
      const jobId = await this.enqueueJob(params, lockResult.lockRowId);
      return {
        queued: true,
        state: 'scheduled',
        retryAfterSeconds: this.config.retryAfterSeconds,
        jobId,
      };
    } catch (error) {
      if (lockResult.lockRowId) {
        const message = error instanceof Error ? error.message : String(error);
        await this.cacheRepository.releaseComputeLock(lockResult.lockRowId, message);
      }
      throw error;
    }
  }

  public async scheduleTelemetryForCompletedSession(params: {
    sessionId: string;
    userId: string;
    sessionStartMs: number;
    sessionEndMs: number;
    resolutions?: TelemetryResolution[];
    windowMinutes?: number;
    correlationId?: string;
    delayMs?: number;
  }): Promise<{ scheduled: number }> {
    const windowMinutes = params.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
    const resolutions = params.resolutions ?? ['1m', '5m'];
    let scheduled = 0;

    for (const resolution of resolutions) {
      const result = await this.scheduleTelemetryCompute({
        sessionId: params.sessionId,
        userId: params.userId,
        sessionStartMs: params.sessionStartMs,
        sessionEndMs: params.sessionEndMs,
        windowMinutes,
        resolution,
        reason: 'session_completed',
        correlationId: params.correlationId,
        delayMs: params.delayMs ?? this.config.defaultDelayMs,
      });
      if (result.queued) {
        scheduled++;
      }
    }

    return { scheduled };
  }

  public async scheduleTelemetryForIngestedSamples(params: {
    userId: string;
    rangeStartMs: number;
    rangeEndMs: number;
    metricCodes: string[];
    dedupeKey?: string;
    correlationId?: string;
    windowMinutes?: number;
    resolutions?: TelemetryResolution[];
  }): Promise<{ sessionsEvaluated: number; scheduled: number; invalidated: number }> {
    // Early exit if no relevant metrics
    if (!params.metricCodes || params.metricCodes.length === 0) {
      return { sessionsEvaluated: 0, scheduled: 0, invalidated: 0 };
    }

    const windowMinutes = params.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
    const resolutions = params.resolutions ?? ['1m', '5m'];
    const searchStartMs = params.rangeStartMs - windowMinutes * 60 * 1000;
    const searchEndMs = params.rangeEndMs + windowMinutes * 60 * 1000;

    if (!Number.isFinite(searchStartMs) || !Number.isFinite(searchEndMs) || searchEndMs <= searchStartMs) {
      this.logger.warn('Invalid ingest range for telemetry scheduling', {
        context: 'SessionTelemetryQueueService.scheduleTelemetryForIngestedSamples',
        userId: params.userId,
        rangeStartMs: params.rangeStartMs,
        rangeEndMs: params.rangeEndMs,
      });
      return { sessionsEvaluated: 0, scheduled: 0, invalidated: 0 };
    }

    const sessions = await this.sessionRepository.findCompletedSessionsOverlappingRange({
      userId: params.userId,
      rangeStart: new Date(searchStartMs),
      rangeEnd: new Date(searchEndMs),
      limit: this.config.maxSessionsPerEvent,
    });

    if (sessions.length === 0) {
      this.logger.info('No completed sessions found overlapping ingested sample range', {
        context: 'SessionTelemetryQueueService.scheduleTelemetryForIngestedSamples',
        userId: params.userId,
        searchStartMs,
        searchEndMs,
        searchStartDate: new Date(searchStartMs).toISOString(),
        searchEndDate: new Date(searchEndMs).toISOString(),
        metricCodes: params.metricCodes,
        windowMinutes,
      });
      return { sessionsEvaluated: 0, scheduled: 0, invalidated: 0 };
    }

    if (sessions.length >= this.config.maxSessionsPerEvent) {
      this.logger.warn('Session telemetry scheduling truncated by maxSessionsPerEvent', {
        context: 'SessionTelemetryQueueService.scheduleTelemetryForIngestedSamples',
        userId: params.userId,
        maxSessionsPerEvent: this.config.maxSessionsPerEvent,
        sessionsEvaluated: sessions.length,
      });
    }

    this.logger.info('Found overlapping sessions for telemetry invalidation', {
      context: 'SessionTelemetryQueueService.scheduleTelemetryForIngestedSamples',
      userId: params.userId,
      sessionsFound: sessions.length,
      sessionIds: sessions.map(s => s.id),
      metricCodes: params.metricCodes,
      queueEnabled: this.config.enabled,
    });

    // Previously, if queue was disabled (!this.config.enabled), we returned early
    // and markStale() was never called. This left cache "READY" with stale data.
    //
    // Now we ALWAYS mark affected sessions as stale. The next client API request
    // will trigger inline compute if queue is disabled, or worker compute if enabled.
    let invalidated = 0;
    let scheduled = 0;

    for (const session of sessions) {
      if (!session.sessionEndTimestamp) {
        continue;
      }

      // ALWAYS invalidate cache (critical for inline compute mode)
      const staleCount = await this.cacheRepository.markStale(session.id, { excludeComputing: true });
      invalidated++;

      if (staleCount > 0) {
        this.logger.info('Marked telemetry cache entries stale for session', {
          context: 'SessionTelemetryQueueService.scheduleTelemetryForIngestedSamples',
          sessionId: session.id,
          entriesMarkedStale: staleCount,
          metricCodes: params.metricCodes,
        });
      } else {
        this.logger.debug('No cache entries to invalidate for session (may be STALE/COMPUTING already)', {
          context: 'SessionTelemetryQueueService.scheduleTelemetryForIngestedSamples',
          sessionId: session.id,
        });
      }

      // Only schedule worker jobs if queue is enabled
      if (!this.config.enabled) {
        continue;
      }

      for (const resolution of resolutions) {
        const result = await this.scheduleTelemetryCompute({
          sessionId: session.id,
          userId: session.userId,
          sessionStartMs: session.sessionStartTimestamp.getTime(),
          sessionEndMs: session.sessionEndTimestamp.getTime(),
          windowMinutes,
          resolution,
          reason: 'late_ingest',
          correlationId: params.correlationId,
          dedupeKey: params.dedupeKey,
          forceRecompute: true,
        });
        if (result.queued) {
          scheduled++;
        }
      }
    }

    // Log when cache invalidated but no jobs scheduled (inline compute mode)
    if (invalidated > 0 && scheduled === 0) {
      this.logger.info('Cache invalidated for late ingest (inline compute mode)', {
        context: 'SessionTelemetryQueueService.scheduleTelemetryForIngestedSamples',
        userId: params.userId,
        invalidated,
        queueEnabled: this.config.enabled,
        metricCodes: params.metricCodes,
      });
    }

    return { sessionsEvaluated: sessions.length, scheduled, invalidated };
  }

  private buildJobId(data: SessionTelemetryComputeJobData, dedupeKey?: string): string {
    // Use underscore (_) as separator instead.
    const suffix = dedupeKey ? `_${dedupeKey}` : `_${data.reason}`;
    return `telemetry_${data.sessionId}_${data.windowMinutes}_${data.resolution}_${data.computeVersion}${suffix}`;
  }

  private async enqueueJob(
    params: ScheduleTelemetryComputeParams,
    lockRowId?: string
  ): Promise<string> {
    const jobData: SessionTelemetryComputeJobData = {
      userId: params.userId,
      sessionId: params.sessionId,
      windowMinutes: params.windowMinutes,
      resolution: params.resolution,
      computeVersion: params.computeVersion ?? CURRENT_COMPUTE_VERSION,
      reason: params.reason,
      forceRecompute: params.forceRecompute,
      dedupeKey: params.dedupeKey,
      correlationId: params.correlationId,
      timestamp: new Date().toISOString(),
      // and compute directly against the pre-created COMPUTING row.
      // This fixes the worker/lock deadlock per SESSIONHEALTHKITUI.md.
      lockRowId,
    };

    const jobId = this.buildJobId(jobData, params.dedupeKey);

    try {
      const enqueuedJobId = await this.jobManagerService.enqueueJob(
        JobNames.SESSION_TELEMETRY_COMPUTE,
        jobData,
        {
          jobId,
          priority: JobPriority.MEDIUM,
          delay: params.delayMs,
          config: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 60000 },
            removeOnComplete: 1000,
            removeOnFail: 5000,
          },
        }
      );

      this.logger.info('Session telemetry compute job enqueued', {
        context: 'SessionTelemetryQueueService.enqueueJob',
        sessionId: params.sessionId,
        resolution: params.resolution,
        windowMinutes: params.windowMinutes,
        jobId: enqueuedJobId,
        lockRowId,
        reason: params.reason,
        forceRecompute: params.forceRecompute ?? false,
      });

      return enqueuedJobId;
    } catch (error) {
      this.logger.error('Failed to enqueue session telemetry compute job', {
        context: 'SessionTelemetryQueueService.enqueueJob',
        sessionId: params.sessionId,
        resolution: params.resolution,
        windowMinutes: params.windowMinutes,
        lockRowId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
