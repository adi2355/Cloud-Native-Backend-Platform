import { Request, Response, NextFunction } from 'express';
import { AuthRateLimitService, AuthRateLimitResult } from '../../../services/authRateLimit.service';
import { SecurityLoggerService, SecurityEventType, SecurityEventSeverity } from '../../../services/securityLogger.service';
import { LoggerService } from '../../../services/logger.service';

export interface AuthRateLimitRequest extends Request {
  authRateLimit?: {
    result: AuthRateLimitResult;
    captchaRequired: boolean;
    suspiciousActivity: boolean;
  };
}

/**
 * Authentication Rate Limiting Middleware
 * Provides brute force protection, account lockout, and CAPTCHA integration
 */
export class AuthRateLimitMiddleware {
  private authRateLimit: AuthRateLimitService;
  private securityLogger: SecurityLoggerService;

  constructor(
    authRateLimit: AuthRateLimitService,
    securityLogger: SecurityLoggerService,
    private logger: LoggerService,
  ) {
    this.authRateLimit = authRateLimit;
    this.securityLogger = securityLogger;
  }

  /**
   * Pre-authentication rate limiting check
   * Should be applied before authentication attempts
   */
  public preAuthCheck = async (
    req: AuthRateLimitRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const ip = this.getClientIP(req);
      const userAgent = req.get('User-Agent');
      const endpoint = req.path;
      
      // Extract userId from request body if available
      const userId = req.body?.username || req.body?.email || req.body?.phoneNumber;

      // Check if authentication attempt is allowed
      const result = this.authRateLimit.checkAuthAttempt(ip, userId, userAgent, endpoint);

      // Attach result to request for later use
      req.authRateLimit = {
        result,
        captchaRequired: result.requiresCaptcha,
        suspiciousActivity: result.suspiciousActivity,
      };

      if (!result.allowed) {
        return this.handleRateLimitExceeded(req, res, result);
      }

      // If CAPTCHA is required, verify it
      if (result.requiresCaptcha) {
        const captchaValid = await this.verifyCaptcha(req);
        if (!captchaValid) {
          return this.handleCaptchaRequired(req, res);
        }
      }

      // Log suspicious activity
      if (result.suspiciousActivity) {
        this.securityLogger.logSuspiciousActivity(
          'Suspicious authentication pattern detected',
          ip,
          endpoint,
          userAgent,
          { userId, remainingAttempts: result.remainingAttempts },
        );
      }

      next();
    } catch (error) {
      try {
        this.logger.error('Auth rate limit middleware error:', {
          error: error instanceof Error ? error.message : String(error),
          endpoint: req.path,
          method: req.method,
          ip: this.getClientIP(req),
        });
      } catch {
        console.error('Auth rate limit middleware error:', error);
      }
      // On error, allow request to proceed to avoid blocking legitimate users
      next();
    }
  };

  /**
   * Post-authentication result recording
   * Should be applied after authentication attempts to record results
   */
  public postAuthRecord = (
    req: AuthRateLimitRequest,
    res: Response,
    next: NextFunction,
  ): void => {
    // Store original end method and capture class instance
    const originalEnd = res.end.bind(res);
    const self = this; // Capture class instance for use in closure

    // Helper function to record auth attempt
    const recordAuthenticationAttempt = (): void => {
      try {
        const ip = self.getClientIP(req);
        const userAgent = req.get('User-Agent');
        const endpoint = req.path;
        const userId = req.body?.username || req.body?.email || req.body?.phoneNumber;

        // Determine if authentication was successful based on status code
        const success = res.statusCode >= 200 && res.statusCode < 300;

        // Determine error type from response
        let errorType: string | undefined;
        if (!success) {
          if (res.statusCode === 401) {
            errorType = 'INVALID_CREDENTIALS';
          } else if (res.statusCode === 403) {
            errorType = 'ACCESS_DENIED';
          } else if (res.statusCode === 429) {
            errorType = 'RATE_LIMITED';
          } else {
            errorType = 'AUTHENTICATION_ERROR';
          }
        }

        // Record the authentication attempt
        self.authRateLimit.recordAuthAttempt(
          success,
          ip,
          userId,
          userAgent,
          endpoint,
          errorType,
        );

        // Log additional security events for failed attempts
        if (!success && req.authRateLimit?.suspiciousActivity) {
          self.securityLogger.logSecurityEvent(
            SecurityEventType.BRUTE_FORCE_ATTEMPT,
            SecurityEventSeverity.HIGH,
            'Failed authentication attempt from suspicious IP',
            { endpoint, method: req.method, statusCode: res.statusCode, errorMessage: errorType },
            { userId, ip, userAgent },
          );
        }

      } catch (error: unknown) {
        try {
          self.logger.error('Error recording auth attempt:', {
            error: error instanceof Error ? error.message : String(error),
            endpoint: req.path,
            method: req.method,
            ip: self.getClientIP(req),
          });
        } catch {
          console.error('Error recording auth attempt:', error);
        }
      }
    };

    // Override end method to record authentication result (with proper overload signatures)
    res.end = function(
      chunkOrCb?: unknown,
      encodingOrCb?: BufferEncoding | (() => void),
      cb?: () => void
    ): Response {
      recordAuthenticationAttempt();

      // Type-safe delegation to original end method with all overload support
      if (chunkOrCb === undefined) {
        return originalEnd();
      } else if (typeof chunkOrCb === 'function') {
        return originalEnd(chunkOrCb as () => void);
      } else if (typeof encodingOrCb === 'function') {
        return originalEnd(chunkOrCb, encodingOrCb);
      } else if (encodingOrCb !== undefined) {
        return originalEnd(chunkOrCb, encodingOrCb as BufferEncoding, cb);
      } else {
        return originalEnd(chunkOrCb, cb);
      }
    };

    next();
  };

  /**
   * Handle rate limit exceeded
   */
  private handleRateLimitExceeded(
    req: Request,
    res: Response,
    result: AuthRateLimitResult,
  ): void {
    const ip = this.getClientIP(req);
    
    // Set appropriate headers
    if (result.retryAfter) {
      res.setHeader('Retry-After', result.retryAfter);
    }

    let statusCode = 429;
    let message = 'Too many authentication attempts. Please try again later.';
    let code = 'RATE_LIMIT_EXCEEDED';

    switch (result.reason) {
      case 'IP_BANNED':
        statusCode = 403;
        message = 'Your IP address has been temporarily banned due to suspicious activity.';
        code = 'IP_BANNED';
        break;
      case 'ACCOUNT_LOCKED':
        statusCode = 423; // Locked
        message = 'Your account has been temporarily locked due to too many failed attempts.';
        code = 'ACCOUNT_LOCKED';
        break;
      case 'TOO_MANY_ATTEMPTS':
        message = 'Too many failed authentication attempts. Please wait before trying again.';
        code = 'TOO_MANY_ATTEMPTS';
        break;
    }

    // Log the rate limiting event
    this.securityLogger.logRateLimitEvent(
      ip,
      req.path,
      0, // No specific limit number for auth attempts
      result.retryAfter ? result.retryAfter * 1000 : 0,
      req.get('User-Agent'),
    );

    res.status(statusCode).json({
      success: false,
      error: message,
      code,
      retryAfter: result.retryAfter,
      lockoutInfo: result.lockoutInfo ? {
        lockedAt: new Date(result.lockoutInfo.lockedAt).toISOString(),
        unlockAt: new Date(result.lockoutInfo.unlockAt).toISOString(),
        lockoutLevel: result.lockoutInfo.lockoutLevel,
        requiresAdminUnlock: result.lockoutInfo.requiresAdminUnlock,
      } : undefined,
      security: {
        requiresCaptcha: result.requiresCaptcha,
        suspiciousActivity: result.suspiciousActivity,
        remainingAttempts: result.remainingAttempts,
      },
    });
  }

  /**
   * Handle CAPTCHA required
   */
  private handleCaptchaRequired(req: Request, res: Response): void {
    const ip = this.getClientIP(req);
    const userId = req.body?.username || req.body?.email || req.body?.phoneNumber;
    
    // Create CAPTCHA challenge
    const challenge = this.authRateLimit.createCaptchaChallenge(ip, userId);

    res.status(428).json({ // 428 Precondition Required
      success: false,
      error: 'CAPTCHA verification required',
      code: 'CAPTCHA_REQUIRED',
      message: 'Please complete the CAPTCHA challenge to continue.',
      captcha: {
        challengeId: challenge.challengeId,
        expiresAt: new Date(challenge.expiresAt).toISOString(),
        maxAttempts: challenge.maxAttempts,
        // In a real implementation, this would include the CAPTCHA image/challenge
        challenge: this.generateCaptchaChallenge(),
      },
    });
  }

  /**
   * Verify CAPTCHA from request
   */
  private async verifyCaptcha(req: Request): Promise<boolean> {
    const captchaData = req.body?.captcha;
    if (!captchaData || !captchaData.challengeId || !captchaData.solution) {
      return false;
    }

    return this.authRateLimit.verifyCaptchaChallenge(
      captchaData.challengeId,
      captchaData.solution,
    );
  }

  /**
   * Generate CAPTCHA challenge (placeholder implementation)
   */
  private generateCaptchaChallenge(): {
    type: string;
    question: string;
    placeholder: string;
  } {
    // In a real implementation, this would integrate with a CAPTCHA service
    // like Google reCAPTCHA, hCaptcha, or generate a custom challenge
    return {
      type: 'text',
      question: 'What is 2 + 2?',
      // In production, this would be an image or reCAPTCHA token
      placeholder: 'Enter the answer to the math problem',
    };
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
   * Middleware for authentication endpoints
   */
  public authEndpointProtection = (
    req: AuthRateLimitRequest,
    res: Response,
    next: NextFunction,
  ): void => {
    // Apply both pre-auth check and post-auth recording
    this.preAuthCheck(req, res, (error) => {
      if (error) return next(error);
      
      this.postAuthRecord(req, res, next);
    });
  };

  /**
   * Admin endpoint to get authentication statistics
   */
  public getAuthStats = (req: Request, res: Response): void => {
    try {
      const stats = this.authRateLimit.getAuthStats();
      const lockedAccounts = this.authRateLimit.getLockedAccounts();
      const bannedIPs = this.authRateLimit.getBannedIPs();
      const suspiciousIPs = this.authRateLimit.getSuspiciousIPs();

      res.json({
        success: true,
        statistics: stats,
        security: {
          lockedAccounts: lockedAccounts.map(account => ({
            userId: account.userId,
            lockedAt: new Date(account.lockedAt).toISOString(),
            unlockAt: new Date(account.unlockAt).toISOString(),
            lockoutLevel: account.lockoutLevel,
            requiresAdminUnlock: account.requiresAdminUnlock,
          })),
          bannedIPs: bannedIPs.map(ban => ({
            ip: ban.ip,
            bannedAt: new Date(ban.bannedAt).toISOString(),
            unbanAt: new Date(ban.unbanAt).toISOString(),
            reason: ban.reason,
            severity: ban.severity,
          })),
          suspiciousIPs,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      try {
        this.logger.error('Error getting auth stats:', {
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        console.error('Error getting auth stats:', error);
      }
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve authentication statistics',
      });
    }
  };

  /**
   * Admin endpoint to unlock account
   */
  public unlockAccount = (req: Request, res: Response): void => {
    try {
      const { userId } = req.body;
      
      if (!userId) {
        res.status(400).json({
          success: false,
          error: 'User ID is required',
        });
        return;
      }

      const unlocked = this.authRateLimit.unlockAccount(userId);
      
      if (unlocked) {
        res.json({
          success: true,
          message: `Account ${userId} has been unlocked`,
          userId,
        });
      } else {
        res.status(404).json({
          success: false,
          error: 'Account not found or not locked',
          userId,
        });
      }
    } catch (error) {
      try {
        this.logger.error('Error unlocking account:', {
          error: error instanceof Error ? error.message : String(error),
          userId: req.body.userId,
        });
      } catch {
        console.error('Error unlocking account:', error);
      }
      res.status(500).json({
        success: false,
        error: 'Failed to unlock account',
      });
    }
  };

  /**
   * Admin endpoint to unban IP
   */
  public unbanIP = (req: Request, res: Response): void => {
    try {
      const { ip } = req.body;
      
      if (!ip) {
        res.status(400).json({
          success: false,
          error: 'IP address is required',
        });
        return;
      }

      const unbanned = this.authRateLimit.unbanIP(ip);
      
      if (unbanned) {
        res.json({
          success: true,
          message: `IP ${ip} has been unbanned`,
          ip,
        });
      } else {
        res.status(404).json({
          success: false,
          error: 'IP not found or not banned',
          ip,
        });
      }
    } catch (error) {
      try {
        this.logger.error('Error unbanning IP:', {
          error: error instanceof Error ? error.message : String(error),
          ip: req.body.ip,
        });
      } catch {
        console.error('Error unbanning IP:', error);
      }
      res.status(500).json({
        success: false,
        error: 'Failed to unban IP',
      });
    }
  };

  /**
   * Endpoint to verify CAPTCHA
   */
  public verifyCaptchaEndpoint = (req: Request, res: Response): void => {
    try {
      const { challengeId, solution } = req.body;
      
      if (!challengeId || !solution) {
        res.status(400).json({
          success: false,
          error: 'Challenge ID and solution are required',
        });
        return;
      }

      const verified = this.authRateLimit.verifyCaptchaChallenge(challengeId, solution);
      
      res.json({
        success: verified,
        message: verified ? 'CAPTCHA verified successfully' : 'CAPTCHA verification failed',
        challengeId,
      });
    } catch (error) {
      try {
        this.logger.error('Error verifying CAPTCHA:', {
          error: error instanceof Error ? error.message : String(error),
          challengeId: req.body.challengeId,
        });
      } catch {
        console.error('Error verifying CAPTCHA:', error);
      }
      res.status(500).json({
        success: false,
        error: 'Failed to verify CAPTCHA',
      });
    }
  };
}

/**
 * Factory function to create AuthRateLimitMiddleware with dependency injection
 */
export function createAuthRateLimitMiddleware(
  authRateLimit: AuthRateLimitService,
  securityLogger: SecurityLoggerService,
  logger: LoggerService,
): AuthRateLimitMiddleware {
  return new AuthRateLimitMiddleware(authRateLimit, securityLogger, logger);
}

/**
 * Factory functions for individual middleware methods
 */
export function createPreAuthCheck(
  authRateLimit: AuthRateLimitService,
  securityLogger: SecurityLoggerService,
  logger: LoggerService,
) {
  const middleware = new AuthRateLimitMiddleware(authRateLimit, securityLogger, logger);
  return middleware.preAuthCheck;
}

export function createPostAuthRecord(
  authRateLimit: AuthRateLimitService,
  securityLogger: SecurityLoggerService,
  logger: LoggerService,
) {
  const middleware = new AuthRateLimitMiddleware(authRateLimit, securityLogger, logger);
  return middleware.postAuthRecord;
}

// Legacy exports - throw errors to enforce new DI pattern
export const preAuthCheck = (() => {
  throw new Error('preAuthCheck: Use createPreAuthCheck factory function with explicit dependencies');
})();

export const postAuthRecord = (() => {
  throw new Error('postAuthRecord: Use createPostAuthRecord factory function with explicit dependencies');
})();

export const authEndpointProtection = (() => {
  throw new Error('authEndpointProtection: Use createAuthRateLimitMiddleware factory function with explicit dependencies');
})();

export const getAuthStats = (() => {
  throw new Error('getAuthStats: Use createAuthRateLimitMiddleware factory function with explicit dependencies');
})();

export const unlockAccount = (() => {
  throw new Error('unlockAccount: Use createAuthRateLimitMiddleware factory function with explicit dependencies');
})();

export const unbanIP = (() => {
  throw new Error('unbanIP: Use createAuthRateLimitMiddleware factory function with explicit dependencies');
})();

export const verifyCaptchaEndpoint = (() => {
  throw new Error('verifyCaptchaEndpoint: Use createAuthRateLimitMiddleware factory function with explicit dependencies');
})();