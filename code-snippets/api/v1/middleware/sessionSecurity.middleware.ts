import { Request, Response, NextFunction } from 'express';
import { getOptionalUser, getSessionId } from '../../../utils/auth-guards';
import { SessionSecurityService, SessionFlag } from '../../../services/sessionSecurity.service';
import { SecurityLoggerService } from '../../../services/securityLogger.service';
import { LoggerService } from '../../../services/logger.service';

export interface SessionSecurityRequest extends Request {
  sessionSecurity?: {
    sessionId: string;
    riskScore: number;
    flags: SessionFlag[];
    requiresAdditionalAuth: boolean;
  };
}

/**
 * Device information extracted from HTTP request headers
 */
export interface DeviceInfo {
  screenResolution?: string;
  timezone?: string;
  language: string;
  platform?: string;
}

/**
 * Location information extracted from HTTP request headers
 */
export interface LocationInfo {
  country: string;
  region: string;
  city: string;
  timezone: string;
}

/**
 * Session security validation result
 */
export interface SessionSecurityResult {
  allowed: boolean;
  riskScore: number;
  flags: SessionFlag[];
  requiresAdditionalAuth?: boolean;
  reason?: string;
  sessionInfo?: {
    sessionId: string;
  };
}

/**
 * Session Security Middleware
 * Provides device fingerprinting, session binding, and security monitoring
 */
export class SessionSecurityMiddleware {
  private sessionSecurity: SessionSecurityService;
  private securityLogger: SecurityLoggerService;

  constructor(
    sessionSecurity: SessionSecurityService,
    securityLogger: SecurityLoggerService,
    private logger?: LoggerService,
  ) {
    this.sessionSecurity = sessionSecurity;
    this.securityLogger = securityLogger;
  }

  /**
   * Create session middleware - used during authentication
   */
  public createSession = async (
    req: SessionSecurityRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      // Extract user information (should be set by auth middleware)
      const userId = getOptionalUser(req)?.id;
      if (!userId) {
        return next(); // Skip if no user context
      }

      const ipAddress = this.getClientIP(req);
      const userAgent = req.get('User-Agent') || 'Unknown';
      
      // Extract device info from request headers or body
      const deviceInfo = this.extractDeviceInfo(req);
      
      // Extract location info if available
      const location = this.extractLocationInfo(req);

      // Create session with security checks
      const result = await this.sessionSecurity.createSession(
        userId,
        ipAddress,
        userAgent,
        deviceInfo,
        location,
      );

      if (!result.allowed) {
        return this.handleSessionSecurityFailure(req, res, result);
      }

      // Attach session info to request
      req.sessionSecurity = {
        sessionId: result.sessionInfo!.sessionId,
        riskScore: result.riskScore,
        flags: result.flags,
        requiresAdditionalAuth: result.requiresAdditionalAuth || false,
      };

      // Set session ID in response headers
      res.setHeader('X-Session-ID', result.sessionInfo!.sessionId);
      res.setHeader('X-Session-Risk-Score', result.riskScore);
      
      if (result.flags.length > 0) {
        res.setHeader('X-Session-Flags', result.flags.join(','));
      }

      // If additional auth is required, set appropriate headers
      if (result.requiresAdditionalAuth) {
        res.setHeader('X-Requires-Additional-Auth', 'true');
      }

      next();
    } catch (error) {
      try {
        if (this.logger) {
          this.logger.error('Session security middleware error:', {
            error: error instanceof Error ? error.message : String(error),
            endpoint: req.path,
            method: req.method,
            ip: req.ip,
            userAgent: req.get('User-Agent'),
          });
        } else {
          console.error('Session security middleware error:', error);
        }
      } catch {
        console.error('Session security middleware error:', error);
      }
      // Continue without session security to avoid blocking legitimate users
      next();
    }
  };

  /**
   * Validate session middleware - used for ongoing requests
   */
  public validateSession = (
    req: SessionSecurityRequest,
    res: Response,
    next: NextFunction,
  ): void => {
    try {
      // Extract session ID from headers or request
      const sessionId = req.headers['x-session-id'] as string || 
                       req.body?.sessionId || 
                       getSessionId(req);

      if (!sessionId) {
        return next(); // Skip if no session ID
      }

      const ipAddress = this.getClientIP(req);
      const userAgent = req.get('User-Agent') || 'Unknown';
      const endpoint = req.path;

      // Validate session
      const result = this.sessionSecurity.validateSession(
        sessionId,
        ipAddress,
        userAgent,
        endpoint,
      );

      if (!result.allowed) {
        return this.handleSessionSecurityFailure(req, res, result);
      }

      // Attach session info to request
      req.sessionSecurity = {
        sessionId,
        riskScore: result.riskScore,
        flags: result.flags,
        requiresAdditionalAuth: result.requiresAdditionalAuth || false,
      };

      // Update response headers
      res.setHeader('X-Session-Risk-Score', result.riskScore);
      
      if (result.flags.length > 0) {
        res.setHeader('X-Session-Flags', result.flags.join(','));
      }

      // Record session activity
      this.recordActivity(req, res, sessionId);

      next();
    } catch (error) {
      try {
        if (this.logger) {
          this.logger.error('Session validation middleware error:', {
            error: error instanceof Error ? error.message : String(error),
            endpoint: req.path,
            method: req.method,
            ip: req.ip,
            userAgent: req.get('User-Agent'),
          });
        } else {
          console.error('Session validation middleware error:', error);
        }
      } catch {
        console.error('Session validation middleware error:', error);
      }
      // Continue without session validation to avoid blocking legitimate users
      next();
    }
  };

  /**
   * Session monitoring middleware - records activity
   */
  public monitorSession = (
    req: SessionSecurityRequest,
    res: Response,
    next: NextFunction,
  ): void => {
    const sessionId = req.sessionSecurity?.sessionId || 
                     req.headers['x-session-id'] as string;

    if (sessionId) {
      // Store original end method
      const originalEnd = res.end.bind(res);

      // Override end method to record activity
      const self = this;
      res.end = function(...args: Parameters<typeof originalEnd>) {
        try {
          const ipAddress = self.getClientIP(req);
          const userAgent = req.get('User-Agent') || 'Unknown';
          const responseTime = Date.now() - (req.requestStartTime || 0);

          // Record session activity
          self.sessionSecurity.recordSessionActivity(
            sessionId,
            req.path,
            req.method,
            ipAddress,
            userAgent,
            res.statusCode,
            responseTime,
          );
        } catch (error) {
          try {
            if (self.logger) {
              self.logger.error('Error recording session activity:', {
                error: error instanceof Error ? error.message : String(error),
                sessionId,
                endpoint: req.path,
              });
            } else {
              console.error('Error recording session activity:', error);
            }
          } catch {
            console.error('Error recording session activity:', error);
          }
        }

        // Call original end method with all arguments
        return originalEnd(...args);
      } as typeof res.end;
    }

    next();
  };

  /**
   * Handle session security failures
   */
  private handleSessionSecurityFailure(
    req: Request,
    res: Response,
    result: SessionSecurityResult,
  ): void {
    const ipAddress = this.getClientIP(req);
    
    let statusCode = 403;
    let message = 'Session security check failed';
    let code = 'SESSION_SECURITY_FAILED';

    switch (result.reason) {
      case 'SESSION_NOT_FOUND':
        statusCode = 401;
        message = 'Session not found. Please sign in again.';
        code = 'SESSION_NOT_FOUND';
        break;
      case 'SESSION_EXPIRED':
        statusCode = 401;
        message = 'Your session has expired. Please sign in again.';
        code = 'SESSION_EXPIRED';
        break;
      case 'SESSION_INACTIVE':
        statusCode = 401;
        message = 'Session is inactive. Please sign in again.';
        code = 'SESSION_INACTIVE';
        break;
      case 'SESSION_TERMINATED_SUSPICIOUS':
        statusCode = 403;
        message = 'Session terminated due to suspicious activity.';
        code = 'SESSION_TERMINATED';
        break;
      case 'CONCURRENT_SESSION_LIMIT_EXCEEDED':
        statusCode = 429;
        message = 'Too many active sessions. Please close other sessions and try again.';
        code = 'TOO_MANY_SESSIONS';
        break;
      case 'SESSION_CREATION_FAILED':
        statusCode = 500;
        message = 'Failed to create secure session. Please try again.';
        code = 'SESSION_CREATION_FAILED';
        break;
    }

    res.status(statusCode).json({
      success: false,
      error: message,
      code,
      security: {
        riskScore: result.riskScore,
        flags: result.flags,
        requiresAdditionalAuth: result.requiresAdditionalAuth,
      },
    });
  }

  /**
   * Record session activity
   */
  private recordActivity(req: Request, res: Response, sessionId: string): void {
    // Store start time for response time calculation
    // Set start time for performance tracking
    req.requestStartTime = Date.now();
  }

  /**
   * Extract device information from request
   */
  private extractDeviceInfo(req: Request): DeviceInfo {
    return {
      screenResolution: req.headers['x-screen-resolution'] as string,
      timezone: req.headers['x-timezone'] as string,
      language: req.headers['accept-language']?.split(',')[0] || 'en',
      platform: req.headers['x-platform'] as string,
    };
  }

  /**
   * Extract location information from request
   */
  private extractLocationInfo(req: Request): LocationInfo | undefined {
    const country = req.headers['x-country'] as string;
    const region = req.headers['x-region'] as string;
    const city = req.headers['x-city'] as string;
    const timezone = req.headers['x-timezone'] as string;

    if (country && region && city) {
      return {
        country,
        region,
        city,
        timezone: timezone || 'UTC',
      };
    }

    return undefined;
  }

  /**
   * Get client IP address
   */
  private getClientIP(req: Request): string {
    return (req.headers['x-forwarded-for'] as string)?.split(',')[0] ||
           req.connection.remoteAddress ||
           req.socket.remoteAddress ||
           'unknown';
  }

  /**
   * Admin endpoint to get session statistics
   */
  public getSessionStats = (req: Request, res: Response): void => {
    try {
      const stats = this.sessionSecurity.getSessionStats();
      
      res.json({
        success: true,
        statistics: stats,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      try {
        if (this.logger) {
          this.logger.error('Error getting session stats:', {
            error: error instanceof Error ? error.message : String(error),
          });
        } else {
          console.error('Error getting session stats:', error);
        }
      } catch {
        console.error('Error getting session stats:', error);
      }
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve session statistics',
      });
    }
  };

  /**
   * Admin endpoint to get user sessions
   */
  public getUserSessions = (req: Request, res: Response): void => {
    try {
      const { userId } = req.params;
      
      if (!userId) {
        res.status(400).json({
          success: false,
          error: 'User ID is required',
        });
        return;
      }

      const sessions = this.sessionSecurity.getUserSessions(userId);
      
      res.json({
        success: true,
        data: {
          userId,
          sessionCount: sessions.length,
          sessions: sessions.map(session => ({
            sessionId: session.sessionId,
            createdAt: new Date(session.createdAt).toISOString(),
            lastActivity: new Date(session.lastActivity).toISOString(),
            expiresAt: new Date(session.expiresAt).toISOString(),
            ipAddress: session.ipAddress,
            platform: session.deviceFingerprint.platform,
            location: session.location ? `${session.location.city}, ${session.location.country}` : undefined,
            riskScore: session.riskScore,
            flags: session.flags,
            isActive: session.isActive,
          })),
        },
      });
    } catch (error) {
      try {
        if (this.logger) {
          this.logger.error('Error getting user sessions:', {
            error: error instanceof Error ? error.message : String(error),
            userId: req.params.userId,
          });
        } else {
          console.error('Error getting user sessions:', error);
        }
      } catch {
        console.error('Error getting user sessions:', error);
      }
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve user sessions',
      });
    }
  };

  /**
   * Admin endpoint to revoke user sessions
   */
  public revokeUserSessions = (req: Request, res: Response): void => {
    try {
      const { userId } = req.body;
      const { exceptSessionId } = req.body;
      
      if (!userId) {
        res.status(400).json({
          success: false,
          error: 'User ID is required',
        });
        return;
      }

      const revokedCount = this.sessionSecurity.revokeUserSessions(userId, exceptSessionId);
      
      res.json({
        success: true,
        message: `Revoked ${revokedCount} sessions for user ${userId}`,
        revokedCount,
        userId,
      });
    } catch (error) {
      try {
        if (this.logger) {
          this.logger.error('Error revoking user sessions:', {
            error: error instanceof Error ? error.message : String(error),
            userId: req.body.userId,
          });
        } else {
          console.error('Error revoking user sessions:', error);
        }
      } catch {
        console.error('Error revoking user sessions:', error);
      }
      res.status(500).json({
        success: false,
        error: 'Failed to revoke user sessions',
      });
    }
  };

  /**
   * Admin endpoint to expire specific session
   */
  public expireSession = (req: Request, res: Response): void => {
    try {
      const { sessionId } = req.body;
      const { reason = 'ADMIN_EXPIRED' } = req.body;
      
      if (!sessionId) {
        res.status(400).json({
          success: false,
          error: 'Session ID is required',
        });
        return;
      }

      const expired = this.sessionSecurity.expireSession(sessionId, reason);
      
      if (expired) {
        res.json({
          success: true,
          message: `Session ${sessionId} has been expired`,
          sessionId,
          reason,
        });
      } else {
        res.status(404).json({
          success: false,
          error: 'Session not found or already expired',
          sessionId,
        });
      }
    } catch (error) {
      try {
        if (this.logger) {
          this.logger.error('Error expiring session:', {
            error: error instanceof Error ? error.message : String(error),
            sessionId: req.body.sessionId,
          });
        } else {
          console.error('Error expiring session:', error);
        }
      } catch {
        console.error('Error expiring session:', error);
      }
      res.status(500).json({
        success: false,
        error: 'Failed to expire session',
      });
    }
  };
}

/**
 * Factory function to create SessionSecurityMiddleware with dependency injection
 */
export function createSessionSecurityMiddleware(
  sessionSecurity: SessionSecurityService,
  securityLogger: SecurityLoggerService,
  logger?: LoggerService,
): SessionSecurityMiddleware {
  return new SessionSecurityMiddleware(sessionSecurity, securityLogger, logger);
}

/**
 * Factory functions for individual middleware methods
 */
export function createCreateSession(
  sessionSecurity: SessionSecurityService,
  securityLogger: SecurityLoggerService,
  logger?: LoggerService,
) {
  const middleware = new SessionSecurityMiddleware(sessionSecurity, securityLogger, logger);
  return middleware.createSession;
}

export function createValidateSession(
  sessionSecurity: SessionSecurityService,
  securityLogger: SecurityLoggerService,
  logger?: LoggerService,
) {
  const middleware = new SessionSecurityMiddleware(sessionSecurity, securityLogger, logger);
  return middleware.validateSession;
}

export function createMonitorSession(
  sessionSecurity: SessionSecurityService,
  securityLogger: SecurityLoggerService,
  logger?: LoggerService,
) {
  const middleware = new SessionSecurityMiddleware(sessionSecurity, securityLogger, logger);
  return middleware.monitorSession;
}

export function createGetSessionStats(
  sessionSecurity: SessionSecurityService,
  securityLogger: SecurityLoggerService,
) {
  const middleware = new SessionSecurityMiddleware(sessionSecurity, securityLogger);
  return middleware.getSessionStats;
}

export function createGetUserSessions(
  sessionSecurity: SessionSecurityService,
  securityLogger: SecurityLoggerService,
) {
  const middleware = new SessionSecurityMiddleware(sessionSecurity, securityLogger);
  return middleware.getUserSessions;
}

export function createRevokeUserSessions(
  sessionSecurity: SessionSecurityService,
  securityLogger: SecurityLoggerService,
) {
  const middleware = new SessionSecurityMiddleware(sessionSecurity, securityLogger);
  return middleware.revokeUserSessions;
}

export function createExpireSession(
  sessionSecurity: SessionSecurityService,
  securityLogger: SecurityLoggerService,
) {
  const middleware = new SessionSecurityMiddleware(sessionSecurity, securityLogger);
  return middleware.expireSession;
}

// Legacy exports - throw errors to enforce new DI pattern
export const createSession = (() => {
  throw new Error('createSession: Use createCreateSession factory function with explicit dependencies');
})();

export const validateSession = (() => {
  throw new Error('validateSession: Use createValidateSession factory function with explicit dependencies');
})();

export const monitorSession = (() => {
  throw new Error('monitorSession: Use createMonitorSession factory function with explicit dependencies');
})();

export const getSessionStats = (() => {
  throw new Error('getSessionStats: Use createGetSessionStats factory function with explicit dependencies');
})();

export const getUserSessions = (() => {
  throw new Error('getUserSessions: Use createGetUserSessions factory function with explicit dependencies');
})();

export const revokeUserSessions = (() => {
  throw new Error('revokeUserSessions factory function with explicit dependencies');
})();

export const expireSession = (() => {
  throw new Error('expireSession: Use createExpireSession factory function with explicit dependencies');
})();