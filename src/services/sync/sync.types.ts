/**
 * Sync Entity Handler Types
 *
 * Defines the contract for entity-specific synchronization handlers.
 * This abstraction enables the SyncService to process different entity types
 * (sessions, journals, purchases, consumptions) without tight coupling to
 * specific repository implementations.
 *
 * **ARCHITECTURE PATTERN: Strategy Pattern + Dependency Inversion Principle**
 * - SyncService depends on SyncEntityHandler abstraction (DIP)
 * - Concrete handlers encapsulate entity-specific logic (SRP)
 * - New entity types can be added without modifying SyncService (OCP)
 *
 * @see https://refactoring.guru/design-patterns/strategy
 */

import { Prisma } from '@prisma/client';

/**
 * Generic synchronization handler for a specific entity type
 *
 * @template T - The entity type (e.g., Session, JournalEntry, Purchase)
 *
 * - All methods use `Prisma.JsonValue` for changeData (matches SyncChange.changeData type)
 * - NO `any` types - use `unknown` with type guards or explicit interfaces
 * - Entity-specific validation via Zod schemas
 * - Throws AppError on failures (never returns success/error objects)
 */
export interface SyncEntityHandler<T> {
  /**
   * Create a new entity from sync change data
   *
   * - Handles idempotency via entity-specific unique constraints (e.g., clientEntryId)
   * - Returns existing entity if duplicate detected
   * - Validates changeData before transformation
   * - Executes within provided transaction context
   *
   * @param userId - User ID for authorization
   * @param entityId - Entity ID (server-generated or client-provided)
   * @param changeData - Raw change data (Prisma.JsonValue from SyncChange)
   * @param tx - Transaction client for atomicity
   * @returns Created or existing entity
   * @throws AppError if validation fails or creation errors
   */
  create(
    userId: string,
    entityId: string,
    changeData: Prisma.JsonValue,
    tx: Prisma.TransactionClient
  ): Promise<T>;

  /**
   * Update an existing entity from sync change data
   *
   * - Implements optimistic locking via version field
   * - Validates entity ownership (userId match)
   * - Validates changeData before transformation
   * - Atomically increments version on success
   *
   * @param userId - User ID for authorization
   * @param entityId - Entity ID to update
   * @param changeData - Raw change data (Prisma.JsonValue from SyncChange)
   * @param tx - Transaction client for atomicity
   * @returns Updated entity
   * @throws AppError if not found, validation fails, or version conflict
   */
  update(
    userId: string,
    entityId: string,
    changeData: Prisma.JsonValue,
    tx: Prisma.TransactionClient
  ): Promise<T>;

  /**
   * Delete an entity
   *
   * - Validates entity ownership (userId match)
   * - Soft-delete preferred for audit trail
   * - Cascades handled by Prisma schema constraints
   *
   * @param userId - User ID for authorization
   * @param entityId - Entity ID to delete
   * @param tx - Transaction client for atomicity
   * @returns Deleted entity (for audit logging)
   * @throws AppError if not found or access denied
   */
  delete(
    userId: string,
    entityId: string,
    tx: Prisma.TransactionClient
  ): Promise<T>;

  /**
   * Fetch current server version of entity for conflict detection
   *
   * - Used by conflict resolution to compare client vs server state
   * - Must include version field for optimistic locking
   * - Returns null if entity doesn't exist (not an error - needed for conflict resolution)
   *
   * @param userId - User ID for authorization
   * @param entityId - Entity ID to fetch
   * @param tx - Transaction client for consistency
   * @returns Current server entity or null if not found
   * @throws AppError only on database errors (NOT on entity not found)
   */
  fetchServerVersion(
    userId: string,
    entityId: string,
    tx: Prisma.TransactionClient
  ): Promise<T | null>;

  /**
   * Validate raw change data before processing
   *
   * - Uses Zod schema validation specific to entity type
   * - Prevents invalid data from entering the system
   * - Returns boolean (true = valid, false = invalid)
   * - Called BEFORE create/update to fail fast
   *
   * @param changeData - Raw change data to validate
   * @returns true if valid, false if invalid
   */
  validate(changeData: Prisma.JsonValue): boolean;

  /**
   * Merge conflicting client and server data
   *
   * 1. Last-Write-Wins (default): Use client data, increment version
   * 2. Field-Level Merge: Intelligently merge non-conflicting fields
   * 3. Custom Business Logic: Entity-specific conflict resolution
   *
   * **ALWAYS:**
   * - Increment version field after merge
   * - Update updatedAt timestamp
   * - Preserve audit trail (e.g., modifiedBy, conflictResolution metadata)
   *
   * @param serverData - Current server entity state
   * @param clientData - Client's proposed changes (Prisma.JsonValue)
   * @returns Merged entity data (partial update)
   */
  merge(serverData: T, clientData: Prisma.JsonValue): Partial<T>;

  /**
   * Resolve the canonical server entity ID for a CREATE operation.
   *
   * **PURPOSE:**
   * Used during idempotent replay reconstruction when `resultPayload` is missing
   * (legacy records or edge-case data loss). Instead of guessing that
   * `serverId === clientEntityId`, this method performs a canonical entity lookup
   * to find the actual server-assigned ID.
   *
   * **WHEN TO IMPLEMENT:**
   * Handlers where `create()` can return an entity with a different ID than the
   * client-provided `entityId` MUST implement this method. For example:
   * - DeviceHandler: MAC address dedup returns existing device with different ID
   *
   * Handlers where `create()` always uses `id: entityId` do NOT need to implement
   * this — the default behavior (direct ID lookup via `fetchServerVersion`) suffices.
   *
   * **CONTRACT:**
   * - Read-only: MUST NOT mutate any data
   * - Returns the canonical server entity ID if the entity is found
   * - Returns null if the entity cannot be located (caller falls back to heuristic)
   *
   * @param userId - User ID for authorization scoping
   * @param clientEntityId - The entity ID from the client's original push request
   * @param changeData - Raw change data (for handler-specific lookups, e.g., macAddress)
   * @returns The canonical server entity ID, or null if not found
   */
  resolveServerIdForCreate?(
    userId: string,
    clientEntityId: string,
    changeData: Prisma.JsonValue,
  ): Promise<string | null>;
}

/**
 * Registry of sync entity handlers keyed by entity type
 *
 * **USAGE IN SYNCSERVICE:**
 * ```typescript
 * constructor(
 *   private readonly entityHandlers: Map<string, SyncEntityHandler<unknown>>
 * ) {}
 *
 * private async applyChange(change: SyncChange, tx: TransactionClient) {
 *   const handler = this.entityHandlers.get(change.entityType);
 *   if (!handler) throw new AppError(...);
 *
 *   if (change.changeType === 'CREATE') {
 *     return await handler.create(userId, entityId, change.changeData, tx);
 *   }
 *   // ... other operations
 * }
 * ```
 */
export type SyncEntityHandlerRegistry = Map<string, SyncEntityHandler<unknown>>;

/**
 * Supported entity types for synchronization
 *
 * - Must match entityType values in SyncChange table
 * - Used for type-safe handler registration in bootstrap.ts
 */
export const SYNC_ENTITY_TYPES = {
  SESSIONS: 'sessions',
  JOURNALS: 'journals',
  PURCHASES: 'purchases',
  CONSUMPTIONS: 'consumptions',
  GOALS: 'goals',
  DEVICES: 'devices',
  USER_ACHIEVEMENTS: 'user_achievements',
  INVENTORY_ITEMS: 'inventory_items',
  PRODUCTS: 'products',
} as const;

export type SyncEntityType = typeof SYNC_ENTITY_TYPES[keyof typeof SYNC_ENTITY_TYPES];
