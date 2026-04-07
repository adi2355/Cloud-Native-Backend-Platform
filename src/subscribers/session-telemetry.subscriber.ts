/**
 * Session Telemetry Subscriber
 *
 * Enqueues background telemetry computation on session.ended events.
 *
 * P0-G FIX: Removed subscription to health.samples.ingested (never emitted).
 * Late-ingest cache invalidation is now handled by TelemetryCacheProjectionHandler
 * via the health.samples.changed outbox event pathway.
 */

import { DomainEventService } from '../events/domain-event.service';
import { LoggerService } from '../services/logger.service';
import { SessionTelemetryQueueService } from '../services/sessionTelemetryQueue.service';
import {
  EventPriority,
  SessionEndedEvent,
} from '../events/domain.events';
// P0-G FIX: Removed SESSION_TELEMETRY_DEFAULT_METRICS and SESSION_TELEMETRY_SECONDARY_METRICS
// imports - they were only used by the removed handleHealthSamplesIngested method.

export class SessionTelemetrySubscriber {
  private initialized = false;
  private subscriptionIds: string[] = [];

  constructor(
    private domainEventService: DomainEventService,
    private sessionTelemetryQueueService: SessionTelemetryQueueService,
    private logger: LoggerService,
  ) {
    if (!domainEventService || !sessionTelemetryQueueService || !logger) {
      throw new Error('SessionTelemetrySubscriber requires domainEventService, sessionTelemetryQueueService, and logger');
    }
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const sessionEndedSubId = this.domainEventService.subscribe(
        'session.ended',
        'SessionTelemetrySubscriber.sessionEnded',
        this.handleSessionEnded.bind(this),
        {
          priority: EventPriority.NORMAL,
          maxRetries: 3,
          retryDelayMs: 10000,
          timeout: 10000,
        },
      );
      this.subscriptionIds.push(sessionEndedSubId);

      // P0-G FIX: Removed subscription to health.samples.ingested
      // This event was NEVER emitted (confirmed by grep). The functionality
      // has been migrated to TelemetryCacheProjectionHandler which handles
      // health.samples.changed events via the outbox pathway.

      this.initialized = true;
      this.logger.info('SessionTelemetrySubscriber initialized', {
        subscriptionCount: this.subscriptionIds.length,
      });
    } catch (error) {
      this.logger.error('Failed to initialize SessionTelemetrySubscriber', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  public async shutdown(): Promise<void> {
    if (!this.initialized) return;

    for (const subId of this.subscriptionIds) {
      this.domainEventService.unsubscribe(subId);
    }

    this.subscriptionIds = [];
    this.initialized = false;
    this.logger.info('SessionTelemetrySubscriber shut down');
  }

  private async handleSessionEnded(event: SessionEndedEvent): Promise<void> {
    if (!event.sessionEndTimestamp || !event.sessionStartTimestamp) {
      this.logger.warn('Session ended event missing timestamps', {
        context: 'SessionTelemetrySubscriber.handleSessionEnded',
        sessionId: event.sessionId,
      });
      return;
    }

    await this.sessionTelemetryQueueService.scheduleTelemetryForCompletedSession({
      sessionId: event.sessionId,
      userId: event.userId,
      sessionStartMs: event.sessionStartTimestamp.getTime(),
      sessionEndMs: event.sessionEndTimestamp.getTime(),
      correlationId: event.correlationId,
    });
  }

  // P0-G FIX: Removed handleHealthSamplesIngested method
  // This handler subscribed to health.samples.ingested which was NEVER emitted.
  // Late-ingest cache invalidation is now handled by:
  //   1. health.samples.changed outbox event (emitted by HealthSampleService)
  //   2. OutboxService routes to HealthProjectionCoordinatorService
  //   3. TelemetryCacheProjectionHandler marks session caches as STALE
  //   4. Next getSessionTelemetry() call triggers lazy recompute
}
