/**
 * Authentication Type Guards and Safe Accessors
 * 
 * Provides runtime type checking and safe property access for authenticated requests.
 * Eliminates unsafe type assertions and provides clear error messages for debugging.
 * 
 * @see ../types/authenticated-request.types.ts
 * @see ../api/v1/middleware/auth.middleware.ts
 */

import { Request } from 'express';
import { Server } from 'socket.io';
import {
  AuthenticatedRequest,
  OptionalAuthRequest,
  AdminRequest,
  WebSocketRequest,
} from '../types/authenticated-request.types';
import { UserContext } from '../types/auth.types';
import { LoggerService } from '../services/logger.service';
import { AppError } from './AppError';

/**
 * Type guard to check if request has authenticated user context
 * @param req Express request object
 * @returns Type predicate for AuthenticatedRequest
 */
export function isAuthenticated(req: Request): req is AuthenticatedRequest {
  const typedReq = req as AuthenticatedRequest;
  return !!typedReq.user && 
         typeof typedReq.user === 'object' && 
         typeof typedReq.user.id === 'string' &&
         typedReq.user.isAuthenticated === true;
}

/**
 * Type guard to check if request has optional authentication
 * @param req Express request object  
 * @returns Type predicate for OptionalAuthRequest
 */
export function hasOptionalAuth(req: Request): req is OptionalAuthRequest {
  // Always returns true since OptionalAuthRequest extends Request with optional properties
  return true;
}

/**
 * Type guard to check if request has admin privileges
 * @param req Express request object
 * @returns Type predicate for AdminRequest
 */
export function isAdminRequest(req: Request): req is AdminRequest {
  if (!isAuthenticated(req)) return false;
  
  const user = (req as AuthenticatedRequest).user;
  return !!(user.roles?.includes('admin') || 
           user.groups?.includes('admin') ||
           user.userType === 'ADMIN');
}

/**
 * Type guard to check if request has WebSocket support
 * @param req Express request object
 * @returns Type predicate for WebSocketRequest
 */
export function hasWebSocket(req: Request): req is WebSocketRequest {
  return isAuthenticated(req) && !!(req as AuthenticatedRequest).io;
}

/**
 * Assertion function that throws if request is not authenticated
 * @param req Express request object
 * @throws AppError if not authenticated
 */
export function assertAuthenticated(req: Request): asserts req is AuthenticatedRequest {
  if (!isAuthenticated(req)) {
    throw AppError.unauthorized(
      'Request must be authenticated. Ensure authenticate middleware is applied.',
    );
  }
}

/**
 * Assertion function that throws if request doesn't have admin privileges
 * @param req Express request object
 * @throws AppError if not admin
 */
export function assertAdmin(req: Request): asserts req is AdminRequest {
  assertAuthenticated(req);
  
  if (!isAdminRequest(req)) {
    throw AppError.forbidden(
      'Admin privileges required for this operation',
    );
  }
}

/**
 * Safely gets user ID from request with clear error messaging
 * @param req Express request object
 * @returns User ID string
 * @throws AppError if user ID not available
 */
export function getUserId(req: Request): string {
  assertAuthenticated(req);

  // After assertAuthenticated, req.user.id is guaranteed to exist
  const userId = req.user.id;
  if (!userId) {
    throw AppError.internal(
      'User ID missing from authenticated request. Check authentication middleware.',
    );
  }

  return userId;
}

/**
 * Safely gets user context from request
 * @param req Express request object  
 * @returns UserContext object
 * @throws AppError if user context not available
 */
export function getUser(req: Request): UserContext {
  assertAuthenticated(req);
  
  if (!req.user) {
    throw AppError.internal(
      'User context missing from authenticated request. Check authentication middleware.',
    );
  }
  
  return req.user;
}

/**
 * Safely gets optional user context (may be null/undefined)
 * @param req Express request object
 * @returns UserContext or undefined
 */
export function getOptionalUser(req: Request): UserContext | undefined {
  const optReq = req as OptionalAuthRequest;
  return optReq.user;
}

/**
 * Safely gets optional user ID (may be null/undefined)
 * Convenience function for mixed authentication routes where only user ID is needed
 * @param req Express request object
 * @returns User ID string or undefined if not authenticated
 */
export function getOptionalUserId(req: Request): string | undefined {
  const user = getOptionalUser(req);
  return user?.id;
}

/**
 * Safely gets request ID with fallback generation
 * @param req Express request object
 * @param logger Optional logger service for structured logging
 * @returns Request ID string
 */
export function getRequestId(req: Request, logger?: LoggerService): string {
  const requestId = (req as AuthenticatedRequest).requestId || (req as AuthenticatedRequest).correlationId;

  if (!requestId) {
    // Generate fallback request ID if not set by middleware
    const fallbackId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    // Use provided logger for structured logging, with fallback to console for critical cases
    try {
      if (logger) {
        logger.warn('Request ID missing, using fallback', { fallbackId });
      } else {
        console.warn(`Request ID missing, using fallback: ${fallbackId}`);
      }
    } catch {
      console.warn(`Request ID missing, using fallback: ${fallbackId}`); // Fallback for early initialization
    }
    return fallbackId;
  }

  return requestId;
}

/**
 * Safely gets correlation ID for distributed tracing
 * @param req Express request object
 * @returns Correlation ID or undefined
 */
export function getCorrelationId(req: Request): string | undefined {
  return (req as AuthenticatedRequest).correlationId;
}

/**
 * Safely gets Socket.io instance for real-time operations
 * @param req Express request object
 * @returns Socket.io instance
 * @throws AppError if WebSocket not available
 */
export function getSocketIO(req: Request): Server {
  if (!hasWebSocket(req)) {
    throw AppError.internal(
      'WebSocket not available on this request. Ensure socket.io middleware is applied.',
    );
  }

  return req.io;
}

/**
 * Gets user roles for authorization checks
 * @param req Express request object
 * @returns Array of user roles
 */
export function getUserRoles(req: Request): string[] {
  const user = getOptionalUser(req);
  if (!user) return [];
  
  return user.roles || user.groups || [];
}

/**
 * Checks if user has specific role
 * @param req Express request object
 * @param role Role to check
 * @returns True if user has role
 */
export function hasRole(req: Request, role: string): boolean {
  const roles = getUserRoles(req);
  return roles.includes(role);
}

/**
 * Checks if user has any of the specified roles
 * @param req Express request object
 * @param roles Array of roles to check
 * @returns True if user has at least one role
 */
export function hasAnyRole(req: Request, roles: string[]): boolean {
  const userRoles = getUserRoles(req);
  return roles.some(role => userRoles.includes(role));
}

/**
 * Safely gets device ID from request
 * @param req Express request object
 * @returns Device ID or undefined
 */
export function getDeviceId(req: Request): string | undefined {
  return (req as AuthenticatedRequest).deviceId;
}

/**
 * Safely gets session ID from request
 * @param req Express request object
 * @returns Session ID or undefined
 */
export function getSessionId(req: Request): string | undefined {
  const typedReq = req as AuthenticatedRequest;
  // Express session uses 'sessionID' property, check it safely
  const reqWithSession = req as AuthenticatedRequest & { sessionID?: string };
  return typedReq.sessionId || reqWithSession.sessionID;
}

/**
 * Safely gets route parameter with validation
 * @param req Express request object
 * @param paramName Parameter name to extract
 * @returns Parameter value
 * @throws AppError if parameter is missing
 */
export function getRouteParam(req: Request, paramName: string): string {
  const value = req.params[paramName];
  if (!value) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `Route parameter '${paramName}' is required`,
      true
    );
  }
  return value as string;
}

/**
 * Development helper: logs request properties for debugging
 * Only active in development mode
 * @param req Express request object
 * @param logger Optional logger service for structured logging
 */
export function debugRequest(req: Request, logger?: LoggerService): void {
  if (process.env.NODE_ENV === 'development') {
    const typedReq = req as AuthenticatedRequest;
    try {
      if (logger) {
        logger.debug('Request Debug Info:', {
          hasUser: !!(typedReq.user),
          userId: typedReq.user?.id,
          requestId: typedReq.requestId,
          correlationId: typedReq.correlationId,
          isAuthenticated: isAuthenticated(req),
          hasWebSocket: hasWebSocket(req),
          roles: getUserRoles(req),
        });
      } else {
        // Fallback to console in case LoggerService is not available
        console.debug('Request Debug Info:', {
          hasUser: !!(typedReq.user),
          userId: typedReq.user?.id,
          requestId: typedReq.requestId,
          correlationId: typedReq.correlationId,
          isAuthenticated: isAuthenticated(req),
          hasWebSocket: hasWebSocket(req),
          roles: getUserRoles(req),
        });
      }
    } catch {
      // Fallback to console in case LoggerService is not available
      console.debug('Request Debug Info:', {
        hasUser: !!(typedReq.user),
        userId: typedReq.user?.id,
        requestId: typedReq.requestId,
        correlationId: typedReq.correlationId,
        isAuthenticated: isAuthenticated(req),
        hasWebSocket: hasWebSocket(req),
        roles: getUserRoles(req),
      });
    }
  }
}