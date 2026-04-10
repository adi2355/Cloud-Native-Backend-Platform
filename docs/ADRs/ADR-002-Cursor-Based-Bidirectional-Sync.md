# ADR-002: Cursor-Based Bidirectional Sync with Conflict Resolution

## Status
Accepted

## Context
Mobile clients operate offline for extended periods. When reconnecting, they must synchronize local changes with the server and pull remote changes — handling concurrent modifications, preserving user intent, and avoiding duplicates. Timestamp-based sync suffers from clock skew. Offset-based pagination degrades at depth and is unstable under concurrent writes.

## Decision
Implement **cursor-based bidirectional synchronization** with **config-driven conflict resolution**.

### Pull Cycle
- Backend exposes `GET /sync/changes` with opaque, Base64-encoded composite cursors
- Each cursor represents `(lastCreatedAt, lastId)` across entity types with per-entity sub-cursors
- Cursors are strictly monotonic — `advanceEntityCursor` enforces forward-only movement
- Changes are ordered topologically by `ENTITY_SYNC_ORDER` to respect FK dependencies

### Push Cycle
- Client sends batched changes via `POST /sync/push` with entity `version` for optimistic locking
- Server compares `clientVersion` against `serverVersion` — mismatch triggers conflict resolution
- Resolution uses declarative `ENTITY_CONFLICT_CONFIG` from shared contracts:
  - Default strategies: `SERVER_WINS`, `CLIENT_WINS`, `LAST_WRITE_WINS`, `MERGE`
  - Field-level policies: `LOCAL_WINS`, `SERVER_WINS`, `MERGE_ARRAYS`, `MONOTONIC`, `MAX_VALUE`
- Each entity type has a dedicated `SyncEntityHandler` for custom merge logic
- The entire push is tracked by `SyncOperation` (keyed on `clientSyncOperationId`) for idempotency

## Consequences

### Positive
- Guaranteed eventual consistency across all devices
- Stable O(log N) pagination, immune to concurrent write instability
- Fine-grained, auditable conflict resolution
- Extensible — new entity types add a handler + config entry

### Negative
- Significantly more complex than simple timestamp sync
- Shared conflict config requires cross-team maintenance discipline
- Cursor format evolution requires `CURSOR_SCHEMA_VERSION` management

### Alternatives Rejected
- **Timestamp-based sync:** Clock skew causes missed or duplicated changes
- **Offset-based pagination:** O(N) at depth, unstable under writes
- **Global last-write-wins:** Loses user-edited fields when server version is newer by timestamp but older by content
- **External sync libraries (Couchbase, AppSync):** Vendor lock-in; insufficient control over merge semantics

## Key Files
- `code-snippets/services/sync.service.ts` — `processPushSync`, `getIncrementalChanges`, `detectConflict`
- `code-snippets/services/sync/handlers/*.handler.ts` — Entity-specific merge implementations
- `packages/shared/src/sync-config/conflict-configs.ts` — `ENTITY_CONFLICT_CONFIG`
- `packages/shared/src/sync-config/cursor.ts` — Cursor encode/decode/advance
- `packages/shared/src/sync-config/entity-types.ts` — `ENTITY_TYPES`, `ENTITY_SYNC_ORDER`
