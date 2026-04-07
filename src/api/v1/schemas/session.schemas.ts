/**
 * Session Validation Schemas
 * Defines validation rules for session-related endpoints
 */

import { z } from 'zod';
import { uuid, timestamp, paginationQuery, numberQuery, enums } from './validation-utils';

// Session status enum - use centralized enum aligned with Prisma SessionStatus
const SessionStatus = enums.SessionStatus;

// Social-Session Sub-Schemas (RESERVED FOR FUTURE USE)
// These schemas define validation for planned social-session features.
// They are NOT currently wired into any active route schema because the
// underlying Prisma model (Session) does not have corresponding
// columns. When social-session features are implemented:
// 1. Add columns to Prisma schema
// 2. Add fields to CreateSessionSchema / UpdateSessionSchema (models/index.ts)
// 3. Re-add these sub-schemas to startSessionSchema / updateSessionSchema

// Location schema (prefixed _ : reserved for future social-session features)
const _locationSchema = z.object({
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  name: z.string().max(200).optional(),
  address: z.string().max(500).optional(),
  type: z.enum(['home', 'friend', 'retailer', 'outdoor', 'event', 'other']).optional(),
});

// Participant schema (prefixed _ : reserved for future social-session features)
const _participantSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(100),
  role: z.enum(['host', 'participant', 'observer']).optional(),
  joinedAt: timestamp().optional(), // Standardized to use timestamp() helper
});

// Session goals schema (prefixed _ : reserved for future social-session features)
const _sessionGoalsSchema = z.object({
  targetConsumption: z.number().positive().optional(),
  targetDuration: z.number().positive().optional(),
  targetEffects: z.array(z.string()).optional(),
  avoidEffects: z.array(z.string()).optional(),
  notes: z.string().max(500).optional(),
});

// Start session schema
// The controller re-validates with CreateSessionSchema (from models/index.ts) which
// expects machine fields (sessionStartTimestamp, clientSessionId, status, etc.).
// If the middleware strips those fields, controller validation ALWAYS fails with 400.
// .passthrough() preserves all fields, letting the controller's own Zod schema
// perform the authoritative validation.
//
// REMOVED (2026-02-08): name, participants, location, goals, isPrivate, tags were
// defined here but NOT in CreateSessionSchema (models/index.ts) or the Prisma
// Session model — they were silently stripped during controller validation.
// When social-session features are implemented, add corresponding Prisma columns
// and model schema fields FIRST, then re-add route validation here.
const startSessionSchema = z.object({
  body: z.object({
    plannedDuration: z.number().positive().max(1440).optional(), // Max 24 hours in minutes
  }).passthrough(),
});

// Update session schema
// NOTE: .passthrough() preserves machine fields (status, sessionEndTimestamp, etc.)
// that the controller re-validates with UpdateSessionSchema from models/index.ts.
// See startSessionSchema comment for rationale.
//
// IMPORTANT: Defined fields MUST match the authoritative model schema's nullability.
// .passthrough() only passes through UNKNOWN keys — defined keys are validated here.
// If a defined field rejects null but the model schema accepts it, clients get a
// spurious 400 from middleware (e.g., sending { notes: null } to clear notes).
//
// REMOVED (2026-02-08): name, participants, location, goals, tags were defined here
// but NOT in UpdateSessionSchema (models/index.ts) or the Prisma Session
// model — they were silently stripped during controller validation.
// When social-session features are implemented, add corresponding Prisma columns
// and model schema fields FIRST, then re-add route validation here.
const updateSessionSchema = z.object({
  body: z.object({
    notes: z.string().max(2000).nullable().optional(), // nullable: clients send null to clear notes
  }).passthrough(),
  params: z.object({
    id: uuid('session ID'),
  }),
});

// End session schema
const endSessionSchema = z.object({
  body: z.object({
    summary: z.object({
      highlights: z.array(z.string()).optional(),
      lowlights: z.array(z.string()).optional(),
      learnings: z.array(z.string()).optional(),
    }).optional(),
    rating: z.number().min(0).max(5).optional(),
    notes: z.string().max(2000).optional(),
    wouldRepeat: z.boolean().optional(),
  }),
  params: z.object({
    id: uuid('session ID'),
  }),
});

// List sessions query schema
const listSessionsSchema = z.object({
  query: z.object({
    ...paginationQuery(),
    status: SessionStatus.optional(),
    startDate: timestamp().optional(),
    endDate: timestamp().optional(),
    sessionType: z.string().optional(),
    purchaseId: uuid('purchase ID').optional(),
    hasParticipants: z.string().transform(val => val === 'true').optional(),
    minRating: numberQuery(0, 5).optional(),
    sortBy: z.enum(['startTime', 'duration', 'rating', 'consumptions']).optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
    includeRelations: z.string().transform(val => val === 'true').optional(),
    include: z.string().optional(),
  }),
});

// Get session by ID schema
const getSessionSchema = z.object({
  params: z.object({
    id: uuid('session ID'),
  }),
  query: z.object({
    includeConsumptions: z.string().transform(val => val === 'true').optional(),
    includeParticipants: z.string().transform(val => val === 'true').optional(),
    includeStats: z.string().transform(val => val === 'true').optional(),
    includeRelations: z.string().transform(val => val === 'true').optional(),
    include: z.string().optional(),
  }),
});

// Add participant schema
const addParticipantSchema = z.object({
  body: z.object({
    participantId: z.string().optional(),
    name: z.string().min(1).max(100),
    role: z.enum(['host', 'participant', 'observer']).optional(),
    email: z.string().email().optional(),
    phone: z.string().max(20).optional(),
  }),
  params: z.object({
    id: uuid('session ID'),
  }),
});

// Session stats query schema
const sessionStatsSchema = z.object({
  query: z.object({
    period: z.enum(['day', 'week', 'month', 'quarter', 'year', 'all']).optional(),
    startDate: timestamp().optional(),
    endDate: timestamp().optional(),
    groupBy: z.enum(['day', 'week', 'month', 'dayOfWeek', 'hour']).optional(),
    includeComparisons: z.string().transform(val => val === 'true').optional(),
  }),
});

// Share session schema
const shareSessionSchema = z.object({
  body: z.object({
    recipientIds: z.array(z.string()).min(1).max(10).optional(),
    emails: z.array(z.string().email()).min(1).max(10).optional(),
    message: z.string().max(500).optional(),
    expiresIn: z.number().positive().max(2592000).optional(), // Max 30 days in seconds
    allowComments: z.boolean().optional(),
    allowJoin: z.boolean().optional(),
  }),
  params: z.object({
    id: uuid('session ID'),
  }),
});

// Join session schema
const joinSessionSchema = z.object({
  body: z.object({
    token: z.string().optional(),
    participantName: z.string().min(1).max(100),
    role: z.enum(['participant', 'observer']).optional(),
  }),
  params: z.object({
    id: uuid('session ID'),
  }),
});

// Live update schema (for WebSocket events)
const liveUpdateSchema = z.object({
  body: z.object({
    type: z.enum(['consumption', 'participant', 'mood', 'note', 'photo']),
    // Data: polymorphic payload based on update type
    // Use z.unknown() instead of z.any() for type safety - requires type guards based on 'type' field
    data: z.unknown(),
    timestamp: timestamp().optional(), // Standardized to use timestamp() helper
  }),
  params: z.object({
    id: uuid('session ID'),
  }),
});

// Update session observations schema (for HMM pipeline)
const updateSessionObservationsSchema = z.object({
  body: z.object({
    sessionUpdates: z.array(z.object({
      sessionId: uuid('session ID'),
      observationFeature: z.number().nullable().optional(),
      sessionTypeHeuristic: z.string().nullable().optional(),
      // Metadata: HMM-specific data (e.g., state probabilities, model version)
      // Use z.unknown() instead of z.any() for type safety - requires explicit type guards when accessing
      metadata: z.record(z.unknown()).optional(),
    })).min(1).max(100),
  }),
});

// Prune old sessions schema
const pruneOldSessionsSchema = z.object({
  body: z.object({
    keepCount: z.number().int().min(1).max(10000).optional(),
  }),
});

// Session telemetry query schema
const sessionTelemetrySchema = z.object({
  params: z.object({
    id: uuid('session ID'),
  }),
  query: z.object({
    /** Window size in minutes before/after session (default: 60) */
    windowMinutes: z.string().transform(val => parseInt(val, 10)).device(z.number().int().min(15).max(180)).optional(),
    /** Resolution: '1m' for 1-minute buckets, '5m' for 5-minute buckets (auto-selected if omitted) */
    resolution: z.enum(['1m', '5m']).optional(),
    /**
     * Specific metrics to compute/return (comma-separated).
     * If omitted, defaults to SESSION_TELEMETRY_DEFAULT_METRICS.
     * Use 'all' to include both default and secondary metrics.
     * Example: 'heart_rate,blood_oxygen' or 'all'
     */
    metricCodes: z.string().optional(),
    /**
     * Force inline recomputation on cache miss (default: false).
     *
     * Without force=true, a cache miss returns 202 'computing' immediately
     * and triggers async background compute. Client should retry after Retry-After.
     *
     * With force=true, the request blocks on inline compute (bounded by timeout).
     * Use sparingly — intended for dev tools and explicit user-triggered refreshes.
     */
    force: z.string().transform(val => val === 'true').optional(),
  }),
});

// Pause session schema
// Body is intentionally empty — the frontend sends {} and the server
// derives all state changes from the current session status.
const pauseSessionSchema = z.object({
  params: z.object({
    id: uuid('session ID'),
  }),
  body: z.object({}).passthrough(), // Accept empty body, passthrough for forward-compat
});

// Resume session schema
// Same contract as pause — empty body, server derives state changes.
const resumeSessionSchema = z.object({
  params: z.object({
    id: uuid('session ID'),
  }),
  body: z.object({}).passthrough(),
});

// Cancel session schema
// Same contract as pause/resume — empty body, server derives state changes.
const cancelSessionSchema = z.object({
  params: z.object({
    id: uuid('session ID'),
  }),
  body: z.object({}).passthrough(),
});

// Export all schemas
export const sessionSchemas = {
  start: startSessionSchema,
  update: updateSessionSchema,
  end: endSessionSchema,
  list: listSessionsSchema,
  get: getSessionSchema,
  addParticipant: addParticipantSchema,
  stats: sessionStatsSchema,
  share: shareSessionSchema,
  join: joinSessionSchema,
  liveUpdate: liveUpdateSchema,
  updateObservations: updateSessionObservationsSchema,
  pruneOld: pruneOldSessionsSchema,
  telemetry: sessionTelemetrySchema,
  pause: pauseSessionSchema,
  resume: resumeSessionSchema,
  cancel: cancelSessionSchema,
};

// Export individual schemas for direct use
export {
  startSessionSchema,
  updateSessionSchema,
  endSessionSchema,
  listSessionsSchema,
  getSessionSchema,
  addParticipantSchema,
  sessionStatsSchema,
  shareSessionSchema,
  joinSessionSchema,
  liveUpdateSchema,
  updateSessionObservationsSchema,
  pruneOldSessionsSchema,
  sessionTelemetrySchema,
  pauseSessionSchema,
  resumeSessionSchema,
  cancelSessionSchema,
  SessionStatus,
};

// Type exports
export type StartSessionInput = z.infer<typeof startSessionSchema>['body'];
export type UpdateSessionInput = z.infer<typeof updateSessionSchema>['body'];
export type EndSessionInput = z.infer<typeof endSessionSchema>['body'];
export type ListSessionsQuery = z.infer<typeof listSessionsSchema>['query'];
export type GetSessionQuery = z.infer<typeof getSessionSchema>['query'];
export type AddParticipantInput = z.infer<typeof addParticipantSchema>['body'];
export type SessionStatsQuery = z.infer<typeof sessionStatsSchema>['query'];
export type ShareSessionInput = z.infer<typeof shareSessionSchema>['body'];
export type JoinSessionInput = z.infer<typeof joinSessionSchema>['body'];
export type LiveUpdateInput = z.infer<typeof liveUpdateSchema>['body'];
export type UpdateSessionObservationsInput = z.infer<typeof updateSessionObservationsSchema>['body'];
export type PruneOldSessionsInput = z.infer<typeof pruneOldSessionsSchema>['body'];
export type SessionTelemetryQuery = z.infer<typeof sessionTelemetrySchema>['query'];