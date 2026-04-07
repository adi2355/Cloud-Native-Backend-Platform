import { Request, Response, NextFunction } from 'express';
import { getOptionalUser } from '../../../utils/auth-guards';
import { SecurityLoggerService, SecurityEventType, SecurityEventSeverity } from '../../../services/securityLogger.service';

interface SecurityLoggingRequest extends Request {
  securityContext?: {
    startTime: number;
    ip: string;
    userAgent?: string;
    userId?: string;
  };
}

export class SecurityLoggingMiddleware {
  private securityLogger: SecurityLoggerService;

  constructor(securityLogger: SecurityLoggerService) {
    this.securityLogger = securityLogger;
  }

  /**
   * Initialize security context for request
   */
  public initializeSecurityContext = (req: SecurityLoggingRequest, res: Response, next: NextFunction): void => {
    req.securityContext = {
      startTime: Date.now(),
      ip: this.getClientIP(req),
      userAgent: req.get('User-Agent'),
      userId: getOptionalUser(req)?.id,
    };

    // Log request initiation for high-risk endpoints
    if (this.isHighRiskEndpoint(req.path)) {
      this.securityLogger.logSecurityEvent(
        SecurityEventType.SUSPICIOUS_ACTIVITY,
        SecurityEventSeverity.MEDIUM,
        `Access attempt to high-risk endpoint: ${req.path}`,
        {
          endpoint: req.path,
          method: req.method,
        },
        {
          ip: req.securityContext.ip,
          userAgent: req.securityContext.userAgent,
          userId: req.securityContext.userId,
        },
      );
    }

    next();
  };

  /**
   * Log request completion
   */
  public logRequestCompletion = (req: SecurityLoggingRequest, res: Response, next: NextFunction): void => {
    const originalSend = res.send;
    const originalJson = res.json;

    res.send = function(body) {
      logResponse.call(this, body);
      return originalSend.call(this, body);
    };

    res.json = function(body) {
      logResponse.call(this, body);
      return originalJson.call(this, body);
    };

    const securityLogger = this.securityLogger;
    const securityContext = req.securityContext;

    function logResponse(body: unknown) {
      if (!securityContext) return;

      const responseTime = Date.now() - securityContext.startTime;
      const statusCode = res.statusCode;

      // Log based on status code
      if (statusCode >= 400) {
        let eventType: SecurityEventType;
        let severity: SecurityEventSeverity;

        if (statusCode === 401) {
          eventType = SecurityEventType.AUTHENTICATION_FAILURE;
          severity = SecurityEventSeverity.MEDIUM;
        } else if (statusCode === 403) {
          eventType = SecurityEventType.AUTHORIZATION_FAILURE;
          severity = SecurityEventSeverity.MEDIUM;
        } else if (statusCode === 429) {
          eventType = SecurityEventType.RATE_LIMIT_EXCEEDED;
          severity = SecurityEventSeverity.MEDIUM;
        } else if (statusCode >= 500) {
          eventType = SecurityEventType.INVALID_REQUEST;
          severity = SecurityEventSeverity.HIGH;
        } else {
          eventType = SecurityEventType.INVALID_REQUEST;
          severity = SecurityEventSeverity.LOW;
        }

        securityLogger.logSecurityEvent(
          eventType,
          severity,
          `Request failed with status ${statusCode}`,
          {
            endpoint: req.path,
            method: req.method,
            statusCode,
            responseTime,
          },
          {
            ip: securityContext.ip,
            userAgent: securityContext.userAgent,
            userId: securityContext.userId,
          },
        );
      }

      // Log successful authentication
      if (statusCode === 200 && req.path.includes('auth')) {
        securityLogger.logAuthenticationEvent(
          true,
          securityContext.userId,
          securityContext.ip,
          securityContext.userAgent,
          {
            endpoint: req.path,
            method: req.method,
            responseTime,
          },
        );
      }
    }

    next();
  };

  /**
   * Log malformed requests
   */
  public logMalformedRequest = (error: unknown, req: SecurityLoggingRequest, res: Response, next: NextFunction): void => {
    if (error instanceof SyntaxError && 'body' in error) {
      this.securityLogger.logSecurityEvent(
        SecurityEventType.MALFORMED_REQUEST,
        SecurityEventSeverity.MEDIUM,
        'Malformed JSON request body',
        {
          endpoint: req.path,
          method: req.method,
          errorMessage: error.message,
        },
        {
          ip: req.securityContext?.ip || this.getClientIP(req),
          userAgent: req.get('User-Agent'),
        },
      );
    }

    next(error);
  };

  /**
   * Log CORS violations
   */
  public logCorsViolation = (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.get('Origin');
    
    // This middleware would be called when CORS blocks a request
    if (origin && res.statusCode === 403) {
      this.securityLogger.logCorsViolation(
        origin,
        this.getClientIP(req),
        req.path,
        req.get('User-Agent'),
      );
    }

    next();
  };

  /**
   * Log suspicious request patterns
   */
  public detectSuspiciousPatterns = (req: SecurityLoggingRequest, res: Response, next: NextFunction): void => {
    const suspiciousIndicators = this.analyzeSuspiciousIndicators(req);
    
    if (suspiciousIndicators.length > 0) {
      this.securityLogger.logSuspiciousActivity(
        `Suspicious request patterns detected: ${suspiciousIndicators.join(', ')}`,
        req.securityContext?.ip || this.getClientIP(req),
        req.path,
        req.get('User-Agent'),
        { indicators: suspiciousIndicators },
      );
    }

    next();
  };

  /**
   * Analyze request for suspicious indicators
   */
  private analyzeSuspiciousIndicators(req: Request): string[] {
    const indicators: string[] = [];

    // Check for SQL injection patterns
    const sqlPatterns = [
      /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\b)/i,
      /(UNION\s+SELECT)/i,
      /(\bOR\s+1\s*=\s*1\b)/i,
      /(\bAND\s+1\s*=\s*1\b)/i,
    ];

    const requestString = JSON.stringify(req.query) + JSON.stringify(req.body) + req.url;
    
    sqlPatterns.forEach(pattern => {
      if (pattern.test(requestString)) {
        indicators.push('SQL_INJECTION_ATTEMPT');
      }
    });

    // Check for XSS patterns
    const xssPatterns = [
      /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
      /javascript:/i,
      /\bon\w+\s*=/i, // Word boundary ensures we only match "onclick=", not "on" in "consumptions"
    ];

    xssPatterns.forEach(pattern => {
      if (pattern.test(requestString)) {
        indicators.push('XSS_ATTEMPT');
      }
    });

    // Check for path traversal
    if (/\.\.\//.test(req.url) || /\.\.\\/.test(req.url)) {
      indicators.push('PATH_TRAVERSAL_ATTEMPT');
    }

    // Check for unusual request size
    const contentLength = parseInt(req.get('Content-Length') || '0', 10);
    if (contentLength > 10 * 1024 * 1024) { // 10MB
      indicators.push('UNUSUALLY_LARGE_REQUEST');
    }

    // Check for missing or suspicious User-Agent
    const userAgent = req.get('User-Agent');
    if (!userAgent || userAgent.length < 10) {
      indicators.push('SUSPICIOUS_USER_AGENT');
    }

    // Check for rapid requests from same IP (basic rate limiting detection)
    // This would require more sophisticated tracking in a real implementation

    return indicators;
  }

  /**
   * Check if endpoint is high-risk
   */
  private isHighRiskEndpoint(path: string): boolean {
    const highRiskPatterns = [
      /\/admin/,
      /\/config/,
      /\/secrets/,
      /\/debug/,
      /\/internal/,
    ];

    return highRiskPatterns.some(pattern => pattern.test(path));
  }

  /**
   * Get client IP address
   */
  private getClientIP(req: Request): string {
    return (
      req.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
      req.get('X-Real-IP') ||
      req.connection.remoteAddress ||
      req.socket.remoteAddress ||
      'unknown'
    );
  }
}

// Factory function to create SecurityLoggingMiddleware with explicit dependencies
export function createSecurityLoggingMiddleware(
  securityLogger: SecurityLoggerService,
): SecurityLoggingMiddleware {
  return new SecurityLoggingMiddleware(securityLogger);
}

// Factory functions for middleware creation with dependency injection
export function createInitializeSecurityContext(
  securityLogger: SecurityLoggerService,
): (req: SecurityLoggingRequest, res: Response, next: NextFunction) => void {
  const middleware = createSecurityLoggingMiddleware(securityLogger);
  return middleware.initializeSecurityContext;
}

export function createLogRequestCompletion(
  securityLogger: SecurityLoggerService,
): (req: SecurityLoggingRequest, res: Response, next: NextFunction) => void {
  const middleware = createSecurityLoggingMiddleware(securityLogger);
  return middleware.logRequestCompletion;
}

export function createLogMalformedRequest(
  securityLogger: SecurityLoggerService,
): (err: unknown, req: SecurityLoggingRequest, res: Response, next: NextFunction) => void {
  const middleware = createSecurityLoggingMiddleware(securityLogger);
  return middleware.logMalformedRequest;
}

export function createLogCorsViolation(
  securityLogger: SecurityLoggerService,
): (req: SecurityLoggingRequest, res: Response, next: NextFunction) => void {
  const middleware = createSecurityLoggingMiddleware(securityLogger);
  return middleware.logCorsViolation;
}

export function createDetectSuspiciousPatterns(
  securityLogger: SecurityLoggerService,
): (req: SecurityLoggingRequest, res: Response, next: NextFunction) => void {
  const middleware = createSecurityLoggingMiddleware(securityLogger);
  return middleware.detectSuspiciousPatterns;
}

// Legacy exports - DEPRECATED - Use factory functions above
export const initializeSecurityContext = (req: SecurityLoggingRequest, res: Response, next: NextFunction): void => {
  throw new Error('DEPRECATED: Use createInitializeSecurityContext factory function with explicit dependencies');
};

export const logRequestCompletion = (req: SecurityLoggingRequest, res: Response, next: NextFunction): void => {
  throw new Error('DEPRECATED: Use createLogRequestCompletion factory function with explicit dependencies');
};

export const logMalformedRequest = (err: unknown, req: SecurityLoggingRequest, res: Response, next: NextFunction): void => {
  throw new Error('DEPRECATED: Use createLogMalformedRequest factory function with explicit dependencies');
};

export const logCorsViolation = (req: SecurityLoggingRequest, res: Response, next: NextFunction): void => {
  throw new Error('DEPRECATED: Use createLogCorsViolation factory function with explicit dependencies');
};

export const detectSuspiciousPatterns = (req: SecurityLoggingRequest, res: Response, next: NextFunction): void => {
  throw new Error('DEPRECATED: Use createDetectSuspiciousPatterns factory function with explicit dependencies');
};

// Export factory function as default for DI
export { createSecurityLoggingMiddleware as default };