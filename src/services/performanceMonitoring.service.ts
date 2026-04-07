import { LoggerService, LogLevel, LogCategory } from './logger.service';
import { generateSecureId } from '../utils/secure-id.utils';
import { metrics, trace, context as otelContext, SpanStatusCode, SpanKind, Meter, Tracer } from '@opentelemetry/api';

export interface PerformanceMetric {
  id: string;
  timestamp: Date;
  type: PerformanceMetricType;
  name: string;
  value: number;
  unit: string;
  tags: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface HealthCheckResult {
  service: string;
  status: HealthStatus;
  timestamp: Date;
  responseTime: number;
  details?: Record<string, unknown>;
  error?: string;
}

export interface ServiceReliabilityMetrics {
  service: string;
  uptime: number; // percentage
  availability: number; // percentage
  meanTimeToFailure: number; // milliseconds
  meanTimeToRecovery: number; // milliseconds
  errorRate: number; // percentage
  successRate: number; // percentage
  averageResponseTime: number; // milliseconds
  p95ResponseTime: number; // milliseconds
  p99ResponseTime: number; // milliseconds
  throughput: number; // requests per second
}

export interface SystemPerformanceSnapshot {
  timestamp: Date;
  cpu: {
    usage: number; // percentage
    loadAverage: number[];
  };
  memory: {
    used: number; // bytes
    total: number; // bytes
    usage: number; // percentage
    heapUsed: number; // bytes
    heapTotal: number; // bytes
  };
  network: {
    bytesIn: number;
    bytesOut: number;
    connectionsActive: number;
  };
  disk: {
    used: number; // bytes
    total: number; // bytes
    usage: number; // percentage
  };
}

export enum PerformanceMetricType {
  RESPONSE_TIME = 'RESPONSE_TIME',
  THROUGHPUT = 'THROUGHPUT',
  ERROR_RATE = 'ERROR_RATE',
  CPU_USAGE = 'CPU_USAGE',
  MEMORY_USAGE = 'MEMORY_USAGE',
  DISK_USAGE = 'DISK_USAGE',
  NETWORK_IO = 'NETWORK_IO',
  DATABASE_QUERY_TIME = 'DATABASE_QUERY_TIME',
  EXTERNAL_API_RESPONSE_TIME = 'EXTERNAL_API_RESPONSE_TIME',
  CACHE_HIT_RATE = 'CACHE_HIT_RATE',
  CACHE_SET = 'CACHE_SET',
  CACHE_MISS = 'CACHE_MISS',
  QUEUE_SIZE = 'QUEUE_SIZE',
  ACTIVE_CONNECTIONS = 'ACTIVE_CONNECTIONS',
  CONSUMPTION_CREATED = 'CONSUMPTION_CREATED',
  CONSUMPTIONS_FETCHED = 'CONSUMPTIONS_FETCHED',
  CONSUMPTION_DELETED = 'CONSUMPTION_DELETED',
  AI_REQUESTS_PROCESSED = 'AI_REQUESTS_PROCESSED',
  /** Number of stale health ingest requests recovered by reaper job */
  HEALTH_INGEST_STALE_RECOVERED = 'HEALTH_INGEST_STALE_RECOVERED',
  /** Number of soft-deleted health samples permanently purged by cleanup job */
  HEALTH_SAMPLE_SOFT_DELETE_PURGED = 'HEALTH_SAMPLE_SOFT_DELETE_PURGED',
  /** Number of stale session telemetry COMPUTING locks recovered by reaper job */
  SESSION_TELEMETRY_LOCK_REAPED = 'SESSION_TELEMETRY_LOCK_REAPED',
}

export enum HealthStatus {
  HEALTHY = 'HEALTHY',
  DEGRADED = 'DEGRADED',
  UNHEALTHY = 'UNHEALTHY',
  UNKNOWN = 'UNKNOWN'
}

export interface PerformanceAlert {
  id: string;
  timestamp: Date;
  type: PerformanceAlertType;
  severity: AlertSeverity;
  service: string;
  metric: string;
  threshold: number;
  actualValue: number;
  message: string;
  resolved: boolean;
  resolvedAt?: Date;
}

export enum PerformanceAlertType {
  HIGH_RESPONSE_TIME = 'HIGH_RESPONSE_TIME',
  HIGH_ERROR_RATE = 'HIGH_ERROR_RATE',
  LOW_THROUGHPUT = 'LOW_THROUGHPUT',
  HIGH_CPU_USAGE = 'HIGH_CPU_USAGE',
  HIGH_MEMORY_USAGE = 'HIGH_MEMORY_USAGE',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  DATABASE_SLOW = 'DATABASE_SLOW',
  EXTERNAL_API_SLOW = 'EXTERNAL_API_SLOW',
  DISK_SPACE_LOW = 'DISK_SPACE_LOW'
}

export enum AlertSeverity {
  INFO = 'INFO',
  WARNING = 'WARNING',
  CRITICAL = 'CRITICAL'
}

export class PerformanceMonitoringService {
  private metrics: PerformanceMetric[] = [];
  private healthChecks: Map<string, HealthCheckResult> = new Map();
  private alerts: PerformanceAlert[] = [];
  private systemSnapshots: SystemPerformanceSnapshot[] = [];
  private maxMetricsInMemory: number = 10000;
  private maxSnapshotsInMemory: number = 1000;
  private monitoringInterval: NodeJS.Timeout | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private meter!: Meter; // OpenTelemetry Meter (initialized in initializeOpenTelemetry)
  private tracer!: Tracer; // OpenTelemetry Tracer (initialized in initializeOpenTelemetry)

  /**
   * Constructor with explicit dependency injection
   * @param logger - LoggerService instance for internal logging
   */
  public constructor(
    private logger: LoggerService,
  ) {
    // Lightweight constructor - initializes OpenTelemetry and monitoring
    this.initializeOpenTelemetry();
    this.startMonitoring();
  }

  /**
   * Initialize OpenTelemetry meter and tracer for custom metrics
   */
  private initializeOpenTelemetry(): void {
    try {
      // Logger is already injected via constructor
      
      // Initialize OpenTelemetry Meter and Tracer
      this.meter = metrics.getMeter('app-platform-backend-performance');
      this.tracer = trace.getTracer('app-platform-backend-performance');

      // Create custom metrics
      this.meter.createCounter('consumption.created.count', {
        description: 'Number of consumption records created',
        unit: '1',
      });

      this.meter.createCounter('ai.requests.processed.count', {
        description: 'Number of AI requests processed',
        unit: '1',
      });

      this.meter.createHistogram('api.response.time', {
        description: 'API response time',
        unit: 'ms',
      });

      this.meter.createHistogram('db.query.time', {
        description: 'Database query time',
        unit: 'ms',
      });

      this.meter.createHistogram('external.api.response.time', {
        description: 'External API response time',
        unit: 'ms',
      });

      this.meter.createCounter('throughput.count', {
        description: 'Request throughput',
        unit: '1',
      });

      this.meter.createCounter('error.rate.count', {
        description: 'Error rate',
        unit: '1',
      });

      // Health ingest stale recovery counter
      this.meter.createCounter('health.ingest.stale.recovered.count', {
        description: 'Number of stale health ingest requests recovered by reaper job',
        unit: '1',
      });

      this.logger.log(
        LogLevel.INFO,
        LogCategory.PERFORMANCE,
        'OpenTelemetry metrics initialized for PerformanceMonitoringService',
      );
    } catch (error) {
      this.logger.log(
        LogLevel.WARN,
        LogCategory.PERFORMANCE,
        'Failed to initialize OpenTelemetry metrics - continuing without custom metrics',
        { error: error instanceof Error ? error.message : 'Unknown error' },
      );
    }
  }

  /**
   * Start performance monitoring
   */
  private startMonitoring(): void {
    // Collect system metrics every 30 seconds
    this.monitoringInterval = setInterval(() => {
      this.collectSystemMetrics();
    }, 30 * 1000);

    // Run health checks every 60 seconds
    this.healthCheckInterval = setInterval(() => {
      this.runHealthChecks();
    }, 60 * 1000);

    this.logger.log(
      LogLevel.INFO,
      LogCategory.PERFORMANCE,
      'Performance monitoring service started',
    );
  }

  /**
   * Stop performance monitoring
   */
  public stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    this.logger.log(
      LogLevel.INFO,
      LogCategory.PERFORMANCE,
      'Performance monitoring service stopped',
    );
  }

  /**
   * Record a performance metric
   */
  public recordMetric(
    type: PerformanceMetricType,
    name: string,
    value: number,
    unit: string,
    tags: Record<string, string> = {},
    metadata?: Record<string, unknown>,
  ): void {
    const metric: PerformanceMetric = {
      id: this.generateMetricId(),
      timestamp: new Date(),
      type,
      name,
      value,
      unit,
      tags,
      metadata,
    };

    this.metrics.push(metric);
    this.trimMetricsInMemory();

    // Push metrics to OpenTelemetry based on type
    this.recordMetricToOpenTelemetry(metric);

    // Check for performance alerts
    this.checkPerformanceThresholds(metric);

    // Log significant performance events
    if (this.isSignificantMetric(metric)) {
      this.logger.log(
        LogLevel.INFO,
        LogCategory.PERFORMANCE,
        `Performance metric recorded: ${name}`,
        {
          type,
          value,
          unit,
          tags,
        },
      );
    }
  }

  /**
   * Record metric to OpenTelemetry based on metric type
   */
  private recordMetricToOpenTelemetry(metric: PerformanceMetric): void {
    try {
      if (!this.meter) return;

      const attributes = { ...metric.tags };
      
      switch (metric.type) {
        case PerformanceMetricType.CONSUMPTION_CREATED:
          const consumptionCounter = this.meter.createCounter('consumption.created.count');
          consumptionCounter.add(metric.value, attributes);
          break;
          
        case PerformanceMetricType.AI_REQUESTS_PROCESSED:
          const aiCounter = this.meter.createCounter('ai.requests.processed.count');
          aiCounter.add(metric.value, attributes);
          break;
          
        case PerformanceMetricType.RESPONSE_TIME:
          const responseTimeHistogram = this.meter.createHistogram('api.response.time', {
            description: 'API response time in milliseconds',
            unit: 'ms',
          });
          responseTimeHistogram.record(metric.value, attributes);
          break;
          
        case PerformanceMetricType.DATABASE_QUERY_TIME:
          const dbQueryHistogram = this.meter.createHistogram('db.query.time', {
            description: 'Database query time in milliseconds',
            unit: 'ms',
          });
          dbQueryHistogram.record(metric.value, attributes);
          break;
          
        case PerformanceMetricType.EXTERNAL_API_RESPONSE_TIME:
          const externalApiHistogram = this.meter.createHistogram('external.api.response.time', {
            description: 'External API response time in milliseconds',
            unit: 'ms',
          });
          externalApiHistogram.record(metric.value, attributes);
          break;

        case PerformanceMetricType.HEALTH_INGEST_STALE_RECOVERED:
          const staleRecoveredCounter = this.meter.createCounter('health.ingest.stale.recovered.count');
          staleRecoveredCounter.add(metric.value, attributes);
          break;

        case PerformanceMetricType.HEALTH_SAMPLE_SOFT_DELETE_PURGED:
          const softDeletePurgedCounter = this.meter.createCounter('health.samples.soft_delete.purged.count', {
            description: 'Number of soft-deleted health samples permanently purged by cleanup job',
            unit: '1',
          });
          softDeletePurgedCounter.add(metric.value, attributes);
          break;
      }
    } catch (error) {
      this.logger.log(
        LogLevel.ERROR,
        LogCategory.PERFORMANCE,
        'Failed to record metric to OpenTelemetry',
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          metric: metric.name,
          type: metric.type,
        },
      );
    }
  }

  /**
   * Record API response time
   */
  public recordAPIResponseTime(
    endpoint: string,
    method: string,
    responseTime: number,
    statusCode: number,
    requestId?: string,
  ): void {
    this.recordMetric(
      PerformanceMetricType.RESPONSE_TIME,
      'api_response_time',
      responseTime,
      'ms',
      {
        endpoint,
        method,
        status_code: statusCode.toString(),
      },
      { requestId },
    );
  }

  /**
   * Record database query time
   */
  public recordDatabaseQueryTime(
    operation: string,
    table: string,
    queryTime: number,
    requestId?: string,
  ): void {
    this.recordMetric(
      PerformanceMetricType.DATABASE_QUERY_TIME,
      'database_query_time',
      queryTime,
      'ms',
      {
        operation,
        table,
      },
      { requestId },
    );
  }

  /**
   * Record external API response time
   */
  public recordExternalAPIResponseTime(
    service: string,
    endpoint: string,
    responseTime: number,
    statusCode?: number,
    requestId?: string,
  ): void {
    this.recordMetric(
      PerformanceMetricType.EXTERNAL_API_RESPONSE_TIME,
      'external_api_response_time',
      responseTime,
      'ms',
      {
        service,
        endpoint,
        status_code: statusCode?.toString() || 'unknown',
      },
      { requestId },
    );
  }

  /**
   * Record throughput metric
   */
  public recordThroughput(
    service: string,
    requestsPerSecond: number,
    timeWindow: number = 60,
  ): void {
    this.recordMetric(
      PerformanceMetricType.THROUGHPUT,
      'throughput',
      requestsPerSecond,
      'rps',
      {
        service,
        time_window: timeWindow.toString(),
      },
    );
  }

  /**
   * Record error rate
   */
  public recordErrorRate(
    service: string,
    errorRate: number,
    timeWindow: number = 60,
  ): void {
    this.recordMetric(
      PerformanceMetricType.ERROR_RATE,
      'error_rate',
      errorRate,
      'percentage',
      {
        service,
        time_window: timeWindow.toString(),
      },
    );
  }

  /**
   * Collect system performance metrics
   */
  private collectSystemMetrics(): void {
    try {
      const snapshot = this.captureSystemSnapshot();
      this.systemSnapshots.push(snapshot);
      this.trimSnapshotsInMemory();

      // Record individual metrics
      this.recordMetric(
        PerformanceMetricType.CPU_USAGE,
        'cpu_usage',
        snapshot.cpu.usage,
        'percentage',
        { component: 'system' },
      );

      this.recordMetric(
        PerformanceMetricType.MEMORY_USAGE,
        'memory_usage',
        snapshot.memory.usage,
        'percentage',
        { component: 'system' },
      );

      this.recordMetric(
        PerformanceMetricType.DISK_USAGE,
        'disk_usage',
        snapshot.disk.usage,
        'percentage',
        { component: 'system' },
      );

      this.recordMetric(
        PerformanceMetricType.ACTIVE_CONNECTIONS,
        'active_connections',
        snapshot.network.connectionsActive,
        'count',
        { component: 'network' },
      );
    } catch (error) {
      this.logger.log(
        LogLevel.ERROR,
        LogCategory.PERFORMANCE,
        'Failed to collect system metrics',
        { error: error instanceof Error ? error.message : 'Unknown error' },
      );
    }
  }

  /**
   * Capture system performance snapshot
   */
  private captureSystemSnapshot(): SystemPerformanceSnapshot {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    
    // Calculate CPU usage percentage (simplified)
    const cpuPercent = Math.min(100, (cpuUsage.user + cpuUsage.system) / 1000000); // Convert to percentage

    return {
      timestamp: new Date(),
      cpu: {
        usage: cpuPercent,
        loadAverage: process.platform !== 'win32' ? require('os').loadavg() : [0, 0, 0],
      },
      memory: {
        used: memUsage.rss,
        total: require('os').totalmem(),
        usage: (memUsage.rss / require('os').totalmem()) * 100,
        heapUsed: memUsage.heapUsed,
        heapTotal: memUsage.heapTotal,
      },
      network: {
        bytesIn: 0, // Would need network monitoring library
        bytesOut: 0,
        connectionsActive: 0, // Would need to track active connections
      },
      disk: {
        used: 0, // Would need disk monitoring library
        total: 0,
        usage: 0,
      },
    };
  }

  /**
   * Run health checks for various services
   */
  private async runHealthChecks(): Promise<void> {
    const healthChecks = [
      this.checkDatabaseHealth(),
      this.checkExternalAPIHealth(),
      this.checkSystemHealth(),
    ];

    const results = await Promise.allSettled(healthChecks);
    
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.logger.log(
          LogLevel.ERROR,
          LogCategory.PERFORMANCE,
          'Health check failed',
          { index, error: result.reason },
        );
      }
    });
  }

  /**
   * Check database health
   */
  private async checkDatabaseHealth(): Promise<void> {
    const span = this.tracer?.startSpan('health_check_database', {
      kind: SpanKind.CLIENT,
      attributes: {
        'db.system': 'postgresql',
        'health.check.type': 'database',
      },
    });

    const startTime = Date.now();
    
    try {
      // In a real implementation, this would ping the database
      // For now, we'll simulate a health check
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const responseTime = Date.now() - startTime;
      const healthCheck: HealthCheckResult = {
        service: 'database',
        status: responseTime < 100 ? HealthStatus.HEALTHY : 
                responseTime < 500 ? HealthStatus.DEGRADED : HealthStatus.UNHEALTHY,
        timestamp: new Date(),
        responseTime,
        details: {
          connectionPool: 'active',
          queryTime: responseTime,
        },
      };

      this.healthChecks.set('database', healthCheck);
      
      if (healthCheck.status !== HealthStatus.HEALTHY) {
        this.generatePerformanceAlert(
          PerformanceAlertType.DATABASE_SLOW,
          'database',
          'response_time',
          100,
          responseTime,
          `Database response time is ${responseTime}ms`,
        );
      }

      // Set span attributes and status
      if (span) {
        span.setAttributes({
          'health.check.status': healthCheck.status,
          'health.check.response_time_ms': responseTime,
          'db.connection_pool.status': 'active',
        });
        span.setStatus({ 
          code: healthCheck.status === HealthStatus.UNHEALTHY ? SpanStatusCode.ERROR : SpanStatusCode.OK, 
        });
      }

    } catch (error) {
      const healthCheck: HealthCheckResult = {
        service: 'database',
        status: HealthStatus.UNHEALTHY,
        timestamp: new Date(),
        responseTime: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      };

      this.healthChecks.set('database', healthCheck);
      
      this.generatePerformanceAlert(
        PerformanceAlertType.SERVICE_UNAVAILABLE,
        'database',
        'availability',
        100,
        0,
        `Database is unavailable: ${healthCheck.error}`,
      );

      // Record error in span
      if (span) {
        span.setAttributes({
          'health.check.status': healthCheck.status,
          'health.check.response_time_ms': healthCheck.responseTime,
        });
        span.recordException(error instanceof Error ? error : new Error('Unknown error'));
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'Database health check failed' });
      }
    } finally {
      span?.end();
    }
  }

  /**
   * Check external API health
   */
  private async checkExternalAPIHealth(): Promise<void> {
    const span = this.tracer?.startSpan('health_check_external_apis', {
      kind: SpanKind.CLIENT,
      attributes: {
        'health.check.type': 'external_apis',
        'peer.service': 'external_apis',
      },
    });

    const startTime = Date.now();
    
    try {
      // In a real implementation, this would check external APIs
      // For now, we'll simulate a health check
      await new Promise(resolve => setTimeout(resolve, 50));
      
      const responseTime = Date.now() - startTime;
      const healthCheck: HealthCheckResult = {
        service: 'external_apis',
        status: responseTime < 1000 ? HealthStatus.HEALTHY : 
                responseTime < 3000 ? HealthStatus.DEGRADED : HealthStatus.UNHEALTHY,
        timestamp: new Date(),
        responseTime,
        details: {
          anthropic: 'healthy',
          aws: 'healthy',
        },
      };

      this.healthChecks.set('external_apis', healthCheck);
      
      if (healthCheck.status !== HealthStatus.HEALTHY) {
        this.generatePerformanceAlert(
          PerformanceAlertType.EXTERNAL_API_SLOW,
          'external_apis',
          'response_time',
          1000,
          responseTime,
          `External API response time is ${responseTime}ms`,
        );
      }

      // Set span attributes and status
      if (span) {
        span.setAttributes({
          'health.check.status': healthCheck.status,
          'health.check.response_time_ms': responseTime,
          'external.apis.anthropic.status': 'healthy',
          'external.apis.aws.status': 'healthy',
        });
        span.setStatus({ 
          code: healthCheck.status === HealthStatus.UNHEALTHY ? SpanStatusCode.ERROR : SpanStatusCode.OK, 
        });
      }

    } catch (error) {
      const healthCheck: HealthCheckResult = {
        service: 'external_apis',
        status: HealthStatus.UNHEALTHY,
        timestamp: new Date(),
        responseTime: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      };

      this.healthChecks.set('external_apis', healthCheck);

      // Record error in span
      if (span) {
        span.setAttributes({
          'health.check.status': healthCheck.status,
          'health.check.response_time_ms': healthCheck.responseTime,
        });
        span.recordException(error instanceof Error ? error : new Error('Unknown error'));
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'External API health check failed' });
      }
    } finally {
      span?.end();
    }
  }

  /**
   * Check system health
   */
  private async checkSystemHealth(): Promise<void> {
    const span = this.tracer?.startSpan('health_check_system', {
      kind: SpanKind.INTERNAL,
      attributes: {
        'health.check.type': 'system',
      },
    });

    try {
      const snapshot = this.captureSystemSnapshot();
      
      let status = HealthStatus.HEALTHY;
      const issues: string[] = [];
      
      if (snapshot.cpu.usage > 80) {
        status = HealthStatus.DEGRADED;
        issues.push('High CPU usage');
      }
      
      if (snapshot.memory.usage > 85) {
        status = HealthStatus.DEGRADED;
        issues.push('High memory usage');
      }
      
      if (snapshot.disk.usage > 90) {
        status = HealthStatus.UNHEALTHY;
        issues.push('Low disk space');
      }

      const healthCheck: HealthCheckResult = {
        service: 'system',
        status,
        timestamp: new Date(),
        responseTime: 0,
        details: {
          cpu: snapshot.cpu.usage,
          memory: snapshot.memory.usage,
          disk: snapshot.disk.usage,
          issues,
        },
      };

      this.healthChecks.set('system', healthCheck);
      
      // Generate alerts for system issues
      if (snapshot.cpu.usage > 80) {
        this.generatePerformanceAlert(
          PerformanceAlertType.HIGH_CPU_USAGE,
          'system',
          'cpu_usage',
          80,
          snapshot.cpu.usage,
          `CPU usage is ${snapshot.cpu.usage.toFixed(1)}%`,
        );
      }
      
      if (snapshot.memory.usage > 85) {
        this.generatePerformanceAlert(
          PerformanceAlertType.HIGH_MEMORY_USAGE,
          'system',
          'memory_usage',
          85,
          snapshot.memory.usage,
          `Memory usage is ${snapshot.memory.usage.toFixed(1)}%`,
        );
      }

      // Set span attributes and status
      if (span) {
        span.setAttributes({
          'health.check.status': healthCheck.status,
          'system.cpu.usage': snapshot.cpu.usage,
          'system.memory.usage': snapshot.memory.usage,
          'system.disk.usage': snapshot.disk.usage,
          'system.issues.count': issues.length,
        });
        
        if (issues.length > 0) {
          span.setAttributes({
            'system.issues': issues.join(', '),
          });
        }
        
        span.setStatus({ 
          code: status === HealthStatus.UNHEALTHY ? SpanStatusCode.ERROR : SpanStatusCode.OK,
          message: issues.length > 0 ? `System issues: ${issues.join(', ')}` : 'System healthy',
        });
      }

    } catch (error) {
      const healthCheck: HealthCheckResult = {
        service: 'system',
        status: HealthStatus.UNKNOWN,
        timestamp: new Date(),
        responseTime: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };

      this.healthChecks.set('system', healthCheck);

      // Record error in span
      if (span) {
        span.setAttributes({
          'health.check.status': healthCheck.status,
        });
        span.recordException(error instanceof Error ? error : new Error('Unknown error'));
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'System health check failed' });
      }
    } finally {
      span?.end();
    }
  }

  /**
   * Get performance metrics
   */
  public getPerformanceMetrics(
    type?: PerformanceMetricType,
    timeWindow?: number,
    limit: number = 1000,
  ): PerformanceMetric[] {
    const now = Date.now();
    const windowStart = timeWindow ? now - timeWindow : 0;
    
    return this.metrics
      .filter(metric => {
        if (timeWindow && metric.timestamp.getTime() < windowStart) return false;
        if (type && metric.type !== type) return false;
        return true;
      })
      .slice(-limit);
  }

  /**
   * Get service reliability metrics
   */
  public getServiceReliabilityMetrics(
    service: string,
    timeWindow: number = 24 * 60 * 60 * 1000,
  ): ServiceReliabilityMetrics {
    const now = Date.now();
    const windowStart = now - timeWindow;
    
    const serviceMetrics = this.metrics.filter(metric =>
      metric.timestamp.getTime() >= windowStart &&
      (metric.tags.service === service || metric.tags.endpoint?.includes(service)),
    );

    const responseTimes = serviceMetrics
      .filter(m => m.type === PerformanceMetricType.RESPONSE_TIME)
      .map(m => m.value);

    const errorRates = serviceMetrics
      .filter(m => m.type === PerformanceMetricType.ERROR_RATE)
      .map(m => m.value);

    const throughputs = serviceMetrics
      .filter(m => m.type === PerformanceMetricType.THROUGHPUT)
      .map(m => m.value);

    // Calculate percentiles
    const sortedResponseTimes = responseTimes.sort((a, b) => a - b);
    const p95Index = Math.floor(sortedResponseTimes.length * 0.95);
    const p99Index = Math.floor(sortedResponseTimes.length * 0.99);

    return {
      service,
      uptime: this.calculateUptime(service, timeWindow),
      availability: this.calculateAvailability(service, timeWindow),
      meanTimeToFailure: 0, // Would need failure tracking
      meanTimeToRecovery: 0, // Would need recovery tracking
      errorRate: errorRates.length > 0 ? errorRates.reduce((a, b) => a + b, 0) / errorRates.length : 0,
      successRate: 100 - (errorRates.length > 0 ? errorRates.reduce((a, b) => a + b, 0) / errorRates.length : 0),
      averageResponseTime: responseTimes.length > 0 ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length : 0,
      p95ResponseTime: sortedResponseTimes[p95Index] || 0,
      p99ResponseTime: sortedResponseTimes[p99Index] || 0,
      throughput: throughputs.length > 0 ? throughputs.reduce((a, b) => a + b, 0) / throughputs.length : 0,
    };
  }

  /**
   * Get current health status
   */
  public getHealthStatus(): Map<string, HealthCheckResult> {
    return new Map(this.healthChecks);
  }

  /**
   * Get performance alerts
   */
  public getPerformanceAlerts(resolved: boolean = false): PerformanceAlert[] {
    return this.alerts.filter(alert => alert.resolved === resolved);
  }

  /**
   * Resolve performance alert
   */
  public resolvePerformanceAlert(alertId: string): boolean {
    const alert = this.alerts.find(a => a.id === alertId);
    if (alert && !alert.resolved) {
      alert.resolved = true;
      alert.resolvedAt = new Date();
      return true;
    }
    return false;
  }

  // Private helper methods

  private checkPerformanceThresholds(metric: PerformanceMetric): void {
    // Define thresholds for different metric types
    const thresholds: Record<PerformanceMetricType, { warning: number; critical: number }> = {
      [PerformanceMetricType.RESPONSE_TIME]: { warning: 1000, critical: 5000 },
      [PerformanceMetricType.ERROR_RATE]: { warning: 5, critical: 10 },
      [PerformanceMetricType.CPU_USAGE]: { warning: 70, critical: 90 },
      [PerformanceMetricType.MEMORY_USAGE]: { warning: 80, critical: 95 },
      [PerformanceMetricType.DISK_USAGE]: { warning: 80, critical: 95 },
      [PerformanceMetricType.DATABASE_QUERY_TIME]: { warning: 500, critical: 2000 },
      [PerformanceMetricType.EXTERNAL_API_RESPONSE_TIME]: { warning: 2000, critical: 10000 },
      [PerformanceMetricType.THROUGHPUT]: { warning: 10, critical: 5 }, // Low throughput warning
      [PerformanceMetricType.NETWORK_IO]: { warning: 1000000, critical: 10000000 }, // bytes
      [PerformanceMetricType.CACHE_HIT_RATE]: { warning: 80, critical: 60 }, // Low hit rate warning
      [PerformanceMetricType.CACHE_SET]: { warning: 10000, critical: 50000 }, // High cache sets warning
      [PerformanceMetricType.CACHE_MISS]: { warning: 100, critical: 500 }, // High cache misses warning
      [PerformanceMetricType.QUEUE_SIZE]: { warning: 100, critical: 500 },
      [PerformanceMetricType.ACTIVE_CONNECTIONS]: { warning: 1000, critical: 5000 },
      [PerformanceMetricType.CONSUMPTION_CREATED]: { warning: 1000, critical: 5000 },
      [PerformanceMetricType.CONSUMPTIONS_FETCHED]: { warning: 1000, critical: 5000 },
      [PerformanceMetricType.CONSUMPTION_DELETED]: { warning: 1000, critical: 5000 },
      [PerformanceMetricType.AI_REQUESTS_PROCESSED]: { warning: 1000, critical: 5000 },
      // High stale recovery count indicates systemic processing issues
      [PerformanceMetricType.HEALTH_INGEST_STALE_RECOVERED]: { warning: 10, critical: 50 },
      // High purge count may indicate unexpected data deletion patterns or data quality issues
      [PerformanceMetricType.HEALTH_SAMPLE_SOFT_DELETE_PURGED]: { warning: 10000, critical: 50000 },
      // High stale lock recovery indicates workers are crashing or getting stuck
      [PerformanceMetricType.SESSION_TELEMETRY_LOCK_REAPED]: { warning: 5, critical: 20 },
    };

    const threshold = thresholds[metric.type];
    if (!threshold) return;

    let alertType: PerformanceAlertType | null = null;
    let severity: AlertSeverity;

    if (metric.value >= threshold.critical) {
      severity = AlertSeverity.CRITICAL;
      alertType = this.getAlertTypeForMetric(metric.type);
    } else if (metric.value >= threshold.warning) {
      severity = AlertSeverity.WARNING;
      alertType = this.getAlertTypeForMetric(metric.type);
    } else {
      return; // No alert needed
    }

    if (alertType) {
      this.generatePerformanceAlert(
        alertType,
        metric.tags.service || 'system',
        metric.name,
        metric.type === PerformanceMetricType.THROUGHPUT || 
        metric.type === PerformanceMetricType.CACHE_HIT_RATE ? threshold.warning : threshold.critical,
        metric.value,
        `${metric.name} is ${metric.value} ${metric.unit}`, //  Fixed: added space
      );
    }
  }

  private getAlertTypeForMetric(metricType: PerformanceMetricType): PerformanceAlertType {
    const mapping: Record<PerformanceMetricType, PerformanceAlertType> = {
      [PerformanceMetricType.RESPONSE_TIME]: PerformanceAlertType.HIGH_RESPONSE_TIME,
      [PerformanceMetricType.ERROR_RATE]: PerformanceAlertType.HIGH_ERROR_RATE,
      [PerformanceMetricType.CPU_USAGE]: PerformanceAlertType.HIGH_CPU_USAGE,
      [PerformanceMetricType.MEMORY_USAGE]: PerformanceAlertType.HIGH_MEMORY_USAGE,
      [PerformanceMetricType.DISK_USAGE]: PerformanceAlertType.DISK_SPACE_LOW,
      [PerformanceMetricType.DATABASE_QUERY_TIME]: PerformanceAlertType.DATABASE_SLOW,
      [PerformanceMetricType.EXTERNAL_API_RESPONSE_TIME]: PerformanceAlertType.EXTERNAL_API_SLOW,
      [PerformanceMetricType.THROUGHPUT]: PerformanceAlertType.LOW_THROUGHPUT,
      [PerformanceMetricType.NETWORK_IO]: PerformanceAlertType.HIGH_CPU_USAGE, // Generic
      [PerformanceMetricType.CACHE_HIT_RATE]: PerformanceAlertType.LOW_THROUGHPUT, // Generic
      [PerformanceMetricType.CACHE_SET]: PerformanceAlertType.HIGH_RESPONSE_TIME, // Generic
      [PerformanceMetricType.CACHE_MISS]: PerformanceAlertType.LOW_THROUGHPUT, // Generic
      [PerformanceMetricType.QUEUE_SIZE]: PerformanceAlertType.HIGH_RESPONSE_TIME, // Generic
      [PerformanceMetricType.ACTIVE_CONNECTIONS]: PerformanceAlertType.HIGH_RESPONSE_TIME, // Generic
      [PerformanceMetricType.CONSUMPTION_CREATED]: PerformanceAlertType.HIGH_RESPONSE_TIME, // Generic
      [PerformanceMetricType.CONSUMPTIONS_FETCHED]: PerformanceAlertType.HIGH_RESPONSE_TIME, // Generic
      [PerformanceMetricType.CONSUMPTION_DELETED]: PerformanceAlertType.HIGH_RESPONSE_TIME, // Generic
      [PerformanceMetricType.AI_REQUESTS_PROCESSED]: PerformanceAlertType.HIGH_RESPONSE_TIME, // Generic
      [PerformanceMetricType.HEALTH_INGEST_STALE_RECOVERED]: PerformanceAlertType.HIGH_ERROR_RATE, // High stale count indicates systemic issue
      [PerformanceMetricType.HEALTH_SAMPLE_SOFT_DELETE_PURGED]: PerformanceAlertType.HIGH_ERROR_RATE, // Unusually high purge may indicate data quality issues
      [PerformanceMetricType.SESSION_TELEMETRY_LOCK_REAPED]: PerformanceAlertType.HIGH_ERROR_RATE, // High stale lock count indicates worker issues
    };

    return mapping[metricType];
  }

  private generatePerformanceAlert(
    type: PerformanceAlertType,
    service: string,
    metric: string,
    threshold: number,
    actualValue: number,
    message: string,
  ): void {
    // Check if we already have an active alert for this combination
    const existingAlert = this.alerts.find(alert =>
      !alert.resolved &&
      alert.type === type &&
      alert.service === service &&
      alert.metric === metric,
    );

    if (existingAlert) {
      // Update existing alert
      existingAlert.actualValue = actualValue;
      existingAlert.timestamp = new Date();
      return;
    }

    const alert: PerformanceAlert = {
      id: this.generateAlertId(),
      timestamp: new Date(),
      type,
      severity: actualValue > threshold * 2 ? AlertSeverity.CRITICAL : AlertSeverity.WARNING,
      service,
      metric,
      threshold,
      actualValue,
      message,
      resolved: false,
    };

    this.alerts.push(alert);

    this.logger.log(
      alert.severity === AlertSeverity.CRITICAL ? LogLevel.ERROR : LogLevel.WARN,
      LogCategory.PERFORMANCE,
      `Performance alert: ${message}`,
      {
        alertId: alert.id,
        type: alert.type,
        service: alert.service,
        threshold: alert.threshold,
        actualValue: alert.actualValue,
      },
    );
  }

  private isSignificantMetric(metric: PerformanceMetric): boolean {
    // Only log significant metrics to avoid noise
    switch (metric.type) {
      case PerformanceMetricType.RESPONSE_TIME:
        return metric.value > 1000; // Log slow responses
      case PerformanceMetricType.ERROR_RATE:
        return metric.value > 1; // Log any error rate
      case PerformanceMetricType.CPU_USAGE:
      case PerformanceMetricType.MEMORY_USAGE:
        return metric.value > 70; // Log high resource usage
      default:
        return false;
    }
  }

  private calculateUptime(service: string, timeWindow: number): number {
    // Simplified uptime calculation based on health checks
    const healthCheck = this.healthChecks.get(service);
    if (!healthCheck) return 0;
    
    return healthCheck.status === HealthStatus.HEALTHY ? 100 : 
           healthCheck.status === HealthStatus.DEGRADED ? 95 : 0;
  }

  private calculateAvailability(service: string, timeWindow: number): number {
    // Simplified availability calculation
    const healthCheck = this.healthChecks.get(service);
    if (!healthCheck) return 0;
    
    return healthCheck.status !== HealthStatus.UNHEALTHY ? 100 : 0;
  }

  private trimMetricsInMemory(): void {
    if (this.metrics.length > this.maxMetricsInMemory) {
      this.metrics = this.metrics.slice(-this.maxMetricsInMemory);
    }
  }

  private trimSnapshotsInMemory(): void {
    if (this.systemSnapshots.length > this.maxSnapshotsInMemory) {
      this.systemSnapshots = this.systemSnapshots.slice(-this.maxSnapshotsInMemory);
    }
  }

  private generateMetricId(): string {
    return generateSecureId('metric', 9);
  }

  private generateAlertId(): string {
    return generateSecureId('perf_alert', 9);
  }
}

export default PerformanceMonitoringService;