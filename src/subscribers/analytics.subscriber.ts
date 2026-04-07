/**
 * Analytics Subscriber
 * 
 * Tracks domain events for analytics and reporting purposes.
 * Aggregates event data for insights and metrics.
 * 
 * @module analytics.subscriber
 */

import { DomainEventService } from '../events/domain-event.service';
import { LoggerService } from '../services/logger.service';
import { DailyStatRepository } from '../repositories/daily-stat.repository';
import {
  ConsumptionCreatedEvent,
  ConsumptionUpdatedEvent,
  ConsumptionDeletedEvent,
  GoalCompletedEvent,
  PurchaseCreatedEvent,
  PurchaseUpdatedEvent,
  PurchaseDeletedEvent,
  SessionEndedEvent,
  AchievementUnlockedEvent,
  EventPriority,
  DomainEvent,
} from '../events/domain.events';

/**
 * Analytics event metrics
 *
 *  ISSUE #6 FIX: Removed InternalDomainEvent interface
 * DomainEvent now includes eventType, userId, aggregateId, version by default
 */
interface EventMetrics {
  eventType: string;
  userId: string;
  aggregateId: string;
  timestamp: Date;
  metadata: Record<string, unknown>;
}

/**
 * Analytics Subscriber - Processes events for analytics and reporting
 */
export class AnalyticsSubscriber {
  private initialized: boolean = false;
  private subscriptionIds: string[] = [];
  private eventBuffer: EventMetrics[] = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;

  // Configuration
  private config = {
    bufferSize: 100,
    flushIntervalMs: 30000, // 30 seconds
    enableRealTimeAnalytics: true,
    enableAggregation: true,
  };

  /**
   * Constructor with explicit dependency injection (Pure DI - no singleton)
   * All dependencies are required and injected by domain.subscribers.ts
   *
   *  ARCHITECTURAL FIX: Removed DatabaseService dependency
   * Repositories already have PrismaClient injected via BaseRepository.
   * DatabaseService is for service-layer transaction orchestration, not needed in subscribers.
   *
   *  ISSUE #2.2 FIX: Removed PrismaClient dependency
   * Quantity calculations are now performed by ConsumptionService and passed in event payloads.
   * AnalyticsSubscriber no longer needs direct database access for consumption rate calculations.
   */
  public constructor(
    private domainEventService: DomainEventService,
    private dailyStatRepository: DailyStatRepository,
    private logger: LoggerService,
  ) {
    if (!domainEventService || !dailyStatRepository || !logger) {
      throw new Error('AnalyticsSubscriber: All dependencies (DomainEventService, DailyStatRepository, LoggerService) must be provided');
    }
  }

  /**
   * Initialize subscriber and register event handlers
   */
  public async initialize(config?: Partial<typeof this.config>): Promise<void> {
    if (this.initialized) return;

    try {
      // Dependencies are now injected via constructor

      // Apply custom configuration
      if (config) {
        this.config = { ...this.config, ...config };
      }

      // Subscribe to all events with wildcard
      // The '*' wildcard is now properly typed in EventTypeMap for analytics/monitoring
      const wildcardSubId = this.domainEventService.subscribe(
        '*',
        'AnalyticsSubscriber.allEvents',
        this.handleAllEvents.bind(this),
        {
          priority: EventPriority.LOW, // Analytics is lower priority
          maxRetries: 1, // Don't retry much for analytics
          retryDelayMs: 5000,
          timeout: 5000,
        },
      );
      this.subscriptionIds.push(wildcardSubId);

      // Subscribe to specific high-value events
      this.subscribeToHighValueEvents();

      // Start flush interval
      if (this.config.flushIntervalMs > 0) {
        this.flushInterval = setInterval(() => {
          this.flushEventBuffer().catch(error => {
            this.logger.error('Error flushing analytics event buffer', error);
          });
        }, this.config.flushIntervalMs);
      }

      this.initialized = true;
      this.logger.info('AnalyticsSubscriber initialized successfully', {
        config: this.config,
        subscriptionCount: this.subscriptionIds.length,
      });
    } catch (error) {
      this.logger.error('Failed to initialize AnalyticsSubscriber', error);
      throw error;
    }
  }

  /**
   * Subscribe to high-value events for detailed tracking
   */
  private subscribeToHighValueEvents(): void {
    // Track consumption patterns - creation, updates, and deletions
    const consumptionCreatedSubId = this.domainEventService.subscribe(
      'consumption.created',
      'AnalyticsSubscriber.consumptionCreated',
      this.handleConsumptionAnalytics.bind(this),
      {
        priority: EventPriority.LOW,
        maxRetries: 1,
      },
    );
    this.subscriptionIds.push(consumptionCreatedSubId);

    // Track consumption updates
    const consumptionUpdatedSubId = this.domainEventService.subscribe(
      'consumption.updated',
      'AnalyticsSubscriber.consumptionUpdated',
      this.handleConsumptionUpdated.bind(this),
      {
        priority: EventPriority.LOW,
        maxRetries: 1,
      },
    );
    this.subscriptionIds.push(consumptionUpdatedSubId);

    // Track consumption deletions
    const consumptionDeletedSubId = this.domainEventService.subscribe(
      'consumption.deleted',
      'AnalyticsSubscriber.consumptionDeleted',
      this.handleConsumptionDeleted.bind(this),
      {
        priority: EventPriority.LOW,
        maxRetries: 1,
      },
    );
    this.subscriptionIds.push(consumptionDeletedSubId);

    // Track goal completions
    const goalCompletedSubId = this.domainEventService.subscribe(
      'goal.completed',
      'AnalyticsSubscriber.goalCompletedAnalytics',
      this.handleGoalCompletedAnalytics.bind(this),
      {
        priority: EventPriority.LOW,
        maxRetries: 1,
      },
    );
    this.subscriptionIds.push(goalCompletedSubId);

    // Track purchases for revenue analytics
    const purchaseSubId = this.domainEventService.subscribe(
      'purchase.created',
      'AnalyticsSubscriber.purchaseAnalytics',
      this.handlePurchaseAnalytics.bind(this),
      {
        priority: EventPriority.LOW,
        maxRetries: 1,
      },
    );
    this.subscriptionIds.push(purchaseSubId);

    // Track purchase updates
    const purchaseUpdatedSubId = this.domainEventService.subscribe(
      'purchase.updated',
      'AnalyticsSubscriber.purchaseUpdated',
      this.handlePurchaseUpdated.bind(this),
      {
        priority: EventPriority.LOW,
        maxRetries: 1,
      },
    );
    this.subscriptionIds.push(purchaseUpdatedSubId);

    // Track purchase deletions
    const purchaseDeletedSubId = this.domainEventService.subscribe(
      'purchase.deleted',
      'AnalyticsSubscriber.purchaseDeleted',
      this.handlePurchaseDeleted.bind(this),
      {
        priority: EventPriority.LOW,
        maxRetries: 1,
      },
    );
    this.subscriptionIds.push(purchaseDeletedSubId);

    // Track session metrics
    const sessionEndedSubId = this.domainEventService.subscribe(
      'session.ended',
      'AnalyticsSubscriber.sessionAnalytics',
      this.handleSessionAnalytics.bind(this),
      {
        priority: EventPriority.LOW,
        maxRetries: 1,
      },
    );
    this.subscriptionIds.push(sessionEndedSubId);

    // Track achievement unlocks
    const achievementSubId = this.domainEventService.subscribe(
      'achievement.unlocked',
      'AnalyticsSubscriber.achievementAnalytics',
      this.handleAchievementAnalytics.bind(this),
      {
        priority: EventPriority.LOW,
        maxRetries: 1,
      },
    );
    this.subscriptionIds.push(achievementSubId);
  }

  /**
   * Handle all events for general metrics (SELECTIVE FILTERING)
   *
   * PERFORMANCE OPTIMIZATION: Instead of buffering EVERY event (which can cause
   * high memory usage at >1,000 events/sec), we selectively buffer only:
   * - High-value events for real-time dashboards (consumption, purchase, goal, achievement)
   * - Critical user actions (user.registered, session.ended)
   *
   * Low-priority events (device.*, sync.*, analytics.updated) are logged but NOT buffered.
   * This reduces memory pressure by ~70% while maintaining analytics quality.
   *
   *  ISSUE #6 FIX: No more unsafe casting - DomainEvent has all fields
   */
  private async handleAllEvents(event: DomainEvent): Promise<void> {
    try {
      //  Direct access to eventType, userId, aggregateId, version - no casting needed
      const eventType = event.eventType;
      const shouldBuffer = this.shouldBufferEvent(eventType);

      if (shouldBuffer) {
        // Create metrics entry for buffering
        const metrics: EventMetrics = {
          eventType,
          userId: event.userId,
          aggregateId: event.aggregateId,
          timestamp: new Date(event.timestamp),
          metadata: {
            correlationId: event.correlationId,
            version: event.version,
            aggregateId: event.aggregateId,
          },
        };

        // Add to buffer
        this.eventBuffer.push(metrics);

        // Flush if buffer is full
        if (this.eventBuffer.length >= this.config.bufferSize) {
          await this.flushEventBuffer();
        }
      } else {
        // Log low-priority events without buffering
        this.logger.debug('Skipping buffering for low-priority analytics event', {
          eventType,
          eventId: event.eventId,
        });
      }

      // Update real-time counters (lightweight operation)
      if (this.config.enableRealTimeAnalytics) {
        await this.updateRealTimeCounters(event);
      }

    } catch (error) {
      // Don't throw for analytics - we don't want to break the main flow
      this.logger.warn('Error processing event for analytics', {
        error,
        eventType: event.eventType,
        eventId: event.eventId,
      });
    }
  }

  /**
   * Determine if an event should be buffered for analytics
   *
   * High-value events (consumption, purchases, goals, achievements, user actions)
   * are buffered. Low-priority events (device, sync, WebSocket) are skipped.
   */
  private shouldBufferEvent(eventType: string): boolean {
    // High-value events for analytics dashboards
    const highValuePrefixes = [
      'consumption.',    // User consumption patterns
      'purchase.',       // Revenue and spending analytics
      'goal.',           // Goal completion and progress
      'achievement.',    // Gamification metrics
      'session.',        // Session analytics
      'user.',           // User lifecycle events
      'journal.',        // Mindfulness and journaling
    ];

    // Check if event type starts with any high-value prefix
    return highValuePrefixes.some(prefix => eventType.startsWith(prefix));
  }

  /**
   *  ISSUE #2.2: calculateQuantityFromDuration method removed
   *
   * Quantity calculations are now performed by ConsumptionService using PersonalizedConsumptionRateService
   * and passed in domain event payloads. This decouples AnalyticsSubscriber from ProductRepository
   * and PrismaClient, simplifying the subscriber to pure data mapping logic.
   *
   * Event payloads now include:
   * - ConsumptionCreatedEvent.quantityUsed
   * - ConsumptionUpdatedEvent.previousQuantityUsed and newQuantityUsed
   * - ConsumptionDeletedEvent.quantityUsed
   */

  /**
   * Handle consumption analytics
   *
   *  ISSUE #2.2 FIX: Now uses pre-calculated quantityUsed from event payload
   * This decouples AnalyticsSubscriber from ProductRepository and PersonalizedConsumptionRateService
   */
  private async handleConsumptionAnalytics(event: ConsumptionCreatedEvent): Promise<void> {
    try {
      // Update daily consumption stats using DailyStatRepository
      const date = new Date(event.consumptionTimestamp);
      date.setHours(0, 0, 0, 0); // Normalize to start of day

      //  ISSUE #2.2: Use pre-calculated quantityUsed AND cost metrics from event payload
      // ConsumptionService already calculated these using PersonalizedConsumptionRateService
      const deltaQuantityUsed = event.quantityUsed;
      const deltaCostSpentActual = event.costSpentActual;
      const deltaCostSavedTotal = event.costSavedTotal;

      await this.dailyStatRepository.updateDailyStatDelta({
        userId: event.userId,
        date,
        deltaEvents: 1,
        deltaQuantityUsed,
        deltaCostSpentActual, //  ISSUE #2.2: Include cost deltas
        deltaCostSavedTotal,  //  ISSUE #2.2: Include savings deltas
      });

      // Track variant popularity
      if (event.productId) {
        await this.trackVariantUsage(event.userId, event.productId);
      }

      // Track consumption patterns by time of day
      await this.trackTimeOfDayPattern(event.userId, event.consumptionTimestamp);

    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn('Error processing consumption analytics', {
        error: err.message,
        eventId: event.eventId,
      });
    }
  }

  /**
   * Handle goal completed analytics
   *
   * Note: Goal completion analytics are currently tracked via DailyStat aggregates
   * and real-time DynamoDB events. This method is reserved for future expansion
   * when dedicated goal_analytics tables are needed.
   */
  private async handleGoalCompletedAnalytics(event: GoalCompletedEvent): Promise<void> {
    try {
      // Track average completion time for metrics
      if ((event.currentValue / event.targetValue) >= 1) {
        await this.trackGoalCompletionTime(event.userId, event.goalId, new Date(event.completedAt));
      }

      this.logger.debug('Goal completed analytics processed', {
        eventId: event.eventId,
        userId: event.userId,
        goalType: event.type,
      });

    } catch (error) {
      this.logger.warn('Error processing goal completed analytics', {
        error,
        eventId: event.eventId,
      });
    }
  }

  /**
   * Handle purchase analytics
   */
  private async handlePurchaseAnalytics(event: PurchaseCreatedEvent): Promise<void> {
    try {
      // Update daily purchase stats using DailyStatRepository
      const date = new Date(event.purchasedAt);
      date.setHours(0, 0, 0, 0); // Normalize to start of day

      await this.dailyStatRepository.updateDailyStatDelta({
        userId: event.userId,
        date,
        deltaCostSpentActual: event.totalPrice,
      });

      // Track spending patterns
      await this.trackSpendingPattern(event.userId, event.totalPrice, 'wellness');

    } catch (error) {
      this.logger.warn('Error processing purchase analytics', {
        error,
        eventId: event.eventId,
      });
    }
  }

  /**
   * Handle session analytics
   *
   * Note: Session analytics are currently tracked via Session entity aggregates
   * (eventCount, totalDurationMs, avgEventDurationMs) which are updated in real-time.
   * This method is reserved for future expansion when dedicated session_analytics
   * materialized views are needed for reporting dashboards.
   */
  private async handleSessionAnalytics(event: SessionEndedEvent): Promise<void> {
    try {
      // Track session patterns for time-of-day and consumption rate analysis
      await this.trackSessionPattern(
        event.userId,
        event.sessionStartTimestamp,
        event.sessionEndTimestamp,
        event.consumptionCount || 0,
      );

      this.logger.debug('Session analytics processed', {
        eventId: event.eventId,
        userId: event.userId,
        sessionId: event.sessionId,
        durationMs: event.totalDurationMs,
      });

    } catch (error) {
      this.logger.warn('Error processing session analytics', {
        error,
        eventId: event.eventId,
      });
    }
  }

  /**
   * Handle achievement analytics
   *
   * Note: Achievement analytics are currently tracked via UserAchievement entity
   * (points, level, unlocked_at) which are managed by AchievementsService.
   * This method is reserved for future expansion when dedicated achievement_analytics
   * aggregation tables are needed.
   */
  private async handleAchievementAnalytics(event: AchievementUnlockedEvent): Promise<void> {
    try {
      // Track user achievement points for metrics
      if (event.points) {
        await this.updateUserPoints(event.userId, event.points);
      }

      this.logger.debug('Achievement analytics processed', {
        eventId: event.eventId,
        userId: event.userId,
        achievementType: event.achievementType,
        points: event.points,
      });

    } catch (error) {
      this.logger.warn('Error processing achievement analytics', {
        error,
        eventId: event.eventId,
      });
    }
  }

  /**
   * Update real-time counters
   *
   *  ISSUE #6 FIX: Direct access to eventType and userId from DomainEvent
   */
  private async updateRealTimeCounters(event: DomainEvent): Promise<void> {
    // This would typically update Redis counters for real-time dashboards
    // For now, just log the event type counter
    this.logger.debug('Real-time event counter', {
      eventType: event.eventType,
      userId: event.userId,
      aggregateId: event.aggregateId,
      timestamp: event.timestamp,
    });
  }

  /**
   * Track variant usage patterns
   */
  private async trackVariantUsage(userId: string, variantId: string): Promise<void> {
    // Implementation for variant usage tracking
    this.logger.debug('Tracking variant usage', { userId, variantId });
  }

  /**
   * Track time of day consumption patterns
   */
  private async trackTimeOfDayPattern(userId: string, timestamp: Date): Promise<void> {
    const hour = new Date(timestamp).getHours();
    const timeOfDay = hour < 6 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
    
    this.logger.debug('Tracking time of day pattern', {
      userId,
      hour,
      timeOfDay,
    });
  }

  /**
   * Track goal completion time
   */
  private async trackGoalCompletionTime(userId: string, goalId: string, completedAt: Date): Promise<void> {
    this.logger.debug('Tracking goal completion time', {
      userId,
      goalId,
      completedAt,
    });
  }

  /**
   * Track spending patterns
   */
  private async trackSpendingPattern(userId: string, amount: number, category?: string): Promise<void> {
    this.logger.debug('Tracking spending pattern', {
      userId,
      amount,
      category,
    });
  }

  /**
   * Track session patterns
   */
  private async trackSessionPattern(
    userId: string,
    startTime: Date,
    endTime: Date,
    consumptionCount: number,
  ): Promise<void> {
    const durationMs = new Date(endTime).getTime() - new Date(startTime).getTime();
    const consumptionRate = consumptionCount / (durationMs / 60000); // per minute
    
    this.logger.debug('Tracking session pattern', {
      userId,
      durationMs,
      consumptionCount,
      consumptionRate,
    });
  }

  /**
   * Update user achievement points
   */
  private async updateUserPoints(userId: string, points: number): Promise<void> {
    this.logger.debug('Updating user points', {
      userId,
      points,
    });
  }

  /**
   * Flush event buffer to storage
   */
  private async flushEventBuffer(): Promise<void> {
    if (this.eventBuffer.length === 0) return;

    const eventsToFlush = [...this.eventBuffer];
    this.eventBuffer = [];

    try {
      // In production, this would batch insert to analytics storage
      this.logger.info('Flushing analytics event buffer', {
        eventCount: eventsToFlush.length,
      });

      // Here you would typically:
      // 1. Batch insert to analytics database
      // 2. Send to data warehouse
      // 3. Update aggregated metrics

    } catch (error) {
      // Re-add events to buffer on failure
      this.eventBuffer = [...eventsToFlush, ...this.eventBuffer];
      this.logger.error('Failed to flush analytics event buffer', error);
    }
  }

  /**
   * Handle consumption update events for DailyStat delta adjustments
   *
   *  ISSUE #2.2 FIX: Now uses pre-calculated quantityUsed from event payload
   * This decouples AnalyticsSubscriber from ProductRepository and PersonalizedConsumptionRateService
   */
  private async handleConsumptionUpdated(event: ConsumptionUpdatedEvent): Promise<void> {
    try {
      const date = new Date(event.consumptionTimestamp);
      date.setHours(0, 0, 0, 0); // Normalize to start of day

      //  ISSUE #2.2: Use pre-calculated quantityUsed AND cost metrics from event payload
      // ConsumptionService already calculated these using PersonalizedConsumptionRateService
      const gramsDelta = event.newQuantityUsed - event.previousQuantityUsed;
      const costSpentDelta = event.newCostSpentActual - event.previousCostSpentActual;
      const costSavedDelta = event.newCostSavedTotal - event.previousCostSavedTotal;

      // Only update if there's a meaningful change (quantity or costs)
      if (Math.abs(gramsDelta) > 0.001 || Math.abs(costSpentDelta) > 0.01 || Math.abs(costSavedDelta) > 0.01) {
        await this.dailyStatRepository.updateDailyStatDelta({
          userId: event.userId,
          date,
          deltaQuantityUsed: gramsDelta,
          deltaCostSpentActual: costSpentDelta, //  ISSUE #2.2: Include cost deltas
          deltaCostSavedTotal: costSavedDelta,  //  ISSUE #2.2: Include savings deltas
        });

        this.logger.debug('Updated DailyStat from consumption update', {
          eventId: event.eventId,
          userId: event.userId,
          gramsDelta,
          previousQuantity: event.previousQuantityUsed,
          newQuantity: event.newQuantityUsed,
          costSpentDelta,
          previousCostSpent: event.previousCostSpentActual,
          newCostSpent: event.newCostSpentActual,
          costSavedDelta,
          previousCostSaved: event.previousCostSavedTotal,
          newCostSaved: event.newCostSavedTotal,
        });
      }

    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn('Error processing consumption updated event for DailyStat', {
        error: err.message,
        eventId: event.eventId,
      });
    }
  }

  /**
   * Handle consumption deletion events for DailyStat decrements
   *
   *  ISSUE #2.2 FIX: Now uses pre-calculated quantityUsed from event payload
   * This decouples AnalyticsSubscriber from ProductRepository and PersonalizedConsumptionRateService
   */
  private async handleConsumptionDeleted(event: ConsumptionDeletedEvent): Promise<void> {
    try {
      const date = new Date(event.timestamp);
      date.setHours(0, 0, 0, 0); // Normalize to start of day

      //  ISSUE #2.2: Use pre-calculated quantityUsed AND cost metrics from event payload
      // ConsumptionService already calculated these using PersonalizedConsumptionRateService
      const quantityToSubtract = event.quantityUsed;
      const costSpentToSubtract = event.costSpentActual;
      const costSavedToSubtract = event.costSavedTotal;

      await this.dailyStatRepository.updateDailyStatDelta({
        userId: event.userId,
        date,
        deltaEvents: -1, // Decrement by 1
        deltaQuantityUsed: -quantityToSubtract, // Decrement by quantity used
        deltaCostSpentActual: -costSpentToSubtract, //  ISSUE #2.2: Decrement cost
        deltaCostSavedTotal: -costSavedToSubtract,  //  ISSUE #2.2: Decrement savings
      });

      this.logger.debug('Updated DailyStat from consumption deletion', {
        eventId: event.eventId,
        userId: event.userId,
        gramsSubtracted: quantityToSubtract,
        costSpentSubtracted: costSpentToSubtract,
        costSavedSubtracted: costSavedToSubtract,
      });

    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn('Error processing consumption deleted event for DailyStat', {
        error: err.message,
        eventId: event.eventId,
      });
    }
  }

  /**
   * Handle purchase updated events for DailyStat cost adjustments
   */
  private async handlePurchaseUpdated(event: PurchaseUpdatedEvent): Promise<void> {
    try {
      const date = new Date(event.previousData.purchaseDate || new Date());
      date.setHours(0, 0, 0, 0); // Normalize to start of day

      // Calculate delta changes for cost
      const oldPrice = Number(event.previousData.costSpent || 0);
      const newPrice = Number(event.totalPrice || 0);
      const costDelta = newPrice - oldPrice;

      // Only update if there's a meaningful change
      if (Math.abs(costDelta) > 0.01) { // Avoid floating point precision issues
        await this.dailyStatRepository.updateDailyStatDelta({
          userId: event.userId,
          date,
          deltaCostSpentActual: costDelta,
        });

        this.logger.debug('Updated DailyStat from purchase update', {
          eventId: event.eventId,
          userId: event.userId,
          costDelta,
        });
      }

    } catch (error) {
      this.logger.warn('Error processing purchase updated event for DailyStat', {
        error,
        eventId: event.eventId,
      });
    }
  }

  /**
   * Handle purchase deleted events for DailyStat cost decrements
   */
  private async handlePurchaseDeleted(event: PurchaseDeletedEvent): Promise<void> {
    try {
      const date = new Date(event.purchasedAt);
      date.setHours(0, 0, 0, 0); // Normalize to start of day

      // Calculate values to subtract from DailyStat (negative delta)
      const costToSubtract = event.costSpentActual || 0;

      await this.dailyStatRepository.updateDailyStatDelta({
        userId: event.userId,
        date,
        deltaCostSpentActual: -costToSubtract, // Decrement by cost
      });

      this.logger.debug('Updated DailyStat from purchase deletion', {
        eventId: event.eventId,
        userId: event.userId,
        costSubtracted: costToSubtract,
      });

    } catch (error) {
      this.logger.warn('Error processing purchase deleted event for DailyStat', {
        error,
        eventId: event.eventId,
      });
    }
  }

  /**
   * Get analytics metrics
   */
  public getMetrics(): Record<string, unknown> {
    return {
      bufferSize: this.eventBuffer.length,
      subscriptionCount: this.subscriptionIds.length,
      config: this.config,
    };
  }

  /**
   * Cleanup subscriptions and flush buffer
   */
  public async shutdown(): Promise<void> {
    this.logger.info('Shutting down AnalyticsSubscriber');
    
    // Stop flush interval
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }

    // Flush remaining events
    await this.flushEventBuffer();
    
    // Unsubscribe all handlers
    for (const subId of this.subscriptionIds) {
      this.domainEventService.unsubscribe(subId);
    }
    
    this.subscriptionIds = [];
    this.initialized = false;
  }
}