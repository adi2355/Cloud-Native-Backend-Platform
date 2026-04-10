/**
 * Optional Authentication Middleware
 * Allows both authenticated and unauthenticated access
 * Adds user context if valid JWT is present, otherwise continues without user
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AuthenticationService } from '../../../services/auth.service';
import { LoggerService } from '../../../services/logger.service';
import { UserContext, JWTPayload } from '../../../types/auth.types';

/**
 * Factory function to create optional authentication middleware with dependency injection
 */
export function createOptionalAuthenticate(
  authService: AuthenticationService,
  logger: LoggerService,
) {
  return async function optionalAuthenticate(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    
    // If no auth header, continue without user context
    if (!authHeader) {
      return next();
    }

    // Extract token
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.substring(7)
      : authHeader;

    if (!token) {
      return next();
    }

    // Verify token and add user context
    try {
      // Use extractUserContext if available, otherwise decode JWT directly
      const userContext = await authService.extractUserContext(token);

      if (userContext) {
        // User context successfully extracted from token
        req.user = userContext;
      } else {
        // Fallback: Direct JWT verification if extractUserContext returns null
        const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JWTPayload;

        // Add user context to request
        req.user = {
          id: decoded.sub,
          email: decoded.email,
          emailVerified: decoded.email_verified,
          username: decoded.username,
          groups: decoded['cognito:groups'],
          roles: decoded.roles || [],
          userType: decoded.userType,
          isAuthenticated: true,
          tokenType: 'cognito',
        } as UserContext;
      }

      // Add userId for compatibility with legacy code
      if (req.user) {
        (req as Request & { userId?: string }).userId = req.user.id;
      }
    } catch (error) {
      // Token invalid or expired - continue without user context
      logger.debug('Optional auth: Invalid token provided', { 
        context: 'optionalAuthenticate',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }

    next();
  } catch (error) {
    // Log unexpected errors but continue
    logger.error('Optional authenticate middleware error', { 
      context: 'optionalAuthenticate',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    next();
  }
  };
}

// Note: These exports are deprecated - middleware now requires dependency injection
export const optionalAuthenticate = (() => {
  throw new Error('optionalAuthenticate export is deprecated. Use createOptionalAuthenticate() factory function with dependency injection instead.');
})();

export default (() => {
  throw new Error('Default export is deprecated. Use createOptionalAuthenticate() factory function with dependency injection instead.');
})();