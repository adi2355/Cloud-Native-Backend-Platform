# Architectural Decision Records

This document contains 21 ADRs for the AppPlatform backend, capturing the context, alternatives, rationale, and consequences of significant architectural decisions. ADRs explain *why* the system is designed the way it is — not just *what* it is.

<br>

## Table of Contents

| ADR | Decision |
| :--- | :--- |
| [ADR-001](#adr-001-backend-dependency-injection-and-composition-root) | Backend Dependency Injection and Composition Root |
| [ADR-002](#adr-002-transactional-outbox-pattern-for-durable-eventing) | Transactional Outbox Pattern for Durable Eventing |
| [ADR-003](#adr-003-health-data-ingestion-pipeline-three-lane-architecture) | Health Data Ingestion Pipeline (Three-Lane Architecture) |
| [ADR-004](#adr-004-health-data-watermark-based-freshness-p0-g) | Health Data Watermark-Based Freshness (P0-G) |
| [ADR-005](#adr-005-api-gateway-pattern-and-cross-cutting-concerns) | API Gateway Pattern and Cross-Cutting Concerns |
| [ADR-006](#adr-006-client-generated-ids-for-idempotent-entity-sync) | Client-Generated IDs for Idempotent Entity Sync |
| [ADR-007](#adr-007-configurable-conflict-resolution-strategies) | Configurable Conflict Resolution Strategies |
| [ADR-008](#adr-008-optimistic-locking-for-data-integrity) | Optimistic Locking for Data Integrity |
| [ADR-009](#adr-009-cursor-based-pagination-for-incremental-sync) | Cursor-Based Pagination for Incremental Sync |
| [ADR-010](#adr-010-health-data-privacy-gating) | Health Data Privacy Gating |
| [ADR-011](#adr-011-health-sample-payload-hash-for-request-idempotency) | Health Sample Payload Hash for Request Idempotency |
| [ADR-012](#adr-012-session-telemetry-precomputation-and-caching-p0-g1) | Session Telemetry Precomputation and Caching (P0-G.1) |
| [ADR-013](#adr-013-multi-factor-inventory-prediction-engine) | Multi-Factor Inventory Prediction Engine |
| [ADR-014](#adr-014-dirichlet-multinomial-temporal-consumption-patterns) | Dirichlet-Multinomial Temporal Consumption Patterns |
| [ADR-015](#adr-015-bullmq-job-payload-size-limit) | BullMQ Job Payload Size Limit |
| [ADR-016](#adr-016-http-compression-for-health-data-uploads) | HTTP Compression for Health Data Uploads |
| [ADR-017](#adr-017-server-time-header-for-client-clock-offset-calculation) | Server-Time Header for Client Clock Offset Calculation |
| [ADR-018](#adr-018-centralized-health-metric-definitions-shared-contract) | Centralized Health Metric Definitions (Shared Contract) |
| [ADR-019](#adr-019-automated-stale-processing-cleanup-reapers) | Automated Stale Processing Cleanup (Reapers) |
| [ADR-020](#adr-020-soft-delete-for-health-samples-with-purge-policy) | Soft Delete for Health Samples with Purge Policy |
| [ADR-021](#adr-021-global-stale-session-reconciliation) | Global Stale Session Reconciliation |

<br>

---

## About This Document

ADRs serve as the architectural record of the backend's evolutionary path. Every ADR is deeply grounded in the actual implementation — referencing specific files, classes, configuration parameters, and code patterns.

**Purpose:**

- **Onboarding** — Accelerate understanding for new team members
- **Maintenance** — Justify existing designs and inform future changes
- **Alignment** — Ensure a shared understanding of core architectural principles
- **Debugging** — Provide historical context for troubleshooting complex issues
- **Auditing** — Document key security, privacy, and data integrity choices

**Scope — ADRs are created for decisions that are:**

- **Significant** — Impact multiple services, modules, or layers
- **Non-trivial** — Involve complex trade-offs or a choice between several viable alternatives
- **Potentially Irreversible** — Introduce new technologies, fundamental design patterns, or major data model changes
- **High Impact** — Affect performance, scalability, security, cost, or maintainability

**Contribution Guide:**
New ADRs should be created when a significant architectural decision is made. Follow the template below and ensure the ADR is grounded in the codebase. All ADRs should be reviewed by at least one other senior engineer.

---

## Decision Records

<br>

### ADR-001: Backend Dependency Injection and Composition Root

#### Context

The AppPlatform backend, as it evolved, faced increasing complexity in managing service dependencies. Traditional patterns like global singletons or service locators led to:

- Tight coupling, making components hard to test in isolation
- Hidden dependencies, obscuring the true graph of service interactions
- Difficulty in replacing implementations (e.g., mock databases for testing)
- Challenges in configuring services with runtime parameters

This created a maintenance burden and hindered the adoption of high-quality testing practices.

#### Decision

The backend adopted **Pure Constructor Dependency Injection (DI)** as the primary mechanism for managing dependencies. `bootstrap.ts` was designated as the sole "composition root" responsible for instantiating and wiring all services, repositories, controllers, and middleware. No service should internally resolve its own dependencies (e.g., no `Service.getInstance()` calls within other services).

#### Alternatives Considered

- **Global Singletons with Internal `getInstance()`:** A prevalent pattern in earlier iterations.
    - *Rejected:* Leads to tight coupling, global state, difficult testing, and obscures dependency graph.
- **Service Locator Pattern:** A central registry (`ServiceContainer`) where services register themselves and others can look them up by name.
    - *Rejected:* Still hides dependencies, making it hard to understand what a service needs without inspecting its runtime behavior. Can lead to runtime errors if services are requested before registration.
- **Setter/Property Injection:** Dependencies injected via setter methods or public properties after object creation.
    - *Rejected:* Makes it harder to guarantee that dependencies are present (nullable types proliferate), introduces an extra step in object initialization, and can lead to runtime errors if setters are not called.

#### Rationale

**Pros:**

- **Testability** — Enables easy mocking of dependencies during unit and integration testing. Services are isolated by default.
- **Clarity** — Dependencies are explicit in constructor signatures, making the codebase easier to read and understand.
- **Maintainability** — Promotes modularity and reduces coupling. Changing a dependency's implementation does not require changing its consumers.
- **Architectural Enforcement** — Reinforces SOLID principles, particularly SRP and DIP.
- **Configuration** — Simplifies runtime configuration by centralizing object creation.

**Cons:**

- **Boilerplate** — Can lead to long constructor signatures in complex services.
- **Circular Dependencies** — Requires careful design to avoid circular dependencies during wiring at the composition root (though TypeScript helps detect these).
- **Composition Root Complexity** — `bootstrap.ts` becomes a large and complex file responsible for orchestrating the entire application.

#### Consequences

- `bootstrap.ts` grew significantly, becoming the single "knowledge hub" for the entire application's wiring.
- New engineers must understand the DI pattern and consult `bootstrap.ts` to grasp the full dependency graph.
- Unit tests for services became simpler, focusing purely on business logic without mocking complex global state.
- Easier to refactor and evolve services without cascading dependency changes.
- TypeScript's static analysis strongly enforces dependency contracts, catching many wiring errors at compile time.

#### Principles Alignment

This decision directly upholds **Dependency Inversion Principle (DIP)** by forcing services to depend on abstractions rather than concrete implementations. It reinforces **Single Responsibility Principle (SRP)** by making dependencies explicit. It aligns with the "Pure core, imperative shell" pattern where `bootstrap.ts` is the imperative shell and individual services form the pure core.

<details>
<summary><strong>Implementation Details</strong></summary>
<br>

- **`packages/backend/src/bootstrap.ts`** — The core wiring logic, where all services are instantiated and passed to their consumers.

- **`packages/backend/src/app.ts`** — The `App` class constructor explicitly takes dependencies:

```typescript
export class App {
  private app: Application;
  private initialized: boolean = false;

  constructor(
    private logger: LoggerService,
    private securityConfigService: ConfigSecurityService,
  ) { /* ... */ }
}
```

- **Service Constructors** — Almost all services demonstrate constructor injection, e.g. `packages/backend/src/services/consumption.service.ts`:

```typescript
export class ConsumptionService extends CorrelationAwareService {
  constructor(
    private consumptionRepository: ConsumptionRepository,
    private sessionRepository: SessionRepository,
    private dailyStatRepository: DailyStatRepository,
    // ... many other dependencies
    logger: LoggerService,
    private outboxService: OutboxService,
    private domainEventService: DomainEventService,
    performanceMonitoringService: PerformanceMonitoringService,
    correlationTracker: CorrelationTrackerService,
    private personalizedConsumptionRateService: PersonalizedConsumptionRateService,
    private db: DatabaseService,
  ) { /* ... */ }
}
```

</details>

> **Status:** `Implemented` · **Date:** 2026-03-24 · **Reviewers:** Core Engineering Team
> **Related:** `ARCHITECTURE.MD`, `WORKER-SCALABILITY.MD`

---

### ADR-002: Transactional Outbox Pattern for Durable Eventing

#### Context

When a service needs to both update its database state and publish an event to notify other services (e.g., "consumption created" event), a "dual-write problem" arises. If the database transaction commits but the event publish fails (or vice-versa), the system enters an inconsistent state (e.g., data is updated but other services are unaware, or an event is published for an uncommitted change). This leads to:

- Data integrity issues and eventual consistency failures for derived data
- Difficult debugging due to partial state changes
- Increased complexity in recovery from failures

This was especially critical for high-volume operations like health data ingestion and core entity CRUD.

#### Decision

The **Transactional Outbox Pattern** was implemented for all critical domain events where atomicity between database state changes and event publishing is paramount. A dedicated `OutboxService` manages an `OutboxEvent` table (in PostgreSQL), ensuring that events are written to the outbox within the *same database transaction* as the primary business data change. A separate, asynchronous `OutboxProcessorService` then polls the `OutboxEvent` table and dispatches these events.

#### Alternatives Considered

- **Direct Event Emission (Fire-and-Forget):** Publishing events directly to an in-memory event bus (`DomainEventService`) or message queue (e.g., Redis Pub/Sub) *after* the database transaction commits.
    - *Rejected:* Prone to dual-write inconsistencies. If the service crashes between DB commit and event publish, the event is lost.
- **Two-Phase Commit (2PC):** Coordinating a distributed transaction across the database and a message queue.
    - *Rejected:* High complexity, performance overhead, and not all message queues support 2PC. Introduces external system coupling into the transaction.
- **Change Data Capture (CDC):** Using a database's transaction log (e.g., PostgreSQL WAL) to extract and publish events.
    - *Rejected:* Higher infrastructure complexity (requires specialized CDC tools like Debezium), increased operational overhead, and tighter coupling to database internals.

#### Rationale

**Pros:**

- **Atomicity** — Guarantees that the event is published if and only if the primary database transaction commits, ensuring strong consistency for the source data and at-least-once delivery for events.
- **Resilience** — Events persist in the outbox table even if the event dispatcher crashes, ensuring they are eventually processed.
- **Decoupling** — Primary services remain decoupled from the event dispatch mechanism.
- **Auditability** — The `OutboxEvent` table provides an audit log of all outgoing events.

**Cons:**

- **Increased Latency** — Events are not published instantly; there's a small delay (typically seconds) as `OutboxProcessorService` polls the `OutboxEvent` table.
- **Infrastructure Overhead** — Requires an `OutboxEvent` table and a dedicated polling processor.
- **Complexity** — Adds an extra layer of abstraction to event publishing.

#### Consequences

- Significantly improved data integrity for all derived data products (analytics, projections, predictions) that rely on domain events.
- Services now call `outboxService.addEvent(tx, ...)` within their `Prisma.$transaction` instead of `domainEventService.emitEvent()` directly.
- `OutboxProcessorService` is responsible for handling event delivery failures (retries, dead-letter queue) rather than the original service.
- Introduction of a slight delay for event propagation, though acceptable for most domain events.
- Downstream subscribers must be idempotent, as events are delivered at-least-once.

#### Principles Alignment

Strongly aligns with **CQRS** by separating the write model from event publishing. Supports **Event-Driven Architecture** principles by using events as the primary communication mechanism between loosely coupled services. The `OutboxService` implements an **Asynchronous Messaging Pattern** within the service boundaries.

<details>
<summary><strong>Implementation Details</strong></summary>
<br>

- **`packages/backend/src/services/outbox.service.ts`** — Core logic for adding and processing outbox events:

```typescript
export class OutboxService {
  // ...
  public async addEvent(
    tx: Prisma.TransactionClient,
    eventData: OutboxEventData,
  ): Promise<OutboxEvent> {
    // ... writes to tx.outboxEvent.create ...
  }
  // ...
}
```

- **`packages/backend/src/services/healthSample.service.ts`** — Demonstrates the transactional outbox for `health.samples.changed` events:

```typescript
export class HealthSampleService {
  // ...
  private createOutboxCallback( /* ... */ ): HealthIngestOutboxCallback {
    return async (tx: Prisma.TransactionClient, result: BatchUpsertResult, watermarkAfter: bigint) => {
      // ... constructs eventPayload ...
      await this.outboxRepository!.createInTransaction(tx, { /* ... eventPayload ... */ });
    };
  }
  // ...
}
```

- **`packages/backend/src/services/outbox-processor.service.ts`** — Background worker that polls the `OutboxEvent` table and dispatches events.
- **`packages/backend/prisma/schema.prisma`** — Defines the `OutboxEvent` model.

</details>

> **Status:** `Implemented` · **Date:** 2026-03-24 · **Reviewers:** Core Engineering Team
> **Related:** `ARCHITECTURE.MD`, `PROJECTION-PIPELINE.MD`, `DATA-INTEGRITY-GUARANTEES.MD`

---

### ADR-003: Health Data Ingestion Pipeline (Three-Lane Architecture)

#### Context

Ingesting health data from client platforms (HealthKit, Health Connect) presented several challenges:

- **UX Freshness** — Users expect to see their latest vital signs immediately upon opening the app.
- **Historical Backfill** — New users have years of historical data that needs to be synced without blocking the UI.
- **Deletion Detection** — Health data can be deleted or edited on the source platform, requiring efficient detection and propagation to the backend.
- **Resource Management** — Querying large date ranges or using inefficient methods can drain battery, consume excessive memory, and hit API rate limits.
- **Cross-Platform Consistency** — Ensuring identical ingestion logic and behavior across iOS (HealthKit) and Android (Health Connect), and between JS and native code.

The initial approach of a single, monolithic ingestion loop struggled to balance these conflicting requirements.

#### Decision

A **Three-Lane Ingestion Architecture** (HOT, COLD, CHANGE) was adopted:

- **HOT Lane** — Prioritizes UI freshness, using date-range queries for recent data, potentially with a two-pass strategy (first-paint + catch-up).
- **COLD Lane** — Focuses on historical backfill in bounded chunks, progressing backward from a time-cursor. Operates in the background.
- **CHANGE Lane** — Detects deletions and edits using anchored queries, updating records accordingly.

This orchestration is managed client-side by `HealthSyncService` (JS) and delegated to an `IHealthIngestionDriver` (abstracting native Swift and JS fallback implementations).

#### Alternatives Considered

- **Single Monolithic Ingestion:** A single loop attempting to do all three tasks (fetch recent, backfill history, detect changes).
    - *Rejected:* Difficult to balance UX freshness with deep backfill. High risk of UI blocking, poor resource management.
- **Time-Windowed Full Re-sync:** Periodically fetching all data within a rolling 90-day window.
    - *Rejected:* Inefficient for detecting deletions/edits (requires full diff), prone to missing data if queries time out for dense windows.
- **Push-Only from Source:** Relying entirely on HealthKit background delivery notifications.
    - *Rejected:* Not reliable enough for critical functions (notifications can be missed), doesn't cover historical backfill.

#### Rationale

**Pros:**

- **Optimized UX** — HOT lane ensures immediate display of fresh data.
- **Efficient Backfill** — COLD lane systematically backfills history in manageable chunks, preventing UI blocking.
- **Data Correctness** — CHANGE lane guarantees propagation of deletions and edits.
- **Resource Management** — Bounded queries prevent excessive battery drain and API rate limit hits.
- **Resilience** — Lane isolation ensures one lane's failure doesn't block others. Idempotent operations.
- **Cross-Platform Alignment** — Provides a unified, semantic contract for both iOS and Android ingestion.

**Cons:**

- **Increased Complexity** — Three distinct lanes require more sophisticated orchestration logic.
- **Cursor Management** — Each lane requires its own cursor (`hot_anchor`, `cold_time`, `change_anchor`) to operate independently.
- **Native/JS Driver Abstraction** — Adds an abstraction layer (`IHealthIngestionDriver`) to accommodate platform-specific implementations.
- **Operational Visibility** — Requires detailed logging and metrics per lane to monitor health and progress.

#### Consequences

- `HealthSyncService` (app-side) became a central orchestrator, managing timers, app state, network status, and routing to appropriate lanes.
- Required extending `health_ingest_cursors` table with a `scope` column (`hot_anchor`, `cold_time`, `change_anchor`).
- Development of ingestion logic is now lane-specific, requiring understanding of lane semantics.
- Significantly improved responsiveness for recent data and more reliable background backfill.
- More structured logging per lane aids in diagnosing ingestion issues.

#### Principles Alignment

Reinforces **Separation of Concerns** by clearly delineating the responsibilities of each ingestion lane. Uses **Strategy Pattern** via `IHealthIngestionDriver` for platform-specific implementations. The architecture is **Resilient** by isolating failures and supporting idempotent operations.

<details>
<summary><strong>Implementation Details</strong></summary>
<br>

- **`packages/app/src/services/health/HealthSyncService.ts`** — The main orchestrator of the three lanes on the app side.
- **`packages/app/src/services/health/HealthIngestionEngine.ts`** — The core ingestion logic (JS implementation), delegating to `HealthDataProviderAdapter`.
- **`packages/app/src/services/health/HealthKitAdapter.ts`** — The iOS-specific implementation of `HealthDataProviderAdapter`.
- **`packages/app/src/services/health/types/ingestion-driver.types.ts`** — Defines the `IHealthIngestionDriver` interface and `NativeErrorCode` enum.
- **`packages/app/src/repositories/health/HealthCursorRepository.ts`** — Manages lane-specific cursors.
- **`packages/app/src/services/health/HealthSyncCoordinationState.ts`** — Defines lane constants:

```typescript
public readonly HOT_OVERLAP_MS = 5 * 60 * 1000; // 5 minutes
public readonly COLD_CHUNK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
public readonly CHANGE_LANE_INTERVAL_MS = 21_600_000; // 6 hours
```

</details>

> **Status:** `Implemented` · **Date:** 2026-03-24 · **Reviewers:** Core Engineering Team
> **Related:** `HEALTH-INGESTION-PIPELINE.MD`, `FAILURE-MODES.MD`, `WORKER-SCALABILITY.MD`

---

### ADR-004: Health Data Watermark-Based Freshness (P0-G)

#### Context

Derived health data (e.g., daily rollups, sleep summaries, session impact) is computed asynchronously from raw health samples. This introduces a challenge: how can a client reliably know if the displayed derived data is *fresh* relative to the underlying raw data, or if it's *stale* and needs recomputation?

Relying solely on time-based TTL (e.g., "cache valid for 5 minutes") is insufficient, as new raw data could arrive seconds after a cache is generated, rendering it immediately stale. This leads to:

- Users seeing outdated insights or aggregates
- Lack of a clear mechanism to trigger recomputation
- Ambiguity between "no data" and "stale data"

#### Decision

A **Watermark-Based Freshness Model** was implemented for all derived health data products (projections):

- A `UserHealthWatermark` table stores a monotonically increasing `sequenceNumber` for each user, incremented on *any* mutation to their raw `HealthSample` data.
- Derived projection rows (e.g., `UserHealthRollupDay`, `UserSleepNightSummary`) store the `sourceWatermark` (the `sequenceNumber` active when they were computed).
- During reads, `HealthProjectionReadService` compares the `currentWatermark` against the `derivedRow.sourceWatermark`. If `currentWatermark > derivedRow.sourceWatermark`, the derived row's freshness status is overridden to `STALE`.
- The API response includes `FreshnessMeta` fields (`status`, `computedAtMs`, `sourceWatermark`, `computeVersion`).

#### Alternatives Considered

- **Time-Based TTL (Cache expiration):** Simply invalidating derived data after a fixed time.
    - *Rejected:* Inaccurate. New data could arrive well within the TTL, making the data stale but still "valid" by TTL. Conversely, no new data might arrive, leading to unnecessary recomputations.
- **Event-Driven Invalidations (Direct):** On `health.samples.changed`, directly invalidate all affected derived caches.
    - *Rejected:* For complex, multi-day aggregates, direct invalidation is difficult to scope precisely and can lead to over-invalidation (thrashing). The watermark pattern offers a lazier, pull-based invalidation.
- **Periodic Full Recomputation:** Recomputing all derived data nightly.
    - *Rejected:* Not granular enough for real-time responsiveness. Data could be stale for up to 24 hours.

#### Rationale

**Pros:**

- **Accuracy** — Precisely tracks staleness relative to source data mutations, eliminating ambiguity.
- **Efficiency** — Recomputation is triggered only when needed (data is stale or missing).
- **Transparent UI** — Provides clear signals to the frontend on whether to show "live," "updating," "stale," or "error" states.
- **Resilience** — Handles out-of-order event processing and replica lag gracefully (`assertWatermarkFreshness` defers processing if watermark is too low).
- **Auditability** — `sourceWatermark` provides a traceable link from derived data back to the state of the raw data.

**Cons:**

- **Overhead** — Requires an additional database query to fetch the current watermark on each read API call.
- **Complexity** — Adds `UserHealthWatermark` table and logic to update it on every raw data mutation.
- **Client Implementation** — Frontend must implement logic to interpret `FreshnessMeta` and trigger UI updates/refreshes.

#### Consequences

- Introduction of the `UserHealthWatermark` table and `sourceWatermark`/`status` columns on projection tables.
- `HealthSampleService` is responsible for incrementing the watermark sequence number on `health.samples.changed` events. `HealthProjectionReadService` queries the watermark and applies freshness overrides.
- All derived health data DTOs (`HealthRollupDayDto`, `SleepNightSummaryDto`, etc.) now include `freshness: ProjectionFreshnessMeta`.
- UI components consuming derived health data must adapt to handle `FreshnessStatus` (e.g., show spinners for `COMPUTING`, badges for `STALE`).

#### Principles Alignment

Reinforces **CQRS** by explicitly separating the write side (mutating `HealthSample` and `UserHealthWatermark`) from the read side (querying derived projections and the watermark). Improves **Data Integrity** by providing a robust mechanism for staleness detection.

<details>
<summary><strong>Implementation Details</strong></summary>
<br>

- **`packages/backend/prisma/schema.prisma`** — Defines `UserHealthWatermark` and `sourceWatermark`/`status` fields on projection models.
- **`packages/backend/src/repositories/user-health-watermark.repository.ts`** — Manages sequence numbers.
- **`packages/backend/src/services/healthSample.service.ts`** — Increments watermark within the transactional outbox callback:

```typescript
// excerpt from createOutboxCallback
await this.outboxRepository!.createInTransaction(tx, { /* ... eventPayload ... */ });
await this.watermarkRepo!.incrementSequenceNumberInTransaction(tx, userId, watermarkAfter);
```

- **`packages/backend/src/services/health-projection-read.service.ts`** — Applies watermark freshness overrides:

```typescript
// excerpt from applyWatermarkFreshness
const currentWatermark = await this.watermarkRepo.getSequenceNumber(userId);
if (currentWatermark > derivedMeta.sourceWatermark) {
  // Override status to STALE
}
```

- **`packages/backend/src/services/health-projection-coordinator.service.ts`** — Projection handlers use `assertWatermarkFreshness` for read-replica lag detection:

```typescript
// excerpt from HealthRollupProjectionHandler.handle
assertWatermarkFreshness(currentWatermark, payload, 'HealthRollupProjectionHandler');
```

- **`packages/shared/src/contracts/health-projection.contract.ts`** — Defines `ProjectionFreshnessMeta` and related helpers.
- **`packages/shared/src/health-config/freshness-types.ts`** — Defines `FreshnessStatus` and `FreshnessMeta` utilities.

</details>

> **Status:** `Implemented` · **Date:** 2026-03-24 · **Reviewers:** Core Engineering Team
> **Related:** `PROJECTION-PIPELINE.MD`, `OBSERVABILITY.MD`

---

### ADR-005: API Gateway Pattern and Cross-Cutting Concerns

#### Context

As the backend grew, managing cross-cutting concerns (authentication, logging, rate limiting, security headers, external service calls) within individual route handlers became cumbersome, repetitive, and error-prone. This led to:

- Duplicated code across controllers and routes
- Inconsistent application of security policies
- Difficulty in auditing and monitoring due to scattered logic
- Tight coupling of controllers to infrastructure concerns

A centralized, declarative approach was needed to ensure consistency, maintainability, and enforce global policies.

#### Decision

An **API Gateway Pattern** was implemented within the Express.js application, managed by `APIGatewayManager` and orchestrated by `MiddlewareFactory`. This centralizes the configuration and application of all cross-cutting concerns:

- **Middleware Pipeline** — All requests flow through a predefined middleware stack (`app.ts`).
- **Authentication/Authorization** — Centralized via `auth.middleware.ts`, `auth-monitoring.middleware.ts`, `authorization.middleware.ts`.
- **Logging/Correlation** — Managed by `correlationContext.middleware.ts` and `logging.middleware.ts`.
- **Rate Limiting** — Enforced by `rateLimitQueue.middleware.ts` and monitored by `rate-limit-monitoring.middleware.ts`.
- **Security Headers** — Applied by `httpsEnforcement.middleware.ts`.
- **External Service Calls** — Abstracted through `APIGatewayManager` for circuit breaking, retries, and correlation.

#### Alternatives Considered

- **Ad-hoc Middleware:** Registering middleware directly in `app.use()` calls or on individual routes without a factory pattern.
    - *Rejected:* Leads to boilerplate, inconsistencies, and makes it hard to enforce global policies or change the middleware stack order.
- **External API Gateway:** Using a dedicated service (e.g., AWS API Gateway, Nginx, Kong) outside the application.
    - *Rejected:* Adds infrastructure complexity and operational overhead for a smaller application. Current Express.js-based solution is sufficient.

#### Rationale

**Pros:**

- **Consistency** — Guarantees all requests are subject to the same set of cross-cutting concerns.
- **Maintainability** — Centralizes logic in dedicated middleware files and a factory, reducing code duplication.
- **Security** — Enforces global security policies (auth, rate limits, headers) uniformly.
- **Observability** — Integrates logging and performance monitoring at key points in the request lifecycle.
- **Decoupling** — Controllers focus solely on business logic, adhering to SRP.
- **Flexibility** — `MiddlewareFactory` allows dynamic composition of middleware chains for specific routes.

**Cons:**

- **Learning Curve** — Requires understanding the middleware factory and how the pipeline is constructed.
- **Debugging** — Tracing execution through multiple middleware layers can be challenging without proper correlation IDs.
- **Overhead** — Each request incurs the overhead of multiple middleware executions.

#### Consequences

- `bootstrap.ts` orchestrates the initialization of `APIGatewayManager` and `MiddlewareFactory`, and then passes the constructed middleware stack to `app.ts`.
- Route files now focus on defining routes and their specific validation schemas, relying on the middleware factory to provide common concerns.
- Changes to cross-cutting concerns are made in the middleware layer/factory, not in individual route handlers.
- Carefully designed middleware and optimized services (e.g., Redis for caching/rate limiting) mitigate the overhead.
- `correlationContext.middleware.ts` is crucial for tracing requests through the extensive middleware pipeline.

#### Principles Alignment

Strongly reinforces **Separation of Concerns** by extracting cross-cutting concerns from business logic. Promotes **Modularity** and **Maintainability** by centralizing configuration and application of middleware. The use of factories adheres to **Dependency Inversion Principle (DIP)**.

<details>
<summary><strong>Implementation Details</strong></summary>
<br>

- **`packages/backend/src/app.ts`** — Main Express app configuration where the middleware stack is applied:

```typescript
// excerpt from setupMiddleware
public async setupMiddleware(middleware: MiddlewareStack): Promise<void> {
  this.app.use(helmet({ /* ... */ }));
  this.app.use(compression({ /* ... */ }));
  this.app.use(cors(corsConfig));
  this.app.use(middleware.httpsEnforcement);
  this.app.use(middleware.correlationContext);
  this.app.use(middleware.serverTime); // ADR-017
  this.app.use(middleware.apiGateway);
  this.app.use(middleware.requestLogging);
  // ... and many more
}
```

- **`packages/backend/src/core/middleware-factory.ts`** — Factory responsible for creating all middleware instances with their dependencies.
- **`packages/backend/src/api/v1/middleware/correlationContext.middleware.ts`** — Initializes correlation ID for tracing.
- **`packages/backend/src/api/v1/middleware/auth.middleware.ts`** — Handles JWT authentication logic.
- **`packages/backend/src/api/v1/middleware/rateLimitQueue.middleware.ts`** — Enforces API rate limits.
- **`packages/backend/src/api/v1/middleware/server-time.middleware.ts`** — Adds `Server-Time` header (ADR-017).

</details>

> **Status:** `Implemented` · **Date:** 2026-03-24 · **Reviewers:** Core Engineering Team
> **Related:** `ARCHITECTURE.MD`, `SECURITY-COMPLIANCE.MD`, `OBSERVABILITY.MD`

---

### ADR-006: Client-Generated IDs for Idempotent Entity Sync

#### Context

In an offline-first mobile application, clients often create new entities (e.g., a `Consumption`, `Purchase`, `Device`) locally while disconnected. When the client later syncs, these entities are pushed to the backend. Without a robust mechanism to identify these client-generated entities:

- **Duplicate Records** — Retrying a failed `CREATE` could lead to multiple identical server-side records.
- **Inconsistent ID Mapping** — The backend might generate its own UUIDs, making it difficult for the client to map local IDs to server IDs.
- **Referential Integrity** — Dependent entities would have broken foreign keys if the parent's ID changed on the server.

#### Decision

The system adopted **client-generated UUIDs** for key entities (`Consumption`, `Purchase`, `Device`, `JournalEntry`, `Product`, `InventoryItem`) as the primary identifier. These client-generated UUIDs are stored in specific `client...Id` columns (e.g., `clientConsumptionId`, `clientPurchaseId`) and used for **idempotent `CREATE` operations**.

Upon successful server-side processing, the backend's internal UUID (which might be the client-generated UUID or a server-assigned one if an existing entity was found) is returned to the client for canonical mapping. This allows the client to update its local primary key and FK references.

#### Alternatives Considered

- **Server-Generated IDs Only:** Client sends data without an ID; server generates a new ID for every `CREATE` and returns it.
    - *Rejected:* Requires clients to manage a temporary ID mapping table, making offline-first complex. Retries become difficult without a client-side idempotency key.
- **Natural Keys for Idempotency:** Using business-domain fields (e.g., `(timestamp, userId, productId)`) as a composite key.
    - *Rejected:* Natural keys are often not globally unique, can change over time, and may not exist for all entities. UUIDs are robust and simple.
- **Using Client-Generated ID as Primary Key:** Client-generated UUID becomes the primary key in the backend.
    - *Rejected:* Tightly couples the backend's primary key strategy to the client's. The current model uses the client ID for *idempotency* but allows the backend to return its *canonical* primary key.

#### Rationale

**Pros:**

- **Robust Offline-First** — Enables clients to create data locally with globally unique identifiers without network connectivity.
- **Idempotent `CREATE` Operations** — Retrying network requests for `CREATE` is safe, preventing duplicate server-side records.
- **Simplified Client Logic** — Clients don't need complex temporary ID management.
- **Clear ID Mapping** — The backend explicitly returns the canonical server-assigned ID for the client to update its local state.
- **Error Detection** — Duplicate `client...Id` values can indicate client-side bugs or concurrency issues.

**Cons:**

- **Database Overhead** — Requires an extra `client...Id` column and unique index for each entity type.
- **Client Implementation** — Clients must reliably generate and store UUIDs for new records.
- **Backend Complexity** — Backend handlers must explicitly check for `client...Id` on `CREATE` and handle unique constraint violations.
- **Semantic Drift** — If clients *fail* to provide these IDs, the backend auto-generates them, which breaks the original idempotency contract for that client, leading to `[RISK]: duplicate records` in corner cases.

#### Consequences

- `prisma/schema.prisma` defines `clientConsumptionId`, `clientPurchaseId`, `clientEntryId`, etc., with unique indexes.
- `PurchaseService.createPurchase`, `ConsumptionService.createConsumption`, `JournalService.createJournalEntry` explicitly handle `client...Id` for deduplication.
- `CreateConsumptionSchema`, `CreatePurchaseSchema`, `CreateJournalEntrySchema` (from `@shared/contracts`) include `client...Id` fields, making them mandatory for new entities.
- `SyncService.processPushSync` tracks `clientId` and `serverId` mappings to ensure FK references are correctly updated during cascade operations.

#### Principles Alignment

Supports **Idempotency** as a key principle for distributed systems. Facilitates an **Offline-First Architecture** and promotes **Resilience** against network failures. By making client IDs part of the contract, it encourages a **Contract-First Development** approach.

<details>
<summary><strong>Implementation Details</strong></summary>
<br>

- **`packages/backend/prisma/schema.prisma`:**

```prisma
model Consumption {
  // ...
  clientConsumptionId String? @map("client_consumption_id")
  // ...
  @@unique([userId, clientConsumptionId], name: "user_clientConsumptionId_unique")
}
```

- **`packages/backend/src/services/purchase.service.ts`** — `createPurchase` method handles `clientPurchaseId`:

```typescript
// excerpt from createPurchase
const purchaseId = uuidv4();
const clientPurchaseIdProvided = !!data.clientPurchaseId;
const clientPurchaseId = data.clientPurchaseId || uuidv4(); // Generate if not provided

const result = await retryWithBackoff(async () => {
  return await this.db.getClient().$transaction(async (tx) => {
    // ... createWithOutboxEvent handles INSERT ... ON CONFLICT DO NOTHING ...
  });
});
```

- **`packages/shared/src/contracts/health.contract.ts`** — Defines `BatchUpsertSamplesRequest.requestId` for batch-level idempotency and `sourceRecordId` for sample-level idempotency.

</details>

> **Status:** `Implemented` · **Date:** 2026-03-24 · **Reviewers:** Core Engineering Team
> **Related:** `SYNC-ENGINE.MD`, `DATA-INTEGRITY-GUARANTEES.MD`, `FAILURE-MODES.MD`

---

### ADR-007: Configurable Conflict Resolution Strategies

#### Context

In a multi-device, offline-first sync system, concurrent modifications to the same entity inevitably lead to conflicts. Without clear, deterministic rules:

- **Data Loss** — One device's changes might silently overwrite another's.
- **Inconsistent State** — Devices could end up with different versions of the same entity.
- **User Confusion** — Unpredictable behavior when syncing.
- **Developer Burden** — Manual, ad-hoc merge logic in each handler leads to inconsistencies and bugs.

The absence of a centralized, configurable conflict resolution policy made the sync engine fragile and hard to extend.

#### Decision

A **Configurable Conflict Resolution System** was adopted, formalizing merge strategies and field-level policies:

- Conflict strategies (`SERVER_WINS`, `CLIENT_WINS`, `LAST_WRITE_WINS`, `MERGE`, `MANUAL`) and field policies (`LOCAL_WINS`, `SERVER_WINS`, `MERGE_ARRAYS`, `MONOTONIC`, `MAX_VALUE`, `SERVER_DERIVED`) are centrally defined in `@shared/sync-config/conflict-strategies.ts`.
- Each `EntityType` has a specific `EntityConflictConfig` in `@shared/sync-config/conflict-configs.ts` that specifies its default strategy, field-level overrides, and server-derived fields.
- The `SyncService` utilizes the **Strategy Pattern** with `SyncEntityHandler` interfaces. Generic conflict resolution logic in `SyncService.resolveConflictStrategy` applies these configurations.

#### Alternatives Considered

- **Hardcoded Merge Logic (per entity):** Implementing `merge()` methods directly in each entity handler with custom logic.
    - *Rejected:* Led to boilerplate, inconsistencies, and made it difficult to audit or change merge behavior globally.
- **Client-Side Resolution Only:** Always returning conflicts to the client for user resolution.
    - *Rejected:* High friction for users, impractical for frequent background syncs.
- **Last-Write-Wins (Global Default):** A simple, universal policy where the most recent change always prevails.
    - *Rejected:* Too blunt for complex entities. Could lead to loss of important fields.

#### Rationale

**Pros:**

- **Consistency** — Ensures all entity types resolve conflicts according to a predefined, auditable policy.
- **Flexibility** — Allows fine-grained control over how individual fields merge (e.g., local wins for notes, max for counters, union for tags).
- **Extensibility** — Adding new entity types requires defining their `EntityConflictConfig`, not rewriting core merge logic.
- **Maintainability** — Centralizes policy definition, simplifies review, and reduces errors.
- **Transparency** — Explicit policies make conflict resolution predictable.
- **Shared Contract** — `@shared/sync-config` ensures frontend and backend use identical rules.

**Cons:**

- **Complexity** — Defining detailed policies for numerous fields adds configuration overhead.
- **Learning Curve** — Requires understanding the policy types and how they interact.
- **Performance** — Field-by-field merging can be slightly slower than a blunt "last write wins" for very large entities, but necessary for data integrity.

#### Consequences

- Creation of `@shared/sync-config/conflict-strategies.ts` and `conflict-configs.ts` as the authoritative source. `SyncService` became more generic, delegating entity-specific logic to `SyncEntityHandler` implementations.
- Engineers now define conflict behavior declaratively in config files, rather than imperatively in code.
- Easier to test merge logic for specific fields by providing mock local/server entities and expected merged outputs.
- The API exposes `ConflictStrategy` and expects `resolvedData` for manual merges.
- Reduced semantic drift between frontend and backend due to shared configurations.

#### Principles Alignment

Reinforces **Separation of Concerns** by separating conflict resolution policy (config) from implementation logic (generic resolver). Adheres to the **Strategy Pattern** and **Open/Closed Principle** by allowing new entity types to extend the system without modifying core sync logic. Promotes **Idempotency** by ensuring predictable outcomes on retries.

<details>
<summary><strong>Implementation Details</strong></summary>
<br>

- **`packages/shared/src/sync-config/conflict-strategies.ts`** — Defines `CONFLICT_STRATEGY`, `FIELD_POLICY`, and `IdStrategy`.
- **`packages/shared/src/sync-config/conflict-configs.ts`** — Registry mapping `EntityType` to its `EntityConflictConfig`:

```typescript
// excerpt from SESSIONS_CONFIG
const SESSIONS_CONFIG: EntityConflictConfig = {
  defaultStrategy: CONFLICT_STRATEGY.MERGE,
  fieldPolicies: [
    { field: 'purchaseId', policy: FIELD_POLICY.SERVER_WINS },
    { field: 'notes', policy: FIELD_POLICY.LOCAL_WINS },
    { field: 'status', policy: FIELD_POLICY.MONOTONIC, transitions: ['ACTIVE', 'PAUSED', 'CANCELLED', 'COMPLETED'] },
  ],
  serverDerivedFields: ['eventCount', 'totalDurationMs', 'sessionStartTimestamp'],
  conflictFree: false,
  requiresCustomMerge: true,
  idStrategy: ID_STRATEGY.PRIMARY_KEY_IS_SERVER_ID,
};
```

- **`packages/backend/src/services/sync.service.ts`** — Entity processing methods delegate to `SyncEntityHandler`s. `resolveConflictStrategy` applies the config.
- **`packages/backend/src/services/sync/handlers/session.handler.ts`** — Example of a concrete `SyncEntityHandler` with custom merge logic for sessions.

</details>

> **Status:** `Implemented` · **Date:** 2026-03-24 · **Reviewers:** Core Engineering Team
> **Related:** `SYNC-ENGINE.MD`, `DATA-INTEGRITY-GUARANTEES.MD`

---

### ADR-008: Optimistic Locking for Data Integrity

#### Context

In a distributed, multi-device, offline-first environment, multiple clients or backend services can attempt to modify the same entity concurrently. Without a mechanism to detect and prevent conflicting updates:

- **Lost Updates** — A user's changes on one device might be silently overwritten by an older version from another device.
- **Data Inconsistency** — The database state does not reflect the intended logical sequence of operations.
- **Debugging Complexity** — Hard to trace why data appears corrupted or outdated.

#### Decision

**Optimistic Locking** was implemented for all syncable entities:

- A `version` integer column was added to all relevant Prisma models (`User`, `Product`, `Consumption`, `Session`, `JournalEntry`, etc.).
- During an `UPDATE` operation, the client provides the `expectedVersion` (the version it last read).
- The backend's `BaseRepository.update` method performs a conditional update: `UPDATE ... WHERE id = [id] AND version = [expectedVersion]`.
- If a `version` mismatch occurs, the update fails, signaling a `CONFLICT` (HTTP 409) to the caller.

#### Alternatives Considered

- **Pessimistic Locking:** Using database locks (`SELECT FOR UPDATE`) to prevent concurrent access.
    - *Rejected:* Introduces contention, reduces concurrency, and is less suitable for long-running, disconnected operations typical of mobile sync.
- **Last-Write-Wins (Implicit):** Simply update the record without version checks.
    - *Rejected:* Leads to lost updates and data corruption. Explicitly rejected for data integrity.
- **Timestamp-Based Last-Write-Wins:** Using `updatedAt` timestamps for conflict detection.
    - *Rejected:* Timestamps can suffer from clock skew between client devices and servers. `version` numbers are atomic and deterministic.

#### Rationale

**Pros:**

- **Data Integrity** — Prevents lost updates, ensuring that every valid modification is preserved or explicitly resolved.
- **High Concurrency** — Does not hold database locks, allowing multiple clients to read concurrently.
- **Simple Implementation** — Relatively straightforward with a `version` column and conditional `UPDATE`.
- **Clear Conflict Signal** — Explicitly returns HTTP 409 when a version mismatch occurs.

**Cons:**

- **Client-Side Awareness** — Clients must be aware of the `version` field and include it in `UPDATE` requests.
- **Increased Conflict Rate** — For highly contentious data, this could lead to more frequent conflicts (though this indicates a legitimate concurrency issue).
- **Developer Workflow** — Requires engineers to include `version` in `UPDATE` operations and handle `CONFLICT` errors.

#### Consequences

- `prisma/schema.prisma` now includes a non-nullable `version` integer column (default `1`) on all syncable models.
- `BaseRepository.update` (and all derived repositories) automatically handle incrementing the `version` and using it in `WHERE` clauses.
- `Update...Schema` (from `@shared/contracts`) for all syncable entities include an optional `version` field.
- `SyncService.detectConflict` explicitly compares `clientVersion` with `serverVersion`.
- Clients must fetch the `version` along with the entity and include it in subsequent `UPDATE` payloads.

#### Principles Alignment

Reinforces **Data Integrity** and **Resilience** in a distributed system. Promotes **Explicit Design** by making conflict detection a first-class concern. Aligns with **SRP** by encapsulating the locking logic within the repository layer.

<details>
<summary><strong>Implementation Details</strong></summary>
<br>

- **`packages/backend/prisma/schema.prisma`** — The `version` column in models:

```prisma
model User {
  // ...
  version Int @default(1)
  // ...
}
```

- **`packages/backend/src/repositories/base.repository.ts`** — The `update` method handles optimistic locking:

```typescript
// excerpt from update method
const updated = await tx[this.modelName].update({
  where: { id: id, version: updateData.expectedVersion }, // Conditional update
  data: {
    ...prismaUpdateData,
    version: { increment: 1 }, // Increment version
    updatedAt: new Date(),
  },
});
```

- **`packages/backend/src/services/sync.service.ts`** — `detectConflict` method checks `serverVersion` against `clientVersion`.
- **`packages/shared/src/contracts/sync-config/conflict-configs.ts`** — `EntityConflictConfig` for each entity details `idStrategy` and `monotonicFields`.

</details>

> **Status:** `Implemented` · **Date:** 2026-03-24 · **Reviewers:** Core Engineering Team
> **Related:** `SYNC-ENGINE.MD`, `DATA-INTEGRITY-GUARANTEES.MD`, `FAILURE-MODES.MD`

---

### ADR-009: Cursor-Based Pagination for Incremental Sync

#### Context

The initial sync implementation used offset-based pagination (`OFFSET`/`LIMIT`). This approach is problematic for large, frequently changing datasets:

- **Performance Degradation** — `OFFSET` queries require the database to scan all rows up to the offset, leading to O(N) performance for deep pages.
- **Data Skew/Missing Data** — Concurrent writes during pagination can cause rows to be skipped or duplicated.
- **Scalability** — Not suitable for high-volume, real-time sync scenarios.

These issues directly impacted sync reliability and performance, especially for users with extensive historical data.

#### Decision

**Keyset (Cursor-Based) Pagination** was implemented for fetching incremental changes (`GET /sync/changes`):

- The cursor is an opaque, base64-encoded string containing a composite key (`lastCreatedAt`, `lastId`) from the last record of the previous page.
- Queries use `WHERE (createdAt > [lastCreatedAt] OR (createdAt = [lastCreatedAt] AND id > [lastId])) ORDER BY createdAt ASC, id ASC LIMIT [limit]`.
- The `SyncService` encodes and decodes cursors using strict Zod schemas defined in `@shared/sync-config/cursor.ts`.
- `GET /health/samples/cursor` also adopted this pattern.

#### Alternatives Considered

- **Offset-Based Pagination (`OFFSET`/`LIMIT`):** The existing solution.
    - *Rejected:* Performance degrades on deep pages, susceptible to data skew during concurrent writes, not scalable.
- **GraphQL Cursor Connections (Relay-style):** A standardized way to implement cursor pagination with GraphQL.
    - *Rejected:* Backend is REST-based. Introducing GraphQL solely for pagination would be overkill.
- **Timestamp-Only Cursor:** Using only `lastCreatedAt` for the cursor.
    - *Rejected:* Not robust enough. Multiple records with the same `createdAt` timestamp (common for batch operations) would lose tie-breaking logic.

#### Rationale

**Pros:**

- **Performance** — O(1) or O(log N) regardless of page depth, as the database jumps directly to the cursor position.
- **Data Integrity** — Immune to data skew from concurrent writes, ensuring consistent pagination.
- **Scalability** — Highly scalable for high-volume incremental sync operations.
- **Deterministic** — Cursor logic is deterministic, ensuring repeatable results.
- **Shared Contract** — `@shared/sync-config/cursor.ts` guarantees identical encoding/decoding on frontend and backend.

**Cons:**

- **Complexity** — Requires more complex query logic for building `WHERE` clauses with composite keys.
- **Opaque Cursor** — Cursors are opaque to clients, limiting their ability to "jump to page N."
- **Debugging** — Debugging corrupt or malformed cursors can be challenging without proper error reporting.
- **Client Implementation** — Clients must adapt to cursor-based pagination logic (storing `nextCursor`, looping until `hasMore`).

#### Consequences

- `GET /sync/changes` and `GET /health/samples/cursor` APIs now return a `cursor` and `hasMore` field instead of `page`, `total`, `totalPages`.
- Introduction of `@shared/sync-config/cursor.ts` for cursor types, encoding, and decoding.
- `SyncChangeRepository` and `HealthSampleRepository` implemented specific methods for cursor-based queries.
- Requires new mental models for sync (cursors instead of page numbers). `InvalidCursorError` is a common error type.
- Significantly improved sync performance for users with large datasets.

#### Principles Alignment

Reinforces **Performance Optimization** and **Scalability**. Promotes **Data Integrity** by ensuring reliable pagination. The strict cursor contract adheres to **Contract-First Development** and **Robustness Principle**.

<details>
<summary><strong>Implementation Details</strong></summary>
<br>

- **`packages/shared/src/sync-config/cursor.ts`** — Defines `EntityCursor`, `CompositeCursor`, encoding/decoding functions:

```typescript
// excerpt from decodeCompositeCursor
export function decodeCompositeCursor(encoded: string): CompositeCursor {
  // ... base64 decoding ...
  // ... JSON parsing ...
  const result = CompositeCursorSchema.safeParse(parsed);
  if (!result.success) {
    throw new InvalidCursorError(encoded, 'Schema validation failed', result.error);
  }
  return result.data;
}
```

- **`packages/backend/src/api/v1/controllers/sync.controller.ts`** — `getIncrementalChanges` method.
- **`packages/backend/src/repositories/sync-change.repository.ts`** — `getChangesSince` method using `WHERE (createdAt > ? OR (createdAt = ? AND id > ?))` clause.
- **`packages/backend/src/api/v1/schemas/sync.schemas.ts`** — `syncChangesSchema` defines cursor validation.

</details>

> **Status:** `Implemented` · **Date:** 2026-03-24 · **Reviewers:** Core Engineering Team
> **Related:** `SYNC-ENGINE.MD`, `WORKER-SCALABILITY.MD`

---

### ADR-010: Health Data Privacy Gating

#### Context

Health data is Protected Health Information (PHI) subject to stringent privacy regulations (e.g., HIPAA). Users must have explicit control over how their health data is collected, processed, and used. Without a robust, server-side enforcement mechanism:

- **Privacy Violations** — Accidental ingestion of data types a user has explicitly blocked.
- **Compliance Risks** — Failure to meet regulatory requirements for user data control.
- **Erosion of Trust** — Users losing confidence if their privacy preferences are not honored.

The initial ingestion pipeline lacked a centralized server-side privacy check, relying solely on client-side permission handling.

#### Decision

A **Server-Side Privacy Gating** mechanism was implemented in `HealthSampleService`. Before any batch of health samples is processed or stored, the service:

- Fetches the user's `privacySettings` (stored in the `User` model as a JSONB column).
- Parses a nested `health` object within `privacySettings` to retrieve `allowHealthDataUpload` (global toggle) and `blockedMetrics` (an array of `metricCode`s).
- Rejects the entire batch with a `FORBIDDEN` error if `allowHealthDataUpload` is false.
- Filters out individual samples whose `metricCode` is in `blockedMetrics`, returning them as `PRIVACY_BLOCKED` failures in the batch response.

#### Alternatives Considered

- **Client-Side Enforcement Only:** Relying solely on the mobile client to respect privacy settings.
    - *Rejected:* Insufficient for robust privacy enforcement. Clients can be buggy, compromised, or outdated.
- **Post-Ingestion Filtering:** Ingesting all data and then filtering for privacy *after* storage but *before* processing.
    - *Rejected:* Inefficient (ingests unwanted data), higher storage cost, and creates a privacy risk as the data temporarily resides in the database.
- **Separate UserHealthPreference Table:** Storing health-specific privacy settings in a dedicated table.
    - *Rejected:* Increased schema complexity for a relatively small, JSON-serializable preference set. JSONB on `User` is sufficient and more flexible.

#### Rationale

**Pros:**

- **Regulatory Compliance** — Directly addresses HIPAA and other privacy regulations.
- **Robust Enforcement** — Guarantees user privacy preferences are honored server-side, regardless of client behavior.
- **User Trust** — Builds user confidence by providing clear, enforceable control.
- **Efficiency** — Filters unwanted data at the ingestion boundary.
- **Flexibility** — JSONB column allows easy evolution without schema migrations.

**Cons:**

- **Performance Overhead** — Requires a database read (user profile) and JSONB parsing on every health batch upload. Mitigated by careful indexing and caching.
- **Complexity** — Adds logic to `HealthSampleService` to fetch, parse, and enforce privacy settings.
- **Client Communication** — Client needs to understand `PRIVACY_BLOCKED` error codes and provide appropriate UI feedback.

#### Consequences

- The `User` model in `prisma/schema.prisma` has a `privacySettings` JSONB column. `ExtendedUserPrivacySettingsSchema` and `HealthPrivacySettingsSchema` define the expected JSON structure.
- `HealthSampleService.batchUpsertSamples` now calls `assertHealthUploadAllowed` and `filterBlockedMetrics`.
- `BatchUpsertSamplesResponseSchema` includes `PRIVACY_BLOCKED` as a `SampleErrorCode`.
- Clients must handle `PRIVACY_BLOCKED` errors in `HealthUploadEngine` and inform the user.

#### Principles Alignment

Directly upholds **Privacy by Design** and **Security by Design** principles. Reinforces **Separation of Concerns** by encapsulating privacy enforcement within a dedicated layer. Improves **Robustness** by adding a server-side trust boundary.

<details>
<summary><strong>Implementation Details</strong></summary>
<br>

- **`packages/backend/src/services/healthSample.service.ts`** — `assertHealthUploadAllowed` and `filterBlockedMetrics` methods:

```typescript
// excerpt from batchUpsertSamples
const privacySettings = await this.assertHealthUploadAllowed(userId, requestId, samples.length);

if (privacySettings.blockedMetrics && privacySettings.blockedMetrics.length > 0) {
  const filterResult = this.filterBlockedMetrics(samples, privacySettings.blockedMetrics);
  samplesToProcess = filterResult.allowed;
  // ... push PRIVACY_BLOCKED failures ...
}
```

- **`packages/shared/src/contracts/health.contract.ts`** — Defines `HealthPrivacySettingsSchema` and `SampleErrorCode.PRIVACY_BLOCKED`.
- **`packages/backend/src/models/index.ts`** — Defines `ExtendedUserPrivacySettingsSchema` for JSONB parsing.

</details>

> **Status:** `Implemented` · **Date:** 2026-03-24 · **Reviewers:** Core Engineering Team
> **Related:** `SECURITY-COMPLIANCE.MD`, `DATA-INTEGRITY-GUARANTEES.MD`

---

### ADR-011: Health Sample Payload Hash for Request Idempotency

#### Context

The batch upsert endpoint (`POST /health/samples/batch-upsert`) relies on a `requestId` for request-level idempotency. However, simply using `requestId` is insufficient for robust protection against:

- **Data Tampering** — A malicious actor (or buggy client) could reuse an old `requestId` with a *modified* payload, leading to data corruption.
- **Client Bugs** — A client might accidentally send different samples under the same `requestId` (e.g., due to local state corruption).

Without verifying payload integrity, the `requestId` alone provided incomplete idempotency.

#### Decision

A **Payload Hash** (`payloadHash`) was introduced in the `BatchUpsertSamplesRequest` contract:

- Clients compute a SHA-256 hash of the **canonicalized** samples (and deletions) array using `computeBatchPayloadHash` from `@shared/health-config/payload-hash.ts`.
- This `payloadHash` is sent alongside the `requestId`.
- The backend's `health.routes.ts` validation middleware verifies that the received `payloadHash` *exactly matches* the hash computed from the incoming `samples` and `deleted` arrays.
- A `configVersion` field handles backward compatibility for deletion hashing (specifically, `startAt` for precise deletion identity).

#### Alternatives Considered

- **`requestId` Only:** Relying solely on `requestId` for idempotency.
    - *Rejected:* Vulnerable to data tampering and client bugs.
- **Server-Side Content Hashing:** Server computes hash internally and stores it with the `requestId`.
    - *Rejected:* Client wouldn't know if content changed without server re-hashing. Less efficient.
- **Stronger Cryptographic Signatures:** Using client-side digital signatures for the entire payload.
    - *Rejected:* Overkill for the current threat model. SHA-256 hash provides sufficient integrity for idempotency.

#### Rationale

**Pros:**

- **Data Integrity** — Guarantees batch content remains unchanged across retries for the same `requestId`.
- **Security** — Detects accidental or malicious data tampering.
- **Robust Idempotency** — Provides a strong, cryptographic guarantee for request-level idempotency.
- **Deterministic** — The canonicalization algorithm ensures the same set of samples (regardless of order) always produces the same hash.
- **Backward Compatibility** — `configVersion` allows the hash algorithm to evolve while maintaining compatibility.

**Cons:**

- **Client-Side Complexity** — Clients must implement SHA-256 hashing and deterministic JSON canonicalization.
- **CPU Overhead** — Hash computation adds a small CPU overhead per request.
- **Payload Size** — Adds 64 bytes for the hash string to each batch request.

#### Consequences

- `BatchUpsertSamplesRequestSchema` (from `@shared/contracts`) now includes `payloadHash` (mandatory) and `configVersion` (optional). `DeletionItemSchema` includes optional `startAt`.
- Introduction of `@shared/health-config/payload-hash.ts` with `computeBatchPayloadHash` and `verifyBatchPayloadHash`.
- Mobile clients (`HealthUploadEngine`) must implement hash computation for outgoing requests.
- `health.routes.ts` includes `createBatchUpsertValidationMiddleware` to verify the hash.
- `BatchValidationError` with `PAYLOAD_HASH_MISMATCH` is thrown on verification failure.

#### Principles Alignment

Reinforces **Data Integrity** and **Security by Design**. Ensures **Idempotency** is cryptographically robust and promotes **Contract-First Development** through shared hashing logic.

<details>
<summary><strong>Implementation Details</strong></summary>
<br>

- **`packages/shared/src/health-config/payload-hash.ts`** — Canonicalization and hashing functions:

```typescript
// excerpt from computeBatchPayloadHash
export async function computeBatchPayloadHash(input: BatchPayloadHashInput): Promise<string> {
  const { samples, deleted = [], configVersion = 1 } = input;
  const sortedSamples = canonicalizeSamplesForHash(samples);
  const sortedDeleted = canonicalizeDeletionsForHash(deleted, configVersion);
  const combinedPayload = { samples: sortedSamples, deleted: sortedDeleted };
  return computePayloadHash(combinedPayload as CanonicalPayload);
}
```

- **`packages/shared/src/contracts/health.contract.ts`** — Defines `BatchUpsertSamplesRequestSchema` and `PayloadHashSchema`.
- **`packages/backend/src/api/v1/routes/health.routes.ts`** — `createBatchUpsertValidationMiddleware` calls `validateBatchUpsertRequestWithHash`.
- **`packages/backend/src/services/health/HealthUploadEngine.ts`** — Calls `computeBatchPayloadHash` before sending requests.

</details>

> **Status:** `Implemented` · **Date:** 2026-03-24 · **Reviewers:** Core Engineering Team
> **Related:** `SECURITY-COMPLIANCE.MD`, `DATA-INTEGRITY-GUARANTEES.MD`, `FAILURE-MODES.MD`

---

### ADR-012: Session Telemetry Precomputation and Caching (P0-G.1)

#### Context

Displaying health vitals for a past consumption session (e.g., heart rate, HRV before, during, and after) is a critical UI feature. Naively querying raw `HealthSample` data for each request is problematic:

- **High Latency** — Joins across thousands of raw samples on every API request.
- **Computational Overhead** — On-the-fly downsampling and aggregation is CPU-intensive.
- **Inconsistent Data** — Without caching, different requests could return slightly different aggregates.
- **Mobile Bandwidth** — Fetching raw data for client-side aggregation is inefficient.

#### Decision

**Session Telemetry Precomputation and Caching** was implemented:

- Derived, downsampled health data for each completed session is precomputed by `SessionTelemetryService` and stored in `SessionTelemetryCache`.
- Computation is triggered asynchronously by `session.ended` domain events (via `SessionTelemetrySubscriber` and `SessionTelemetryQueueService`).
- The `SessionTelemetryService` API (`getSessionTelemetry`) prioritizes fetching from cache. On a cache miss, it returns a `COMPUTING` state (with a `retryAfterSeconds` hint) and triggers async recomputation via `BoundedComputeCoordinator`.
- Cache entries use **watermark-based freshness** (`sourceWatermark`) for staleness detection.

#### Alternatives Considered

- **On-Demand Computation Only:** Computing telemetry from raw samples on every API request.
    - *Rejected:* High latency, high CPU/DB load, inconsistent results, poor UX.
- **Client-Side Computation:** Fetching raw samples for client-side downsampling/aggregation.
    - *Rejected:* High mobile bandwidth/battery usage, increased client complexity.
- **Materialized Views in PostgreSQL:** Creating SQL materialized views for session telemetry.
    - *Rejected:* Less flexible for dynamic windowing/resolution, complex to manage per-session state.

#### Rationale

**Pros:**

- **API Performance** — Sub-second response times (cache hits are O(1)).
- **Reduced Load** — Minimizes queries against raw `HealthSample` table.
- **Consistent Data** — Cached results ensure all clients see the same aggregates.
- **Scalability** — Computation is offloaded to background workers.
- **UI Responsiveness** — Returns `COMPUTING` state instantly on cache miss, improving perceived performance.
- **Freshness** — Watermark-based staleness ensures data is consistent with source mutations.

**Cons:**

- **Complexity** — Requires a new table, background jobs, a queue service, and a sophisticated cache workflow.
- **Eventual Consistency** — A brief delay exists between `session.ended` and the cache becoming `READY`.
- **Infrastructure Overhead** — Requires BullMQ workers and potentially more Redis memory.
- **Data Size** — Storing aggregated telemetry (JSONB) increases database size.

#### Consequences

- `prisma/schema.prisma` defines `SessionTelemetryCache` model with `metricsJson` (JSONB) and `sourceWatermark`.
- `SessionTelemetryService` manages cache reads, computations, and interactions with `SessionTelemetryQueueService`.
- New BullMQ jobs (`SESSION_TELEMETRY_COMPUTE`, `SESSION_TELEMETRY_LOCK_REAPER`) were introduced.
- `SessionTelemetryPayload` (from `@shared/contracts`) includes freshness metadata.
- Clients must interpret `TelemetryQueryResult.state` (`ready`, `computing`, `stale`, `error`, `no_data`) and `retryAfterSeconds`.

#### Principles Alignment

Reinforces **CQRS** by precomputing read models. Promotes **Event-Driven Architecture** for triggering computation. Ensures **Performance Optimization** and **Scalability** for the telemetry API.

<details>
<summary><strong>Implementation Details</strong></summary>
<br>

- **`packages/backend/prisma/schema.prisma`** — The `SessionTelemetryCache` model.
- **`packages/shared/src/contracts/session-telemetry.contract.ts`** — Defines `SessionTelemetryPayload`, `TelemetryResolution`, `TelemetryFreshnessMeta`.

- **`packages/backend/src/services/session-telemetry.service.ts`** — Main service:

```typescript
// excerpt from getSessionTelemetry
const cacheResult = await this.checkCache(sessionId, userId, windowMinutes, resolvedResolution);
if (cacheResult) {
    // ... return cached, trigger async recompute if stale ...
}
// ... trigger async compute and return 'computing' state ...
```

- **`packages/backend/src/services/sessionTelemetryQueue.service.ts`** — Schedules `SESSION_TELEMETRY_COMPUTE` jobs.
- **`packages/backend/src/jobs/job.types.ts`** — Defines `SessionTelemetryComputeJobData`.
- **`packages/backend/src/jobs/job-processor.ts`** — Implements `processSessionTelemetryComputeJob`.

</details>

> **Status:** `Implemented` · **Date:** 2026-03-24 · **Reviewers:** Core Engineering Team
> **Related:** `PROJECTION-PIPELINE.MD`, `WORKER-SCALABILITY.MD`

---

### ADR-013: Multi-Factor Inventory Prediction Engine

#### Context

Predicting inventory depletion and suggesting purchase timing accurately for tracked products is a complex problem. Relying on simplistic linear models leads to:

- **Inaccurate Predictions** — Ignoring variations in user consumption, routine patterns, or safety concerns.
- **Suboptimal Recommendations** — Missing opportunities for timely purchases or failing to warn about low stock.
- **Lack of Trust** — Users distrusting predictions due to poor reliability.

A more sophisticated, multi-factor approach was needed.

#### Decision

A **Multi-Factor Inventory Prediction Engine** was implemented in `InventoryPredictionService`. This service orchestrates several data sources and models:

- **EMA Learning** — `UserConsumptionProfileService` provides learned average quantity-per-event and consumption rates.
- **Temporal Patterns** — `TemporalPatternService` (Dirichlet-multinomial histogram) provides time-of-day/day-of-week consumption multipliers and routine stability.
- **Safety Factors** — `SafetyService` provides adjustments based on recent high-risk events.
- **Loss Estimation** — `UserConsumptionProfileService` provides personalized loss factors.

The service combines these factors into a single `effectiveDailyRate` to forecast depletion, assess risk, and generate purchase recommendations.

#### Alternatives Considered

- **Single-Factor Linear Regression:** Predicting depletion solely based on average daily consumption.
    - *Rejected:* Too simplistic, ignores individual variations, routines, and safety context.
- **External ML Platform (e.g., AWS SageMaker):** Building complex ML models on a dedicated platform.
    - *Rejected:* Higher cost, increased operational complexity, latency overhead.
- **Hardcoded Rules:** Using a set of static rules for predictions.
    - *Rejected:* Not personalized, not adaptive, and prone to poor accuracy.

#### Rationale

**Pros:**

- **Increased Accuracy** — Combines multiple behavioral signals for robust, personalized predictions.
- **Context-Aware** — Integrates temporal routines and safety concerns.
- **Transparency** — `PredictionExplain` provides a breakdown of contributing factors, improving user trust.
- **Extensibility** — New prediction factors can be added as modular strategies.
- **Scalability** — Uses lightweight statistical models directly in the backend.

**Cons:**

- **Increased Complexity** — Orchestrating multiple services and models adds significant logic.
- **Cold Start Problem** — Requires sufficient user data for confident predictions. `[MITIGATION]:` Fallback to inventory-only predictions.
- **Debugging** — Tracing prediction logic through multiple factors can be challenging.

#### Consequences

- `InventoryPredictionService` became a core prediction orchestrator with `UserConsumptionProfileService`, `UserRoutineService`, `SafetyService`, and `TemporalPatternService` as dependencies.
- `@shared/contracts/prediction.contract.ts` defines `InventoryPredictionResult`, `ProductInventoryPrediction`, `PredictionExplain`, and `PurchaseRecommendation`.
- `PredictionRecord` table stores historical predictions for accuracy tracking.

#### Principles Alignment

Embraces **Composition** by combining multiple specialized services. Aligns with **SRP** by having `InventoryPredictionService` orchestrate, rather than implement, all underlying models. Promotes **Data-Driven Decision Making**.

<details>
<summary><strong>Implementation Details</strong></summary>
<br>

- **`packages/backend/src/services/inventory-prediction.service.ts`** — The main orchestrator:

```typescript
// excerpt from predictInventoryDepletion
const effectiveDailyRate = baseRate
  .mul(dampedTemporalFactor)
  .mul(computedTrendMultiplier)
  .mul(safetyAdjustment)
  .mul(lossFactor);
// ...
const predictions = this.buildPredictions(predictionBuildParams);
```

- **`packages/shared/src/contracts/prediction.contract.ts`** — Defines prediction data structures.
- **`packages/backend/src/services/user-consumption-profile.service.ts`** — Provides `learnedAvgQuantityPerEvent`.
- **`packages/backend/src/services/temporal-pattern.service.ts`** — Provides `temporalMultiplier`, `routineStability`, `temporalConfidence`.
- **`packages/backend/src/services/safety.service.ts`** — Provides safety adjustments.

</details>

> **Status:** `Implemented` · **Date:** 2026-03-24 · **Reviewers:** Core Engineering Team
> **Related:** `AI-INTEGRATION.MD`, `PROJECTION-PIPELINE.MD`

---

### ADR-014: Dirichlet-Multinomial Temporal Consumption Patterns

#### Context

The previous implementation of user routine detection relied on a Hidden Markov Model (HMM). This approach proved to be:

- **Data-Intensive** — HMMs require substantial data to train effectively, leading to poor performance for new users or sparse consumption histories.
- **Opaque** — HMM states and transitions are hard to interpret, making explanations to users difficult.
- **Complex** — Training and managing HMMs added significant complexity to `UserRoutineService`.

#### Decision

The HMM-based routine engine was retired and replaced by a **Dirichlet-Multinomial Temporal Histogram Engine** implemented in `TemporalPatternService`:

- Maintains 168-bin histograms (24 hours × 7 days-of-week) of user consumption frequency and quantity.
- Uses **exponential decay** to weight recent consumption events more heavily.
- **Bayesian posterior inference** with a Dirichlet prior provides robust probability distributions even with sparse data.
- Computes: a `temporalMultiplier` (consumption relative to average for a given time slot), `routineStability` (1 − entropy), and `confidence` (based on total decayed sessions).

#### Alternatives Considered

- **Retain HMM:** Continue with the existing HMM.
    - *Rejected:* Data-intensive, opaque, and complex — the problems this architecture solves.
- **Simpler Moving Averages:** Using standard moving averages for consumption patterns.
    - *Rejected:* Not granular enough (no time-of-day/day-of-week specificity), poor sparse data handling.
- **Neural Networks (e.g., RNNs):** Using deep learning models for sequence prediction.
    - *Rejected:* Overkill, extreme data hunger, opaque, high computational cost.

#### Rationale

**Pros:**

- **Cold Start Friendly** — Bayesian approach works well with sparse data, providing reasonable priors.
- **Interpretability** — Histograms and multipliers are much easier to understand and explain.
- **Robustness** — Exponential decay handles changing user behavior over time.
- **Simplicity** — Simpler mathematical model, reducing implementation complexity.
- **Efficiency** — Faster computation for real-time inference compared to HMM.
- **Confidence Metrics** — Provides explicit confidence scores based on decayed session count.

**Cons:**

- **Loss of State Sequence** — Does not model *transitions* between states like HMMs. Focuses solely on *when* consumption occurs.
- **Granularity** — Fixed 168 bins might not capture extremely subtle patterns.
- **Implementation Effort** — Required a complete re-implementation of routine pattern detection.

#### Consequences

- `UserRoutineService` was refactored to delegate pattern detection to `TemporalPatternService`. HMM-related code was removed.
- `UserRoutineProfile` now stores `temporalCounts`, `temporalQuantity`, `lastTemporalUpdateAt`, `totalDecayedSessions`, `priorStrength`, and `trendMultiplier`.
- `TemporalPatternSubscriber` was introduced to update the histogram on `session.ended` events.
- Improved accuracy and reliability of inventory predictions that rely on these temporal patterns.

#### Principles Alignment

Reinforces **Simplicity** and **Robustness** in model design. Aligns with **SRP** by separating routine profile management (`UserRoutineService`) from the pattern learning algorithm (`TemporalPatternService`). **Data-Driven** by directly inferring patterns from user consumption history.

<details>
<summary><strong>Implementation Details</strong></summary>
<br>

- **`packages/backend/src/services/temporal-pattern.service.ts`** — Core Dirichlet-multinomial histogram logic:

```typescript
// excerpt from updateTemporalHistogram
// Apply exponential decay
if (profile.lastTemporalUpdateAt) { /* ... */ }
// Increment bin counts with age-based weight
counts[binIndex] = (counts[binIndex] ?? 0) + sessionWeight;
quantityArr[binIndex] = (quantityArr[binIndex] ?? 0) + sessionQuantity * sessionWeight;
totalDecayed += sessionWeight;
// Compute posterior and derived metrics
const posterior = TemporalPatternService.computePosteriorDistribution(counts, priorStrength);
const temporalMultiplier = TemporalPatternService.computeMultiplier(posterior, binIndex);
```

- **`packages/backend/src/subscribers/temporal-pattern.subscriber.ts`** — Subscribes to `session.ended` events.
- **`packages/backend/src/repositories/user-routine-profile.repository.ts`** — Stores histogram data (`temporalCounts`, `temporalQuantity`).

</details>

> **Status:** `Implemented` · **Date:** 2026-03-24 · **Reviewers:** Core Engineering Team
> **Related:** `AI-INTEGRATION.MD`, `PROJECTION-PIPELINE.MD`

---

### ADR-015: BullMQ Job Payload Size Limit

#### Context

The `HealthIngestBatchJob` leverages BullMQ for asynchronous processing. BullMQ stores job data as JSON in Redis. Without explicit limits, very large payloads could lead to:

- **Redis Memory Exhaustion (OOM)** — Unbounded job data consuming excessive Redis memory, causing evictions or crashes.
- **ioredis Socket Failures (EPIPE/ECONNRESET)** — Overly large JSON writes to Redis causing socket errors.
- **Job Processing Deadlocks** — If enqueueing fails *after* `HealthIngestRequest` is created but *before* the job enters the queue, the request remains stuck in "PROCESSING."

#### Decision

A **hard payload size limit of 5MB** was imposed on `HealthIngestBatchJobData` within the `HealthIngestQueueService`:

- Before enqueueing, the service serializes the job data and checks its byte length.
- If the payload exceeds 5MB, the job is rejected, the `HealthIngestRequest` is marked `FAILED`, and an `AppError(413)` (Payload Too Large) is returned.
- The client-side `HealthUploadEngine` implements **auto-rechunking** and pre-send byte size validation (`MAX_BATCH_BYTES = 4.5MB`).

#### Alternatives Considered

- **No Limit:** Allowing unbounded job payload sizes.
    - *Rejected:* Directly leads to Redis OOM, socket failures, and system instability.
- **Queue-Specific Redis Instance:** A dedicated Redis instance for BullMQ with `noeviction` policy.
    - *Rejected:* Even with a dedicated instance, unbounded payloads still consume memory. This ADR addresses *payload size*, not eviction policy.
- **Store Payload in S3, Pass Reference:** Storing large payloads in S3, passing only the S3 key.
    - *Rejected:* Adds significant complexity (S3 upload, pre-signed URLs, garbage collection), increased latency. The 5MB limit is sufficient to avoid this complexity.

#### Rationale

**Pros:**

- **Redis Stability** — Prevents memory exhaustion and socket failures.
- **System Resilience** — Reduces the likelihood of `HealthIngestRequest` getting stuck in "PROCESSING."
- **Predictability** — Ensures robust job processing by handling oversized payloads gracefully.
- **Client Auto-Rechunking** — Proactively splits large batches, preventing server-side rejections.
- **Clear Error Feedback** — Clients receive specific `413 Payload Too Large` errors.

**Cons:**

- **Client-Side Complexity** — Clients must implement payload size estimation and auto-rechunking.
- **Batch Splitting** — Very large health data batches may need splitting.
- **Arbitrary Limit** — 5MB is a heuristic; optimal size depends on Redis configuration and network.

#### Consequences

- `HealthIngestQueueService.maybeQueueBatch` now includes byte size validation. `HealthUploadEngine` has `estimateRequestBytes` and auto-rechunking logic.
- `BatchUpsertSamplesErrorResponseSchema` includes `PAYLOAD_TOO_LARGE` as a `BatchErrorCode`.
- Errors are logged with payload byte sizes, aiding in debugging client-side batching issues.

#### Principles Alignment

Reinforces **System Resilience** and **Resource Management**. Promotes **Robustness** by handling failure conditions gracefully. Ensures **Operational Stability** for the BullMQ job queue.

<details>
<summary><strong>Implementation Details</strong></summary>
<br>

- **`packages/backend/src/services/healthIngestQueue.service.ts`** — Pre-enqueue byte size check:

```typescript
// excerpt from maybeQueueBatch
const payloadBytes = Buffer.byteLength(JSON.stringify(jobData), 'utf-8');
if (payloadBytes > HealthIngestQueueService.MAX_JOB_PAYLOAD_BYTES) {
    // ... fail ingest request, throw AppError(413) ...
}
```

- **`packages/backend/src/services/health/HealthUploadEngine.ts`** — Client-side payload estimation and auto-rechunking:

```typescript
// excerpt from doUploadPendingSamplesInternal
// ... auto-rechunk logic ...
throw new PayloadTooLargeError( /* ... */ );
```

- **`packages/shared/src/contracts/health.contract.ts`** — Defines `BatchErrorCode.PAYLOAD_TOO_LARGE`.

</details>

> **Status:** `Implemented` · **Date:** 2026-03-24 · **Reviewers:** Core Engineering Team
> **Related:** `FAILURE-MODES.MD`, `WORKER-SCALABILITY.MD`

---

### ADR-016: HTTP Compression for Health Data Uploads

#### Context

Health data payloads, especially high-frequency metrics (heart rate, steps) or detailed categorical data (sleep stages), can be quite large. Sending these uncompressed leads to:

- **High Bandwidth Consumption** — Increased data transfer costs.
- **Increased Latency** — Longer upload times on slow or congested mobile networks.
- **Client Battery Drain** — More data transfer consumes more battery.

#### Decision

**HTTP Compression (gzip)** was implemented for health data upload requests:

- The client (`HealthUploadHttpClientImpl`) compresses the `BatchUpsertSamplesRequest` payload using `pako.gzip` if its uncompressed size exceeds a `GZIP_MIN_BYTES` threshold.
- The `Content-Encoding: gzip` header is added to the request.
- The backend's `app.ts` middleware pipeline includes `compression()` to automatically decompress incoming requests.
- `health.controller.ts` validates the `Content-Encoding` header and logs byte sizes for observability.

#### Alternatives Considered

- **No Compression:** Continue sending payloads uncompressed.
    - *Rejected:* Directly leads to poor UX and higher costs.
- **Application-Level Compression (Custom):** Implementing a custom compression algorithm (e.g., LZ4).
    - *Rejected:* Reinvents the wheel, higher complexity, not compatible with standard HTTP headers.
- **Always Compress:** Compress all payloads regardless of size.
    - *Rejected:* For very small payloads, compression overhead can exceed the savings. `GZIP_MIN_BYTES` threshold optimizes this.

#### Rationale

**Pros:**

- **Reduced Bandwidth** — Significantly decreases transfer size (often 60-80% for JSON payloads).
- **Improved Performance** — Faster uploads, especially over cellular networks.
- **Battery Savings** — Lower network activity on mobile clients.
- **Standardized** — Uses standard `gzip` and `Content-Encoding` headers.
- **Observability** — Backend logs `bytes_uncompressed`, `bytes_compressed`, and `compression_ratio`.

**Cons:**

- **CPU Overhead** — Compression/decompression consumes CPU on both client and server. Mitigated by optimizing gzip level and threshold.
- **Client-Side Complexity** — Requires `pako` library and conditional compression logic.
- **Backend Configuration** — Requires correct `compression()` middleware ordering in `app.ts`.

#### Consequences

- `HealthUploadHttpClientImpl` now includes `pako.gzip` and `Content-Encoding` header logic.
- `app.ts` includes `compression()` middleware.
- `health.controller` and `HealthUploadEngine` log compression details for metrics.

#### Principles Alignment

Improves **Performance Optimization** and **Resource Management**. Adheres to **Standardization** by using common HTTP mechanisms. Contributes to a better **User Experience**.

<details>
<summary><strong>Implementation Details</strong></summary>
<br>

- **`packages/app/src/services/health/HealthUploadHttpClientImpl.ts`** — Client-side compression:

```typescript
// excerpt from uploadBatch
const requestJson = JSON.stringify(request);
const uncompressedBytes = utf8ByteLength(requestJson);

if (isFeatureEnabled('healthGzip') && uncompressedBytes >= GZIP_MIN_BYTES) {
  const compressed = pako.gzip(requestJson);
  requestBody = compressed;
  bodyType = 'raw';
  contentEncoding = 'gzip';
  compressedBytes = compressed.byteLength;
  headers['Content-Encoding'] = 'gzip';
  headers['Content-Type'] = 'application/json';
}
```

- **`packages/backend/src/app.ts`** — Configures the Express `compression` middleware.
- **`packages/backend/src/api/v1/controllers/health.controller.ts`** — Validates `Content-Encoding` header and logs byte sizes.
- **`packages/backend/src/api/v1/middleware/jsonBodyParser.middleware.ts`** — `createJsonBodyParser` handles `Content-Encoding` during parsing.

</details>

> **Status:** `Implemented` · **Date:** 2026-03-24 · **Reviewers:** Core Engineering Team
> **Related:** `WORKER-SCALABILITY.MD`, `OBSERVABILITY.MD`

---

### ADR-017: Server-Time Header for Client Clock Offset Calculation

#### Context

Client devices often have inaccurate clocks due to drift, user manipulation, or network latency. This causes issues for a sync-heavy application that relies on accurate timestamps for:

- **Event Ordering** — Correctly sequencing events (`consumption.created`, `purchase.finished`).
- **Stale Data Detection** — Miscalculating local cache freshness.
- **Optimistic UI Updates** — Client-side updates appearing out of sync with the server's authoritative timeline.

#### Decision

A **`Server-Time` HTTP header** was added to all HTTP responses, containing the server's current UTC timestamp in ISO 8601 format (e.g., `2025-01-15T10:30:45.123Z`):

- A dedicated `server-time.middleware.ts` adds this header early in the middleware pipeline.
- Clients parse this header and calculate their clock offset (`serverTime - clientTime`).
- This offset adjusts local timestamps for display and optimistic updates.

#### Alternatives Considered

- **NTP Client on Device:** Implementing a full NTP client on mobile devices.
    - *Rejected:* Overkill, high complexity, security concerns. OS-level NTP exists but isn't exposed to apps.
- **Dedicated Time API Endpoint:** A specific `/time` endpoint.
    - *Rejected:* Requires an extra HTTP request per cycle. A header is more efficient.
- **Embedding Server Time in Response Body:** Including `serverTime` in every API response body.
    - *Rejected:* Modifies every API contract. A header is a cleaner cross-cutting concern.

#### Rationale

**Pros:**

- **Accuracy** — Provides a reliable, server-authoritative UTC timestamp.
- **Efficiency** — Minimal overhead (one header per request), no extra network calls.
- **Consistency** — Enables deterministic clock offset calculations.
- **Improved UX** — Correct "just now" labels and optimistic UI timing.
- **Decoupling** — Implemented as a clean, cross-cutting middleware.

**Cons:**

- **Client Implementation** — Requires consistent header parsing and offset application.
- **Latency Bias** — The timestamp is captured when the response *starts* being sent. Network latency contributes to an inherent (small) offset.
- **Security** — Timestamp is not sensitive but needs correct formatting.

#### Consequences

- Introduction of `server-time.middleware.ts` in the middleware layer, registered early in `app.ts`.
- Clients (`BackendAPIClient`) are expected to parse this header and compute/apply a clock offset.
- The `Server-Time` header is implicitly part of the API contract for all HTTP responses.

#### Principles Alignment

Improves **Data Integrity** for timestamp-sensitive operations and enhances **User Experience**. A clean implementation of a **Cross-Cutting Concern** via middleware.

<details>
<summary><strong>Implementation Details</strong></summary>
<br>

- **`packages/backend/src/api/v1/middleware/server-time.middleware.ts`:**

```typescript
export function serverTimeMiddleware(req: Request, res: Response, next: NextFunction): void {
  const serverTime = new Date().toISOString();
  res.setHeader('Server-Time', serverTime);
  next();
}
```

- **`packages/backend/src/app.ts`** — The middleware is applied globally:

```typescript
// excerpt from setupMiddleware
this.app.use(middleware.correlationContext);
this.app.use(middleware.serverTime); // ADR-017
this.app.use(middleware.apiGateway);
```

</details>

> **Status:** `Implemented` · **Date:** 2026-03-24 · **Reviewers:** Core Engineering Team
> **Related:** `OBSERVABILITY.MD`

---

### ADR-018: Centralized Health Metric Definitions (Shared Contract)

#### Context

Managing health data consistently across a mobile frontend and a backend API is challenging. Disparate definitions for metric codes, units, value types, and validation rules lead to:

- **Semantic Drift** — Frontend and backend interpreting the same metric differently.
- **Validation Mismatches** — Client-side validation succeeding while server-side fails.
- **Normalization Errors** — Incorrect unit conversions or data transformations.
- **API Inconsistencies** — Difficulty extending the API with new metrics.
- **Debugging Overhead** — Tracing issues caused by subtle differences in metric definitions.

#### Decision

All canonical health metric definitions (codes, names, categories, value kinds, units, allowed value ranges, category code allowlists) were centralized in `@shared/health-config/metric-types.ts`:

- `HEALTH_METRIC_DEFINITIONS` acts as the single source of truth (registry).
- Utilities (`getMetricDefinition`, `getCanonicalUnit`, `isValueInBounds`, `normalizeToCanonicalUnit`, `isCategoryCodeAllowed`) provide consistent access and validation.
- `HEALTH_METRIC_CODES` is a frozen array derived from the definitions, used for strict Zod schema validation.
- Invariants are validated at module load time to catch configuration drift early.

#### Alternatives Considered

- **Separate Definitions (Frontend/Backend):** Each layer maintains its own definitions.
    - *Rejected:* Directly leads to semantic drift, inconsistencies, and high maintenance burden.
- **Backend as SSOT (API-driven):** Frontend fetches metric definitions from a backend API endpoint.
    - *Rejected:* Adds runtime overhead, requires local caching, and still needs a shared *type definition*. Compile-time shared contract is more robust.
- **Database-Driven (Dynamic):** Storing metric definitions in a database and loading dynamically.
    - *Rejected:* Higher complexity, runtime overhead, and loses compile-time type safety. For immutable metadata, a code-based registry is simpler.

#### Rationale

**Pros:**

- **Single Source of Truth** — Eliminates semantic drift between frontend and backend.
- **Type Safety** — All metric handling is compile-time type-checked.
- **Consistent Validation** — Identical rules applied consistently across layers.
- **Reliable Normalization** — Guarantees correct unit conversions.
- **Extensibility** — Adding new metrics involves a single update to the shared registry.
- **Fail-Fast** — Invariant checks catch configuration errors at module load time.
- **Performance** — O(1) lookup from the frozen registry.

**Cons:**

- **Shared Module Coupling** — Requires a shared `@shared` module, increasing frontend build size.
- **Deployment Coordination** — Updates require a coordinated deployment of both frontend and backend.
- **Immutable Configuration** — Not suitable for highly dynamic definitions that change frequently at runtime.

#### Consequences

- Creation of `@shared/health-config/metric-types.ts` as a foundational shared module.
- Mobile apps import `HEALTH_METRIC_DEFINITIONS` and utilities for local validation and normalization.
- `health.contract.ts` (Zod schemas) directly imports `HealthMetricCodeSchema`. `HealthSampleService` uses these definitions for ingestion.
- Engineers must update the shared registry for any new health metric.
- Module-level invariant checks ensure the integrity of the definitions at runtime.

#### Principles Alignment

Strongly reinforces **Single Source of Truth** and **DRY**. Adheres to **Contract-First Development** and enhances **Type Safety**. Improves **Robustness** by ensuring consistent validation and normalization.

<details>
<summary><strong>Implementation Details</strong></summary>
<br>

- **`packages/shared/src/health-config/metric-types.ts`** — Defines the registry:

```typescript
// excerpt from HEALTH_METRIC_DEFINITIONS
const _HEALTH_METRIC_DEFINITIONS = {
  heart_rate: {
    code: 'heart_rate',
    name: 'Heart Rate',
    category: 'vital_signs',
    valueKind: 'SCALAR_NUM',
    canonicalUnit: 'bpm',
    allowedUnits: ['bpm', 'count/min'] as const,
    minValue: 20, maxValue: 400, expectedSamplesPerHour: 60,
  },
  // ... more definitions ...
} as const satisfies Readonly<Record<HealthMetricCode, HealthMetricDefinition>>;
```

- **`packages/shared/src/contracts/health.contract.ts`** — Imports `HealthMetricCodeSchema` and uses `isValueInBounds`, `isCategoryCodeAllowed` for Zod schema refinements.
- **`packages/backend/src/services/health/HealthIngestionEngine.ts`** — Uses `getMetricDefinition`, `isValueInBounds`, `isUnitAllowedForMetric` during ingestion.

</details>

> **Status:** `Implemented` · **Date:** 2026-03-24 · **Reviewers:** Core Engineering Team
> **Related:** `ARCHITECTURE.MD`, `DATA-INTEGRITY-GUARANTEES.MD`

---

### ADR-019: Automated Stale Processing Cleanup (Reapers)

#### Context

In an asynchronous processing pipeline, operations can get stuck in an "in-progress" or "processing" state due to worker crashes, network failures, or timeouts. When `HealthIngestRequest` or `SessionTelemetryCache` entries get stuck in `COMPUTING`/`PROCESSING`:

- **Deadlocks** — Subsequent requests for the same item are blocked, waiting for an abandoned "lock."
- **Stale Data** — Caches remain in a `COMPUTING` state indefinitely.
- **Operational Blindness** — Difficulty identifying and recovering from stuck states.

Manual intervention was previously required — not scalable or reliable.

#### Decision

**Automated Reaper Jobs** were implemented using BullMQ for proactive cleanup:

- **`HealthIngestReaperJob`** — Periodically finds `HealthIngestRequest` entries stuck in `PROCESSING` for too long and marks them `FAILED`. Clients can then retry safely.
- **`SessionTelemetryLockReaperJob`** — Periodically finds `SessionTelemetryCache` entries stuck in `COMPUTING` and marks them `FAILED`. Subsequent requests can take over the abandoned computation lock.

These jobs run on a fixed schedule (e.g., every 5-15 minutes) via BullMQ cron.

#### Alternatives Considered

- **Manual Cleanup:** Relying on human operators.
    - *Rejected:* Not scalable, error-prone, leads to longer downtimes.
- **Process-Specific Watchdogs:** Implementing a watchdog thread within each worker process.
    - *Rejected:* Complex to implement reliably, doesn't cover external failures.
- **Longer Timeouts:** Simply increasing the timeout for `PROCESSING` states.
    - *Rejected:* Only delays the problem.

#### Rationale

**Pros:**

- **Proactive Recovery** — Automatically recovers from abandoned processing states.
- **System Resilience** — Improves robustness against transient failures and crashes.
- **Operational Visibility** — Reaper actions are logged, providing clear signals of stuck processes.
- **Idempotency** — Marking as `FAILED` (instead of deleting) allows clients to retry.
- **Configurable** — Thresholds for "stale" are configurable.

**Cons:**

- **False Positives** — A legitimate long-running operation might be incorrectly classified as "stale." Mitigated by generous timeouts.
- **Complexity** — Adds background jobs and associated logic.
- **Race Conditions (Small Window)** — A tiny window exists where a reaper might mark a job `FAILED` just before the original worker completes. Handled by idempotent updates and retry logic.

#### Consequences

- No new tables, but `HealthIngestRequest` and `SessionTelemetryCache` have their `status` and `updatedAt` fields used for stale detection.
- `HealthSampleRepository` and `SessionTelemetryCacheRepository` implement `reapStaleProcessingIngestRequests` and `reapStaleComputingRows`.
- Introduction of `HealthIngestReaperJobData` and `SessionTelemetryLockReaperJobData` in `job.types.ts`, implemented in `job-processor.ts`, and scheduled in `schedules.ts`.
- Reduced need for manual intervention, improved system reliability.

#### Principles Alignment

Reinforces **System Resilience** and **Reliability**. Promotes **Automated Operations** and improves **Observability** into asynchronous process state.

<details>
<summary><strong>Implementation Details</strong></summary>
<br>

- **`packages/backend/src/jobs/job.types.ts`** — Defines `HealthIngestReaperJobData` and `SessionTelemetryLockReaperJobData`.

- **`packages/backend/src/jobs/job-processor.ts`** — Implements reaper logic:

```typescript
// excerpt from processHealthIngestReaperJob
const result = await this.healthSampleRepository.reapStaleProcessingIngestRequests(
  data.staleAfterMinutes,
  data.maxRows
);
```

- **`packages/backend/src/jobs/schedules.ts`** — Schedules these jobs via BullMQ cron.
- **`packages/backend/src/repositories/health-sample.repository.ts`** — Implements `reapStaleProcessingIngestRequests`.
- **`packages/backend/src/repositories/session-telemetry-cache.repository.ts`** — Implements `reapStaleComputingRows`.

</details>

> **Status:** `Implemented` · **Date:** 2026-03-24 · **Reviewers:** Core Engineering Team
> **Related:** `FAILURE-MODES.MD`, `WORKER-SCALABILITY.MD`

---

### ADR-020: Soft Delete for Health Samples with Purge Policy

#### Context

When health data is deleted from the client device's HealthKit or Health Connect, the backend needs to reflect this change. A naive hard-delete approach poses several problems:

- **Audit Trail Loss** — No record of the data ever existing or being deleted.
- **Analytics Impact** — Historical aggregates would suddenly drop values.
- **Reconciliation Issues** — Difficult to reconcile if the client re-sends a "deleted" sample.
- **GDPR Compliance** — Users may request data deletion, but a temporary retention period might be necessary for auditing.

However, indefinite storage of all deleted data is costly.

#### Decision

**Soft Deletion** was implemented for `HealthSample` records:

- Instead of hard-deleting, `HealthSampleService` sets an `isDeleted` boolean to `true` and a `deletedAt` timestamp.
- API queries (`GET /health/samples`) default to filtering `isDeleted = false`.
- A periodic **`HealthSampleSoftDeletePurgerJob`** (BullMQ worker) hard-deletes records older than a configurable retention period (e.g., 30 days).

#### Alternatives Considered

- **Hard Delete Only:** Permanently delete records immediately.
    - *Rejected:* Leads to audit trail loss, analytics disruption, and reconciliation issues.
- **Indefinite Soft Delete:** Never hard-delete records.
    - *Rejected:* High storage costs, performance degradation, unnecessary data retention beyond needs.
- **TimescaleDB Retention Policy:** Using `add_retention_policy`.
    - *Rejected:* Operates on *entire chunks* by time, not filtered by `isDeleted`. Would delete *all* data older than the period, not just soft-deleted rows.

#### Rationale

**Pros:**

- **Auditability** — Preserves a complete history of data and its deletion.
- **Analytics Integrity** — Historical aggregates remain stable.
- **Reconciliation** — Simplifies handling if deleted data reappears.
- **GDPR Compliance** — Supports deletion requests with a temporary audit retention period.
- **Storage Optimization** — The purger job manages long-term storage.

**Cons:**

- **Increased Storage** — Soft-deleted records temporarily consume space.
- **Query Complexity** — Default queries require `WHERE isDeleted = false` clauses.
- **Background Job Overhead** — Requires a dedicated BullMQ job for purging.

#### Consequences

- `prisma/schema.prisma` includes `isDeleted` (boolean) and `deletedAt` (DateTime) on `HealthSample`.
- `HealthSampleRepository` methods handle `isDeleted` flags (e.g., `queryActiveByUserAndTimeRange` filters `isDeleted=false`).
- `HealthSampleService.deleteConsumption` performs soft deletion.
- Introduction of `HealthSampleSoftDeletePurgerJobData` in `job.types.ts`, scheduled in `schedules.ts`.
- `GET /health/samples` implicitly filters soft-deleted samples.

#### Principles Alignment

Improves **Data Integrity**, **Auditability**, and **Resource Management**. Adheres to **Privacy by Design** for data deletion and supports **Automated Operations**.

<details>
<summary><strong>Implementation Details</strong></summary>
<br>

- **`packages/backend/prisma/schema.prisma`** — Soft delete columns:

```prisma
model HealthSample {
  // ...
  isDeleted      Boolean  @default(false) @map("is_deleted")
  deletedAt      DateTime? @map("deleted_at") @db.Timestamptz(6)
  // ...
  @@index([userId, isDeleted])
  @@index([deletedAt])
}
```

- **`packages/backend/src/services/healthSample.service.ts`** — `deleteConsumption` method for soft deleting.
- **`packages/backend/src/repositories/health-sample.repository.ts`** — `queryActiveByUserAndTimeRange` and `purgeAllOldDeletedSamplesForAdmin`.
- **`packages/backend/src/jobs/job.types.ts`** — Defines `HealthSampleSoftDeletePurgerJobData`.
- **`packages/backend/src/jobs/job-processor.ts`** — Implements `processHealthSampleSoftDeletePurgerJob`.
- **`packages/backend/src/jobs/schedules.ts`** — Schedules `scheduleHealthSampleSoftDeletePurger`.

</details>

> **Status:** `Implemented` · **Date:** 2026-03-24 · **Reviewers:** Core Engineering Team
> **Related:** `DATA-INTEGRITY-GUARANTEES.MD`, `FAILURE-MODES.MD`

---

### ADR-021: Global Stale Session Reconciliation

#### Context

In an event-driven system with a rolling window definition for active sessions, it's possible for sessions to become "stale active":

- A user exits the app abruptly without explicitly ending a session.
- Network issues prevent the client from sending the `session:end` event.
- A client's clock is significantly out of sync.

These stale active sessions lead to inaccurate counts of active sessions, blocking of downstream processing (e.g., session impact calculations), and potential data inconsistencies. Reactive cleanup (e.g., `createSession` closing prior active sessions) is insufficient for global cleanup.

#### Decision

A **Global Stale Session Reconciliation Job** was implemented:

- A periodic `StaleSessionReconciliationJob` (BullMQ worker) runs on a schedule (e.g., every 10 minutes).
- It sweeps across *all users* to find sessions still marked `ACTIVE` or `PAUSED` but whose `sessionEndTimestamp` is in the past.
- For each stale session, it invokes `SessionService.completeSession()` durably, ensuring the session status is set to `COMPLETED` and the `session.ended` domain event is emitted.

#### Alternatives Considered

- **Purely Reactive Cleanup:** Relying solely on `createSession` to close prior active sessions, or `getActiveSessions` to perform inline cleanup.
    - *Rejected:* Insufficient for global cleanup. Only fires when the specific user takes action.
- **Database-Level Cron Job:** A SQL cron job directly updating `session.status`.
    - *Rejected:* Bypasses service-layer business logic and event emission, losing critical `session.ended` domain events.
- **Longer Session Timeouts:** Increasing `SESSION_IDLE_TIMEOUT_MS`.
    - *Rejected:* Only delays the problem.

#### Rationale

**Pros:**

- **Data Integrity** — Ensures session statuses are eventually consistent with their actual lifespan.
- **Accuracy** — Provides accurate counts of genuinely active sessions.
- **Proactive Cleanup** — Automatically clears abandoned sessions.
- **Event Emission** — Guarantees `session.ended` domain events for all completed sessions.
- **Scalability** — Bounded by `maxUsers` and `maxSessionsPerUser` to prevent runaway queries.

**Cons:**

- **Background Job Overhead** — Requires a dedicated BullMQ job.
- **Complexity** — Adds global sweep logic to the `SessionService`.
- **Potential False Positives** — A session might be active despite `sessionEndTimestamp` being in the past (extreme clock skew). Mitigated by idempotent completion.

#### Consequences

- `SessionService` gained `reconcileStaleSessionsGlobal` and `completeSession` was made robust for idempotent calls.
- Introduction of `StaleSessionReconciliationJobData` in `job.types.ts`, implemented in `job-processor.ts`, and scheduled in `schedules.ts`.
- Reduced manual intervention, improved data consistency for session-related analytics and projections.
- Queries for active sessions are more accurate.

#### Principles Alignment

Improves **Data Integrity**, **System Resilience**, and **Automated Operations**. Ensures **Event-Driven Architecture** consistency by guaranteeing `session.ended` events for all completed sessions.

<details>
<summary><strong>Implementation Details</strong></summary>
<br>

- **`packages/backend/src/services/session.service.ts`** — Reconciliation logic:

```typescript
// excerpt from reconcileStaleSessionsGlobal
const staleSessions = await this.sessionRepository.findManyAdmin({
  where: {
    status: { in: ['ACTIVE', 'PAUSED'] },
    sessionEndTimestamp: { lt: now },
  },
  orderBy: { userId: 'asc' },
  take: maxUsers * maxSessionsPerUser,
});
// ... then loops through and calls completeSession() ...
```

- **`packages/backend/src/repositories/session.repository.ts`** — `findManyAdmin` method for querying across users.
- **`packages/backend/src/jobs/job.types.ts`** — Defines `StaleSessionReconciliationJobData`.
- **`packages/backend/src/jobs/job-processor.ts`** — Implements `processStaleSessionReconciliationJob`.
- **`packages/backend/src/jobs/schedules.ts`** — Schedules `scheduleStaleSessionReconciliation`.

</details>

> **Status:** `Implemented` · **Date:** 2026-03-24 · **Reviewers:** Core Engineering Team
> **Related:** `DATA-INTEGRITY-GUARANTEES.MD`, `FAILURE-MODES.MD`, `WORKER-SCALABILITY.MD`

---

## Maintaining ADRs

To ensure the ADRs remain a living, accurate, and high-value document:

**When to Create a New ADR:**

- Introduces a new technology or significant library
- Changes the core data model of an entity
- Impacts the system's scalability, performance, security, or resilience
- Modifies a cross-cutting concern (e.g., authentication, logging, error handling)
- Resolves a critical bug that exposed an architectural flaw
- Involves a significant trade-off or a choice between multiple complex alternatives

**How to Update an ADR:**

Once an ADR is marked `Implemented`, its core Decision, Alternatives, and Rationale sections are considered immutable. However, the `Status` can be updated (e.g., to `Deprecated` or `Superseded` with a link to a newer ADR). The `Consequences` section can be appended with new insights.

**Review Process:**

All proposed ADRs should undergo peer review to ensure clarity, accuracy, and alignment with architectural principles before being merged.

**Tooling:**

Use Markdown for easy readability and version control. Consider incorporating CI checks for ADR format consistency in the future.
