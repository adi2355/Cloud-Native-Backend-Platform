/**
 * Sync Validation Schemas
 * Defines validation rules for synchronization endpoints
 *
 * CANONICAL ENTITY TYPES: All entity type validation uses ENTITY_TYPES
 * from @shared/contracts as the single source of truth. This eliminates
 * drift between frontend and backend validation.
 *
 * @see packages/shared/src/sync-config/entity-types.ts
 */

import { z } from 'zod';
import { timestamp, numberQuery } from './validation-utils';
import { ENTITY_TYPES, SyncLeaseRequestSchema } from '@shared/contracts';

// ENTITY TYPE VALIDATION (Single Source of Truth from Shared Contracts)

/**
 * Canonical entity type schema derived from shared contracts.
 *
 * Do NOT hardcode entity types here - they will drift from the canonical source.
 *
 * The spread operator converts the readonly tuple to a mutable tuple
 * required by Zod's z.enum() signature.
 */
const SyncableEntityType = z.enum([...ENTITY_TYPES] as [string, ...string[]]);

// Sync operation types
const OperationType = z.enum(['create', 'update', 'delete']);

// Conflict resolution strategies
const ResolutionStrategy = z.enum(['client', 'server', 'merge', 'custom']);

// Change record schema
const changeRecordSchema = z.object({
  id: z.string().uuid(),
  entity: SyncableEntityType,
  entityId: z.string().uuid(),
  operation: OperationType,
  // Data: entity-specific change payload - structure varies by entity type
  // Use z.unknown() instead of z.any() for type safety - requires entity-specific validation
  data: z.unknown(),
  timestamp: timestamp(), // Standardized to use timestamp() helper
  version: z.number().int().positive().optional(),
  checksum: z.string().optional(),
});

// Push sync schema
const pushSyncSchema = z.object({
  body: z.object({
    lastSyncTimestamp: timestamp().optional(), // Standardized to use timestamp() helper
    changes: z.array(changeRecordSchema).max(1000, 'Too many changes in single push'),
    deviceId: z.string().max(100),
    clientVersion: z.string().max(20).optional(),
    metadata: z.object({
      platform: z.enum(['ios', 'android', 'web']).optional(),
      appVersion: z.string().optional(),
      timezone: z.string().optional(),
    }).optional(),
  }),
});

// Pull sync schema
const pullSyncSchema = z.object({
  query: z.object({
    lastSyncTimestamp: timestamp().optional(), // Standardized to use timestamp() helper
    deviceId: z.string().max(100).optional(),
    entities: z.string().optional(), // Comma-separated entity types
    limit: numberQuery(1, 1000).optional(),
    includeDeleted: z.string().transform(val => val === 'true').optional(),
  }),
});

// Full sync schema
const fullSyncSchema = z.object({
  body: z.object({
    lastSyncTimestamp: timestamp().optional(), // Standardized to use timestamp() helper
    changes: z.array(changeRecordSchema).max(1000).optional(),
    deviceId: z.string().max(100),
    checksum: z.string().optional(),
    forceOverwrite: z.boolean().optional(),
  }),
});

// Sync status schema
const syncStatusSchema = z.object({
  query: z.object({
    deviceId: z.string().max(100).optional(),
    includeMetrics: z.string().transform(val => val === 'true').optional(),
  }),
});

// Sync health schema (lightweight status for UI indicators)
const syncHealthSchema = z.object({
  query: z.object({
    deviceId: z.string().max(100).optional(),
  }),
});

// Resolve conflict schema
const resolveConflictSchema = z.object({
  body: z.object({
    resolution: ResolutionStrategy,
    // Data: resolution-specific payload (e.g., merged data for 'merge' strategy)
    // Use z.unknown() instead of z.any() for type safety - requires strategy-specific validation
    data: z.unknown().optional(),
    reason: z.string().max(500).optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid conflict ID'),
  }),
});

// Get conflicts schema
const getConflictsSchema = z.object({
  query: z.object({
    status: z.enum(['pending', 'resolved', 'ignored']).optional(),
    entity: SyncableEntityType.optional(),
    limit: numberQuery(1, 100).optional(),
    offset: numberQuery(0).optional(),
  }),
});

// Reset sync schema
const resetSyncSchema = z.object({
  body: z.object({
    deviceId: z.string().max(100).optional(),
    entities: z.array(SyncableEntityType).optional(),
    force: z.boolean(),
    clearConflicts: z.boolean().optional(),
    reason: z.string().max(500).optional(),
  }),
});

// Export data schema
const exportDataSchema = z.object({
  query: z.object({
    format: z.enum(['json', 'csv', 'sqlite']).optional(),
    entities: z.string().optional(), // Comma-separated entity types
    compress: z.string().transform(val => val === 'true').optional(),
    includeMetadata: z.string().transform(val => val === 'true').optional(),
    startDate: timestamp().optional(), // Standardized to use timestamp() helper
    endDate: timestamp().optional(), // Standardized to use timestamp() helper
  }),
});

// Import data schema
const importDataSchema = z.object({
  body: z.object({
    // Data: import payload - structure validated based on format (JSON, CSV, SQLite)
    // Use z.unknown() instead of z.any() for type safety - requires format-specific validation
    data: z.unknown(),
    format: z.enum(['json', 'csv', 'sqlite']).optional(),
    merge: z.boolean().optional(),
    validate: z.boolean().optional(),
    overwriteExisting: z.boolean().optional(),
    dryRun: z.boolean().optional(),
  }),
});

// Sync history schema
const syncHistorySchema = z.object({
  query: z.object({
    deviceId: z.string().max(100).optional(),
    limit: numberQuery(1, 100).optional(),
    offset: numberQuery(0).optional(),
    startDate: timestamp().optional(), // Standardized to use timestamp() helper
    endDate: timestamp().optional(), // Standardized to use timestamp() helper
    operationType: z.enum(['push', 'pull', 'full']).optional(),
  }),
});

// Batch sync schema for multiple entities
const batchSyncSchema = z.object({
  body: z.object({
    operations: z.array(z.object({
      entity: SyncableEntityType,
      changes: z.array(changeRecordSchema),
    })).max(10, 'Too many entity types in batch'),
    deviceId: z.string().max(100),
    atomic: z.boolean().optional(),
  }),
});

// Cursor-based sync changes schema (for GET /changes endpoint)
const syncChangesSchema = z.object({
  query: z.object({
    cursor: z.string().optional(),
    entityTypes: z.string().optional(), // Comma-separated or repeated query param
    limit: numberQuery(1, 1000).optional(),
    leaseId: z.string().uuid().optional(),
    productFields: z.string().max(500).optional(),
  }),
});

// Sync lease request schema (admission control)
const syncLeaseSchema = z.object({
  body: SyncLeaseRequestSchema,
});

// Enhanced push sync schema with cursor support
const pushSyncCursorSchema = z.object({
  body: z.object({
    deviceId: z.string().max(100),
    changes: z.array(
      z.object({
        entityType: SyncableEntityType,
        entityId: z.string(),
        changeType: z.enum(['CREATE', 'UPDATE', 'DELETE']),
        clientId: z.string().optional(),
        // REQUIRED: requestId enables precise per-command outbox tracking.
        // Frontend sends outbox event ID; backend returns it in response for exact marking.
        // Without this, lost-ack retries cannot deterministically reconcile individual commands,
        // and conflict REBASE_AND_RETRY dead-letters instead of retrying.
        requestId: z.string().min(1, 'requestId is required for precise command tracking'),
        // Data: entity-specific change data - structure varies by entityType
        // Use z.unknown() instead of z.any() for type safety - requires entity-specific validation
        data: z.record(z.unknown()),
        version: z.number().int().default(1),
        timestamp: timestamp(), // Standardized to use timestamp() helper
      }),
    ).max(1000, 'Too many changes in single push'),
    syncOperationId: z.string(),
    lastSyncCursor: z.string().optional(),
  }),
});

// Batch conflict resolution schema
const batchResolveConflictsSchema = z.object({
  body: z.object({
    resolutions: z.array(
      z.object({
        conflictId: z.string().uuid(),
        strategy: z.enum(['LOCAL_WINS', 'REMOTE_WINS', 'MERGE', 'MANUAL']),
        // MergedData: conflict-resolved data for MERGE/MANUAL strategies
        // Use z.unknown() instead of z.any() for type safety - requires entity-specific validation
        mergedData: z.record(z.unknown()).optional(),
      }),
    ).max(100, 'Too many conflicts in batch resolution'),
  }),
});

// Export all schemas
export const syncSchemas = {
  push: pushSyncSchema,
  pull: pullSyncSchema,
  full: fullSyncSchema,
  status: syncStatusSchema,
  health: syncHealthSchema,
  resolveConflict: resolveConflictSchema,
  getConflicts: getConflictsSchema,
  reset: resetSyncSchema,
  export: exportDataSchema,
  import: importDataSchema,
  history: syncHistorySchema,
  batch: batchSyncSchema,
  changes: syncChangesSchema,
  pushCursor: pushSyncCursorSchema,
  batchResolveConflicts: batchResolveConflictsSchema,
};

// Export individual schemas for direct use
export {
  pushSyncSchema,
  pullSyncSchema,
  fullSyncSchema,
  syncStatusSchema,
  syncHealthSchema,
  resolveConflictSchema,
  getConflictsSchema,
  resetSyncSchema,
  exportDataSchema,
  importDataSchema,
  syncHistorySchema,
  batchSyncSchema,
  syncChangesSchema,
  syncLeaseSchema,
  pushSyncCursorSchema,
  batchResolveConflictsSchema,
  SyncableEntityType,
  OperationType,
  ResolutionStrategy,
};

// Type exports
export type PushSyncInput = z.infer<typeof pushSyncSchema>['body'];
export type PullSyncQuery = z.infer<typeof pullSyncSchema>['query'];
export type FullSyncInput = z.infer<typeof fullSyncSchema>['body'];
export type SyncStatusQuery = z.infer<typeof syncStatusSchema>['query'];
export type SyncHealthQuery = z.infer<typeof syncHealthSchema>['query'];
export type ResolveConflictInput = z.infer<typeof resolveConflictSchema>['body'];
export type GetConflictsQuery = z.infer<typeof getConflictsSchema>['query'];
export type ResetSyncInput = z.infer<typeof resetSyncSchema>['body'];
export type ExportDataQuery = z.infer<typeof exportDataSchema>['query'];
export type ImportDataInput = z.infer<typeof importDataSchema>['body'];
export type SyncHistoryQuery = z.infer<typeof syncHistorySchema>['query'];
export type BatchSyncInput = z.infer<typeof batchSyncSchema>['body'];
export type ChangeRecord = z.infer<typeof changeRecordSchema>;
export type SyncChangesQuery = z.infer<typeof syncChangesSchema>['query'];
export type SyncLeaseInput = z.infer<typeof syncLeaseSchema>['body'];
export type PushSyncCursorInput = z.infer<typeof pushSyncCursorSchema>['body'];
export type BatchResolveConflictsInput = z.infer<typeof batchResolveConflictsSchema>['body'];
