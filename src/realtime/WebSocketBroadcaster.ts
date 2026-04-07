/**
 * WebSocket Broadcaster Service
 *
 * DI-friendly wrapper around SocketService for emitting real-time events.
 * Provides a clean interface for domain services and outbox processors
 * to broadcast events without tight coupling to Socket.IO internals.
 *
 * Design Principles:
 * - Constructor injection (no getInstance() internally)
 * - Type-safe event emission with Zod validation
 * - Graceful degradation (log errors, don't crash)
 * - Correlation ID preservation for traceability
 *
 * Usage:
 * ```typescript
 * const broadcaster = new WebSocketBroadcaster(socketService, logger);
 * await broadcaster.toUser(userId, createConsumptionEvent(...));
 * ```
 */

import { SocketService } from '../websocket/socket.service';
import { LoggerService } from '../services/logger.service';
import {
  RealtimeEnvelopeV1,
  safeValidateRealtimeEvent,
} from './contracts/events';
import { getErrorMessage, getErrorStack } from '../utils/error-handler';

export class WebSocketBroadcaster {
  // BACKEND FIX #2: Deduplication cache for exactly-once event emission
  // Prevents duplicate WebSocket emissions during failover/retry scenarios
  private readonly dedupeCache = new Map<string, number>(); // eventId -> timestamp
  private readonly DEDUPE_WINDOW_MS = 60_000; // 60 seconds

  constructor(
    private readonly socketService: SocketService,
    private readonly logger: LoggerService,
  ) {
    // Start periodic cleanup of expired deduplication entries
    this.startDedupeCacheCleanup();
  }

  /**
   * Broadcast an event to a specific user's room.
   *
   * The event will be delivered to all connected devices for that user.
   * If SocketService is not initialized or user has no connections, the event is dropped gracefully.
   *
   * @param userId - Target user UUID
   * @param event - Realtime event envelope (validated)
   */
  async toUser(userId: string, event: RealtimeEnvelopeV1 | unknown): Promise<void> {
    try {
      // Validate event structure before emitting
      const validatedEvent = this.validateEvent(event);
      if (!validatedEvent) {
        this.logger.warn('WebSocketBroadcaster: Invalid event structure, skipping emission', {
          context: 'WebSocketBroadcaster.toUser',
          userId,
          rawEvent: event,
        });
        return;
      }

      // BACKEND FIX #3: Tenancy security - double userId validation
      // Prevents cross-user event leakage by ensuring event.userId matches target userId
      if (validatedEvent.userId !== userId) {
        this.logger.error('WebSocketBroadcaster: Tenancy violation - event userId mismatch', {
          context: 'WebSocketBroadcaster.toUser',
          targetUserId: userId,
          eventUserId: validatedEvent.userId,
          eventType: validatedEvent.type,
          entityId: validatedEvent.entityId,
        });
        return;
      }

      // BACKEND FIX #2: Exactly-once emission via deduplication cache
      // Generate deterministic event ID from event content
      const eventId = this.generateEventId(validatedEvent);

      // Check if we've already emitted this event recently
      if (this.isDuplicate(eventId)) {
        this.logger.warn('WebSocketBroadcaster: Duplicate event detected, skipping emission', {
          context: 'WebSocketBroadcaster.toUser',
          userId,
          eventType: validatedEvent.type,
          entityId: validatedEvent.entityId,
          eventId,
        });
        return;
      }

      // Check if SocketService is initialized
      if (!this.socketService.getServer()) {
        this.logger.debug('WebSocketBroadcaster: SocketService not initialized, skipping emission', {
          context: 'WebSocketBroadcaster.toUser',
          userId,
          eventType: validatedEvent.type,
        });
        return;
      }

      // Emit event to user's room (event type becomes the Socket.IO event name)
      this.socketService.emitToUser(userId, validatedEvent.type, validatedEvent);

      // BACKEND FIX #2: Record emission in deduplication cache
      this.recordEmission(eventId);

      this.logger.debug('WebSocketBroadcaster: Event emitted successfully', {
        context: 'WebSocketBroadcaster.toUser',
        userId,
        eventType: validatedEvent.type,
        entityId: validatedEvent.entityId,
        correlationId: validatedEvent.correlationId,
        eventId,
      });
    } catch (error) {
      // WebSocket is a "hint" mechanism; failures should not break core business logic.
      this.logger.error('WebSocketBroadcaster: Failed to emit event', {
        context: 'WebSocketBroadcaster.toUser',
        userId,
        error: getErrorMessage(error),
        stack: getErrorStack(error),
        eventType: typeof event === 'object' && event !== null && 'type' in event
          ? String(event.type)
          : 'unknown',
      });
    }
  }

  /**
   * Broadcast an event to multiple users (batch).
   *
   * @param userIds - Array of user UUIDs
   * @param event - Realtime event envelope
   */
  async toUsers(userIds: string[], event: RealtimeEnvelopeV1 | unknown): Promise<void> {
    const validatedEvent = this.validateEvent(event);
    if (!validatedEvent) {
      this.logger.warn('WebSocketBroadcaster: Invalid event structure for batch emission', {
        context: 'WebSocketBroadcaster.toUsers',
        userCount: userIds.length,
        rawEvent: event,
      });
      return;
    }

    // Emit to each user individually (could be optimized with rooms if needed)
    await Promise.allSettled(
      userIds.map((userId) => this.toUser(userId, validatedEvent)),
    );
  }

  /**
   * Broadcast to a device-specific room (user + device).
   *
   * Useful for device-specific notifications (e.g., Bluetooth connection status).
   *
   * @param userId - User UUID
   * @param deviceId - Device UUID
   * @param event - Realtime event envelope
   */
  async toDevice(userId: string, deviceId: string, event: RealtimeEnvelopeV1 | unknown): Promise<void> {
    try {
      const validatedEvent = this.validateEvent(event);
      if (!validatedEvent) {
        this.logger.warn('WebSocketBroadcaster: Invalid event for device emission', {
          context: 'WebSocketBroadcaster.toDevice',
          userId,
          deviceId,
          rawEvent: event,
        });
        return;
      }

      if (!this.socketService.getServer()) {
        this.logger.debug('WebSocketBroadcaster: SocketService not initialized (device emission)', {
          context: 'WebSocketBroadcaster.toDevice',
          userId,
          deviceId,
        });
        return;
      }

      // Emit to device-specific room
      const roomName = `user:${userId}:device:${deviceId}`;
      this.socketService.getServer()!.to(roomName).emit(validatedEvent.type, validatedEvent);

      this.logger.debug('WebSocketBroadcaster: Event emitted to device', {
        context: 'WebSocketBroadcaster.toDevice',
        userId,
        deviceId,
        eventType: validatedEvent.type,
      });
    } catch (error) {
      this.logger.error('WebSocketBroadcaster: Failed to emit device event', {
        context: 'WebSocketBroadcaster.toDevice',
        userId,
        deviceId,
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
    }
  }

  /**
   * Validates and parses a raw event object.
   * Returns null if invalid (logs error internally).
   *
   * @param event - Raw event object
   * @returns Validated RealtimeEnvelopeV1 or null
   */
  private validateEvent(event: unknown): RealtimeEnvelopeV1 | null {
    try {
      // If already validated, return as-is
      if (this.isValidatedEvent(event)) {
        return event;
      }

      // Validate with Zod
      return safeValidateRealtimeEvent(event);
    } catch (error) {
      this.logger.error('WebSocketBroadcaster: Event validation failed', {
        context: 'WebSocketBroadcaster.validateEvent',
        error: getErrorMessage(error),
        rawEvent: event,
      });
      return null;
    }
  }

  /**
   * Type guard to check if event is already a validated RealtimeEnvelopeV1.
   *
   * @param event - Unknown event
   * @returns True if event has required v1 envelope structure
   */
  private isValidatedEvent(event: unknown): event is RealtimeEnvelopeV1 {
    return (
      typeof event === 'object' &&
      event !== null &&
      'v' in event &&
      event.v === 1 &&
      'type' in event &&
      'entity' in event &&
      'entityId' in event &&
      'userId' in event &&
      'occurredAt' in event
    );
  }

  /**
   * Get current active connection count (for monitoring).
   *
   * @returns Number of active WebSocket connections
   */
  getActiveConnectionCount(): number {
    const server = this.socketService.getServer();
    if (!server) return 0;

    // Socket.IO v4+ uses sockets.size
    return server.sockets.sockets.size;
  }

  /**
   * Get connection count for a specific user.
   *
   * @param userId - User UUID
   * @returns Number of active connections for the user
   */
  async getUserConnectionCount(userId: string): Promise<number> {
    const server = this.socketService.getServer();
    if (!server) return 0;

    const roomName = `user:${userId}`;
    const sockets = await server.in(roomName).fetchSockets();
    return sockets.length;
  }

  /**
   * Check if SocketService is ready to emit events.
   *
   * @returns True if WebSocket server is initialized
   */
  isReady(): boolean {
    return this.socketService.getServer() !== null;
  }

  /**
   * BACKEND FIX #2: Generate deterministic event ID for deduplication
   *
   * Creates a unique ID from event type, entity, and entityId
   * to identify duplicate emissions across failover/retry scenarios.
   *
   * Note: event.type already contains operation info (e.g., "consumption.created")
   *
   * @param event - Validated realtime event
   * @returns Deterministic event ID
   */
  private generateEventId(event: RealtimeEnvelopeV1): string {
    // Use type (includes operation), entity, and entityId to create deterministic ID
    // Type already includes operation: "consumption.created", "session.updated", etc.
    return `${event.type}:${event.entity}:${event.entityId}`;
  }

  /**
   * BACKEND FIX #2: Check if event has already been emitted recently
   *
   * @param eventId - Event ID to check
   * @returns True if event was emitted within deduplication window
   */
  private isDuplicate(eventId: string): boolean {
    const emittedAt = this.dedupeCache.get(eventId);
    if (!emittedAt) return false;

    const now = Date.now();
    const ageMs = now - emittedAt;

    // Event is a duplicate if it was emitted within the deduplication window
    return ageMs < this.DEDUPE_WINDOW_MS;
  }

  /**
   * BACKEND FIX #2: Record event emission in deduplication cache
   *
   * @param eventId - Event ID to record
   */
  private recordEmission(eventId: string): void {
    this.dedupeCache.set(eventId, Date.now());
  }

  /**
   * BACKEND FIX #2: Periodically clean up expired deduplication cache entries
   *
   * Runs every 30 seconds to remove entries older than the deduplication window.
   * Prevents memory leaks from unbounded cache growth.
   */
  private startDedupeCacheCleanup(): void {
    setInterval(() => {
      const now = Date.now();
      let cleanedCount = 0;

      for (const [eventId, emittedAt] of this.dedupeCache.entries()) {
        const ageMs = now - emittedAt;

        if (ageMs >= this.DEDUPE_WINDOW_MS) {
          this.dedupeCache.delete(eventId);
          cleanedCount++;
        }
      }

      if (cleanedCount > 0) {
        this.logger.debug('WebSocketBroadcaster: Cleaned up expired deduplication entries', {
          context: 'WebSocketBroadcaster.startDedupeCacheCleanup',
          cleanedCount,
          remainingCount: this.dedupeCache.size,
        });
      }
    }, 30_000); // Run cleanup every 30 seconds
  }
}
