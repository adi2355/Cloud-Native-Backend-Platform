import { Router, Request, Response, NextFunction } from 'express';
import { SecurityLoggerService, SecurityEventType, SecurityEventSeverity } from '../../../services/securityLogger.service';
import { getRouteParam } from '../../../utils/auth-guards';
import { ConfigSecurityService } from '../../../services/configSecurity.service';
import { AuthRateLimitService } from '../../../services/authRateLimit.service';
import { SessionSecurityService } from '../../../services/sessionSecurity.service';
// import { getAuthStats, unlockAccount, unbanIP, verifyCaptchaEndpoint } from '../middleware/authRateLimit.middleware';
// import { getSessionStats, getUserSessions, revokeUserSessions, expireSession } from '../middleware/sessionSecurity.middleware';
import { authorize } from '../middleware/authorization.middleware';
import type { MiddlewareFactory } from '../../../core/middleware-factory';
import type { InitializedServices } from '../../../bootstrap';

// Route services interface
export interface RouteServices {
  middlewareFactory: MiddlewareFactory;
  controllerRegistry: Record<string, unknown>;
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
  registerSecurityRoutes();
}

/**
 * Get SecurityLoggerService from injected services
 */
const getSecurityLoggerService = (): SecurityLoggerService => {
  if (!routeServices) {
    throw new Error('Route services not initialized. Call initializeRouteServices() first.');
  }
  return routeServices.services.securityLoggerService;
};

/**
 * Get SecurityConfigService from injected services
 */
const getSecurityConfigService = (): ConfigSecurityService => {
  if (!routeServices) {
    throw new Error('Route services not initialized');
  }
  return routeServices.services.securityConfigService;
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
 * Get authorization middleware with logger injection
 */
const getAuthorize = (requiredRoles: string[] = []) => {
  if (!routeServices) {
    throw new Error('Route services not initialized');
  }
  return authorize(requiredRoles, routeServices.services.logger);
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
 * Get AuthRateLimitService from injected services
 */
const getAuthRateLimitService = (): AuthRateLimitService => {
  if (!routeServices) {
    throw new Error('Route services not initialized. Call initializeRouteServices() first.');
  }
  return routeServices.services.authRateLimitService;
};

/**
 * Get SessionSecurityService from injected services
 */
const getSessionSecurityService = (): SessionSecurityService => {
  if (!routeServices) {
    throw new Error('Route services not initialized. Call initializeRouteServices() first.');
  }
  return routeServices.services.sessionSecurityService;
};

/**
 * Register security routes after services are initialized
 */
function registerSecurityRoutes() {
  // Clear any existing routes first
  router.stack.length = 0;

  /**
   * Get security metrics
   */
  router.get('/metrics',
  getRateLimiter('strict'),
  ...getCacheMiddleware(['security-metrics']),
  async (req: Request, res: Response) => {
  try {
    const timeWindow = req.query.timeWindow ? parseInt(req.query.timeWindow as string) : undefined;
    const securityLogger = getSecurityLoggerService();
    const metrics = securityLogger.getSecurityMetrics(timeWindow);
    
    res.json({
      success: true,
      data: metrics,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve security metrics',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get security events by type
 */
router.get('/events/:type',
  getRateLimiter('strict'),
  ...getCacheMiddleware(['security-events']),
  async (req: Request, res: Response): Promise<void> => {
  try {
    const typeParam = getRouteParam(req, 'type');
    const eventType = typeParam.toUpperCase() as SecurityEventType;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;
    
    if (!Object.values(SecurityEventType).includes(eventType)) {
      res.status(400).json({
        success: false,
        error: 'Invalid event type',
        validTypes: Object.values(SecurityEventType),
      });
      return;
    }
    
    const securityLogger = getSecurityLoggerService();
    const events = securityLogger.getEventsByType(eventType, limit);
    
    res.json({
      success: true,
      data: {
        eventType,
        count: events.length,
        events: events.map(event => ({
          ...event,
          // Remove sensitive details for API response
          userContext: event.userContext ? {
            ip: event.userContext.ip,
            userId: event.userContext.userId ? '[MASKED]' : undefined,
          } : undefined,
        })),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve security events',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get security events by severity
 */
router.get('/events/severity/:severity',
  getRateLimiter('strict'),
  ...getCacheMiddleware(['security-events']),
  async (req: Request, res: Response): Promise<void> => {
  try {
    const severityParam = getRouteParam(req, 'severity');
    const severity = severityParam.toUpperCase() as SecurityEventSeverity;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;
    
    if (!Object.values(SecurityEventSeverity).includes(severity)) {
      res.status(400).json({
        success: false,
        error: 'Invalid severity level',
        validSeverities: Object.values(SecurityEventSeverity),
      });
      return;
    }
    
    const securityLogger = getSecurityLoggerService();
    const events = securityLogger.getEventsBySeverity(severity, limit);
    
    res.json({
      success: true,
      data: {
        severity,
        count: events.length,
        events: events.map(event => ({
          ...event,
          // Remove sensitive details for API response
          userContext: event.userContext ? {
            ip: event.userContext.ip,
            userId: event.userContext.userId ? '[MASKED]' : undefined,
          } : undefined,
        })),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve security events',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get configuration security audit
 */
router.get('/config-audit',
  getRateLimiter('strict'),
  ...getCacheMiddleware(['config-audit']),
  async (req: Request, res: Response) => {
  try {
    const configSecurityService = getSecurityConfigService();
    const audit = await configSecurityService.auditConfigSecurity();
    
    // Remove sensitive information from audit results
    const sanitizedAudit = {
      ...audit,
      environmentVariables: audit.environmentVariables.map(env => ({
        name: env.name,
        isSet: env.isSet,
        isSecure: env.isSecure,
        exposureRisk: env.exposureRisk,
        recommendation: env.recommendation,
        // Remove actual values
      })),
    };
    
    res.json({
      success: true,
      data: sanitizedAudit,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to perform configuration audit',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get security dashboard summary
 */
router.get('/dashboard',
  getRateLimiter('strict'),
  ...getCacheMiddleware(['security-dashboard', 'security-metrics']),
  async (req: Request, res: Response) => {
  try {
    const last24Hours = 24 * 60 * 60 * 1000;
    const securityLogger = getSecurityLoggerService();
    const configSecurityService = getSecurityConfigService();
    const metrics = securityLogger.getSecurityMetrics(last24Hours);
    const configAudit = await configSecurityService.validateConfiguration();
    
    const dashboard = {
      overview: {
        totalEvents24h: metrics.totalEvents,
        securityScore: configAudit.securityScore,
        criticalEvents: metrics.eventsBySeverity[SecurityEventSeverity.CRITICAL] || 0,
        highSeverityEvents: metrics.eventsBySeverity[SecurityEventSeverity.HIGH] || 0,
        suspiciousIPs: metrics.suspiciousIPs.length,
        isConfigValid: configAudit.isValid,
      },
      eventBreakdown: {
        authFailures: metrics.eventsByType[SecurityEventType.AUTHENTICATION_FAILURE] || 0,
        rateLimitExceeded: metrics.eventsByType[SecurityEventType.RATE_LIMIT_EXCEEDED] || 0,
        corsViolations: metrics.eventsByType[SecurityEventType.CORS_VIOLATION] || 0,
        suspiciousActivity: metrics.eventsByType[SecurityEventType.SUSPICIOUS_ACTIVITY] || 0,
      },
      topEndpoints: metrics.topEndpoints.slice(0, 5),
      recentCriticalEvents: metrics.recentEvents
        .filter(event => event.severity === SecurityEventSeverity.CRITICAL)
        .slice(-5)
        .map(event => ({
          timestamp: event.timestamp,
          type: event.type,
          message: event.message,
          endpoint: event.details.endpoint,
        })),
      configurationStatus: {
        errors: configAudit.errors.length,
        warnings: configAudit.warnings.length,
        recommendations: configAudit.recommendations.slice(0, 3),
      },
    };
    
    res.json({
      success: true,
      data: dashboard,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to generate security dashboard',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get authentication statistics and rate limiting info
 */
router.get('/auth-stats',
  getRateLimiter('strict'),
  ...getCacheMiddleware(['auth-stats']),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authRateLimitService = getAuthRateLimitService();
      const stats = authRateLimitService.getAuthStats();
      const lockedAccounts = authRateLimitService.getLockedAccounts();
      const bannedIPs = authRateLimitService.getBannedIPs();
      const suspiciousIPs = authRateLimitService.getSuspiciousIPs();

      res.json({
        success: true,
        data: {
          ...stats,
          lockedAccountDetails: lockedAccounts.map(account => ({
            userId: account.userId,
            lockedAt: new Date(account.lockedAt).toISOString(),
            unlockAt: new Date(account.unlockAt).toISOString(),
            failedAttempts: account.failedAttempts,
            requiresAdminUnlock: account.requiresAdminUnlock,
          })),
          bannedIPDetails: bannedIPs.map(ban => ({
            ip: ban.ip,
            bannedAt: new Date(ban.bannedAt).toISOString(),
            unbanAt: new Date(ban.unbanAt).toISOString(),
            reason: ban.reason,
            severity: ban.severity,
          })),
          suspiciousIPList: suspiciousIPs,
        },
        metadata: {
          timestamp: new Date().toISOString(),
          cached: false,
        },
      });
    } catch (error) {
      const logger = routeServices!.services.logger;
      logger.error('Failed to get auth stats', { error });
      next(error);
    }
  },
);

/**
 * Unlock user account (admin only)
 */
router.post('/unlock-account',
  getRateLimiter('strict'),
  getAuthorize(['admin']),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { userId } = req.body;

      if (!userId) {
        res.status(400).json({
          success: false,
          error: 'User ID is required',
        });
        return;
      }

      const authRateLimitService = getAuthRateLimitService();
      const unlocked = authRateLimitService.unlockAccount(userId);

      const logger = routeServices!.services.logger;
      const securityLogger = getSecurityLoggerService();

      if (unlocked) {
        logger.info('Account unlocked successfully', {
          userId,
          adminId: req.user?.id,
        });

        securityLogger.logAccountSecurityEvent(
          'unlocked',
          userId,
          req.ip,
          req.get('User-Agent'),
          {
            unlockedBy: req.user?.id,
            reason: 'ADMIN_UNLOCK',
          },
        );

        res.json({
          success: true,
          message: 'Account unlocked successfully',
          metadata: {
            userId,
            unlockedBy: req.user?.id,
            timestamp: new Date().toISOString(),
          },
        });
      } else {
        res.status(404).json({
          success: false,
          error: 'Account not found or not locked',
        });
      }
    } catch (error) {
      const logger = routeServices!.services.logger;
      logger.error('Failed to unlock account', { error });
      next(error);
    }
  },
);

/**
 * Unban IP address (admin only)
 */
router.post('/unban-ip',
  getRateLimiter('strict'),
  getAuthorize(['admin']),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { ipAddress } = req.body;

      if (!ipAddress) {
        res.status(400).json({
          success: false,
          error: 'IP address is required',
        });
        return;
      }

      // Validate IP format
      const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
      const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;

      if (!ipRegex.test(ipAddress) && !ipv6Regex.test(ipAddress)) {
        res.status(400).json({
          success: false,
          error: 'Invalid IP address format',
        });
        return;
      }

      const authRateLimitService = getAuthRateLimitService();
      const unbanned = authRateLimitService.unbanIP(ipAddress);

      const logger = routeServices!.services.logger;
      const securityLogger = getSecurityLoggerService();

      if (unbanned) {
        logger.info('IP unbanned successfully', {
          ipAddress,
          adminId: req.user?.id,
        });

        securityLogger.logSecurityEvent(
          SecurityEventType.AUTHENTICATION_SUCCESS,
          SecurityEventSeverity.LOW,
          'IP address unbanned by admin',
          { endpoint: req.path, method: req.method },
          { ip: ipAddress, userId: req.user?.id },
          { unbannedBy: req.user?.id },
        );

        res.json({
          success: true,
          message: 'IP address unbanned successfully',
          metadata: {
            ipAddress,
            unbannedBy: req.user?.id,
            timestamp: new Date().toISOString(),
          },
        });
      } else {
        res.status(404).json({
          success: false,
          error: 'IP address not found in ban list',
        });
      }
    } catch (error) {
      const logger = routeServices!.services.logger;
      logger.error('Failed to unban IP', { error });
      next(error);
    }
  },
);

/**
 * Verify CAPTCHA challenge
 */
router.post('/verify-captcha',
  getRateLimiter('standard'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { captchaToken, challengeId } = req.body;

      if (!captchaToken || !challengeId) {
        res.status(400).json({
          success: false,
          error: 'CAPTCHA token and challenge ID are required',
        });
        return;
      }

      const authRateLimitService = getAuthRateLimitService();
      const isValid = authRateLimitService.verifyCaptchaChallenge(challengeId, captchaToken);

      const logger = routeServices!.services.logger;
      const securityLogger = getSecurityLoggerService();

      if (isValid) {
        logger.info('CAPTCHA verified successfully', {
          challengeId,
          ip: req.ip,
        });

        securityLogger.logSecurityEvent(
          SecurityEventType.AUTHENTICATION_SUCCESS,
          SecurityEventSeverity.LOW,
          'CAPTCHA challenge completed successfully',
          { endpoint: req.path, method: req.method },
          { ip: req.ip, userAgent: req.get('User-Agent') },
          { challengeId },
        );

        res.json({
          success: true,
          verified: true,
          metadata: {
            challengeId,
            timestamp: new Date().toISOString(),
          },
        });
      } else {
        logger.warn('CAPTCHA verification failed', {
          challengeId,
          ip: req.ip,
        });

        securityLogger.logSecurityEvent(
          SecurityEventType.AUTHENTICATION_FAILURE,
          SecurityEventSeverity.MEDIUM,
          'CAPTCHA challenge failed',
          { endpoint: req.path, method: req.method },
          { ip: req.ip, userAgent: req.get('User-Agent') },
          { challengeId },
        );

        res.status(400).json({
          success: false,
          verified: false,
          error: 'Invalid or expired CAPTCHA',
        });
      }
    } catch (error) {
      const logger = routeServices!.services.logger;
      logger.error('Failed to verify CAPTCHA', { error });
      next(error);
    }
  },
);

/**
 * Get session statistics
 */
router.get('/session-stats',
  getRateLimiter('strict'),
  getAuthorize(['admin']),
  ...getCacheMiddleware(['session-stats']),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const sessionSecurityService = getSessionSecurityService();
      const stats = sessionSecurityService.getSessionStats();

      res.json({
        success: true,
        data: {
          activeSessions: stats.totalActiveSessions,
          expiredSessions: 0, // Can be calculated if we track expired sessions
          totalSessions: stats.totalActiveSessions,
          suspiciousSessions: stats.highRiskSessions,
          totalUsers: stats.totalUsers,
          averageSessionsPerUser: stats.averageSessionsPerUser,
          sessionsWithFlags: stats.sessionsWithFlags,
          deviceCount: stats.deviceCount,
          lastUpdated: new Date().toISOString(),
        },
        metadata: {
          timestamp: new Date().toISOString(),
          cached: false,
        },
      });
    } catch (error) {
      const logger = routeServices!.services.logger;
      logger.error('Failed to get session stats', { error });
      next(error);
    }
  },
);

/**
 * Get user sessions
 */
router.get('/sessions/user/:userId',
  getRateLimiter('strict'),
  getAuthorize(['admin']),
  ...getCacheMiddleware(['user-sessions']),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { userId } = req.params;

      if (!userId) {
        res.status(400).json({
          success: false,
          error: 'User ID is required',
        });
        return;
      }

      const sessionSecurityService = getSessionSecurityService();
      const sessions = sessionSecurityService.getUserSessions(userId);

      const formattedSessions = sessions.map(session => ({
        sessionId: session.sessionId,
        userId: session.userId,
        createdAt: new Date(session.createdAt).toISOString(),
        lastActivity: new Date(session.lastActivity).toISOString(),
        expiresAt: new Date(session.expiresAt).toISOString(),
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        status: session.isActive ? 'active' : 'inactive',
        deviceId: session.deviceFingerprint.id,
        platform: session.deviceFingerprint.platform,
        location: session.location ? {
          country: session.location.country,
          region: session.location.region,
          city: session.location.city,
        } : undefined,
        riskScore: session.riskScore,
        flags: session.flags,
      }));

      res.json({
        success: true,
        data: formattedSessions,
        metadata: {
          timestamp: new Date().toISOString(),
          count: formattedSessions.length,
          userId,
        },
      });
    } catch (error) {
      const logger = routeServices!.services.logger;
      logger.error('Failed to get user sessions', { error });
      next(error);
    }
  },
);

/**
 * Revoke user sessions (admin only)
 */
router.post('/sessions/revoke',
  getRateLimiter('strict'),
  getAuthorize(['admin']),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { userId, sessionIds } = req.body;

      if (!userId) {
        res.status(400).json({
          success: false,
          error: 'User ID is required',
        });
        return;
      }

      const sessionSecurityService = getSessionSecurityService();
      const logger = routeServices!.services.logger;
      const securityLogger = getSecurityLoggerService();

      let revokedCount = 0;

      if (sessionIds && Array.isArray(sessionIds)) {
        // Revoke specific sessions
        for (const sessionId of sessionIds) {
          const revoked = sessionSecurityService.expireSession(sessionId, 'ADMIN_REVOKED');
          if (revoked) revokedCount++;
        }
      } else {
        // Revoke all user sessions
        revokedCount = sessionSecurityService.revokeUserSessions(userId);
      }

      logger.info('Sessions revoked successfully', {
        userId,
        sessionIds,
        revokedCount,
        adminId: req.user?.id,
      });

      securityLogger.logSessionEvent(
        'revoked',
        userId,
        undefined,
        req.ip,
        req.get('User-Agent'),
        {
          revokedCount,
          revokedBy: req.user?.id,
          sessionIds: sessionIds || 'all',
        },
      );

      res.json({
        success: true,
        message: `${revokedCount} session(s) revoked successfully`,
        revokedCount,
        metadata: {
          userId,
          revokedBy: req.user?.id,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      const logger = routeServices!.services.logger;
      logger.error('Failed to revoke sessions', { error });
      next(error);
    }
  },
);

/**
 * Expire specific session (admin only)
 */
router.post('/sessions/expire',
  getRateLimiter('strict'),
  getAuthorize(['admin']),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { sessionId } = req.body;

      if (!sessionId) {
        res.status(400).json({
          success: false,
          error: 'Session ID is required',
        });
        return;
      }

      const sessionSecurityService = getSessionSecurityService();
      const { reason } = req.body;
      const sessionReason = reason || 'ADMIN_EXPIRED';
      const expired = sessionSecurityService.expireSession(sessionId, sessionReason);

      const logger = routeServices!.services.logger;
      const securityLogger = getSecurityLoggerService();

      if (expired) {
        logger.info('Session expired successfully', {
          sessionId,
          reason: sessionReason,
          adminId: req.user?.id,
        });

        // Get session info for logging (if available)
        const session = sessionSecurityService.getSession(sessionId);

        securityLogger.logSessionEvent(
          'expired',
          session?.userId || 'unknown',
          sessionId,
          req.ip,
          req.get('User-Agent'),
          {
            expiredBy: req.user?.id,
            reason: sessionReason,
          },
        );

        res.json({
          success: true,
          message: 'Session expired successfully',
          metadata: {
            sessionId,
            expiredBy: req.user?.id,
            reason: sessionReason,
            timestamp: new Date().toISOString(),
          },
        });
      } else {
        res.status(404).json({
          success: false,
          error: 'Session not found or already expired',
        });
      }
    } catch (error) {
      const logger = routeServices!.services.logger;
      logger.error('Failed to expire session', { error });
      next(error);
    }
  },
);

/**
 * Get security alerts
 */
router.get('/alerts',
  getRateLimiter('strict'),
  ...getCacheMiddleware(['security-alerts']),
  async (req: Request, res: Response) => {
  try {
    const timeWindow = req.query.timeWindow ? parseInt(req.query.timeWindow as string) : undefined;
    const securityLogger = getSecurityLoggerService();
    const alerts = securityLogger.getSecurityAlerts(timeWindow);
    
    res.json({
      success: true,
      data: {
        alerts,
        count: alerts.length,
        timeWindow: timeWindow || 24 * 60 * 60 * 1000,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve security alerts',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Export security events
 */
router.get('/export',
  getRateLimiter('strict'),
  async (req: Request, res: Response) => {
  try {
    const timeWindow = req.query.timeWindow ? parseInt(req.query.timeWindow as string) : undefined;
    const format = (req.query.format as 'json' | 'csv') || 'json';
    const eventTypes = req.query.eventTypes ? 
      (req.query.eventTypes as string).split(',').map(t => t.trim().toUpperCase() as SecurityEventType) : 
      undefined;
    
    const securityLogger = getSecurityLoggerService();
    const exportData = securityLogger.exportSecurityEvents(timeWindow, eventTypes, format);
    
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="security-events-${new Date().toISOString().split('T')[0]}.csv"`);
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="security-events-${new Date().toISOString().split('T')[0]}.json"`);
    }
    
    res.send(exportData);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to export security events',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Clear old security events (admin only)
 */
router.delete('/events/cleanup',
  getRateLimiter('strict'),
  async (req: Request, res: Response) => {
  try {
    const olderThanDays = req.query.olderThanDays ? parseInt(req.query.olderThanDays as string) : 30;
    const securityLogger = getSecurityLoggerService();
    const removedCount = securityLogger.clearOldEvents(olderThanDays);
    
    res.json({
      success: true,
      message: `Cleaned up ${removedCount} old security events`,
      removedCount,
      olderThanDays,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to cleanup old events',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Test security logging (development only)
 */
router.post('/test-event',
  getRateLimiter('strict'),
  async (req: Request, res: Response): Promise<void> => {
  if (process.env.NODE_ENV === 'production') {
    res.status(403).json({
      success: false,
      error: 'Test endpoints not available in production',
    });
    return;
  }
  
  try {
    const { type, severity, message } = req.body;
    
    if (!type || !severity || !message) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: type, severity, message',
      });
      return;
    }
    
    const securityLogger = getSecurityLoggerService();
    securityLogger.logSecurityEvent(
      type as SecurityEventType,
      severity as SecurityEventSeverity,
      message,
      { endpoint: req.path, method: req.method },
      { ip: req.ip, userAgent: req.get('User-Agent') },
    );
    
    res.json({
      success: true,
      message: 'Test security event logged successfully',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to log test event',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
  });
}

export default router;