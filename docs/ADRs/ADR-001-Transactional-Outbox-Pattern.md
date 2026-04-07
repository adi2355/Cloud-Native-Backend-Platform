# ADR-001: Transactional Outbox Pattern

## Status
Accepted

## Context
The platform is event-driven — data mutations trigger downstream processes (analytics, achievements, projections, real-time updates). The fundamental challenge is the **dual-write problem**: ensuring a database transaction and its corresponding domain event are atomic. A crash after commit but before event emission creates silent inconsistencies.

## Decision
All critical data mutations write an `OutboxEvent` record to a dedicated table **within the same database transaction** as the primary data change. A separate `OutboxProcessorService` polls the outbox, routes events to their destinations, and marks them `COMPLETED`.

### Key Implementation Details
- **Atomic write:** `OutboxService.addEvent()` accepts a `Prisma.TransactionClient` — the event is part of the caller's transaction
- **Reliable processing:** `OutboxProcessorService.processPendingEvents()` claims batches with `FOR UPDATE SKIP LOCKED`, preventing duplicate processing
- **Health event coalescing:** `outbox-coalescing.ts` groups health events by user/metric, reducing redundant projection fan-outs
- **Retry + Dead Letter:** Failed events increment `retryCount` with exponential `nextAttemptAt`; after `maxRetries`, events move to `DEAD_LETTER` status
- **Bounded concurrency:** The processor limits concurrent event processing to prevent resource exhaustion

## Consequences

### Positive
- Dual-write problem is structurally eliminated
- Events survive application crashes (persisted in PostgreSQL)
- Downstream processing is decoupled from primary write latency
- The outbox table serves as an audit log of all system events

### Negative
- Additional database write load (mitigated by efficient indexing on `status` + `nextAttemptAt`)
- Events are eventually consistent, not immediately consistent
- Schema evolution of `OutboxEvent.payload` (JSONB) requires forward-compatible design

### Alternatives Rejected
- **Direct event publishing:** Prone to dual-write inconsistencies; no crash safety
- **Change Data Capture (CDC):** Higher operational overhead; Prisma doesn't expose WAL
- **Two-Phase Commit (2PC):** Excessive complexity and performance overhead for this use case

## Key Files
- `src/services/outbox.service.ts` — `addEvent`, `addEventInternal`
- `src/services/outbox-processor.service.ts` — `processPendingEvents`, `processEvent`
- `src/services/outbox-coalescing.ts` — `coalesceHealthPayloads`
- `src/repositories/outbox-event.repository.ts` — `claimBatch`, `markAsCompleted`, `markAsDeadLetter`
- `prisma/schema.prisma` — `OutboxEvent` model
