/**
 * User Context Middleware
 * Handles user context extraction and injection into requests
 */

import { Request, Response, NextFunction } from 'express';
import { AppError, ErrorCodes } from '../../../utils/AppError';
import { UserContextService } from '../../../services/userContext.service';
import { LoggerService } from '../../../services/logger.service';

// Removed global userContextService - now injected via factory functions

/**
 * Factory function to create user context injection middleware
 * Now accepts UserContextService as dependency (DI pattern)
 */
export const createInjectUserContext = (
  logger: LoggerService,
  userContextService: UserContextService,
) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = userContextService;
      const userContext = await service.extractFromRequest(req, {
        requireAuthentication: false,
        allowPlaceholder: false,
      });

      if (userContext) {
        req.user = userContext;

        // Log user context for debugging (sanitized)
        try {
          logger.info('User context injected', {
            userContext: service.sanitizeUserContext(userContext),
            timestamp: new Date().toISOString(),
          });
        } catch {
          console.log(' User context injected:', service.sanitizeUserContext(userContext));
        }
      }

      next();
    } catch (error) {
      try {
        // Use injected logger
        logger.error('Error injecting user context:', {
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        });
      } catch {
        console.error(' Error injecting user context:', error);
      }
      next(); // Continue without user context
    }
  };
};

/**
 * Factory function to create require user context middleware
 * Now accepts UserContextService as dependency (DI pattern)
 */
export const createRequireUserContext = (
  logger: LoggerService,
  userContextService: UserContextService,
) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
    const service = userContextService;
    
    if (!req.user) {
      const userContext = await service.extractFromRequest(req, {
        requireAuthentication: true,
        allowPlaceholder: false,
      });

      if (!userContext) {
        return next(new AppError(401, ErrorCodes.UNAUTHORIZED, 'User context required'));
      }

      req.user = userContext;
    }

    // Validate user context
    const validationResult = service.validateUserContext(req.user);
    if (!validationResult.isValid) {
      return next(new AppError(
        400, 
        ErrorCodes.VALIDATION_ERROR,
        `Invalid user context: ${validationResult.errors?.join(', ')}`,
      ));
    }

    next();
    } catch (error) {
      try {
        // Use injected logger
        logger.error('Error requiring user context:', {
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        });
      } catch {
        console.error(' Error requiring user context:', error);
      }
      next(new AppError(500, ErrorCodes.INTERNAL_SERVER_ERROR, 'Failed to validate user context'));
    }
  };
};

/**
 * Factory function to create require roles middleware
 * Now accepts UserContextService as dependency (DI pattern)
 */
export const createRequireRoles = (
  logger: LoggerService,
  userContextService: UserContextService,
) => {
  return (requiredRoles: string[]) => {
    return async (req: Request, res: Response, next: NextFunction) => {
      try{
      const service = userContextService;
      
      if (!req.user) {
        return next(new AppError(401, ErrorCodes.UNAUTHORIZED, 'Authentication required for role validation'));
      }

      const validationResult = service.validateUserContext(req.user, {
        validateRoles: requiredRoles,
      });

      if (!validationResult.isValid) {
        return next(new AppError(
          403, 
          ErrorCodes.FORBIDDEN,
          `Access denied: ${validationResult.errors?.join(', ')}`,
        ));
      }

        next();
      } catch (error) {
        try {
          logger.error('Error validating user roles:', {
            error: error instanceof Error ? error.message : String(error),
            requiredRoles,
            timestamp: new Date().toISOString(),
          });
        } catch {
          console.error(' Error validating user roles:', error);
        }
        next(new AppError(500, ErrorCodes.INTERNAL_SERVER_ERROR, 'Failed to validate user roles'));
      }
    };
  };
};

/**
 * Factory function to create validate user context middleware
 * Now accepts UserContextService as dependency (DI pattern)
 */
export const createValidateUserContext = (
  logger: LoggerService,
  userContextService: UserContextService,
) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = userContextService;

      if (req.user) {
        const validationResult = service.validateUserContext(req.user);

        if (!validationResult.isValid) {
          try {
            logger.warn('Invalid user context detected', {
              errors: validationResult.errors,
              timestamp: new Date().toISOString(),
            });
          } catch {
            console.warn(' Invalid user context detected:', validationResult.errors);
          }
          // Remove invalid user context
          delete req.user;
        }
      }

      next();
    } catch (error) {
      try {
        // Use injected logger
        logger.error('Error validating user context:', {
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        });
      } catch {
        console.error(' Error validating user context:', error);
      }
      next(); // Continue without blocking
    }
  };
};

/**
 * Factory function to create middleware for getting user context information
 * Now accepts UserContextService as dependency (DI pattern)
 */
export const createGetUserContextInfo = (userContextService: UserContextService) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const service = userContextService;
  const userInfo = req.user ? {
    context: service.sanitizeUserContext(req.user),
    validation: service.validateUserContext(req.user),
    displayName: service.getDisplayName(req.user),
    roles: req.user.roles || [],
    isExpired: service.isExpired(req.user),
  } : null;

    res.json({
      user: userInfo,
      hasContext: !!req.user,
      timestamp: new Date().toISOString(),
    });
  };
};

// Removed global userContextService export - use dependency injection instead