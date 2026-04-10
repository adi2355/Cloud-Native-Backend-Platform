/**
 * Authorization Middleware
 * Role-based access control for protected routes
 * 
 * Production-ready middleware following AppPlatform patterns
 */

import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../../utils/AppError';
import { LoggerService } from '../../../services/logger.service';
import { UserContext } from '../../../types/auth.types';

export interface AuthorizedRequest extends Request {
  user?: UserContext;
}

/**
 * Creates an authorization middleware that checks for required roles
 * @param requiredRoles Array of roles that are allowed access
 * @param logger Logger service instance for dependency injection
 * @returns Express middleware function
 */
export function authorize(requiredRoles: string[] = [], logger: LoggerService) {
  
  return (req: AuthorizedRequest, res: Response, next: NextFunction): void => {
    try {
      // Check if user is authenticated
      if (!req.user) {
        throw AppError.unauthorized('User not authenticated');
      }

      // If no specific roles required, allow any authenticated user
      if (requiredRoles.length === 0) {
        return next();
      }

      // Get user roles (default to 'user' if not set)
      const userRoles = req.user.roles || ['user'];

      // Check if user has at least one required role
      const hasRequiredRole = requiredRoles.some(role => userRoles.includes(role));

      if (!hasRequiredRole) {
        logger.warn('Authorization failed - insufficient permissions', {
          context: 'AuthorizationMiddleware',
          userId: req.user.id,
          requiredRoles,
          userRoles,
          path: req.path,
          method: req.method,
        });

        throw AppError.forbidden('Insufficient permissions');
      }

      // User is authorized
      logger.debug('Authorization successful', {
        context: 'AuthorizationMiddleware',
        userId: req.user.id,
        requiredRoles,
        userRoles,
      });

      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Creates an authorization middleware that checks for required permissions
 * @param requiredPermissions Array of permissions that are required
 * @param logger Logger service instance for dependency injection
 * @returns Express middleware function
 */
export function authorizePermissions(requiredPermissions: string[] = [], logger: LoggerService) {
  
  return (req: AuthorizedRequest, res: Response, next: NextFunction): void => {
    try {
      // Check if user is authenticated
      if (!req.user) {
        throw AppError.unauthorized('User not authenticated');
      }

      // If no specific permissions required, allow any authenticated user
      if (requiredPermissions.length === 0) {
        return next();
      }

      // Get user permissions
      const userPermissions = req.user.permissions || [];

      // Check if user has all required permissions
      const hasAllPermissions = requiredPermissions.every(permission => 
        userPermissions.includes(permission),
      );

      if (!hasAllPermissions) {
        logger.warn('Authorization failed - missing permissions', {
          context: 'AuthorizationMiddleware',
          userId: req.user.id,
          requiredPermissions,
          userPermissions,
          path: req.path,
          method: req.method,
        });

        throw AppError.forbidden('Missing required permissions');
      }

      // User is authorized
      logger.debug('Permission check successful', {
        context: 'AuthorizationMiddleware',
        userId: req.user.id,
        requiredPermissions,
        userPermissions,
      });

      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Middleware to check if user owns the resource
 * @param getUserId Function to extract user ID from request params
 * @param logger Logger service instance for dependency injection
 * @returns Express middleware function
 */
export function authorizeOwnership(getUserId: (req: Request) => string, logger: LoggerService) {
  
  return (req: AuthorizedRequest, res: Response, next: NextFunction): void => {
    try {
      // Check if user is authenticated
      if (!req.user) {
        throw AppError.unauthorized('User not authenticated');
      }

      // Get the resource owner ID
      const resourceOwnerId = getUserId(req);

      // Check if user is admin (admins can access any resource)
      const isAdmin = req.user.roles?.includes('admin') || false;

      // Check if user owns the resource
      const isOwner = req.user.id === resourceOwnerId;

      if (!isOwner && !isAdmin) {
        logger.warn('Authorization failed - not resource owner', {
          context: 'AuthorizationMiddleware',
          userId: req.user.id,
          resourceOwnerId,
          path: req.path,
          method: req.method,
        });

        throw AppError.forbidden('Access denied to this resource');
      }

      // User is authorized
      logger.debug('Ownership check successful', {
        context: 'AuthorizationMiddleware',
        userId: req.user.id,
        resourceOwnerId,
        isAdmin,
        isOwner,
      });

      next();
    } catch (error) {
      next(error);
    }
  };
}

// Export factory functions for common role checks with dependency injection
export const createRequireAdmin = (logger: LoggerService) => authorize(['admin'], logger);
export const createRequirePremium = (logger: LoggerService) => authorize(['premium', 'admin'], logger);
export const createRequireModerator = (logger: LoggerService) => authorize(['moderator', 'admin'], logger);
export const createRequireUser = (logger: LoggerService) => authorize(['user', 'premium', 'moderator', 'admin'], logger);