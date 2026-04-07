/**
 * Domain Events Type Definitions
 * 
 * This file contains all domain event interfaces and type definitions for the AppPlatform event-driven architecture.
 * These events facilitate loose coupling between services and enable real-time updates across the system.
 * 
 * @module domain.events
 * @see https://martinfowler.com/articles/domainEvents.html
 */

import {
  Consumption,
  JournalEntry,
  Purchase,
  Goal,
  User,
} from '@prisma/client';

/**
 * Event priority levels for processing order
 */
export enum EventPriority {
  LOW = 'low',
  NORMAL = 'normal',
  HIGH = 'high',
  CRITICAL = 'critical'
}

/**
 * Base interface for all domain events
 *
 * These fields are now MANDATORY to ensure proper event correlation,
 * analytics tracking, and subscriber type safety. Previously, these
 * were extracted at runtime and cast unsafely in subscribers.
 */
export interface DomainEvent {
  /** Unique identifier for the event */
  eventId: string;
  /** Event type identifier (e.g., 'consumption.created') */
  eventType: string;
  /** ISO timestamp when the event occurred */
  timestamp: string;
  /** User ID associated with this event */
  userId: string;
  /** Aggregate/entity ID (consumptionId, goalId, sessionId, etc.) */
  aggregateId: string;
  /** Aggregate type identifier (e.g., 'Consumption', 'Goal') */
  aggregateType: string;
  /** Event version for schema evolution */
  version: number;
  /** Correlation ID for tracking related events across services */
  correlationId: string;
  /** Optional causation ID for event chain tracking */
  causationId?: string;
  /** Optional metadata for additional context */
  metadata?: Record<string, unknown>;
  /** Event priority for processing order */
  priority?: EventPriority;
}

/**
 * Consumption Events
 */
export interface ConsumptionCreatedEvent extends DomainEvent {
  // Direct properties - no nesting
  consumptionId: string;
  userId: string;
  productId?: string;
  consumptionTimestamp: Date;
  durationMs: number;
  intensity?: number;
  quantity?: string;           // ADDED: Decimal as string from Prisma @db.Decimal(12,3)
  dosageMg?: string;     // ADDED: Decimal as string from Prisma @db.Decimal(12,2)
  deviceId?: string;
  sessionId?: string;
  purchaseId?: string;
  notes?: string;
  isJournaled: boolean;
  // Analytics data for DailyStat updates (calculated by ConsumptionService)
  quantityUsed: number;
  //  ISSUE #2.2 FIX: Cost metrics for DailyStat analytics
  costSpentActual: number;   // Actual cost = quantityUsed × pricePerUnit (0 if no purchase)
  costSavedTotal: number;     // Total savings including direct + waste (0 if no purchase)
  // Client traceability for offline-first sync and debugging
  clientConsumptionId?: string; // Client-generated UUID for end-to-end traceability
  // Inventory adjustment tracking (optional - populated when inventory adjustment occurs)
  inventoryItemId?: string;           // Which inventory item was decremented
  inventoryAdjustmentType?: string;   // 'CONSUMPTION' | 'MANUAL' etc.
  inventoryQuantityBefore?: string;   // Decimal as string before adjustment
  inventoryQuantityAfter?: string;    // Decimal as string after adjustment
}

export interface ConsumptionUpdatedEvent extends DomainEvent {
  consumptionId: string;
  userId: string;
  productId?: string;
  consumptionTimestamp: Date;
  durationMs: number;
  intensity?: number;
  quantity?: string;           // ADDED: Current Decimal as string
  dosageMg?: string;     // ADDED: Current Decimal as string
  notes?: string;
  isJournaled: boolean;
  previousData: {
    productId?: string;
    consumptionTimestamp?: Date;
    durationMs?: number;
    intensity?: number;
    quantity?: string;           // ADDED: Previous Decimal as string
    dosageMg?: string;     // ADDED: Previous Decimal as string
    notes?: string;
    isJournaled?: boolean;
  };
  changes: string[];
  // Analytics data for DailyStat delta calculations (calculated by ConsumptionService)
  previousQuantityUsed: number; // Old calculated quantity before update
  newQuantityUsed: number; // New calculated quantity after update
  //  ISSUE #2.2 FIX: Cost delta metrics for DailyStat analytics
  previousCostSpentActual: number;  // Old cost before update
  newCostSpentActual: number;       // New cost after update
  previousCostSavedTotal: number;   // Old savings before update
  newCostSavedTotal: number;        // New savings after update
}

export interface ConsumptionDeletedEvent extends DomainEvent {
  consumptionId: string;
  userId: string;
  productId?: string;
  durationMs: number;
  intensity?: number;
  quantity?: string;           // ADDED: Decimal as string from deleted consumption
  dosageMg?: string;     // ADDED: Decimal as string from deleted consumption
  timestamp: string;
  // Analytics data for DailyStat delta calculations (calculated by ConsumptionService)
  quantityUsed: number; // Calculated quantity for the deleted consumption
  //  ISSUE #2.2 FIX: Cost metrics for DailyStat analytics (replaces deprecated costSpent)
  costSpentActual: number;  // Actual cost = quantityUsed × pricePerUnit (0 if no purchase)
  costSavedTotal: number;   // Total savings including direct + waste (0 if no purchase)
}

/**
 * Goal Events
 */
export interface GoalCreatedEvent extends DomainEvent {
  // Direct properties - no nesting
  goalId: string;
  userId: string;
  name: string;
  type: string;
  category?: string;
  targetValue: number;
  currentValue: number;
  startDate: Date;
  endDate?: Date;
  status: string;
  metricType: string;
  progressPercentage: number;
  reminderEnabled: boolean;
  reminderFrequency?: string;
  milestoneValues?: number[];
}

export interface GoalUpdatedEvent extends DomainEvent {
  goalId: string;
  userId: string;
  name: string;
  type: string;
  category?: string;
  targetValue: number;
  currentValue: number;
  status: string;
  metricType: string;
  progressPercentage: number;
  previousData: Partial<Goal>;
  changes: string[];
}

export interface GoalCompletedEvent extends DomainEvent {
  goalId: string;
  userId: string;
  name: string;
  type: string;
  category?: string;
  targetValue: number;
  currentValue: number;
  completedAt: string;
  achievement?: {
    level: string;
    points: number;
  };
}

export interface GoalProgressEvent extends DomainEvent {
  goalId: string;
  userId: string;
  currentValue: number;
  targetValue: number;
  percentageComplete: number;
}

/**
 * Purchase Events
 */
export interface PurchaseCreatedEvent extends DomainEvent {
  // Direct properties - no nesting
  purchaseId: string;
  userId: string;
  productId: string;
  retailerId?: string;
  amount: number;
  unit: string;
  pricePerUnit: number;
  totalPrice: number;
  purchasedAt: Date;
  notes?: string;
}

export interface PurchaseUpdatedEvent extends DomainEvent {
  purchaseId: string;
  userId: string;
  productId: string;
  amount: number;
  unit: string;
  pricePerUnit: number;
  totalPrice: number;
  previousData: Partial<Purchase>;
  changes: string[];
}

/**
 * Purchase appended event — emitted when quantity+cost are appended to an existing active purchase.
 * Triggers inventory recalculation and analytics updates.
 */
export interface PurchaseAppendedEvent extends DomainEvent {
  purchaseId: string;
  userId: string;
  productId: string;
  /** Quantity added in this append operation */
  quantityAdded: number;
  /** Cost added in this append operation */
  costAdded: number;
  /** Total quantity after append */
  totalQuantityBought: number;
  /** Total cost after append */
  totalCostSpent: number;
  /** Recalculated price per unit after append */
  pricePerUnit: number;
  /** Inventory item ID that was updated */
  inventoryItemId?: string;
}

export interface PurchaseDeletedEvent extends DomainEvent {
  purchaseId: string;
  userId: string;
  productId: string;
  amount: number;
  totalPrice: number;
  purchasedAt: Date;
  // Additional data needed for DailyStat calculations
  costSpentActual: number;
}

/**
 * Purchase finished event — emitted when a purchase is marked as completed.
 * Triggers EMA learning pipeline (ConsumptionLearningService) and analytics updates.
 * This event is DISTINCT from purchase.updated to enable specific subscriber routing.
 */
export interface PurchaseFinishedEvent extends DomainEvent {
  purchaseId: string;
  userId: string;
  productId: string;
  quantityPurchased: number;
  costSpent: number;
  totalConsumptions: number;
  finishedDate: string; // ISO timestamp
  // Inventory adjustment details (populated when active inventory was zeroed out)
  inventoryAdjustment?: {
    inventoryItemId: string;
    quantityBefore: string;   // Decimal as string
    quantityAfter: string;    // Decimal as string (typically '0.000')
    adjustmentType: string;   // 'CORRECTION'
  };
}

/**
 * Journal Events
 */
export interface JournalEntryCreatedEvent extends DomainEvent {
  // Direct properties - no nesting
  entryId: string;
  userId: string;
  consumptionId?: string;
  journalDate: Date;
  content: string;
  mood?: string;
  tags?: string[];
  isPrivate: boolean;
}

export interface JournalEntryUpdatedEvent extends DomainEvent {
  entryId: string;
  userId: string;
  consumptionId?: string;
  content: string;
  mood?: string;
  tags?: string[];
  isPrivate: boolean;
  previousData: Partial<JournalEntry>;
  changes: string[];
}

export interface JournalEntryDeletedEvent extends DomainEvent {
  entryId: string;
  userId: string;
}

/**
 * Session Events
 */
export interface SessionStartedEvent extends DomainEvent {
  // Direct properties - no nesting
  sessionId: string;
  userId: string;
  purchaseId?: string;
  sessionStartTimestamp: Date;
  deviceId?: string;
  sessionTypeHeuristic?: string;
}

export interface SessionEndedEvent extends DomainEvent {
  // Direct properties - no nesting
  sessionId: string;
  userId: string;
  purchaseId?: string;
  sessionStartTimestamp: Date;
  sessionEndTimestamp: Date;
  duration: number;
  consumptionCount: number;
  totalDurationMs: number;
  avgEventDurationMs: number;
}

export interface SessionUpdatedEvent extends DomainEvent {
  sessionId: string;
  userId: string;
  purchaseId?: string;
  eventCount: number;
  totalDurationMs: number;
  avgEventDurationMs: number;
  changes: string[];
}

/**
 * Emitted when a session is paused (ACTIVE → PAUSED).
 * Subscribers may use this to update real-time UI state for connected clients
 * and track session pause metrics.
 */
export interface SessionPausedEvent extends DomainEvent {
  sessionId: string;
  userId: string;
  sessionStartTimestamp: Date;
  purchaseId?: string;
  deviceId?: string;
}

/**
 * Emitted when a paused session is resumed (PAUSED → ACTIVE).
 * Subscribers may use this to update real-time UI state for connected clients
 * and track session resume metrics.
 */
export interface SessionResumedEvent extends DomainEvent {
  sessionId: string;
  userId: string;
  sessionStartTimestamp: Date;
  purchaseId?: string;
  deviceId?: string;
}

/**
 * Emitted when a session is cancelled (ACTIVE/PAUSED → CANCELLED).
 * Subscribers may use this to exclude cancelled sessions from analytics,
 * achievements, and goal tracking.
 *
 * Note: Unlike session.ended (which signals successful completion),
 * session.cancelled signals the session was abandoned by the user.
 */
export interface SessionCancelledEvent extends DomainEvent {
  sessionId: string;
  userId: string;
  purchaseId?: string;
  sessionStartTimestamp: Date;
  sessionEndTimestamp: Date;
  duration: number;
  consumptionCount: number;
  totalDurationMs: number;
  avgEventDurationMs: number;
}

/**
 * User Events
 */
export interface UserRegisteredEvent extends DomainEvent {
  // Direct properties - no nesting
  userId: string;
  email?: string;
  phoneNumber?: string;
  displayName?: string;
  registrationMethod: 'email' | 'google' | 'phone';
  createdAt: Date;
}

export interface UserUpdatedEvent extends DomainEvent {
  userId: string;
  email?: string;
  phoneNumber?: string;
  displayName?: string;
  previousData: Partial<User>;
  changes: string[];
}

export interface UserDeletedEvent extends DomainEvent {
  userId: string;
  deletedAt: string;
}

/**
 * Device Events
 */
export interface DeviceConnectedEvent extends DomainEvent {
  // Direct properties - no nesting
  deviceId: string;
  userId: string;
  deviceName: string;
  deviceType: string;
  connectionType: 'bluetooth' | 'wifi';
  firmwareVersion?: string;
  lastConnected: Date;
}

export interface DeviceDisconnectedEvent extends DomainEvent {
  deviceId: string;
  userId: string;
  reason?: string;
}

export interface DeviceDataReceivedEvent extends DomainEvent {
  deviceId: string;
  userId: string;
  dataType: string;
  payload: unknown;
}

/**
 * Analytics Events
 */
export interface AnalyticsUpdatedEvent extends DomainEvent {
  userId: string;
  period: 'daily' | 'weekly' | 'monthly';
  metrics: {
    totalConsumptions?: number;
    averageDuration?: number;
    totalDuration?: number;
    uniqueProducts?: number;
    peakHours?: number[];
  };
}

/**
 * Achievement Events
 */
export interface AchievementUnlockedEvent extends DomainEvent {
  userId: string;
  achievementId: string;
  achievementType: string;
  points: number;
  level?: number;
}

/**
 * Sync Events
 */
export interface SyncStartedEvent extends DomainEvent {
  userId: string;
  deviceId: string;
  syncType: 'full' | 'delta';
  lastSyncTime?: string;
}

export interface SyncCompletedEvent extends DomainEvent {
  userId: string;
  deviceId: string;
  recordsSynced: number;
  conflicts: number;
  duration: number;
}

export interface SyncFailedEvent extends DomainEvent {
  userId: string;
  deviceId: string;
  error: string;
  retryCount: number;
}

/**
 * User Consumption Profile Events
 *  ISSUE #6 FIX: Added missing event types for type-safe emission
 */
export interface UserConsumptionProfileLearnedEvent extends DomainEvent {
  userId: string;
  learningResult: Record<string, unknown>;
  purchaseId: string;
  /** Number of purchase cycles processed in this learning batch (multi-purchase EMA) */
  purchasesProcessed?: number;
}

export interface UserConsumptionProfileSafetyAdaptedEvent extends DomainEvent {
  userId: string;
  adaptationReason: string;
  previousThresholds: Record<string, unknown>;
  newThresholds: Record<string, unknown>;
  adaptationCount: number;
}

/**
 * Inventory Prediction Events
 *  ISSUE #6 FIX: Added missing event types for type-safe emission
 */
export interface InventoryPredictionGeneratedEvent extends DomainEvent {
  userId: string;
  predictionId: string;
  daysUntilDepletion: number;
  confidence: number;
  overallRisk: string;
}

export interface InventoryPredictionHistoryClearedEvent extends DomainEvent {
  userId: string;
  deletedCount: number;
}

/**
 * Emitted when a consumption is created but no active inventory item exists for adjustment.
 * This signals that inventory drift has occurred and the adjustment should be reconciled
 * asynchronously when the inventory item becomes available (e.g., after out-of-order sync).
 *
 * Subscribers can attempt to:
 * 1. Find the inventory item (may have been created since the original attempt)
 * 2. Apply the deferred inventory adjustment
 * 3. Log irreconcilable drift for manual review
 */
export interface InventoryReconciliationNeededEvent extends DomainEvent {
  userId: string;
  consumptionId: string;
  productId: string | null;
  purchaseId: string | null;
  /** Quantity that should have been deducted from inventory */
  quantity: string | null;
  /** Source of the reconciliation need (sync handler or online service) */
  source: string;
}

/**
 * User Routine Events
 */

/**
 * @deprecated RETIRED — HMM training has been replaced by TemporalPatternService
 * (Dirichlet-multinomial temporal engine). This event type is retained for
 * backward compatibility with the EventTypeMap but is no longer emitted.
 * The trainHMMModel method that emitted this event has been removed from
 * UserRoutineService.
 */
export interface UserRoutineModelTrainedEvent extends DomainEvent {
  // Direct properties - no nesting
  userId: string;
  modelVersion: string;
  trainingDataSize: number;
  detectedStates: string[];
  success: boolean;
  accuracy?: number;
  logLikelihood?: number;
  trainedAt: Date;
}

export interface UserRoutineProfileSafetyAdaptedEvent extends DomainEvent {
  // Direct properties - no nesting
  userId: string;
  triggeredByReason: string;
  newHighRiskStates: string[];
  newCoolingOffStates: string[];
  adjustedMultipliersJson: string; // Serialized StateConsumptionMultipliers
  adaptedAt: Date;
}

export interface UserRoutineProfileResetEvent extends DomainEvent {
  // Direct properties - no nesting
  userId: string;
  resetAt: Date;
}

/**
 * Health Events
 *
 * NOTE: HealthSamplesIngestedEvent was removed (2026-02-04, Phase 0.1b).
 * It was never emitted after the P0-A transactional outbox migration.
 * All health event processing now uses HealthSamplesChangedEvent exclusively.
 */

/**
 * Outbox-backed health samples changed event.
 *
 * transaction as health sample inserts/updates/deletes. This guarantees at-least-once
 * delivery and prevents the dual-write anti-pattern.
 *
 * CANONICAL EVENT: This is the ONLY health change event type.
 *
 * DOWNSTREAM CONSUMERS (via HealthProjectionCoordinatorService):
 * - HealthRollupProjectionHandler: Updates daily/weekly aggregates
 * - SleepSummaryProjectionHandler: Updates sleep analysis
 * - TelemetryCacheProjectionHandler: Invalidates session telemetry caches
 */
export interface HealthSamplesChangedEvent extends DomainEvent {
  userId: string;
  requestId: string;
  correlationId: string;
  deviceId?: string;

  /** Number of samples successfully upserted. */
  sampleCount: number;

  /** Number of samples deleted. */
  deletedCount: number;

  /** Whether this batch includes deletions (for targeted cache invalidation). */
  hasDeletions: boolean;

  /** Unique metric codes affected by this batch (sorted for consistency). */
  metricCodes: string[];

  /**
   * Local dates affected by this batch (YYYY-MM-DD format, sorted).
   * Used for targeted rollup recomputation.
   */
  affectedLocalDates: string[];

  /** Earliest sample start time in batch (Unix ms). */
  rangeStartMs: number;

  /** Latest sample end time in batch (Unix ms). */
  rangeEndMs: number;

  /**
   * Timezone offset in minutes at time of ingestion.
   * Used for correct local date computation.
   */
  timezoneOffsetMinutes?: number;

  /**
   * Whether the timezone offset was explicitly provided (per-sample or request-level),
   * not silently defaulted to UTC (0).
   *
   * When false (or absent), downstream projections (especially sleep) should treat
   * affectedLocalDates with lower confidence — the dates were computed under UTC
   * assumption and may not reflect the user's actual local time.
   */
  timezoneExplicit?: boolean;
}

/**
 * Type-safe event type mapping for compile-time checking
 */
export interface EventTypeMap {
  // Consumption events
  'consumption.created': ConsumptionCreatedEvent;
  'consumption.updated': ConsumptionUpdatedEvent;
  'consumption.deleted': ConsumptionDeletedEvent;

  // Goal events
  'goal.created': GoalCreatedEvent;
  'goal.updated': GoalUpdatedEvent;
  'goal.completed': GoalCompletedEvent;
  'goal.progress': GoalProgressEvent;

  // Purchase events
  'purchase.created': PurchaseCreatedEvent;
  'purchase.updated': PurchaseUpdatedEvent;
  'purchase.appended': PurchaseAppendedEvent;
  'purchase.deleted': PurchaseDeletedEvent;
  'purchase.finished': PurchaseFinishedEvent;

  // Journal events
  'journal.entry.created': JournalEntryCreatedEvent;
  'journal.entry.updated': JournalEntryUpdatedEvent;
  'journal.entry.deleted': JournalEntryDeletedEvent;

  // Session events
  'session.started': SessionStartedEvent;
  'session.ended': SessionEndedEvent;
  'session.cancelled': SessionCancelledEvent;
  'session.updated': SessionUpdatedEvent;
  'session.paused': SessionPausedEvent;
  'session.resumed': SessionResumedEvent;

  // User events
  'user.registered': UserRegisteredEvent;
  'user.updated': UserUpdatedEvent;
  'user.deleted': UserDeletedEvent;

  // Device events
  'device.connected': DeviceConnectedEvent;
  'device.disconnected': DeviceDisconnectedEvent;
  'device.data.received': DeviceDataReceivedEvent;

  // Analytics events
  'analytics.updated': AnalyticsUpdatedEvent;

  // Achievement events
  'achievement.unlocked': AchievementUnlockedEvent;

  // Sync events
  'sync.started': SyncStartedEvent;
  'sync.completed': SyncCompletedEvent;
  'sync.failed': SyncFailedEvent;

  // Health events
  // NOTE: 'health.samples.ingested' removed (Phase 0.1b) — never emitted after P0-A outbox migration.
  // All health events now use 'health.samples.changed' exclusively via transactional outbox.
  'health.samples.changed': HealthSamplesChangedEvent;

  // User consumption profile events
  //  ISSUE #6 FIX: Added missing event types for type-safe emission
  'user.consumption.profile.learned': UserConsumptionProfileLearnedEvent;
  'user.consumption.profile.safety.adapted': UserConsumptionProfileSafetyAdaptedEvent;

  // Inventory prediction events
  //  ISSUE #6 FIX: Added missing event types for type-safe emission
  'inventory.prediction.generated': InventoryPredictionGeneratedEvent;
  'inventory.prediction.history.cleared': InventoryPredictionHistoryClearedEvent;

  // Inventory reconciliation events
  // Emitted when consumption skips inventory adjustment due to missing inventory item
  'inventory.reconciliation.needed': InventoryReconciliationNeededEvent;

  // User routine events
  'user.routine.model.trained': UserRoutineModelTrainedEvent;
  'user.routine.profile.safety.adapted': UserRoutineProfileSafetyAdaptedEvent;
  'user.routine.profile.reset': UserRoutineProfileResetEvent;

  // WILDCARD EVENT TYPE: Used for monitoring/analytics subscribers that listen to ALL events
  // This is a special type that matches the EventEmitter wildcard pattern ('*')
  // Subscribers using this will receive all events as a union type of DomainEvent
  '*': DomainEvent;
}

/**
 * Helper type to extract event names
 */
export type EventName = keyof EventTypeMap;

/**
 * Helper type to extract event payload for a specific event name
 */
export type EventPayload<K extends EventName> = Omit<EventTypeMap[K], keyof DomainEvent>;

/**
 * Event handler type definition
 */
export type EventHandler<K extends EventName> = (event: EventTypeMap[K]) => Promise<void> | void;

/**
 * Event subscription options
 */
export interface EventSubscriptionOptions {
  priority?: EventPriority;
  filter?: (event: DomainEvent) => boolean;
  maxRetries?: number;
  retryDelay?: number;
}

/**
 * Event emitter options
 */
export interface EventEmitterOptions {
  correlationId?: string;
  metadata?: Record<string, unknown>;
  priority?: EventPriority;
}

/**
 * Dead letter queue entry for failed events
 */
export interface DeadLetterEntry {
  event: DomainEvent;
  eventType: EventName;
  error: string;
  failedAt: Date;
  retryCount: number;
  maxRetries: number;
}

/**
 * Event statistics for monitoring
 */
export interface EventStatistics {
  eventType: EventName;
  emittedCount: number;
  processedCount: number;
  failedCount: number;
  averageProcessingTime: number;
  lastEmittedAt?: Date;
  lastProcessedAt?: Date;
  lastFailedAt?: Date;
}
