# Failure Modes and Resilience

This document details the backend's resilience and fault tolerance mechanisms. It serves as a reference for monitoring, troubleshooting, and incident response — covering how the system detects, mitigates, and recovers from failures across all processing layers.

The architecture adheres to four core resilience principles:

> **Fail-Fast** · **Idempotency** · **At-Least-Once Delivery** · **Graceful Degradation**

The scope focuses on backend failure modes and recovery strategies. Mobile and firmware interactions are referenced where they directly impact backend resilience.

---

## System Overview and Failure Domains

The backend employs a service-oriented architecture designed for data synchronization, real-time updates, and asynchronous processing. Its structure facilitates compartmentalization and resilience.

### Internal Components

| Component | Responsibility | Key Files |
| :--- | :--- | :--- |
| **API Gateway / Middleware** | Authentication, authorization, rate limiting, caching, request routing | `apiGateway.middleware.ts`, `MiddlewareFactory.ts` |
| **Controllers** | Request validation, delegation to services | `health.controller.ts`, `sync.controller.ts` |
| **Services** | Core business logic, orchestration across repositories and external APIs | `HealthSampleService.ts`, `SyncService.ts` |
| **Repositories** | Type-safe database access via Prisma ORM for PostgreSQL | Repository layer |

### Asynchronous Processing

| Subsystem | Mechanism | Key Files |
| :--- | :--- | :--- |
| **Domain Event Service** | In-memory event bus with retry and circuit breaker logic per handler | `domain-event.service.ts` |
| **Transactional Outbox** | PostgreSQL-backed `OutboxEvent` table for at-least-once delivery | `outbox.service.ts` |
| **BullMQ Job Queue** | Redis-backed queues for long-running background tasks | `job-manager.service.ts`, `job-processor.ts` |
| **Health Data Pipeline** | Push-only pipeline: client ingestion, upload, and async projection processing | Pipeline layer |
| **Projection Coordinator** | Fan-out of `health.samples.changed` events with independent checkpointing | `health-projection-coordinator.service.ts` |

### External Dependencies

| Dependency | Purpose | Key Files |
| :--- | :--- | :--- |
| **PostgreSQL** | Primary data store for all application data | `database.service.ts` |
| **Redis** | API caching, BullMQ job queues, Socket.IO horizontal scaling | `cache.service.ts`, `job-manager.service.ts`, `socket.service.ts` |
| **AWS Cognito** | User authentication and identity management | `cognito.service.ts` |
| **AWS S3** | User content storage (journal photos) and database backups | `s3.service.ts` |
| **Anthropic (AI)** | AI-powered features (chat, analysis, recommendations) | External API |
| **HealthKit / Health Connect** | Raw health data sources (iOS and Android) | Client-side providers |

### Failure Domains

| Domain | Examples |
| :--- | :--- |
| **Network & Connectivity** | Transient issues, DNS resolution failures, connection timeouts, packet loss |
| **Database (PostgreSQL)** | Connection pool exhaustion, long-running queries, deadlocks, unique constraint violations, foreign key violations, schema drift |
| **Cache & Messaging (Redis)** | Connection failures, high latency, cache misses, queue overflow, message processing delays |
| **External APIs** | Downtime, rate limiting, unexpected response formats, authentication failures |
| **Internal Service Logic** | Bugs, unhandled exceptions, resource leaks, unexpected data states, infinite loops |
| **Async Message Processing** | Message loss, poison pill messages, crashed workers, message processing timeouts |
| **Concurrency & Race Conditions** | Simultaneous updates to shared resources, stale reads, distributed lock contention |
| **Resource Exhaustion** | Server CPU, memory, disk I/O, open file descriptors |

---

## Resilience Mechanisms

The backend incorporates a multi-layered approach to resilience, employing specific design patterns and configurations at various architectural boundaries.

<br>

### Retry Policies and Backoff Strategies

Automated retry mechanisms handle transient failures using **exponential backoff with jitter** to prevent thundering herds.

**Database Operations**

- **Mechanism:** `DatabaseService.executeWithRetry` wraps critical database operations with retry logic for transient PostgreSQL errors.
- **Triggers:** Prisma errors `P1001` (connection issues), `P1002` (timeouts), `P2024` (connection pool exhaustion), and network errors (`ECONNRESET`, `ETIMEDOUT`).
- **Parameters:** `maxRetries: 3`, `baseDelayMs: 1000`, `maxDelayMs: 10000` via `DEFAULT_RETRY_CONFIG`.
- **Recovery:** Transparent retry with logged warnings per attempt.

**Domain Event Handlers**

- **Mechanism:** `DomainEventService.emitEvent` dispatches to handlers via `executeHandler` with per-handler retry logic.
- **Triggers:** Any `Error` thrown by a subscriber handler.
- **Parameters:** Per-subscriber configuration (`maxRetries`, `retryDelayMs`, `timeout`) defined in each subscriber file (`achievement.subscriber.ts`, `analytics.subscriber.ts`, etc.).
- **Recovery:** Automatic retries for individual handlers. Repeated failures may trip the per-handler circuit breaker.

**Health Data Ingestion (Client-Side)**

- **Mechanism:** `HealthSyncCoordinationState` manages global backoff periods (`_ingestBackoffMs`, `_uploadBackoffMs`) for HealthKit/Health Connect ingestion and server uploads.
- **Triggers:** HealthKit API failures, network errors, and HTTP 429 (`RATE_LIMITED`) responses. `HealthUploadEngine.classifyError` informs retryability and provides server `retryAfterMs` hints.
- **Parameters:** `MIN_BACKOFF_MS`, `MAX_BACKOFF_MS`, `BACKOFF_MULTIPLIER: 2`, `BACKOFF_JITTER_FACTOR: 0.25`.
- **Recovery:** Automatic client-side retries, affecting the timing of the next sync cycle.

**Health Projection Hydration (Client-Side)**

- **Mechanism:** `HealthProjectionRefreshService.shouldRetryHydration` determines if a projection hydration call should be retried.
- **Triggers:** Backend projection states (`COMPUTING`, `STALE`, `FAILED` as returned by `HealthProjectionHydrationClient`), or transient network errors during the HTTP request.
- **Parameters:** `MAX_HYDRATION_RETRIES: 3`, `HYDRATION_RETRY_BASE_MS: 2000`.
- **Recovery:** Automatic client-side retries to refresh the local projection cache, allowing the UI to converge to fresh data.

**Outbox Event Processing**

- **Mechanism:** `OutboxService.incrementRetryCount` sets the `nextAttemptAt` timestamp in the `OutboxEvent` table for crashed or failed processing events.
- **Triggers:** Any error encountered during `OutboxService.processEvent`.
- **Parameters:** `BASE_DELAY_MS: 5000`, `MAX_DELAY_MS: 300000`.
- **Recovery:** Durable, crash-safe retry scheduling. `OutboxProcessorService` periodically queries for events whose `nextAttemptAt` has passed, ensuring eventual processing.

**External API Calls**

- **Mechanism:** `apiGateway.middleware.ts` wraps external calls via `ServiceRegistry.executeWithRetry`.
- **Triggers:** Network errors, HTTP 5xx responses from external services. Does *not* retry on client errors (4xx).
- **Parameters:** Configurable per service definition in `APIGatewayManager` (e.g., 3 retries for Anthropic) with exponential backoff.
- **Recovery:** Transparent retries at the API Gateway level.

> **Key principle:** All retry mechanisms use exponential backoff with jitter. No component retries at a fixed interval.

<br>

### Idempotency Guarantees

Idempotency ensures that performing the same operation multiple times yields the same result — preventing duplicate data, unintended side effects, and maintaining data consistency.

**Request-Level Idempotency**

Health and sync endpoints enforce request-level deduplication:

- **Health Ingest:** `HealthSampleService.batchUpsertSamples` uses a client-generated `requestId` (UUID) and `payloadHash` (SHA-256 of the canonicalized request body). The `HealthIngestRequest` table stores the request and its processing status. Duplicate requests return the cached result instantly. A mismatched `payloadHash` is rejected as potential tampering (`BatchValidationError`). Concurrent in-progress requests receive 409 Conflict.
- **Sync Push:** `SyncService.processPushSync` uses a `clientSyncOperationId` (client-generated UUID) in the `SyncOperation` table. Duplicate operations return the cached `resultPayload`.

*Source: `health.contract.ts` (`PayloadHashSchema`, `BatchUpsertSamplesRequestSchema`), `payload-hash.ts` (`computeBatchPayloadHash`), `HealthSampleService.batchUpsertSamples`, `SyncService.processPushSync`, `prisma/schema.prisma` (`HealthIngestRequest`, `SyncOperation`)*

**Entity-Level Deduplication**

Unique constraints on natural keys at the database level enforce sample-level idempotency:

- `HealthSample`: `(userId, sourceId, sourceRecordId, startAt)`
- `Consumption`: `(userId, clientConsumptionId)`
- `Purchase`: `(userId, clientPurchaseId)`

Repository `create` methods leverage `ON CONFLICT DO UPDATE` in PostgreSQL — a duplicate `CREATE` operation becomes an `UPDATE`, modifying non-key fields without creating a new record.

*Source: `prisma/schema.prisma` (`@@unique` constraints), repository `create` methods (e.g., `HealthSampleRepository.batchUpsertWithIdempotency`)*

**Cursor-Based Sync**

The `sync-config/cursor.ts` module defines `EntityCursor` (`lastCreatedAt`, `lastId`) and `CompositeCursor` for tracking processed changes. Cursors advance monotonically (`isValidAdvancement`). Backward movement is rejected with `InvalidCursorError`.

**Asynchronous Job Deduplication**

- **BullMQ:** Repeatable jobs specify a `jobId` to ensure only one instance is active in the queue at any time.
- **Outbox:** `OutboxEvent.eventHash` provides content-based deduplication. `OutboxService.addEventInternal` checks `eventHash` to prevent identical events. `OutboxEvent.dedupeKey` prevents duplicate in-flight events for the same request.

*Source: `job-manager.service.ts` (`enqueueJob` with `jobId`), `outbox.service.ts` (`generateEventHash`, `dedupeKey`)*

**Projection Lease Coordination**

`ProjectionCheckpointRepository.tryAcquireProjectionLease` (used by `HealthProjectionCoordinatorService`) employs lease-based locking and checkpoint status tracking. This ensures only one worker process computes a specific projection for a given `OutboxEvent` at any time, preventing duplicate derived data from concurrent processing.

> **Key principle:** Idempotency is enforced at every trust boundary — request, entity, cursor, job, and projection.

<br>

### Circuit Breakers

Circuit breakers prevent cascading failures by detecting unhealthy dependencies and quickly failing subsequent calls, rather than waiting for timeouts.

**External API Gateway**

- **Scope:** Per-service `CircuitBreaker` instance for each external dependency (e.g., Anthropic, AWS Cognito).
- **States:** `CLOSED` (normal) → `OPEN` (short-circuited after `failureThreshold` consecutive failures) → `HALF_OPEN` (probing after `resetTimeout`).
- **Behavior:** `OPEN` state fails immediately without reaching the unhealthy service. `HALF_OPEN` permits limited test calls.
- **Recovery:** Automatic transition through `HALF_OPEN` → `CLOSED` upon successful probe calls.

*Source: `apiGateway.middleware.ts` (`CircuitBreaker`, `APIGatewayManager`)*

**Domain Event Handlers**

- **Scope:** Per-handler circuit breaker within `DomainEventService` (via `circuitBreakers` map).
- **Triggers:** `circuitBreakerThreshold` consecutive failures (e.g., 5 for a specific handler).
- **Behavior:** Prevents a poison-pill event from continuously retrying and blocking healthy event processing.
- **Recovery:** Automatic reset after `circuitBreakerResetTime` allows the handler to re-engage.

**Redis Client**

- **Scope:** Internal circuit breaker within `CacheService` (tracks `consecutiveFailures`, uses `shouldAttemptOperation`, `recordSuccess`, `recordFailure`).
- **Triggers:** `CIRCUIT_FAILURE_THRESHOLD: 3` consecutive Redis errors.
- **Behavior:** Prevents continuous access attempts to a degraded Redis instance, reducing log flooding and resource consumption.
- **Recovery:** After `CIRCUIT_RESET_TIMEOUT_MS`, probes Redis via `HALF_OPEN` state to check for recovery.

> **Key principle:** Each external dependency and critical internal handler has an independent circuit breaker. No single failure point cascades unchecked.

<br>

### Asynchronous Processing and Queues

The system employs two durable async pipelines: a **transactional outbox** for event-driven projections, and **BullMQ** for compute-heavy background tasks. Both run in a dedicated Worker Service process, sharing no state with the Web Service except through PostgreSQL and Redis.

**Transactional Outbox**

- **Mechanism:** Events (`OutboxEvent`) are written to a PostgreSQL table within the same database transaction as the primary data change (`OutboxService.addEvent`).
- **Guarantees:** At-least-once delivery. Atomicity with the primary write prevents data inconsistencies if the backend crashes between commit and dispatch.
- **Processing:** `OutboxService.processPendingEvents` claims events in batches for concurrent, efficient processing.
- **Recovery:** `OutboxService.recoverStaleProcessing` resets abandoned `PROCESSING` events from crashed workers. `OutboxService.handleFailedEvent` moves persistently failing events to `DEAD_LETTER` status, preventing poison-pill messages from blocking the queue.

*Source: `outbox.service.ts`, `prisma/schema.prisma` (`OutboxEvent`)*

**BullMQ Job Queues**

- **Mechanism:** Redis-backed queues (`Queue`) and workers (`Worker`) for scheduled and long-running tasks (e.g., `REFRESH_ANALYTICS_MVS`, `HEALTH_INGEST_BATCH`, `INVENTORY_RECONCILIATION`).
- **Durability:** Uses a *dedicated Redis instance* (separate from volatile cache Redis) with `noeviction` policy. Job data and queue state persist across worker restarts and deployments.
- **Recovery:** BullMQ handles job retries, delays, and crash recovery. `job-processor.ts` rethrows exceptions to signal failure accurately. `JobManagerService` includes reconnection and retry logic for the Redis connection itself.
- **Configuration:** `removeOnComplete`/`removeOnFail` with configurable retention prevents Redis memory bloat.

*Source: `job-manager.service.ts`, `job-processor.ts`, `jobs/job.types.ts`*

**Health Projection Coordination**

- **Mechanism:** Orchestrates fan-out of `health.samples.changed` outbox events to multiple projection handlers (`HealthRollupProjectionHandler`, `SleepSummaryProjectionHandler`, `SessionImpactProjectionHandler`, `ProductImpactProjectionHandler`, `TelemetryCacheProjectionHandler`).
- **Checkpointing:** The `ProjectionCheckpoint` table tracks `PENDING` → `PROCESSING` → `COMPLETED` | `FAILED` per handler per event.
- **Recovery:** `tryAcquireProjectionLease` implements lease-based concurrency control. `recoverStaleCheckpoints` recovers stuck `PROCESSING` checkpoints. Independent retry per projection — failures in one do not block others (P0-B compliance).

*Source: `health-projection-coordinator.service.ts`, `prisma/schema.prisma` (`ProjectionCheckpoint`)*

**Backpressure and Queue Limits**

- **Health Ingest Queue:** `HealthIngestQueueService.maybeQueueBatch` checks `maxQueueDepth` for the `HEALTH_INGEST_BATCH` job queue. Full queue rejects with 429 `RATE_LIMIT_EXCEEDED`. `MAX_JOB_PAYLOAD_BYTES` caps individual BullMQ job payloads to prevent Redis OOM errors.
- **Insight Computation:** An `AsyncSemaphore` (`MAX_CONCURRENT_INSIGHT_QUERIES`, `MAX_PENDING_INSIGHT_QUERIES`) limits concurrent database queries from the insight engine. When the semaphore queue is full, calls are immediately shed (`backpressure_shed`), returning a `computing` state to the client with a `retryAfterSeconds` hint.

> **Key principle:** Background jobs survive worker crashes via durable Redis queues. Outbox events survive application crashes via transactional persistence. Both pipelines are idempotent and retry-safe.

<br>

### Error Classification and Handling

Consistent error classification drives automated recovery decisions and enables effective troubleshooting.

**Central Error Middleware**

`createErrorHandler` acts as the central error handler for the Express application, classifying errors into appropriate HTTP responses:

| Error Type | HTTP Status | Notes |
| :--- | :--- | :--- |
| `ZodError` | 400 | Validation failures |
| Body parser error | 400 / 413 / 415 | Malformed or oversized request bodies |
| `PrismaClientKnownRequestError` | Mapped | Converted to `AppError` for database issues |
| `AppError` | Varies | Custom operational errors |
| Generic `Error` | 500 | Unexpected / unhandled errors |

- **Security:** The `redactSensitiveBody` utility ensures PHI/PII from request bodies is never logged in plaintext.
- **Observability:** All errors are logged with `requestId`, `correlationId`, and `userId` for end-to-end tracing. Responses consistently include `requestId`.

*Source: `error.middleware.ts`*

**Health-Specific Error Middleware**

`createHealthErrorHandler` is a specialized handler for health data batch endpoints, registered *before* the generic error middleware. It translates `AppError` codes into `BatchErrorCode` (defined in `health.contract.ts`) and populates `retryable` and `retryAfterMs` fields in the HTTP response, enabling mobile clients to programmatically interpret batch failures and apply appropriate retry strategies.

*Source: `health-error.middleware.ts`, `health.contract.ts` (`BatchErrorCodeSchema`, `BATCH_ERROR_RETRYABLE`)*

**Health Upload Engine Classification**

`HealthUploadEngine.classifyError` analyzes error types during the client-side upload process to determine retryability:

| Error Type | Classification | Action |
| :--- | :--- | :--- |
| `PayloadTooLargeError` | Retryable | Client-side auto-rechunking (from estimation or server 413) |
| `PreSendValidationError` | Non-retryable | Internal bug in staging logic |
| `TypeError` (network) | Retryable | Transient network issue |
| `TypeError` (code) | Non-retryable | Permanent programming bug |

<br>

### Concurrency Control and Race Conditions

Managing concurrent access to shared resources is critical to prevent data corruption and ensure consistency.

**API Cache Invalidation**

`apiCache.middleware.ts` implements race condition protection for cached API responses. When a mutating request (`POST`, `PUT`) arrives, it calls `cacheService.setInvalidationTimestamps` for relevant cache tags *before* controller execution. A `GET` request that started before the invalidation timestamp but attempts to `cacheResponse` after it will detect the invalidation and skip caching — preventing stale data from being stored.

**Session Telemetry Computation**

`SessionTelemetryCacheRepository.tryAcquireComputeLock` uses an atomic PostgreSQL `UPDATE ... RETURNING` statement to acquire a computation lock for a specific session, window, resolution, and compute version. This prevents thundering-herd redundant computation and recovers stale `COMPUTING` locks.

**Single Active Purchase Enforcement**

`PurchaseService` uses `PurchaseRepository.findActiveByUserAndProduct` within a database transaction combined with a partial unique index (`Purchase_userId_productId_active_unique` on `(userId, productId)` where `isActive=true`). Violations return 409 `AppError.activePurchaseExists`, preventing duplicate active purchases.

> **Key principle:** All shared-resource access uses optimistic locking, lease-based coordination, or database-level constraints — never application-level mutexes.

---

## Cascading Failure Scenarios

Cascading failures occur when a failure in one component triggers failures in others. The system employs strategies to contain and mitigate these propagation paths.

<br>

### Auth Service Outage (AWS Cognito)

- **Impact:** All authenticated API requests receive 401/403. New user registrations and logins fail.
- **Mitigation:** API Gateway `CircuitBreaker` for Cognito trips, preventing repeated failed calls. `AuthRateLimitService` logs repeated authentication failures.
- **Recovery:** Automatic when Cognito service functionality is restored.

### Database Exhaustion (PostgreSQL / Neon)

- **Impact:** API requests block with increased latency, eventually timing out (HTTP 504). `JobManagerService` workers stall, causing queue backlogs. High error rates across all DB-dependent services.
- **Mitigation:** `DatabaseService.executeWithRetry` handles transient connection errors. `AsyncSemaphore` in `HealthInsightEngineService` applies backpressure to database queries. BullMQ queues enforce `maxQueueLen` and `concurrency` limits.
- **Recovery:** Automated retries alleviate transient issues. Neon serverless autoscaling handles dynamic load. Persistent outages require manual intervention.

### Redis Outage (Cache, BullMQ, Socket.IO Adapter)

| Subsystem | Impact | Degradation Mode |
| :--- | :--- | :--- |
| **API Cache** | Cache misses — requests hit database directly, increasing DB load | Graceful (non-fatal) |
| **BullMQ Job Queues** | Job processing halts, queues build up, `JobManagerService` logs severe errors | Durable (auto-restart on recovery) |
| **Socket.IO Real-time** | Live consumption and session updates unavailable, clients disconnect | Falls back to single-instance mode |

- **Mitigation:** Cache failures are designed to be non-fatal. BullMQ jobs are durable and restart automatically upon Redis recovery. Socket.IO falls back to single-instance mode if the Redis adapter fails. Dedicated reconnection logic in `CacheService` and `JobManagerService`.
- **Recovery:** Automatic when Redis service functionality is restored.

### External AI API Downtime (Anthropic)

- **Impact:** AI-powered features (chat, analysis, recommendations) fail with HTTP 503 or 429.
- **Mitigation:** API Gateway `CircuitBreaker` for Anthropic trips, short-circuiting further calls. Exponential backoff prevents overwhelming the API.
- **Recovery:** Automatic when the external API restores functionality.

### Health Data Provider Issues (Client-Side)

- **Impact:** Client-side ingestion of health data fails, leading to stale health data in the mobile UI.
- **Mitigation:** `HealthSyncCoordinationState` manages exponential backoff for ingestion attempts, preventing rapid-fire retries. `HealthIngestionEngine` handles provider-specific errors (`HealthKitError`).
- **Recovery:** Automatic client-side retries.

### Long-Running Worker Jobs (BullMQ)

- **Impact:** A stuck or slow job prevents other jobs from processing, causing queue backlogs and potential resource exhaustion on the worker instance.
- **Mitigation:** Configurable `workerConcurrency` limits per queue. Job-level timeouts in `job-processor.ts`. `HealthIngestQueueService.MAX_JOB_PAYLOAD_BYTES` limits payload size to prevent memory issues.
- **Recovery:** Automatic if the job completes or fails its retries. Persistent DLQ items require manual cleanup via `JobManagerService.getJob` / `cleanQueue`.

---

## Self-Healing and Recovery

The system is designed to recover automatically from a wide range of failures, minimizing human intervention.

**Automated Retries** — Most transient errors across database interactions, internal service calls, and external API integrations are retried with exponential backoff.

**Stale Lock Recovery** — Background reaper jobs proactively identify and reset abandoned `PROCESSING` records, preventing permanent deadlocks from crashed workers:

| Reaper | Target | Source |
| :--- | :--- | :--- |
| `HEALTH_INGEST_REAPER` | Stale `HealthIngestRequest` entries | `HealthSampleRepository.reapStaleProcessingIngestRequests` |
| `SESSION_TELEMETRY_LOCK_REAPER` | Stale `SessionTelemetryCache` entries | `SessionTelemetryCacheRepository.reapStaleComputingRows` |
| Outbox recovery | Stale `PROCESSING` outbox events | `OutboxService.recoverStaleProcessing` |

**Data Reconciliation** — Scheduled background jobs proactively identify and repair data inconsistencies or incomplete states:

- `INVENTORY_RECONCILIATION` (`InventoryRepository.adjustInventoryBatch`): Links consumptions not yet associated with inventory adjustments.
- `STALE_SESSION_RECONCILIATION` (`SessionService.reconcileStaleSessionsGlobal`): Closes sessions remaining `ACTIVE` after their `sessionEndTimestamp`.

**Cache Reconstruction** — When client-side caches are invalid or expired, a cache miss triggers a fetch of fresh data from the server. On the backend, precomputed data (e.g., session telemetry) is recomputed on demand or refreshed on schedule. `REFRESH_ANALYTICS_MVS` jobs periodically refresh materialized views to ensure analytics data freshness.

**Crash Safety** — The transactional outbox guarantees events are durably recorded alongside data changes, preventing message loss even on server crash. BullMQ's durable queues ensure jobs survive worker restarts. The `HealthUploadEngine` includes a comprehensive `initialize()` method for crash recovery, resetting `staged`/`uploading` samples and deletions back to `pending` status.

> **Key principle:** Recovery is a primary operating mode, not an edge case handler.

---

## Manual Intervention Points

While extensive self-healing mechanisms are in place, certain failure modes require human intervention to diagnose, mitigate, or resolve.

| Scenario | Indicators | Required Action |
| :--- | :--- | :--- |
| **Dead Letter Queue events** | `OutboxStatus.DEAD_LETTER` after `maxRetries` exhausted or non-retryable errors | Root cause analysis (data corruption, unhandled business logic). Manual replay via `OutboxService.processNow` or permanent discard. |
| **Non-retryable errors** | HTTP 4xx: `VALIDATION_ERROR`, `PAYLOAD_HASH_MISMATCH`, `CONFIG_VERSION_TOO_NEW`, `CODE_ERROR` (e.g., `TypeError` from a bug) | Fix client-side bugs, configuration errors, or data corruption. Automated retries cannot resolve these. |
| **Security incidents** | Brute force attempts, account lockouts, suspicious IP activity (`AuthRateLimitMiddleware`) | Administrative action: `AuthRateLimitMiddleware.unlockAccount`, `AuthRateLimitMiddleware.unbanIP`. |
| **Schema drift** | Prisma errors `P2021` (missing table), `P2022` (missing column) | Application schema out of sync with codebase. Apply pending migrations: `npx prisma migrate deploy`. |
| **Persistent infrastructure outage** | Extended PostgreSQL or Redis downtime beyond automatic recovery capabilities | Manual infrastructure repair, failover procedures. |

---

## Observability for Failures

Comprehensive observability provides visibility into system health and enables rapid detection and diagnosis of failures.

### Structured Logging

All errors, warnings, and critical events are logged as structured JSON objects via `LoggerService`, including `correlationId`, `userId`, `errorCode`, and detailed stack traces. The `redactSensitiveBody` utility ensures PHI/PII from request bodies is never exposed in logs.

### Performance Metrics

`PerformanceMonitoringService` tracks key operational metrics: HTTP error rates, API response times (p95/p99 latency), database query latencies, queue depths, and circuit breaker states (via `apiGateway.middleware.ts`).

### Security Logging

`SecurityLoggerService` records specific security events — authentication failures, suspicious activity, and rate limit exceedances — for auditing, compliance, and real-time security alerting.

### Health Checks

| Endpoint | Purpose |
| :--- | :--- |
| `/health` | Basic application health status |
| `/api/v1/monitoring/health/rate-limit` | Rate limiting queue status, queue length, and health indicators (`createRateLimitHealthCheck`) |
| `/api/v1/gateway/health` | External service health summary and circuit breaker states |

### Distributed Tracing

OpenTelemetry (`instrumentation.ts`) provides end-to-end distributed tracing. `correlationId` is propagated across HTTP requests, service boundaries, and asynchronous queues, enabling full trace correlation for debugging complex, multi-service failure scenarios.
