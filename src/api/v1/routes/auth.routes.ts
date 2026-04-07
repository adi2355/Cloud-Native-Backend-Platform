import { Router, Request, Response, RequestHandler } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/validation.middleware';
import { CognitoService } from '../../../services/cognito.service';
import { SecurityLoggerService, SecurityEventType, SecurityEventSeverity } from '../../../services/securityLogger.service';
import type { MiddlewareFactory } from '../../../core/middleware-factory';
import type { InitializedServices } from '../../../bootstrap';
import type { ControllerRegistry } from '../../../core/controller-registry';
import type { AuthenticatedRequest } from '../../../types/authenticated-request.types';

// Route services interface
export interface RouteServices {
  middlewareFactory: MiddlewareFactory;
  controllerRegistry: ControllerRegistry;
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
  registerAuthRoutes();
}

/**
 * Get AuthenticationService from injected services
 */
const getAuthenticationService = () => {
  if (!routeServices) {
    throw new Error('Route services not initialized');
  }
  return routeServices.services.authenticationService;
};

/**
 * Get rate limiter from MiddlewareFactory
 */
const getAuthRateLimit = (): RequestHandler => {
  if (!routeServices) {
    throw new Error('Route services not initialized');
  }
  return routeServices.middlewareFactory.getRateLimiter('auth');
};

/**
 * Get SecurityLoggerService from injected services
 */
const getSecurityLogger = () => {
  if (!routeServices) {
    throw new Error('Route services not initialized');
  }
  return routeServices.services.securityLoggerService;
};

/**
 * Get CognitoService from injected services
 */
const getCognitoService = () => {
  if (!routeServices) {
    throw new Error('Route services not initialized');
  }
  return routeServices.services.cognitoService;
};

/**
 * Get UserService from injected services
 */
const getUserService = () => {
  if (!routeServices) {
    throw new Error('Route services not initialized');
  }
  return routeServices.services.userService;
};

/**
 * Get validation middleware from MiddlewareFactory
 */
const getValidation = (schema: z.AnyZodObject) => {
  if (!routeServices) {
    throw new Error('Route services not initialized');
  }
  return routeServices.middlewareFactory.getValidation(schema);
};

/**
 * Get authentication middleware from MiddlewareFactory
 * Used for protected routes that require a valid JWT token
 */
const getAuthenticationMiddleware = (): RequestHandler => {
  if (!routeServices) {
    throw new Error('Route services not initialized');
  }
  return routeServices.middlewareFactory.getAuthentication();
};

// Validation schemas - Wrapped in 'body' to match MiddlewareFactory.getValidation() structure
const registerSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email format'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    name: z.string().min(1, 'Name is required'),
    givenName: z.string().optional(),
    familyName: z.string().optional(),
  })
});

const loginSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email format'),
    password: z.string().min(1, 'Password is required'),
  })
});

const googleTokenExchangeSchema = z.object({
  body: z.object({
    idToken: z.string().min(1, 'Google ID Token is required'),
    userInfo: z.object({
      id: z.string().optional(),
      email: z.string().email().optional(),
      name: z.string().optional(),
      givenName: z.string().optional(),
      familyName: z.string().optional(),
      photo: z.string().url().optional(),
    }).optional(),
  })
});

const refreshTokenSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(1, 'Refresh token is required'),
  })
});

/**
 * Register all auth routes after services are initialized
 */
function registerAuthRoutes() {
  // Clear any existing routes first
  router.stack.length = 0;

  /**
   * POST /api/v1/auth/register
   * Register a new user with email and password
   */
  router.post('/register',
  getAuthRateLimit(),
  getValidation(registerSchema),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { email, password, name, givenName, familyName } = req.body;
    const ip = req.ip || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    const requestId = req.headers['x-request-id'] || 'unknown';

    try {
      // Log registration attempt
      getSecurityLogger().logSecurityEvent(
        SecurityEventType.AUTHENTICATION_SUCCESS,
        SecurityEventSeverity.LOW,
        'User registration initiated',
        { endpoint: '/api/v1/auth/register', method: 'POST' },
        { ip, userAgent: userAgent.substring(0, 100) },
        { email, requestId },
      );

      // Check if user already exists in Cognito
      const cognitoService = getCognitoService();
      let existingUser;
      try {
        existingUser = await cognitoService.adminGetUser(email);
      } catch (error: unknown) {
        // Type-safe error handling - preserve AWS SDK error structure
        // AWS SDK errors have 'name' property directly on the error object
        const errorName = error instanceof Error ? error.name : '';
        const errorMessage = error instanceof Error ? error.message : String(error);

        // UserNotFoundException is expected when user doesn't exist - this is normal flow
        if (errorName !== 'UserNotFoundException') {
          getSecurityLogger().logSecurityEvent(
            SecurityEventType.AUTHENTICATION_FAILURE,
            SecurityEventSeverity.HIGH,
            'Unexpected error checking user existence in Cognito',
            { endpoint: '/api/v1/auth/register', method: 'POST', errorMessage },
            { ip, userAgent: userAgent.substring(0, 100) },
            { email, requestId, errorName }, // errorName in additionalDetails
          );
          throw error;
        }
        // If UserNotFoundException, user doesn't exist - continue with registration
      }

      if (existingUser) {
        res.status(409).json({
          success: false,
          error: {
            code: 'USER_EXISTS',
            message: 'An account with this email already exists',
            userMessage: 'An account with this email already exists'
          }
        });
        return;
      }

      // Create user in Cognito
      const { AdminCreateUserCommand, AdminSetUserPasswordCommand, MessageActionType } = await import('@aws-sdk/client-cognito-identity-provider');
      
      const createUserCommand = new AdminCreateUserCommand({
        UserPoolId: process.env.COGNITO_USER_POOL_ID,
        Username: email,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'false' },
          { Name: 'name', Value: name },
          { Name: 'given_name', Value: givenName || '' },
          { Name: 'family_name', Value: familyName || '' },
        ].filter(attr => attr.Value !== ''),
        TemporaryPassword: password,
        MessageAction: MessageActionType.SUPPRESS, // Don't send welcome email
      });

      if (!cognitoService.cognitoClient) {
        throw new Error('Cognito client not initialized');
      }
      
      const createResult = await cognitoService.cognitoClient.send(createUserCommand);
      
      // Set permanent password
      await cognitoService.cognitoClient.send(new AdminSetUserPasswordCommand({
        UserPoolId: process.env.COGNITO_USER_POOL_ID,
        Username: email,
        Password: password,
        Permanent: true,
      }));

      // Extract Cognito sub
      const cognitoSub = createResult.User?.Attributes?.find(attr => attr.Name === 'sub')?.Value;

      // Create user in database
      const { UserService } = await import('../../../services/user.service');
      const userService = getUserService();
      
      const dbUser = await userService.createUser({
        email,
        name,
        cognitoSub,
        emailVerified: false,
        authProvider: 'COGNITO',
        accountStatus: 'PENDING_VERIFICATION',
      });

      // Generate tokens
      const { AdminInitiateAuthCommand, AuthFlowType } = await import('@aws-sdk/client-cognito-identity-provider');
      const authCommand = new AdminInitiateAuthCommand({
        UserPoolId: process.env.COGNITO_USER_POOL_ID,
        ClientId: process.env.COGNITO_CLIENT_ID,
        AuthFlow: AuthFlowType.ADMIN_NO_SRP_AUTH,
        AuthParameters: {
          USERNAME: email,
          PASSWORD: password,
        },
      });

      const authResult = await cognitoService.cognitoClient.send(authCommand);

      if (!authResult.AuthenticationResult) {
        throw new Error('Failed to generate authentication tokens');
      }

      // Log successful registration
      getSecurityLogger().logSecurityEvent(
        SecurityEventType.AUTHENTICATION_SUCCESS,
        SecurityEventSeverity.LOW,
        'User registration successful',
        { endpoint: '/api/v1/auth/register', method: 'POST' },
        { userId: dbUser.id, ip, userAgent: userAgent.substring(0, 100) },
        { email, requestId },
      );

      res.status(201).json({
        success: true,
        data: {
          user: {
            id: dbUser.id,
            email: dbUser.email,
            name: dbUser.name,
            emailVerified: dbUser.emailVerified,
          },
          tokens: {
            idToken: authResult.AuthenticationResult.IdToken,
            accessToken: authResult.AuthenticationResult.AccessToken,
            refreshToken: authResult.AuthenticationResult.RefreshToken,
            expiresAt: Date.now() + ((authResult.AuthenticationResult.ExpiresIn || 3600) * 1000),
          },
        },
      });

    } catch (error: unknown) {
      // Type-safe error handling with proper type guards
      const err = error instanceof Error ? error : new Error(String(error));

      getSecurityLogger().logSecurityEvent(
        SecurityEventType.AUTHENTICATION_FAILURE,
        SecurityEventSeverity.HIGH,
        'User registration failed',
        { endpoint: '/api/v1/auth/register', method: 'POST', errorMessage: err.message },
        { ip, userAgent: userAgent.substring(0, 100) },
        { email, requestId },
      );

      if (err.name === 'UsernameExistsException') {
        res.status(409).json({
          success: false,
          error: {
            code: 'USER_EXISTS',
            message: 'An account with this email already exists',
            userMessage: 'An account with this email already exists'
          }
        });
      } else if (err.name === 'InvalidPasswordException') {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_PASSWORD',
            message: 'Password does not meet requirements',
            userMessage: 'Password does not meet requirements. Please use at least 8 characters with uppercase, lowercase, numbers, and special characters.'
          }
        });
      } else {
        res.status(500).json({
          success: false,
          error: {
            code: 'REGISTRATION_FAILED',
            message: 'Unable to complete registration',
            userMessage: 'Unable to complete registration. Please try again later.'
          }
        });
      }
    }
  }),
  );

  /**
   * POST /api/v1/auth/login
   * Login with email and password
   */
  router.post('/login',
  getAuthRateLimit(),
  getValidation(loginSchema),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { email, password } = req.body;
    const ip = req.ip || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    const requestId = req.headers['x-request-id'] || 'unknown';

    try {
      // Log login attempt
      getSecurityLogger().logSecurityEvent(
        SecurityEventType.AUTHENTICATION_SUCCESS,
        SecurityEventSeverity.LOW,
        'User login initiated',
        { endpoint: '/api/v1/auth/login', method: 'POST' },
        { ip, userAgent: userAgent.substring(0, 100) },
        { email, requestId },
      );

      const cognitoService = getCognitoService();
      const { AdminInitiateAuthCommand, AuthFlowType } = await import('@aws-sdk/client-cognito-identity-provider');
      
      const authCommand = new AdminInitiateAuthCommand({
        UserPoolId: process.env.COGNITO_USER_POOL_ID,
        ClientId: process.env.COGNITO_CLIENT_ID,
        AuthFlow: AuthFlowType.ADMIN_NO_SRP_AUTH,
        AuthParameters: {
          USERNAME: email,
          PASSWORD: password,
        },
      });

      if (!cognitoService.cognitoClient) {
        throw new Error('Cognito client not initialized');
      }
      
      const authResult = await cognitoService.cognitoClient.send(authCommand);

      if (!authResult.AuthenticationResult) {
        throw new Error('Authentication failed');
      }

      // Get user info from Cognito
      const cognitoUser = await cognitoService.getUserInfo(authResult.AuthenticationResult.AccessToken!);

      // Update last sign in
      const { UserService } = await import('../../../services/user.service');
      const userService = getUserService();
      
      const dbUser = await userService.findByEmailOrPhone(email, undefined);
      if (dbUser) {
        await userService.updateLastSignIn(dbUser.id);
      }

      // Log successful login
      getSecurityLogger().logSecurityEvent(
        SecurityEventType.AUTHENTICATION_SUCCESS,
        SecurityEventSeverity.LOW,
        'User login successful',
        { endpoint: '/api/v1/auth/login', method: 'POST' },
        { userId: cognitoUser.id, ip, userAgent: userAgent.substring(0, 100) },
        { email, requestId },
      );

      res.json({
        success: true,
        data: {
          user: {
            id: cognitoUser.id,
            email: cognitoUser.email,
            name: cognitoUser.name,
            emailVerified: cognitoUser.emailVerified,
          },
          tokens: {
            idToken: authResult.AuthenticationResult.IdToken,
            accessToken: authResult.AuthenticationResult.AccessToken,
            refreshToken: authResult.AuthenticationResult.RefreshToken,
            expiresAt: Date.now() + ((authResult.AuthenticationResult.ExpiresIn || 3600) * 1000),
          },
        },
      });

    } catch (error: unknown) {
      // Type-safe error handling with proper type guards
      const err = error instanceof Error ? error : new Error(String(error));

      getSecurityLogger().logSecurityEvent(
        SecurityEventType.AUTHENTICATION_FAILURE,
        SecurityEventSeverity.HIGH,
        'User login failed',
        { endpoint: '/api/v1/auth/login', method: 'POST', errorMessage: err.message },
        { ip, userAgent: userAgent.substring(0, 100) },
        { email, requestId },
      );

      if (err.name === 'NotAuthorizedException') {
        res.status(401).json({
          success: false,
          error: {
            code: 'INVALID_CREDENTIALS',
            message: 'Invalid email or password',
            userMessage: 'Invalid email or password'
          }
        });
      } else if (err.name === 'UserNotFoundException') {
        res.status(401).json({
          success: false,
          error: {
            code: 'INVALID_CREDENTIALS',
            message: 'Invalid email or password',
            userMessage: 'Invalid email or password'
          }
        });
      } else if (err.name === 'UserNotConfirmedException') {
        res.status(403).json({
          success: false,
          error: {
            code: 'EMAIL_NOT_VERIFIED',
            message: 'Please verify your email before logging in',
            userMessage: 'Please verify your email before logging in'
          }
        });
      } else {
        res.status(500).json({
          success: false,
          error: {
            code: 'LOGIN_FAILED',
            message: 'Unable to complete login',
            userMessage: 'Unable to complete login. Please try again later.'
          }
        });
      }
    }
  }),
  );

  /**
   * POST /api/v1/auth/google/exchange
   * Exchanges a Google ID Token for application (Cognito) tokens.
   * 
   * SECURITY REQUIREMENTS:
   * 1. Server-side validation of Google ID token
   * 2. Audience and issuer validation
   * 3. Signature verification using Google's public keys
   * 4. Rate limiting to prevent abuse
   * 5. Comprehensive security logging
   */
  router.post('/google/exchange',
  getAuthRateLimit(),
  getValidation(googleTokenExchangeSchema),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { idToken, userInfo } = req.body;
    const ip = req.ip || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    const requestId = req.headers['x-request-id'] || 'unknown';

    // Log authentication attempt
    getSecurityLogger().logSecurityEvent(
      SecurityEventType.AUTHENTICATION_SUCCESS, // Use closest available type
      SecurityEventSeverity.LOW,
      'Google OAuth token exchange initiated',
      {
        endpoint: '/api/v1/auth/google/exchange',
        method: 'POST',
      },
      {
        ip,
        userAgent: userAgent.substring(0, 100),
      },
      {
        email: userInfo?.email,
        requestId,
        provider: 'Google',
      },
    );

    try {
      // Use the singleton authentication service instance
      // Note: authenticationService must be initialized during server startup

      // validateGoogleIdToken now throws AppError on failure (never returns null)
      const authService = getAuthenticationService();
      const validatedTokenData = await authService.validateGoogleIdToken(idToken);

      // Use validated token data instead of client-provided userInfo
      const validatedUserInfo = {
        id: validatedTokenData.sub,
        email: validatedTokenData.email,
        name: validatedTokenData.name,
        givenName: validatedTokenData.given_name,
        familyName: validatedTokenData.family_name,
        photo: validatedTokenData.picture,
        emailVerified: validatedTokenData.email_verified,
      };

      // Perform federated sign-in with Cognito
      const federationResult = await authService.federatedSignIn(
        'Google',
        idToken,
        validatedUserInfo,
        validatedTokenData,
      );

      // Log successful authentication
      getSecurityLogger().logSecurityEvent(
        SecurityEventType.AUTHENTICATION_SUCCESS,
        SecurityEventSeverity.LOW,
        'Google OAuth token exchange successful',
        {
          endpoint: '/api/v1/auth/google/exchange',
          method: 'POST',
        },
        {
          userId: federationResult.user.id,
          ip,
          userAgent: userAgent.substring(0, 100),
        },
        {
          email: federationResult.user.email,
          provider: 'Google',
          requestId,
        },
      );

      // Return user and tokens
      res.json({
        success: true,
        data: {
          user: federationResult.user,
          tokens: federationResult.tokens,
        },
      });

    } catch (error: unknown) {
      // Type-safe error handling with proper type guards
      const err = error instanceof Error ? error : new Error(String(error));
      // Extract error code from AppError or legacy error objects
      const { AppError } = await import('../../../utils/AppError');
      const isAppError = error instanceof AppError;
      const errorCode = isAppError
        ? (error as InstanceType<typeof AppError>).errorCode
        : (error as { code?: string }).code;

      // Log authentication failure with error details
      getSecurityLogger().logSecurityEvent(
        SecurityEventType.AUTHENTICATION_FAILURE,
        SecurityEventSeverity.HIGH,
        'Google OAuth token exchange failed',
        {
          endpoint: '/api/v1/auth/google/exchange',
          method: 'POST',
          errorMessage: err.message,
          errorCode: errorCode || 'unknown',
        },
        {
          ip,
          userAgent: userAgent.substring(0, 100),
        },
        {
          email: userInfo?.email,
          requestId,
          stack: err.stack?.substring(0, 500),
        },
      );

      // Google token validation errors (specific codes from validateGoogleIdToken)
      if (isAppError && typeof errorCode === 'string' && errorCode.startsWith('GOOGLE_TOKEN_')) {
        const appErr = error as InstanceType<typeof AppError>;
        res.status(appErr.statusCode).json({
          success: false,
          error: {
            code: errorCode,
            message: appErr.message,
            userMessage: 'Google authentication failed. Please try signing in again.',
          }
        });
        return;
      }

      // Service not configured (503)
      if (errorCode === 'SERVICE_UNAVAILABLE') {
        res.status(503).json({
          success: false,
          error: {
            code: 'GOOGLE_SIGNIN_NOT_CONFIGURED',
            message: err.message || 'Google Sign-In is not configured',
            userMessage: 'Google Sign-In is not available at this time. Please use email and password to sign in, or contact support.',
          }
        });
        return;
      }

      // Cognito / external service errors
      if (errorCode === 'EXTERNAL_SERVICE_ERROR' || errorCode === 'COGNITO_ERROR') {
        res.status(500).json({
          success: false,
          error: {
            code: 'AUTHENTICATION_ERROR',
            message: err.message || 'Failed to authenticate with identity provider',
            userMessage: 'Authentication failed. Please try again. If the problem persists, contact support.',
          }
        });
        return;
      }

      // Legacy INVALID_GOOGLE_TOKEN code (backward compat)
      if (errorCode === 'INVALID_GOOGLE_TOKEN') {
        res.status(401).json({
          success: false,
          error: {
            code: 'INVALID_GOOGLE_TOKEN',
            message: 'Google ID token validation failed',
            userMessage: 'Google authentication failed. Please try again.',
          }
        });
        return;
      }

      // Generic error response for unexpected errors
      const statusCode = isAppError ? (error as InstanceType<typeof AppError>).statusCode : 500;
      res.status(statusCode).json({
        success: false,
        error: {
          code: errorCode || 'INTERNAL_ERROR',
          message: err.message || 'Authentication service temporarily unavailable',
          userMessage: 'Authentication service temporarily unavailable. Please try again later.',
        }
      });
    }
  }),
  );

  /**
   * POST /api/v1/auth/refresh
   * Refreshes authentication tokens using a valid refresh token
   */
  router.post('/refresh',
  getAuthRateLimit(),
  getValidation(refreshTokenSchema),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { refreshToken } = req.body;
    const ip = req.ip || 'unknown';
    const requestId = req.headers['x-request-id'] || 'unknown';

    try {
      const cognitoService = getCognitoService();
      const refreshResult = await cognitoService.refreshTokens(refreshToken);

      getSecurityLogger().logSecurityEvent(
        SecurityEventType.AUTHENTICATION_SUCCESS,
        SecurityEventSeverity.LOW,
        'Token refresh successful',
        {
          endpoint: '/api/v1/auth/refresh',
          method: 'POST',
        },
        {
          ip,
          userAgent: req.headers['user-agent']?.substring(0, 100) || 'unknown',
        },
        {
          requestId,
        },
      );

      res.json({
        success: true,
        data: {
          tokens: refreshResult.tokens,
        },
      });

    } catch (error: unknown) {
      // Type-safe error handling with proper type guards
      const err = error instanceof Error ? error : new Error(String(error));

      getSecurityLogger().logSecurityEvent(
        SecurityEventType.TOKEN_VALIDATION_FAILURE,
        SecurityEventSeverity.MEDIUM,
        'Token refresh failed',
        {
          endpoint: '/api/v1/auth/refresh',
          method: 'POST',
          errorMessage: err.message,
        },
        {
          ip,
          userAgent: req.headers['user-agent']?.substring(0, 100) || 'unknown',
        },
        {
          requestId,
        },
      );

      res.status(401).json({
        success: false,
        error: {
          code: 'REFRESH_FAILED',
          message: 'Unable to refresh authentication tokens',
          userMessage: 'Your session has expired. Please sign in again.'
        }
      });
    }
  }),
  );

  /**
   * POST /api/v1/auth/logout
   * Revokes all tokens for the authenticated user
   */
  router.post('/logout',
  // Note: Would need authentication middleware here to validate current token
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    const ip = req.ip || 'unknown';
    const requestId = req.headers['x-request-id'] || 'unknown';

    if (!accessToken) {
      res.status(401).json({
        success: false,
        error: {
          code: 'NO_TOKEN',
          message: 'Access token required for logout',
          userMessage: 'Authentication required'
        }
      });
      return;
    }

    try {
      const cognitoService = getCognitoService();
      await cognitoService.globalSignOut(accessToken);

      getSecurityLogger().logSecurityEvent(
        SecurityEventType.AUTHENTICATION_SUCCESS,
        SecurityEventSeverity.LOW,
        'User logout successful',
        {
          endpoint: '/api/v1/auth/logout',
          method: 'POST',
        },
        {
          ip,
          userAgent: req.headers['user-agent']?.substring(0, 100) || 'unknown',
        },
        {
          requestId,
        },
      );

      res.json({
        success: true,
        message: 'Logout successful',
      });

    } catch (error: unknown) {
      // Type-safe error handling with proper type guards
      const err = error instanceof Error ? error : new Error(String(error));

      getSecurityLogger().logSecurityEvent(
        SecurityEventType.AUTHENTICATION_FAILURE,
        SecurityEventSeverity.MEDIUM,
        'Logout failed',
        {
          endpoint: '/api/v1/auth/logout',
          method: 'POST',
          errorMessage: err.message,
        },
        {
          ip,
          userAgent: req.headers['user-agent']?.substring(0, 100) || 'unknown',
        },
        {
          requestId,
        },
      );

      res.status(500).json({
        success: false,
        error: {
          code: 'LOGOUT_FAILED',
          message: 'Unable to complete logout',
          userMessage: 'Unable to complete logout. Please try again.'
        }
      });
    }
  }),
  );

  /**
   * GET /api/v1/auth/status
   * Returns authentication status and user information
   *
   * FIX: Now uses authentication middleware to validate the JWT token (ID token)
   * instead of manually calling cognitoService.getUserInfo() which requires an
   * Access token. The middleware validates the ID token and populates req.user.
   */
  router.get('/status',
    getAuthRateLimit(),
    getAuthenticationMiddleware(),
    asyncHandler(async (req: Request, res: Response): Promise<void> => {
      // After authentication middleware, req.user is guaranteed to be populated
      const authReq = req as AuthenticatedRequest;

      // Return user context from the validated token
      // The authentication middleware already validated the JWT and extracted user info
      res.json({
        success: true,
        data: {
          user: {
            id: authReq.user.id,
            email: authReq.user.email,
            emailVerified: authReq.user.emailVerified,
            username: authReq.user.username,
            groups: authReq.user.groups,
            roles: authReq.user.roles,
            permissions: authReq.user.permissions,
            userType: authReq.user.userType,
          },
          authenticated: true,
        },
      });
    }),
  );
}

export default router;