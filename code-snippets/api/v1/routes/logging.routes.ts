import { Router, Request, Response } from 'express';
import { getRequestId, getOptionalUser } from '../../../utils/auth-guards';
import { LoggerService, LogLevel, LogCategory } from '../../../services/logger.service';
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
  registerLoggingRoutes();
}

/**
 * Get LoggerService from injected services
 */
const getLoggerService = (): LoggerService => {
  if (!routeServices) {
    throw new Error('Route services not initialized. Call initializeRouteServices() first.');
  }
  if (!routeServices.services.logger) { throw new Error('LoggerService not available'); } return routeServices.services.logger;
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
 * Register all logging routes after services are initialized
 */
function registerLoggingRoutes() {
  // Clear any existing routes first
  router.stack.length = 0;

  /**
   * Get log metrics
   */
  router.get('/metrics',
  getRateLimiter('strict'),
  async (req: Request, res: Response): Promise<void> => {
  try {
    const timeWindow = req.query.timeWindow ? parseInt(req.query.timeWindow as string) : undefined;
    const logger = getLoggerService();
    const metrics = getLoggerService().getLogMetrics(timeWindow);
    
    res.json({
      success: true,
      data: metrics,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve log metrics',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get logs by level
 */
router.get('/level/:level',
  getRateLimiter('strict'),
  async (req: Request, res: Response): Promise<void> => {
  try {
    const levelParam = req.params.level;
    if (!levelParam) {
      res.status(400).json({
        success: false,
        error: 'Log level parameter is required'
      });
      return;
    }
    const level = levelParam.toUpperCase() as LogLevel;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;
    const timeWindow = req.query.timeWindow ? parseInt(req.query.timeWindow as string) : undefined;
    
    if (!Object.values(LogLevel).includes(level)) {
      res.status(400).json({
        success: false,
        error: 'Invalid log level',
        validLevels: Object.values(LogLevel),
      });
      return;
    }
    
    const logger = getLoggerService();
    const logs = getLoggerService().getLogs(level, undefined, limit, timeWindow);
    
    res.json({
      success: true,
      data: {
        level,
        count: logs.length,
        logs,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve logs by level',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get logs by category
 */
router.get('/category/:category', async (req: Request, res: Response): Promise<void> => {
  try {
    const categoryParam = req.params.category;
    if (!categoryParam) {
      res.status(400).json({
        success: false,
        error: 'Log category parameter is required'
      });
      return;
    }
    const category = categoryParam.toUpperCase() as LogCategory;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;
    const timeWindow = req.query.timeWindow ? parseInt(req.query.timeWindow as string) : undefined;
    
    if (!Object.values(LogCategory).includes(category)) {
      res.status(400).json({
        success: false,
        error: 'Invalid log category',
        validCategories: Object.values(LogCategory),
      });
      return;
    }
    
    const logs = getLoggerService().getLogs(undefined, category, limit, timeWindow);
    
    res.json({
      success: true,
      data: {
        category,
        count: logs.length,
        logs,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve logs by category',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Search logs
 */
router.get('/search', async (req: Request, res: Response): Promise<void> => {
  try {
    const searchTerm = req.query.q as string;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;
    const timeWindow = req.query.timeWindow ? parseInt(req.query.timeWindow as string) : undefined;
    
    if (!searchTerm) {
      res.status(400).json({
        success: false,
        error: 'Search term is required',
        usage: '/api/v1/logging/search?q=search_term&limit=100&timeWindow=3600000',
      });
      return;
    }
    
    const logs = getLoggerService().searchLogs(searchTerm, limit, timeWindow);
    
    res.json({
      success: true,
      data: {
        searchTerm,
        count: logs.length,
        logs,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to search logs',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Export logs
 */
router.get('/export', async (req: Request, res: Response): Promise<void> => {
  try {
    const format = (req.query.format as string) || 'json';
    const timeWindow = req.query.timeWindow ? parseInt(req.query.timeWindow as string) : undefined;
    
    if (!['json', 'csv'].includes(format)) {
      res.status(400).json({
        success: false,
        error: 'Invalid format',
        validFormats: ['json', 'csv'],
      });
      return;
    }
    
    const exportData = getLoggerService().exportLogs(format as 'json' | 'csv', timeWindow);
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `logs_${timestamp}.${format}`;
    
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', format === 'json' ? 'application/json' : 'text/csv');
    
    res.send(exportData);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to export logs',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get recent errors
 */
router.get('/errors/recent', async (req: Request, res: Response): Promise<void> => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
    const timeWindow = req.query.timeWindow ? parseInt(req.query.timeWindow as string) : 24 * 60 * 60 * 1000; // 24 hours
    
    const errorLogs = getLoggerService().getLogs(LogLevel.ERROR, undefined, limit, timeWindow);
    const fatalLogs = getLoggerService().getLogs(LogLevel.FATAL, undefined, limit, timeWindow);
    
    const allErrors = [...errorLogs, ...fatalLogs]
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
    
    res.json({
      success: true,
      data: {
        count: allErrors.length,
        errors: allErrors,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve recent errors',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get performance metrics
 */
router.get('/performance', async (req: Request, res: Response): Promise<void> => {
  try {
    const timeWindow = req.query.timeWindow ? parseInt(req.query.timeWindow as string) : 60 * 60 * 1000; // 1 hour
    const metrics = getLoggerService().getLogMetrics(timeWindow);
    
    res.json({
      success: true,
      data: {
        averageResponseTime: metrics.averageResponseTime,
        errorRate: metrics.errorRate,
        performanceMetrics: metrics.performanceMetrics,
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
 * Get system health based on logs
 */
router.get('/health', async (req: Request, res: Response): Promise<void> => {
  try {
    const timeWindow = 15 * 60 * 1000; // 15 minutes
    const metrics = getLoggerService().getLogMetrics(timeWindow);
    
    // Calculate health score based on error rate and performance
    let healthScore = 100;
    
    // Deduct points for high error rate
    if (metrics.errorRate > 10) {
      healthScore -= 30;
    } else if (metrics.errorRate > 5) {
      healthScore -= 15;
    } else if (metrics.errorRate > 1) {
      healthScore -= 5;
    }
    
    // Deduct points for slow response times
    if (metrics.averageResponseTime > 5000) {
      healthScore -= 25;
    } else if (metrics.averageResponseTime > 2000) {
      healthScore -= 10;
    } else if (metrics.averageResponseTime > 1000) {
      healthScore -= 5;
    }
    
    // Deduct points for recent critical errors
    const criticalErrors = metrics.recentErrors.filter(e => e.level === LogLevel.FATAL).length;
    healthScore -= criticalErrors * 10;
    
    const status = healthScore >= 90 ? 'healthy' : 
                   healthScore >= 70 ? 'warning' : 
                   healthScore >= 50 ? 'degraded' : 'critical';
    
    res.json({
      success: true,
      data: {
        status,
        healthScore: Math.max(0, healthScore),
        metrics: {
          errorRate: metrics.errorRate,
          averageResponseTime: metrics.averageResponseTime,
          totalLogs: metrics.totalLogs,
          criticalErrors,
          recentErrorCount: metrics.recentErrors.length,
        },
        recommendations: generateHealthRecommendations(metrics, healthScore),
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
 * Test logging endpoint (development only)
 */
router.post('/test', async (req: Request, res: Response): Promise<void> => {
  if (process.env.NODE_ENV === 'production') {
    res.status(403).json({
      success: false,
      error: 'Test endpoint not available in production',
    });
    return;
  }

  try {
    const { level, category, message, data } = req.body;
    
    if (!level || !category || !message) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: level, category, message',
      });
      return;
    }
    
    getLoggerService().log(
      level as LogLevel,
      category as LogCategory,
      message,
      data,
      getRequestId(req),
      getOptionalUser(req)?.id,
    );
    
    res.json({
      success: true,
      message: 'Test log entry created',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to create test log entry',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

function generateHealthRecommendations(
  metrics: { errorRate: number; averageResponseTime: number; recentErrors: unknown[] },
  healthScore: number
): string[] {
  const recommendations: string[] = [];
  
  if (metrics.errorRate > 5) {
    recommendations.push('High error rate detected - investigate recent errors');
  }
  
  if (metrics.averageResponseTime > 2000) {
    recommendations.push('Slow response times detected - consider performance optimization');
  }
  
  if (metrics.recentErrors.length > 10) {
    recommendations.push('Multiple recent errors - check system stability');
  }
  
  if (healthScore < 70) {
    recommendations.push('System health is degraded - immediate attention required');
  }
  
  if (recommendations.length === 0) {
    recommendations.push('System is operating normally');
  }
  
  return recommendations;
}
}

export default router;