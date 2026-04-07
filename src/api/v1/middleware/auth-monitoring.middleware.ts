/**
 * Authentication Monitoring Middleware
 * Detects and logs potential authentication bypasses and suspicious patterns
 * 
 * Production-ready security monitoring following AppPlatform patterns
 * Integrates with existing logging and security services
 */

import { Request, Response, NextFunction } from 'express';
import { LoggerService, LogLevel, LogCategory } from '../../../services/logger.service';
import { SecurityLoggerService, SecurityEventType, SecurityEventSeverity } from '../../../services/securityLogger.service';
import { AuthRateLimitService } from '../../../services/authRateLimit.service';
import { getCorrelationContext } from './correlationContext.middleware';
import { AuthenticatedRequest } from '../../../types/authenticated-request.types';

// Security event types for monitoring
export enum AuthMonitoringEvent {
  AUTH_BYPASS_ATTEMPT = 'AUTH_BYPASS_ATTEMPT',
  MISSING_AUTH_HEADER = 'MISSING_AUTH_HEADER',
  INVALID_TOKEN_FORMAT = 'INVALID_TOKEN_FORMAT',
  EXPIRED_TOKEN_ACCESS = 'EXPIRED_TOKEN_ACCESS',
  SUSPICIOUS_PATTERN = 'SUSPICIOUS_PATTERN',
  REPEATED_AUTH_FAILURES = 'REPEATED_AUTH_FAILURES',
  PRIVILEGE_ESCALATION_ATTEMPT = 'PRIVILEGE_ESCALATION_ATTEMPT'
}

// Removed authFailureTracker - now using AuthRateLimitService for tracking

/**
 * Create Authentication Monitoring Middleware Factory
 * Tracks authentication patterns and detects potential security issues
 *
 * This middleware should be placed BEFORE the authenticate middleware
 * to detect bypass attempts and AFTER authenticate to verify success
 *
 * Now uses AuthRateLimitService for distributed-safe failure tracking
 */
export function createAuthMonitoring(
  logger: LoggerService,
  securityLogger: SecurityLoggerService,
  authRateLimitService: AuthRateLimitService,
) {
  return function authMonitoring(req: Request, res: Response, next: NextFunction) {
    const correlationContext = getCorrelationContext();
    const correlationId = correlationContext?.correlationId || 'unknown';
    const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';
    const path = req.path;
    const method = req.method;

    // Track request metadata
    const requestMetadata: Record<string, unknown> = {
      correlationId,
      clientIp,
      userAgent,
      path,
      method,
      timestamp: new Date().toISOString(),
    };

    // Helper function to log security events with injected dependencies
    const logSecurityEvent = (
      eventType: AuthMonitoringEvent,
      message: string,
      metadata: Record<string, unknown>,
    ) => {
      // Log to application logger
      logger.log(
        LogLevel.WARN,
        LogCategory.SECURITY,
        `[AUTH_MONITOR] ${message}`,
        {
          eventType,
          ...metadata,
        },
        String(metadata.correlationId),
      );

      // Log to security logger (SecurityMonitoringService will auto-generate alerts from these events)
      securityLogger.logSecurityEvent(
        mapAuthEventToSecurityEventType(eventType),
        getEventSeverity(eventType),
        message,
        {}, // SecurityEventDetails (empty for now, can be extended)
        {
          userId: String(metadata.userId || undefined),
          ip: String(metadata.clientIp || 'unknown'),
          userAgent: String(metadata.userAgent || undefined),
        },
        {
          ...metadata,
          authMonitoringEvent: eventType,
        },
      );
    };

    // Check for authentication bypass attempts on protected routes
    if (isProtectedRoute(path) && !hasAuthenticationHeader(req)) {
      logSecurityEvent(
        AuthMonitoringEvent.AUTH_BYPASS_ATTEMPT,
        'Attempt to access protected route without authentication',
        requestMetadata,
      );
    }

    // Track authentication failures using AuthRateLimitService
    const rateLimitCheck = authRateLimitService.checkAuthAttempt(
      clientIp,
      undefined, // userId not available yet
      userAgent,
      path,
    );

    // Log if there are repeated failures detected
    if (!rateLimitCheck.allowed && rateLimitCheck.reason === 'TOO_MANY_ATTEMPTS') {
      logSecurityEvent(
        AuthMonitoringEvent.REPEATED_AUTH_FAILURES,
        `Repeated authentication failures from IP: ${clientIp}`,
        {
          ...requestMetadata,
          reason: rateLimitCheck.reason,
          retryAfter: rateLimitCheck.retryAfter,
          requiresCaptcha: rateLimitCheck.requiresCaptcha,
        },
      );
    }

    // Monitor for suspicious patterns
    detectSuspiciousPatterns(req, requestMetadata, logSecurityEvent);

  // Add response interceptor to track authentication results
  const originalJson = res.json.bind(res);
  res.json = function(data: unknown) {
    // Check for authentication failure responses
    if (res.statusCode === 401 || res.statusCode === 403) {
      const failureType = res.statusCode === 401
        ? AuthMonitoringEvent.MISSING_AUTH_HEADER
        : AuthMonitoringEvent.PRIVILEGE_ESCALATION_ATTEMPT;

      // Extract error code safely from data
      const errorCode = typeof data === 'object' && data !== null && 'error' in data
        ? (data as Record<string, unknown>).error
        : undefined;
      const errorCodeValue = typeof errorCode === 'object' && errorCode !== null && 'code' in errorCode
        ? (errorCode as Record<string, unknown>).code
        : undefined;

      logSecurityEvent(
        failureType,
        `Authentication failure: ${res.statusCode}`,
        {
          ...requestMetadata,
          statusCode: res.statusCode,
          errorCode: errorCodeValue,
        },
      );

      // Record auth failure using AuthRateLimitService
      authRateLimitService.recordAuthAttempt(
        false, // success = false
        clientIp,
        undefined, // userId unknown at this point
        userAgent,
        req.path,
        typeof errorCodeValue === 'string' ? errorCodeValue : undefined,
      );
    }

    return originalJson(data);
  };

    next();
  };
}

/**
 * Create Post-Authentication Monitoring Middleware Factory
 * Verifies authentication was successful for protected routes
 *
 * This should be placed AFTER the authenticate middleware
 */
export function createPostAuthMonitoring(
  logger: LoggerService,
  securityLogger: SecurityLoggerService,
) {
  return function postAuthMonitoring(req: Request, res: Response, next: NextFunction) {
    const correlationContext = getCorrelationContext();
    const correlationId = correlationContext?.correlationId || 'unknown';
    const path = req.path;

    // Helper function to log security events with injected dependencies
    const logSecurityEvent = (
      eventType: AuthMonitoringEvent,
      message: string,
      metadata: Record<string, unknown>,
    ) => {
      // Log to application logger
      logger.log(
        LogLevel.WARN,
        LogCategory.SECURITY,
        `[AUTH_MONITOR] ${message}`,
        {
          eventType,
          ...metadata,
        },
        String(metadata.correlationId),
      );

      // Log to security logger (SecurityMonitoringService will auto-generate alerts from these events)
      securityLogger.logSecurityEvent(
        mapAuthEventToSecurityEventType(eventType),
        getEventSeverity(eventType),
        message,
        {}, // SecurityEventDetails (empty for now, can be extended)
        {
          userId: String(metadata.userId || undefined),
          ip: String(metadata.clientIp || 'unknown'),
          userAgent: String(metadata.userAgent || undefined),
        },
        {
          ...metadata,
          authMonitoringEvent: eventType,
        },
      );
    };
    
    // Verify authentication succeeded for protected routes
    if (isProtectedRoute(path)) {
      const authenticatedReq = req as AuthenticatedRequest;
      
      if (!authenticatedReq.user) {
        logSecurityEvent(
          AuthMonitoringEvent.AUTH_BYPASS_ATTEMPT,
          'Protected route accessed without user context after authentication',
          {
            correlationId,
            path,
            method: req.method,
            headers: Object.keys(req.headers),
          },
        );
      } else {
        // Log successful authentication for audit
        logger.log(
          LogLevel.DEBUG,
          LogCategory.SECURITY,
          'Authenticated request',
          {
            correlationId,
            userId: authenticatedReq.user.id,
            path,
            method: req.method,
          },
          correlationId,
          authenticatedReq.user.id,
        );
      }
    }

    next();
  };
}

/**
 * Check if route should be protected
 */
function isProtectedRoute(path: string): boolean {
  // Public routes that don't require authentication
  const publicPaths = [
    '/api/v1/auth/login',
    '/api/v1/auth/register',
    '/api/v1/auth/refresh',
    '/api/v1/auth/verify',
    '/api/v1/health',
    '/api/v1/status',
    '/api/v1/metrics',
  ];

  // Check if path is in public list
  if (publicPaths.some(publicPath => path.startsWith(publicPath))) {
    return false;
  }

  // All /api/v1/* routes should be protected by default
  return path.startsWith('/api/v1/');
}

/**
 * Check if request has authentication header
 */
function hasAuthenticationHeader(req: Request): boolean {
  const authHeader = req.headers.authorization;
  const cookieToken = req.cookies?.authToken;
  
  return !!(authHeader || cookieToken);
}

// Removed updateFailureTracker and cleanupFailureTracker functions
// Now using AuthRateLimitService.recordAuthAttempt() for distributed-safe tracking

/**
 * Detect suspicious authentication patterns
 */
function detectSuspiciousPatterns(
  req: Request,
  metadata: Record<string, unknown>,
  logSecurityEvent: (eventType: AuthMonitoringEvent, message: string, metadata: Record<string, unknown>) => void,
) {
  const authHeader = req.headers.authorization;

  // Check for malformed tokens
  if (authHeader && !authHeader.match(/^Bearer\s+[\w-]+\.[\w-]+\.[\w-]+$/)) {
    logSecurityEvent(
      AuthMonitoringEvent.INVALID_TOKEN_FORMAT,
      'Malformed authentication token detected',
      {
        ...metadata,
        tokenPrefix: authHeader.substring(0, 20),
      },
    );
  }

  // Check for SQL injection attempts in auth header
  if (authHeader && /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION)\b|[';])/i.test(authHeader)) {
    logSecurityEvent(
      AuthMonitoringEvent.SUSPICIOUS_PATTERN,
      'Potential SQL injection in authentication header',
      metadata,
    );
  }

  // Check for path traversal attempts
  if (req.path.includes('../') || req.path.includes('..\\')) {
    logSecurityEvent(
      AuthMonitoringEvent.SUSPICIOUS_PATTERN,
      'Path traversal attempt detected',
      metadata,
    );
  }
}


/**
 * Get severity level for security event
 */
function getEventSeverity(eventType: AuthMonitoringEvent): SecurityEventSeverity {
  switch (eventType) {
    case AuthMonitoringEvent.AUTH_BYPASS_ATTEMPT:
    case AuthMonitoringEvent.PRIVILEGE_ESCALATION_ATTEMPT:
      return SecurityEventSeverity.CRITICAL;
    case AuthMonitoringEvent.REPEATED_AUTH_FAILURES:
    case AuthMonitoringEvent.SUSPICIOUS_PATTERN:
      return SecurityEventSeverity.HIGH;
    case AuthMonitoringEvent.INVALID_TOKEN_FORMAT:
    case AuthMonitoringEvent.EXPIRED_TOKEN_ACCESS:
      return SecurityEventSeverity.MEDIUM;
    case AuthMonitoringEvent.MISSING_AUTH_HEADER:
    default:
      return SecurityEventSeverity.LOW;
  }
}

/**
 * Determine if event should trigger immediate alert
 * Note: This function is currently unused as SecurityMonitoringService auto-generates alerts
 */
// function shouldTriggerAlert(eventType: AuthMonitoringEvent): boolean {
//   return [
//     AuthMonitoringEvent.AUTH_BYPASS_ATTEMPT,
//     AuthMonitoringEvent.PRIVILEGE_ESCALATION_ATTEMPT,
//     AuthMonitoringEvent.REPEATED_AUTH_FAILURES,
//   ].includes(eventType);
// }

/**
 * Create Authentication Metrics Middleware Factory
 */
export function createAuthMetrics(
  logger: LoggerService,
) {
  return function authMetrics(req: Request, res: Response, next: NextFunction) {
    const startTime = Date.now();

    res.on('finish', () => {
      const duration = Date.now() - startTime;
      // Use type guard to safely check if user exists
      const authenticatedReq = req as Partial<AuthenticatedRequest>;
      const authenticated = !!authenticatedReq.user;

      // Log authentication metrics using logger
      logger.log(
        LogLevel.DEBUG,
        LogCategory.PERFORMANCE,
        'Authentication request metrics',
        {
          duration,
          authenticated,
          statusCode: res.statusCode,
          path: req.path,
          method: req.method,
        },
      );
    });

    next();
  };
}

/**
 * Map AuthMonitoringEvent to SecurityEventType
 * Translates auth-specific events to security logger event types
 */
function mapAuthEventToSecurityEventType(authEvent: AuthMonitoringEvent): SecurityEventType {
  switch (authEvent) {
    case AuthMonitoringEvent.AUTH_BYPASS_ATTEMPT:
      return SecurityEventType.AUTHENTICATION_FAILURE;
    case AuthMonitoringEvent.MISSING_AUTH_HEADER:
      return SecurityEventType.AUTHENTICATION_FAILURE;
    case AuthMonitoringEvent.INVALID_TOKEN_FORMAT:
      return SecurityEventType.TOKEN_VALIDATION_FAILURE;
    case AuthMonitoringEvent.EXPIRED_TOKEN_ACCESS:
      return SecurityEventType.TOKEN_VALIDATION_FAILURE;
    case AuthMonitoringEvent.SUSPICIOUS_PATTERN:
      return SecurityEventType.SUSPICIOUS_ACTIVITY;
    case AuthMonitoringEvent.REPEATED_AUTH_FAILURES:
      return SecurityEventType.AUTHENTICATION_FAILURE;
    case AuthMonitoringEvent.PRIVILEGE_ESCALATION_ATTEMPT:
      return SecurityEventType.AUTHORIZATION_FAILURE;
    default:
      return SecurityEventType.SUSPICIOUS_ACTIVITY;
  }
}

//  All exports now use factory functions with explicit dependency injection
// Legacy throwing exports removed - use createAuthMonitoring, createPostAuthMonitoring, createAuthMetrics