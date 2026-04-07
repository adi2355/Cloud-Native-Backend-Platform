import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminUserGlobalSignOutCommand,
  AdminDeleteUserCommand,
  AdminUpdateUserAttributesCommand,
  GetUserCommand,
  InitiateAuthCommand,
  AuthFlowType,
  ChallengeNameType,
  AdminCreateUserCommand,
  AdminInitiateAuthCommand,
  AdminSetUserPasswordCommand,
  MessageActionType,
  AdminRespondToAuthChallengeCommand,
  AdminCreateUserCommandOutput,
  AdminInitiateAuthCommandOutput,
  AdminRespondToAuthChallengeCommandOutput,
} from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import {
  CognitoService as ICognitoService,
  CognitoTokenValidationResult,
  CognitoUser,
  CognitoGroupInfo,
  CognitoError,
  CognitoRefreshTokenResult,
  CognitoJWTPayload,
  CognitoConfig,
} from '../types/cognito.types';
import { LoggerService, LogLevel, LogCategory } from './logger.service';
import {
  getErrorMessage,
  getErrorStack,
  isPrismaError,
  getErrorCode,
  getErrorName,
} from '../utils/error-handler';
import { AppError, ErrorCodes } from '../utils/AppError';
import { handlePrismaError } from '../models';

// Type for JWT Verifier instances from aws-jwt-verify
type JwtVerifier = ReturnType<typeof CognitoJwtVerifier.create>;

// Response interface for refreshTokens method
interface RefreshTokensResponse {
  tokens: {
    idToken: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  };
}

export class CognitoService implements ICognitoService {
  public cognitoClient: CognitoIdentityProviderClient | null = null; // Made public for auth service access
  private idTokenVerifier: JwtVerifier | null = null;
  private accessTokenVerifier: JwtVerifier | null = null;
  private config: CognitoConfig | null = null;
  private isDevelopmentMode: boolean;
  private isInitialized: boolean = false;

  /**
   * Constructor with explicit dependency injection (Pure DI - no singleton)
   * All dependencies are required and injected by bootstrap.ts
   */
  public constructor(private logger: LoggerService) {
    // Lightweight constructor - configuration will be set via initialize() method
    this.isDevelopmentMode = false;
  }

  /**
   * Initialize the service with configuration
   * This should be called once during server initialization
   */
  public async initialize(config: CognitoConfig): Promise<void> {
    if (this.isInitialized) {
      this.logger.log(LogLevel.WARN, LogCategory.AUTHENTICATION,
        'CognitoService already initialized');
      return;
    }

    this.config = config;

    // Log the exact configuration being used for initialization
    this.logger.log(LogLevel.DEBUG, LogCategory.AUTHENTICATION, 'Initializing CognitoService with config:', {
      context: 'CognitoService.initialize',
      userPoolId: this.config.userPoolId ? `${this.config.userPoolId.substring(0, 10)}***` : 'MISSING',
      clientId: this.config.clientId ? `${this.config.clientId.substring(0, 10)}***` : 'MISSING',
      region: this.config.region,
      isDevelopmentMode: this.isDevelopmentMode,
    });

    // SECURITY FIX: Remove development mode bypass - always use production auth
    this.isDevelopmentMode = false;

    this.cognitoClient = new CognitoIdentityProviderClient({
      region: this.config.region,
    });

    // Log parameters passed to CognitoJwtVerifier.create
    this.logger.log(LogLevel.DEBUG, LogCategory.AUTHENTICATION, 'Creating CognitoJwtVerifier instances with:', {
      context: 'CognitoService.initialize',
      userPoolId: this.config?.userPoolId ? `${this.config.userPoolId.substring(0, 10)}***` : 'MISSING',
      clientId: this.config?.clientId ? `${this.config.clientId.substring(0, 10)}***` : 'MISSING',
      tokenUse: 'id/access',
    });

    // Create JWT verifiers
    this.idTokenVerifier = CognitoJwtVerifier.create({
      userPoolId: this.config?.userPoolId || '',
      tokenUse: 'id',
      clientId: this.config?.clientId || '',
    });

    this.accessTokenVerifier = CognitoJwtVerifier.create({
      userPoolId: this.config?.userPoolId || '',
      tokenUse: 'access',
      clientId: this.config?.clientId || '',
    });

    this.isInitialized = true;
    this.logger.log(LogLevel.INFO, LogCategory.AUTHENTICATION,
      'CognitoService initialized successfully', {
        userPoolId: `${this.config.userPoolId?.substring(0, 10)}***`,
        region: this.config.region,
      });
  }

  /**
   * Ensure service is initialized before use
   */
  private ensureInitialized(): void {
    if (!this.isInitialized || !this.config || !this.cognitoClient) {
      throw new AppError(
        503,
        ErrorCodes.SERVICE_UNAVAILABLE,
        'Authentication service not initialized',
      );
    }
  }

  /**
   * Validate a Cognito JWT token with comprehensive debugging
   */
  async validateToken(token: string): Promise<CognitoTokenValidationResult> {
    const startTime = Date.now();

    try {
      this.ensureInitialized();

      // Log the incoming token (truncated for security) and initial state
      this.logger.log(LogLevel.DEBUG, LogCategory.AUTHENTICATION, 'Starting token validation.', {
        context: 'CognitoService.validateToken',
        token_prefix: `${token.substring(0, 30)  }...`,
        isProperlyConfigured: this.isProperlyConfigured(),
      });

      // Enhanced security check with detailed logging
      if (!this.isProperlyConfigured()) {
        this.logger.error('SECURITY: Cognito not properly configured or using test placeholder IDs - rejecting all tokens.', {
          context: 'CognitoService.validateToken',
          userPoolId: this.config?.userPoolId,
          clientId: this.config?.clientId,
          region: this.config?.region,
          reason: 'Configuration is marked as insecure or incomplete for token validation',
        });
        return {
          isValid: false,
          error: 'Authentication service not configured for secure token validation',
          errorCode: 'SERVICE_UNAVAILABLE',
        };
      }

      let payload;
      let tokenType: 'id' | 'access' = 'id';

      // Attempt ID token verification
      this.logger.log(LogLevel.DEBUG, LogCategory.AUTHENTICATION, 'Attempting ID token verification...', {
        context: 'CognitoService.validateToken',
      });
      try {
        if (!this.idTokenVerifier) {
          throw new Error('ID token verifier not initialized');
        }
        payload = await this.idTokenVerifier.verify(token);
        tokenType = 'id';
        this.logger.log(LogLevel.DEBUG, LogCategory.AUTHENTICATION, 'ID token verification successful.', {
          context: 'CognitoService.validateToken',
          payload_sub: payload.sub,
          payload_email: payload.email,
          tokenUse: payload.token_use,
        });
      } catch (idError: unknown) {
        this.logger.log(LogLevel.WARN, LogCategory.AUTHENTICATION, 'ID token verification failed, trying Access token.', {
          context: 'CognitoService.validateToken',
          idError_message: getErrorMessage(idError),
          idError_name: getErrorName(idError),
        });

        // If ID token verification fails, try access token
        try {
          this.logger.log(LogLevel.DEBUG, LogCategory.AUTHENTICATION, 'Attempting Access token verification...', {
            context: 'CognitoService.validateToken',
          });
          if (!this.accessTokenVerifier) {
            throw new Error('Access token verifier not initialized');
          }
          payload = await this.accessTokenVerifier.verify(token);
          tokenType = 'access';
          this.logger.log(LogLevel.DEBUG, LogCategory.AUTHENTICATION, 'Access token verification successful.', {
            context: 'CognitoService.validateToken',
            payload_sub: payload.sub,
            payload_username: payload.username,
            tokenUse: payload.token_use,
          });
        } catch (accessError: unknown) {
          this.logger.error('Access token verification also failed.', {
            context: 'CognitoService.validateToken',
            accessError_message: getErrorMessage(accessError),
            accessError_name: getErrorName(accessError),
            accessError_stack: getErrorStack(accessError),
            validation_duration: Date.now() - startTime,
          });
          return {
            isValid: false,
            error: 'Invalid or expired token',
            errorCode: 'INVALID_TOKEN',
          };
        }
      }

      // After successful verification, log payload for detailed inspection
      this.logger.log(LogLevel.DEBUG, LogCategory.AUTHENTICATION, 'Token successfully verified by aws-jwt-verify. Starting internal payload validation.', {
        context: 'CognitoService.validateToken',
        tokenType,
        payload: {
          sub: payload.sub,
          aud: payload.aud,
          iss: payload.iss,
          exp: new Date(payload.exp * 1000).toISOString(),
          iat: new Date(payload.iat * 1000).toISOString(),
          token_use: payload.token_use,
          'cognito:username': payload['cognito:username'],
          email: payload.email,
        },
      });

      // Additional custom validation (cast payload to our CognitoJWTPayload type)
      const validationError = this.validateTokenPayload(payload as unknown as CognitoJWTPayload);
      if (validationError) {
        this.logger.log(LogLevel.WARN, LogCategory.AUTHENTICATION, 'Internal token payload validation failed.', {
          context: 'CognitoService.validateToken',
          validationError,
          payload_sub: payload.sub,
          payload_aud: payload.aud,
          payload_iss: payload.iss,
          config_clientId: this.config!.clientId,
          tokenUse: payload.token_use,
          validation_duration: Date.now() - startTime,
        });
        return {
          isValid: false,
          error: validationError,
          errorCode: 'INVALID_TOKEN',
        };
      }
      this.logger.log(LogLevel.DEBUG, LogCategory.AUTHENTICATION, 'Internal token payload validation passed.', {
        context: 'CognitoService.validateToken',
        payload_sub: payload.sub,
      });

      // Convert payload to user object (cast to our CognitoJWTPayload interface for consistency)
      const typedPayload = payload as unknown as CognitoJWTPayload;
      const user = this.payloadToUser(typedPayload, tokenType);
      this.logger.log(LogLevel.DEBUG, LogCategory.AUTHENTICATION, 'Payload successfully converted to CognitoUser object.', {
        context: 'CognitoService.validateToken',
        user_id: user.id,
      });

      const validationDuration = Date.now() - startTime;
      this.logger.log(LogLevel.INFO, LogCategory.AUTHENTICATION, 'Token validation completed successfully.', {
        context: 'CognitoService.validateToken',
        user_id: user.id,
        tokenType,
        validation_duration_ms: validationDuration,
      });

      return {
        isValid: true,
        payload: typedPayload,
        user,
      };
    } catch (error: unknown) {
      const validationDuration = Date.now() - startTime;
      this.logger.error('CognitoService.validateToken() caught an unexpected error during processing.', {
        context: 'CognitoService.validateToken.catch',
        error_message: getErrorMessage(error),
        error_name: getErrorName(error),
        error_stack: getErrorStack(error),
        original_error_details: error,
        validation_duration_ms: validationDuration,
      });

      let errorCode: string = 'VERIFICATION_FAILED';
      const errorMessage = getErrorMessage(error);
      if (errorMessage?.includes('expired')) {
        errorCode = 'EXPIRED_TOKEN';
      } else if (errorMessage?.includes('malformed')) {
        errorCode = 'MALFORMED_TOKEN';
      }

      return {
        isValid: false,
        error: errorMessage || 'Token validation failed',
        errorCode,
      };
    }
  }

  /**
   * Enhanced `isProperlyConfigured` for clarity.
   * This helper method's logic is critical for the `validateToken` flow.
   */
  private isProperlyConfigured(): boolean {
    const isUserPoolIdValid = !!this.config?.userPoolId && !this.config.userPoolId.includes('TestPool') && !this.config.userPoolId.includes('TEMP');
    const isClientIdValid = !!this.config?.clientId && !this.config.clientId.includes('TestClient') && !this.config.clientId.includes('TEMP');
    const isRegionValid = !!this.config?.region;

    if (!isUserPoolIdValid) {
      this.logger.error('Configuration check failed: User Pool ID is missing or contains test placeholders.', {
        context: 'CognitoService.isProperlyConfigured',
        userPoolId: this.config?.userPoolId,
      });
    }
    if (!isClientIdValid) {
      this.logger.error('Configuration check failed: Client ID is missing or contains test placeholders.', {
        context: 'CognitoService.isProperlyConfigured',
        clientId: this.config?.clientId,
      });
    }
    if (!isRegionValid) {
      this.logger.warn('Configuration check: Region is missing.', {
        context: 'CognitoService.isProperlyConfigured',
        region: this.config?.region,
      });
    }

    return isUserPoolIdValid && isClientIdValid && isRegionValid;
  }

  /**
   * Validate token payload claims with detailed logging
   * This method is called after `aws-jwt-verify` confirms signature and basic claims.
   */
  private validateTokenPayload(payload: CognitoJWTPayload): string | null {
    // Log the payload claims against configured values at the start of this function
    this.logger.log(LogLevel.DEBUG, LogCategory.AUTHENTICATION, 'Starting internal payload claim validation.', {
      context: 'CognitoService.validateTokenPayload',
      payload_sub: payload.sub,
      payload_aud: payload.aud,
      payload_iss: payload.iss,
      payload_token_use: payload.token_use,
      config_clientId: this.config!.clientId,
      current_time_epoch: Math.floor(Date.now() / 1000),
      payload_exp_epoch: payload.exp,
      payload_iat_epoch: payload.iat,
    });

    // Check required claims
    if (!payload.sub) {
      this.logger.log(LogLevel.WARN, LogCategory.AUTHENTICATION, 'Payload validation failed: Missing subject (sub) claim.', {
        context: 'CognitoService.validateTokenPayload',
      });
      return 'Missing subject (sub) claim';
    }

    // IMPORTANT: Verify Audience/ClientId match your Cognito User Pool App Client
    // ID tokens use 'aud' claim, Access tokens use 'client_id' claim
    const expectedClientId = this.config!.clientId;
    const tokenClientId = payload.aud || payload.client_id;

    if (!tokenClientId || tokenClientId !== expectedClientId) {
      this.logger.log(LogLevel.WARN, LogCategory.AUTHENTICATION, 'Payload validation failed: Invalid audience/client_id claim.', {
        context: 'CognitoService.validateTokenPayload',
        expected_clientId: expectedClientId,
        received_aud: payload.aud,
        received_client_id: payload.client_id,
        token_use: payload.token_use,
      });
      return 'Invalid audience/client_id claim';
    }

    // Build expected issuer from userPoolId
    const expectedIssuer = `https://cognito-idp.${this.config!.region}.amazonaws.com/${this.config!.userPoolId}`;
    if (!payload.iss || payload.iss !== expectedIssuer) {
      this.logger.log(LogLevel.WARN, LogCategory.AUTHENTICATION, 'Payload validation failed: Invalid issuer claim.', {
        context: 'CognitoService.validateTokenPayload',
        expected_iss: expectedIssuer,
        received_iss: payload.iss,
      });
      return 'Invalid issuer claim';
    }

    if (!payload.token_use || !['id', 'access'].includes(payload.token_use)) {
      this.logger.log(LogLevel.WARN, LogCategory.AUTHENTICATION, 'Payload validation failed: Invalid token_use claim.', {
        context: 'CognitoService.validateTokenPayload',
        received_token_use: payload.token_use,
      });
      return 'Invalid token_use claim';
    }

    // Check expiration (this is usually handled by jwt.verify itself, but good to double-check)
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) {
      this.logger.log(LogLevel.WARN, LogCategory.AUTHENTICATION, 'Payload validation failed: Token has expired.', {
        context: 'CognitoService.validateTokenPayload',
        expiry_time: new Date(payload.exp * 1000),
        current_time: new Date(),
      });
      return 'Token has expired';
    }

    this.logger.log(LogLevel.DEBUG, LogCategory.AUTHENTICATION, 'Internal payload claim validation passed.', {
      context: 'CognitoService.validateTokenPayload',
      payload_sub: payload.sub,
    });
    return null;
  }

  /**
   * Convert JWT payload to CognitoUser object
   */
  private payloadToUser(payload: CognitoJWTPayload, tokenType: 'id' | 'access'): CognitoUser {
    const user: CognitoUser = {
      id: payload.sub,
      username: payload['cognito:username'],
      email: payload.email,
      emailVerified: payload.email_verified,
      groups: payload['cognito:groups'] || [],
      attributes: {},
      enabled: true,
      status: 'CONFIRMED',
    };

    // Add custom attributes
    if (tokenType === 'id') {
      user.name = payload.name;
      user.attributes = user.attributes || {};
      if (payload.given_name) user.attributes.given_name = payload.given_name;
      if (payload.family_name) user.attributes.family_name = payload.family_name;

      // Extract custom attributes with proper type handling
      const payloadRecord = payload as Record<string, unknown>;
      Object.keys(payloadRecord).forEach(key => {
        if (key.startsWith('custom:')) {
          const value = payloadRecord[key];
          user.attributes![key.replace('custom:', '')] = typeof value === 'string' ? value : String(value);
        }
      });
    }

    return user;
  }

  /**
   * Get user information by username (admin operation)
   */
  async adminGetUser(username: string): Promise<CognitoUser> {
    try {
      this.ensureInitialized();

      // SECURITY FIX: Always use real Cognito authentication, no mock data
      const command = new AdminGetUserCommand({
        UserPoolId: this.config!.userPoolId,
        Username: username,
      });

      const response = await this.cognitoClient!.send(command);

      const attributes: Record<string, string> = {};
      response.UserAttributes?.forEach(attr => {
        if(attr.Name && attr.Value) {
            attributes[attr.Name] = attr.Value;
        }
      });

      const user: CognitoUser = {
        id: response.UserAttributes?.find(attr => attr.Name === 'sub')?.Value || '',
        username: response.Username!,
        email: response.UserAttributes?.find(attr => attr.Name === 'email')?.Value,
        emailVerified: response.UserAttributes?.find(attr => attr.Name === 'email_verified')?.Value === 'true',
        name: response.UserAttributes?.find(attr => attr.Name === 'name')?.Value,
        groups: [],
        attributes,
        enabled: response.Enabled,
        status: response.UserStatus,
      };

      return user;
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
      
      // Log detailed error information for debugging AWS SDK errors
      const errorDetails = {
        context: 'CognitoService.adminGetUser',
        username,
        errorMessage: getErrorMessage(error),
        errorStack: getErrorStack(error),
        errorName: getErrorName(error),
        errorCode: getErrorCode(error),
        // Log raw error structure to see AWS SDK format
        rawError: error && typeof error === 'object' ? {
          name: (error as { name?: unknown }).name,
          code: (error as { code?: unknown }).code,
          message: (error as { message?: unknown }).message,
          $metadata: (error as { $metadata?: unknown }).$metadata,
        } : 'not an object',
      };

      this.logger.log(LogLevel.ERROR, LogCategory.AUTHENTICATION, 'AdminGetUser failed - detailed error info', errorDetails);

      // Re-throw the original error for specific Cognito error handling
      throw error;
    }
  }

  /**
   * Get user information from Cognito
   */
  async getUserInfo(accessToken: string): Promise<CognitoUser> {
    try {
      this.ensureInitialized();
      
      const command = new GetUserCommand({
        AccessToken: accessToken,
      });

      const response = await this.cognitoClient!.send(command);

      const attributes: Record<string, string> = {};
      response.UserAttributes?.forEach(attr => {
        if(attr.Name && attr.Value) {
            attributes[attr.Name] = attr.Value;
        }
      });

      const user: CognitoUser = {
        id: response.UserAttributes?.find(attr => attr.Name === 'sub')?.Value || '',
        username: response.Username!,
        email: response.UserAttributes?.find(attr => attr.Name === 'email')?.Value,
        emailVerified: response.UserAttributes?.find(attr => attr.Name === 'email_verified')?.Value === 'true',
        name: response.UserAttributes?.find(attr => attr.Name === 'name')?.Value,
        attributes,
        enabled: true,
        status: 'CONFIRMED',
      };

      return user;
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
      this.logger.log(LogLevel.ERROR, LogCategory.AUTHENTICATION, 'Failed to get user info', { 
        context: 'CognitoService', 
        error: getErrorMessage(error), 
        stack: getErrorStack(error), 
      });
      
      // Throw generic AppError
      throw new AppError(500, ErrorCodes.INTERNAL_SERVER_ERROR, 'Failed to get user info');
    }
  }

  /**
   * Get user groups
   */
  async getUserGroups(username: string): Promise<CognitoGroupInfo[]> {
    try {
      this.ensureInitialized();
      
      const command = new AdminListGroupsForUserCommand({
        UserPoolId: this.config!.userPoolId,
        Username: username,
      });

      const response = await this.cognitoClient!.send(command);

      return (response.Groups || []).map(group => ({
        groupName: group.GroupName!,
        description: group.Description,
        precedence: group.Precedence,
        roleArn: group.RoleArn,
      }));
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
      this.logger.log(LogLevel.ERROR, LogCategory.AUTHENTICATION, 'Failed to get user groups', { 
        context: 'CognitoService', 
        error: getErrorMessage(error), 
        stack: getErrorStack(error), 
      });
      
      // Throw generic AppError
      throw new AppError(500, ErrorCodes.INTERNAL_SERVER_ERROR, 'Failed to get user groups');
    }
  }

  /**
   * @deprecated Use refreshTokens instead
   * This method is kept for backwards compatibility but throws an error
   */
  async refreshToken(refreshToken: string): Promise<CognitoRefreshTokenResult> {
    // SECURITY FIX: Consolidate on single refreshTokens implementation
    // Redirect to the proper implementation
    const result = await this.refreshTokens(refreshToken);
    return {
      accessToken: result.tokens.accessToken,
      idToken: result.tokens.idToken,
      expiresAt: result.tokens.expiresAt,
    };
  }

  /**
   * Revoke token (sign out)
   */
  async revokeToken(token: string): Promise<void> {
    try {
      this.ensureInitialized();
      
      // Validate the token first
      const validation = await this.validateToken(token);
      if (!validation.isValid || !validation.user) {
        throw new AppError(
          401,
          ErrorCodes.UNAUTHORIZED,
          'Invalid token',
        );
      }

      const command = new AdminUserGlobalSignOutCommand({
        UserPoolId: this.config!.userPoolId,
        Username: validation.user.username,
      });

      await this.cognitoClient!.send(command);
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
      this.logger.log(LogLevel.ERROR, LogCategory.AUTHENTICATION, 'Failed to revoke token', { 
        context: 'CognitoService', 
        error: getErrorMessage(error), 
        stack: getErrorStack(error), 
      });
      
      // Throw generic AppError
      throw new AppError(500, ErrorCodes.INTERNAL_SERVER_ERROR, 'Failed to revoke token');
    }
  }

  /**
   * Helper to create standardized Cognito errors
   */
  private createCognitoError(error: unknown): CognitoError {
    const cognitoError: CognitoError = {
      name: getErrorName(error),
      message: getErrorMessage(error) || 'Cognito operation failed',
      code: getErrorCode(error),
      statusCode: (error && typeof error === 'object' && '$metadata' in error && error.$metadata && typeof error.$metadata === 'object' && 'httpStatusCode' in error.$metadata && typeof error.$metadata.httpStatusCode === 'number') ? error.$metadata.httpStatusCode : 500,
      retryable: (error && typeof error === 'object' && '$retryable' in error && error.$retryable && typeof error.$retryable === 'object' && 'throttling' in error.$retryable) ? Boolean(error.$retryable.throttling) : false,
    };

    return cognitoError;
  }

  // Duplicate adminGetUser function removed - using the one defined earlier in the file

  async adminDeleteUser(username: string): Promise<void> {
    try {
      this.ensureInitialized();
      
      const command = new AdminDeleteUserCommand({
        UserPoolId: this.config!.userPoolId,
        Username: username,
      });

      await this.cognitoClient!.send(command);
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
      this.logger.log(LogLevel.ERROR, LogCategory.AUTHENTICATION, 'Admin delete user failed', { 
        context: 'CognitoService', 
        error: getErrorMessage(error), 
        stack: getErrorStack(error), 
      });
      
      // Throw generic AppError
      throw new AppError(500, ErrorCodes.INTERNAL_SERVER_ERROR, 'Failed to delete user');
    }
  }

  async adminUpdateUserAttributes(
    username: string,
    attributes: Record<string, string>,
  ): Promise<void> {
    try {
      this.ensureInitialized();
      
      const userAttributes = Object.entries(attributes).map(([name, value]) => ({
        Name: name.startsWith('custom:') ? name : `custom:${name}`,
        Value: value,
      }));

      const command = new AdminUpdateUserAttributesCommand({
        UserPoolId: this.config!.userPoolId,
        Username: username,
        UserAttributes: userAttributes,
      });

      await this.cognitoClient!.send(command);
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
      this.logger.log(LogLevel.ERROR, LogCategory.AUTHENTICATION, 'Admin update user attributes failed', { 
        context: 'CognitoService', 
        error: getErrorMessage(error), 
        stack: getErrorStack(error), 
      });
      
      // Throw generic AppError
      throw new AppError(500, ErrorCodes.INTERNAL_SERVER_ERROR, 'Failed to update user attributes');
    }
  }

  /**
   * Refresh tokens using a valid refresh token
   */
  async refreshTokens(refreshToken: string): Promise<RefreshTokensResponse> {
    const startTime = Date.now();
    this.ensureInitialized();
    
    // Validate input
    if (!refreshToken || typeof refreshToken !== 'string') {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        'Valid refresh token is required',
      );
    }

    // Check token format (basic validation)
    if (refreshToken.length < 10) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        'Invalid refresh token format',
      );
    }

    // SECURITY FIX: Remove all development mode token generation
    // Always use real Cognito authentication

    try {
      // Use InitiateAuth instead of AdminInitiateAuth for proper OAuth 2.0 compliance
      const command = new InitiateAuthCommand({
        ClientId: this.config!.clientId,
        AuthFlow: AuthFlowType.REFRESH_TOKEN_AUTH,
        AuthParameters: {
          REFRESH_TOKEN: refreshToken,
        },
      });

      const response = await this.cognitoClient!.send(command);

      if (!response.AuthenticationResult) {
        throw new AppError(
          500,
          ErrorCodes.INTERNAL_SERVER_ERROR,
          'Token refresh failed - no authentication result',
        );
      }

      // Validate required tokens are present
      if (!response.AuthenticationResult.IdToken || !response.AuthenticationResult.AccessToken) {
        throw new AppError(
          500,
          ErrorCodes.INTERNAL_SERVER_ERROR,
          'Token refresh failed - missing required tokens',
        );
      }

      // Calculate expiration time
      const expiresIn = response.AuthenticationResult.ExpiresIn || 3600;
      const expiresAt = Date.now() + (expiresIn * 1000);

      // Log successful refresh
      this.logger.info('Token refresh successful', {
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        expiresIn,
      });

      return {
        tokens: {
          idToken: response.AuthenticationResult.IdToken,
          accessToken: response.AuthenticationResult.AccessToken,
          refreshToken: response.AuthenticationResult.RefreshToken || refreshToken,
          expiresAt,
        },
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
        context: 'CognitoService',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
        duration: Date.now() - startTime,
      });

      // Transform common Cognito errors
      const errorName = getErrorName(error);
      if (errorName === 'NotAuthorizedException') {
        throw new AppError(
          401,
          ErrorCodes.UNAUTHORIZED,
          'Refresh token expired or invalid',
        );
      } else if (errorName === 'UserNotFoundException') {
        throw new AppError(
          404,
          ErrorCodes.NOT_FOUND,
          'User not found',
        );
      } else {
        throw new AppError(
          500,
          ErrorCodes.INTERNAL_SERVER_ERROR,
          'Token refresh failed',
        );
      }
    }
  }

  /**
   * Globally sign out user from all devices
   */
  async globalSignOut(accessToken: string): Promise<void> {
    try {
      this.ensureInitialized();
      
      // First get the user to extract the username
      const getUserCommand = new GetUserCommand({
        AccessToken: accessToken,
      });
      
      const userResponse = await this.cognitoClient!.send(getUserCommand);
      const username = userResponse.Username;

      if (!username) {
        throw new AppError(
          500,
          ErrorCodes.INTERNAL_SERVER_ERROR,
          'Unable to process sign out request',
        );
      }

      // Perform global sign out
      const signOutCommand = new AdminUserGlobalSignOutCommand({
        UserPoolId: this.config!.userPoolId,
        Username: username,
      });

      await this.cognitoClient!.send(signOutCommand);
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
      this.logger.log(LogLevel.ERROR, LogCategory.AUTHENTICATION, 'Global sign out failed', { 
        context: 'CognitoService', 
        error: getErrorMessage(error), 
        stack: getErrorStack(error), 
      });
      
      // Throw generic AppError
      throw new AppError(500, ErrorCodes.INTERNAL_SERVER_ERROR, 'Failed to sign out user');
    }
  }

  /**
   * Create a new user in Cognito User Pool (admin operation)
   * Used for federated authentication to create users without sending welcome emails
   */
  async adminCreateUser(params: {
    username: string;
    temporaryPassword?: string;
    userAttributes?: Array<{ Name: string; Value: string }>;
    messageAction?: MessageActionType;
    forceAliasCreation?: boolean;
  }): Promise<AdminCreateUserCommandOutput> {
    try {
      this.ensureInitialized();
      
      const command = new AdminCreateUserCommand({
        UserPoolId: this.config!.userPoolId,
        Username: params.username,
        TemporaryPassword: params.temporaryPassword,
        UserAttributes: params.userAttributes,
        MessageAction: params.messageAction || MessageActionType.SUPPRESS,
        ForceAliasCreation: params.forceAliasCreation || false,
      });

      const response = await this.cognitoClient!.send(command);
      
      this.logger.log(LogLevel.INFO, LogCategory.AUTHENTICATION, 'User created in Cognito', {
        username: params.username,
        userStatus: response.User?.UserStatus,
      });
      
      return response;
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
      
      // Log detailed error information for debugging AWS SDK errors
      const errorDetails = {
        context: 'CognitoService.adminCreateUser',
        username: params.username,
        errorMessage: getErrorMessage(error),
        errorStack: getErrorStack(error),
        errorName: getErrorName(error),
        errorCode: getErrorCode(error),
        // Log raw error structure to see AWS SDK format
        rawError: error && typeof error === 'object' ? {
          name: (error as { name?: unknown }).name,
          code: (error as { code?: unknown }).code,
          message: (error as { message?: unknown }).message,
          $metadata: (error as { $metadata?: unknown }).$metadata,
        } : 'not an object',
      };

      this.logger.log(LogLevel.ERROR, LogCategory.AUTHENTICATION, 'Failed to create user in Cognito - detailed error info', errorDetails);

      // Re-throw the original error for specific Cognito error handling
      throw error;
    }
  }

  /**
   * Initiate authentication flow (admin operation)
   * Used for authenticating users with various auth flows
   */
  async adminInitiateAuth(params: {
    username: string;
    authFlow: AuthFlowType;
    authParameters: Record<string, string>;
    clientMetadata?: Record<string, string>;
  }): Promise<AdminInitiateAuthCommandOutput> {
    try {
      this.ensureInitialized();
      
      const command = new AdminInitiateAuthCommand({
        UserPoolId: this.config!.userPoolId,
        ClientId: this.config!.clientId,
        AuthFlow: params.authFlow,
        AuthParameters: params.authParameters,
        ClientMetadata: params.clientMetadata,
      });

      const response = await this.cognitoClient!.send(command);
      
      if (response.AuthenticationResult) {
        this.logger.log(LogLevel.INFO, LogCategory.AUTHENTICATION, 'Authentication successful', {
          username: params.username,
          authFlow: params.authFlow,
        });
      } else if (response.ChallengeName) {
        this.logger.log(LogLevel.INFO, LogCategory.AUTHENTICATION, 'Authentication challenge received', {
          username: params.username,
          challenge: response.ChallengeName,
        });
      }
      
      return response;
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
      
      // Log detailed error information for debugging AWS SDK errors
      const errorDetails = {
        context: 'CognitoService.adminInitiateAuth',
        username: params.username,
        authFlow: params.authFlow,
        errorMessage: getErrorMessage(error),
        errorStack: getErrorStack(error),
        errorName: getErrorName(error),
        errorCode: getErrorCode(error),
        // Log raw error structure to see AWS SDK format
        rawError: error && typeof error === 'object' ? {
          name: (error as { name?: unknown }).name,
          code: (error as { code?: unknown }).code,
          message: (error as { message?: unknown }).message,
          $metadata: (error as { $metadata?: unknown }).$metadata,
        } : 'not an object',
      };

      this.logger.log(LogLevel.ERROR, LogCategory.AUTHENTICATION, 'Failed to initiate auth - detailed error info', errorDetails);

      // Re-throw the original error for specific Cognito error handling
      throw error;
    }
  }

  /**
   * Set a permanent password for a user (admin operation)
   * Used to bypass the FORCE_CHANGE_PASSWORD state for federated users
   */
  async adminSetUserPassword(username: string, password: string, permanent: boolean = true): Promise<void> {
    try {
      this.ensureInitialized();
      
      const command = new AdminSetUserPasswordCommand({
        UserPoolId: this.config!.userPoolId,
        Username: username,
        Password: password,
        Permanent: permanent,
      });

      await this.cognitoClient!.send(command);
      
      this.logger.log(LogLevel.INFO, LogCategory.AUTHENTICATION, 'User password set', {
        username,
        permanent,
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
      
      // Log detailed error information for debugging AWS SDK errors
      const errorDetails = {
        context: 'CognitoService.adminSetUserPassword',
        username,
        permanent,
        errorMessage: getErrorMessage(error),
        errorStack: getErrorStack(error),
        errorName: getErrorName(error),
        errorCode: getErrorCode(error),
        // Log raw error structure to see AWS SDK format
        rawError: error && typeof error === 'object' ? {
          name: (error as { name?: unknown }).name,
          code: (error as { code?: unknown }).code,
          message: (error as { message?: unknown }).message,
          $metadata: (error as { $metadata?: unknown }).$metadata,
        } : 'not an object',
      };

      this.logger.log(LogLevel.ERROR, LogCategory.AUTHENTICATION, 'Failed to set user password - detailed error info', errorDetails);
      
      // Re-throw the original error for specific Cognito error handling
      throw error;
    }
  }

  /**
   * Respond to an authentication challenge (admin operation)
   * Used to handle various authentication challenges like NEW_PASSWORD_REQUIRED
   */
  async adminRespondToAuthChallenge(params: {
    username: string;
    challengeName: ChallengeNameType;
    challengeResponses: Record<string, string>;
    session?: string;
    clientMetadata?: Record<string, string>;
  }): Promise<AdminRespondToAuthChallengeCommandOutput> {
    try {
      this.ensureInitialized();
      
      const command = new AdminRespondToAuthChallengeCommand({
        UserPoolId: this.config!.userPoolId,
        ClientId: this.config!.clientId,
        ChallengeName: params.challengeName,
        ChallengeResponses: {
          USERNAME: params.username,
          ...params.challengeResponses,
        },
        Session: params.session,
        ClientMetadata: params.clientMetadata,
      });

      const response = await this.cognitoClient!.send(command);
      
      if (response.AuthenticationResult) {
        this.logger.log(LogLevel.INFO, LogCategory.AUTHENTICATION, 'Challenge response successful', {
          username: params.username,
          challengeName: params.challengeName,
        });
      } else if (response.ChallengeName) {
        this.logger.log(LogLevel.INFO, LogCategory.AUTHENTICATION, 'New challenge received', {
          username: params.username,
          newChallenge: response.ChallengeName,
        });
      }
      
      return response;
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
      this.logger.log(LogLevel.ERROR, LogCategory.AUTHENTICATION, 'Failed to respond to auth challenge', {
        context: 'CognitoService',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
        username: params.username,
        challengeName: params.challengeName,
      });
      
      // Re-throw the original error for specific Cognito error handling
      throw error;
    }
  }
}

// Export singleton instance
// Class export only - instance should be created in bootstrap.ts with explicit dependencies