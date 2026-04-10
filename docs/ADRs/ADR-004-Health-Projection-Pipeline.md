# ADR-004: Health Projection Pipeline (CQRS Read Models)

## Status
Accepted

## Context
The platform generates high volumes of raw health data (`HealthSample`). Directly querying and aggregating raw data for every UI request is prohibitively slow. Complex derivations (sleep clustering, session impact correlations) are CPU-intensive and cannot run on the read path. Manual cache invalidation is error-prone.

## Decision
Implement a **CQRS Health Projection Pipeline**:

1. **Derived Read Models:** Pre-computed tables tailored for fast reads:
   - `UserHealthRollupDay` — Daily metric aggregates (sum, count, min, max, sum of squares)
   - `UserSleepNightSummary` — Nightly sleep metrics with pre-bed session correlation
   - `UserSessionImpactSummary` — Per-session health impact deltas (before/during/after)
   - `UserProductImpactRollup` — Product-level health impact with confidence tiers

2. **Event-Driven Computation:** `health.samples.changed` events from the Transactional Outbox trigger the `HealthProjectionCoordinatorService`, which fans out to independent `HealthProjectionHandler`s.

3. **Per-Projection Checkpoints:** Each handler has a `ProjectionCheckpoint` — independent retries, partial failure tolerance.

4. **Watermark-Based Freshness:** Each read model stores a `sourceWatermark` (the `UserHealthWatermark.sequenceNumber` at computation time). On read, if `currentWatermark > sourceWatermark`, data is marked `STALE` — triggering recomputation.

5. **Read Service:** `HealthProjectionReadService` exposes API endpoints for querying derived data with freshness metadata.

## Consequences

### Positive
- Millisecond reads for dashboards and AI (pre-computed aggregates)
- Reduced database load (no real-time joins on raw data)
- Explicit freshness tracking (`READY`, `COMPUTING`, `STALE`, `NO_DATA`, `PARTIAL`, `FAILED`)
- Independent handler retries — one failure doesn't block others

### Negative
- Data duplication (intentional trade-off for read performance)
- Write-side complexity (outbox events, checkpoint management)
- Eventually consistent derived data (acceptable for analytics)

### Alternatives Rejected
- **Direct queries + caching:** Expensive on-demand aggregation; cache invalidation is hard
- **Client-side aggregation:** Battery drain, inconsistent results, not suitable for centralized AI
- **Database materialized views:** Expensive `REFRESH CONCURRENTLY` on every sample change

## Key Files
- `code-snippets/services/health-projection-coordinator.service.ts` — Orchestrator + handler implementations
- `code-snippets/repositories/projection-checkpoint.repository.ts` — Checkpoint CRUD
- `code-snippets/repositories/user-health-watermark.repository.ts` — Watermark management
- `code-snippets/services/health-projection-read.service.ts` — Read model query service
- `packages/shared/src/contracts/health-projection.contract.ts` — DTOs, `ProjectionFreshnessMeta`
