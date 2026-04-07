import { Router, Request, Response } from 'express';
import {
  PerformanceMonitoringService,
  PerformanceMetricType,
  HealthStatus,
  PerformanceAlertType,
} from '../../../services/performanceMonitoring.service';
import { getRouteParam } from '../../../utils/auth-guards';
import type { MiddlewareFactory } from '../../../core/middleware-factory';
import type { InitializedServices } from '../../../bootstrap';
import type { ControllerRegistry } from '../../../core/controller-registry';

// Route services interface
export interface RouteServices {
  middlewareFactory: MiddlewareFactory;
  controllerRegistry: ControllerRegistry;
  services: InitializedServices;
}

const router = Router();

// Service injection support
let routeServices: RouteServices | null = null;

/**
 * Initialize route services and register routes
 */
export function initializeRouteServices(services: RouteServices): void {
  routeServices = services;
  
  // Register all routes after services are initialized
  registerPerformanceRoutes();
}

/**
 * Get PerformanceMonitoringService from injected services
 */
const getPerformanceMonitoringService = (): PerformanceMonitoringService => {
  if (!routeServices) {
    throw new Error('Route services not initialized. Call initializeRouteServices() first.');
  }
  if (!routeServices.services.performanceMonitoringService) { throw new Error('PerformanceMonitoringService not available'); } return routeServices.services.performanceMonitoringService;
};

/**
 * Get rate limiter from MiddlewareFactory
 */
const getRateLimiter = (type: 'strict' | 'standard' | 'ai' | 'auth' = 'strict') => {
  if (!routeServices) {
    throw new Error('Route services not initialized');
  }
  return routeServices.middlewareFactory.getRateLimiter(type);
};

/**
 * Register all performance routes after services are initialized
 */
function registerPerformanceRoutes() {
  // Clear any existing routes first
  router.stack.length = 0;

  /**
   * Get performance metrics
   */
  router.get('/metrics',
  getRateLimiter('strict'),
  async (req: Request, res: Response): Promise<void> => {
  try {
    const type = req.query.type as PerformanceMetricType;
    const timeWindow = req.query.timeWindow ? parseInt(req.query.timeWindow as string) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 1000;
    
    if (type && !Object.values(PerformanceMetricType).includes(type)) {
      res.status(400).json({
        success: false,
        error: 'Invalid metric type',
        validTypes: Object.values(PerformanceMetricType),
      });
      return;
    }
    
    const performanceMonitoring = getPerformanceMonitoringService();
    const metrics = getPerformanceMonitoringService().getPerformanceMetrics(type, timeWindow, limit);
    
    res.json({
      success: true,
      data: {
        type: type || 'all',
        count: metrics.length,
        timeWindow,
        metrics,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve performance metrics',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get service reliability metrics
 */
router.get('/reliability/:service', async (req: Request, res: Response): Promise<void> => {
  try {
    const service = getRouteParam(req, 'service');
    const timeWindow = req.query.timeWindow ? parseInt(req.query.timeWindow as string) : 24 * 60 * 60 * 1000; // 24 hours
    
    const reliabilityMetrics = getPerformanceMonitoringService().getServiceReliabilityMetrics(service, timeWindow);
    
    res.json({
      success: true,
      data: reliabilityMetrics,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve service reliability metrics',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get system health status
 */
router.get('/health', async (req: Request, res: Response): Promise<void> => {
  try {
    const healthStatus = getPerformanceMonitoringService().getHealthStatus();
    const healthArray = Array.from(healthStatus.entries()).map(([serviceName, status]) => ({
      service: serviceName,
      status: status.status,
      timestamp: status.timestamp,
      responseTime: status.responseTime,
      details: status.details,
      error: status.error,
    }));
    
    // Calculate overall system health
    const healthyServices = healthArray.filter(s => s.status === HealthStatus.HEALTHY).length;
    const totalServices = healthArray.length;
    const overallHealth = totalServices > 0 ? (healthyServices / totalServices) * 100 : 0;
    
    let overallStatus: HealthStatus;
    if (overallHealth >= 90) {
      overallStatus = HealthStatus.HEALTHY;
    } else if (overallHealth >= 70) {
      overallStatus = HealthStatus.DEGRADED;
    } else {
      overallStatus = HealthStatus.UNHEALTHY;
    }
    
    res.json({
      success: true,
      data: {
        overallStatus,
        overallHealth: Math.round(overallHealth),
        services: healthArray,
        summary: {
          total: totalServices,
          healthy: healthArray.filter(s => s.status === HealthStatus.HEALTHY).length,
          degraded: healthArray.filter(s => s.status === HealthStatus.DEGRADED).length,
          unhealthy: healthArray.filter(s => s.status === HealthStatus.UNHEALTHY).length,
          unknown: healthArray.filter(s => s.status === HealthStatus.UNKNOWN).length,
        },
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve health status',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get performance alerts
 */
router.get('/alerts', async (req: Request, res: Response): Promise<void> => {
  try {
    const resolved = req.query.resolved === 'true';
    const alerts = getPerformanceMonitoringService().getPerformanceAlerts(resolved);
    
    res.json({
      success: true,
      data: {
        resolved,
        count: alerts.length,
        alerts,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve performance alerts',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Resolve performance alert
 */
router.post('/alerts/:alertId/resolve', async (req: Request, res: Response): Promise<void> => {
  try {
    const alertId = getRouteParam(req, 'alertId');
    
    const resolved = getPerformanceMonitoringService().resolvePerformanceAlert(alertId);
    
    if (resolved) {
      res.json({
        success: true,
        message: 'Performance alert resolved successfully',
        alertId,
        timestamp: new Date().toISOString(),
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Performance alert not found or already resolved',
        alertId,
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to resolve performance alert',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get performance dashboard
 */
router.get('/dashboard', async (req: Request, res: Response): Promise<void> => {
  try {
    const timeWindow = req.query.timeWindow ? parseInt(req.query.timeWindow as string) : 60 * 60 * 1000; // 1 hour
    
    // Get various performance data
    const healthStatus = getPerformanceMonitoringService().getHealthStatus();
    const activeAlerts = getPerformanceMonitoringService().getPerformanceAlerts(false);
    const responseTimeMetrics = getPerformanceMonitoringService().getPerformanceMetrics(
      PerformanceMetricType.RESPONSE_TIME, 
      timeWindow, 
      100,
    );
    const cpuMetrics = getPerformanceMonitoringService().getPerformanceMetrics(
      PerformanceMetricType.CPU_USAGE, 
      timeWindow, 
      100,
    );
    const memoryMetrics = getPerformanceMonitoringService().getPerformanceMetrics(
      PerformanceMetricType.MEMORY_USAGE, 
      timeWindow, 
      100,
    );
    
    // Calculate averages
    const avgResponseTime = responseTimeMetrics.length > 0 
      ? responseTimeMetrics.reduce((sum, m) => sum + m.value, 0) / responseTimeMetrics.length 
      : 0;
    
    const avgCpuUsage = cpuMetrics.length > 0 
      ? cpuMetrics.reduce((sum, m) => sum + m.value, 0) / cpuMetrics.length 
      : 0;
    
    const avgMemoryUsage = memoryMetrics.length > 0 
      ? memoryMetrics.reduce((sum, m) => sum + m.value, 0) / memoryMetrics.length 
      : 0;
    
    // Get service reliability for key services
    const apiReliability = getPerformanceMonitoringService().getServiceReliabilityMetrics('api', timeWindow);
    const databaseReliability = getPerformanceMonitoringService().getServiceReliabilityMetrics('database', timeWindow);
    
    res.json({
      success: true,
      data: {
        timeWindow,
        overview: {
          avgResponseTime: Math.round(avgResponseTime),
          avgCpuUsage: Math.round(avgCpuUsage * 10) / 10,
          avgMemoryUsage: Math.round(avgMemoryUsage * 10) / 10,
          activeAlerts: activeAlerts.length,
          healthyServices: Array.from(healthStatus.values()).filter(h => h.status === HealthStatus.HEALTHY).length,
          totalServices: healthStatus.size,
        },
        health: {
          services: Array.from(healthStatus.entries()).map(([service, status]) => ({
            service,
            status: status.status,
            responseTime: status.responseTime,
            lastCheck: status.timestamp,
          })),
        },
        alerts: {
          active: activeAlerts.slice(0, 10), // Latest 10 alerts
          byType: activeAlerts.reduce((acc: Record<string, number>, alert) => {
            acc[alert.type] = (acc[alert.type] || 0) + 1;
            return acc;
          }, {}),
          bySeverity: activeAlerts.reduce((acc: Record<string, number>, alert) => {
            acc[alert.severity] = (acc[alert.severity] || 0) + 1;
            return acc;
          }, {}),
        },
        reliability: {
          api: {
            uptime: apiReliability.uptime,
            errorRate: apiReliability.errorRate,
            avgResponseTime: apiReliability.averageResponseTime,
          },
          database: {
            uptime: databaseReliability.uptime,
            errorRate: databaseReliability.errorRate,
            avgResponseTime: databaseReliability.averageResponseTime,
          },
        },
        trends: {
          responseTime: responseTimeMetrics.slice(-20).map(m => ({
            timestamp: m.timestamp,
            value: m.value,
          })),
          cpuUsage: cpuMetrics.slice(-20).map(m => ({
            timestamp: m.timestamp,
            value: m.value,
          })),
          memoryUsage: memoryMetrics.slice(-20).map(m => ({
            timestamp: m.timestamp,
            value: m.value,
          })),
        },
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve performance dashboard',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get performance statistics
 */
router.get('/stats', async (req: Request, res: Response): Promise<void> => {
  try {
    const timeWindow = req.query.timeWindow ? parseInt(req.query.timeWindow as string) : 24 * 60 * 60 * 1000; // 24 hours
    
    const allMetrics = getPerformanceMonitoringService().getPerformanceMetrics(undefined, timeWindow);

    // Group metrics by type
    const metricsByType: Partial<Record<PerformanceMetricType, number>> = {};
    Object.values(PerformanceMetricType).forEach(type => {
      metricsByType[type] = 0;
    });
    
    allMetrics.forEach(metric => {
      if (metricsByType[metric.type] !== undefined) {
        metricsByType[metric.type]!++;
      }
    });
    
    // Calculate statistics
    const responseTimeMetrics = allMetrics.filter(m => m.type === PerformanceMetricType.RESPONSE_TIME);
    const errorRateMetrics = allMetrics.filter(m => m.type === PerformanceMetricType.ERROR_RATE);
    
    const avgResponseTime = responseTimeMetrics.length > 0 
      ? responseTimeMetrics.reduce((sum, m) => sum + m.value, 0) / responseTimeMetrics.length 
      : 0;
    
    const avgErrorRate = errorRateMetrics.length > 0 
      ? errorRateMetrics.reduce((sum, m) => sum + m.value, 0) / errorRateMetrics.length 
      : 0;
    
    // Get slowest endpoints
    const endpointResponseTimes: Record<string, number[]> = {};
    responseTimeMetrics.forEach(metric => {
      const endpoint = metric.tags.endpoint || 'unknown';
      if (!endpointResponseTimes[endpoint]) {
        endpointResponseTimes[endpoint] = [];
      }
      endpointResponseTimes[endpoint].push(metric.value);
    });
    
    const slowestEndpoints = Object.entries(endpointResponseTimes)
      .map(([endpoint, times]) => ({
        endpoint,
        avgResponseTime: times.reduce((a, b) => a + b, 0) / times.length,
        requestCount: times.length,
      }))
      .sort((a, b) => b.avgResponseTime - a.avgResponseTime)
      .slice(0, 10);
    
    res.json({
      success: true,
      data: {
        timeWindow,
        totalMetrics: allMetrics.length,
        metricsByType,
        performance: {
          avgResponseTime: Math.round(avgResponseTime),
          avgErrorRate: Math.round(avgErrorRate * 100) / 100,
          slowestEndpoints,
        },
        alerts: {
          active: getPerformanceMonitoringService().getPerformanceAlerts(false).length,
          resolved: getPerformanceMonitoringService().getPerformanceAlerts(true).length,
        },
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve performance statistics',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Record custom performance metric (for testing/manual recording)
 */
router.post('/metrics', async (req: Request, res: Response): Promise<void> => {
  try {
    const { type, name, value, unit, tags, metadata } = req.body;
    
    if (!type || !name || value === undefined || !unit) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: type, name, value, unit',
      });
      return;
    }
    
    if (!Object.values(PerformanceMetricType).includes(type)) {
      res.status(400).json({
        success: false,
        error: 'Invalid metric type',
        validTypes: Object.values(PerformanceMetricType),
      });
      return;
    }
    
    getPerformanceMonitoringService().recordMetric(type, name, value, unit, tags || {}, metadata);
    
    res.status(201).json({
      success: true,
      message: 'Performance metric recorded successfully',
      metric: { type, name, value, unit, tags },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to record performance metric',
      message: error instanceof Error ? error.message : 'Unknown error',
      });
  }
  });
}

export default router;