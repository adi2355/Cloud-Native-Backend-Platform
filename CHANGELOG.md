# CHANGELOG — Engineering Journal

Key architectural decisions and milestones.

---

## Transactional Outbox for Durable Eventing

**Problem:** Ensuring atomicity between database writes and domain event publishing in a distributed system.

**Solution:** Implemented the Transactional Outbox Pattern — events written to `OutboxEvent` table within the same database transaction as data changes. `OutboxProcessorService` reliably polls, processes, and completes events with retry + dead letter support.

**Impact:** Guaranteed at-least-once event delivery. Strong data consistency across analytics, projections, and real-time updates. Crash-safe event publication.

---

## Cursor-Based Bidirectional Sync Engine

**Problem:** Reliably synchronizing data between multiple offline-first clients and the backend without data loss or duplicates.

**Solution:** Custom cursor-based sync with opaque composite cursors, optimistic locking, and config-driven conflict resolution (`ENTITY_CONFLICT_CONFIG` with field-level merge policies). Client-generated `requestId`s ensure push idempotency.

**Impact:** Robust eventual consistency across all devices. Extensible conflict resolution. Scalable O(log N) pagination.

---

## Health Data Projection Pipeline (CQRS)

**Problem:** Real-time aggregation of raw health data is too slow for UI dashboards and AI analysis.

**Solution:** Event-driven projection pipeline — `health.samples.changed` outbox events trigger independent `HealthProjectionHandler`s that pre-compute derived read models. Watermark-based freshness tracking provides explicit staleness signals.

**Impact:** Millisecond reads for dashboards. Reduced database load. Explicit data freshness contract between backend and frontend.

---

## Idempotent Health Data Ingestion

**Problem:** High-volume health data uploads from mobile clients create duplicates on network retry.

**Solution:** Two-layer idempotency: request-level (`requestId` + `payloadHash` in `HealthIngestRequest` table) and sample-level (composite unique constraint with `ON CONFLICT DO UPDATE`). Large batches offloaded to BullMQ workers.

**Impact:** Zero duplicate health records. Safe retries. API-responsive even under high ingestion volume.

---

## AI Integration with PHI Redaction

**Problem:** Sending health data to external LLMs risks exposing Protected Health Information.

**Solution:** `AiPhiRedactionService` systematically removes PHI before AI processing. Context aggregation builds rich analysis inputs while stripping identifiable information. Cost tracking monitors LLM usage per user.

**Impact:** HIPAA-grade privacy for AI features. Personalized insights without compromising user data.

---

## Real-Time Session Telemetry

**Problem:** Delivering live health metric visualizations during sessions without overwhelming the backend.

**Solution:** `SessionTelemetryService` with watermark-based caching, `BoundedComputeCoordinator` for concurrent computation limits, and WebSocket delivery via `WebSocketBroadcaster`.

**Impact:** Instant user feedback during sessions. Efficient background computation. Scalable real-time data delivery.
