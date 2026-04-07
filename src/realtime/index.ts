/**
 * Real-time Module - Barrel Export
 *
 * Centralized exports for WebSocket-based real-time communication.
 */

// Core service
export { WebSocketBroadcaster } from './WebSocketBroadcaster';

// Event contracts & types (Zod schemas and factory functions)
export {
  // Zod Schemas
  RealtimeEnvelopeV1,
  RealtimeEventType,
  EntityType,
  SessionProjection,
  UserProjection,

  // Factory helpers
  createSessionEvent,
  createUserEvent,

  // Validation helpers
  validateRealtimeEvent,
  safeValidateRealtimeEvent,
} from './contracts/events';

// Type-only exports (aliases for convenience)
export type {
  RealtimeEnvelopeV1 as RealtimeEvent,
  RealtimeEventType as EventType,
  EntityType as EntityKind,
} from './contracts/events';
