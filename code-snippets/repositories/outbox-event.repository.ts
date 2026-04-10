/**
 * Outbox Event Repository
 * 
 * Handles all outbox pattern event publishing database operations for the AppPlatform backend.
 * Implements the transactional outbox pattern for reliable event publishing.
 * 
 * @module OutboxEventRepository
 */

import { PrismaClient, OutboxEvent, OutboxStatus, Prisma } from '@prisma/client';
import { BaseRepository } from './base.repository';
import { PaginationOptions, PaginatedResponse } from '../types/database.types';
import { AppError, ErrorCodes } from '../utils/AppError';
import { LoggerService } from '../services/logger.service';
import { OutboxEventPayloadSchema, MetadataSchema, validateJsonbField } from '../models';
import { z } from 'zod';

export interface OutboxEventCreateInput {
  aggregateId: string;
  aggregateType: string;
  eventType: string;
  payload: z.infer<typeof OutboxEventPayloadSchema>;
  eventHash: string;
  maxRetries?: number;
  /**
   * Request-level deduplication key for atomic health ingest.
   * Used with partial unique index to prevent duplicate in-flight events.
   * Format: `health-ingest:${requestId}`
   */
  dedupeKey?: string;
}

export interface OutboxEventUpdateInput {
  status?: OutboxStatus;
  processedAt?: Date;
  error?: string;
  retryCount?: number;
}

export interface EventProcessingResult {
  eventId: string;
  success: boolean;
  errorMessage?: string;
  shouldRetry?: boolean;
}

export interface OutboxStatistics {
  totalEvents: number;
  pendingEvents: number;
  processedEvents: number;
  failedEvents: number;
  averageProcessingTime: number;
  eventsByType: Record<string, number>;
  oldestPendingEvent?: Date;
  retryQueue: number;
}

export class OutboxEventRepository extends BaseRepository<OutboxEvent> {
  constructor(prisma: PrismaClient, entityName: string, logger: LoggerService) {
    super(prisma, entityName, logger);
  }

  /**
   * Creates a new outbox event
   */
  async create(
    data: OutboxEventCreateInput,
  ): Promise<OutboxEvent> {
    try {
      // Validate payload before storing
      const validatedPayload = validateJsonbField(
        data.payload,
        OutboxEventPayloadSchema,
        'payload'
      );

      const outboxEvent = await this.prisma.outboxEvent.create({
        data: {
          aggregateId: data.aggregateId,
          aggregateType: data.aggregateType,
          eventType: data.eventType,
          payload: validatedPayload as Prisma.InputJsonValue,
          status: OutboxStatus.PENDING,
          retryCount: 0,
          maxRetries: data.maxRetries || 3,
          eventHash: data.eventHash,
          dedupeKey: data.dedupeKey ?? null,
          // NOTE: OutboxEvent does NOT have a version field - status-based concurrency control
        },
      });

      return outboxEvent;
    } catch (error) {
      throw this.handleError(error, 'create outbox event');
    }
  }

  /**
   * Creates an outbox event within an existing transaction.
   *
   * the outbox event MUST be written in the same transaction as the data mutation.
   * This prevents dual-write inconsistencies where data is committed but event is lost.
   *
   * @param tx - Prisma transaction client
   * @param data - Outbox event data
   * @returns Created outbox event
   */
  async createInTransaction(
    tx: Prisma.TransactionClient,
    data: OutboxEventCreateInput,
  ): Promise<OutboxEvent> {
    // Validate payload before storing
    const validatedPayload = validateJsonbField(
      data.payload,
      OutboxEventPayloadSchema,
      'payload'
    );

    const outboxEvent = await tx.outboxEvent.create({
      data: {
        aggregateId: data.aggregateId,
        aggregateType: data.aggregateType,
        eventType: data.eventType,
        payload: validatedPayload as Prisma.InputJsonValue,
        status: OutboxStatus.PENDING,
        retryCount: 0,
        maxRetries: data.maxRetries || 3,
        eventHash: data.eventHash,
        dedupeKey: data.dedupeKey ?? null,
      },
    });

    this.logSuccess('createInTransaction', {
      eventId: outboxEvent.id,
      eventType: data.eventType,
      aggregateType: data.aggregateType,
    });

    return outboxEvent;
  }

  /**
   * Creates multiple outbox events in a transaction
   */
  async createMany(
    events: OutboxEventCreateInput[],
  ): Promise<number> {
    try {
      const result = await this.prisma.outboxEvent.createMany({
        data: events.map(event => {
          // Validate each payload before storing
          const validatedPayload = validateJsonbField(
            event.payload,
            OutboxEventPayloadSchema,
            'payload',
            event.aggregateId
          );

          return {
            aggregateId: event.aggregateId,
            aggregateType: event.aggregateType,
            eventType: event.eventType,
            payload: validatedPayload as Prisma.InputJsonValue,
            status: OutboxStatus.PENDING,
            retryCount: 0,
            maxRetries: event.maxRetries || 3,
            eventHash: event.eventHash,
          };
        }),
      });

      return result.count;
    } catch (error) {
      throw this.handleError(error, 'create multiple outbox events');
    }
  }

  /**
   * Finds unprocessed events ready for processing.
   *
   * Crash-safe polling: events are PENDING with nextAttemptAt = NULL (new) or
   * nextAttemptAt <= NOW() (retry backoff elapsed). Failed events that are retrying
   * stay in PENDING status with a future nextAttemptAt and are excluded until
   * their backoff period elapses.
   *
   * Uses retry logic for transient database failures (Neon cold starts, pool exhaustion).
   */
  async findUnprocessedEvents(
    limit: number = 100,
    _includeRetries: boolean = true, // Retained for backward compat; retries are now always included via nextAttemptAt
  ): Promise<OutboxEvent[]> {
    try {
      // Wrap database operation with retry logic for transient failures
      return await this.executeWithRetry(async () => {
        const now = new Date();

        const where: Prisma.OutboxEventWhereInput = {
          status: OutboxStatus.PENDING,
          OR: [
            { nextAttemptAt: null },          // New events or legacy events (immediately eligible)
            { nextAttemptAt: { lte: now } },  // Retry backoff period has elapsed
          ],
        };

        const events = await this.prisma.outboxEvent.findMany({
          where,
          orderBy: [
            { createdAt: 'asc' },
            { retryCount: 'asc' },
          ],
          take: limit,
        });

        this.logSuccess('findUnprocessedEvents', { count: events.length, limit });
        return events;
      }, 'findUnprocessedEvents');
    } catch (error) {
      throw this.handleError(error, 'find unprocessed events');
    }
  }

  /**
   * Atomically claim a batch of pending outbox events for processing.
   *
   * Uses UPDATE...RETURNING with FOR UPDATE SKIP LOCKED to prevent concurrent
   * workers from double-processing the same event (TOCTOU race). This replaces
   * the vulnerable fetch-then-mark pattern.
   *
   * The inner SELECT locks candidate rows (SKIP LOCKED skips rows held by other
   * workers instead of blocking), and the outer UPDATE atomically transitions
   * them to PROCESSING. RETURNING provides the claimed events in a single round-trip.
   *
   * @param limit - Maximum number of events to claim (default 100)
   * @returns Array of claimed events (already transitioned to PROCESSING status)
   */
  async claimBatch(limit: number = 100): Promise<OutboxEvent[]> {
    try {
      return await this.executeWithRetry(async () => {
        const now = new Date();
        // Columns with @map() directives: next_attempt_at, event_hash, dedupe_key.
        // RETURNING uses aliases to match the Prisma OutboxEvent type shape.
        const rawEvents = await this.prisma.$queryRaw<OutboxEvent[]>`
          UPDATE "OutboxEvent"
          SET status = 'PROCESSING'::"OutboxStatus", "updatedAt" = ${now}
          WHERE id IN (
            SELECT id FROM "OutboxEvent"
            WHERE status = 'PENDING'::"OutboxStatus"
              AND ("next_attempt_at" IS NULL OR "next_attempt_at" <= ${now})
            -- FINDING 4 FIX: Cluster same-user events together to maximize
            -- health event coalescing within a single claimed batch. With
            -- createdAt-only ordering, interleaved multi-user events split
            -- across positions, reducing coalescing effectiveness under
            -- concurrent ingestion. Tradeoff: users with many pending events
            -- are processed in bursts rather than strict cross-user FIFO;
            -- at typical 10s polling intervals this delay is negligible.
            ORDER BY "aggregateId" ASC, "createdAt" ASC
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED
          )
          RETURNING
            id,
            "aggregateId",
            "aggregateType",
            "eventType",
            payload,
            status,
            "retryCount",
            "maxRetries",
            "processedAt",
            error,
            "event_hash" AS "eventHash",
            "next_attempt_at" AS "nextAttemptAt",
            "dedupe_key" AS "dedupeKey",
            "createdAt",
            "updatedAt"
        `;

        // Unlike findMany (which auto-deserializes JSONB → object), $queryRaw
        // may return JSONB columns as raw JSON strings depending on the driver.
        // Normalize payload to a parsed object at this boundary.
        const events = rawEvents.map(event => ({
          ...event,
          payload: typeof event.payload === 'string'
            ? JSON.parse(event.payload)
            : event.payload,
        }));

        this.logSuccess('claimBatch', { claimed: events.length, limit });
        return events;
      }, 'claimBatch');
    } catch (error) {
      throw this.handleError(error, 'claimBatch');
    }
  }

  /**
   * Recover events stuck in PROCESSING status due to worker crashes.
   *
   * Resets events that have been in PROCESSING for longer than the specified
   * timeout back to PENDING, making them eligible for re-processing on the
   * next poll cycle.
   *
   * Should be called before each claimBatch to prevent event starvation.
   *
   * @param staleTimeoutMinutes - Minutes after which PROCESSING events are considered stale (default 5)
   * @returns Number of recovered events
   */
  async recoverStaleProcessing(staleTimeoutMinutes: number = 5): Promise<number> {
    try {
      const cutoff = new Date(Date.now() - staleTimeoutMinutes * 60 * 1000);
      const result = await this.prisma.outboxEvent.updateMany({
        where: {
          status: OutboxStatus.PROCESSING,
          updatedAt: { lt: cutoff },
        },
        data: {
          status: OutboxStatus.PENDING,
          updatedAt: new Date(),
        },
      });

      if (result.count > 0) {
        this.logSuccess('recoverStaleProcessing', {
          recovered: result.count,
          staleTimeoutMinutes,
        });
      }
      return result.count;
    } catch (error) {
      throw this.handleError(error, 'recoverStaleProcessing');
    }
  }

  /**
   * Marks an event as processed
   */
  async markAsProcessed(
    id: string,
    processedAt?: Date,
  ): Promise<OutboxEvent> {
    try {
      const event = await this.prisma.outboxEvent.update({
        where: { id },
        data: {
          status: OutboxStatus.COMPLETED,
          processedAt: processedAt || new Date(),
          error: null,
          updatedAt: new Date(),
        },
      });

      return event;
    } catch (error) {
      throw this.handleError(error, 'mark event as processed');
    }
  }

  /**
   * Marks an event as failed with retry logic
   */
  async markAsFailed(
    id: string,
    errorMessage: string,
    shouldRetry: boolean = true,
  ): Promise<OutboxEvent> {
    try {
      const event = await this.prisma.outboxEvent.findUnique({
        where: { id },
      });

      if (!event) {
        throw new AppError(404, ErrorCodes.NOT_FOUND, 'Outbox event not found');
      }

      const newRetryCount = event.retryCount + 1;
      const canRetry = shouldRetry && newRetryCount < event.maxRetries;
      
      // Calculate next retry time with exponential backoff
      const nextRetryAt = canRetry
        ? new Date(Date.now() + Math.pow(2, newRetryCount) * 1000 * 60) // 2^n minutes
        : null;

      const updatedEvent = await this.prisma.outboxEvent.update({
        where: { id },
        data: {
          status: canRetry ? OutboxStatus.FAILED : OutboxStatus.DEAD_LETTER,
          error: errorMessage,
          retryCount: newRetryCount,
          updatedAt: new Date(),
        },
      });

      return updatedEvent;
    } catch (error) {
      throw this.handleError(error, 'mark event as failed');
    }
  }

  /**
   * Processes events in batch
   */
  async processBatch(
    processor: (event: OutboxEvent) => Promise<EventProcessingResult>,
    batchSize: number = 50,
  ): Promise<{ processed: number; failed: number }> {
    try {
      const events = await this.findUnprocessedEvents(batchSize);
      let processed = 0;
      let failed = 0;

      // Process events in parallel with concurrency limit
      const concurrencyLimit = 10;
      for (let i = 0; i < events.length; i += concurrencyLimit) {
        const batch = events.slice(i, i + concurrencyLimit);
        
        const results = await Promise.allSettled(
          batch.map(async (event) => {
            try {
              const result = await processor(event);
              
              if (result.success) {
                await this.markAsProcessed(event.id);
                processed++;
                return;
              } else {
                await this.markAsFailed(
                  event.id,
                  result.errorMessage || 'Processing failed',
                  result.shouldRetry !== false,
                );
                return { success: false };
              }
            } catch (error) {
              await this.markAsFailed(
                event.id,
                error instanceof Error ? error.message : 'Unknown error',
                true,
              );
              return { success: false };
            }
          }),
        );

        results.forEach(result => {
          if (result.status === 'fulfilled') {
            // processed++ is already handled inside the async function
          } else {
            failed++;
          }
        });
      }

      return { processed, failed };
    } catch (error) {
      throw this.handleError(error, 'process event batch');
    }
  }

  /**
   * Gets events by aggregate
   */
  async findByAggregate(
    aggregateId: string,
    aggregateType: string,
    options?: PaginationOptions,
  ): Promise<PaginatedResponse<OutboxEvent>> {
    try {
      const where: Prisma.OutboxEventWhereInput = {
        aggregateId,
        aggregateType,
      };

      // Extract pagination parameters with proper typing from PaginationOptions
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? 20;
      const pageSize = options?.pageSize ?? limit;

      const [events, total] = await Promise.all([
        this.prisma.outboxEvent.findMany({
          where,
          skip: offset,
          take: limit,
          orderBy: { createdAt: 'desc' },
        }),
        this.prisma.outboxEvent.count({ where }),
      ]);

      return {
        items: events,
        total,
        page: Math.floor(offset / pageSize) + 1,
        pageSize,
        hasMore: events.length === pageSize,
        totalPages: Math.ceil(total / pageSize),
        offset,
      };
    } catch (error) {
      throw this.handleError(error, 'find events by aggregate');
    }
  }

  /**
   * Gets outbox statistics
   */
  async getStatistics(): Promise<OutboxStatistics> {
    try {
      const [statusCounts, typeStats, processingTimes, oldestPending] = await Promise.all([
        // Count by status
        this.prisma.outboxEvent.groupBy({
          by: ['status'],
          _count: true,
        }),
        // Count by event type
        this.prisma.outboxEvent.groupBy({
          by: ['eventType'],
          _count: true,
        }),
        // Average processing time for completed events
        this.prisma.$queryRaw<Array<{ avg_time: number }>>`
          SELECT AVG(EXTRACT(EPOCH FROM ("processedAt" - "createdAt"))) as avg_time
          FROM "OutboxEvent"
          WHERE status = 'COMPLETED' AND "processedAt" IS NOT NULL
        `,
        // Oldest pending event
        this.prisma.outboxEvent.findFirst({
          where: { status: OutboxStatus.PENDING },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
      ]);

      const statusMap = statusCounts.reduce((acc, item) => {
        acc[item.status] = item._count;
        return acc;
      }, {} as Record<string, number>);

      const eventsByType = typeStats.reduce((acc, item) => {
        acc[item.eventType] = item._count;
        return acc;
      }, {} as Record<string, number>);

      return {
        totalEvents: Object.values(statusMap).reduce((sum, count) => sum + count, 0),
        pendingEvents: statusMap[OutboxStatus.PENDING] || 0,
        processedEvents: statusMap[OutboxStatus.COMPLETED] || 0,
        failedEvents: (statusMap[OutboxStatus.FAILED] || 0) + (statusMap[OutboxStatus.DEAD_LETTER] || 0),
        averageProcessingTime: processingTimes[0]?.avg_time || 0,
        eventsByType,
        oldestPendingEvent: oldestPending?.createdAt,
        retryQueue: statusMap[OutboxStatus.FAILED] || 0,
      };
    } catch (error) {
      throw this.handleError(error, 'get outbox statistics');
    }
  }

  /**
   * Moves dead letter events back to pending
   */
  async retryDeadLetterEvents(
    eventIds?: string[],
  ): Promise<number> {
    try {
      const where: Prisma.OutboxEventWhereInput = {
        status: OutboxStatus.DEAD_LETTER,
        ...(eventIds && { id: { in: eventIds } }),
      };

      const result = await this.prisma.outboxEvent.updateMany({
        where,
        data: {
          status: OutboxStatus.PENDING,
          retryCount: 0,
          error: null,
          updatedAt: new Date(),
        },
      });

      return result.count;
    } catch (error) {
      throw this.handleError(error, 'retry dead letter events');
    }
  }

  /**
   * Cleans up old processed events
   */
  async cleanupProcessedEvents(
    daysToKeep: number = 30,
  ): Promise<number> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

      const result = await this.prisma.outboxEvent.deleteMany({
        where: {
          status: OutboxStatus.COMPLETED,
          processedAt: {
            lt: cutoffDate,
          },
        },
      });

      return result.count;
    } catch (error) {
      throw this.handleError(error, 'cleanup processed events');
    }
  }

  /**
   * Archives old events
   */
  async archiveOldEvents(
    daysToArchive: number = 90,
  ): Promise<number> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToArchive);

      // In production, you might move these to an archive table
      // For now, we'll just mark them with metadata
      const result = await this.prisma.outboxEvent.updateMany({
        where: {
          createdAt: {
            lt: cutoffDate,
          },
          status: {
            in: [OutboxStatus.COMPLETED, OutboxStatus.DEAD_LETTER],
          },
        },
        data: {
          status: OutboxStatus.COMPLETED, // Mark as completed/archived
          processedAt: new Date(),
          updatedAt: new Date(),
        },
      });

      return result.count;
    } catch (error) {
      throw this.handleError(error, 'archive old events');
    }
  }

  /**
   * Find many outbox events with flexible filtering
   * Uses retry logic for transient database failures (Neon cold starts, pool exhaustion)
   * 
   * @param args - Prisma findMany arguments
   * @returns Array of outbox events
   */
  async findMany(args?: Prisma.OutboxEventFindManyArgs): Promise<OutboxEvent[]> {
    try {
      // Wrap database operation with retry logic for transient failures
      return await this.executeWithRetry(async () => {
        const events = await this.prisma.outboxEvent.findMany(args);
        this.logSuccess('findMany', { count: events.length });
        return events;
      }, 'findMany');
    } catch (error) {
      throw this.handleError(error, 'findMany');
    }
  }

  /**
   * Update outbox event
   * 
   * @param where - Prisma where clause
   * @param data - Update data
   * @returns Updated outbox event
   */
  async update(where: Prisma.OutboxEventWhereUniqueInput, data: Prisma.OutboxEventUpdateInput): Promise<OutboxEvent> {
    try {
      const event = await this.prisma.outboxEvent.update({
        where,
        data,
      });
      this.logSuccess('update', { eventId: event.id });
      return event;
    } catch (error) {
      throw this.handleError(error, 'update');
    }
  }

  /**
   * Find unique outbox event
   * 
   * @param where - Prisma where unique input
   * @returns Outbox event or null
   */
  async findUnique(where: Prisma.OutboxEventWhereUniqueInput): Promise<OutboxEvent | null> {
    try {
      const event = await this.prisma.outboxEvent.findUnique({ where });
      this.logSuccess('findUnique', { found: !!event });
      return event;
    } catch (error) {
      throw this.handleError(error, 'findUnique');
    }
  }

  /**
   * Delete many outbox events
   * 
   * @param where - Prisma where clause
   * @returns Number of deleted events
   */
  async deleteMany(where: Prisma.OutboxEventWhereInput): Promise<number> {
    try {
      const result = await this.prisma.outboxEvent.deleteMany({ where });
      this.logSuccess('deleteMany', { count: result.count });
      return result.count;
    } catch (error) {
      throw this.handleError(error, 'deleteMany');
    }
  }

  /**
   * Count outbox events
   * 
   * @param where - Prisma where clause
   * @returns Count of matching events
   */
  async count(where?: Prisma.OutboxEventWhereInput): Promise<number> {
    try {
      const count = await this.prisma.outboxEvent.count({ where });
      this.logSuccess('count', { count });
      return count;
    } catch (error) {
      throw this.handleError(error, 'count');
    }
  }
}