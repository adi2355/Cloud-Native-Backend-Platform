/**
 * Real-time Event Contracts
 *
 * Defines versioned WebSocket event schemas for real-time client updates.
 * Events are **hints/notifications**, not authoritative data.
 * Cursor pull sync ensures correctness; WebSocket enables instant UX.
 *
 * Design Principles:
 * - Minimal payloads (IDs and timestamps only, no PHI)
 * - Versioned envelopes for evolution (v1, v2, etc.)
 * - Strict Zod validation to prevent malformed events
 * - Correlation IDs for end-to-end traceability
 *
 * @see https://martinfowler.com/articles/patterns-of-distributed-systems/change-data-capture.html
 */

import { z } from 'zod';

// Event Types Enum

/**
 * All supported real-time event types.
 * Must match domain event types from DomainEventService.
 */
export const RealtimeEventType = z.enum([
  // Session events
  'session.created',
  'session.updated',
  'session.completed',
  'session.cancelled',
  'session.paused',
  'session.resumed',

  // User events
  'user.updated',
  'user.preferences.updated',

  // Sync events (system-level)
  'sync.conflict.detected',
  'sync.completed',
]);

export type RealtimeEventType = z.infer<typeof RealtimeEventType>;

// Entity Types Enum

/**
 * Entity types for cache invalidation targeting.
 */
export const EntityType = z.enum([
  'Session',
  'User',
  'Device',
]);

export type EntityType = z.infer<typeof EntityType>;

// Base Event Envelope (Version 1)

/**
 * Version 1 event envelope.
 * All WebSocket events MUST conform to this structure.
 *
 * Fields:
 * - v: Version number for schema evolution
 * - type: Event type (e.g., 'consumption.created')
 * - entity: Entity type for cache key targeting
 * - entityId: Server UUID of the affected entity
 * - userId: Owner of the entity (for routing to correct user rooms)
 * - occurredAt: ISO timestamp from server clock (source of truth)
 * - correlationId: Optional ID linking HTTP request → Outbox → WebSocket
 * - data: Optional minimal projection (use sparingly, avoid PHI)
 */
export const RealtimeEnvelopeV1 = z.object({
  v: z.literal(1),
  type: RealtimeEventType,
  entity: EntityType,
  entityId: z.string().uuid(),
  userId: z.string().uuid(),
  occurredAt: z.string().datetime(), // ISO 8601
  correlationId: z.string().optional(),
  data: z.record(z.any()).optional(), // Minimal projection, validated separately
});

export type RealtimeEnvelopeV1 = z.infer<typeof RealtimeEnvelopeV1>;

// Event-Specific Projections (Minimal Data)

/**
 * Consumption event projection (minimal).
 * Only includes fields safe for WebSocket and useful for cache patching.
 */
/**
 * Session event projection (minimal).
 */
export const SessionProjection = z.object({
  id: z.string().uuid(),
  status: z.enum(['active', 'paused', 'completed', 'cancelled', 'archived']),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
});

export type SessionProjection = z.infer<typeof SessionProjection>;

/**
 * User event projection (minimal).
 * Only metadata, no email or name.
 */
export const UserProjection = z.object({
  id: z.string().uuid(),
  updatedAt: z.string().datetime(),
  preferencesUpdated: z.boolean().optional(),
});

export type UserProjection = z.infer<typeof UserProjection>;

// Event Factory Helpers

/**
 * Creates a Version 1 envelope for consumption events.
 *
 * ENHANCED: Accepts flexible data payload (full entity or minimal projection).
 * Frontend determines validity via Zod validation (ConsumptionResponseSchema).
 *
 * @param type - Event type (created/updated/deleted)
 * @param entityId - Consumption UUID
 * @param userId - User UUID
 * @param correlationId - Optional correlation ID
 * @param data - Optional entity data (can be full entity, partial update, or minimal projection)
 * @returns Validated RealtimeEnvelopeV1
 */
/**
 * Creates a Version 1 envelope for session events.
 */
export function createSessionEvent(
  type: Extract<RealtimeEventType, 'session.created' | 'session.updated' | 'session.completed' | 'session.cancelled' | 'session.paused' | 'session.resumed'>,
  entityId: string,
  userId: string,
  correlationId?: string,
  projection?: Partial<SessionProjection>
): RealtimeEnvelopeV1 {
  const envelope: RealtimeEnvelopeV1 = {
    v: 1,
    type,
    entity: 'Session',
    entityId,
    userId,
    occurredAt: new Date().toISOString(),
    correlationId,
    data: projection,
  };

  return RealtimeEnvelopeV1.parse(envelope);
}

/**
 * Creates a Version 1 envelope for user events.
 */
export function createUserEvent(
  type: Extract<RealtimeEventType, 'user.updated' | 'user.preferences.updated'>,
  entityId: string,
  userId: string,
  correlationId?: string,
  projection?: Partial<UserProjection>
): RealtimeEnvelopeV1 {
  const envelope: RealtimeEnvelopeV1 = {
    v: 1,
    type,
    entity: 'User',
    entityId,
    userId,
    occurredAt: new Date().toISOString(),
    correlationId,
    data: projection,
  };

  return RealtimeEnvelopeV1.parse(envelope);
}

/**
 * Creates a Version 1 envelope for achievement events.
 */
export function createAchievementEvent(
  entityId: string,
  userId: string,
  correlationId?: string,
  projection?: Partial<AchievementProjection>
): RealtimeEnvelopeV1 {
  const envelope: RealtimeEnvelopeV1 = {
    v: 1,
    type: 'achievement.unlocked',
    entity: 'Achievement',
    entityId,
    userId,
    occurredAt: new Date().toISOString(),
    correlationId,
    data: projection,
  };

  return RealtimeEnvelopeV1.parse(envelope);
}

// Validation Helpers

/**
 * Validates a raw object against RealtimeEnvelopeV1 schema.
 * Throws ZodError if invalid.
 *
 * @param raw - Unknown object from WebSocket/Outbox
 * @returns Validated RealtimeEnvelopeV1
 */
export function validateRealtimeEvent(raw: unknown): RealtimeEnvelopeV1 {
  return RealtimeEnvelopeV1.parse(raw);
}

/**
 * Safe validation (returns null on error instead of throwing).
 *
 * @param raw - Unknown object
 * @returns RealtimeEnvelopeV1 or null if invalid
 */
export function safeValidateRealtimeEvent(raw: unknown): RealtimeEnvelopeV1 | null {
  const result = RealtimeEnvelopeV1.safeParse(raw);
  return result.success ? result.data : null;
}
