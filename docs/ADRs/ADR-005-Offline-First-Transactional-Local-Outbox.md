# ADR-005: Offline-First with Transactional Local Outbox

## Status
Accepted

## Context
Users expect full functionality offline. Local mutations must survive app crashes, device power loss, and extended offline periods. Simple in-memory queues or immediate API calls are insufficient — they lose data when the process terminates.

## Decision
Implement **Offline-First Architecture** with a **Transactional Local Outbox**:

1. **Local-First Database:** SQLite (via `expo-sqlite` + `drizzle-orm`) is the primary UI data source. All reads and writes go through the local database first.

2. **Transactional Outbox:** Every local mutation is atomically recorded in an `outbox_events` table within the same SQLite transaction as the data change. This guarantees the outbox entry exists if and only if the data change committed.

3. **Background Sync:** `DataSyncService` polls the outbox for pending commands. When connectivity is available, commands are batched and pushed to the backend. Failed commands are retried with exponential backoff.

4. **Client-Generated IDs:** All entities use client-generated UUIDs (`clientConsumptionId`, `clientSessionId`). The backend uses these for idempotent processing — retried creates produce the same result.

5. **Integrity Gate:** Post-sync, an `IntegrityGate` validates foreign key relationships using a `RELATION_GRAPH` from shared contracts, detecting orphaned records before cursors are committed.

## Consequences

### Positive
- Zero data loss — outbox survives crashes, power loss, app termination
- Always-responsive UI — no waiting for network
- Full offline functionality
- Idempotent uploads via client-generated IDs

### Negative
- Significant client-side complexity (outbox, sync coordination, integrity validation)
- Local storage consumption (mitigated by outbox cleanup after completion)
- Eventual consistency — UI may show local changes that the server later rejects

### Alternatives Rejected
- **Direct API calls + in-memory queue:** Data loss on crash
- **Background fetch + immediate API:** Still fails on network errors; no durability
- **Third-party sync libraries (Realm, Couchbase Lite):** Vendor lock-in; insufficient merge control

## Key Files
- `packages/app/src/db/schema.ts` — `outbox_events` table definition
- `packages/app/src/repositories/offline/OutboxRepository.ts` — Outbox CRUD
- `packages/app/src/services/sync/DataSyncService.ts` — Sync orchestration
- `packages/app/src/services/sync/IntegrityGate.ts` — Post-sync FK validation
- `packages/app/src/services/health/HealthUploadEngine.ts` — Health batch upload
