/**
 * Correlation Tracker Service
 * Centralizes all correlation-aware tracking logic with full DI compliance
 *
 * @module correlationTracker
 * @description Replaces decorator-based tracking with service-based tracking
 * that receives all dependencies through constructor injection
 */

import { LoggerService } from './logger.service';
import { PerformanceMonitoringService, PerformanceMetricType } from './performanceMonitoring.service';
import {
  getCurrentCorrelationId,
  getCurrentUserId,
  CorrelationContextManager,
  createChildSpan,
} from '../api/v1/middleware/correlationContext.middleware';
import { trace, context as otelContext, SpanStatusCode, SpanKind, Tracer } from '@opentelemetry/api';

/**
 * Service for centralizing correlation-aware tracking logic
 * This replaces the functionality previously encapsulated in decorators
 * Full DI compliance achieved through explicit constructor injection
 */
export class CorrelationTrackerService {
  private tracer: Tracer;

  /**
   * Constructor with explicit dependency injection
   * @param logger - LoggerService instance for internal logging
   * @param performanceMonitor - PerformanceMonitoringService for metrics tracking
   */
  public constructor(
    private logger: LoggerService,
    private performanceMonitor: PerformanceMonitoringService,
  ) {
    this.tracer = trace.getTracer('AppPlatform-CorrelationTrackerService');
  }

  /**
   * Track general method execution with correlation context
   * Replaces the @LogWithCorrelation decorator
   */
  public async trackMethodExecution<T>(
    className: string,
    methodName: string,
    operation: () => Promise<T>,
    tags: Record<string, unknown> = {},
  ): Promise<T> {
    const correlationId = getCurrentCorrelationId();
    const spanId = createChildSpan(`${className}.${methodName}`);
    const startTime = Date.now();

    const span = this.tracer.startSpan(`${className}.${methodName}`, {
      kind: SpanKind.INTERNAL,
      attributes: {
        'class.name': className,
        'method.name': methodName,
        'method.args.count': (tags.argsCount as number) || 0,
        'correlation.id': correlationId || 'unknown',
        'user.id': getCurrentUserId() || 'anonymous',
        ...(tags as Record<string, string | number | boolean>),
      },
    });

    return otelContext.with(trace.setSpan(otelContext.active(), span), async () => {
      this.logger.debug(`Entering ${className}.${methodName}`, {
        correlationId,
        spanId,
        argsCount: tags.argsCount || 0,
      });

      try {
        const result = await operation();
        const duration = Date.now() - startTime;

        this.logger.debug(`Exiting ${className}.${methodName}`, {
          correlationId,
          spanId,
          duration,
          success: true,
        });

        span.setAttributes({
          'method.duration_ms': duration,
          'method.success': true,
        });

        // Record performance metric if method takes > 100ms
        if (duration > 100) {
          this.logger.logPerformance(`${className}.${methodName}`, duration, {
            correlationId,
          });
          this.performanceMonitor.recordMetric(
            PerformanceMetricType.RESPONSE_TIME,
            `${className}.${methodName}`,
            duration,
            'ms',
            { class: className, method: methodName },
            { correlationId },
          );
        }

        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        const duration = Date.now() - startTime;

        this.logger.error(`Error in ${className}.${methodName}`, {
          correlationId,
          spanId,
          duration,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });

        span.setAttributes({
          'method.duration_ms': duration,
          'method.success': false,
        });
        span.recordException(error instanceof Error ? error : new Error('Unknown error'));
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'Method execution failed' });

        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Track database operations with correlation context
   * Replaces the @TrackDatabaseOperation decorator
   */
  public async trackDatabaseOperation<T>(
    className: string,
    methodName: string,
    table: string,
    operation: () => Promise<T>,
    tags: Record<string, unknown> = {},
  ): Promise<T> {
    const correlationId = getCurrentCorrelationId();
    const startTime = Date.now();

    const span = this.tracer.startSpan(`db.${table}.${methodName}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        'db.system': 'postgresql',
        'db.name': 'app_platform',
        'db.operation': methodName,
        'db.table': table,
        'class.name': className,
        'method.name': methodName,
        'correlation.id': correlationId || 'unknown',
        'user.id': getCurrentUserId() || 'anonymous',
        ...tags,
      },
    });

    return otelContext.with(trace.setSpan(otelContext.active(), span), async () => {
      try {
        const result = await operation();
        const duration = Date.now() - startTime;

        this.logger.logDatabase(
          `${className}.${methodName}`,
          table,
          duration,
          undefined,
          correlationId,
        );

        span.setAttributes({
          'db.latency_ms': duration,
          'db.success': true,
        });
        span.setStatus({ code: SpanStatusCode.OK });

        this.performanceMonitor.recordDatabaseQueryTime(
          methodName,
          table,
          duration,
          correlationId,
        );

        return result;
      } catch (error) {
        const duration = Date.now() - startTime;

        this.logger.logDatabase(
          `${className}.${methodName}`,
          table,
          duration,
          error as Error,
          correlationId,
        );

        span.setAttributes({
          'db.latency_ms': duration,
          'db.success': false,
        });
        span.recordException(error instanceof Error ? error : new Error('Unknown database error'));
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'Database operation failed' });

        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Track external API calls with correlation context
   * Replaces the @TrackExternalAPI decorator
   */
  public async trackExternalAPI<T>(
    className: string,
    methodName: string,
    service: string,
    endpoint: string,
    method: string = 'POST',
    operation: () => Promise<T>,
    tags: Record<string, unknown> = {},
  ): Promise<T> {
    const correlationId = getCurrentCorrelationId();
    const startTime = Date.now();

    const span = this.tracer.startSpan(`http.client.${service}.${methodName}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        'http.method': method,
        'http.url': endpoint,
        'peer.service': service,
        'class.name': className,
        'method.name': methodName,
        'correlation.id': correlationId || 'unknown',
        'user.id': getCurrentUserId() || 'anonymous',
        ...tags,
      },
    });

    return otelContext.with(trace.setSpan(otelContext.active(), span), async () => {
      try {
        const result = await operation();
        const duration = Date.now() - startTime;

        // Try to extract status code from result
        const resultWithStatus = result as { status?: number; statusCode?: number };
        const statusCode = resultWithStatus?.status || resultWithStatus?.statusCode || 200;

        this.logger.logExternalAPI(
          service,
          endpoint,
          method,
          duration,
          statusCode,
          undefined,
          correlationId,
        );

        span.setAttributes({
          'http.status_code': statusCode,
          'http.latency_ms': duration,
          'http.success': true,
        });
        span.setStatus({ code: SpanStatusCode.OK });

        this.performanceMonitor.recordExternalAPIResponseTime(
          service,
          endpoint,
          duration,
          statusCode,
          correlationId,
        );

        return result;
      } catch (error) {
        const duration = Date.now() - startTime;

        // Try to extract status code from error
        const errorWithStatus = error as { response?: { status?: number }; statusCode?: number };
        const statusCode = errorWithStatus?.response?.status ||
                          errorWithStatus?.statusCode ||
                          500;

        this.logger.logExternalAPI(
          service,
          endpoint,
          method,
          duration,
          statusCode,
          error as Error,
          correlationId,
        );

        span.setAttributes({
          'http.status_code': statusCode,
          'http.latency_ms': duration,
          'http.success': false,
        });
        span.recordException(error instanceof Error ? error : new Error('Unknown external API error'));
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'External API call failed' });

        throw error;
      } finally {
        span.end();
      }
    });
  }
}