/**
 * Domain Event Service
 * 
 * Central event bus for domain events in the AppPlatform application.
 * Implements the singleton pattern with async initialization for production readiness.
 * Provides type-safe event emission and subscription with error handling, retry logic,
 * and circuit breaker pattern for resilience.
 * 
 * Future-ready for migration to message queues (SQS/Kafka).
 * 
 * @module domain-event.service
 */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { LoggerService } from '../services/logger.service';
import { AppError, ErrorCodes } from '../utils/AppError';
import { retryWithBackoff } from '../utils/retry.util';
import {
  DomainEvent,
  EventTypeMap,
  EventPriority,
} from './domain.events';

/**
 * Configuration for event handlers
 */
interface EventHandlerConfig {
  priority?: EventPriority;
  maxRetries?: number;
  retryDelayMs?: number;
  timeout?: number;
  async?: boolean;
}

/**
 * Event handler wrapper with metadata
 */
interface EventHandler<T extends DomainEvent = DomainEvent> {
  id: string;
  name: string;
  handler: (event: T) => Promise<void> | void;
  config: EventHandlerConfig;
  metrics: {
    totalCalls: number;
    successCount: number;
    failureCount: number;
    lastExecutionTime?: number;
    averageExecutionTime: number;
  };
}

/**
 * Internal event type with eventType property
 */
interface InternalDomainEvent extends DomainEvent {
  eventType: string;
}

/**
 * Dead letter queue entry
 */
interface DeadLetterEntry {
  event: DomainEvent;
  error: Error;
  attemptCount: number;
  timestamp: Date;
  handlerName?: string;
}

/**
 * Circuit breaker state
 */
interface CircuitBreakerState {
  isOpen: boolean;
  failureCount: number;
  lastFailureTime?: Date;
  nextRetryTime?: Date;
}

/**
 * Domain Event Service - Central event bus for domain events
 */
export class DomainEventService extends EventEmitter {
  private initialized: boolean = false;
  private handlers: Map<string, EventHandler[]> = new Map();
  private deadLetterQueue: DeadLetterEntry[] = [];
  private eventReplayBuffer: InternalDomainEvent[] = [];
  private circuitBreakers: Map<string, CircuitBreakerState> = new Map();
  private correlationIds: Map<string, string[]> = new Map();

  // Configuration
  private config = {
    maxListeners: 100,
    maxDeadLetterQueueSize: 1000,
    maxReplayBufferSize: 500,
    defaultTimeout: 30000, // 30 seconds
    circuitBreakerThreshold: 5,
    circuitBreakerResetTime: 60000, // 1 minute
    enableMetrics: true,
    enableReplay: false,
    enableDeadLetter: true,
  };

  /**
   * Constructor with explicit dependency injection
   * @param logger - LoggerService instance for internal logging
   */
  public constructor(
    private logger: LoggerService,
  ) {
    super();
    // Lightweight constructor - initializes event emitter
    // Async configuration happens in initialize() method
    this.setMaxListeners(this.config.maxListeners);
  }

  /**
   * Initialize the service
   */
  public async initialize(config?: Partial<typeof this.config>): Promise<void> {
    if (this.initialized) return;

    try {
      // Logger is already injected via constructor

      // Apply custom configuration
      if (config) {
        this.config = { ...this.config, ...config };
        this.setMaxListeners(this.config.maxListeners);
      }

      // Setup error handling
      this.setupErrorHandling();

      // Setup periodic cleanup tasks
      this.setupCleanupTasks();

      this.initialized = true;
      this.logger.info('DomainEventService initialized successfully', {
        config: {
          maxListeners: this.config.maxListeners,
          enableMetrics: this.config.enableMetrics,
          enableReplay: this.config.enableReplay,
          enableDeadLetter: this.config.enableDeadLetter,
        },
      });
    } catch (error) {
      this.logger.error('Failed to initialize DomainEventService', error);
      throw error;
    }
  }

  /**
   * Ensure service is initialized
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new AppError(
        500,
        ErrorCodes.INTERNAL_SERVER_ERROR,
        'DomainEventService not initialized. Call initialize() first.',
      );
    }
  }

  /**
   * Emit a domain event with type safety
   * Renamed from emit() to emitEvent() to avoid conflict with EventEmitter base class
   *
   *  ISSUE #6 FIX: Now populates eventType, aggregateId, aggregateType, version
   * into the DomainEvent object, while preserving userId from payload
   */
  public async emitEvent<K extends keyof EventTypeMap>(
    eventType: K,
    payload: Omit<EventTypeMap[K], 'eventId' | 'timestamp' | 'eventType' | 'aggregateType' | 'version' | 'correlationId' | 'causationId' | 'aggregateId'>,
    options?: {
      correlationId?: string;
      causationId?: string;
      metadata?: Record<string, unknown>;
      priority?: EventPriority;
      /**
       * When true, errors from ANY subscriber handler are collected and re-thrown
       * as a single error after all handlers have executed. This enables the caller
       * to detect failures and retry (e.g., outbox retry/DLQ flow).
       *
       * When false (default), handler errors are logged and swallowed — the
       * existing fire-and-forget behavior for in-process domain events.
       *
       * at-least-once delivery guarantees. Without it, subscriber failures are
       * silently acked and the event is marked COMPLETED.
       */
      throwOnHandlerFailure?: boolean;
    },
  ): Promise<void> {
    this.ensureInitialized();

    const eventId = uuidv4();
    const timestamp = new Date().toISOString();

    // Type-safe extraction without 'any' casts
    const aggregateId = this.extractAggregateId(payload, eventId);
    const userId = this.extractUserId(payload) || 'system'; // Extract from payload or fallback
    const aggregateType = this.extractAggregateType(String(eventType)); // Derive from eventType
    const version = 1; // Default version, can be incremented for schema evolution
    const correlationId = options?.correlationId || uuidv4();

    // This eliminates the need for unsafe casting in subscribers (AnalyticsSubscriber, etc.)
    // Note: userId comes from payload, aggregateId/aggregateType/version are derived
    const event: EventTypeMap[K] = {
      ...payload, // Spread payload first (contains userId and event-specific fields)
      eventId,
      eventType: String(eventType),
      timestamp,
      aggregateId,
      aggregateType,
      version,
      correlationId,
      causationId: options?.causationId,
      metadata: options?.metadata,
      priority: options?.priority,
    } as EventTypeMap[K];

    // Track correlation
    if (correlationId) {
      const correlatedEvents = this.correlationIds.get(correlationId) || [];
      correlatedEvents.push(eventId);
      this.correlationIds.set(correlationId, correlatedEvents);
    }

    // Add to replay buffer if enabled
    if (this.config.enableReplay) {
      this.addToReplayBuffer(event as InternalDomainEvent);
    }

    // Log event emission
    this.logger.debug(`Emitting domain event: ${String(eventType)}`, {
      eventId,
      eventType: String(eventType),
      userId,
      aggregateId,
      aggregateType,
      correlationId,
    });

    // Collect handler errors when throwOnHandlerFailure is requested.
    // This enables the outbox to detect subscriber failures and retry/DLQ.
    const handlerErrors: Array<{ handlerName: string; error: Error }> = [];
    const shouldThrowOnFailure = options?.throwOnHandlerFailure === true;

    try {
      // Process handlers for this event type.
      // When shouldThrowOnFailure is true, errors are collected (not swallowed)
      // and all handlers still execute — one handler's failure does not block others.
      await this.processEvent(event as InternalDomainEvent, shouldThrowOnFailure ? handlerErrors : undefined);

      // Emit to Node.js EventEmitter for legacy compatibility
      super.emit(String(eventType), event);
      super.emit('*', event); // Wildcard for monitoring

    } catch (error) {
      this.logger.error(`Error emitting event ${String(eventType)}`, {
        error,
        eventId,
        eventType: String(eventType),
      });

      // Add to dead letter queue if enabled
      if (this.config.enableDeadLetter) {
        this.addToDeadLetterQueue(event as InternalDomainEvent, error as Error);
      }

      // When throwOnHandlerFailure is set, propagate errors to caller (outbox)
      // so they can trigger retry/DLQ. Otherwise swallow for backward compat.
      if (shouldThrowOnFailure) {
        throw error;
      }
    }

    // After all handlers executed: if any failed AND caller wants failures propagated,
    // throw an aggregate error. This triggers outbox retry → eventual DLQ.
    if (shouldThrowOnFailure && handlerErrors.length > 0) {
      const failedNames = handlerErrors.map(e => e.handlerName).join(', ');
      const firstError = handlerErrors[0]!.error;
      const aggregateMessage =
        `${handlerErrors.length} handler(s) failed for event '${String(eventType)}': [${failedNames}]. ` +
        `First error: ${firstError.message}`;

      this.logger.error(aggregateMessage, {
        eventId,
        eventType: String(eventType),
        failedHandlerCount: handlerErrors.length,
        failedHandlers: failedNames,
      });

      // Throw the first error with aggregate context for the outbox retry path
      const err = new Error(aggregateMessage);
      err.cause = firstError;
      throw err;
    }
  }

  /**
   * Subscribe to a domain event with type safety
   */
  public subscribe<K extends keyof EventTypeMap>(
    eventType: K,
    name: string,
    handler: (event: EventTypeMap[K]) => Promise<void> | void,
    config?: EventHandlerConfig,
  ): string {
    this.ensureInitialized();

    const handlerId = uuidv4();
    const eventHandler: EventHandler = {
      id: handlerId,
      name,
      handler: handler as (event: DomainEvent) => Promise<void> | void,
      config: {
        priority: EventPriority.NORMAL,
        maxRetries: 3,
        retryDelayMs: 1000,
        timeout: this.config.defaultTimeout,
        async: true,
        ...config,
      },
      metrics: {
        totalCalls: 0,
        successCount: 0,
        failureCount: 0,
        averageExecutionTime: 0,
      },
    };

    // Get or create handler array for this event type
    const handlers = this.handlers.get(String(eventType)) || [];
    handlers.push(eventHandler);
    
    // Sort by priority
    const getPriorityValue = (priority: EventPriority | undefined): number => {
      const priorityMap = { critical: 4, high: 3, normal: 2, low: 1 };
      return priority ? (priorityMap[priority] || 2) : 2;
    };
    handlers.sort((a, b) => getPriorityValue(b.config.priority) - getPriorityValue(a.config.priority));
    
    this.handlers.set(String(eventType), handlers);

    this.logger.info(`Subscribed handler '${name}' to event '${String(eventType)}'`, {
      handlerId,
      eventType,
      handlerName: name,
      priority: eventHandler.config.priority,
    });

    return handlerId;
  }

  /**
   * Unsubscribe a handler
   */
  public unsubscribe(handlerId: string): boolean {
    this.ensureInitialized();

    for (const [eventType, handlers] of this.handlers.entries()) {
      const index = handlers.findIndex(h => h.id === handlerId);
      if (index !== -1) {
        const removed = handlers.splice(index, 1)[0];
        if (removed) {
          this.logger.info(`Unsubscribed handler '${removed.name}' from event '${eventType}'`);
        }
        return true;
      }
    }
    return false;
  }

  /**
   * Process an event through all registered handlers.
   *
   * @param event - The domain event to process
   * @param collectErrors - When provided, handler errors are pushed into this
   *   array instead of being silently swallowed. All handlers still execute
   *   regardless of earlier failures (fan-out: one failure does not block others).
   *   The caller (emitEvent) decides whether to throw based on the collected errors.
   */
  private async processEvent(
    event: InternalDomainEvent,
    collectErrors?: Array<{ handlerName: string; error: Error }>,
  ): Promise<void> {
    const handlers = this.handlers.get(String(event.eventType)) || [];

    for (const handler of handlers) {
      // Check circuit breaker
      if (this.isCircuitOpen(handler.id)) {
        this.logger.warn(`Circuit breaker open for handler '${handler.name}'`, {
          handlerId: handler.id,
          eventType: event.eventType,
        });
        // Circuit-breaker open counts as a failure for the outbox retry path:
        // the handler is not healthy and will need to be retried later.
        if (collectErrors) {
          collectErrors.push({
            handlerName: handler.name,
            error: new Error(`Circuit breaker open for handler '${handler.name}'`),
          });
        }
        continue;
      }

      try {
        await this.executeHandler(handler, event);
      } catch (error) {
        this.logger.error(`Handler '${handler.name}' failed for event '${event.eventType}'`, {
          error,
          handlerId: handler.id,
          eventId: event.eventId,
        });

        // Update circuit breaker
        this.recordFailure(handler.id);

        // Collect error for the caller if requested (outbox retry path)
        if (collectErrors) {
          collectErrors.push({
            handlerName: handler.name,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }

        // Don't stop processing other handlers — fan-out continues
      }
    }
  }

  /**
   * Execute a single handler with retry logic and timeout
   */
  private async executeHandler(handler: EventHandler, event: DomainEvent): Promise<void> {
    const startTime = Date.now();
    
    handler.metrics.totalCalls++;

    try {
      // Wrap handler execution with timeout
      const timeoutPromise = new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error('Handler timeout')), handler.config.timeout);
      });

      let handlerPromise: Promise<void>;

      if (handler.config.maxRetries && handler.config.maxRetries > 0) {
        handlerPromise = retryWithBackoff(
          () => {
            const result = handler.handler(event);
            return result instanceof Promise ? result : Promise.resolve();
          },
          {
            maxAttempts: handler.config.maxRetries,
            initialDelayMs: handler.config.retryDelayMs || 1000,
          },
        );
      } else {
        const result = handler.handler(event);
        handlerPromise = result instanceof Promise ? result : Promise.resolve();
      }

      await Promise.race([handlerPromise, timeoutPromise]);

      // Update metrics
      handler.metrics.successCount++;
      const executionTime = Date.now() - startTime;
      handler.metrics.lastExecutionTime = executionTime;
      handler.metrics.averageExecutionTime = 
        (handler.metrics.averageExecutionTime * (handler.metrics.successCount - 1) + executionTime) / 
        handler.metrics.successCount;

      // Reset circuit breaker on success
      this.resetCircuitBreaker(handler.id);

    } catch (error) {
      handler.metrics.failureCount++;
      throw error;
    }
  }

  /**
   * Check if circuit breaker is open
   */
  private isCircuitOpen(handlerId: string): boolean {
    const state = this.circuitBreakers.get(handlerId);
    if (!state) return false;

    if (state.isOpen) {
      // Check if it's time to retry
      if (state.nextRetryTime && Date.now() >= state.nextRetryTime.getTime()) {
        state.isOpen = false;
        state.failureCount = 0;
        return false;
      }
      return true;
    }

    return false;
  }

  /**
   * Record a failure for circuit breaker
   */
  private recordFailure(handlerId: string): void {
    let state = this.circuitBreakers.get(handlerId);
    
    if (!state) {
      state = {
        isOpen: false,
        failureCount: 0,
      };
      this.circuitBreakers.set(handlerId, state);
    }

    state.failureCount++;
    state.lastFailureTime = new Date();

    if (state.failureCount >= this.config.circuitBreakerThreshold) {
      state.isOpen = true;
      state.nextRetryTime = new Date(Date.now() + this.config.circuitBreakerResetTime);
      
      this.logger.warn('Circuit breaker opened for handler', {
        handlerId,
        failureCount: state.failureCount,
        nextRetryTime: state.nextRetryTime,
      });
    }
  }

  /**
   * Reset circuit breaker
   */
  private resetCircuitBreaker(handlerId: string): void {
    this.circuitBreakers.delete(handlerId);
  }

  /**
   * Add event to replay buffer
   */
  private addToReplayBuffer(event: InternalDomainEvent): void {
    this.eventReplayBuffer.push(event);

    // Trim buffer if it exceeds max size
    if (this.eventReplayBuffer.length > this.config.maxReplayBufferSize) {
      this.eventReplayBuffer.shift();
    }
  }

  /**
   * Add event to dead letter queue
   */
  private addToDeadLetterQueue(event: InternalDomainEvent, error: Error, handlerName?: string): void {
    const entry: DeadLetterEntry = {
      event,
      error,
      attemptCount: 1,
      timestamp: new Date(),
      handlerName,
    };

    this.deadLetterQueue.push(entry);

    // Trim queue if it exceeds max size
    if (this.deadLetterQueue.length > this.config.maxDeadLetterQueueSize) {
      this.deadLetterQueue.shift();
    }

    this.logger.error('Event added to dead letter queue', {
      eventId: event.eventId,
      eventType: event.eventType,
      error: error.message,
      handlerName,
    });
  }

  /**
   * Replay events from buffer
   */
  public async replayEvents(
    filter?: (event: DomainEvent) => boolean,
    limit?: number,
  ): Promise<void> {
    this.ensureInitialized();

    if (!this.config.enableReplay) {
      throw new AppError(
        400,
        ErrorCodes.INVALID_OPERATION,
        'Event replay is not enabled',
      );
    }

    const eventsToReplay = filter
      ? this.eventReplayBuffer.filter(filter)
      : [...this.eventReplayBuffer];

    const replayLimit = limit || eventsToReplay.length;

    this.logger.info(`Replaying ${Math.min(replayLimit, eventsToReplay.length)} events`);

    for (let i = 0; i < Math.min(replayLimit, eventsToReplay.length); i++) {
      const event = eventsToReplay[i];
      if (!event) {
        this.logger.warn(`Skipping undefined event at index ${i} during replay`);
        continue;
      }
      // Cast to InternalDomainEvent since replay buffer contains events with eventType
      await this.processEvent(event as InternalDomainEvent);
    }
  }

  /**
   * Get dead letter queue entries
   */
  public getDeadLetterQueue(limit?: number): DeadLetterEntry[] {
    this.ensureInitialized();
    return limit ? this.deadLetterQueue.slice(-limit) : [...this.deadLetterQueue];
  }

  /**
   * Retry dead letter queue entries
   */
  public async retryDeadLetterQueue(): Promise<void> {
    this.ensureInitialized();

    const entries = [...this.deadLetterQueue];
    this.deadLetterQueue = [];

    this.logger.info(`Retrying ${entries.length} dead letter queue entries`);

    for (const entry of entries) {
      try {
        // Cast to InternalDomainEvent since dead letter queue contains events with eventType
        await this.processEvent(entry.event as InternalDomainEvent);
      } catch (error) {
        entry.attemptCount++;
        this.addToDeadLetterQueue(entry.event as InternalDomainEvent, error as Error, entry.handlerName);
      }
    }
  }

  /**
   * Get handler metrics
   */
  public getMetrics(): Record<string, unknown> {
    this.ensureInitialized();

    const metrics: Record<string, unknown> = {
      totalHandlers: 0,
      handlersByEvent: {},
      deadLetterQueueSize: this.deadLetterQueue.length,
      replayBufferSize: this.eventReplayBuffer.length,
      circuitBreakersOpen: 0,
    };

    for (const [eventType, handlers] of this.handlers.entries()) {
      (metrics.totalHandlers as number) += handlers.length;
      (metrics.handlersByEvent as Record<string, unknown>)[eventType] = handlers.map(h => ({
        name: h.name,
        metrics: h.metrics,
      }));
    }

    for (const state of this.circuitBreakers.values()) {
      if (state.isOpen) (metrics.circuitBreakersOpen as number)++;
    }

    return metrics;
  }

  /**
   * Clear all event data (for testing)
   */
  public clear(): void {
    this.ensureInitialized();
    
    this.handlers.clear();
    this.deadLetterQueue = [];
    this.eventReplayBuffer = [];
    this.circuitBreakers.clear();
    this.correlationIds.clear();
    this.removeAllListeners();
    
    this.logger.info('DomainEventService cleared');
  }

  /**
   * Setup error handling
   */
  private setupErrorHandling(): void {
    this.on('error', (error) => {
      this.logger.error('EventEmitter error', error);
    });
  }

  /**
   * Setup periodic cleanup tasks
   */
  private setupCleanupTasks(): void {
    // Clean up old correlation IDs every hour
    setInterval(() => {
      // This is a simple cleanup - in production, you'd check event timestamps
      if (this.correlationIds.size > 10000) {
        // Remove oldest entries when size exceeds threshold
        const entriesToDelete = Array.from(this.correlationIds.keys()).slice(0, 1000);
        entriesToDelete.forEach(correlationId => {
          this.correlationIds.delete(correlationId);
        });
      }
    }, 3600000);
  }

  /**
   * Type-safe helper to extract aggregate ID from event payload
   * This replaces unsafe 'any' casts with proper type guards
   *
   * @param payload - Event payload (type-safe union of all event types)
   * @param fallbackId - Fallback ID if no aggregate ID found (typically eventId)
   * @returns The aggregate ID or fallback
   */
  private extractAggregateId<T extends Record<string, unknown>>(
    payload: T,
    fallbackId: string
  ): string {
    // Type guard pattern: Check if property exists and is a string
    // This is type-safe because we're explicitly checking types at runtime
    if ('consumptionId' in payload && typeof payload.consumptionId === 'string') {
      return payload.consumptionId;
    }
    if ('goalId' in payload && typeof payload.goalId === 'string') {
      return payload.goalId;
    }
    if ('purchaseId' in payload && typeof payload.purchaseId === 'string') {
      return payload.purchaseId;
    }
    if ('entryId' in payload && typeof payload.entryId === 'string') {
      return payload.entryId;
    }
    if ('sessionId' in payload && typeof payload.sessionId === 'string') {
      return payload.sessionId;
    }
    if ('inventoryId' in payload && typeof payload.inventoryId === 'string') {
      return payload.inventoryId;
    }
    if ('deviceId' in payload && typeof payload.deviceId === 'string') {
      return payload.deviceId;
    }
    if ('achievementId' in payload && typeof payload.achievementId === 'string') {
      return payload.achievementId;
    }
    if ('userId' in payload && typeof payload.userId === 'string') {
      return payload.userId;
    }

    // Fallback to eventId if no specific aggregate ID found
    return fallbackId;
  }

  /**
   * Type-safe helper to extract user ID from event payload
   *
   * @param payload - Event payload
   * @returns The user ID if present, undefined otherwise
   */
  private extractUserId<T extends Record<string, unknown>>(
    payload: T
  ): string | undefined {
    // Type guard: Only return userId if it exists and is a string
    if ('userId' in payload && typeof payload.userId === 'string') {
      return payload.userId;
    }
    return undefined;
  }

  /**
   * Derive aggregate type from event type
   *
   * Maps event types like 'consumption.created' to aggregate types like 'Consumption'
   *
   * @param eventType - The event type string (e.g., 'consumption.created')
   * @returns The aggregate type (e.g., 'Consumption')
   */
  private extractAggregateType(eventType: string): string {
    // Extract the first part before the dot and capitalize
    const parts = eventType.split('.');
    if (parts.length > 0 && parts[0]) {
      const aggregateType = parts[0];
      return aggregateType.charAt(0).toUpperCase() + aggregateType.slice(1);
    }
    return 'Unknown';
  }

  /**
   * Graceful shutdown
   */
  public async shutdown(): Promise<void> {
    this.logger.info('Shutting down DomainEventService');

    // Clear all intervals
    this.removeAllListeners();
    this.handlers.clear();

    // Log final metrics
    this.logger.info('Final DomainEventService metrics', this.getMetrics());

    this.initialized = false;
  }
}