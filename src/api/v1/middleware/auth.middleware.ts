
/**
 * Enhanced authentication middleware with real Cognito validation
 * Supports multiple authentication strategies and AWS Cognito integration
 * 
 * Now uses type-safe request interfaces to eliminate (req as any) usage.
 * 
 * @see ../../../types/authenticated-request.types.ts
 * @see ../../../utils/auth-guards.ts
 */

import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest, OptionalAuthRequest } from '../../../types/authenticated-request.types';
import { CognitoService } from '../../../services/cognito.service';
import { SecurityLoggerService, SecurityEventType, SecurityEventSeverity } from '../../../services/securityLogger.service';
import { LoggerService } from '../../../services/logger.service';
import { UserRepository } from '../../../repositories/user.repository';

/**
 * Factory function to create authenticate middleware with dependency injection
 *
 *
 * Authentication Flow:
 * 1. Validate Cognito JWT → Extract sub (Cognito user ID)
 * 2. Look up internal User by cognitoSub → Get internal database user ID
 * 3. Set req.userId to internal database user ID (NOT Cognito sub)
 *
 * This ensures foreign key constraints work correctly for all user-related entities
 * (Consumption, Session, Purchase, etc.)
 */
export function createAuthenticate(
  cognitoService: CognitoService,
  userRepository: UserRepository,
  securityLoggerService: SecurityLoggerService,
  logger: LoggerService,
) {
  // Add initialization debugging
  console.log(' createAuthenticate called with services:', {
    cognitoService: !!cognitoService,
    userRepository: !!userRepository,
    securityLoggerService: !!securityLoggerService,
    logger: !!logger,
  });

  if (!cognitoService) {
    console.error(' CRITICAL: CognitoService is null/undefined in createAuthenticate!');
    throw new Error('CognitoService is required for authentication');
  }

  if (!userRepository) {
    console.error(' CRITICAL: UserRepository is null/undefined in createAuthenticate!');
    throw new Error('UserRepository is required for authentication');
  }

  if (!logger) {
    console.error(' CRITICAL: Logger is null/undefined in createAuthenticate!');
    throw new Error('Logger is required for authentication');
  }

  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    console.log(' MIDDLEWARE ENTRY POINT REACHED:', req.path, 'Method:', req.method);

  try {
    // Always log authentication attempts for production debugging
    console.log(' AUTHENTICATION MIDDLEWARE TRIGGERED:', req.path);
    logger.info('Authentication middleware triggered', {
      endpoint: req.path,
      method: req.method,
      USE_MOCK_COGNITO: process.env.USE_MOCK_COGNITO,
      NODE_ENV: process.env.NODE_ENV,
      hasAuthHeader: !!req.headers.authorization,
    });

    // Production authentication flow
    // Extract token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      securityLoggerService.logAuthenticationEvent(
        false,
        undefined,
        req.ip,
        req.get('User-Agent'),
        { endpoint: req.path, method: req.method, errorMessage: 'No authorization header provided' },
      );
      
      res.status(401).json({
        error: 'Authentication required',
        message: 'Please provide a valid authentication token',
      });
      return;
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    // Validate token with Cognito
    logger.info(' Validating JWT token with Cognito', {
      endpoint: req.path,
      tokenLength: token.length,
      tokenPrefix: token.substring(0, 30) + '...',
    });

    const validationResult = await cognitoService.validateToken(token);

    if (!validationResult.isValid) {
      // Enhanced error logging for production debugging
      logger.error(' JWT token validation failed', {
        endpoint: req.path,
        method: req.method,
        errorCode: validationResult.errorCode,
        errorMessage: validationResult.error,
        tokenPrefix: token.substring(0, 20) + '...',
        cognitoConfig: {
          userPoolId: process.env.COGNITO_USER_POOL_ID?.substring(0, 15) + '***',
          clientId: process.env.COGNITO_CLIENT_ID?.substring(0, 10) + '***',
          region: process.env.COGNITO_REGION,
        },
      });

      // Use enhanced token validation logging
      securityLoggerService.logTokenValidationEvent(
        false,
        'access', // More likely to be access token from mobile apps
        validationResult.errorCode,
        undefined,
        req.ip,
        req.get('User-Agent'),
        { 
          endpoint: req.path, 
          method: req.method, 
          errorMessage: validationResult.error || 'Token validation failed', 
        },
      );

      // Different responses based on error type
      switch (validationResult.errorCode) {
        case 'EXPIRED_TOKEN':
          res.status(401).json({
            error: 'Token expired',
            message: 'Your session has expired. Please sign in again.',
            code: 'TOKEN_EXPIRED',
          });
          break;
        case 'MALFORMED_TOKEN':
          res.status(400).json({
            error: 'Invalid token format',
            message: 'The provided token is malformed.',
            code: 'MALFORMED_TOKEN',
          });
          break;
        default:
          res.status(401).json({
            error: 'Authentication failed',
            message: 'Invalid authentication token.',
            code: 'INVALID_TOKEN',
          });
      }
      return;
    }

    // Token validation successful
    logger.info(' JWT token validation successful', {
      endpoint: req.path,
      cognitoSub: validationResult.user?.id,
      username: validationResult.user?.username,
    });

    // Cognito sub (validationResult.user.id) is NOT the same as PostgreSQL User.id
    // We must map Cognito sub → internal database user ID for foreign key constraints
    const cognitoSub = validationResult.user!.id;
    const internalUser = await userRepository.findByCognitoSub(cognitoSub);

    if (!internalUser) {
      logger.error(' User not found in internal database', {
        endpoint: req.path,
        cognitoSub,
        username: validationResult.user!.username,
        email: validationResult.user!.email,
      });

      securityLoggerService.logSecurityEvent(
        SecurityEventType.AUTHENTICATION_FAILURE,
        SecurityEventSeverity.HIGH,
        'User authenticated with Cognito but not found in internal database',
        {
          cognitoSub,
          username: validationResult.user!.username,
          endpoint: req.path,
          method: req.method,
        },
        { ip: req.ip, userAgent: req.get('User-Agent') },
      );

      res.status(403).json({
        error: 'User not found',
        message: 'Your account is not set up. Please contact support.',
        code: 'USER_NOT_FOUND',
      });
      return;
    }

    // Create enhanced user context with INTERNAL database user ID
    const userContext = {
      id: internalUser.id,
      email: validationResult.user!.email,
      username: validationResult.user!.username,
      isAuthenticated: true,
      roles: validationResult.user!.groups || [], // Map groups to roles
      tokenType: 'cognito' as const,
      emailVerified: validationResult.user!.emailVerified,
      expiresAt: validationResult.payload?.exp ? new Date(validationResult.payload.exp * 1000) : undefined,
    };

    // Attach to request with proper typing
    const typedReq = req as AuthenticatedRequest;
    typedReq.user = userContext;
    typedReq.userId = userContext.id;
    typedReq.userContext = userContext;

    logger.debug('User mapped from Cognito to internal database', {
      cognitoSub,
      internalUserId: internalUser.id,
      username: internalUser.username,
    });
    
    // Ensure requestId is set for tracing
    if (!typedReq.requestId) {
      typedReq.requestId = `auth-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    // Log successful token validation
    securityLoggerService.logTokenValidationEvent(
      true,
      'id', // Assume ID token for now
      undefined,
      userContext.id,
      req.ip,
      req.get('User-Agent'),
      { endpoint: req.path, method: req.method },
    );

    // Log successful authentication
    securityLoggerService.logAuthenticationEvent(
      true,
      userContext.id,
      req.ip,
      req.get('User-Agent'),
      { endpoint: req.path, method: req.method },
    );

    next();
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));

    securityLoggerService.logSecurityEvent(
      SecurityEventType.AUTHENTICATION_FAILURE,
      SecurityEventSeverity.HIGH,
      `Authentication middleware error: ${err.message}`,
      { endpoint: req.path, method: req.method, errorMessage: err.message },
      { ip: req.ip, userAgent: req.get('User-Agent') },
    );

    // Log error using injected logger
    logger.error('Authentication middleware error:', {
      error: err.message,
      stack: err.stack,
      endpoint: req.path,
      method: req.method,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
    });

    res.status(500).json({
      error: 'Authentication error',
      message: 'An error occurred during authentication. Please try again.',
    });
  }
  };
}

/**
 * Factory function to create optionalAuthenticate middleware with dependency injection
 *
 */
export function createOptionalAuthenticate(
  cognitoService: CognitoService,
  userRepository: UserRepository,
  securityLoggerService: SecurityLoggerService,
  logger: LoggerService,
) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
  const authHeader = req.headers.authorization;
  
  // If no token provided, continue without authentication
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    const typedReq = req as OptionalAuthRequest;
    typedReq.user = undefined;
    typedReq.userId = undefined;
    typedReq.userContext = undefined;
    
    // Ensure requestId is set
    if (!typedReq.requestId) {
      typedReq.requestId = `opt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
    
    return next();
  }

  // If token provided, validate it
  try {
    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    const validationResult = await cognitoService.validateToken(token);

    if (validationResult.isValid && validationResult.user) {
      const cognitoSub = validationResult.user.id;
      const internalUser = await userRepository.findByCognitoSub(cognitoSub);

      if (!internalUser) {
        // If user not found in database, continue without authentication
        // (Optional auth allows requests to proceed even if auth fails)
        logger.warn('User authenticated with Cognito but not found in internal database (optional auth)', {
          cognitoSub,
          username: validationResult.user.username,
        });

        const typedReq = req as OptionalAuthRequest;
        typedReq.user = undefined;
        typedReq.userId = undefined;
        typedReq.userContext = undefined;

        if (!typedReq.requestId) {
          typedReq.requestId = `opt-no-user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        }

        return next();
      }

      // Create user context with INTERNAL database user ID
      const userContext = {
        id: internalUser.id,
        email: validationResult.user.email,
        username: validationResult.user.username,
        isAuthenticated: true,
        roles: validationResult.user.groups || [],
        tokenType: 'cognito' as const,
        emailVerified: validationResult.user.emailVerified,
        expiresAt: validationResult.payload?.exp ? new Date(validationResult.payload.exp * 1000) : undefined,
      };

      const typedReq = req as OptionalAuthRequest;
      typedReq.user = userContext;
      typedReq.userId = userContext.id;
      typedReq.userContext = userContext;
      
      // Ensure requestId is set
      if (!typedReq.requestId) {
        typedReq.requestId = `opt-auth-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      }
    } else {
      // If validation fails, continue without authentication
      const typedReq = req as OptionalAuthRequest;
      typedReq.user = undefined;
      typedReq.userId = undefined;
      typedReq.userContext = undefined;
      
      // Ensure requestId is set
      if (!typedReq.requestId) {
        typedReq.requestId = `opt-fail-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      }
    }
    
    next();
  } catch (error) {
    // If validation fails, continue without authentication
    const typedReq = req as OptionalAuthRequest;
    typedReq.user = undefined;
    typedReq.userId = undefined;
    typedReq.userContext = undefined;
    
    // Ensure requestId is set
    if (!typedReq.requestId) {
      typedReq.requestId = `opt-err-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
    
    next();
  }
  };
}

/**
 * Factory function to create requireRoles middleware with dependency injection
 */
export function createRequireRoles(securityLoggerService: SecurityLoggerService, logger?: LoggerService) {
  return (requiredRoles: string[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const typedReq = req as AuthenticatedRequest;
    if (!typedReq.user || !typedReq.user.isAuthenticated) {
      res.status(401).json({
        error: 'Authentication required',
        message: 'You must be authenticated to access this resource.',
      });
      return;
    }

    const userRoles = typedReq.user.roles || [];
    const hasRequiredRole = requiredRoles.some(role => userRoles.includes(role));

    if (!hasRequiredRole) {
      securityLoggerService.logSecurityEvent(
        SecurityEventType.AUTHORIZATION_FAILURE,
        SecurityEventSeverity.MEDIUM,
        'Authorization failed: insufficient roles',
        { 
          endpoint: req.path, 
          method: req.method, 
          blockedReason: `Required roles: ${requiredRoles.join(', ')}`, 
        },
        { userId: typedReq.userId, ip: typedReq.ip, userAgent: typedReq.get('User-Agent') },
      );

      res.status(403).json({
        error: 'Insufficient permissions',
        message: 'You do not have the required permissions to access this resource.',
      });
      return;
    }

    next();
  };
  };
}

/**
 * Email verification requirement middleware (standalone - no DI needed)
 */
export const requireEmailVerified = (req: Request, res: Response, next: NextFunction): void => {
  const typedReq = req as AuthenticatedRequest;
  
  if (!typedReq.user || !typedReq.user.emailVerified) {
    res.status(403).json({
      error: 'Email not verified',
      message: 'Please verify your email address to access this resource.',
      code: 'EMAIL_NOT_VERIFIED',
    });
    return;
  }

  next();
};

// Legacy exports - DEPRECATED - Use factory functions above
export const authenticate = () => {
  throw new Error('DEPRECATED: Use createAuthenticate factory function with explicit dependencies');
};

export const optionalAuthenticate = () => {
  throw new Error('DEPRECATED: Use createOptionalAuthenticate factory function with explicit dependencies');
};

export const requireRoles = () => {
  throw new Error('DEPRECATED: Use createRequireRoles factory function with explicit dependencies');
};
