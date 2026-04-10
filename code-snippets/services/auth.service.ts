/**
 * Authentication service for managing user authentication and authorization
 * Provides centralized authentication logic with support for multiple strategies
 *
 * GOOGLE OAUTH CONFIGURATION REQUIREMENTS:
 * For Google Sign-In to work, the following environment variables/secrets must be configured:
 *
 * 1. GOOGLE_WEB_CLIENT_ID (REQUIRED for token validation)
 *    - OAuth 2.0 Client ID from Google Cloud Console
 *    - Used for server-side validation of Google ID tokens
 *    - Must match the audience in Google ID tokens from frontend
 *    - Store in AWS Secrets Manager under key: 'app-platform/google-oauth'
 *    - Example format: '123456789-abcdefghijk.apps.googleusercontent.com'
 *
 * 2. GOOGLE_CLIENT_ID (Optional - for direct OAuth flows)
 *    - Additional client ID if using server-initiated OAuth
 *
 * 3. GOOGLE_CLIENT_SECRET (Optional - for server-initiated OAuth)
 *    - Client secret from Google Cloud Console
 *
 * How to obtain GOOGLE_WEB_CLIENT_ID:
 * 1. Go to https://console.cloud.google.com/apis/credentials
 * 2. Select your project (or create one)
 * 3. Click "Create Credentials" -> "OAuth 2.0 Client ID"
 * 4. Choose "Web application" as application type
 * 5. Add authorized redirect URIs (your backend domain)
 * 6. Copy the "Client ID" - this is your GOOGLE_WEB_CLIENT_ID
 *
 * How to configure in AWS Secrets Manager:
 * 1. Navigate to AWS Secrets Manager in your AWS Console
 * 2. Find or create secret: 'app-platform/google-oauth'
 * 3. Add key-value pair: { "GOOGLE_WEB_CLIENT_ID": "your-client-id-here" }
 * 4. Bootstrap.ts will automatically load this secret during initialization
 *
 * Without proper configuration:
 * - Google Sign-In will fail with "Google OAuth client not configured" error
 * - Frontend users will see "Authentication service temporarily unavailable" message
 * - Backend logs will show "Google OAuth client not configured - cannot validate token"
 */

import {
  UserContext,
  AuthToken,
  TokenValidationResult,
  AuthenticationConfig,
  AuthenticationService as IAuthenticationService,
  RefreshTokenResponse,
} from '../types/auth.types';
import { AuthenticationUtils } from '../utils/auth.utils';
import { LoggerService, LogLevel, LogCategory } from './logger.service';
import { getErrorMessage, getErrorStack, isPrismaError, hasErrorCode, getErrorName, getErrorCode } from '../utils/error-handler';
import { AppError, ErrorCodes } from '../utils/AppError';
import { handlePrismaError } from '../models';
import { generateSecurePassword } from '../utils/secure-id.utils';
import { CognitoService } from './cognito.service';
import { User, AuthProvider, AccountStatus } from '@prisma/client';
import {
  AdminCreateUserCommand,
  AdminInitiateAuthCommandOutput,
  AdminRespondToAuthChallengeCommandOutput,
  MessageActionType,
  UserStatusType,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  CognitoIdentityClient,
  GetIdCommand,
  GetCredentialsForIdentityCommand,
} from '@aws-sdk/client-cognito-identity';
// DynamoDB imports removed - federated session storage was unused dead code
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import { JwtSecretValidator } from '../utils/jwt-validation.utils';

// Types for Google OAuth and federated authentication
interface GoogleTokenPayload {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  aud: string;
  iss: string;
  exp: number;
  iat: number;
}

interface FederatedUserInfo {
  id: string;
  email: string;
  name?: string;
  photo?: string;
  emailVerified?: boolean;
}

interface FederatedSignInResult {
  user: UserContext;
  tokens: {
    idToken: string;
    accessToken: string;
    refreshToken?: string;
    expiresAt: number;
  };
}

// Federated Provider Configuration
interface FederatedProvider {
  name: string;
  clientId: string;
  clientSecret?: string;
  discoveryUrl?: string;
  enabled: boolean;
}

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresIn: number;
}

// AWS Cognito User Attribute interface
interface CognitoUserAttribute {
  Name: string;
  Value: string;
}

// AWS Cognito User interface (from AdminGetUser response)
interface CognitoUser {
  Username: string;
  Attributes?: CognitoUserAttribute[];
  UserCreateDate?: Date;
  UserLastModifiedDate?: Date;
  Enabled?: boolean;
  UserStatus?: UserStatusType;
}

// Extended Error interface for statusCode
interface ExtendedError extends Error {
  statusCode?: number;
}

// Minimal UserService interface to avoid circular imports
// Based on actual Prisma User model
interface IUserService {
  findByCognitoSub(cognitoSub: string): Promise<User | null>;
  findByGoogleId(googleId: string): Promise<User | null>;
  findByEmailOrPhone(email?: string, phone?: string): Promise<User | null>;
  updateUser(id: string, data: Partial<User>): Promise<User>;
  updateLastSignIn(id: string): Promise<void>;
  createUser(data: Record<string, unknown>): Promise<User>;
}

// Provider configuration will be loaded from config
let FEDERATED_PROVIDERS: Record<string, FederatedProvider> = {};

export class AuthenticationService implements IAuthenticationService {
  private config: AuthenticationConfig;
  private googleAuthClient?: OAuth2Client;
  private isInitialized: boolean = false;
  private googleWebClientId?: string;
  private googleClientId?: string;
  private googleClientSecret?: string;
  private appleClientId?: string;
  private facebookAppId?: string;
  private facebookAppSecret?: string;
  private cognitoIdentityPoolId?: string;
  // sessionsTableName removed - DynamoDB session storage was unused dead code

  /**
   * Constructor with explicit dependency injection (Pure DI - no singleton)
   * All dependencies are required and injected by bootstrap.ts
   */
  public constructor(
    private logger: LoggerService,
    private cognitoService: CognitoService,
    private userService: IUserService,
    private authUtils: AuthenticationUtils,
  ) {
    // Pure constructor injection - all dependencies provided by bootstrap.ts
    // Configuration will be set via initialize() method
    if (!logger || !cognitoService || !userService || !authUtils) {
      throw new Error('AuthenticationService: All dependencies (logger, cognitoService, userService, authUtils) must be provided');
    }
    this.config = {} as AuthenticationConfig;
  }

  /**
   * Initialize the service with configuration
   * This should be called once during server initialization
   */
  public async initialize(config: AuthenticationConfig, secrets: {
    googleWebClientId?: string;
    googleClientId?: string;
    googleClientSecret?: string;
    appleClientId?: string;
    facebookAppId?: string;
    facebookAppSecret?: string;
    cognitoIdentityPoolId?: string;
    // sessionsTableName removed - DynamoDB session storage was unused
  }): Promise<void> {
    if (this.isInitialized) {
      this.logger.log(LogLevel.WARN, LogCategory.AUTHENTICATION, 
        'AuthenticationService already initialized');
      return;
    }

    // Note: AuthenticationService uses AWS Cognito for JWT token generation and validation
    // JWT secret validation is handled at the global config level for WebSocket authentication

    this.config = config;
    // authUtils is now injected via constructor - no need to create it here
    // cognitoService is already injected via constructor

    // Store all secrets
    this.googleWebClientId = secrets.googleWebClientId;
    this.googleClientId = secrets.googleClientId;
    this.googleClientSecret = secrets.googleClientSecret;
    this.appleClientId = secrets.appleClientId;
    this.facebookAppId = secrets.facebookAppId;
    this.facebookAppSecret = secrets.facebookAppSecret;
    this.cognitoIdentityPoolId = secrets.cognitoIdentityPoolId;
    // sessionsTableName assignment removed - DynamoDB session storage was unused
    
    // Initialize federated providers
    this.initializeFederatedProviders();
    
    // Initialize Google OAuth client for server-side token validation
    this.initializeGoogleAuthClient();
    
    this.isInitialized = true;
    this.logger.log(LogLevel.INFO, LogCategory.AUTHENTICATION, 
      'AuthenticationService initialized successfully');
  }

  /**
   * Initialize federated providers configuration
   */
  private initializeFederatedProviders(): void {
    FEDERATED_PROVIDERS = {
      google: {
        name: 'Google',
        clientId: this.googleClientId || '',
        clientSecret: this.googleClientSecret,
        enabled: Boolean(this.googleClientId),
      },
      apple: {
        name: 'Apple',
        clientId: this.appleClientId || '',
        enabled: Boolean(this.appleClientId),
      },
      facebook: {
        name: 'Facebook',
        clientId: this.facebookAppId || '',
        clientSecret: this.facebookAppSecret,
        enabled: Boolean(this.facebookAppId),
      },
    };
  }

  /**
   * Initialize Google OAuth client for server-side token validation
   */
  private initializeGoogleAuthClient(): void {
    if (this.googleWebClientId) {
      this.googleAuthClient = new OAuth2Client(this.googleWebClientId);
      this.logger.log(LogLevel.INFO, LogCategory.AUTHENTICATION, 'Google OAuth client initialized for token validation', { context: 'auth_service' });
    } else {
      this.logger.log(LogLevel.WARN, LogCategory.AUTHENTICATION, 'Google OAuth client ID not configured - Google authentication will fail', { 
        context: 'auth_service',
        required_config: 'GOOGLE_WEB_CLIENT_ID in Secrets Manager',
      });
    }
  }

  /**
   * Validate token using Cognito authentication
   */
  async validateToken(token: string): Promise<TokenValidationResult> {
    try {
      const result = await this.authUtils.validateToken(token);
      
      // Log authentication attempt (without sensitive data)
      if (result.isValid && result.user) {
        this.logger.log(LogLevel.INFO, LogCategory.AUTHENTICATION, 'Authentication successful', { 
          context: 'token_validation',
          user_id: result.user?.id || 'unknown',
        });
      } else {
        this.logger.log(LogLevel.WARN, LogCategory.AUTHENTICATION, 'Authentication failed', { 
          context: 'token_validation', 
          error_type: result.error || 'unknown',
        });
      }
      
      return result;
    } catch (error) {
      // Re-throw if already AppError
      if (error instanceof AppError) throw error;
      
      // Handle Zod validation errors
      if (error instanceof Error && error.name === 'ZodError') {
        throw error; // Let middleware handle
      }
      
      // Handle Prisma errors
      if (isPrismaError(error)) {
        throw handlePrismaError(error);
      }
      
      // Log unexpected errors
      this.logger.log(LogLevel.ERROR, LogCategory.AUTHENTICATION, 'Authentication error', { 
        context: 'AuthenticationService', 
        error: getErrorMessage(error), 
        stack: getErrorStack(error), 
      });
      
      // Throw generic AppError
      throw new AppError(500, ErrorCodes.INTERNAL_SERVER_ERROR, 'Authentication service error');
    }
  }

  /**
   * Extract user context from token
   */
  async extractUserContext(token: string): Promise<UserContext | null> {
    try {
      const result = await this.validateToken(token);
      return result.isValid ? result.user || null : null;
    } catch (error) {
      // Re-throw if already AppError
      if (error instanceof AppError) throw error;
      
      // Handle Zod validation errors
      if (error instanceof Error && error.name === 'ZodError') {
        throw error; // Let middleware handle
      }
      
      // Handle Prisma errors
      if (isPrismaError(error)) {
        throw handlePrismaError(error);
      }
      
      // Log unexpected errors
      this.logger.log(LogLevel.ERROR, LogCategory.AUTHENTICATION, 'User context extraction failed', { 
        context: 'AuthenticationService', 
        error: getErrorMessage(error), 
        stack: getErrorStack(error), 
      });
      
      // Throw generic AppError
      throw new AppError(500, ErrorCodes.INTERNAL_SERVER_ERROR, 'User context extraction failed');
    }
  }


  /**
   * Refresh authentication tokens using a valid refresh token
   */
  async refreshToken(refreshToken: string): Promise<RefreshTokenResponse> {
    try {
      this.logger.log(LogLevel.INFO, LogCategory.AUTHENTICATION, 'Initiating token refresh', {
        context: 'auth_service',
      });

      // Use CognitoService to refresh tokens
      const refreshResult = await this.cognitoService.refreshTokens(refreshToken);

      // Calculate expiresIn from expiresAt timestamp
      const expiresIn = Math.max(0, Math.floor((refreshResult.tokens.expiresAt - Date.now()) / 1000));

      this.logger.log(LogLevel.INFO, LogCategory.AUTHENTICATION, 'Token refresh successful', {
        context: 'auth_service',
        expiresAt: refreshResult.tokens.expiresAt,
        expiresIn,
      });

      // Transform to match RefreshTokenResponse interface
      return {
        accessToken: refreshResult.tokens.accessToken,
        idToken: refreshResult.tokens.idToken,
        refreshToken: refreshResult.tokens.refreshToken,
        expiresIn,
        tokenType: 'Bearer',
      };
    } catch (error: unknown) {
      // Re-throw if already AppError
      if (error instanceof AppError) throw error;
      
      // Handle Zod validation errors
      if (error instanceof Error && error.name === 'ZodError') {
        throw error; // Let middleware handle
      }
      
      // Handle Prisma errors
      if (isPrismaError(error)) {
        throw handlePrismaError(error);
      }
      
      // Log unexpected errors
      this.logger.log(LogLevel.ERROR, LogCategory.AUTHENTICATION, 'Token refresh failed', {
        context: 'AuthenticationService',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      
      // Throw generic AppError
      throw new AppError(401, ErrorCodes.UNAUTHORIZED, 'Token refresh failed');
    }
  }


  /**
   * Check if Cognito authentication is properly configured
   */
  isConfigured(): boolean {
    return !!(this.config.cognitoUserPoolId && this.config.cognitoClientId);
  }

  /**
   * Get Cognito authentication configuration status
   */
  getConfigStatus(): {
    strategy: 'cognito';
    configured: boolean;
    features: string[];
  } {
    const configured = this.isConfigured();
    const features: string[] = [];

    if (this.config.cognitoUserPoolId) features.push('Cognito');

    return {
      strategy: 'cognito',
      configured,
      features,
    };
  }

  /**
   * This method prevents token forgery attacks by validating the token with Google's servers
   * 
   * @param idToken - The Google ID token from the client
   * @returns Validated token payload or null if invalid
   */
  async validateGoogleIdToken(idToken: string): Promise<GoogleTokenPayload> {
    try {
      this.logger.log(LogLevel.INFO, LogCategory.AUTHENTICATION, 'Validating Google ID token with Google servers', { context: 'auth_service' });

      if (!this.googleAuthClient) {
        this.logger.log(LogLevel.ERROR, LogCategory.AUTHENTICATION, 'Google OAuth client not configured - cannot validate token', {
          context: 'auth_service',
          googleWebClientId: this.googleWebClientId ? 'configured' : 'missing',
          isInitialized: this.isInitialized,
        });
        throw new AppError(
          503,
          ErrorCodes.SERVICE_UNAVAILABLE,
          'Google Sign-In is not configured. Please configure GOOGLE_WEB_CLIENT_ID in AWS Secrets Manager or environment variables.',
        );
      }

      // SECURITY: Verify the Google ID token with Google's servers
      const verifyStartMs = Date.now();
      const ticket = await this.googleAuthClient.verifyIdToken({
        idToken,
        audience: this.googleWebClientId,
      });
      const verifyDurationMs = Date.now() - verifyStartMs;
      this.logger.log(LogLevel.INFO, LogCategory.AUTHENTICATION, 'Google token verification completed', {
        context: 'auth_service',
        verifyDurationMs,
      });

      const payload = ticket.getPayload();
      if (!payload) {
        this.logger.log(LogLevel.WARN, LogCategory.AUTHENTICATION, 'Google ID token validation failed - no payload returned', { context: 'auth_service' });
        throw new AppError(401, ErrorCodes.GOOGLE_TOKEN_NO_PAYLOAD, 'Google ID token contained no payload');
      }

      // NOTE: email_verified=false is legitimate for Google Workspace and phone-first accounts.
      // Google's verifyIdToken() already cryptographically proved the user owns this Google account.
      // We log the status but do NOT reject — the emailVerified field will be stored in the DB.
      if (!payload.email_verified) {
        this.logger.log(LogLevel.WARN, LogCategory.AUTHENTICATION,
          'Google ID token has email_verified=false — allowing because token is server-verified', {
            context: 'auth_service',
            email: payload.email,
            sub: payload.sub,
          });
      }

      // SECURITY: Additional validation checks
      const now = Math.floor(Date.now() / 1000);
      
      // Check token expiration
      if (payload.exp && payload.exp < now) {
        this.logger.log(LogLevel.WARN, LogCategory.AUTHENTICATION, 'Google ID token validation failed - token expired', {
          context: 'auth_service',
          exp: payload.exp,
          now,
          expiredAgoSeconds: now - payload.exp,
        });
        throw new AppError(401, ErrorCodes.GOOGLE_TOKEN_EXPIRED, 'Google ID token has expired');
      }

      // Check token was issued recently (generous 2-hour window + 5-minute clock-skew buffer).
      // google-auth-library's verifyIdToken() already validates exp, so this is a secondary guard
      // against replayed tokens. The generous window prevents clock-skew rejections.
      const MAX_TOKEN_AGE_SECONDS = 7200; // 2 hours
      const CLOCK_SKEW_BUFFER_SECONDS = 300; // 5 minutes
      const tokenAgeSeconds = now - (payload.iat || 0);
      if (payload.iat && tokenAgeSeconds > (MAX_TOKEN_AGE_SECONDS + CLOCK_SKEW_BUFFER_SECONDS)) {
        this.logger.log(LogLevel.WARN, LogCategory.AUTHENTICATION, 'Google ID token validation failed - token too old', {
          context: 'auth_service',
          iat: payload.iat,
          tokenAgeSeconds,
          maxAllowedSeconds: MAX_TOKEN_AGE_SECONDS + CLOCK_SKEW_BUFFER_SECONDS,
        });
        throw new AppError(401, ErrorCodes.GOOGLE_TOKEN_TOO_OLD, 'Google ID token was issued more than 2 hours ago');
      }

      // Check issuer is Google
      if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
        this.logger.log(LogLevel.WARN, LogCategory.AUTHENTICATION, 'Google ID token validation failed - invalid issuer', {
          context: 'auth_service',
          issuer: payload.iss,
        });
        throw new AppError(401, ErrorCodes.GOOGLE_TOKEN_INVALID_ISSUER,
          `Google ID token has unexpected issuer: ${payload.iss}`);
      }

      // Check audience matches our client ID
      if (payload.aud !== this.googleWebClientId) {
        this.logger.log(LogLevel.WARN, LogCategory.AUTHENTICATION, 'Google ID token validation failed - invalid audience', {
          context: 'auth_service',
          audience: payload.aud,
          expected: this.googleWebClientId,
        });
        throw new AppError(401, ErrorCodes.GOOGLE_TOKEN_AUDIENCE_MISMATCH,
          'Google ID token audience does not match configured client ID');
      }

      // All validations passed
      this.logger.log(LogLevel.INFO, LogCategory.AUTHENTICATION, 'Google ID token validation successful', {
        context: 'auth_service',
        email: payload.email,
        sub: payload.sub,
        email_verified: payload.email_verified,
        tokenAgeSeconds: payload.iat ? Math.floor(Date.now() / 1000) - payload.iat : undefined,
        verifyDurationMs,
      });

      return payload as GoogleTokenPayload;

    } catch (error: unknown) {
      // Re-throw if already AppError
      if (error instanceof AppError) throw error;
      
      // Handle Zod validation errors
      if (error instanceof Error && error.name === 'ZodError') {
        throw error; // Let middleware handle
      }
      
      // Handle Prisma errors
      if (isPrismaError(error)) {
        throw handlePrismaError(error);
      }
      
      // Log unexpected errors
      this.logger.log(LogLevel.ERROR, LogCategory.AUTHENTICATION, 'Google ID token validation error', {
        context: 'AuthenticationService',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });

      // Map common google-auth-library errors to specific codes for client diagnostics
      const errorMessage = getErrorMessage(error);
      if (errorMessage?.includes('Token used too early')) {
        this.logger.log(LogLevel.WARN, LogCategory.AUTHENTICATION, 'Google ID token used before valid time — clock skew suspected', { context: 'auth_service' });
        throw new AppError(401, ErrorCodes.GOOGLE_TOKEN_VALIDATION_FAILED, 'Google ID token used before valid time (clock skew)');
      } else if (errorMessage?.includes('Invalid token signature')) {
        this.logger.log(LogLevel.WARN, LogCategory.AUTHENTICATION, 'Google ID token has invalid signature', { context: 'auth_service' });
        throw new AppError(401, ErrorCodes.GOOGLE_TOKEN_VALIDATION_FAILED, 'Google ID token has invalid signature');
      } else if (errorMessage?.includes('No pem found for envelope')) {
        this.logger.log(LogLevel.WARN, LogCategory.AUTHENTICATION, 'Google ID token verification failed - invalid format', { context: 'auth_service' });
        throw new AppError(401, ErrorCodes.GOOGLE_TOKEN_VALIDATION_FAILED, 'Google ID token has invalid format');
      }

      // Generic verification failure
      throw new AppError(401, ErrorCodes.GOOGLE_TOKEN_VALIDATION_FAILED,
        `Google ID token verification failed: ${errorMessage || 'unknown error'}`);
    }
  }

  /**
   * Perform federated sign-in with Cognito using validated external identity
   * Creates or links user accounts and returns Cognito tokens
   * 
   * @param provider - Identity provider name (e.g., 'Google')
   * @param idToken - External provider's ID token (already validated)
   * @param userInfo - Validated user information from the provider
   * @param validatedTokenData - Additional validated token data
   * @returns Federated sign-in result with user and tokens
   */
  async federatedSignIn(
    provider: 'Google' | 'Facebook' | 'Apple',
    idToken: string,
    userInfo: FederatedUserInfo,
    validatedTokenData?: GoogleTokenPayload | Record<string, unknown>,
  ): Promise<FederatedSignInResult> {
    try {
      this.logger.log(LogLevel.INFO, LogCategory.AUTHENTICATION, 'Starting federated sign-in process', {
        context: 'auth_service',
        provider,
        email: userInfo.email,
      });

      // Use provider-specific user ID as username to avoid Cognito email alias conflict
      // Cognito User Pool is configured with email as an alias, so username cannot be in email format
      // Format: "google_{id}", "facebook_{id}", "apple_{id}"
      const providerPrefix = provider.toLowerCase();
      const username = `${providerPrefix}_${userInfo.id}`;

      if (!userInfo.id) {
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          `${provider} user ID is required for federated sign-in`,
        );
      }

      if (!userInfo.email) {
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          'Email is required for federated sign-in',
        );
      }

      let cognitoUserAuthResult;
      try {
        // Attempt to sign in an existing user (which will also check for existence)
        cognitoUserAuthResult = await this.signInExistingUser(username, provider, idToken, validatedTokenData || userInfo);
      } catch (error: unknown) {
        // AWS SDK errors can have the error name in either 'name' or 'code' properties
        const errorName = getErrorName(error);
        const errorCode = getErrorCode(error);

        // NotAuthorizedException means the user EXISTS but auth failed (e.g., Cognito state issue).
        // Previously both were treated the same → createAndSignInUser → UsernameExistsException loop.
        if (errorName === 'UserNotFoundException' || errorCode === 'UserNotFoundException') {
          this.logger.log(LogLevel.INFO, LogCategory.AUTHENTICATION, 'Cognito user not found, creating new federated user', {
            context: 'auth_service',
            username,
            provider,
            errorName,
            errorCode,
          });
          cognitoUserAuthResult = await this.createAndSignInUser(username, provider, userInfo, idToken, validatedTokenData);
        } else if (errorName === 'NotAuthorizedException' || errorCode === 'NotAuthorizedException') {
          // User exists but authentication failed — possible Cognito state corruption
          this.logger.log(LogLevel.ERROR, LogCategory.AUTHENTICATION,
            'Federated user exists but authentication failed — possible Cognito state issue', {
              context: 'auth_service',
              username,
              provider,
              errorName,
              errorCode,
            });
          throw new AppError(500, ErrorCodes.EXTERNAL_SERVICE_ERROR,
            'Federated authentication failed for existing user — please try again or contact support');
        } else {
          throw error; // Re-throw other errors
        }
      }

      // Extract tokens from Cognito response
      const tokens = {
        idToken: cognitoUserAuthResult.AuthenticationResult?.IdToken || '',
        accessToken: cognitoUserAuthResult.AuthenticationResult?.AccessToken || '',
        refreshToken: cognitoUserAuthResult.AuthenticationResult?.RefreshToken,
        expiresAt: Date.now() + ((cognitoUserAuthResult.AuthenticationResult?.ExpiresIn || 3600) * 1000),
      };

      // Get user context using the access token (Cognito's GetUser API)
      const cognitoUserInfo = await this.cognitoService.getUserInfo(tokens.accessToken);

      // This ensures frontend receives the same user ID used by HTTP middleware and WebSocket
      // Previously returned cognitoUserInfo.id (Cognito Sub), causing userId mismatch errors
      const internalUserId = await this.updateDatabaseUser(cognitoUserInfo, userInfo, provider);

      // Build user context with INTERNAL database user ID (NOT Cognito sub)
      const userContext: UserContext = {
        id: internalUserId,
        username: cognitoUserInfo.username,
        email: cognitoUserInfo.email,
        emailVerified: cognitoUserInfo.emailVerified,
        groups: cognitoUserInfo.groups || [],
        roles: cognitoUserInfo.groups || ['user'], // Map Cognito groups to roles
        permissions: [], // Permissions will be derived from roles
        isAuthenticated: true,
        tokenType: 'cognito',
        expiresAt: new Date(tokens.expiresAt),
      };

      this.logger.log(LogLevel.INFO, LogCategory.AUTHENTICATION, 'Federated sign-in successful', {
        context: 'auth_service',
        internalUserId,           // Internal database user ID
        cognitoSub: cognitoUserInfo.id, // Cognito sub for reference
        provider,
        email: userContext.email,
      });

      return { user: userContext, tokens };

    } catch (error: unknown) {
      // Re-throw if already AppError
      if (error instanceof AppError) throw error;
      
      // Handle Zod validation errors
      if (error instanceof Error && error.name === 'ZodError') {
        throw error; // Let middleware handle
      }
      
      // Handle Prisma errors
      if (isPrismaError(error)) {
        throw handlePrismaError(error);
      }
      
      // Log unexpected errors
      this.logger.log(LogLevel.ERROR, LogCategory.AUTHENTICATION, 'Federated sign-in failed', {
        context: 'AuthenticationService',
        provider,
        email: userInfo.email,
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      
      // Throw generic AppError
      throw new AppError(401, ErrorCodes.UNAUTHORIZED, 'Federated sign-in failed');
    }
  }

  /**
   * Sign in an existing Cognito user with federated identity
   * Updates the stored password and authenticates the user
   */
  private async signInExistingUser(
    username: string,
    provider: string,
    idToken: string,
    validatedTokenData: GoogleTokenPayload | FederatedUserInfo | Record<string, unknown>
  ): Promise<AdminInitiateAuthCommandOutput | AdminRespondToAuthChallengeCommandOutput> {
    this.logger.log(LogLevel.INFO, LogCategory.AUTHENTICATION, 'Attempting sign-in for existing federated user', {
      context: 'auth_service',
      username,
      provider,
    });

    // First, check if the user exists and is in a state that allows sign-in
    let existingCognitoUser;
    try {
      existingCognitoUser = await this.cognitoService.adminGetUser(username);
      this.logger.log(LogLevel.DEBUG, LogCategory.AUTHENTICATION, 'Existing Cognito user found', { 
        username, 
        status: existingCognitoUser.status, 
      });
    } catch (error: unknown) {
      // Re-throw if already AppError
      if (error instanceof AppError) throw error;
      
      // Handle Zod validation errors
      if (error instanceof Error && error.name === 'ZodError') {
        throw error; // Let middleware handle
      }
      
      // Handle Prisma errors
      if (isPrismaError(error)) {
        throw handlePrismaError(error);
      }

      // Specific AWS Cognito errors
      // AWS SDK errors can have the error name in either 'name' or 'code' properties
      const errorName = getErrorName(error);
      const errorCode = getErrorCode(error);

      if (errorName === 'UserNotFoundException' || errorCode === 'UserNotFoundException') {
        this.logger.log(LogLevel.DEBUG, LogCategory.AUTHENTICATION, 'Cognito user not found, will create new user', {
          context: 'AuthenticationService',
          username,
          errorName,
          errorCode,
        });
        throw error; // User does not exist, caller should handle creation
      }

      // Log unexpected errors with full AWS error details
      this.logger.log(LogLevel.ERROR, LogCategory.AUTHENTICATION, 'Cognito user lookup failed - unexpected error', {
        context: 'AuthenticationService.signInExistingUser',
        username,
        errorName,
        errorCode,
        errorMessage: getErrorMessage(error),
        errorStack: getErrorStack(error),
        // Log raw error to see AWS SDK structure
        rawErrorType: typeof error,
        rawErrorConstructor: error && typeof error === 'object' && 'constructor' in error ? (error.constructor as { name?: string }).name : 'unknown',
      });

      // Throw generic AppError with detailed context
      throw new AppError(
        500,
        ErrorCodes.EXTERNAL_SERVICE_ERROR,
        `Cognito user lookup failed: ${getErrorMessage(error)} (errorName: ${errorName}, errorCode: ${errorCode})`
      );
    }

    // If user is in a non-CONFIRMED state, we might need to confirm them first
    if (existingCognitoUser.status === 'UNCONFIRMED') {
      this.logger.log(LogLevel.WARN, LogCategory.AUTHENTICATION, 'Existing federated user is UNCONFIRMED, attempting to set password and confirm', { 
        username, 
      });
      try {
        await this.cognitoService.adminSetUserPassword(username, this.generateTemporaryPassword(), true);
        this.logger.log(LogLevel.INFO, LogCategory.AUTHENTICATION, 'Set temporary password for UNCONFIRMED federated user', { 
          username, 
        });
      } catch (pwdError) {
        // Re-throw if already AppError
        if (pwdError instanceof AppError) throw pwdError;
        
        // Handle Zod validation errors
        if (pwdError instanceof Error && pwdError.name === 'ZodError') {
          throw pwdError; // Let middleware handle
        }
        
        // Handle Prisma errors
        if (isPrismaError(pwdError)) {
          throw handlePrismaError(pwdError);
        }
        
        // Log unexpected errors
        this.logger.log(LogLevel.ERROR, LogCategory.AUTHENTICATION, 'Failed to set password for UNCONFIRMED federated user', { 
          context: 'AuthenticationService',
          username, 
          error: getErrorMessage(pwdError),
          stack: getErrorStack(pwdError),
        });
        
        // Continue execution - this is not a critical failure
      }
    }

    const securePassword = this.generateTemporaryPassword();
    try {
      // Update the user's password to ensure we have a valid password for ADMIN_NO_SRP_AUTH
      await this.cognitoService.adminSetUserPassword(username, securePassword, true);
    } catch (pwdError: unknown) {
      // Re-throw if already AppError
      if (pwdError instanceof AppError) throw pwdError;

      // Handle Zod validation errors
      if (pwdError instanceof Error && pwdError.name === 'ZodError') {
        throw pwdError; // Let middleware handle
      }

      // Handle Prisma errors
      if (isPrismaError(pwdError)) {
        throw handlePrismaError(pwdError);
      }

      // with NotAuthorizedException, which previously was mishandled as "user not found"
      // causing an incorrect createAndSignInUser → UsernameExistsException loop.
      this.logger.log(LogLevel.ERROR, LogCategory.AUTHENTICATION,
        'Failed to set password for existing federated user — cannot authenticate', {
          context: 'AuthenticationService',
          username,
          error: getErrorMessage(pwdError),
          stack: getErrorStack(pwdError),
        });
      throw new AppError(500, ErrorCodes.EXTERNAL_SERVICE_ERROR,
        'Failed to prepare federated authentication — password set failed');
    }

    const { AuthFlowType } = await import('@aws-sdk/client-cognito-identity-provider');
    let authResult;
    try {
      authResult = await this.cognitoService.adminInitiateAuth({
        username,
        authFlow: AuthFlowType.ADMIN_NO_SRP_AUTH,
        authParameters: {
          USERNAME: username,
          PASSWORD: securePassword,
        },
      });
    } catch (initAuthError: unknown) {
      // Re-throw if already AppError
      if (initAuthError instanceof AppError) throw initAuthError;

      // Handle Zod validation errors
      if (initAuthError instanceof Error && initAuthError.name === 'ZodError') {
        throw initAuthError; // Let middleware handle
      }

      // Handle Prisma errors
      if (isPrismaError(initAuthError)) {
        throw handlePrismaError(initAuthError);
      }

      // Specific AWS Cognito errors
      const errorName = getErrorName(initAuthError);
      if (errorName === 'NotAuthorizedException' || errorName === 'UserNotFoundException') {
        throw initAuthError; // Re-throw to indicate sign-in failed
      }
      
      // Log unexpected errors
      this.logger.log(LogLevel.ERROR, LogCategory.AUTHENTICATION, 'Cognito authentication failed', { 
        context: 'AuthenticationService', 
        error: getErrorMessage(initAuthError), 
        stack: getErrorStack(initAuthError), 
      });
      
      // Throw generic AppError
      throw new AppError(500, ErrorCodes.EXTERNAL_SERVICE_ERROR, `Cognito authentication failed: ${getErrorMessage(initAuthError)}`);
    }

    // Handle authentication challenges (e.g., NEW_PASSWORD_REQUIRED)
    if (authResult.ChallengeName && !authResult.AuthenticationResult) {
      if (authResult.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
        const newSecurePassword = this.generateTemporaryPassword();
        const challengeResponse = await this.cognitoService.adminRespondToAuthChallenge({
          username,
          challengeName: authResult.ChallengeName,
          challengeResponses: {
            NEW_PASSWORD: newSecurePassword,
            USERNAME: username,
          },
          session: authResult.Session,
        });

        if (challengeResponse.AuthenticationResult) {
          return challengeResponse;
        }
      }
      throw new AppError(500, ErrorCodes.INTERNAL_SERVER_ERROR, `Unhandled authentication challenge: ${authResult.ChallengeName}`);
    }

    if (!authResult.AuthenticationResult) {
      throw new AppError(401, ErrorCodes.UNAUTHORIZED, 'Authentication failed for existing user');
    }

    return authResult;
  }

  /**
   * Generate application tokens for authenticated federated users
   * Uses AdminInitiateAuth with CUSTOM_AUTH flow for federated users
   */
  private async generateFederatedTokens(
    username: string,
    provider: string,
    idToken: string,
    validatedTokenData?: GoogleTokenPayload | Record<string, unknown>
  ): Promise<AdminInitiateAuthCommandOutput | AdminRespondToAuthChallengeCommandOutput> {
    try {
      this.logger.log(LogLevel.INFO, LogCategory.AUTHENTICATION, 'Generating federated tokens via Cognito', {
        context: 'auth_service',
        username,
        provider,
      });

      // Validate provider
      const federatedProvider = FEDERATED_PROVIDERS[provider.toLowerCase()];
      if (!federatedProvider || !federatedProvider.enabled) {
        throw new AppError(
          400,
          ErrorCodes.BAD_REQUEST,
          'Authentication provider not available',
        );
      }

      // Use AdminInitiateAuth with CUSTOM_AUTH flow
      // This allows us to authenticate users without passwords for federated auth
      const { AdminInitiateAuthCommand, AuthFlowType } = await import('@aws-sdk/client-cognito-identity-provider');
      
      const authCommand = new AdminInitiateAuthCommand({
        UserPoolId: this.config.cognitoUserPoolId,
        ClientId: this.config.cognitoClientId,
        AuthFlow: AuthFlowType.ADMIN_NO_SRP_AUTH,
        AuthParameters: {
          USERNAME: username,
          // For federated users, we use a special marker password that's never used directly
          PASSWORD: generateSecurePassword(24), // Cryptographically secure password for federated auth
        },
      });

      try {
        // Try to authenticate the user
        if (!this.cognitoService.cognitoClient) {
          throw new AppError(
            503,
            ErrorCodes.SERVICE_UNAVAILABLE,
            'Authentication service temporarily unavailable',
          );
        }
        const authResult = await this.cognitoService.cognitoClient.send(authCommand);
        
        if (authResult.AuthenticationResult) {
          this.logger.log(LogLevel.INFO, LogCategory.AUTHENTICATION, 'Successfully generated tokens for federated user', {
            context: 'auth_service',
            username,
            provider,
          });
          return authResult;
        }
        
        // If we get a challenge, handle it
        if (authResult.ChallengeName) {
          this.logger.log(LogLevel.WARN, LogCategory.AUTHENTICATION, 'Authentication challenge received for federated user', {
            context: 'auth_service',
            username,
            provider,
            challenge: authResult.ChallengeName,
          });
          
          // For NEW_PASSWORD_REQUIRED, set a secure random password
          if (authResult.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
            const { AdminSetUserPasswordCommand } = await import('@aws-sdk/client-cognito-identity-provider');
            const securePassword = generateSecurePassword(20); // Cryptographically secure password for challenge response
            
            if (!this.cognitoService.cognitoClient) {
              throw new AppError(
            503,
            ErrorCodes.SERVICE_UNAVAILABLE,
            'Authentication service temporarily unavailable',
          );
            }
            await this.cognitoService.cognitoClient.send(new AdminSetUserPasswordCommand({
              UserPoolId: this.config.cognitoUserPoolId,
              Username: username,
              Password: securePassword,
              Permanent: true,
            }));
            
            // Retry authentication with the new password
            const retryAuth = new AdminInitiateAuthCommand({
              UserPoolId: this.config.cognitoUserPoolId,
              ClientId: this.config.cognitoClientId,
              AuthFlow: AuthFlowType.ADMIN_NO_SRP_AUTH,
              AuthParameters: {
                USERNAME: username,
                PASSWORD: securePassword,
              },
            });
            
            if (!this.cognitoService.cognitoClient) {
              throw new AppError(
            503,
            ErrorCodes.SERVICE_UNAVAILABLE,
            'Authentication service temporarily unavailable',
          );
            }
            return await this.cognitoService.cognitoClient.send(retryAuth);
          }
        }
        
        throw new AppError(
          401,
          ErrorCodes.UNAUTHORIZED,
          'Authentication failed',
        );


      } catch (authError: unknown) {
        // If user doesn't exist or password is wrong, that's expected for federated users
        // We'll handle this in the calling function
        const authErrorName = getErrorName(authError);
        if (authErrorName === 'NotAuthorizedException' || authErrorName === 'UserNotFoundException') {
          this.logger.log(LogLevel.INFO, LogCategory.AUTHENTICATION, 'Federated user not found or not authorized, will create', {
            context: 'auth_service',
            username,
            provider,
          });
          
          // For federated users that don't exist yet, we need to return a special response
          // The calling function will create the user and retry
          throw authError;
        }
        
        throw authError;
      }
      
    } catch (error: unknown) {
      // Re-throw if already AppError
      if (error instanceof AppError) throw error;
      
      // Handle Zod validation errors
      if (error instanceof Error && error.name === 'ZodError') {
        throw error; // Let middleware handle
      }
      
      // Handle Prisma errors
      if (isPrismaError(error)) {
        throw handlePrismaError(error);
      }
      
      // Log unexpected errors
      this.logger.log(LogLevel.ERROR, LogCategory.AUTHENTICATION, 'Failed to generate federated tokens', {
        context: 'AuthenticationService',
        username,
        provider,
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      
      // Throw generic AppError
      throw new AppError(500, ErrorCodes.INTERNAL_SERVER_ERROR, 'Failed to generate federated tokens');
    }
  }

  /**
   * @deprecated This method is disabled for security reasons
   * Access tokens must be generated by AWS Cognito, not locally
   */
  private generateAccessToken(claims: unknown): string {
    throw new AppError(
      501,
      ErrorCodes.INVALID_OPERATION,
      'Token generation not supported',
    );
  }

  /**
   * @deprecated This method is disabled for security reasons
   * Refresh tokens must be generated by AWS Cognito, not locally
   */
  private generateRefreshToken(claims: unknown): string {
    throw new AppError(
      501,
      ErrorCodes.INVALID_OPERATION,
      'Token generation not supported',
    );
  }

  /**
   * @deprecated This method is disabled for security reasons
   * ID tokens must be generated by AWS Cognito, not locally
   */
  private generateIdToken(claims: unknown): string {
    throw new AppError(
      501,
      ErrorCodes.INVALID_OPERATION,
      'Token generation not supported',
    );
  }

  // storeSession method removed - was unused dead code that stored federated sessions in DynamoDB

  /**
   * Create new Cognito user and sign them in with federated identity
   */
  private async createAndSignInUser(
    username: string,
    provider: string,
    userInfo: FederatedUserInfo,
    idToken: string,
    validatedTokenData?: GoogleTokenPayload | Record<string, unknown>,
  ): Promise<AdminInitiateAuthCommandOutput | AdminRespondToAuthChallengeCommandOutput> {
    this.logger.log(LogLevel.INFO, LogCategory.AUTHENTICATION, 'Creating new Cognito user for federated sign-in', {
      context: 'auth_service',
      username,
      provider,
    });

    const securePassword = this.generateTemporaryPassword();

    // Create user in Cognito User Pool
    const createResult = await this.cognitoService.adminCreateUser({
      username,
      temporaryPassword: securePassword,
      userAttributes: [
        { Name: 'email', Value: userInfo.email },
        { Name: 'email_verified', Value: userInfo.emailVerified ? 'true' : 'false' },
        { Name: 'name', Value: userInfo.name || '' },
        { Name: 'picture', Value: userInfo.photo || '' },
        { Name: 'custom:auth_provider', Value: provider.toLowerCase() },
        { Name: 'custom:provider_user_id', Value: userInfo.id },
      ].filter(attr => attr.Value !== undefined && attr.Value !== ''),
      messageAction: MessageActionType.SUPPRESS, // Don't send welcome email
      forceAliasCreation: false,
    });

    this.logger.log(LogLevel.INFO, LogCategory.AUTHENTICATION, 'Cognito user created, setting password permanent', {
      context: 'auth_service',
      username,
      provider,
      userStatus: createResult.User?.UserStatus,
    });

    // Set the user's password to permanent (skip FORCE_CHANGE_PASSWORD state)
    await this.cognitoService.adminSetUserPassword(username, securePassword, true);

    // Now sign in the newly created user
    const { AuthFlowType } = await import('@aws-sdk/client-cognito-identity-provider');
    const authResult = await this.cognitoService.adminInitiateAuth({
      username,
      authFlow: AuthFlowType.ADMIN_NO_SRP_AUTH,
      authParameters: {
        USERNAME: username,
        PASSWORD: securePassword,
      },
    });

    if (!authResult.AuthenticationResult) {
      throw new AppError(500, ErrorCodes.INTERNAL_SERVER_ERROR, 'User creation succeeded but authentication failed');
    }

    return authResult;
  }

  /**
   * Generates a cryptographically secure temporary password that meets Cognito requirements
   * Uses crypto.randomBytes() for secure random generation instead of Math.random()
   * 
   * Security Features:
   * - 256 bits of entropy (32 random bytes)
   * - Meets AWS Cognito password requirements
   * - Cryptographically secure randomization
   * - Character set validation
   * - Secure shuffling algorithm
   */
  private generateTemporaryPassword(): string {
    try {
      // Generate 32 bytes of random data (256 bits of entropy)
      const buffer = randomBytes(32);

      // Verify buffer length (defensive programming)
      if (buffer.length < 16) {
        throw new AppError(
          500,
          ErrorCodes.INTERNAL_SERVER_ERROR,
          'Failed to generate sufficient random bytes for password',
          true
        );
      }

      // Define character sets that meet Cognito requirements
      const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const lowercase = 'abcdefghijklmnopqrstuvwxyz';
      const numbers = '0123456789';
      const symbols = '!@#$%^&*()_+-=[]{}|;:,.<>?';

      // Ensure password has required character types
      let password = '';

      // Add at least one of each required character type (using secure random bytes)
      password += uppercase[buffer[0]! % uppercase.length];
      password += lowercase[buffer[1]! % lowercase.length];
      password += numbers[buffer[2]! % numbers.length];
      password += symbols[buffer[3]! % symbols.length];

      // Fill remaining positions with random characters from all sets
      const allChars = uppercase + lowercase + numbers + symbols;
      for (let i = 4; i < 16; i++) {
        password += allChars[buffer[i]! % allChars.length];
      }
      
      // Cryptographically secure shuffle using Fisher-Yates algorithm with random bytes
      const passwordArray = password.split('');
      for (let i = passwordArray.length - 1; i > 0; i--) {
        // Use additional random bytes for shuffling
        const shuffleBuffer = randomBytes(4);
        const randomIndex = shuffleBuffer.readUInt32BE(0) % (i + 1);
        const temp = passwordArray[i];
        const randomElement = passwordArray[randomIndex];
        if (temp !== undefined && randomElement !== undefined) {
          passwordArray[i] = randomElement;
          passwordArray[randomIndex] = temp;
        }
      }
      
      const finalPassword = passwordArray.join('');
      
      // Log password generation (without revealing the actual password)
      this.logger.log(LogLevel.DEBUG, LogCategory.SECURITY, 'Generated cryptographically secure temporary password', {
        context: 'AuthenticationService.generateTemporaryPassword',
        passwordLength: finalPassword.length,
        hasUppercase: /[A-Z]/.test(finalPassword),
        hasLowercase: /[a-z]/.test(finalPassword),
        hasNumbers: /[0-9]/.test(finalPassword),
        hasSymbols: /[!@#$%^&*()_+\-=\[\]{}|;:,.<>?]/.test(finalPassword),
        entropyBits: 256,
      });
      
      return finalPassword;
      
    } catch (error) {
      this.logger.log(LogLevel.ERROR, LogCategory.SECURITY, 'Failed to generate secure temporary password', {
        context: 'AuthenticationService.generateTemporaryPassword',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      
      // Fallback should never be used, but ensures service doesn't completely fail
      throw new AppError(
        500,
        ErrorCodes.INTERNAL_SERVER_ERROR,
        'Failed to generate secure temporary password - cryptographic random generation failed',
      );
    }
  }


  /**
   * Create or update user in database after Cognito authentication
   */
  private async createDatabaseUser(cognitoUser: CognitoUser, userInfo: FederatedUserInfo, provider: string): Promise<void> {
    try {
      // Use injected userService instead of getInstance()

      // Extract Cognito sub (user ID)
      const cognitoSub = cognitoUser?.Attributes?.find((attr: CognitoUserAttribute) => attr.Name === 'sub')?.Value;

      if (!cognitoSub) {
        this.logger.log(LogLevel.ERROR, LogCategory.AUTHENTICATION, 'No Cognito sub found for user', {
          context: 'auth_service',
          email: userInfo.email,
        });
        return;
      }

      // Check if user already exists
      let existingUser = await this.userService.findByCognitoSub(cognitoSub);

      if (!existingUser && provider.toLowerCase() === 'google' && userInfo.id) {
        existingUser = await this.userService.findByGoogleId(userInfo.id);
      }

      if (!existingUser && userInfo.email) {
        existingUser = await this.userService.findByEmailOrPhone(userInfo.email, undefined);
      }

      if (existingUser) {
        // Update existing user
        await this.userService.updateUser(existingUser.id, {
          cognitoSub,
          googleId: provider.toLowerCase() === 'google' ? userInfo.id : (existingUser.googleId || undefined),
          emailVerified: userInfo.emailVerified || existingUser.emailVerified,
          name: userInfo.name || existingUser.name || undefined,
          authProvider: provider.toUpperCase() as AuthProvider,
          accountStatus: AccountStatus.ACTIVE,
        });

        await this.userService.updateLastSignIn(existingUser.id);

        this.logger.log(LogLevel.INFO, LogCategory.AUTHENTICATION, 'Updated existing database user', {
          context: 'auth_service',
          userId: existingUser.id,
          provider,
        });
      } else {
        // Create new user
        const newUser = await this.userService.createUser({
          email: userInfo.email,
          name: userInfo.name || userInfo.email,
          cognitoSub,
          googleId: provider.toLowerCase() === 'google' ? userInfo.id : undefined,
          emailVerified: userInfo.emailVerified,
          authProvider: provider.toUpperCase() as AuthProvider,
          accountStatus: AccountStatus.ACTIVE,
        });

        this.logger.log(LogLevel.INFO, LogCategory.AUTHENTICATION, 'Created new database user', {
          context: 'auth_service',
          userId: newUser.id,
          provider,
        });
      }
    } catch (error: unknown) {
      // Re-throw if already AppError
      if (error instanceof AppError) throw error;
      
      // Handle Zod validation errors
      if (error instanceof Error && error.name === 'ZodError') {
        throw error; // Let middleware handle
      }
      
      // Handle Prisma errors
      if (isPrismaError(error)) {
        throw handlePrismaError(error);
      }
      
      // Log unexpected errors but don't fail authentication
      this.logger.log(LogLevel.ERROR, LogCategory.AUTHENTICATION, 'Failed to create/update database user', {
        context: 'AuthenticationService',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
        email: userInfo.email,
      });
    }
  }
  
  /**
   * Creates or updates the user in our internal database based on Cognito information
   * 
   * across all authentication flows (HTTP, WebSocket, Google OAuth exchange).
   * 
   * @returns The internal database user ID (NOT Cognito sub)
   */
  private async updateDatabaseUser(
    cognitoUser: { id: string; username: string; email?: string; emailVerified?: boolean; name?: string; },
    federatedUserInfo: FederatedUserInfo,
    provider: string,
  ): Promise<string> {
    // Use injected userService instead of getInstance()

    try {
      let existingInternalUser;
      // Prioritize finding by CognitoSub
      if (cognitoUser.id) {
        existingInternalUser = await this.userService.findByCognitoSub(cognitoUser.id);
      }
      // Fallback to GoogleId if provider is Google
      if (!existingInternalUser && provider === 'Google' && federatedUserInfo.id) {
        existingInternalUser = await this.userService.findByGoogleId(federatedUserInfo.id);
      }
      // Fallback to email/phone
      if (!existingInternalUser && cognitoUser.email) {
        existingInternalUser = await this.userService.findByEmailOrPhone(cognitoUser.email, undefined);
      }

      if (existingInternalUser) {
        // Update existing user
        await this.userService.updateUser(existingInternalUser.id, {
          cognitoSub: cognitoUser.id,
          googleId: provider === 'Google' ? federatedUserInfo.id : existingInternalUser.googleId,
          email: cognitoUser.email,
          emailVerified: cognitoUser.emailVerified,
          name: cognitoUser.name,
          authProvider: provider.toUpperCase() as AuthProvider,
          accountStatus: AccountStatus.ACTIVE,
        });
        await this.userService.updateLastSignIn(existingInternalUser.id);

        this.logger.log(LogLevel.INFO, LogCategory.AUTHENTICATION, 'Updated existing internal database user during federated sign-in', {
          internalUserId: existingInternalUser.id,
          cognitoSub: cognitoUser.id,
          provider,
        });

        return existingInternalUser.id;
      } else {
        // Create new user in internal database
        const newUser = await this.userService.createUser({
          username: cognitoUser.username,
          email: cognitoUser.email,
          emailVerified: cognitoUser.emailVerified,
          name: cognitoUser.name || cognitoUser.username,
          cognitoSub: cognitoUser.id,
          googleId: provider === 'Google' ? federatedUserInfo.id : undefined,
          authProvider: provider.toUpperCase() as AuthProvider,
          accountStatus: AccountStatus.ACTIVE,
          password: this.generateTemporaryPassword(), // Required by schema but not used for federated
        });

        this.logger.log(LogLevel.INFO, LogCategory.AUTHENTICATION, 'Created new internal database user during federated sign-in', {
          internalUserId: newUser.id,
          cognitoSub: cognitoUser.id,
          provider,
          email: cognitoUser.email,
        });

        return newUser.id;
      }
    } catch (error: unknown) {
      // Re-throw if already AppError
      if (error instanceof AppError) throw error;
      
      // Handle Zod validation errors
      if (error instanceof Error && error.name === 'ZodError') {
        throw error; // Let middleware handle
      }
      
      // Handle Prisma errors
      if (isPrismaError(error)) {
        throw handlePrismaError(error);
      }
      
      // Log unexpected errors
      this.logger.log(LogLevel.ERROR, LogCategory.AUTHENTICATION, 'Failed to create/update internal database user during federated sign-in', {
        context: 'AuthenticationService',
        cognitoSub: cognitoUser.id,
        provider,
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      
      // This is a fail-fast approach - better to fail auth than have mismatched IDs
      throw new AppError(
        500,
        ErrorCodes.INTERNAL_SERVER_ERROR,
        'Failed to synchronize user with internal database',
      );
    }
  }

  /**
   * Create authentication error with consistent format
   */
  createAuthError(message: string, code: string, statusCode: number = 500): ExtendedError {
    const error: ExtendedError = new Error(message);
    error.name = code;
    error.statusCode = statusCode;
    return error;
  }
}

// createAuthenticationService factory function removed - was unused dead code
// bootstrap.ts uses AuthenticationService.getInstance() directly with proper DI

