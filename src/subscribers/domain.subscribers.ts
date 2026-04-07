/**
 * Domain Subscribers Initialization
 * 
 * Main module for initializing all domain event subscribers.
 * Manages the lifecycle of event subscribers and ensures proper initialization order.
 * 
 * @module domain.subscribers
 */

import { DomainEventService } from '../events/domain-event.service';
import { AchievementSubscriber } from './achievement.subscriber';
import { AnalyticsSubscriber } from './analytics.subscriber';
import { GoalsSubscriber } from './goals.subscriber';
import { WebSocketEventSubscriber } from './websocket-event.subscriber';
import { SessionTelemetrySubscriber } from './session-telemetry.subscriber';
import { LoggerService } from '../services/logger.service';
import { AchievementsService } from '../services/achievements.service';
import { GoalsService } from '../services/goals.service';
import { WebSocketBroadcaster } from '../realtime/WebSocketBroadcaster';
import { DomainEvent } from '../events/domain.events';
// NOTE: UserRoutineService import retained — used by other services outside the subscriber layer.
// RoutineTrainingSubscriber has been retired (HMM replaced by Dirichlet-multinomial temporal engine).
import { PurchaseFinishedSubscriber } from './purchase-finished.subscriber';
import { TemporalPatternSubscriber } from './temporal-pattern.subscriber';
import { UserConsumptionProfileService } from '../services/user-consumption-profile.service';
import { TemporalPatternService } from '../services/temporal-pattern.service';
import { SessionTelemetryQueueService } from '../services/sessionTelemetryQueue.service';

/**
 * Subscriber configuration
 */
export interface SubscriberConfig {
  enableAchievements?: boolean;
  enableAnalytics?: boolean;
  enableGoals?: boolean;
  enableWebSocket?: boolean;
  enablePurchaseFinished?: boolean;
  enableTemporalPattern?: boolean;
  enableSessionTelemetry?: boolean;
  analyticsConfig?: {
    bufferSize?: number;
    flushIntervalMs?: number;
    enableRealTimeAnalytics?: boolean;
  };
}

/**
 * Active subscribers tracking
 */
interface ActiveSubscribers {
  achievement?: AchievementSubscriber;
  analytics?: AnalyticsSubscriber;
  goals?: GoalsSubscriber;
  webSocket?: WebSocketEventSubscriber;
  purchaseFinished?: PurchaseFinishedSubscriber;
  temporalPattern?: TemporalPatternSubscriber;
  sessionTelemetry?: SessionTelemetrySubscriber;
}

/**
 * Domain Subscribers Manager - Factory function with dependency injection
 *
 *  ARCHITECTURAL FIX: Removed DatabaseService dependency
 * Subscribers use repositories directly, which already have PrismaClient injected.
 * DatabaseService is only needed for service-layer transaction orchestration.
 */
export function createDomainSubscribersManager(
  domainEventService: DomainEventService,
  achievementsService: AchievementsService,
  goalsService: GoalsService,
  sessionTelemetryQueueService: SessionTelemetryQueueService,
  logger: LoggerService,
  repositoryFactory: import('../repositories/repository.factory').RepositoryFactory,
  webSocketBroadcaster?: WebSocketBroadcaster,
  userConsumptionProfileService?: UserConsumptionProfileService,
  temporalPatternService?: TemporalPatternService,
) {
  let activeSubscribers: ActiveSubscribers = {};
  let initialized = false;

  /**
   * Initialize all domain event subscribers
   *
   * This function should be called during application bootstrap
   * after all services have been initialized.
   */
  async function initializeDomainSubscribers(config?: SubscriberConfig): Promise<void> {
  if (initialized) {
    logger.warn('Domain subscribers already initialized');
    return;
  }

  const defaultConfig: SubscriberConfig = {
    enableAchievements: true,
    enableAnalytics: true,
    enableGoals: true,
    enableWebSocket: true,
    enablePurchaseFinished: true,
    enableTemporalPattern: true,
    enableSessionTelemetry: true,
    analyticsConfig: {
      bufferSize: 100,
      flushIntervalMs: 30000,
      enableRealTimeAnalytics: true,
    },
  };

  const finalConfig = { ...defaultConfig, ...config };

  logger.info('Initializing domain event subscribers', {
    config: finalConfig,
  });

  try {
    // NOTE: DomainEventService is already initialized in bootstrap.ts
    // No need to call initialize() again - it has idempotency guards
    // Just log that we're proceeding with subscriber initialization
    logger.info('Domain event service ready, initializing subscribers...');

    // Initialize achievement subscriber
    if (finalConfig.enableAchievements) {
      try {
        const achievementSubscriber = new AchievementSubscriber(
          domainEventService,
          achievementsService,
          logger,
        );
        await achievementSubscriber.initialize();
        activeSubscribers.achievement = achievementSubscriber;
        logger.info('Achievement subscriber initialized');
      } catch (error) {
        logger.error('Failed to initialize achievement subscriber', error);
        // Continue with other subscribers even if one fails
      }
    }

    // Initialize analytics subscriber
    if (finalConfig.enableAnalytics) {
      try {
        const analyticsSubscriber = new AnalyticsSubscriber(
          domainEventService,
          repositoryFactory.getDailyStatRepository(), // Inject DailyStatRepository
          logger,
        );
        await analyticsSubscriber.initialize(finalConfig.analyticsConfig);
        activeSubscribers.analytics = analyticsSubscriber;
        logger.info('Analytics subscriber initialized (quantity calculations delegated to ConsumptionService)');
      } catch (error) {
        logger.error('Failed to initialize analytics subscriber', error);
        // Continue with other subscribers
      }
    }

    // Initialize goals subscriber
    //  ISSUE #2.3 FIX: Updated dependencies - removed ConsumptionRepository, SessionRepository, JournalRepository
    // GoalsService.calculateGoalProgress() handles all data access internally
    if (finalConfig.enableGoals) {
      try {
        const goalsSubscriber = new GoalsSubscriber(
          domainEventService,
          goalsService,
          repositoryFactory.getGoalRepository(), // Inject GoalRepository
          logger,
        );
        await goalsSubscriber.initialize();
        activeSubscribers.goals = goalsSubscriber;
        logger.info('Goals subscriber initialized with CQS pattern');
      } catch (error) {
        logger.error('Failed to initialize goals subscriber', error);
        // Continue with other subscribers
      }
    }

    // Initialize WebSocket subscriber
    if (finalConfig.enableWebSocket && webSocketBroadcaster) {
      try {
        const webSocketSubscriber = new WebSocketEventSubscriber(
          domainEventService,
          webSocketBroadcaster,
          logger,
          repositoryFactory.getConsumptionRepository(), // Inject for fetching full entity data
        );
        await webSocketSubscriber.initialize();
        activeSubscribers.webSocket = webSocketSubscriber;
        logger.info('WebSocket subscriber initialized');
      } catch (error) {
        logger.error('Failed to initialize WebSocket subscriber', error);
        // Continue with other subscribers
      }
    }

    // Initialize purchase-finished subscriber (triggers EMA learning)
    if (finalConfig.enablePurchaseFinished && userConsumptionProfileService) {
      try {
        const purchaseFinishedSubscriber = new PurchaseFinishedSubscriber(
          domainEventService,
          userConsumptionProfileService,
          logger,
        );
        await purchaseFinishedSubscriber.initialize();
        activeSubscribers.purchaseFinished = purchaseFinishedSubscriber;
        logger.info('Purchase finished subscriber initialized (EMA learning pipeline)');
      } catch (error) {
        logger.error('Failed to initialize purchase finished subscriber', error);
      }
    } else if (finalConfig.enablePurchaseFinished && !userConsumptionProfileService) {
      logger.warn('Purchase finished subscriber enabled but UserConsumptionProfileService not provided — skipping');
    }

    // Initialize temporal pattern subscriber (Dirichlet-multinomial histogram on session.ended)
    if (finalConfig.enableTemporalPattern !== false && temporalPatternService) {
      try {
        const temporalPatternSubscriber = new TemporalPatternSubscriber(
          domainEventService,
          temporalPatternService,
          logger,
          repositoryFactory.getUserRoutineProfileRepository(), // For auto-creating profile on first session
        );
        await temporalPatternSubscriber.initialize();
        activeSubscribers.temporalPattern = temporalPatternSubscriber;
        logger.info('Temporal pattern subscriber initialized (Dirichlet histogram engine)');
      } catch (error) {
        logger.error('Failed to initialize temporal pattern subscriber', error);
      }
    } else if (finalConfig.enableTemporalPattern !== false && !temporalPatternService) {
      logger.warn('Temporal pattern subscriber enabled but TemporalPatternService not provided — skipping');
    }

    if (finalConfig.enableSessionTelemetry) {
      try {
        const sessionTelemetrySubscriber = new SessionTelemetrySubscriber(
          domainEventService,
          sessionTelemetryQueueService,
          logger,
        );
        await sessionTelemetrySubscriber.initialize();
        activeSubscribers.sessionTelemetry = sessionTelemetrySubscriber;
        logger.info('Session telemetry subscriber initialized');
      } catch (error) {
        logger.error('Failed to initialize session telemetry subscriber', error);
      }
    }

    initialized = true;
    logger.info('Domain event subscribers initialized successfully', {
      activeSubscribers: Object.keys(activeSubscribers),
    });

  } catch (error) {
    logger.error('Failed to initialize domain event subscribers', error);
    throw error;
  }
}

/**
 * Shutdown all domain event subscribers
 *
 * This function should be called during application shutdown
 * to ensure graceful cleanup of event handlers.
 */
async function shutdownDomainSubscribers(): Promise<void> {
  if (!initialized) {
    logger.warn('Domain subscribers not initialized');
    return;
  }

  logger.info('Shutting down domain event subscribers');

  const shutdownPromises: Promise<void>[] = [];

  // Shutdown achievement subscriber
  if (activeSubscribers.achievement) {
    shutdownPromises.push(
      activeSubscribers.achievement.shutdown()
        .catch(error => {
          logger.error('Error shutting down achievement subscriber', error);
        }),
    );
  }

  // Shutdown analytics subscriber
  if (activeSubscribers.analytics) {
    shutdownPromises.push(
      activeSubscribers.analytics.shutdown()
        .catch(error => {
          logger.error('Error shutting down analytics subscriber', error);
        }),
    );
  }

  // Shutdown goals subscriber
  if (activeSubscribers.goals) {
    shutdownPromises.push(
      activeSubscribers.goals.shutdown()
        .catch(error => {
          logger.error('Error shutting down goals subscriber', error);
        }),
    );
  }

  if (activeSubscribers.purchaseFinished) {
    shutdownPromises.push(
      activeSubscribers.purchaseFinished.shutdown()
        .catch(error => {
          logger.error('Error shutting down purchase finished subscriber', error);
        }),
    );
  }

  if (activeSubscribers.temporalPattern) {
    shutdownPromises.push(
      activeSubscribers.temporalPattern.shutdown()
        .catch(error => {
          logger.error('Error shutting down temporal pattern subscriber', error);
        }),
    );
  }

  if (activeSubscribers.sessionTelemetry) {
    shutdownPromises.push(
      activeSubscribers.sessionTelemetry.shutdown()
        .catch(error => {
          logger.error('Error shutting down session telemetry subscriber', error);
        }),
    );
  }

  // Shutdown WebSocket subscriber
  if (activeSubscribers.webSocket) {
    shutdownPromises.push(
      activeSubscribers.webSocket.shutdown()
        .catch(error => {
          logger.error('Error shutting down WebSocket subscriber', error);
        }),
    );
  }

  // Wait for all shutdowns to complete
  await Promise.all(shutdownPromises);

  // Shutdown domain event service (use injected instance from closure)
  await domainEventService.shutdown();

  activeSubscribers = {};
  initialized = false;

  logger.info('Domain event subscribers shut down successfully');
}

  // Return the manager interface
  return {
    initializeDomainSubscribers,
    shutdownDomainSubscribers,
    getInitialized: () => initialized,
    getActiveSubscribers: () => activeSubscribers,
  };
}

/**
 * Get metrics from all active subscribers with dependency injection
 */
export function getSubscriberMetrics(domainEventService: DomainEventService): Record<string, unknown> {
  const metrics: Record<string, unknown> = {
    initialized: managerInstance?.getInitialized() || false,
    activeSubscribers: Object.keys(managerInstance?.getActiveSubscribers() || {}),
  };

  // Get domain event service metrics
  metrics.domainEventService = domainEventService.getMetrics();

  // Get metrics from each active subscriber
  const activeSubscribers = managerInstance?.getActiveSubscribers() || {};
  if (activeSubscribers.analytics) {
    metrics.analytics = activeSubscribers.analytics.getMetrics();
  }

  if (activeSubscribers.goals) {
    metrics.goals = activeSubscribers.goals.getMetrics();
  }

  return metrics;
}

/**
 * Replay events for testing or recovery with dependency injection
 *
 * @param domainEventService Domain event service instance
 * @param filter Optional filter function for events
 * @param limit Maximum number of events to replay
 */
export async function replayDomainEvents(
  domainEventService: DomainEventService,
  filter?: (event: DomainEvent) => boolean,
  limit?: number,
): Promise<void> {
  if (!managerInstance?.getInitialized()) {
    throw new Error('Domain subscribers not initialized');
  }

  await domainEventService.replayEvents(filter, limit);
}

/**
 * Get dead letter queue entries with dependency injection
 *
 * @param domainEventService Domain event service instance
 * @param limit Maximum number of entries to return
 */
export function getDeadLetterQueue(
  domainEventService: DomainEventService,
  limit?: number,
): ReturnType<DomainEventService['getDeadLetterQueue']> {
  if (!managerInstance?.getInitialized()) {
    throw new Error('Domain subscribers not initialized');
  }

  return domainEventService.getDeadLetterQueue(limit);
}

/**
 * Retry failed events from dead letter queue with dependency injection
 *
 * @param domainEventService Domain event service instance
 */
export async function retryDeadLetterQueue(domainEventService: DomainEventService): Promise<void> {
  if (!managerInstance?.getInitialized()) {
    throw new Error('Domain subscribers not initialized');
  }

  await domainEventService.retryDeadLetterQueue();
}

// Create singleton instances for export compatibility
let managerInstance: ReturnType<typeof createDomainSubscribersManager> | null = null;

/**
 * Initialize domain subscribers - compatibility function for bootstrap
 * @param dependencies Required dependencies for domain subscribers
 *
 *  ARCHITECTURAL FIX: Removed DatabaseService dependency
 * Subscribers use repositories directly, which already have PrismaClient injected.
 */
export async function initializeDomainSubscribers(dependencies: {
  domainEventService: DomainEventService;
  achievementsService: AchievementsService;
  goalsService: GoalsService;
  sessionTelemetryQueueService: SessionTelemetryQueueService;
  logger: LoggerService;
  repositoryFactory: import('../repositories/repository.factory').RepositoryFactory;
  webSocketBroadcaster?: WebSocketBroadcaster;
  userConsumptionProfileService?: UserConsumptionProfileService;
  temporalPatternService?: TemporalPatternService;
  /** @deprecated No longer used — retained for backward-compatible call sites */
  userRoutineService?: unknown;
}, config?: SubscriberConfig): Promise<void> {
  if (!managerInstance) {
    managerInstance = createDomainSubscribersManager(
      dependencies.domainEventService,
      dependencies.achievementsService,
      dependencies.goalsService,
      dependencies.sessionTelemetryQueueService,
      dependencies.logger,
      dependencies.repositoryFactory,
      dependencies.webSocketBroadcaster,
      dependencies.userConsumptionProfileService,
      dependencies.temporalPatternService,
    );
  }
  return managerInstance.initializeDomainSubscribers(config);
}

/**
 * Shutdown domain subscribers - compatibility function for bootstrap
 */
export async function shutdownDomainSubscribers(): Promise<void> {
  if (managerInstance) {
    return managerInstance.shutdownDomainSubscribers();
  }
}

/**
 * Export for convenience
 */
export {
  DomainEventService,
  AchievementSubscriber,
  AnalyticsSubscriber,
  GoalsSubscriber,
  WebSocketEventSubscriber,
  PurchaseFinishedSubscriber,
};
