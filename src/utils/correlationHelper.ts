/**
 * Correlation Helper Utilities
 * Provides helper functions and decorators for correlation context integration
 * 
 * @module correlationHelper
 * @description Utilities to help services and repositories use correlation context
 * without requiring major refactoring of existing code.
 */

import { LoggerService } from '../services/logger.service';
import { PerformanceMonitoringService, PerformanceMetricType } from '../services/performanceMonitoring.service';
import { CorrelationTrackerService } from '../services/correlationTracker.service';
import {
  getCurrentCorrelationId,
  getCurrentTraceId,
  getCurrentUserId,
  CorrelationContextManager,
} from '../api/v1/middleware/correlationContext.middleware';
import { trace, context as otelContext, SpanStatusCode, SpanKind } from '@opentelemetry/api';

// REMOVED: CorrelationAwareLogger - services now use LoggerService directly
// Correlation context is automatically included by the CorrelationTrackerService

// REMOVED: CorrelationAwarePerformanceMonitor - services now use PerformanceMonitoringService directly
// Correlation context is automatically included by the CorrelationTrackerService

// DEPRECATED: @LogWithCorrelation decorator removed
// Use CorrelationAwareService.trackMethod() instead for DI compliance

// DEPRECATED: @TrackDatabaseOperation decorator removed
// Use CorrelationAwareService.trackDatabase() instead for DI compliance

// DEPRECATED: @TrackExternalAPI decorator removed
// Use CorrelationAwareService.trackExternalAPI() instead for DI compliance

/**
 * Helper to add correlation headers to outgoing HTTP requests
 */
export function getCorrelationHeaders(): Record<string, string> {
  return CorrelationContextManager.getOutgoingHeaders();
}

/**
 * Helper to create a child span for nested operations
 */
export function createChildSpan(name: string): string {
  return CorrelationContextManager.createChildSpan(name);
}

/**
 * Helper to add custom attributes to current correlation context
 */
export function addCorrelationAttribute(key: string, value: unknown): void {
  CorrelationContextManager.addAttribute(key, value);
}

/**
 * Helper to get custom attribute from correlation context
 */
export function getCorrelationAttribute(key: string): unknown {
  return CorrelationContextManager.getAttribute(key);
}

/**
 * Create a correlation-aware service base class
 * Now uses dependency injection for all tracking capabilities
 */
export abstract class CorrelationAwareService {
  protected logger: LoggerService;
  protected performanceMonitor: PerformanceMonitoringService;
  protected correlationTracker: CorrelationTrackerService;
  protected tracer: ReturnType<typeof trace.getTracer>; // OpenTelemetry Tracer
  protected serviceName: string;

  constructor(
    serviceName: string,
    logger: LoggerService,
    performanceMonitoringService: PerformanceMonitoringService,
    correlationTracker: CorrelationTrackerService,
  ) {
    this.serviceName = serviceName;
    this.logger = logger;
    this.performanceMonitor = performanceMonitoringService;
    this.correlationTracker = correlationTracker;
    this.tracer = trace.getTracer(serviceName);
  }

  /**
   * Get current correlation ID (enhanced with OpenTelemetry context)
   */
  protected getCorrelationId(): string | undefined {
    // Try to get from OpenTelemetry span first
    const currentSpan = trace.getActiveSpan();
    if (currentSpan) {
      const spanContext = currentSpan.spanContext();
      if (spanContext && spanContext.traceId) {
        return spanContext.traceId;
      }
    }
    
    // Fallback to correlation context
    return getCurrentCorrelationId();
  }

  /**
   * Get current trace ID (enhanced with OpenTelemetry context)
   */
  protected getTraceId(): string | undefined {
    // Try to get from OpenTelemetry span first
    const currentSpan = trace.getActiveSpan();
    if (currentSpan) {
      const spanContext = currentSpan.spanContext();
      if (spanContext && spanContext.traceId) {
        return spanContext.traceId;
      }
    }
    
    // Fallback to correlation context
    return getCurrentTraceId();
  }

  /**
   * Get current user ID from context (enhanced with OpenTelemetry attributes)
   */
  protected getUserId(): string | undefined {
    // Try to get from OpenTelemetry span attributes first
    const currentSpan = trace.getActiveSpan();
    if (currentSpan) {
      // Note: In OpenTelemetry, span attributes are not directly accessible
      // They would need to be stored in the span context or retrieved differently
      // For now, we'll rely on the correlation context fallback
    }
    
    // Fallback to correlation context
    return getCurrentUserId();
  }

  /**
   * Track method execution with correlation context
   * Replaces @LogWithCorrelation decorator
   */
  protected async trackMethod<T>(
    methodName: string,
    operation: () => Promise<T>,
    tags: Record<string, unknown> = {},
  ): Promise<T> {
    return this.correlationTracker.trackMethodExecution(
      this.serviceName,
      methodName,
      operation,
      tags,
    );
  }

  /**
   * Track database operation with correlation context
   * Replaces @TrackDatabaseOperation decorator
   */
  protected async trackDatabase<T>(
    methodName: string,
    table: string,
    operation: () => Promise<T>,
    tags: Record<string, unknown> = {},
  ): Promise<T> {
    return this.correlationTracker.trackDatabaseOperation(
      this.serviceName,
      methodName,
      table,
      operation,
      tags,
    );
  }

  /**
   * Track external API call with correlation context
   * Replaces @TrackExternalAPI decorator
   */
  protected async trackExternalAPI<T>(
    methodName: string,
    service: string,
    endpoint: string,
    httpMethod: string = 'POST',
    operation: () => Promise<T>,
    tags: Record<string, unknown> = {},
  ): Promise<T> {
    return this.correlationTracker.trackExternalAPI(
      this.serviceName,
      methodName,
      service,
      endpoint,
      httpMethod,
      operation,
      tags,
    );
  }

  /**
   * Execute with performance tracking (legacy support)
   * @deprecated Use trackMethod() instead
   */
  protected async executeWithTracking<T>(
    operation: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.trackMethod(operation, fn);
  }
}