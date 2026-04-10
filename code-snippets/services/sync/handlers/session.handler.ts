/**
 * Session Sync Handler
 *
 * Implements SyncEntityHandler for Session entities.
 * Handles session-specific sync operations including creation, updates,
 * deletion, conflict resolution, and data validation.
 *
 * **ARCHITECTURE:**
 * - Pure constructor injection (SessionRepository dependency)
 * - Transactional operations using Prisma.TransactionClient
 * - Zod validation for type-safe data transformation
 * - Idempotency via clientSessionId unique constraint
 *
 * @see SyncEntityHandler interface
 */

import { Session, Prisma } from '@prisma/client';
import { SyncEntityHandler } from '../sync.types';
import { SessionRepository } from '../../../repositories/session.repository';
import { ConsumptionRepository } from '../../../repositories/consumption.repository';
import { OutboxService } from '../../outbox.service';
import { AppError, ErrorCodes } from '../../../utils/AppError';
import { CreateSessionSchema, UpdateSessionSchema } from '../../../models';
import { LoggerService } from '../../logger.service';
import { isTerminalSessionStatus } from '../../session.service';
import { v4 as uuidv4 } from 'uuid';
import { SESSION_IDLE_TIMEOUT_MS } from '@shared/contracts';

function resolveInitialSessionEndTimestamp(
  sessionStartTimestamp: string,
  sessionEndTimestamp?: string | null,
): Date {
  if (sessionEndTimestamp) {
    return new Date(sessionEndTimestamp);
  }

  // Preserve ACTIVE-session cleanup guarantees:
  // sessionEndTimestamp is the rolling-window boundary (start + idle timeout).
  const start = new Date(sessionStartTimestamp);
  return new Date(start.getTime() + SESSION_IDLE_TIMEOUT_MS);
}

/**
 * Session-specific synchronization handler
 *
 * 1. Validates Prisma.JsonValue → CreateSessionInput/UpdateSessionInput via Zod
 * 2. Uses clientSessionId for idempotency (returns existing if duplicate)
 * 3. Optimistic locking via version field
 * 4. Merge strategy preserves server-derived aggregates (consumption-based)
 */
export class SessionHandler implements SyncEntityHandler<Session> {
  /**
   *  MODERN DI PATTERN: Constructor Injection
   *
   * @param sessionRepository - Session repository for database operations
   * @param logger - Logger service for audit trail
   */
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly consumptionRepository: ConsumptionRepository,
    private readonly logger: LoggerService,
    private readonly outboxService?: OutboxService,
  ) {}

  /**
   * Create session within transaction context
   *
   * **IDEMPOTENCY:** Returns existing session if clientSessionId matches
   *
   * @param userId - User ID for authorization
   * @param entityId - Entity ID (server-assigned or client-provided)
   * @param changeData - Raw sync change data
   * @param tx - Transaction client for atomicity
   * @returns Created or existing session
   */
  async create(
    userId: string,
    entityId: string,
    changeData: Prisma.JsonValue,
    tx: Prisma.TransactionClient,
  ): Promise<Session> {
    try {
      // STEP 1: Validate and transform JsonValue → CreateSessionInput
      const parseResult = CreateSessionSchema.safeParse(changeData);
      if (!parseResult.success) {
        this.logger.error('Session sync data validation failed', {
          context: 'SessionHandler.create',
          userId,
          entityId,
          errors: parseResult.error.flatten().fieldErrors,
        });
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          'Invalid session data for sync creation',
          true,
          { validationErrors: parseResult.error.flatten().fieldErrors },
        );
      }

      const sessionData = parseResult.data;
      const resolvedStatus = sessionData.status ?? 'ACTIVE';
      const initialEndTimestamp = resolveInitialSessionEndTimestamp(
        sessionData.sessionStartTimestamp,
        sessionData.sessionEndTimestamp,
      );

      // STEP 2: Transform Zod-validated data (string dates) to repository input (Date objects)
      const repositoryInput = {
        id: entityId, // Use provided entity ID from sync
        userId,
        clientSessionId: sessionData.clientSessionId,
        deviceId: sessionData.deviceId,
        purchaseId: sessionData.purchaseId,
        // FIX: Preserve primaryProductId from sync create data (user-assignable field).
        // recalculateSessionAggregates() below will override if consumptions exist.
        primaryProductId: sessionData.primaryProductId ?? null,
        sessionStartTimestamp: new Date(sessionData.sessionStartTimestamp),
        sessionEndTimestamp: initialEndTimestamp,
        eventCount: 0,
        totalDurationMs: 0,
        avgEventDurationMs: 0,
        sessionTypeHeuristic: sessionData.sessionTypeHeuristic,
        observationFeature: sessionData.observationFeature,
        status: resolvedStatus,
        // User-provided notes (synced from local-first app)
        notes: sessionData.notes ?? null,
      };

      // STEP 3: Call repository method with transaction context
      // Repository handles idempotency checking via clientSessionId and version initialization
      const session = await this.sessionRepository.create(repositoryInput, tx);
      const recomputed = await this.consumptionRepository.recalculateSessionAggregates(
        tx,
        session.id,
        userId,
      );

      this.logger.info('Session created via sync', {
        context: 'SessionHandler.create',
        userId,
        sessionId: session.id,
        clientSessionId: session.clientSessionId,
      });

      return recomputed ?? session;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Failed to create session via sync', {
        context: 'SessionHandler.create',
        userId,
        entityId,
        error: err.message,
        stack: err.stack,
      });

      throw new AppError(
        500,
        ErrorCodes.DATABASE_ERROR,
        'Failed to create session during synchronization',
        true,
        { originalError: err.message },
      );
    }
  }

  /**
   * Update session within transaction context (with upsert support)
   *
   * **UPSERT PATTERN:** If session doesn't exist on server but update data contains
   * required fields (sessionStartTimestamp), create the session. This handles the
   * case where a session was created locally but never synced before updates arrived.
   *
   * **OPTIMISTIC LOCKING:** Uses version field to prevent concurrent update conflicts
   *
   * @param userId - User ID for authorization
   * @param entityId - Session ID to update (or create if not exists)
   * @param changeData - Raw sync change data
   * @param tx - Transaction client for atomicity
   * @returns Updated or created session
   */
  async update(
    userId: string,
    entityId: string,
    changeData: Prisma.JsonValue,
    tx: Prisma.TransactionClient,
  ): Promise<Session> {
    try {
      // STEP 1: Validate and transform JsonValue → UpdateSessionInput
      const parseResult = UpdateSessionSchema.safeParse(changeData);
      if (!parseResult.success) {
        this.logger.error('Session update data validation failed', {
          context: 'SessionHandler.update',
          userId,
          entityId,
          errors: parseResult.error.flatten().fieldErrors,
        });
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          'Invalid session data for sync update',
          true,
          { validationErrors: parseResult.error.flatten().fieldErrors },
        );
      }

      const updateData = parseResult.data;

      // STEP 2: Check if session exists on server
      const existingSession = await this.sessionRepository.findById(entityId, userId, false, tx);

      // STEP 3A: Session exists - perform normal update
      if (existingSession) {
        // Transform Zod-validated data (string dates) to repository input (Date objects)
        // Terminal-state guard: COMPLETED and CANCELLED are irrevocable.
        // If the server session is in a terminal state, the client cannot change it.
        // This is consistent with the REST API (session.service.ts) and the shared
        // monotonic transition config (conflict-configs.ts: ACTIVE < PAUSED < CANCELLED < COMPLETED).
        const resolvedStatus = isTerminalSessionStatus(existingSession.status as any)
          ? existingSession.status
          : updateData.status ?? existingSession.status;

        // Server-derived aggregates (eventCount, durations, timestamps) are recomputed
        // from consumptions — ignore client-provided values for these fields.
        //
        // WHY sessionEndTimestamp is dropped (INTENTIONAL):
        // The client sends a rolling-window sessionEndTimestamp (sessionStart + 1h idle
        // timeout), which is a UX heuristic for "is the session still active?". The
        // server recomputes authoritative timestamps from actual consumption records
        // via recalculateSessionAggregates() below:
        //   - sessionStartTimestamp = MIN(consumption.timestamp)
        //   - sessionEndTimestamp = MAX(consumption.timestamp) + IDLE_TIMEOUT
        //   - Zero-consumption case: preserves initial timestamps until consumptions arrive
        //
        // See: packages/shared/src/sync-config/session-window.ts for rolling-window semantics
        // See: consumption.repository.ts recalculateSessionAggregates() for recompute logic
        //
        // NOTE: primaryProductId is NOT server-derived — it's user-assignable.
        // recalculateSessionAggregates() will override it if consumptions exist,
        // but we must preserve the client value for sessions without consumptions.
        const {
          eventCount: _ignoredEventCount,
          totalDurationMs: _ignoredTotalDuration,
          avgEventDurationMs: _ignoredAvgHitDuration,
          sessionStartTimestamp: _ignoredSessionStart,
          sessionEndTimestamp: _ignoredSessionEnd,
          status: _ignoredStatus,
          ...updateWithoutDerived
        } = updateData;

        const repositoryInput = {
          ...updateWithoutDerived,
          status: resolvedStatus,
          // FIX: Preserve primaryProductId from sync updates.
          // It was incorrectly dropped as "server-derived" but it's user-assignable.
          // recalculateSessionAggregates() below will override with consumption-based
          // primary product if consumptions exist — this just ensures the initial
          // user-assigned value isn't lost for sessions without consumptions.
          ...(updateData.primaryProductId !== undefined && {
            primaryProductId: updateData.primaryProductId,
          }),
          lastKnownUpdatedAt: updateData.lastKnownUpdatedAt
            ? new Date(updateData.lastKnownUpdatedAt)
            : undefined,
        };

        const session = await this.sessionRepository.update(entityId, userId, repositoryInput, tx);
        const recomputed = await this.consumptionRepository.recalculateSessionAggregates(
          tx,
          session.id,
          userId,
        );
        const finalSession = recomputed ?? session;

        // Emit durable lifecycle events when transitioning from non-terminal states.
        // - ACTIVE/PAUSED -> COMPLETED emits session.ended
        // - ACTIVE/PAUSED -> CANCELLED emits session.cancelled
        if (!isTerminalSessionStatus(existingSession.status as any) && this.outboxService) {
          try {
            if (resolvedStatus === 'COMPLETED') {
              await this.outboxService.addEvent(tx, {
                aggregateId: finalSession.id,
                aggregateType: 'session',
                eventType: 'domain_event',
                payload: {
                  eventType: 'domain_event',
                  aggregateId: finalSession.id,
                  aggregateType: 'session',
                  version: 1,
                  data: {
                    domainEventType: 'session.ended',
                    sessionId: finalSession.id,
                    userId: finalSession.userId,
                    purchaseId: finalSession.purchaseId || undefined,
                    sessionStartTimestamp: finalSession.sessionStartTimestamp,
                    sessionEndTimestamp: finalSession.sessionEndTimestamp,
                    duration: finalSession.totalDurationMs ?? 0,
                    consumptionCount: finalSession.eventCount ?? 0,
                    totalDurationMs: finalSession.totalDurationMs ?? 0,
                    avgEventDurationMs: finalSession.avgEventDurationMs ?? 0,
                    emitOptions: {
                      correlationId: uuidv4(),
                      metadata: {
                        source: 'SessionHandler.update (sync)',
                        sessionType: finalSession.sessionTypeHeuristic,
                      },
                    },
                  },
                  metadata: {
                    userId: finalSession.userId,
                    timestamp: new Date().toISOString(),
                  },
                },
              });
              this.logger.info('session.ended outbox event written during sync status transition', {
                context: 'SessionHandler.update',
                userId,
                sessionId: finalSession.id,
                previousStatus: existingSession.status,
                newStatus: resolvedStatus,
              });
            } else if (resolvedStatus === 'CANCELLED') {
              await this.outboxService.addEvent(tx, {
                aggregateId: finalSession.id,
                aggregateType: 'session',
                eventType: 'domain_event',
                payload: {
                  eventType: 'domain_event',
                  aggregateId: finalSession.id,
                  aggregateType: 'session',
                  version: 1,
                  data: {
                    domainEventType: 'session.cancelled',
                    sessionId: finalSession.id,
                    userId: finalSession.userId,
                    purchaseId: finalSession.purchaseId || undefined,
                    sessionStartTimestamp: finalSession.sessionStartTimestamp,
                    sessionEndTimestamp: finalSession.sessionEndTimestamp,
                    duration: finalSession.totalDurationMs ?? 0,
                    consumptionCount: finalSession.eventCount ?? 0,
                    totalDurationMs: finalSession.totalDurationMs ?? 0,
                    avgEventDurationMs: finalSession.avgEventDurationMs ?? 0,
                    emitOptions: {
                      correlationId: uuidv4(),
                      metadata: {
                        source: 'SessionHandler.update (sync)',
                        sessionType: finalSession.sessionTypeHeuristic,
                      },
                    },
                  },
                  metadata: {
                    userId: finalSession.userId,
                    timestamp: new Date().toISOString(),
                  },
                },
              });
              this.logger.info('session.cancelled outbox event written during sync status transition', {
                context: 'SessionHandler.update',
                userId,
                sessionId: finalSession.id,
                previousStatus: existingSession.status,
                newStatus: resolvedStatus,
              });
            }
          } catch (outboxError) {
            // Log at ERROR — this is within the same tx, so if it fails, the entire update fails.
            this.logger.error('Failed to write session lifecycle outbox event during sync — transaction will rollback', {
              context: 'SessionHandler.update',
              userId,
              sessionId: finalSession.id,
              error: outboxError instanceof Error ? outboxError.message : String(outboxError),
            });
            throw outboxError; // Let the transaction fail — data integrity > silent loss
          }
        }

        this.logger.info('Session updated via sync', {
          context: 'SessionHandler.update',
          userId,
          sessionId: finalSession.id,
          newVersion: finalSession.version,
        });

        return finalSession;
      }

      // STEP 3B: Session doesn't exist - attempt upsert (create if we have required data)
      // This handles the case where session was created locally but never synced
      this.logger.warn('Session not found for update, attempting upsert', {
        context: 'SessionHandler.update',
        userId,
        entityId,
        hasSessionStartTimestamp: !!updateData.sessionStartTimestamp,
      });

      // Check if we have the required field for creation
      if (!updateData.sessionStartTimestamp) {
        // Cannot create session without sessionStartTimestamp
        throw new AppError(
          404,
          ErrorCodes.NOT_FOUND,
          'Session not found and cannot be created: missing sessionStartTimestamp. ' +
          'Ensure the CREATE sync operation is processed before UPDATE.',
          true,
          {
            entityId,
            userId,
            missingRequiredFields: ['sessionStartTimestamp'],
            hint: 'The session may have been created locally but its CREATE command was not synced before this UPDATE.',
          },
        );
      }

      // We have enough data to create the session - construct CreateSessionInput
      const resolvedStatus = updateData.status ?? 'ACTIVE';
      const initialEndTimestamp = resolveInitialSessionEndTimestamp(
        updateData.sessionStartTimestamp,
        updateData.sessionEndTimestamp,
      );
      const createInput = {
        id: entityId,
        userId,
        deviceId: updateData.deviceId ?? undefined,
        purchaseId: updateData.purchaseId ?? undefined,
        // FIX: Preserve primaryProductId from sync data instead of hardcoding null.
        // If the client set a primary product, it should survive the upsert-create path.
        primaryProductId: updateData.primaryProductId ?? null,
        sessionStartTimestamp: new Date(updateData.sessionStartTimestamp),
        sessionEndTimestamp: initialEndTimestamp,
        eventCount: 0,
        totalDurationMs: 0,
        avgEventDurationMs: 0,
        sessionTypeHeuristic: updateData.sessionTypeHeuristic ?? undefined,
        observationFeature: updateData.observationFeature ?? undefined,
        status: resolvedStatus,
        // User-provided notes (synced from local-first app)
        notes: updateData.notes ?? null,
      };

      // Create the session via repository
      const session = await this.sessionRepository.create(createInput, tx);
      const recomputed = await this.consumptionRepository.recalculateSessionAggregates(
        tx,
        session.id,
        userId,
      );

      this.logger.info('Session created via sync upsert (was UPDATE for non-existent session)', {
        context: 'SessionHandler.update',
        userId,
        sessionId: session.id,
        version: session.version,
        upsertReason: 'session_not_found_on_server',
      });

      return recomputed ?? session;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      // Check for optimistic locking conflict (Prisma P2025: Record not found)
      const err = error instanceof Error ? error : new Error(String(error));
      if (err.message.includes('P2025')) {
        throw new AppError(
          409,
          ErrorCodes.CONFLICT,
          'Session version conflict - concurrent modification detected',
          true,
          { entityId, userId },
        );
      }

      this.logger.error('Failed to update session via sync', {
        context: 'SessionHandler.update',
        userId,
        entityId,
        error: err.message,
        stack: err.stack,
      });

      throw new AppError(
        500,
        ErrorCodes.DATABASE_ERROR,
        'Failed to update session during synchronization',
        true,
        { originalError: err.message },
      );
    }
  }

  /**
   * Delete session within transaction context
   *
   * @param userId - User ID for authorization
   * @param entityId - Session ID to delete
   * @param tx - Transaction client for atomicity
   * @returns Deleted session (for audit logging)
   */
  async delete(
    userId: string,
    entityId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Session> {
    try {
      // Call repository method with transaction
      // Repository handles ownership verification and deletion
      const session = await this.sessionRepository.delete(entityId, userId, tx);

      this.logger.info('Session deleted via sync', {
        context: 'SessionHandler.delete',
        userId,
        sessionId: session.id,
      });

      return session;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Failed to delete session via sync', {
        context: 'SessionHandler.delete',
        userId,
        entityId,
        error: err.message,
        stack: err.stack,
      });

      throw new AppError(
        500,
        ErrorCodes.DATABASE_ERROR,
        'Failed to delete session during synchronization',
        true,
        { originalError: err.message },
      );
    }
  }

  /**
   * Fetch current server version for conflict detection
   *
   *
   * @param userId - User ID for authorization
   * @param entityId - Session ID to fetch
   * @param tx - Transaction client for consistency
   * @returns Current server session or null
   */
  async fetchServerVersion(
    userId: string,
    entityId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Session | null> {
    try {
      // Call repository method with transaction
      // Repository handles user authorization check
      const session = await this.sessionRepository.findById(entityId, userId, false, tx);

      return session;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Failed to fetch server session version', {
        context: 'SessionHandler.fetchServerVersion',
        userId,
        entityId,
        error: err.message,
      });

      throw new AppError(
        500,
        ErrorCodes.DATABASE_ERROR,
        'Failed to fetch session for conflict detection',
        true,
        { originalError: err.message },
      );
    }
  }

  /**
   * Validate raw change data before processing
   *
   * @param changeData - Raw sync change data
   * @returns true if valid for session creation/update
   */
  validate(changeData: Prisma.JsonValue): boolean {
    // Try validating as either create or update schema
    const createValid = CreateSessionSchema.safeParse(changeData).success;
    const updateValid = UpdateSessionSchema.safeParse(changeData).success;

    return createValid || updateValid;
  }

  /**
   * Merge conflicting client and server session data
   *
   * **STRATEGY: Server-Derived Aggregates with Version Increment**
   * - Client data applies only to non-derived fields
   * - Server-derived aggregates (eventCount, durations, timestamps) are preserved
   * - Session status is monotonic (COMPLETED is irreversible)
   * - Server version incremented
   * - Timestamp updated to reflect merge
   *
   * @param serverData - Current server session state
   * @param clientData - Client's proposed changes
   * @returns Merged session data (partial update)
   */
  merge(serverData: Session, clientData: Prisma.JsonValue): Partial<Session> {
    try {
      // Validate client data first
      const parseResult = UpdateSessionSchema.safeParse(clientData);
      if (!parseResult.success) {
        this.logger.warn('Invalid client data during merge, using server data', {
          context: 'SessionHandler.merge',
          sessionId: serverData.id,
          userId: serverData.userId,
        });
        // Return server data unchanged if client data is invalid
        return {
          version: serverData.version + 1, // Still increment version to mark as processed
          updatedAt: new Date(),
        };
      }

      const clientUpdate = parseResult.data;

      // Last-write-wins: Client data overrides server (with type conversions)
      // Convert schema types (strings) to entity types (Date)
      // Terminal-state guard: COMPLETED and CANCELLED are irrevocable in merge.
      // Consistent with update() path and REST API terminal-state policy.
      const resolvedStatus = isTerminalSessionStatus(serverData.status as any)
        ? serverData.status
        : clientUpdate.status ?? serverData.status;

      const merged: Partial<Session> = {
        // Only include fields that are present in client update
        ...(clientUpdate.purchaseId !== undefined && { purchaseId: clientUpdate.purchaseId }),
        ...(clientUpdate.deviceId !== undefined && { deviceId: clientUpdate.deviceId }),
        ...(clientUpdate.lastKnownUpdatedAt && {
          lastKnownUpdatedAt: new Date(clientUpdate.lastKnownUpdatedAt),
        }),
        ...(clientUpdate.sessionTypeHeuristic !== undefined && { sessionTypeHeuristic: clientUpdate.sessionTypeHeuristic }),
        ...(clientUpdate.observationFeature !== undefined && { observationFeature: clientUpdate.observationFeature }),
        ...(clientUpdate.notes !== undefined && { notes: clientUpdate.notes }),
        ...(resolvedStatus && { status: resolvedStatus }),
        version: serverData.version + 1,
        updatedAt: new Date(), // Update timestamp to reflect merge
      } as Partial<Session>;

      this.logger.info('Session data merged for conflict resolution', {
        context: 'SessionHandler.merge',
        sessionId: serverData.id,
        userId: serverData.userId,
        oldVersion: serverData.version,
        newVersion: merged.version,
      });

      return merged;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Error during session merge, using server data', {
        context: 'SessionHandler.merge',
        sessionId: serverData.id,
        error: err.message,
      });

      // Fallback: Return server data with incremented version
      return {
        version: serverData.version + 1,
        updatedAt: new Date(),
      };
    }
  }
}
