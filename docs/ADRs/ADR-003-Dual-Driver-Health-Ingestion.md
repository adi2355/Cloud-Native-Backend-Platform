# ADR-003: Dual-Driver Health Ingestion (JS + Native Swift)

## Status
Accepted

## Context
The mobile app ingests high-volume health data from iOS HealthKit. React Native's JavaScript bridge has inherent limitations for this: large HealthKit queries block the UI thread, iOS terminates background tasks that exceed strict time budgets (~15s), and JS lacks native `OperationQueue` for concurrent, prioritized background processing.

## Decision
Implement a **dual-driver health ingestion system** on iOS:

1. **NativeHealthIngestionDriver (Swift):** Primary driver. Uses native `OperationQueue`s for concurrent, throttled HealthKit queries. Writes directly to local SQLite with `BEGIN IMMEDIATE` transactions and CAS cursor advancement. Supports three ingestion lanes:
   - **Hot:** UI-critical, two-pass freshness-first for recent data
   - **Cold:** Background historical backfill with time-cursor advancement
   - **Change:** Deletion detection via `HKObserverQuery` with 15s hard timeout

2. **JsHealthIngestionDriver (TypeScript):** Fallback driver wrapping `HealthIngestionEngine`. Used on Android and as emergency iOS fallback (feature flag `healthJsFallbackInProd`).

A factory (`createHealthIngestionDriver`) selects the driver at runtime based on platform detection and feature flags.

## Consequences

### Positive
- Native performance for HealthKit — no UI thread blocking
- Reliable background ingestion within iOS time budgets
- Clean `IHealthIngestionDriver` interface — `HealthSyncService` is driver-agnostic
- Emergency kill switch via feature flag if native driver has critical bugs

### Negative
- Two implementations to maintain (Swift + TypeScript)
- Some logic duplication (normalization rules, cursor management)
- Cross-bridge debugging complexity

### Alternatives Rejected
- **Pure JavaScript HealthKit abstraction:** Inadequate background performance; iOS terminates tasks
- **Monolithic native module:** Reduces JS iteration speed; harder to debug
- **Pure native app (separate codebase):** Loses React Native cross-platform benefits

## Key Files
- `packages/app/src/services/health/drivers/createHealthIngestionDriver.ts` — Factory
- `packages/app/src/services/health/drivers/NativeHealthIngestionDriver.ts` — Swift bridge client
- `packages/app/src/services/health/drivers/JsHealthIngestionDriver.ts` — TS fallback
- `packages/app/ios/AppPlatform/HealthIngest/HealthIngestCore.swift` — Native implementation
- `packages/app/ios/AppPlatform/HealthIngest/HealthIngestSQLite.swift` — Atomic persistence
