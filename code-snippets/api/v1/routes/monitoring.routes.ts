import { Router, Request, Response } from 'express';
import { SecurityMonitoringService, SecurityAlertType, SecurityAction } from '../../../services/securityMonitoring.service';
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
  registerMonitoringRoutes();
}

/**
 * Get SecurityMonitoringService from injected services
 */
const getSecurityMonitoringService = (): SecurityMonitoringService => {
  if (!routeServices) {
    throw new Error('Route services not initialized. Call initializeRouteServices() first.');
  }
  if (!routeServices.services.securityMonitoringService) {
    throw new Error('SecurityMonitoringService not available in injected services');
  }
  return routeServices.services.securityMonitoringService;
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
 * Get cache middleware from MiddlewareFactory
 */
const getCacheMiddleware = (invalidationKeys?: string[]) => {
  if (!routeServices) {
    throw new Error('Route services not initialized');
  }
  return routeServices.middlewareFactory.createCachingMiddleware(invalidationKeys);
};

/**
 * Register all monitoring routes after services are initialized
 */
function registerMonitoringRoutes() {
  // Clear any existing routes first
  router.stack.length = 0;

  /**
   * Get security dashboard
   */
  router.get('/dashboard', 
  getRateLimiter('strict'),
  ...getCacheMiddleware(['security-monitoring', 'security-dashboard']),
  async (req: Request, res: Response): Promise<void> => {
  try {
    const timeWindow = req.query.timeWindow ? parseInt(req.query.timeWindow as string) : 24 * 60 * 60 * 1000; // 24 hours
    const securityMonitoring = getSecurityMonitoringService();
    const dashboard = securityMonitoring.getSecurityDashboard(timeWindow);
    
    res.json({
      success: true,
      data: dashboard,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve security dashboard',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get active security alerts
 */
router.get('/alerts/active', 
  getRateLimiter('strict'),
  ...getCacheMiddleware(['security-alerts']),
  async (req: Request, res: Response): Promise<void> => {
  try {
    const securityMonitoring = getSecurityMonitoringService();
    const activeAlerts = securityMonitoring.getActiveAlerts();
    
    res.json({
      success: true,
      data: {
        count: activeAlerts.length,
        alerts: activeAlerts,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve active alerts',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get alerts by type
 */
router.get('/alerts/type/:type', 
  getRateLimiter('strict'),
  ...getCacheMiddleware(['security-alerts']),
  async (req: Request, res: Response): Promise<void> => {
  try {
    const typeParam = getRouteParam(req, 'type');
    const alertType = typeParam.toUpperCase() as SecurityAlertType;
    
    if (!Object.values(SecurityAlertType).includes(alertType)) {
      res.status(400).json({
        success: false,
        error: 'Invalid alert type',
        validTypes: Object.values(SecurityAlertType),
      });
      return;
    }
    
    const securityMonitoring = getSecurityMonitoringService();
    const activeAlerts = securityMonitoring.getActiveAlerts();
    const filteredAlerts = activeAlerts.filter(alert => alert.type === alertType);
    
    res.json({
      success: true,
      data: {
        type: alertType,
        count: filteredAlerts.length,
        alerts: filteredAlerts,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve alerts by type',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Resolve a security alert
 */
router.post('/alerts/:alertId/resolve', 
  getRateLimiter('strict'),
  ...getCacheMiddleware(['security-alerts', 'security-monitoring']),
  async (req: Request, res: Response): Promise<void> => {
  try {
    const alertId = getRouteParam(req, 'alertId');
    const { resolvedBy } = req.body;
    
    const securityMonitoring = getSecurityMonitoringService();
    const resolved = securityMonitoring.resolveAlert(alertId, resolvedBy);
    
    if (resolved) {
      res.json({
        success: true,
        message: 'Alert resolved successfully',
        alertId,
        resolvedBy,
        timestamp: new Date().toISOString(),
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Alert not found or already resolved',
        alertId,
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to resolve alert',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get system health status
 */
router.get('/health', 
  getRateLimiter('standard'),
  ...getCacheMiddleware(['security-health']),
  async (req: Request, res: Response): Promise<void> => {
  try {
    const timeWindow = req.query.timeWindow ? parseInt(req.query.timeWindow as string) : 15 * 60 * 1000; // 15 minutes
    const securityMonitoring = getSecurityMonitoringService();
    const dashboard = securityMonitoring.getSecurityDashboard(timeWindow);
    
    res.json({
      success: true,
      data: {
        systemHealth: dashboard.systemHealth,
        threatLevel: dashboard.threatLevel,
        activeAlertsCount: dashboard.activeAlerts.length,
        metrics: dashboard.metrics,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve system health',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get threat intelligence
 */
router.get('/threats', 
  getRateLimiter('strict'),
  ...getCacheMiddleware(['security-threats', 'security-monitoring']),
  async (req: Request, res: Response): Promise<void> => {
  try {
    const timeWindow = req.query.timeWindow ? parseInt(req.query.timeWindow as string) : 24 * 60 * 60 * 1000; // 24 hours
    const securityMonitoring = getSecurityMonitoringService();
    const dashboard = securityMonitoring.getSecurityDashboard(timeWindow);
    
    res.json({
      success: true,
      data: {
        threatLevel: dashboard.threatLevel,
        topThreats: dashboard.topThreats,
        suspiciousIPs: dashboard.suspiciousIPs,
        threatsBlocked: dashboard.metrics.threatsBlocked,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve threat intelligence',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Add custom monitoring rule
 */
router.post('/rules', 
  getRateLimiter('strict'),
  ...getCacheMiddleware(['security-rules', 'security-monitoring']),
  async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      name,
      description,
      eventType,
      threshold,
      timeWindow,
      severity,
      alertType,
      actions,
      enabled = true,
      conditions,
    } = req.body;
    
    // Validate required fields
    if (!name || !description || !eventType || !threshold || !timeWindow || !severity || !alertType || !actions) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields',
        required: ['name', 'description', 'eventType', 'threshold', 'timeWindow', 'severity', 'alertType', 'actions'],
      });
      return;
    }
    
    // Validate enum values
    if (!Object.values(SecurityAlertType).includes(alertType)) {
      res.status(400).json({
        success: false,
        error: 'Invalid alert type',
        validTypes: Object.values(SecurityAlertType),
      });
      return;
    }
    
    if (!Array.isArray(actions) || !actions.every(action => Object.values(SecurityAction).includes(action))) {
      res.status(400).json({
        success: false,
        error: 'Invalid actions',
        validActions: Object.values(SecurityAction),
      });
      return;
    }
    
    const securityMonitoring = getSecurityMonitoringService();
    const ruleId = securityMonitoring.addMonitoringRule({
      name,
      description,
      eventType,
      threshold,
      timeWindow,
      severity,
      alertType,
      actions,
      enabled,
      conditions,
    });
    
    res.status(201).json({
      success: true,
      message: 'Monitoring rule created successfully',
      ruleId,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to create monitoring rule',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Remove monitoring rule
 */
router.delete('/rules/:ruleId', 
  getRateLimiter('strict'),
  ...getCacheMiddleware(['security-rules', 'security-monitoring']),
  async (req: Request, res: Response): Promise<void> => {
  try {
    const ruleId = getRouteParam(req, 'ruleId');
    
    const securityMonitoring = getSecurityMonitoringService();
    const removed = securityMonitoring.removeMonitoringRule(ruleId);
    
    if (removed) {
      res.json({
        success: true,
        message: 'Monitoring rule removed successfully',
        ruleId,
        timestamp: new Date().toISOString(),
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Monitoring rule not found',
        ruleId,
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to remove monitoring rule',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get monitoring statistics
 */
router.get('/stats', 
  getRateLimiter('standard'),
  ...getCacheMiddleware(['security-stats', 'security-monitoring']),
  async (req: Request, res: Response): Promise<void> => {
  try {
    const timeWindow = req.query.timeWindow ? parseInt(req.query.timeWindow as string) : 24 * 60 * 60 * 1000; // 24 hours
    const securityMonitoring = getSecurityMonitoringService();
    const dashboard = securityMonitoring.getSecurityDashboard(timeWindow);
    
    // Calculate additional statistics
    const alertsByType: Record<string, number> = {};
    dashboard.activeAlerts.forEach(alert => {
      alertsByType[alert.type] = (alertsByType[alert.type] || 0) + 1;
    });
    
    const alertsBySeverity: Record<string, number> = {};
    dashboard.activeAlerts.forEach(alert => {
      alertsBySeverity[alert.severity] = (alertsBySeverity[alert.severity] || 0) + 1;
    });
    
    res.json({
      success: true,
      data: {
        timeWindow,
        totalActiveAlerts: dashboard.activeAlerts.length,
        alertsByType,
        alertsBySeverity,
        systemHealth: dashboard.systemHealth,
        threatLevel: dashboard.threatLevel,
        metrics: dashboard.metrics,
        topThreats: dashboard.topThreats.slice(0, 3), // Top 3 threats
        suspiciousIPCount: dashboard.suspiciousIPs.length,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve monitoring statistics',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Test security monitoring (development only)
 */
router.post('/test-alert', 
  getRateLimiter('strict'),
  async (req: Request, res: Response): Promise<void> => {
  if (process.env.NODE_ENV === 'production') {
    res.status(403).json({
      success: false,
      error: 'Test endpoint not available in production',
    });
    return;
  }

  try {
    const { alertType, severity, description } = req.body;
    
    if (!alertType || !severity || !description) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: alertType, severity, description',
      });
      return;
    }
    
    // This would trigger the monitoring system to generate a test alert
    // In a real implementation, you might inject test events into the security logger
    
    res.json({
      success: true,
      message: 'Test alert triggered',
      alertType,
      severity,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to trigger test alert',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
  });
}

export default router;