/**
 * Session Service
 * Handles all consumption session operations with comprehensive error handling
 */

import { Session, Prisma, SessionStatus } from '@prisma/client';
import { RepositoryFactory } from '../repositories/repository.factory';
import { SessionRepository, UpdateSessionInput } from '../repositories/session.repository';
import { ConsumptionRepository } from '../repositories/consumption.repository';
import { ProductRepository } from '../repositories/product.repository';
import { LoggerService, LogCategory, LogLevel } from './logger.service';
import { DeviceTelemetryService } from './deviceTelemetry.service';
import { OutboxService } from './outbox.service';
import { DomainEventService } from '../events/domain-event.service';
import {
  CreateSessionSchema,
  UpdateSessionSchema,
  PaginatedResponse,
  handlePrismaError,
} from '../models';
import { CreateDeviceTelemetrySchema } from '../models/dynamodb-schemas';
import { AppError, ErrorCodes } from '../utils/AppError';
import { getErrorMessage, getErrorStack, isPrismaError } from '../utils/error-handler';
import { retryWithBackoff } from '../utils/retry.util';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import {
  recomputeSessionAggregates,
  SESSION_IDLE_TIMEOUT_MS,
  type ConsumptionInput,
} from '@shared/contracts';

/**
 * Terminal session statuses — COMPLETED and CANCELLED are irrevocable.
 * Once a session enters a terminal state, it cannot transition to any other state.
 *
 * This constant is the single source of truth for terminal-state guards across:
 * - REST API (patchSession, completeSession, pauseSession, resumeSession, cancelSession)
 * - Sync handler (SessionHandler.update, SessionHandler.merge)
 *
 * @see conflict-configs.ts monotonic transitions: ['ACTIVE', 'PAUSED', 'CANCELLED', 'COMPLETED']
 */
export const TERMINAL_SESSION_STATUSES: readonly SessionStatus[] = [
  SessionStatus.COMPLETED,
  SessionStatus.CANCELLED,
] as const;

/**
 * Type guard: returns true if the given status is terminal (COMPLETED or CANCELLED).
 */
export function isTerminalSessionStatus(status: SessionStatus): boolean {
  return (TERMINAL_SESSION_STATUSES as readonly string[]).includes(status);
}

/**
 * Pure function: computes which fields in updateData differ from existingSession.
 * Returns an array of field names that are being changed.
 * Used to populate SessionUpdatedEvent.changes[] for downstream consumers.
 */
function computeChangedFields(
  existingSession: Session,
  updateData: UpdateSessionInput,
): string[] {
  const changes: string[] = [];
  const fieldMap: Array<{ key: keyof UpdateSessionInput; sessionKey: keyof Session }> = [
    { key: 'purchaseId', sessionKey: 'purchaseId' },
    { key: 'deviceId', sessionKey: 'deviceId' },
    { key: 'primaryProductId', sessionKey: 'primaryProductId' },
    { key: 'sessionStartTimestamp', sessionKey: 'sessionStartTimestamp' },
    { key: 'sessionEndTimestamp', sessionKey: 'sessionEndTimestamp' },
    { key: 'eventCount', sessionKey: 'eventCount' },
    { key: 'totalDurationMs', sessionKey: 'totalDurationMs' },
    { key: 'avgEventDurationMs', sessionKey: 'avgEventDurationMs' },
    { key: 'sessionTypeHeuristic', sessionKey: 'sessionTypeHeuristic' },
    { key: 'observationFeature', sessionKey: 'observationFeature' },
    { key: 'notes', sessionKey: 'notes' },
  ];
  for (const { key, sessionKey } of fieldMap) {
    if (updateData[key] !== undefined) {
      // Compare values — Date objects need timestamp comparison
      const newVal = updateData[key];
      const oldVal = existingSession[sessionKey];
      if (newVal instanceof Date && oldVal instanceof Date) {
        if (newVal.getTime() !== oldVal.getTime()) changes.push(key);
      } else if (newVal !== oldVal) {
        changes.push(key);
      }
    }
  }
  return changes;
}

/**
 * Session statistics result interface
 */
export interface SessionStatsResult {
  totalSessions: number;
  totalConsumptions: number;
  totalDurationMs: number;
  averageDurationMs: number;
  averageConsumptionsPerSession: number;
  sessionsByType: Record<string, number>;
  dailyAverage: number;
  longestSessionMs: number;
  shortestSessionMs: number;
  [key: string]: unknown; // Allow additional properties for controller enhancements
}

export class SessionService {
  private initialized: boolean = false;

  /**
   * Constructor with explicit dependency injection (Pure DI - no singleton)
   * All dependencies are required and injected by bootstrap.ts
   */
  public constructor(
    private sessionRepository: SessionRepository,
    private consumptionRepository: ConsumptionRepository,
    private productRepository: ProductRepository,
    private logger: LoggerService,
    private deviceTelemetryService: DeviceTelemetryService,
    private outboxService: OutboxService,
    private domainEventService: DomainEventService,
  ) {
    // Pure constructor injection - all dependencies provided by bootstrap.ts
    if (!sessionRepository || !consumptionRepository || !productRepository || !logger || !deviceTelemetryService || !outboxService || !domainEventService) {
      throw new Error('SessionService: All dependencies must be provided');
    }
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    
    try {
      // Dependencies are already injected via constructor
      // Any async initialization if needed
      this.initialized = true;
      this.logger.info('SessionService initialized successfully', { context: 'SessionService' });
    } catch (error) {
      if (this.logger) {
        this.logger.error('Failed to initialize SessionService', { error: getErrorMessage(error) });
      }
      throw error;
    }
  }

  /**
   * Validate that a product exists and is accessible by the user.
   */
  private async assertProductAccessible(userId: string, productId: string): Promise<void> {
    const product = await this.productRepository.findById(productId, userId);
    if (!product) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        'Invalid primaryProductId: product not found or not accessible',
      );
    }
  }

  /**
   * Create a new consumption session with dual write to PostgreSQL and DynamoDB
   * Includes client deduplication logic using clientSessionId
   */
  public async createSession(
    userId: string,
    data: typeof CreateSessionSchema._type, // Pre-validated by controller
    correlationId?: string,
  ): Promise<Session> {
    try {
      // Note: Input data is already validated by the controller layer
      const now = new Date();

      if (data.primaryProductId) {
        await this.assertProductAccessible(userId, data.primaryProductId);
      }

      // Ensure a clientSessionId is present for deduplication. If not provided by client, generate one.
      const sessionId = data.id || uuidv4();
      const clientSessionIdProvided = !!data.clientSessionId;
      const clientSessionId = data.clientSessionId || uuidv4();

      if (!clientSessionIdProvided) {
        this.logger.warn(
          'DEPRECATION: clientSessionId not provided by client — server generated a substitute UUID. '
          + 'This breaks idempotency on retry. Clients MUST supply clientSessionId in a future version.',
          { userId, sessionId, serverGeneratedKey: clientSessionId, field: 'clientSessionId' },
        );
      }
      
      const sessionStartTime = data.sessionStartTimestamp 
        ? new Date(data.sessionStartTimestamp) 
        : now;

      // Determine status: if end timestamp is provided, it's COMPLETED, otherwise ACTIVE
      const sessionStatus = data.sessionEndTimestamp ? SessionStatus.COMPLETED : SessionStatus.ACTIVE;

      // Use atomic transaction with outbox pattern to handle race conditions and dual-writes
      const eventCorrelationId = correlationId || uuidv4();

      const session = await retryWithBackoff(
        async () => {
          return await this.sessionRepository.createWithOutboxEvent(
            {
              id: sessionId,
              clientSessionId,
              userId,
              sessionStartTimestamp: sessionStartTime,
              sessionEndTimestamp: data.sessionEndTimestamp
                ? new Date(data.sessionEndTimestamp)
                : new Date(sessionStartTime.getTime() + 3600000), // Default 1 hour session
              sessionTypeHeuristic: data.sessionTypeHeuristic,
              purchaseId: data.purchaseId,
              primaryProductId: data.primaryProductId ?? null,
              eventCount: data.eventCount || 0,
              totalDurationMs: data.totalDurationMs || 0,
              status: sessionStatus,
            },
            true, // Close active sessions
            async (tx, sessionRecord) => {
              // Add telemetry event to outbox WITHIN the same transaction
              const telemetryEventData = {
                eventType: 'telemetry',
                aggregateId: sessionRecord.id,
                aggregateType: 'session',
                version: 1,
                data: {
                  deviceId: data.deviceId || 'web-app',
                  timestamp: sessionRecord.sessionStartTimestamp.getTime(),
                  userId: sessionRecord.userId,
                  sessionId: sessionRecord.id,
                  eventType: 'session_start',
                  sessionType: sessionRecord.sessionTypeHeuristic || 'unknown',
                  purchaseId: sessionRecord.purchaseId || '',
                  expectedDurationMs: sessionRecord.sessionEndTimestamp
                    ? sessionRecord.sessionEndTimestamp.getTime() - sessionRecord.sessionStartTimestamp.getTime()
                    : 0,
                },
                metadata: {
                  userId: sessionRecord.userId,
                  timestamp: new Date().toISOString(),
                },
              };

              await this.outboxService.addEvent(tx, {
                aggregateId: sessionRecord.id,
                aggregateType: 'session',
                eventType: 'telemetry',
                payload: telemetryEventData,
              });

              // DURABLE LIFECYCLE EVENT: Emit session.started domain event within the
              // same transaction as the session creation. This enables:
              // 1. WebSocket real-time broadcast to connected clients
              // 2. Future subscriber processing (analytics, activity feed, etc.)
              // The telemetry event above feeds DynamoDB analytics (separate pipeline).
              await this.outboxService.addEvent(tx, {
                aggregateId: sessionRecord.id,
                aggregateType: 'session',
                eventType: 'domain_event',
                payload: {
                  eventType: 'domain_event',
                  aggregateId: sessionRecord.id,
                  aggregateType: 'session',
                  version: 1,
                  data: {
                    domainEventType: 'session.started',
                    sessionId: sessionRecord.id,
                    userId: sessionRecord.userId,
                    purchaseId: sessionRecord.purchaseId || undefined,
                    sessionStartTimestamp: sessionRecord.sessionStartTimestamp,
                    deviceId: data.deviceId || undefined,
                    sessionTypeHeuristic: sessionRecord.sessionTypeHeuristic || undefined,
                    emitOptions: {
                      correlationId: eventCorrelationId,
                      metadata: {
                        source: 'SessionService.createSession',
                        sessionType: sessionRecord.sessionTypeHeuristic,
                      },
                    },
                  },
                  metadata: {
                    userId: sessionRecord.userId,
                    timestamp: new Date().toISOString(),
                  },
                },
              });

              this.logger.debug('Session start telemetry + domain events added to outbox', {
                sessionId: sessionRecord.id,
              });
            },
            // DURABLE LIFECYCLE EVENT: Per-session callback for force-closed active sessions.
            // Computes canonical rolling-window aggregates and emits session.ended outbox event
            // within the same transaction. Without this, closed sessions had no durable events
            // and downstream projections (session-impact, product-impact) were never notified.
            async (tx, closedSession) => {
              // Fetch consumptions for canonical aggregate computation
              const consumptions = await tx.consumption.findMany({
                where: { sessionId: closedSession.id, deletedAt: null },
              });

              const consumptionInputs: ConsumptionInput[] = consumptions.map((c) => ({
                timestamp: c.timestamp.toISOString(),
                durationMs: c.durationMs,
              }));

              const aggregates = recomputeSessionAggregates(
                consumptionInputs,
                closedSession.sessionStartTimestamp.toISOString(),
                closedSession.sessionEndTimestamp?.toISOString() ?? null,
                SESSION_IDLE_TIMEOUT_MS,
              );

              // For sessions with consumptions, use canonical rolling-window end time.
              // For empty sessions, keep the end time already set by the repository.
              const endTime = consumptionInputs.length > 0
                ? new Date(aggregates.sessionEndTimestamp)
                : closedSession.sessionEndTimestamp ?? now;

              // Update with canonical aggregates (the initial close only set status + end time)
              await tx.consumptionSession.update({
                where: { id: closedSession.id },
                data: {
                  sessionEndTimestamp: endTime,
                  totalDurationMs: aggregates.totalDurationMs,
                  eventCount: aggregates.eventCount,
                  avgEventDurationMs: aggregates.avgEventDurationMs,
                },
              });

              // Write durable session.ended domain event — same pattern as completeSession()
              await this.outboxService.addEvent(tx, {
                aggregateId: closedSession.id,
                aggregateType: 'session',
                eventType: 'domain_event',
                payload: {
                  eventType: 'domain_event',
                  aggregateId: closedSession.id,
                  aggregateType: 'session',
                  version: 1,
                  data: {
                    domainEventType: 'session.ended',
                    sessionId: closedSession.id,
                    userId: closedSession.userId,
                    purchaseId: closedSession.purchaseId || undefined,
                    sessionStartTimestamp: closedSession.sessionStartTimestamp,
                    sessionEndTimestamp: endTime,
                    duration: aggregates.totalDurationMs,
                    consumptionCount: aggregates.eventCount,
                    totalDurationMs: aggregates.totalDurationMs,
                    avgEventDurationMs: aggregates.avgEventDurationMs,
                    emitOptions: {
                      correlationId: eventCorrelationId,
                      metadata: {
                        source: 'SessionService.createSession.closePriorActive',
                        sessionType: closedSession.sessionTypeHeuristic,
                      },
                    },
                  },
                  metadata: {
                    userId: closedSession.userId,
                    timestamp: new Date().toISOString(),
                  },
                },
              });

              this.logger.info('Emitted session.ended for force-closed active session', {
                closedSessionId: closedSession.id,
                userId: closedSession.userId,
                eventCount: aggregates.eventCount,
                totalDurationMs: aggregates.totalDurationMs,
              });
            },
          );
        },
        {
          maxAttempts: 3,
          initialDelayMs: 50,
          retryableErrors: ['P2002', 'P2034', 'P2028'], // Handle unique constraint violations and transaction conflicts
        },
      );

      this.logger.info(
        `Session created: ${session.id} for user: ${userId}`,
        { context: 'SessionService', sessionId: session.id, correlationId, userId },
      );

      return session;
    } catch (error: unknown) {
      this.logger.error('Failed to create session', {
        context: 'SessionService',
        userId,
        data,
        error: getErrorMessage(error),
        stack: getErrorStack(error),
        correlationId,
      });

      // Already an AppError - re-throw
      if (error instanceof AppError) throw error;

      // Zod validation errors
      if (error && typeof error === 'object' && 'name' in error && error.name === 'ZodError' && 'errors' in error) {
        throw AppError.validation('Invalid session data', error.errors as Record<string, unknown>);
      }

      // Prisma database errors
      if (isPrismaError(error)) {
        throw handlePrismaError(error);
      }

      // Generic fallback
      throw AppError.internal('Failed to create session');
    }
  }

  /**
   * Get session by ID
   */
  public async getSessionById(
    id: string,
    userId: string,
    correlationId?: string,
    options: { includeRelations?: boolean } = {},
  ): Promise<Session | null> {
    try {
      const session = await this.sessionRepository.findById(
        id,
        userId,
        options.includeRelations === true,
      );

      if (!session) {
        return null;
      }

      if (!session) {
        this.logger.warn(
          `Session not found: ${id}`,
          { sessionId: id, userId, correlationId },
        );
        return null;
      }

      return session;
    } catch (error: unknown) {
      this.logger.error('Failed to get session', {
        context: 'SessionService',
        id,
        userId,
        error: getErrorMessage(error),
        stack: getErrorStack(error),
        correlationId,
      });

      // Already an AppError - re-throw
      if (error instanceof AppError) throw error;

      // Zod validation errors
      if (error && typeof error === 'object' && 'name' in error && error.name === 'ZodError' && 'errors' in error) {
        throw AppError.validation('Invalid data', error.errors as Record<string, unknown>);
      }
      
      // Prisma database errors
      if (isPrismaError(error)) {
        throw handlePrismaError(error);
      }
      
      // Generic fallback
      throw AppError.internal('Failed to get session');
    }
  }

  /**
   * Update an existing session (full update)
   */
  public async updateSession(
    id: string,
    userId: string,
    data: typeof CreateSessionSchema._type, // Pre-validated by controller
    correlationId?: string,
  ): Promise<Session> {
    try {
      // Note: Input data is already validated by the controller layer

      // Check if session exists and belongs to user
      const existingSession = await this.getSessionById(id, userId, correlationId);
      if (!existingSession) {
        throw AppError.notFound('Session not found');
      }

      const updateData: UpdateSessionInput = {};

      // Only update fields that are provided
      if (data.sessionEndTimestamp) {
        updateData.sessionEndTimestamp = new Date(data.sessionEndTimestamp);
      }
      if (data.sessionTypeHeuristic !== undefined) {
        updateData.sessionTypeHeuristic = data.sessionTypeHeuristic || undefined;
      }
      if (data.purchaseId !== undefined) {
        updateData.purchaseId = data.purchaseId || undefined;
      }
      if (data.primaryProductId !== undefined) {
        if (data.primaryProductId !== null) {
          await this.assertProductAccessible(userId, data.primaryProductId);
        }
        updateData.primaryProductId = data.primaryProductId;
      }
      if (data.eventCount !== undefined) {
        updateData.eventCount = data.eventCount;
      }
      if (data.totalDurationMs !== undefined) {
        updateData.totalDurationMs = data.totalDurationMs;
      }

      // Compute which fields are actually changing for the domain event
      const changes = computeChangedFields(existingSession, updateData);

      // TRANSACTIONAL OUTBOX: Session update + session.updated domain event are ATOMIC.
      // If no fields actually changed, skip the outbox event (no-op update).
      const eventCorrelationId = correlationId || uuidv4();

      const session = await this.sessionRepository.updateWithOutboxEvent(
        id,
        userId,
        updateData,
        async (tx, updatedSession) => {
          if (changes.length === 0) return; // No-op: no fields changed, skip event

          await this.outboxService.addEvent(tx, {
            aggregateId: updatedSession.id,
            aggregateType: 'session',
            eventType: 'domain_event',
            payload: {
              eventType: 'domain_event',
              aggregateId: updatedSession.id,
              aggregateType: 'session',
              version: 1,
              data: {
                domainEventType: 'session.updated',
                sessionId: updatedSession.id,
                userId: updatedSession.userId,
                purchaseId: updatedSession.purchaseId || undefined,
                eventCount: updatedSession.eventCount,
                totalDurationMs: updatedSession.totalDurationMs,
                avgEventDurationMs: updatedSession.avgEventDurationMs,
                changes,
                emitOptions: {
                  correlationId: eventCorrelationId,
                  metadata: {
                    source: 'SessionService.updateSession',
                  },
                },
              },
              metadata: {
                userId: updatedSession.userId,
                timestamp: new Date().toISOString(),
              },
            },
          });
        },
      );

      this.logger.info(
        `Session updated: ${id} for user: ${userId}`,
        { context: 'SessionService', sessionId: id, correlationId, userId, changes },
      );

      return session;
    } catch (error: unknown) {
      this.logger.error('Failed to update session', {
        context: 'SessionService',
        sessionId: id,
        userId,
        error: getErrorMessage(error),
        stack: getErrorStack(error),
        correlationId,
      });

      // Already an AppError - re-throw
      if (error instanceof AppError) throw error;

      // Zod validation errors
      if (error && typeof error === 'object' && 'name' in error && error.name === 'ZodError' && 'errors' in error) {
        throw AppError.validation('Invalid update data', error.errors as Record<string, unknown>);
      }

      // Prisma database errors
      if (isPrismaError(error)) {
        throw handlePrismaError(error);
      }

      // Generic fallback
      throw AppError.internal('Failed to update session');
    }
  }

  /**
   * Partially update an existing session (PATCH)
   */
  public async patchSession(
    id: string,
    userId: string,
    data: typeof UpdateSessionSchema._type, // Pre-validated by controller
    correlationId?: string,
  ): Promise<Session> {
    try {
      // Note: Input data is already validated by the controller layer

      // Check if session exists and belongs to user
      const existingSession = await this.getSessionById(id, userId, correlationId);
      if (!existingSession) {
        throw AppError.notFound('Session not found');
      }

      // OPTIMISTIC CONCURRENCY: If caller provides lastKnownUpdatedAt, verify the
      // session hasn't been modified since the caller last read it. This prevents
      // lost updates from concurrent modifications (API clients, sync handler, etc.).
      // Must run BEFORE building updateData to fail-fast on stale reads.
      if (data.lastKnownUpdatedAt !== undefined) {
        const clientUpdatedAt = new Date(data.lastKnownUpdatedAt);
        const serverUpdatedAt = existingSession.updatedAt;
        // Compare at millisecond precision (ISO timestamps may have sub-ms differences)
        if (Math.abs(clientUpdatedAt.getTime() - serverUpdatedAt.getTime()) > 1) {
          throw new AppError(
            409,
            ErrorCodes.CONFLICT,
            'Session has been modified since your last read. ' +
            'Re-fetch the session and retry your update.',
            true,
            {
              sessionId: id,
              clientUpdatedAt: clientUpdatedAt.toISOString(),
              serverUpdatedAt: serverUpdatedAt.toISOString(),
            },
          );
        }
      }

      // Status: BLOCKED in PATCH — all status transitions must go through dedicated
      // lifecycle endpoints that emit proper domain events via transactional outbox:
      //   POST /sessions/:id/complete  → completeSession()
      //   POST /sessions/:id/cancel    → cancelSession()
      //   POST /sessions/:id/pause     → pauseSession()
      //   POST /sessions/:id/resume    → resumeSession()
      //
      // Allowing status changes via PATCH bypasses aggregate recomputation and
      // domain event emission, causing downstream projection data loss.
      // Checked BEFORE building updateData to fail-fast.
      if (data.status !== undefined) {
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          'Status cannot be changed via PATCH. Use dedicated lifecycle endpoints: ' +
          'POST /sessions/:id/complete, POST /sessions/:id/cancel, ' +
          'POST /sessions/:id/pause, POST /sessions/:id/resume',
          true,
          { sessionId: id, requestedStatus: data.status },
        );
      }

      // Build partial update — only include fields that are explicitly provided.
      // Missing fields are NOT updated (PATCH semantics, not PUT).
      // EVERY field accepted by UpdateSessionSchema MUST be mapped here or
      // explicitly rejected above (status) / handled above (lastKnownUpdatedAt).
      const updateData: UpdateSessionInput = {};

      if (data.sessionStartTimestamp !== undefined) {
        updateData.sessionStartTimestamp = new Date(data.sessionStartTimestamp);
      }
      // Handle sessionEndTimestamp: can be string, null, or undefined
      if (data.sessionEndTimestamp !== undefined) {
        updateData.sessionEndTimestamp = data.sessionEndTimestamp
          ? new Date(data.sessionEndTimestamp)
          : null;
      }
      if (data.sessionTypeHeuristic !== undefined) {
        updateData.sessionTypeHeuristic = data.sessionTypeHeuristic || undefined;
      }
      if (data.purchaseId !== undefined) {
        updateData.purchaseId = data.purchaseId || undefined;
      }
      if (data.primaryProductId !== undefined) {
        if (data.primaryProductId !== null) {
          await this.assertProductAccessible(userId, data.primaryProductId);
        }
        updateData.primaryProductId = data.primaryProductId;
      }
      if (data.eventCount !== undefined) {
        updateData.eventCount = data.eventCount;
      }
      if (data.totalDurationMs !== undefined) {
        updateData.totalDurationMs = data.totalDurationMs;
      }
      // Device ID: identifier for the device that recorded this session
      if (data.deviceId !== undefined) {
        updateData.deviceId = data.deviceId;
      }
      // Average hit duration: client-computed or server-recomputed aggregate
      if (data.avgEventDurationMs !== undefined) {
        updateData.avgEventDurationMs = data.avgEventDurationMs ?? undefined;
      }
      // Observation feature: HMM-pipeline observation score (nullable to clear)
      if (data.observationFeature !== undefined) {
        updateData.observationFeature = data.observationFeature;
      }
      // Notes: user-provided session notes (nullable — null clears notes)
      if (data.notes !== undefined) {
        updateData.notes = data.notes;
      }

      // Compute which fields are actually changing for the domain event
      const changes = computeChangedFields(existingSession, updateData);

      // TRANSACTIONAL OUTBOX: Session update + session.updated domain event are ATOMIC.
      // If no fields actually changed, skip the outbox event (no-op update).
      const eventCorrelationId = correlationId || uuidv4();

      const session = await this.sessionRepository.updateWithOutboxEvent(
        id,
        userId,
        updateData,
        async (tx, updatedSession) => {
          if (changes.length === 0) return; // No-op: no fields changed, skip event

          await this.outboxService.addEvent(tx, {
            aggregateId: updatedSession.id,
            aggregateType: 'session',
            eventType: 'domain_event',
            payload: {
              eventType: 'domain_event',
              aggregateId: updatedSession.id,
              aggregateType: 'session',
              version: 1,
              data: {
                domainEventType: 'session.updated',
                sessionId: updatedSession.id,
                userId: updatedSession.userId,
                purchaseId: updatedSession.purchaseId || undefined,
                eventCount: updatedSession.eventCount,
                totalDurationMs: updatedSession.totalDurationMs,
                avgEventDurationMs: updatedSession.avgEventDurationMs,
                changes,
                emitOptions: {
                  correlationId: eventCorrelationId,
                  metadata: {
                    source: 'SessionService.patchSession',
                  },
                },
              },
              metadata: {
                userId: updatedSession.userId,
                timestamp: new Date().toISOString(),
              },
            },
          });
        },
      );

      this.logger.info(
        `Session patched: ${id} for user: ${userId}`,
        { context: 'SessionService', sessionId: id, correlationId, userId, changes },
      );

      return session;
    } catch (error: unknown) {
      this.logger.error('Failed to patch session', {
        context: 'SessionService',
        sessionId: id,
        userId,
        error: getErrorMessage(error),
        stack: getErrorStack(error),
        correlationId,
      });

      // Already an AppError - re-throw
      if (error instanceof AppError) throw error;

      // Zod validation errors
      if (error && typeof error === 'object' && 'name' in error && error.name === 'ZodError' && 'errors' in error) {
        throw AppError.validation('Invalid update data', error.errors as Record<string, unknown>);
      }

      // Prisma database errors
      if (isPrismaError(error)) {
        throw handlePrismaError(error);
      }

      // Generic fallback
      throw AppError.internal('Failed to patch session');
    }
  }

  /**
   * Delete a session
   */
  public async deleteSession(
    id: string,
    userId: string,
    correlationId?: string,
  ): Promise<void> {
    try {
      // Check if session exists and belongs to user
      const existingSession = await this.getSessionById(id, userId, correlationId);
      if (!existingSession) {
        throw AppError.notFound('Session not found');
      }

      // This will cascade delete related consumptions
      await this.sessionRepository.delete(id, userId);

      this.logger.info(
        `Session deleted: ${id} for user: ${userId}`,
        { context: 'SessionService', sessionId: id, correlationId, userId },
      );
    } catch (error: unknown) {
      this.logger.error('Failed to delete session', {
        context: 'SessionService',
        sessionId: id,
        userId,
        error: getErrorMessage(error),
        stack: getErrorStack(error),
        correlationId,
      });
      
      // Already an AppError - re-throw
      if (error instanceof AppError) throw error;
      
      // Zod validation errors
      if (error && typeof error === 'object' && 'name' in error && error.name === 'ZodError' && 'errors' in error) {
        throw AppError.validation('Invalid data', error.errors as Record<string, unknown>);
      }
      
      // Prisma database errors
      if (isPrismaError(error)) {
        throw handlePrismaError(error);
      }
      
      // Generic fallback
      throw AppError.internal('Failed to delete session');
    }
  }

  /**
   * Pause an active session
   *
   * STATE MACHINE GUARD: Only ACTIVE → PAUSED is allowed.
   * COMPLETED and CANCELLED are terminal states and cannot be paused.
   * Already-PAUSED sessions are idempotent (return current state without error).
   *
   * Uses updateWithOutboxEvent for atomic status change + domain event.
   */
  public async pauseSession(
    id: string,
    userId: string,
    correlationId?: string,
  ): Promise<Session> {
    try {
      const session = await this.getSessionById(id, userId, correlationId);
      if (!session) {
        throw AppError.notFound('Session not found');
      }

      // Idempotent: already paused → return as-is
      if (session.status === SessionStatus.PAUSED) {
        this.logger.debug('Session already paused, returning idempotently', {
          context: 'SessionService.pauseSession', sessionId: id, userId,
        });
        return session;
      }

      // State machine guard: only ACTIVE can transition to PAUSED
      if (session.status !== SessionStatus.ACTIVE) {
        throw new AppError(
          409,
          ErrorCodes.CONFLICT,
          `Cannot pause session in '${session.status}' status — only ACTIVE sessions can be paused`,
          true,
          { sessionId: id, currentStatus: session.status },
        );
      }

      const eventCorrelationId = correlationId || uuidv4();

      const pausedSession = await this.sessionRepository.updateWithOutboxEvent(
        id,
        userId,
        { status: SessionStatus.PAUSED },
        async (tx, updatedSession) => {
          await this.outboxService.addEvent(tx, {
            aggregateId: updatedSession.id,
            aggregateType: 'session',
            eventType: 'domain_event',
            payload: {
              eventType: 'domain_event',
              aggregateId: updatedSession.id,
              aggregateType: 'session',
              version: 1,
              data: {
                domainEventType: 'session.paused',
                sessionId: updatedSession.id,
                userId: updatedSession.userId,
                sessionStartTimestamp: updatedSession.sessionStartTimestamp,
                emitOptions: {
                  correlationId: eventCorrelationId,
                  metadata: { source: 'SessionService.pauseSession' },
                },
              },
              metadata: {
                userId: updatedSession.userId,
                timestamp: new Date().toISOString(),
              },
            },
          });
        },
      );

      this.logger.info(`Session paused: ${id} for user: ${userId}`, {
        context: 'SessionService', sessionId: id, correlationId, userId,
      });

      return pausedSession;
    } catch (error: unknown) {
      this.logger.error('Failed to pause session', {
        context: 'SessionService', sessionId: id, userId,
        error: getErrorMessage(error), stack: getErrorStack(error), correlationId,
      });
      if (error instanceof AppError) throw error;
      if (isPrismaError(error)) throw handlePrismaError(error);
      throw AppError.internal('Failed to pause session');
    }
  }

  /**
   * Resume a paused session
   *
   * STATE MACHINE GUARD: Only PAUSED → ACTIVE is allowed.
   * COMPLETED and CANCELLED are terminal states and cannot be resumed.
   * Already-ACTIVE sessions are idempotent (return current state without error).
   *
   * Uses updateWithOutboxEvent for atomic status change + domain event.
   */
  public async resumeSession(
    id: string,
    userId: string,
    correlationId?: string,
  ): Promise<Session> {
    try {
      const session = await this.getSessionById(id, userId, correlationId);
      if (!session) {
        throw AppError.notFound('Session not found');
      }

      // Idempotent: already active → return as-is
      if (session.status === SessionStatus.ACTIVE) {
        this.logger.debug('Session already active, returning idempotently', {
          context: 'SessionService.resumeSession', sessionId: id, userId,
        });
        return session;
      }

      // State machine guard: only PAUSED can transition to ACTIVE (via resume)
      if (session.status !== SessionStatus.PAUSED) {
        throw new AppError(
          409,
          ErrorCodes.CONFLICT,
          `Cannot resume session in '${session.status}' status — only PAUSED sessions can be resumed`,
          true,
          { sessionId: id, currentStatus: session.status },
        );
      }

      const eventCorrelationId = correlationId || uuidv4();

      const resumedSession = await this.sessionRepository.updateWithOutboxEvent(
        id,
        userId,
        { status: SessionStatus.ACTIVE },
        async (tx, updatedSession) => {
          await this.outboxService.addEvent(tx, {
            aggregateId: updatedSession.id,
            aggregateType: 'session',
            eventType: 'domain_event',
            payload: {
              eventType: 'domain_event',
              aggregateId: updatedSession.id,
              aggregateType: 'session',
              version: 1,
              data: {
                domainEventType: 'session.resumed',
                sessionId: updatedSession.id,
                userId: updatedSession.userId,
                sessionStartTimestamp: updatedSession.sessionStartTimestamp,
                emitOptions: {
                  correlationId: eventCorrelationId,
                  metadata: { source: 'SessionService.resumeSession' },
                },
              },
              metadata: {
                userId: updatedSession.userId,
                timestamp: new Date().toISOString(),
              },
            },
          });
        },
      );

      this.logger.info(`Session resumed: ${id} for user: ${userId}`, {
        context: 'SessionService', sessionId: id, correlationId, userId,
      });

      return resumedSession;
    } catch (error: unknown) {
      this.logger.error('Failed to resume session', {
        context: 'SessionService', sessionId: id, userId,
        error: getErrorMessage(error), stack: getErrorStack(error), correlationId,
      });
      if (error instanceof AppError) throw error;
      if (isPrismaError(error)) throw handlePrismaError(error);
      throw AppError.internal('Failed to resume session');
    }
  }

  /**
   * Complete an active session
   */
  public async completeSession(
    id: string,
    userId: string,
    correlationId?: string,
  ): Promise<Session> {
    try {
      const session = await this.getSessionById(id, userId, correlationId);
      if (!session) {
        throw AppError.notFound('Session not found');
      }

      // Idempotent: already completed → return as-is (no duplicate outbox events)
      if (session.status === SessionStatus.COMPLETED) {
        this.logger.debug('Session already completed, returning idempotently', {
          context: 'SessionService.completeSession', sessionId: id, userId,
        });
        return session;
      }

      // State machine guard: CANCELLED is terminal — cannot transition to COMPLETED
      if (session.status === SessionStatus.CANCELLED) {
        throw new AppError(
          409,
          ErrorCodes.CONFLICT,
          `Cannot complete session in '${session.status}' status — CANCELLED sessions are terminal`,
          true,
          { sessionId: id, currentStatus: session.status },
        );
      }

      // FIX: Use the canonical rolling-window aggregate computation (shared module)
      // instead of wall-clock duration (endTime - startTime). Wall-clock duration
      // includes idle time and is inconsistent with consumption-based aggregates
      // used everywhere else (sync handler, batch create, recalculate).
      //
      // For sessions WITH consumptions: totalDurationMs = SUM(consumption.durationMs),
      // sessionEndTimestamp = MAX(consumption.timestamp) + SESSION_IDLE_TIMEOUT_MS.
      //
      // For sessions WITHOUT consumptions: use `now` as end time, 0 for aggregates.
      const consumptions = await this.consumptionRepository.findMany({
        where: { sessionId: id, userId, deletedAt: null },
      });

      const consumptionInputs: ConsumptionInput[] = (consumptions ?? []).map((c) => ({
        timestamp: c.timestamp.toISOString(),
        durationMs: c.durationMs,
      }));

      const aggregates = recomputeSessionAggregates(
        consumptionInputs,
        session.sessionStartTimestamp.toISOString(),
        session.sessionEndTimestamp?.toISOString() ?? null,
        SESSION_IDLE_TIMEOUT_MS,
      );

      // For sessions with no consumptions, cap end time at `now` (don't project
      // 1 hour into the future for an empty session being completed).
      const now = new Date();
      const endTime = consumptionInputs.length > 0
        ? new Date(aggregates.sessionEndTimestamp)
        : now;
      const totalDurationMs = aggregates.totalDurationMs;
      const consumptionCount = aggregates.eventCount;
      const avgEventDurationMs = aggregates.avgEventDurationMs;

      // TRANSACTIONAL OUTBOX: Session update + outbox event write are ATOMIC.
      // If either fails, both roll back — no lost events, no orphan state changes.
      const eventCorrelationId = correlationId || uuidv4();

      const completedSession = await this.sessionRepository.updateWithOutboxEvent(
        id,
        userId,
        {
          sessionEndTimestamp: endTime,
          totalDurationMs,
          avgEventDurationMs,
          eventCount: consumptionCount,
          status: SessionStatus.COMPLETED,
        },
        async (tx, session) => {
          // Write session.ended domain event within the SAME transaction
          await this.outboxService.addEvent(tx, {
            aggregateId: session.id,
            aggregateType: 'session',
            eventType: 'domain_event',
            payload: {
              eventType: 'domain_event',
              aggregateId: session.id,
              aggregateType: 'session',
              version: 1,
              data: {
                domainEventType: 'session.ended',
                sessionId: session.id,
                userId: session.userId,
                purchaseId: session.purchaseId || undefined,
                sessionStartTimestamp: session.sessionStartTimestamp,
                sessionEndTimestamp: endTime,
                duration: totalDurationMs,
                consumptionCount,
                totalDurationMs,
                avgEventDurationMs,
                emitOptions: {
                  correlationId: eventCorrelationId,
                  metadata: {
                    source: 'SessionService.completeSession',
                    sessionType: session.sessionTypeHeuristic,
                  },
                },
              },
              metadata: {
                userId: session.userId,
                timestamp: new Date().toISOString(),
              },
            },
          });
        },
      );

      // --- Write session completion data to DynamoDB (Device Telemetry for real-time tracking) ---
      // OUTSIDE transaction: non-critical, best-effort telemetry write
      try {
        const telemetryRecordData: z.infer<typeof CreateDeviceTelemetrySchema> = {
          deviceId: 'web-app', // Default to web app - in real implementation get from session context
          timestamp: endTime.getTime(), // Unix timestamp in milliseconds
          userId: completedSession.userId,
          sessionId: completedSession.id,
          metrics: {
            eventType: 'session:end',
            sessionType: completedSession.sessionTypeHeuristic || 'unknown',
            actualDurationMs: totalDurationMs,
            eventCount: consumptionCount,
            purchaseId: completedSession.purchaseId || '',
          },
        };

        await this.deviceTelemetryService.recordDeviceTelemetry(
          completedSession.userId,
          telemetryRecordData
        );
        this.logger.debug('Session completion recorded as device telemetry', {
          sessionId: completedSession.id,
        });
      } catch (telemetryError) {
        // Log telemetry error but don't fail the primary operation
        this.logger.error('Failed to write session completion to device telemetry', {
          sessionId: completedSession.id,
          error: getErrorMessage(telemetryError),
        });
      }

      this.logger.info(
        `Session completed: ${id} for user: ${userId}`,
        { context: 'SessionService', sessionId: id, totalDurationMs, correlationId, userId },
      );

      return completedSession;
    } catch (error: unknown) {
      this.logger.error('Failed to complete session', {
        context: 'SessionService',
        sessionId: id,
        userId,
        error: getErrorMessage(error),
        stack: getErrorStack(error),
        correlationId,
      });
      
      // Already an AppError - re-throw
      if (error instanceof AppError) throw error;
      
      // Zod validation errors
      if (error && typeof error === 'object' && 'name' in error && error.name === 'ZodError' && 'errors' in error) {
        throw AppError.validation('Invalid data', error.errors as Record<string, unknown>);
      }
      
      // Prisma database errors
      if (isPrismaError(error)) {
        throw handlePrismaError(error);
      }
      
      // Generic fallback
      throw AppError.internal('Failed to complete session');
    }
  }

  /**
   * Cancel an active or paused session
   *
   * STATE MACHINE GUARD:
   * - ACTIVE → CANCELLED: valid
   * - PAUSED → CANCELLED: valid
   * - CANCELLED → CANCELLED: idempotent (return as-is, no duplicate events)
   * - COMPLETED → CANCELLED: rejected (409 CONFLICT)
   *
   * Like completeSession, this method:
   * 1. Recomputes aggregates from consumptions (canonical data)
   * 2. Writes a durable session.cancelled outbox event atomically
   * 3. Is fully idempotent for already-cancelled sessions
   *
   * Subscribers may use session.cancelled events to exclude cancelled sessions
   * from analytics, achievements, and goal tracking.
   */
  public async cancelSession(
    id: string,
    userId: string,
    correlationId?: string,
  ): Promise<Session> {
    try {
      const session = await this.getSessionById(id, userId, correlationId);
      if (!session) {
        throw AppError.notFound('Session not found');
      }

      // Idempotent: already cancelled → return as-is (no duplicate outbox events)
      if (session.status === SessionStatus.CANCELLED) {
        this.logger.debug('Session already cancelled, returning idempotently', {
          context: 'SessionService.cancelSession', sessionId: id, userId,
        });
        return session;
      }

      // State machine guard: COMPLETED is terminal — cannot transition to CANCELLED
      if (session.status === SessionStatus.COMPLETED) {
        throw new AppError(
          409,
          ErrorCodes.CONFLICT,
          `Cannot cancel session in '${session.status}' status — COMPLETED sessions are terminal`,
          true,
          { sessionId: id, currentStatus: session.status },
        );
      }

      // Recompute aggregates from consumptions (same as completeSession —
      // cancelled sessions should still have accurate aggregate data for auditability)
      const consumptions = await this.consumptionRepository.findMany({
        where: { sessionId: id, userId, deletedAt: null },
      });

      const consumptionInputs: ConsumptionInput[] = (consumptions ?? []).map((c) => ({
        timestamp: c.timestamp.toISOString(),
        durationMs: c.durationMs,
      }));

      const aggregates = recomputeSessionAggregates(
        consumptionInputs,
        session.sessionStartTimestamp.toISOString(),
        session.sessionEndTimestamp?.toISOString() ?? null,
        SESSION_IDLE_TIMEOUT_MS,
      );

      const now = new Date();
      const endTime = consumptionInputs.length > 0
        ? new Date(aggregates.sessionEndTimestamp)
        : now;
      const totalDurationMs = aggregates.totalDurationMs;
      const consumptionCount = aggregates.eventCount;
      const avgEventDurationMs = aggregates.avgEventDurationMs;

      // TRANSACTIONAL OUTBOX: Session update + outbox event write are ATOMIC.
      const eventCorrelationId = correlationId || uuidv4();

      const cancelledSession = await this.sessionRepository.updateWithOutboxEvent(
        id,
        userId,
        {
          sessionEndTimestamp: endTime,
          totalDurationMs,
          avgEventDurationMs,
          eventCount: consumptionCount,
          status: SessionStatus.CANCELLED,
        },
        async (tx, updatedSession) => {
          // Write session.cancelled domain event within the SAME transaction
          await this.outboxService.addEvent(tx, {
            aggregateId: updatedSession.id,
            aggregateType: 'session',
            eventType: 'domain_event',
            payload: {
              eventType: 'domain_event',
              aggregateId: updatedSession.id,
              aggregateType: 'session',
              version: 1,
              data: {
                domainEventType: 'session.cancelled',
                sessionId: updatedSession.id,
                userId: updatedSession.userId,
                purchaseId: updatedSession.purchaseId || undefined,
                sessionStartTimestamp: updatedSession.sessionStartTimestamp,
                sessionEndTimestamp: endTime,
                duration: totalDurationMs,
                consumptionCount,
                totalDurationMs,
                avgEventDurationMs,
                emitOptions: {
                  correlationId: eventCorrelationId,
                  metadata: {
                    source: 'SessionService.cancelSession',
                    sessionType: updatedSession.sessionTypeHeuristic,
                  },
                },
              },
              metadata: {
                userId: updatedSession.userId,
                timestamp: new Date().toISOString(),
              },
            },
          });
        },
      );

      this.logger.info(
        `Session cancelled: ${id} for user: ${userId}`,
        { context: 'SessionService', sessionId: id, totalDurationMs, correlationId, userId },
      );

      return cancelledSession;
    } catch (error: unknown) {
      this.logger.error('Failed to cancel session', {
        context: 'SessionService',
        sessionId: id,
        userId,
        error: getErrorMessage(error),
        stack: getErrorStack(error),
        correlationId,
      });

      if (error instanceof AppError) throw error;

      if (error && typeof error === 'object' && 'name' in error && error.name === 'ZodError' && 'errors' in error) {
        throw AppError.validation('Invalid data', error.errors as Record<string, unknown>);
      }

      if (isPrismaError(error)) {
        throw handlePrismaError(error);
      }

      throw AppError.internal('Failed to cancel session');
    }
  }

  /**
   * Reconcile stale ACTIVE sessions — sessions whose endTimestamp has passed
   * but are still marked ACTIVE. Completes each one durably with outbox events.
   *
   * This is a WRITE operation and MUST NOT be called from read paths (CQRS).
   * Appropriate call sites:
   * - Background reconciliation worker/job
   * - Admin maintenance endpoint
   * - Before creating a new session (handled by createWithOutboxEvent's closeActiveSessions)
   *
   * @param userId - User whose stale sessions should be reconciled
   * @param correlationId - Optional correlation ID for tracing
   * @returns Count of reconciled and failed sessions
   */
  public async reconcileStaleSessions(
    userId: string,
    correlationId?: string,
  ): Promise<{ reconciled: number; failed: number }> {
    const now = new Date();
    let reconciled = 0;
    let failed = 0;

    try {
      // Find ACTIVE sessions with endTimestamp in the past — these are stale
      const staleSessions = await this.sessionRepository.findManyAdmin({
        where: {
          userId,
          status: 'ACTIVE',
          sessionEndTimestamp: { lt: now },
        },
      });

      if (staleSessions.length === 0) {
        return { reconciled: 0, failed: 0 };
      }

      this.logger.info('Reconciling stale sessions', {
        userId,
        staleCount: staleSessions.length,
        staleIds: staleSessions.map((s) => s.id),
        correlationId,
      });

      for (const session of staleSessions) {
        try {
          await this.completeSession(session.id, userId, correlationId);
          reconciled++;
        } catch (error) {
          // Idempotent: already completed (409 for CANCELLED is also acceptable)
          if (error instanceof AppError && (error.statusCode === 409 || error.statusCode === 404)) {
            reconciled++;
          } else {
            this.logger.error('Failed to reconcile stale session', {
              sessionId: session.id,
              userId,
              error: getErrorMessage(error),
            });
            failed++;
          }
        }
      }

      if (reconciled > 0 || failed > 0) {
        this.logger.info('Stale session reconciliation complete', {
          userId, reconciled, failed, correlationId,
        });
      }
    } catch (error) {
      this.logger.error('Stale session reconciliation query failed', {
        userId,
        error: getErrorMessage(error),
        correlationId,
      });
      // Don't throw — reconciliation is best-effort, caller should not fail
    }

    return { reconciled, failed };
  }

  /**
   * Global stale session reconciliation — sweeps ALL users for ACTIVE sessions
   * whose sessionEndTimestamp has passed and durably completes them.
   *
   * Unlike reconcileStaleSessions (per-user), this method finds stale sessions
   * globally and groups by userId for batch processing.
   *
   * IDEMPOTENT: completeSession() is idempotent for already-completed sessions.
   * BOUNDED: Limited by maxUsers and maxSessionsPerUser to prevent runaway queries.
   * BEST-EFFORT: Errors for individual sessions do not fail the entire job.
   *
   * @param maxUsers - Maximum distinct users to process per run
   * @param maxSessionsPerUser - Maximum sessions to reconcile per user
   * @param correlationId - Optional correlation ID for tracing
   * @returns Aggregate counts of reconciled and failed sessions
   */
  public async reconcileStaleSessionsGlobal(
    maxUsers: number = 100,
    maxSessionsPerUser: number = 20,
    correlationId?: string,
  ): Promise<{ reconciled: number; failed: number; usersProcessed: number }> {
    const now = new Date();
    let totalReconciled = 0;
    let totalFailed = 0;
    let usersProcessed = 0;

    try {
      // Single query: find all stale ACTIVE sessions across all users,
      // ordered by user for grouping. PAUSED sessions are also candidates
      // since a paused session with past endTimestamp is effectively stale.
      const staleSessions = await this.sessionRepository.findManyAdmin({
        where: {
          status: { in: ['ACTIVE', 'PAUSED'] },
          sessionEndTimestamp: { lt: now },
        },
        orderBy: { userId: 'asc' },
        take: maxUsers * maxSessionsPerUser, // Upper bound
      });

      if (staleSessions.length === 0) {
        this.logger.debug('No stale sessions found globally', {
          context: 'SessionService.reconcileStaleSessionsGlobal',
          correlationId,
        });
        return { reconciled: 0, failed: 0, usersProcessed: 0 };
      }

      this.logger.info('Global stale session reconciliation starting', {
        context: 'SessionService.reconcileStaleSessionsGlobal',
        totalStale: staleSessions.length,
        correlationId,
      });

      // Group by userId — we process per-user to respect maxSessionsPerUser
      const byUser = new Map<string, typeof staleSessions>();
      for (const session of staleSessions) {
        const existing = byUser.get(session.userId);
        if (!existing) {
          if (byUser.size >= maxUsers) break; // Respect maxUsers cap
          byUser.set(session.userId, [session]);
        } else if (existing.length < maxSessionsPerUser) {
          existing.push(session);
        }
      }

      for (const [userId, userSessions] of byUser) {
        usersProcessed++;
        for (const session of userSessions) {
          try {
            await this.completeSession(session.id, userId, correlationId);
            totalReconciled++;
          } catch (error) {
            // Idempotent: already completed/cancelled is success
            if (error instanceof AppError && (error.statusCode === 409 || error.statusCode === 404)) {
              totalReconciled++;
            } else {
              this.logger.error('Failed to reconcile stale session in global sweep', {
                sessionId: session.id,
                userId,
                error: getErrorMessage(error),
              });
              totalFailed++;
            }
          }
        }
      }

      this.logger.info('Global stale session reconciliation complete', {
        context: 'SessionService.reconcileStaleSessionsGlobal',
        totalReconciled,
        totalFailed,
        usersProcessed,
        correlationId,
      });
    } catch (error) {
      this.logger.error('Global stale session reconciliation query failed', {
        context: 'SessionService.reconcileStaleSessionsGlobal',
        error: getErrorMessage(error),
        correlationId,
      });
      // Don't throw — reconciliation is best-effort
    }

    return { reconciled: totalReconciled, failed: totalFailed, usersProcessed };
  }

  /**
   * Get active sessions for a user
   */
  public async getActiveSessions(
    userId: string,
    correlationId?: string,
  ): Promise<Session[]> {
    try {
      const now = new Date();
      
      const sessionsResult = await this.sessionRepository.findActiveSession(userId);
      
      if (!sessionsResult || sessionsResult === null) {
        return [];
      }

      // Proactive cleanup: If session's projected end time is in the past,
      // it's stale but still ACTIVE in the DB. Repository findActiveSession()
      // includes recently-expired sessions (within 1h grace window) specifically
      // so this cleanup path can detect and durably complete them.
      //
      // completeSession() emits a durable session.ended domain event via outbox,
      // which is critical for downstream projections (session-impact, product-impact).
      if (sessionsResult.sessionEndTimestamp && sessionsResult.sessionEndTimestamp < now) {
        this.logger.info('Durably auto-completing stale session during getActiveSessions', {
          userId, sessionId: sessionsResult.id, correlationId,
          expiredAt: sessionsResult.sessionEndTimestamp.toISOString(),
        });

        try {
          await this.completeSession(sessionsResult.id, userId, correlationId);
        } catch (e) {
          // Log at error level — this means the session remains ACTIVE.
          // Version conflict is benign (concurrent sync already completed it).
          this.logger.error('Failed to auto-complete stale session in getActiveSessions', {
            sessionId: sessionsResult.id,
            error: getErrorMessage(e),
            note: 'Session may have been completed by concurrent sync (benign race)',
          });
        }
        return [];
      }
      
      // findActiveSession returns a single session or null, not an array
      return sessionsResult ? [sessionsResult] : [];
    } catch (error: unknown) {
      this.logger.error('Failed to get active sessions', {
        context: 'SessionService',
        userId,
        error: getErrorMessage(error),
        stack: getErrorStack(error),
        correlationId,
      });
      
      // Already an AppError - re-throw
      if (error instanceof AppError) throw error;
      
      // Zod validation errors
      if (error && typeof error === 'object' && 'name' in error && error.name === 'ZodError' && 'errors' in error) {
        throw AppError.validation('Invalid data', error.errors as Record<string, unknown>);
      }
      
      // Prisma database errors
      if (isPrismaError(error)) {
        throw handlePrismaError(error);
      }
      
      // Generic fallback
      throw AppError.internal('Failed to get active sessions');
    }
  }

  /**
   * Get session statistics for a user
   */
  public async getSessionStats(
    userId: string,
    options: {
      startDate?: Date;
      endDate?: Date;
    } = {},
    correlationId?: string,
  ): Promise<SessionStatsResult> {
    try {
      const where: Prisma.SessionWhereInput = { userId };

      if (options.startDate || options.endDate) {
        where.sessionStartTimestamp = {};
        if (options.startDate) where.sessionStartTimestamp.gte = options.startDate;
        if (options.endDate) where.sessionStartTimestamp.lte = options.endDate;
      }

      const [sessions, consumptions] = await Promise.all([
        this.sessionRepository.findManyAdmin({
          where,
          take: 1000, // Limit to prevent unbounded queries
          include: {
            consumptions: true,
            purchase: true,
          },
        }),
        this.consumptionRepository.findMany({
          where: { userId, sessionId: { not: null } },
          take: 5000, // Limit to prevent unbounded queries
        }),
      ]);

      // Calculate statistics
      const totalSessions = sessions.length;
      const totalConsumptions = consumptions.length;
      const totalDuration = sessions.reduce((sum, s) => sum + s.totalDurationMs, 0);
      const avgDuration = totalSessions > 0 ? totalDuration / totalSessions : 0;
      const avgConsumptionsPerSession = totalSessions > 0 ? totalConsumptions / totalSessions : 0;

      // Group sessions by type
      const sessionsByType: { [key: string]: number } = {};
      sessions.forEach(s => {
        const type = s.sessionTypeHeuristic || 'unknown';
        sessionsByType[type] = (sessionsByType[type] || 0) + 1;
      });

      // Calculate daily averages
      const daysCovered = options.startDate && options.endDate
        ? Math.ceil((options.endDate.getTime() - options.startDate.getTime()) / (1000 * 60 * 60 * 24))
        : 30; // Default to 30 days

      const dailyAverage = totalSessions / daysCovered;

      return {
        totalSessions,
        totalConsumptions,
        totalDurationMs: totalDuration,
        averageDurationMs: avgDuration,
        averageConsumptionsPerSession: avgConsumptionsPerSession,
        sessionsByType,
        dailyAverage,
        longestSessionMs: sessions.reduce((max, s) => Math.max(max, s.totalDurationMs), 0),
        shortestSessionMs: sessions.reduce((min, s) => s.totalDurationMs > 0 ? Math.min(min, s.totalDurationMs) : min, Infinity),
      };
    } catch (error: unknown) {
      this.logger.error('Failed to get session stats', {
        context: 'SessionService',
        userId,
        error: getErrorMessage(error),
        stack: getErrorStack(error),
        correlationId,
      });
      
      // Already an AppError - re-throw
      if (error instanceof AppError) throw error;
      
      // Zod validation errors
      if (error && typeof error === 'object' && 'name' in error && error.name === 'ZodError' && 'errors' in error) {
        throw AppError.validation('Invalid data', error.errors as Record<string, unknown>);
      }
      
      // Prisma database errors
      if (isPrismaError(error)) {
        throw handlePrismaError(error);
      }
      
      // Generic fallback
      throw AppError.internal('Failed to get session stats');
    }
  }

  /**
   * List sessions with pagination and filters
   */
  public async listSessions(
    userId: string,
    options: {
      page?: number;
      pageSize?: number;
      limit?: number;
      offset?: number;
      startDate?: Date;
      endDate?: Date;
      sessionType?: string;
      purchaseId?: string;
      status?: SessionStatus;
      includeRelations?: boolean;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
    },
    correlationId?: string,
  ): Promise<PaginatedResponse<Session>> {
    try {
      const { 
        page, 
        pageSize,
        limit,
        offset,
        startDate, 
        endDate, 
        sessionType,
        purchaseId,
        status,
        includeRelations,
        sortBy = 'sessionStartTimestamp',
        sortOrder = 'desc',
      } = options;

      const where: Prisma.SessionWhereInput = { userId };

      if (startDate || endDate) {
        where.sessionStartTimestamp = {};
        if (startDate) where.sessionStartTimestamp.gte = startDate;
        if (endDate) where.sessionStartTimestamp.lte = endDate;
      }

      if (sessionType) where.sessionTypeHeuristic = sessionType;
      if (purchaseId) where.purchaseId = purchaseId;
      if (status) where.status = status;

      // Handle dual pagination patterns
      let take = limit || pageSize || 20;
      let skip = offset !== undefined ? offset : (page && pageSize ? (page - 1) * pageSize : 0);

      // Map API sortBy fields to database fields if necessary
      const orderByField = sortBy === 'startTime' ? 'sessionStartTimestamp' : sortBy;

      const [items, total] = await Promise.all([
        this.sessionRepository.findManyAdmin({
          where,
          skip,
          take,
          orderBy: { [orderByField]: sortOrder },
          include: {
            purchase: true,
            ...(includeRelations ? {
              primaryProduct: true,
              sessionProducts: {
                include: { product: true },
              },
              consumptions: {
                include: { product: true },
              },
            } : {
              consumptions: {
                take: 10,
              },
            }),
          },
        }),
        this.sessionRepository.countAdmin(where),
      ]);

      // NOTE: Stale session reconciliation was previously performed here inline
      // (auto-completing ACTIVE sessions with past endTimestamp). This violated CQRS:
      // a READ operation had WRITE side effects, masked failures (response was mutated
      // to COMPLETED even when DB write failed), and added latency to every list call.
      //
      // Stale sessions are now reconciled via:
      // 1. createSession() — force-closes all active sessions with durable events
      // 2. reconcileStaleSessions() — standalone method for background/admin use
      //
      // The read path returns actual DB state without mutation.

      const effectivePageSize = take;
      const effectivePage = Math.floor(skip / take) + 1;
      const totalPages = Math.ceil(total / effectivePageSize);

      return {
        items,
        total,
        page: effectivePage,
        pageSize: effectivePageSize,
        hasMore: skip + items.length < total,
        totalPages,
      };
    } catch (error: unknown) {
      this.logger.error('Failed to list sessions', {
        context: 'SessionService',
        userId,
        options,
        error: getErrorMessage(error),
        stack: getErrorStack(error),
        correlationId,
      });
      
      // Already an AppError - re-throw
      if (error instanceof AppError) throw error;
      
      // Zod validation errors
      if (error && typeof error === 'object' && 'name' in error && error.name === 'ZodError' && 'errors' in error) {
        throw AppError.validation('Invalid data', error.errors as Record<string, unknown>);
      }
      
      // Prisma database errors
      if (isPrismaError(error)) {
        throw handlePrismaError(error);
      }
      
      // Generic fallback
      throw AppError.internal('Failed to list sessions');
    }
  }

  /**
   * Close active sessions for a user
   */
  private async closeActiveSessions(
    userId: string,
    correlationId?: string,
  ): Promise<void> {
    try {
      const now = new Date();
      
      // Find sessions that should still be active
      const activeSessions = await this.sessionRepository.findManyAdmin({
        where: {
          userId,
          sessionEndTimestamp: { gte: now },
        },
        take: 100, // Reasonable limit for active sessions
      });

      // Update them to end now
      for (const session of activeSessions) {
        const totalDurationMs = now.getTime() - session.sessionStartTimestamp.getTime();
        
        await this.sessionRepository.update(session.id, userId, {
          sessionEndTimestamp: now,
          totalDurationMs,
        });

        this.logger.info(
          `Auto-closed active session: ${session.id}`,
          { sessionId: session.id, userId, correlationId },
        );
      }
    } catch (error) {
      this.logger.error(
        'Failed to close active sessions',
        { userId, error: getErrorMessage(error), correlationId },
      );
      // Don't throw - this is a cleanup operation
    }
  }

}
