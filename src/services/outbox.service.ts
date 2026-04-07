/**
 * Outbox Service - Transactional Outbox Pattern Implementation
 * Ensures reliable dual-write operations by writing events to outbox table
 * within the same transaction as the primary data operation
 */

import { OutboxEvent, OutboxStatus, Prisma } from '@prisma/client';
import { OutboxEventRepository } from '../repositories/outbox-event.repository';
import { DatabaseService } from './database.service';
import { LoggerService } from './logger.service';
import { DeviceTelemetryRepository, CreateDeviceTelemetryInput } from '../repositories/device-telemetry.repository';
import { AnalyticsEventRepository, CreateAnalyticsEventInput } from '../repositories/analytics-event.repository';
import { DomainEventService } from '../events/domain-event.service';
import { EventTypeMap } from '../events/domain.events';
import {
  HealthProjectionCoordinatorService,
  HealthSamplesChangedPayload,
} from './health-projection-coordinator.service';
import { coalesceHealthPayloads } from './outbox-coalescing';
import { AppError, ErrorCodes } from '../utils/AppError';
import { getErrorMessage, getErrorStack, isPrismaError } from '../utils/error-handler';
import { handlePrismaError, OutboxEventPayloadSchema, validateJsonbField, parseJsonbField } from '../models';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import crypto from 'crypto';

export interface OutboxEventData {
  aggregateId: string;
  aggregateType: 'consumption' | 'journal' | 'purchase' | 'session' | 'inventory' | 'health';
  eventType: 'telemetry' | 'analytics' | 'domain_event' | 'health.samples.changed';
  payload: z.infer<typeof OutboxEventPayloadSchema>;
  maxRetries?: number;
}

export interface ProcessOutboxOptions {
  batchSize?: number;
  maxProcessingTime?: number;
  aggregateType?: string;
  eventType?: string;
}

export class OutboxService {
  private initialized: boolean = false;

  /**
   * Constructor with explicit dependency injection (Pure DI - no singleton)
   * All dependencies are required and injected by bootstrap.ts
   */
  public constructor(
    private outboxEventRepository: OutboxEventRepository,
    private db: DatabaseService,
    private logger: LoggerService,
    private deviceTelemetryRepository: DeviceTelemetryRepository,
    private analyticsEventRepository: AnalyticsEventRepository,
    private domainEventService?: DomainEventService,
    private healthProjectionCoordinator?: HealthProjectionCoordinatorService,
  ) {
    // Lightweight constructor - all dependencies injected explicitly
    // No internal service resolution, no getInstance() calls
  }

  /**
   * Generate a deterministic hash for event deduplication
   */
  private generateEventHash(eventData: OutboxEventData): string {
    const hashInput = JSON.stringify({
      aggregateId: eventData.aggregateId,
      aggregateType: eventData.aggregateType,
      eventType: eventData.eventType,
      payload: eventData.payload,
    });
    return crypto.createHash('sha256').update(hashInput).digest('hex');
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    
    try {
      // Dependencies are already injected via constructor
      // This method now only handles async initialization if needed
      
      this.initialized = true;
      this.logger.info('OutboxService initialized successfully', { context: 'OutboxService' });
    } catch (error) {
      this.logger.error('Failed to initialize OutboxService', { 
        context: 'OutboxService', 
        error: getErrorMessage(error), 
        stack: getErrorStack(error), 
      });
      throw new AppError(500, ErrorCodes.INTERNAL_SERVER_ERROR, 'OutboxService initialization failed');
    }
  }

  /**
   * Add event to outbox within a transaction
   * This should be called within the same transaction as the primary data operation
   */
  public async addEvent(
    tx: Prisma.TransactionClient,
    eventData: OutboxEventData,
  ): Promise<OutboxEvent> {
    return this.addEventInternal(tx, eventData);
  }

  /**
   * Add event to outbox outside of an existing transaction.
   * Creates its own mini-transaction for the outbox write.
   *
   * Use this when domain events must be durably persisted but the primary
   * data operation has already committed (e.g., post-transaction domain events).
   *
   * This is NOT atomic with the primary operation — a tiny window of loss
   * remains if the process crashes between the primary commit and this call.
   * However, it is vastly more durable than in-memory EventEmitter because
   * the event survives server restarts and benefits from outbox retry + DLQ.
   */
  public async addEventDirect(
    eventData: OutboxEventData,
  ): Promise<OutboxEvent> {
    const client = this.db.getClient();
    return client.$transaction(async (tx) => {
      return this.addEventInternal(tx, eventData);
    });
  }

  /**
   * Internal implementation for adding an event to outbox.
   * Shared by both addEvent (in-transaction) and addEventDirect (standalone).
   */
  private async addEventInternal(
    tx: Prisma.TransactionClient,
    eventData: OutboxEventData,
  ): Promise<OutboxEvent> {
    try {
      const eventHash = this.generateEventHash(eventData);

      const event = await tx.outboxEvent.create({
        data: {
          id: uuidv4(),
          aggregateId: eventData.aggregateId,
          aggregateType: eventData.aggregateType,
          eventType: eventData.eventType,
          payload: validateJsonbField(
            eventData.payload,
            OutboxEventPayloadSchema,
            'payload',
            eventData.aggregateId,
          ) as Prisma.InputJsonValue,
          status: OutboxStatus.PENDING,
          maxRetries: eventData.maxRetries || 3,
          eventHash: eventHash,
        },
      });

      this.logger.debug('Event added to outbox', {
        context: 'OutboxService',
        eventId: event.id,
        aggregateId: eventData.aggregateId,
        aggregateType: eventData.aggregateType,
        eventType: eventData.eventType,
      });

      return event;
    } catch (error) {
      this.logger.error('Failed to add event to outbox', {
        context: 'OutboxService',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
        eventData,
      });
      
      if (isPrismaError(error)) {
        throw handlePrismaError(error);
      }
      
      throw new AppError(
        500,
        ErrorCodes.INTERNAL_SERVER_ERROR,
        'Failed to add event to outbox',
      );
    }
  }

  /**
   * Process pending events in outbox
   * This runs asynchronously outside of transaction context
   */
  public async processPendingEvents(options: ProcessOutboxOptions = {}): Promise<{
    processed: number;
    failed: number;
    deadLettered: number;
  }> {
    const {
      batchSize = 100,
      maxProcessingTime = 30000, // 30 seconds
      aggregateType,
      eventType,
    } = options;

    const startTime = Date.now();
    let processed = 0;
    let failed = 0;
    let deadLettered = 0;

    try {
      this.logger.info('Starting outbox event processing', {
        context: 'OutboxService',
        batchSize,
        maxProcessingTime,
        aggregateType,
        eventType,
      });

      while (Date.now() - startTime < maxProcessingTime) {
        // Recover stale events from crashed workers before claiming new ones
        await this.outboxEventRepository.recoverStaleProcessing(5);

        // Atomic claim: SELECT + UPDATE in single statement (no TOCTOU race)
        // Events are returned already in PROCESSING status — no separate markAsProcessing needed
        const events = await this.outboxEventRepository.claimBatch(batchSize);

        if (events.length === 0) {
          break;
        }

        const directEvents: OutboxEvent[] = [];
        const healthGroups = new Map<string, OutboxEvent[]>();

        for (const event of events) {
          if (event.eventType === 'health.samples.changed') {
            const key = event.aggregateId;
            const existing = healthGroups.get(key);
            if (existing) {
              existing.push(event);
            } else {
              healthGroups.set(key, [event]);
            }
          } else {
            directEvents.push(event);
          }
        }

        // Process non-health events with existing per-event semantics.
        for (const event of directEvents) {
          try {
            await this.processEvent(event);
            processed++;
          } catch (error) {
            const outcome = await this.handleFailedEvent(event, error);
            if (outcome === 'deadLettered') {
              deadLettered++;
            } else {
              failed++;
            }
          }
        }

        const totalHealthEvents = Array.from(healthGroups.values()).reduce((sum, group) => sum + group.length, 0);
        if (totalHealthEvents > 0) {
          const coalescedGroups = Array.from(healthGroups.values()).filter((group) => group.length > 1).length;
          this.logger.info('Outbox health coalescing summary', {
            context: 'OutboxService.processPendingEvents',
            totalHealthEvents,
            totalHealthGroups: healthGroups.size,
            coalescedGroups,
            reductionFactor: totalHealthEvents / Math.max(healthGroups.size, 1),
          });
        }

        for (const group of healthGroups.values()) {
          if (group.length === 1) {
            const event = group[0]!;
            try {
              await this.processEvent(event);
              processed++;
            } catch (error) {
              const outcome = await this.handleFailedEvent(event, error);
              if (outcome === 'deadLettered') {
                deadLettered++;
              } else {
                failed++;
              }
            }
            continue;
          }

          const extracted: Array<{ event: OutboxEvent; payload: HealthSamplesChangedPayload }> = [];
          for (const event of group) {
            try {
              const validatedPayload = this.parseValidatedPayload(event);
              const payload = this.extractHealthPayload(validatedPayload, event.id);
              extracted.push({ event, payload });
            } catch (error) {
              const outcome = await this.handleFailedEvent(event, error);
              if (outcome === 'deadLettered') {
                deadLettered++;
              } else {
                failed++;
              }
            }
          }

          if (extracted.length === 0) {
            continue;
          }

          // FINDING 3 FIX: Wrap coalescing in try/catch with graceful degradation.
          // If coalescing fails (e.g., an unforeseen payload incompatibility that
          // survives per-event extraction validation), fall back to individual
          // per-event fanout. Healthy events proceed normally at the cost of N:N
          // fanout (pre-coalescing behavior). The corrupt event will fail during
          // its own individual processHealthProjectionFanout or markAsCompleted.
          // Previously, ALL events in the group were failed together — a single
          // corrupt event could push healthy peer events to DLQ after max retries.
          let mergedPayload: HealthSamplesChangedPayload;
          try {
            mergedPayload = coalesceHealthPayloads(extracted.map((item) => item.payload));
          } catch (mergeError) {
            this.logger.warn('Coalescing failed — falling back to individual per-event fanout', {
              context: 'OutboxService.processPendingEvents',
              aggregateId: group[0]!.aggregateId,
              groupSize: extracted.length,
              error: getErrorMessage(mergeError),
            });
            for (const item of extracted) {
              try {
                await this.processHealthProjectionFanout(item.event, item.payload);
                await this.markAsCompleted(item.event.id);
                processed++;
              } catch (individualError) {
                const outcome = await this.handleFailedEvent(item.event, individualError);
                if (outcome === 'deadLettered') {
                  deadLettered++;
                } else {
                  failed++;
                }
              }
            }
            continue;
          }

          const primaryEvent = extracted[0]!.event;
          const completedEventIds = new Set<string>();

          try {
            await this.processHealthProjectionFanout(primaryEvent, mergedPayload);

            for (const item of extracted) {
              await this.markAsCompleted(item.event.id);
              completedEventIds.add(item.event.id);
              processed++;
            }

            this.logger.info('Coalesced health event group processed', {
              context: 'OutboxService.processPendingEvents',
              primaryEventId: primaryEvent.id,
              aggregateId: primaryEvent.aggregateId,
              groupSize: extracted.length,
              metricCodes: mergedPayload.metricCodes.length,
              affectedLocalDates: mergedPayload.affectedLocalDates.length,
            });
          } catch (error) {
            this.logger.error('Failed to process coalesced health event group', {
              context: 'OutboxService.processPendingEvents',
              primaryEventId: primaryEvent.id,
              aggregateId: primaryEvent.aggregateId,
              groupSize: extracted.length,
              error: getErrorMessage(error),
            });

            for (const item of extracted) {
              if (completedEventIds.has(item.event.id)) {
                continue;
              }
              const outcome = await this.handleFailedEvent(item.event, error);
              if (outcome === 'deadLettered') {
                deadLettered++;
              } else {
                failed++;
              }
            }
          }
        }
      }

      this.logger.info('Outbox event processing completed', {
        context: 'OutboxService',
        processed,
        failed,
        deadLettered,
        processingTimeMs: Date.now() - startTime,
      });

      return { processed, failed, deadLettered };
    } catch (error) {
      this.logger.error('Outbox event processing failed', {
        context: 'OutboxService',
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
   * @deprecated Replaced by OutboxEventRepository.claimBatch() which atomically
   * claims events using UPDATE...RETURNING with FOR UPDATE SKIP LOCKED.
   * Retained for backward compatibility and potential direct use.
   *
   * Fetch pending events from outbox.
   * WARNING: This method has a TOCTOU race condition under concurrent workers.
   * Use OutboxEventRepository.claimBatch() instead.
   */
  private async fetchPendingEvents(
    batchSize: number,
    aggregateType?: string,
    eventType?: string,
  ): Promise<OutboxEvent[]> {
    const now = new Date();

    // Crash-safe WHERE: PENDING events whose retry backoff has elapsed (or was never set)
    const where: Prisma.OutboxEventWhereInput = {
      status: OutboxStatus.PENDING,
      OR: [
        { nextAttemptAt: null },          // New events or legacy events (immediately eligible)
        { nextAttemptAt: { lte: now } },  // Retry backoff period has elapsed
      ],
    };

    if (aggregateType) {
      where.aggregateType = aggregateType;
    }

    if (eventType) {
      where.eventType = eventType;
    }

    const result = await this.outboxEventRepository.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: batchSize,
    });

    return result || [];
  }

  /**
   * Process individual event
   */
  private async processEvent(event: OutboxEvent): Promise<void> {
    try {
      // NOTE: Event is already in PROCESSING status from atomic claimBatch.
      // No separate markAsProcessing call needed — eliminates TOCTOU race window.

      const validatedPayload = this.parseValidatedPayload(event);

      // Route event to appropriate handler based on eventType
      switch (event.eventType) {
        case 'telemetry':
          if (this.deviceTelemetryRepository) {
            // Convert payload to CreateDeviceTelemetryInput format
            // Type guard: validated payload has 'data' field as Record<string, unknown>
            const telemetryData = validatedPayload.data as Record<string, unknown>;
            const deviceTelemetryInput: CreateDeviceTelemetryInput = {
              userId: typeof telemetryData.userId === 'string' ? telemetryData.userId : '',
              deviceId: typeof telemetryData.deviceId === 'string' ? telemetryData.deviceId : '',
              timestamp: new Date(typeof telemetryData.timestamp === 'number' ? telemetryData.timestamp : Date.now()),
              metrics: typeof telemetryData.metrics === 'object' && telemetryData.metrics !== null ? telemetryData.metrics as Record<string, unknown> : {},
              sessionId: typeof telemetryData.sessionId === 'string' ? telemetryData.sessionId : undefined,
              ttl: typeof telemetryData.ttl === 'number' ? telemetryData.ttl : undefined,
            };
            await this.deviceTelemetryRepository.create(deviceTelemetryInput);
          } else {
            this.logger.warn('DeviceTelemetryRepository not available, skipping telemetry event', { eventId: event.id });
          }
          break;
        case 'analytics':
          if (this.analyticsEventRepository) {
            // Convert payload to CreateAnalyticsEventInput format
            const analyticsData = validatedPayload.data as Record<string, unknown>;
            const analyticsEventInput: CreateAnalyticsEventInput = {
              userId: typeof analyticsData.userId === 'string' ? analyticsData.userId : '',
              eventType: typeof analyticsData.eventType === 'string' ? analyticsData.eventType : '',
              eventTimestamp: new Date(typeof analyticsData.eventTimestamp === 'number' ? analyticsData.eventTimestamp : Date.now()),
              eventData: typeof analyticsData.eventData === 'object' && analyticsData.eventData !== null ? analyticsData.eventData as Record<string, unknown> : {},
              correlationId: typeof analyticsData.correlationId === 'string' ? analyticsData.correlationId : undefined,
              sessionId: typeof analyticsData.sessionId === 'string' ? analyticsData.sessionId : undefined,
              productId: typeof analyticsData.productId === 'string' ? analyticsData.productId : undefined,
              ttl: typeof analyticsData.ttl === 'number' ? analyticsData.ttl : undefined,
            };
            await this.analyticsEventRepository.create(analyticsEventInput);
          } else {
            this.logger.warn('AnalyticsEventRepository not available, skipping analytics event', { eventId: event.id });
          }
          break;
        case 'domain_event':
          if (!this.domainEventService) {
            throw new Error(
              `DomainEventService not injected — cannot process domain_event outbox entry ${event.id}`,
            );
          }
          {
            // Extract domain event routing info from outbox payload data
            const domainData = validatedPayload.data as Record<string, unknown>;
            const domainEventType = domainData.domainEventType;
            if (typeof domainEventType !== 'string') {
              throw new Error(
                `Missing or invalid domainEventType in domain_event outbox payload for event ${event.id}`,
              );
            }

            // Extract the domain event payload (everything except routing key)
            const { domainEventType: _key, emitOptions: rawOptions, ...domainPayload } = domainData;

            // Reconstruct emitEvent options (correlationId, metadata, priority)
            const emitOptions = typeof rawOptions === 'object' && rawOptions !== null
              ? rawOptions as Record<string, unknown>
              : undefined;

            this.logger.debug('Processing domain_event from outbox', {
              context: 'OutboxService',
              eventId: event.id,
              domainEventType,
              aggregateId: event.aggregateId,
            });

            // Emit through DomainEventService — this fires all in-memory subscribers
            // (achievements, analytics, goals, WebSocket broadcast, etc.)
            //
            // DomainEventService.emitEvent() swallows handler errors (by design
            // for fire-and-forget in-process events), which means the outbox
            // marks the event COMPLETED even when subscribers failed — breaking
            // at-least-once delivery guarantees. With the flag set, handler
            // errors propagate back to processEvent() → outbox retry → DLQ.
            await this.domainEventService.emitEvent(
              domainEventType as keyof EventTypeMap,
              domainPayload as Parameters<typeof this.domainEventService.emitEvent>[1],
              {
                correlationId: emitOptions && typeof emitOptions.correlationId === 'string'
                  ? emitOptions.correlationId
                  : undefined,
                metadata: emitOptions && typeof emitOptions.metadata === 'object' && emitOptions.metadata !== null
                  ? emitOptions.metadata as Record<string, unknown>
                  : undefined,
                throwOnHandlerFailure: true,
              },
            );
          }
          break;
        case 'health.samples.changed':
          // P0-A/B: HEALTH PROJECTION FANOUT PATTERN
          // Route health.samples.changed events to HealthProjectionCoordinatorService
          // which handles per-projection checkpoint tracking and independent retry.
          //
          // provide at-least-once delivery guarantees with proper failure tracking.
          if (!this.healthProjectionCoordinator) {
            throw new Error(
              `HealthProjectionCoordinatorService not injected — cannot process health.samples.changed outbox entry ${event.id}`,
            );
          }
          await this.processHealthProjectionFanout(
            event,
            this.extractHealthPayload(validatedPayload, event.id),
          );
          break;
        default:
          throw new Error(`Unknown event type: ${event.eventType}`);
      }

      // Mark as completed
      await this.markAsCompleted(event.id);

      this.logger.debug('Outbox event processed successfully', {
        context: 'OutboxService',
        eventId: event.id,
        aggregateType: event.aggregateType,
        eventType: event.eventType,
      });
    } catch (error) {
      // DO NOT reset status here — the caller (processPendingEvents) handles
      // the full status transition atomically via incrementRetryCount or
      // markAsDeadLetter. Resetting to PENDING here without backoff creates a
      // hot-loop risk: if incrementRetryCount subsequently fails, the event
      // sits PENDING with no nextAttemptAt and gets immediately re-claimed.
      //
      // By leaving the event in PROCESSING status, two safety nets apply:
      // 1. The caller's incrementRetryCount atomically transitions
      //    PROCESSING → PENDING with retryCount++ and nextAttemptAt (crash-safe backoff)
      // 2. If incrementRetryCount itself fails, recoverStaleProcessing (called at
      //    the start of each poll cycle) will eventually reset stale PROCESSING
      //    events back to PENDING after the configured threshold (default 5 min).
      throw error;
    }
  }

  private parseValidatedPayload(event: OutboxEvent): z.infer<typeof OutboxEventPayloadSchema> {
    const validatedPayload = parseJsonbField(
      event.payload,
      OutboxEventPayloadSchema,
      'payload',
      { entityId: event.id, required: true, logger: this.logger },
    );

    if (!validatedPayload) {
      throw new Error(`Failed to parse payload for event ${event.id}`);
    }

    return validatedPayload;
  }

  private extractHealthPayload(
    validatedPayload: z.infer<typeof OutboxEventPayloadSchema>,
    eventId: string,
  ): HealthSamplesChangedPayload {
    const healthData = validatedPayload.data as Record<string, unknown>;

    // FINDING 6 FIX: Fail-fast on critical fields.
    // These fields are ALWAYS populated by the health ingestion transaction.
    // Missing or wrong-typed values indicate DB corruption, serialization bug,
    // or manual SQL manipulation — all non-retryable. Throw so the event
    // routes to DLQ instead of silently producing incorrect projections.
    if (typeof healthData.userId !== 'string' || healthData.userId.length === 0) {
      throw new Error(
        `Corrupt health payload for event ${eventId}: missing or empty userId`
      );
    }
    if (typeof healthData.requestId !== 'string' || healthData.requestId.length === 0) {
      throw new Error(
        `Corrupt health payload for event ${eventId}: missing or empty requestId`
      );
    }
    const metricCodes = Array.isArray(healthData.metricCodes)
      ? healthData.metricCodes.filter((c): c is string => typeof c === 'string')
      : [];
    if (metricCodes.length === 0) {
      throw new Error(
        `Corrupt health payload for event ${eventId}: missing or empty metricCodes`
      );
    }
    const affectedLocalDates = Array.isArray(healthData.affectedLocalDates)
      ? healthData.affectedLocalDates.filter((d): d is string => typeof d === 'string')
      : [];
    if (affectedLocalDates.length === 0) {
      throw new Error(
        `Corrupt health payload for event ${eventId}: missing or empty affectedLocalDates`
      );
    }
    if (typeof healthData.rangeStartMs !== 'number') {
      throw new Error(
        `Corrupt health payload for event ${eventId}: missing rangeStartMs (got ${typeof healthData.rangeStartMs})`
      );
    }
    if (typeof healthData.rangeEndMs !== 'number') {
      throw new Error(
        `Corrupt health payload for event ${eventId}: missing rangeEndMs (got ${typeof healthData.rangeEndMs})`
      );
    }

    // FINDING 3 FIX: Validate minRequiredSeq at the per-event extraction boundary.
    // Corrupt values (e.g., 'not-a-number') that survive extraction would poison
    // coalesceHealthPayloads() (which calls BigInt()), failing the entire user-group
    // including healthy events. By validating here, the per-event catch block in
    // processPendingEvents (extraction loop) isolates corruption to the single
    // offending event — healthy peer events proceed to coalescing unaffected.
    let minRequiredSeq: string | number | undefined;
    if (typeof healthData.minRequiredSeq === 'string' || typeof healthData.minRequiredSeq === 'number') {
      try {
        BigInt(healthData.minRequiredSeq);
        minRequiredSeq = healthData.minRequiredSeq;
      } catch {
        throw new Error(
          `Invalid minRequiredSeq in health payload for event ${eventId}: ` +
          `cannot convert '${String(healthData.minRequiredSeq)}' to BigInt`
        );
      }
    }

    // Non-critical fields: safe to default (metadata, counters, optional flags).
    // These do not affect projection correctness if absent.
    return {
      userId: healthData.userId,
      requestId: healthData.requestId,
      correlationId: typeof healthData.correlationId === 'string' ? healthData.correlationId : '',
      deviceId: typeof healthData.deviceId === 'string' ? healthData.deviceId : undefined,
      sampleCount: typeof healthData.sampleCount === 'number' ? healthData.sampleCount : 0,
      deletedCount: typeof healthData.deletedCount === 'number' ? healthData.deletedCount : 0,
      hasDeletions: typeof healthData.hasDeletions === 'boolean' ? healthData.hasDeletions : false,
      metricCodes,
      affectedLocalDates,
      rangeStartMs: healthData.rangeStartMs,
      rangeEndMs: healthData.rangeEndMs,
      timezoneOffsetMinutes: typeof healthData.timezoneOffsetMinutes === 'number'
        ? healthData.timezoneOffsetMinutes
        : undefined,
      timezoneExplicit: typeof healthData.timezoneExplicit === 'boolean'
        ? healthData.timezoneExplicit
        : undefined,
      offsetRange: (
        healthData.offsetRange != null &&
        typeof healthData.offsetRange === 'object' &&
        typeof (healthData.offsetRange as Record<string, unknown>).min === 'number' &&
        typeof (healthData.offsetRange as Record<string, unknown>).max === 'number'
      )
        ? {
            min: (healthData.offsetRange as Record<string, unknown>).min as number,
            max: (healthData.offsetRange as Record<string, unknown>).max as number,
          }
        : undefined,
      minRequiredSeq,
    };
  }

  private async processHealthProjectionFanout(
    event: OutboxEvent,
    healthPayload: HealthSamplesChangedPayload,
  ): Promise<void> {
    if (!this.healthProjectionCoordinator) {
      throw new Error(
        `HealthProjectionCoordinatorService not injected — cannot process health.samples.changed outbox entry ${event.id}`,
      );
    }

    this.logger.debug('Processing health.samples.changed from outbox', {
      context: 'OutboxService',
      eventId: event.id,
      userId: healthPayload.userId,
      requestId: healthPayload.requestId,
      sampleCount: healthPayload.sampleCount,
      deletedCount: healthPayload.deletedCount,
    });

    const fanoutResult = await this.healthProjectionCoordinator.processHealthSamplesChanged(
      event,
      healthPayload,
    );

    if (fanoutResult.anyFailed) {
      throw new Error(
        `Health projection fanout partially failed: ${fanoutResult.failedProjections.join(', ')}`,
      );
    }

    this.logger.info('Health projection fanout completed successfully', {
      context: 'OutboxService',
      eventId: event.id,
      userId: healthPayload.userId,
      allCompleted: fanoutResult.allCompleted,
      resultCount: fanoutResult.results.length,
      totalDurationMs: fanoutResult.totalDurationMs,
    });
  }

  private async handleFailedEvent(
    event: OutboxEvent,
    error: unknown,
  ): Promise<'failed' | 'deadLettered'> {
    this.logger.error('Failed to process outbox event', {
      context: 'OutboxService',
      eventId: event.id,
      error: getErrorMessage(error),
    });

    if (this.isNonRetryablePayloadError(error)) {
      await this.markAsDeadLetter(event.id, getErrorMessage(error));
      return 'deadLettered';
    }

    if (event.retryCount >= event.maxRetries) {
      await this.markAsDeadLetter(event.id, getErrorMessage(error));
      return 'deadLettered';
    }

    await this.incrementRetryCount(event.id, getErrorMessage(error), event.retryCount);
    return 'failed';
  }

  /**
   * @deprecated No longer called by processEvent — claimBatch atomically sets
   * status to PROCESSING. Retained for backward compatibility.
   */
  private async markAsProcessing(eventId: string): Promise<void> {
    await this.outboxEventRepository.update(
      { id: eventId },
      {
        status: OutboxStatus.PROCESSING,
        updatedAt: new Date(),
      },
    );
    // Repository throws AppError on failure
  }

  /**
   * Mark event as completed
   */
  private async markAsCompleted(eventId: string): Promise<void> {
    await this.outboxEventRepository.update(
      { id: eventId },
      {
        status: OutboxStatus.COMPLETED,
        processedAt: new Date(),
        updatedAt: new Date(),
      },
    );
    // Repository throws AppError on failure
  }

  /**
   * Increment retry count with crash-safe scheduling.
   *
   * Instead of using volatile setTimeout (lost on crash/restart), we persist
   * nextAttemptAt to the database. The event stays PENDING with a future
   * nextAttemptAt — the polling loop will pick it up when the time arrives.
   *
   * Backoff formula: min(2^retryCount * 5000ms, 300000ms)
   *   retryCount=0 → 5s, 1 → 10s, 2 → 20s, 3 → 40s (then DLQ at maxRetries=3)
   */
  private static readonly BASE_DELAY_MS = 5000;
  private static readonly MAX_DELAY_MS = 300_000; // 5 minutes cap

  private async incrementRetryCount(eventId: string, error: string, currentRetryCount?: number): Promise<void> {
    // Use provided retryCount (from the claimed event object) to avoid an extra
    // DB round-trip. Falls back to 0 if not provided (backward compat).
    const retryCount = currentRetryCount ?? 0;

    // Crash-safe exponential backoff: persisted in DB instead of volatile setTimeout
    const delayMs = Math.min(
      Math.pow(2, retryCount) * OutboxService.BASE_DELAY_MS,
      OutboxService.MAX_DELAY_MS,
    );
    const nextAttemptAt = new Date(Date.now() + delayMs);

    // Atomically: transition PROCESSING → PENDING with retryCount++, nextAttemptAt, error.
    // The event remains PENDING (eligible for polling) but with a future nextAttemptAt
    // that the polling query respects: (nextAttemptAt IS NULL OR nextAttemptAt <= NOW())
    //
    // If this update fails, the event stays in PROCESSING status. This is
    // intentional: recoverStaleProcessing (called at the start of each poll
    // cycle) will reset stale PROCESSING events after the configured threshold.
    // This is strictly safer than silently swallowing the error and leaving the
    // event PENDING without backoff (which would cause a hot-loop).
    await this.outboxEventRepository.update(
      { id: eventId },
      {
        status: OutboxStatus.PENDING,
        retryCount: { increment: 1 },
        error,
        nextAttemptAt,
        updatedAt: new Date(),
      },
    );

    this.logger.debug('Event retry scheduled via nextAttemptAt (crash-safe)', {
      context: 'OutboxService',
      eventId,
      retryCount: retryCount + 1,
      delayMs,
      nextAttemptAt: nextAttemptAt.toISOString(),
    });
  }

  /**
   * Mark event as dead letter
   */
  private async markAsDeadLetter(eventId: string, error: string): Promise<void> {
    const result = await this.outboxEventRepository.update(
      { id: eventId },
      {
        status: OutboxStatus.DEAD_LETTER,
        error,
        updatedAt: new Date(),
      },
    );
    
    // Repository throws AppError on failure

    this.logger.error('Event moved to dead letter queue', {
      context: 'OutboxService',
      eventId,
      error,
    });
  }

  /**
   * Determine whether an error is guaranteed non-retryable payload corruption.
   *
   * parseJsonbField(required=true) throws AppError(DATABASE_ERROR) for missing
   * or schema-invalid payloads persisted in DB. Retries cannot heal these rows.
   */
  private isNonRetryablePayloadError(error: unknown): boolean {
    if (!(error instanceof AppError)) {
      return false;
    }

    if (error.errorCode !== ErrorCodes.DATABASE_ERROR) {
      return false;
    }

    return (
      error.message.includes('Corrupted payload data found in database') ||
      error.message.includes('Required payload is missing from database')
    );
  }

  /**
   * Clean up old completed events (for maintenance)
   */
  public async cleanupOldEvents(olderThanDays: number = 7): Promise<number> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

      const result = await this.outboxEventRepository.deleteMany({
        status: OutboxStatus.COMPLETED,
        processedAt: {
          lt: cutoffDate,
        },
      });
      
      this.logger.info('Cleaned up old outbox events', {
        context: 'OutboxService',
        deletedCount: result,
        olderThanDays,
      });

      return result ?? 0;
    } catch (error) {
      this.logger.error('Failed to cleanup old outbox events', {
        context: 'OutboxService',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      
      throw new AppError(
        500,
        ErrorCodes.INTERNAL_SERVER_ERROR,
        'Failed to cleanup old outbox events',
      );
    }
  }

  /**
   * Get outbox statistics
   */
  public async getStatistics(): Promise<{
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    deadLetter: number;
  }> {
    try {
      const [pendingResult, processingResult, completedResult, failedResult, deadLetterResult] = await Promise.all([
        this.outboxEventRepository.count({ status: OutboxStatus.PENDING }),
        this.outboxEventRepository.count({ status: OutboxStatus.PROCESSING }),
        this.outboxEventRepository.count({ status: OutboxStatus.COMPLETED }),
        this.outboxEventRepository.count({ status: OutboxStatus.FAILED }),
        this.outboxEventRepository.count({ status: OutboxStatus.DEAD_LETTER }),
      ]);
      
      return {
        pending: pendingResult ?? 0,
        processing: processingResult ?? 0,
        completed: completedResult ?? 0,
        failed: failedResult ?? 0,
        deadLetter: deadLetterResult ?? 0,
      };
    } catch (error) {
      this.logger.error('Failed to get outbox statistics', {
        context: 'OutboxService',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      
      throw new AppError(
        500,
        ErrorCodes.INTERNAL_SERVER_ERROR,
        'Failed to get outbox statistics',
      );
    }
  }
}
