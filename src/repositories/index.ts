/**
 * Repository Layer Exports
 *
 * Central export for all repository classes
 * Following the Repository Pattern for data access abstraction
 * All database operations should go through these repositories
 *
 * Architecture: Controller → Service → Repository → Prisma → Database
 */

// Base Repository
export { BaseRepository } from './base.repository';
export type { PaginatedResponse, PaginationParams } from './base.repository';

// USER & PROFILE REPOSITORIES

// User Repository
export { UserRepository } from './user.repository';
export type {
  CreateUserInput,
  UpdateUserInput,
  UserFilters,
} from './user.repository';

// User Statistics Repository
export { UserStatisticsRepository } from './user-statistics.repository';
export type {
  SyncMetricsInput,
  ConflictMetricsInput,
  SyncStatsSummary,
} from './user-statistics.repository';

// User Achievement Repository
export { UserAchievementRepository } from './user-achievement.repository';
export type {
  UserAchievementCreateInput,
  UserAchievementWithDetails,
  UserAchievementProgress,
  UserAchievementStats,
} from './user-achievement.repository';

// CORE ENTITY REPOSITORIES

// Consumption Repository
export { ConsumptionRepository } from './consumption.repository';

// Session Repository
export { SessionRepository } from './session.repository';
export type {
  CreateSessionInput,
  UpdateSessionInput,
  SessionFilters,
  SessionWithConsumptions,
  SessionAnalytics,
  UserSessionStats,
} from './session.repository';

// Product Repository
export { ProductRepository } from './product.repository';

// ProductReview repository removed - model doesn't exist in schema

// Purchase Repository
export { PurchaseRepository } from './purchase.repository';

// Journal Repository
export { JournalRepository } from './journal.repository';

// Device Repository
export { DeviceRepository } from './device.repository';

// INVENTORY REPOSITORIES

// Inventory Repository
export { InventoryRepository } from './inventory.repository';

// Inventory Adjustment Repository
export { InventoryAdjustmentRepository } from './inventory-adjustment.repository';
export type {
  InventoryAdjustmentCreateInput,
  InventoryAdjustmentWithDetails,
  AdjustmentSummary,
  AdjustmentReason,
} from './inventory-adjustment.repository';

// GOALS & ACHIEVEMENTS REPOSITORIES

// Goal Repository
export { GoalRepository } from './goal.repository';
export type {
  GoalCreateInput,
  GoalUpdateInput,
  GoalProgress,
  GoalAnalytics,
} from './goal.repository';

// Achievement Repository
export { AchievementRepository } from './achievement.repository';
export type {
  AchievementCreateInput,
  AchievementUpdateInput,
  AchievementWithProgress,
} from './achievement.repository';

// ANALYTICS & MONITORING REPOSITORIES

// Device Telemetry Repository
export { DeviceTelemetryRepository } from './device-telemetry.repository';
export type {
  CreateDeviceTelemetryInput,
  DeviceTelemetryQueryParams,
} from './device-telemetry.repository';

// Analytics Event Repository
export { AnalyticsEventRepository } from './analytics-event.repository';
export type {
  CreateAnalyticsEventInput,
  AnalyticsEventQueryParams,
  EventTypeFilter,
  EventAnalytics,
} from './analytics-event.repository';

// Daily Stat Repository
export { DailyStatRepository } from './daily-stat.repository';
export type {
  DailyStatCreateInput,
  DailyStatUpdateInput,
  DailyStatDeltaInput,
  WeeklyStat,
  MonthlyStat,
} from './daily-stat.repository';

// AI Usage Record Repository
export { AiUsageRecordRepository } from './ai-usage-record.repository';
export type {
  AiUsageRecordCreateInput,
  AiUsageRecordUpdateInput,
  AiUsageCostSummary,
  AiUsageAnalytics,
} from './ai-usage-record.repository';

// Safety Record Repository
export { SafetyRecordRepository } from './safety-record.repository';
export type {
  SafetyRecordCreateInput,
  SafetyRecordUpdateInput,
  SafetyCheckResult,
  SafetyStatistics,
} from './safety-record.repository';

// SYNC & OUTBOX REPOSITORIES

// Sync Change Repository
export { SyncChangeRepository } from './sync-change.repository';
export type {
  TrackChangeInput,
  MarkAppliedInput,
  RejectChangeInput,
  PendingChangesFilter,
  BatchProcessResult,
} from './sync-change.repository';

// Sync Conflict Repository
export { SyncConflictRepository } from './sync-conflict.repository';
export type {
  CreateConflictInput,
  ResolveConflictInput,
  BatchConflictInput,
  ConflictHistoryFilter,
} from './sync-conflict.repository';


// Sync State Repository
export { SyncStateRepository } from './sync-state.repository';
export type {
  SyncStateInput,
  UpdateSyncProgressInput,
  SyncLockResult,
  SyncStatusSummary,
} from './sync-state.repository';

// Sync Operation Repository
export { SyncOperationRepository } from './sync-operation.repository';
export type {
  CreateSyncOperationInput,
  SyncOperationUpdateInput,
  SyncConflict,
  SyncStatistics,
} from './sync-operation.repository';

// Outbox Event Repository
export { OutboxEventRepository } from './outbox-event.repository';
export type {
  OutboxEventCreateInput,
  OutboxEventUpdateInput,
  EventProcessingResult,
  OutboxStatistics,
} from './outbox-event.repository';

// Health Sample Repository (SEPARATE from entity sync - push-only)
export { HealthSampleRepository } from './health-sample.repository';
export type {
  CreateHealthSampleInput,
  BatchUpsertResult,
  HealthSampleQueryParams,
  TimeRange,
  AggregatedMetric,
} from './health-sample.repository';

// Session Telemetry Cache Repository
export { SessionTelemetryCacheRepository } from './session-telemetry-cache.repository';
export type {
  CreateSessionTelemetryCacheInput,
  UpdateSessionTelemetryCacheInput,
  SessionTelemetryCacheFilters,
  SessionTelemetryCacheKey,
} from './session-telemetry-cache.repository';

// User Health Watermark Repository (P0-G: Freshness tracking)
export { UserHealthWatermarkRepository } from './user-health-watermark.repository';

// Projection Checkpoint Repository (P0-B: Per-projection checkpoint tracking)
export { ProjectionCheckpointRepository } from './projection-checkpoint.repository';
export type {
  ProjectionCheckpointUpsertInput,
  CheckpointSummary,
} from './projection-checkpoint.repository';