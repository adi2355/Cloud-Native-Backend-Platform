/**
 * Repository Factory for Dependency Injection
 *
 * Centralized factory for creating and managing repository instances.
 * Provides lazy initialization and caching of repository instances.
 *
 *  MODERN DI PATTERN: Pure constructor injection
 * - No singleton getInstance() pattern
 * - Instantiated once in bootstrap.ts (composition root)
 * - Injected as dependency where needed
 *
 * This factory provides:
 * - Lazy initialization of repositories
 * - Cached repository instances per factory
 * - Centralized dependency injection
 * - Easy mocking for testing
 *
 * Usage:
 * ```typescript
 * const factory = new RepositoryFactory(prismaClient, logger);
 * const userRepo = factory.getUserRepository();
 * ```
 */

import { PrismaClient } from '@prisma/client';
import { DatabaseService } from '../services/database.service';
import { LoggerService } from '../services/logger.service';
import { PerformanceMonitoringService } from '../services/performanceMonitoring.service';

// Import base repository
import { BaseRepository } from './base.repository';

// Import all repositories
import { UserRepository } from './user.repository';
import { ConsumptionRepository } from './consumption.repository';
import { ProductRepository } from './product.repository';
// import { ProductReviewRepository } from './product-review.repository';
import { PurchaseRepository } from './purchase.repository';
import { SessionRepository } from './session.repository';
import { JournalRepository } from './journal.repository';
import { DeviceRepository } from './device.repository';
import { GoalRepository } from './goal.repository';
import { AchievementRepository } from './achievement.repository';
import { UserAchievementRepository } from './user-achievement.repository';
import { InventoryRepository } from './inventory.repository';
import { InventoryAdjustmentRepository } from './inventory-adjustment.repository';
import { DailyStatRepository } from './daily-stat.repository';
import { SyncOperationRepository } from './sync-operation.repository';
import { OutboxEventRepository } from './outbox-event.repository';
import { SafetyRecordRepository } from './safety-record.repository';
import { AiUsageRecordRepository } from './ai-usage-record.repository';
import { SyncChangeRepository } from './sync-change.repository';
import { SyncConflictRepository } from './sync-conflict.repository';
import { SyncStateRepository } from './sync-state.repository';
import { UserStatisticsRepository } from './user-statistics.repository';
import { UserConsumptionProfileRepository } from './user-consumption-profile.repository';
import { UserRoutineProfileRepository } from './user-routine-profile.repository';
import { AiChatThreadRepository } from './ai-chat-thread.repository';
import { AiChatMessageRepository } from './ai-chat-message.repository';
import { AiResponseCacheRepository } from './ai-response-cache.repository';
import { AiRecommendationSetRepository } from './ai-recommendation-set.repository';
import { AiRecommendationItemRepository } from './ai-recommendation-item.repository';
import { AiAnalysisRepository } from './ai-analysis.repository';
import { DeviceTelemetryRepository } from './device-telemetry.repository';
import { AnalyticsEventRepository } from './analytics-event.repository';
import { WebSocketEventRepository } from './websocket-event.repository';
import { LiveConsumptionRepository } from './live-consumption.repository';
import { SessionMessageRepository } from './session-message.repository';
import { PredictionRecordRepository } from './prediction-record.repository';
import { HealthSampleRepository } from './health-sample.repository';
import { SessionTelemetryCacheRepository } from './session-telemetry-cache.repository';
import { UserHealthWatermarkRepository } from './user-health-watermark.repository';
import { HealthRollupDayRepository } from './health-rollup-day.repository';
import { SleepNightSummaryRepository } from './sleep-night-summary.repository';
import { SessionImpactSummaryRepository } from './session-impact-summary.repository';
import { ProductImpactRollupRepository } from './product-impact-rollup.repository';

/**
 * Repository Factory class for managing all repository instances
 */
export class RepositoryFactory {
  private prisma: PrismaClient;
  private logger: LoggerService;
  private performanceMonitoring?: PerformanceMonitoringService;
  
  // Repository instances (lazy initialized)
  private userRepository?: UserRepository;
  private consumptionRepository?: ConsumptionRepository;
  private productRepository?: ProductRepository;
  // private productReviewRepository?: ProductReviewRepository;
  private purchaseRepository?: PurchaseRepository;
  private sessionRepository?: SessionRepository;
  private journalRepository?: JournalRepository;
  private deviceRepository?: DeviceRepository;
  private goalRepository?: GoalRepository;
  private achievementRepository?: AchievementRepository;
  private userAchievementRepository?: UserAchievementRepository;
  private inventoryRepository?: InventoryRepository;
  private inventoryAdjustmentRepository?: InventoryAdjustmentRepository;
  private dailyStatRepository?: DailyStatRepository;
  private syncOperationRepository?: SyncOperationRepository;
  private outboxEventRepository?: OutboxEventRepository;
  private safetyRecordRepository?: SafetyRecordRepository;
  private aiUsageRecordRepository?: AiUsageRecordRepository;
  private syncChangeRepository?: SyncChangeRepository;
  private syncConflictRepository?: SyncConflictRepository;
  private syncStateRepository?: SyncStateRepository;
  private userStatisticsRepository?: UserStatisticsRepository;
  private userConsumptionProfileRepository?: UserConsumptionProfileRepository;
  private userRoutineProfileRepository?: UserRoutineProfileRepository;
  private aiChatThreadRepository?: AiChatThreadRepository;
  private aiChatMessageRepository?: AiChatMessageRepository;
  private aiResponseCacheRepository?: AiResponseCacheRepository;
  private aiRecommendationSetRepository?: AiRecommendationSetRepository;
  private aiRecommendationItemRepository?: AiRecommendationItemRepository;
  private aiAnalysisRepository?: AiAnalysisRepository;
  private deviceTelemetryRepository?: DeviceTelemetryRepository;
  private analyticsEventRepository?: AnalyticsEventRepository;
  private webSocketEventRepository?: WebSocketEventRepository;
  private liveConsumptionRepository?: LiveConsumptionRepository;
  private sessionMessageRepository?: SessionMessageRepository;
  private predictionRecordRepository?: PredictionRecordRepository;
  private healthSampleRepository?: HealthSampleRepository;
  private sessionTelemetryCacheRepository?: SessionTelemetryCacheRepository;
  private userHealthWatermarkRepository?: UserHealthWatermarkRepository;
  private healthRollupDayRepository?: HealthRollupDayRepository;
  private sleepNightSummaryRepository?: SleepNightSummaryRepository;
  private sessionImpactSummaryRepository?: SessionImpactSummaryRepository;
  private productImpactRollupRepository?: ProductImpactRollupRepository;

  /**
   * Constructor with pure dependency injection
   * @param prisma - PrismaClient instance (required)
   * @param logger - LoggerService instance (required)
   */
  public constructor(prisma: PrismaClient, logger: LoggerService, performanceMonitoring?: PerformanceMonitoringService) {
    if (!prisma) {
      throw new Error('RepositoryFactory: PrismaClient instance is required');
    }
    if (!logger) {
      throw new Error('RepositoryFactory: LoggerService instance is required');
    }

    this.prisma = prisma;
    this.logger = logger;
    this.performanceMonitoring = performanceMonitoring;
  }

  /**
   * Get PrismaClient instance
   *
   *  ISSUE #2.1 FIX: Expose PrismaClient for system-wide operations
   * Used by subscribers and other components that need direct database access
   * without user-specific filtering (e.g., AnalyticsSubscriber for product lookups)
   *
   * @returns PrismaClient instance
   */
  public getPrismaClient(): PrismaClient {
    return this.prisma;
  }

  /**
   * Get UserRepository instance
   * @returns UserRepository singleton
   */
  public getUserRepository(): UserRepository {
    if (!this.userRepository) {
      this.userRepository = new UserRepository(this.prisma, 'User', this.logger);
    }
    return this.userRepository;
  }

  /**
   * Get ConsumptionRepository instance
   * @returns ConsumptionRepository singleton
   */
  public getConsumptionRepository(): ConsumptionRepository {
    if (!this.consumptionRepository) {
      this.consumptionRepository = new ConsumptionRepository(this.prisma, 'Consumption', this.logger);
    }
    return this.consumptionRepository;
  }

  /**
   * Get ProductRepository instance
   * @returns ProductRepository singleton
   */
  public getProductRepository(): ProductRepository {
    if (!this.productRepository) {
      this.productRepository = new ProductRepository(this.prisma, 'Product', this.logger);
    }
    return this.productRepository;
  }


  /**
   * Get PurchaseRepository instance
   * @returns PurchaseRepository singleton
   */
  public getPurchaseRepository(): PurchaseRepository {
    if (!this.purchaseRepository) {
      this.purchaseRepository = new PurchaseRepository(this.prisma, 'Purchase', this.logger);
    }
    return this.purchaseRepository;
  }

  /**
   * Get SessionRepository instance
   * @returns SessionRepository singleton
   */
  public getSessionRepository(): SessionRepository {
    if (!this.sessionRepository) {
      this.sessionRepository = new SessionRepository(this.prisma, 'Session', this.logger);
    }
    return this.sessionRepository;
  }

  /**
   * Get JournalRepository instance
   * @returns JournalRepository singleton
   */
  public getJournalRepository(): JournalRepository {
    if (!this.journalRepository) {
      this.journalRepository = new JournalRepository(this.prisma, 'Journal', this.logger);
    }
    return this.journalRepository;
  }

  /**
   * Get DeviceRepository instance
   * @returns DeviceRepository singleton
   */
  public getDeviceRepository(): DeviceRepository {
    if (!this.deviceRepository) {
      this.deviceRepository = new DeviceRepository(this.prisma, 'Device', this.logger);
    }
    return this.deviceRepository;
  }

  /**
   * Get GoalRepository instance
   * @returns GoalRepository singleton
   */
  public getGoalRepository(): GoalRepository {
    if (!this.goalRepository) {
      this.goalRepository = new GoalRepository(this.prisma, 'Goal', this.logger);
    }
    return this.goalRepository;
  }

  /**
   * Get AchievementRepository instance
   * @returns AchievementRepository singleton
   */
  public getAchievementRepository(): AchievementRepository {
    if (!this.achievementRepository) {
      this.achievementRepository = new AchievementRepository(this.prisma, 'Achievement', this.logger);
    }
    return this.achievementRepository;
  }

  /**
   * Get UserAchievementRepository instance
   * @returns UserAchievementRepository singleton
   */
  public getUserAchievementRepository(): UserAchievementRepository {
    if (!this.userAchievementRepository) {
      this.userAchievementRepository = new UserAchievementRepository(this.prisma, 'UserAchievement', this.logger);
    }
    return this.userAchievementRepository;
  }

  /**
   * Get InventoryRepository instance
   * @returns InventoryRepository singleton
   */
  public getInventoryRepository(): InventoryRepository {
    if (!this.inventoryRepository) {
      this.inventoryRepository = new InventoryRepository(this.prisma, 'Inventory', this.logger);
    }
    return this.inventoryRepository;
  }

  /**
   * Get InventoryAdjustmentRepository instance
   * @returns InventoryAdjustmentRepository singleton
   */
  public getInventoryAdjustmentRepository(): InventoryAdjustmentRepository {
    if (!this.inventoryAdjustmentRepository) {
      this.inventoryAdjustmentRepository = new InventoryAdjustmentRepository(this.prisma, 'InventoryAdjustment', this.logger);
    }
    return this.inventoryAdjustmentRepository;
  }

  /**
   * Get DailyStatRepository instance
   * @returns DailyStatRepository singleton
   */
  public getDailyStatRepository(): DailyStatRepository {
    if (!this.dailyStatRepository) {
      this.dailyStatRepository = new DailyStatRepository(this.prisma, 'DailyStat', this.logger);
    }
    return this.dailyStatRepository;
  }

  /**
   * Get SyncOperationRepository instance
   * @returns SyncOperationRepository singleton
   */
  public getSyncOperationRepository(): SyncOperationRepository {
    if (!this.syncOperationRepository) {
      this.syncOperationRepository = new SyncOperationRepository(this.prisma, 'SyncOperation', this.logger);
    }
    return this.syncOperationRepository;
  }

  /**
   * Get OutboxEventRepository instance
   * @returns OutboxEventRepository singleton
   */
  public getOutboxEventRepository(): OutboxEventRepository {
    if (!this.outboxEventRepository) {
      this.outboxEventRepository = new OutboxEventRepository(this.prisma, 'OutboxEvent', this.logger);
    }
    return this.outboxEventRepository;
  }

  /**
   * Get SafetyRecordRepository instance
   * @returns SafetyRecordRepository singleton
   */
  public getSafetyRecordRepository(): SafetyRecordRepository {
    if (!this.safetyRecordRepository) {
      this.safetyRecordRepository = new SafetyRecordRepository(this.prisma, 'SafetyRecord', this.logger);
    }
    return this.safetyRecordRepository;
  }

  /**
   * Get AiUsageRecordRepository instance
   * @returns AiUsageRecordRepository singleton
   */
  public getAiUsageRecordRepository(): AiUsageRecordRepository {
    if (!this.aiUsageRecordRepository) {
      this.aiUsageRecordRepository = new AiUsageRecordRepository(this.prisma, 'AiUsageRecord', this.logger);
    }
    return this.aiUsageRecordRepository;
  }

  /**
   * Get SyncChangeRepository instance
   * @returns SyncChangeRepository singleton
   */
  public getSyncChangeRepository(): SyncChangeRepository {
    if (!this.syncChangeRepository) {
      this.syncChangeRepository = new SyncChangeRepository(this.prisma, 'SyncChange', this.logger);
    }
    return this.syncChangeRepository;
  }

  /**
   * Get SyncConflictRepository instance
   * @returns SyncConflictRepository singleton
   */
  public getSyncConflictRepository(): SyncConflictRepository {
    if (!this.syncConflictRepository) {
      this.syncConflictRepository = new SyncConflictRepository(this.prisma, 'SyncConflict', this.logger);
    }
    return this.syncConflictRepository;
  }


  /**
   * Get SyncStateRepository instance
   * @returns SyncStateRepository singleton
   */
  public getSyncStateRepository(): SyncStateRepository {
    if (!this.syncStateRepository) {
      this.syncStateRepository = new SyncStateRepository(this.prisma, 'SyncState', this.logger);
    }
    return this.syncStateRepository;
  }

  /**
   * Get UserStatisticsRepository instance
   * @returns UserStatisticsRepository singleton
   */
  public getUserStatisticsRepository(): UserStatisticsRepository {
    if (!this.userStatisticsRepository) {
      this.userStatisticsRepository = new UserStatisticsRepository(this.prisma, 'UserStatistics', this.logger);
    }
    return this.userStatisticsRepository;
  }

  /**
   * Get UserConsumptionProfileRepository instance
   * @returns UserConsumptionProfileRepository singleton
   */
  public getUserConsumptionProfileRepository(): UserConsumptionProfileRepository {
    if (!this.userConsumptionProfileRepository) {
      this.userConsumptionProfileRepository = new UserConsumptionProfileRepository(this.prisma, 'UserConsumptionProfile', this.logger);
    }
    return this.userConsumptionProfileRepository;
  }

  /**
   * Get UserRoutineProfileRepository instance
   * @returns UserRoutineProfileRepository singleton
   */
  public getUserRoutineProfileRepository(): UserRoutineProfileRepository {
    if (!this.userRoutineProfileRepository) {
      this.userRoutineProfileRepository = new UserRoutineProfileRepository(this.prisma, 'UserRoutineProfile', this.logger);
    }
    return this.userRoutineProfileRepository;
  }

  /**
   * Get AiChatThreadRepository instance
   * @returns AiChatThreadRepository singleton
   */
  public getAiChatThreadRepository(): AiChatThreadRepository {
    if (!this.aiChatThreadRepository) {
      this.aiChatThreadRepository = new AiChatThreadRepository(this.prisma, 'AiChatThread', this.logger);
    }
    return this.aiChatThreadRepository;
  }

  /**
   * Get AiChatMessageRepository instance
   * @returns AiChatMessageRepository singleton
   */
  public getAiChatMessageRepository(): AiChatMessageRepository {
    if (!this.aiChatMessageRepository) {
      this.aiChatMessageRepository = new AiChatMessageRepository(this.prisma, 'AiChatMessage', this.logger);
    }
    return this.aiChatMessageRepository;
  }

  /**
   * Get AiResponseCacheRepository instance
   * @returns AiResponseCacheRepository singleton
   */
  public getAiResponseCacheRepository(): AiResponseCacheRepository {
    if (!this.aiResponseCacheRepository) {
      this.aiResponseCacheRepository = new AiResponseCacheRepository(this.prisma, 'AiResponseCache', this.logger);
    }
    return this.aiResponseCacheRepository;
  }

  /**
   * Get AiRecommendationSetRepository instance
   * @returns AiRecommendationSetRepository singleton
   */
  public getAiRecommendationSetRepository(): AiRecommendationSetRepository {
    if (!this.aiRecommendationSetRepository) {
      this.aiRecommendationSetRepository = new AiRecommendationSetRepository(this.prisma, 'AiRecommendationSet', this.logger);
    }
    return this.aiRecommendationSetRepository;
  }

  /**
   * Get AiRecommendationItemRepository instance
   * @returns AiRecommendationItemRepository singleton
   */
  public getAiRecommendationItemRepository(): AiRecommendationItemRepository {
    if (!this.aiRecommendationItemRepository) {
      this.aiRecommendationItemRepository = new AiRecommendationItemRepository(this.prisma, 'AiRecommendationItem', this.logger);
    }
    return this.aiRecommendationItemRepository;
  }

  /**
   * Get AiAnalysisRepository instance
   * @returns AiAnalysisRepository singleton
   */
  public getAiAnalysisRepository(): AiAnalysisRepository {
    if (!this.aiAnalysisRepository) {
      this.aiAnalysisRepository = new AiAnalysisRepository(this.prisma, 'AiAnalysis', this.logger);
    }
    return this.aiAnalysisRepository;
  }

  /**
   * Get DeviceTelemetryRepository instance
   * @returns DeviceTelemetryRepository singleton
   */
  public getDeviceTelemetryRepository(): DeviceTelemetryRepository {
    if (!this.deviceTelemetryRepository) {
      this.deviceTelemetryRepository = new DeviceTelemetryRepository(this.prisma, this.logger);
    }
    return this.deviceTelemetryRepository;
  }

  /**
   * Get AnalyticsEventRepository instance
   * @returns AnalyticsEventRepository singleton
   */
  public getAnalyticsEventRepository(): AnalyticsEventRepository {
    if (!this.analyticsEventRepository) {
      this.analyticsEventRepository = new AnalyticsEventRepository(this.prisma, this.logger);
    }
    return this.analyticsEventRepository;
  }

  /**
   * Get WebSocketEventRepository instance
   * @returns WebSocketEventRepository singleton
   */
  public getWebSocketEventRepository(): WebSocketEventRepository {
    if (!this.webSocketEventRepository) {
      this.webSocketEventRepository = new WebSocketEventRepository(this.prisma, 'WebSocketEvent', this.logger);
    }
    return this.webSocketEventRepository;
  }

  /**
   * Get LiveConsumptionRepository instance
   * @returns LiveConsumptionRepository singleton
   */
  public getLiveConsumptionRepository(): LiveConsumptionRepository {
    if (!this.liveConsumptionRepository) {
      this.liveConsumptionRepository = new LiveConsumptionRepository(this.prisma, 'LiveConsumption', this.logger);
    }
    return this.liveConsumptionRepository;
  }

  /**
   * Get SessionMessageRepository instance
   * @returns SessionMessageRepository singleton
   */
  public getSessionMessageRepository(): SessionMessageRepository {
    if (!this.sessionMessageRepository) {
      this.sessionMessageRepository = new SessionMessageRepository(this.prisma, 'SessionMessage', this.logger);
    }
    return this.sessionMessageRepository;
  }

  /**
   * Get PredictionRecordRepository instance
   * @returns PredictionRecordRepository singleton
   */
  public getPredictionRecordRepository(): PredictionRecordRepository {
    if (!this.predictionRecordRepository) {
      this.predictionRecordRepository = new PredictionRecordRepository(this.prisma, 'PredictionRecord', this.logger);
    }
    return this.predictionRecordRepository;
  }

  /**
   * Get HealthSampleRepository instance
   *
   * NOTE: HealthSampleRepository has a different constructor signature than BaseRepository.
   * It takes PrismaClient and LoggerService directly, not a model name.
   *
   * @returns HealthSampleRepository singleton
   */
  public getHealthSampleRepository(): HealthSampleRepository {
    if (!this.healthSampleRepository) {
      this.healthSampleRepository = new HealthSampleRepository(
        this.prisma,
        this.logger,
        this.performanceMonitoring
      );
    }
    return this.healthSampleRepository;
  }

  /**
   * Get SessionTelemetryCacheRepository instance
   *
   * @returns SessionTelemetryCacheRepository singleton
   */
  public getSessionTelemetryCacheRepository(): SessionTelemetryCacheRepository {
    if (!this.sessionTelemetryCacheRepository) {
      this.sessionTelemetryCacheRepository = new SessionTelemetryCacheRepository(
        this.prisma,
        'SessionTelemetryCache',
        this.logger
      );
    }
    return this.sessionTelemetryCacheRepository;
  }

  /**
   * Get UserHealthWatermarkRepository instance
   * @returns UserHealthWatermarkRepository singleton
   */
  public getUserHealthWatermarkRepository(): UserHealthWatermarkRepository {
    if (!this.userHealthWatermarkRepository) {
      this.userHealthWatermarkRepository = new UserHealthWatermarkRepository(
        this.prisma,
        this.logger
      );
    }
    return this.userHealthWatermarkRepository;
  }

  /**
   * Get HealthRollupDayRepository instance
   * @returns HealthRollupDayRepository singleton
   */
  public getHealthRollupDayRepository(): HealthRollupDayRepository {
    if (!this.healthRollupDayRepository) {
      this.healthRollupDayRepository = new HealthRollupDayRepository(
        this.prisma,
        this.logger
      );
    }
    return this.healthRollupDayRepository;
  }

  /**
   * Get SleepNightSummaryRepository instance
   * @returns SleepNightSummaryRepository singleton
   */
  public getSleepNightSummaryRepository(): SleepNightSummaryRepository {
    if (!this.sleepNightSummaryRepository) {
      this.sleepNightSummaryRepository = new SleepNightSummaryRepository(
        this.prisma,
        this.logger
      );
    }
    return this.sleepNightSummaryRepository;
  }

  /**
   * Get SessionImpactSummaryRepository instance
   * @returns SessionImpactSummaryRepository singleton
   */
  public getSessionImpactSummaryRepository(): SessionImpactSummaryRepository {
    if (!this.sessionImpactSummaryRepository) {
      this.sessionImpactSummaryRepository = new SessionImpactSummaryRepository(
        this.prisma,
        this.logger
      );
    }
    return this.sessionImpactSummaryRepository;
  }

  /**
   * Get ProductImpactRollupRepository singleton
   * @returns ProductImpactRollupRepository singleton
   */
  public getProductImpactRollupRepository(): ProductImpactRollupRepository {
    if (!this.productImpactRollupRepository) {
      this.productImpactRollupRepository = new ProductImpactRollupRepository(
        this.prisma,
        this.logger
      );
    }
    return this.productImpactRollupRepository;
  }

  /**
   * Get all repository instances (for testing or bulk operations)
   * @returns Object containing all repository instances
   */
  public getAllRepositories(): Record<string, BaseRepository<unknown>> {
    return {
      user: this.getUserRepository(),
      consumption: this.getConsumptionRepository(),
      product: this.getProductRepository(),
      // productReview: this.getProductReviewRepository(), // REMOVED: ProductReview not in schema
      purchase: this.getPurchaseRepository(),
      session: this.getSessionRepository(),
      journal: this.getJournalRepository(),
      device: this.getDeviceRepository(),
      goal: this.getGoalRepository(),
      achievement: this.getAchievementRepository(),
      userAchievement: this.getUserAchievementRepository(),
      inventory: this.getInventoryRepository(),
      inventoryAdjustment: this.getInventoryAdjustmentRepository(),
      dailyStat: this.getDailyStatRepository(),
      syncOperation: this.getSyncOperationRepository(),
      outboxEvent: this.getOutboxEventRepository(),
      safetyRecord: this.getSafetyRecordRepository(),
      aiUsageRecord: this.getAiUsageRecordRepository(),
      syncChange: this.getSyncChangeRepository(),
      syncConflict: this.getSyncConflictRepository(),
      syncState: this.getSyncStateRepository(),
      userStatistics: this.getUserStatisticsRepository(),
      userConsumptionProfile: this.getUserConsumptionProfileRepository(),
      userRoutineProfile: this.getUserRoutineProfileRepository(),
      aiChatThread: this.getAiChatThreadRepository(),
      aiChatMessage: this.getAiChatMessageRepository(),
      aiResponseCache: this.getAiResponseCacheRepository(),
      aiRecommendationSet: this.getAiRecommendationSetRepository(),
      aiRecommendationItem: this.getAiRecommendationItemRepository(),
      aiAnalysis: this.getAiAnalysisRepository(),
      deviceTelemetry: this.getDeviceTelemetryRepository(),
      analyticsEvent: this.getAnalyticsEventRepository(),
      webSocketEvent: this.getWebSocketEventRepository(),
      liveConsumption: this.getLiveConsumptionRepository(),
      sessionMessage: this.getSessionMessageRepository(),
      predictionRecord: this.getPredictionRecordRepository(),
      healthSample: this.getHealthSampleRepository(),
      sessionTelemetryCache: this.getSessionTelemetryCacheRepository(),
      userHealthWatermark: this.getUserHealthWatermarkRepository(),
      healthRollupDay: this.getHealthRollupDayRepository(),
      sleepNightSummary: this.getSleepNightSummaryRepository(),
      sessionImpactSummary: this.getSessionImpactSummaryRepository(),
      productImpactRollup: this.getProductImpactRollupRepository(),
    };
  }

  /**
   * Clear all repository instances (useful for testing)
   */
  public clearRepositories(): void {
    this.userRepository = undefined;
    this.consumptionRepository = undefined;
    this.productRepository = undefined;
    this.purchaseRepository = undefined;
    this.sessionRepository = undefined;
    this.journalRepository = undefined;
    this.deviceRepository = undefined;
    this.goalRepository = undefined;
    this.achievementRepository = undefined;
    this.userAchievementRepository = undefined;
    this.inventoryRepository = undefined;
    this.inventoryAdjustmentRepository = undefined;
    this.dailyStatRepository = undefined;
    this.syncOperationRepository = undefined;
    this.outboxEventRepository = undefined;
    this.safetyRecordRepository = undefined;
    this.aiUsageRecordRepository = undefined;
    this.syncChangeRepository = undefined;
    this.syncConflictRepository = undefined;
    this.syncStateRepository = undefined;
    this.userStatisticsRepository = undefined;
    this.userConsumptionProfileRepository = undefined;
    this.userRoutineProfileRepository = undefined;
    this.aiChatThreadRepository = undefined;
    this.aiChatMessageRepository = undefined;
    this.aiResponseCacheRepository = undefined;
    this.aiRecommendationSetRepository = undefined;
    this.aiRecommendationItemRepository = undefined;
    this.aiAnalysisRepository = undefined;
    this.deviceTelemetryRepository = undefined;
    this.analyticsEventRepository = undefined;
    this.webSocketEventRepository = undefined;
    this.liveConsumptionRepository = undefined;
    this.sessionMessageRepository = undefined;
    this.predictionRecordRepository = undefined;
    this.healthSampleRepository = undefined;
    this.sessionTelemetryCacheRepository = undefined;
    this.userHealthWatermarkRepository = undefined;
    this.healthRollupDayRepository = undefined;
    this.sleepNightSummaryRepository = undefined;
    this.sessionImpactSummaryRepository = undefined;
    this.productImpactRollupRepository = undefined;
  }

  /**
   * Set a custom PrismaClient (useful for testing with mocked client)
   * @param prisma - PrismaClient instance to use
   */
  public setPrismaClient(prisma: PrismaClient): void {
    this.prisma = prisma;
    // Clear existing repositories to force re-initialization with new client
    this.clearRepositories();
  }
}

/**
 * Export a convenience function for creating repository factory
 * @param prisma - PrismaClient instance (required)
 * @param logger - LoggerService instance (required)
 * @returns RepositoryFactory instance
 */
export function getRepositories(prisma: PrismaClient, logger: LoggerService): RepositoryFactory {
  return new RepositoryFactory(prisma, logger);
}
