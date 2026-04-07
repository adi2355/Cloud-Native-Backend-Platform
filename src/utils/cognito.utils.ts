/**
 * AWS Cognito utilities for token validation and user management
 * Provides comprehensive Cognito integration capabilities
 */

import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { 
  CognitoConfig, 
  CognitoJWTPayload, 
  CognitoTokenValidationResult, 
  CognitoUser,
  CognitoError,
} from '../types/cognito.types';
import { LoggerService } from '../services/logger.service';

// Additional interfaces needed for this utility
export interface CognitoConfigValidation {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

export interface JWKSClientConfig {
  cacheMaxAge?: number; // milliseconds, default 24 hours
  rateLimit?: boolean;
  jwksRequestsPerMinute?: number;
}

export interface ExtendedCognitoConfig extends CognitoConfig {
  jwksUri?: string;
  issuer?: string;
  jwksConfig?: JWKSClientConfig;
}

export class CognitoUtils {
  private config: ExtendedCognitoConfig;
  private jwksClient?: jwksClient.JwksClient;

  constructor(config: CognitoConfig | ExtendedCognitoConfig, private logger: LoggerService) {
    this.config = { ...config };
    this.initializeConfig();
    this.initializeJWKSClient();
  }

  /**
   * Initialize configuration with defaults
   */
  private initializeConfig(): void {
    if (!this.config.jwksUri) {
      this.config.jwksUri = `https://cognito-idp.${this.config.region}.amazonaws.com/${this.config.userPoolId}/.well-known/jwks.json`;
    }

    if (!this.config.issuer) {
      this.config.issuer = `https://cognito-idp.${this.config.region}.amazonaws.com/${this.config.userPoolId}`;
    }
  }

  /**
   * Initialize JWKS client for key retrieval
   */
  private initializeJWKSClient(): void {
    if (!this.config.jwksUri) {
      this.logger.warn('JWKS URI not configured - JWKS client initialization skipped');
      return;
    }

    // Use externalized JWKS config with sensible defaults
    const jwksConfig = this.config.jwksConfig || {};
    const cacheMaxAge = jwksConfig.cacheMaxAge ?? 24 * 60 * 60 * 1000; // Default 24 hours
    const rateLimit = jwksConfig.rateLimit ?? true;
    const jwksRequestsPerMinute = jwksConfig.jwksRequestsPerMinute ?? 10;

    this.jwksClient = jwksClient({
      jwksUri: this.config.jwksUri,
      cache: true,
      cacheMaxAge,
      rateLimit,
      jwksRequestsPerMinute,
      requestHeaders: {
        'User-Agent': 'AppPlatform-Backend/1.0.0',
      },
    });

    this.logger.info('JWKS client initialized', {
      jwksUri: this.config.jwksUri,
      cacheMaxAge,
      rateLimit,
      jwksRequestsPerMinute,
    });
  }

  /**
   * Validate Cognito JWT token
   */
  async validateToken(token: string): Promise<CognitoTokenValidationResult> {
    try {
      // Decode token header to get key ID
      const decodedHeader = jwt.decode(token, { complete: true });
      
      if (!decodedHeader || !decodedHeader.header.kid) {
        return {
          isValid: false,
          error: 'Invalid token format or missing key ID',
          errorCode: 'MALFORMED_TOKEN',
        };
      }

      // Get signing key from JWKS
      const key = await this.getSigningKey(decodedHeader.header.kid);
      
      if (!key) {
        return {
          isValid: false,
          error: 'Unable to find signing key',
          errorCode: 'VERIFICATION_FAILED',
        };
      }

      // Verify and decode token
      const payload = jwt.verify(token, key, {
        issuer: this.config.issuer,
        audience: this.config.clientId,
      }) as CognitoJWTPayload;

      // Additional validation
      const validationError = this.validateTokenPayload(payload);
      if (validationError) {
        return {
          isValid: false,
          error: validationError,
          errorCode: 'INVALID_TOKEN',
        };
      }

      // Convert payload to user object
      const user = this.payloadToUser(payload);

      return {
        isValid: true,
        payload,
        user,
      };

    } catch (error) {
      this.logger.error('Cognito token validation error:', { error: error instanceof Error ? error.message : String(error) });

      if (error instanceof jwt.TokenExpiredError) {
        return {
          isValid: false,
          error: 'Token has expired',
          errorCode: 'EXPIRED_TOKEN',
        };
      }

      if (error instanceof jwt.JsonWebTokenError) {
        return {
          isValid: false,
          error: 'Invalid token',
          errorCode: 'INVALID_TOKEN',
        };
      }

      return {
        isValid: false,
        error: 'Token validation failed',
        errorCode: 'VERIFICATION_FAILED',
      };
    }
  }

  /**
   * Get signing key from JWKS endpoint
   * Retrieves the public key for JWT signature verification
   */
  private async getSigningKey(kid: string): Promise<string | null> {
    try {
      if (!this.jwksClient) {
        this.logger.warn('JWKS client not initialized - cannot retrieve signing key');
        return null;
      }

      this.logger.debug('Retrieving signing key', { kid });

      const key = await this.jwksClient.getSigningKey(kid);
      const publicKey = key.getPublicKey();

      this.logger.debug('Successfully retrieved signing key', { kid });
      return publicKey;
    } catch (error: unknown) {
      const errorName = error && typeof error === 'object' && 'name' in error && typeof error.name === 'string' ? error.name : 'UnknownError';
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.logger.error('Error getting signing key', {
        kid,
        error: errorMessage,
        errorName,
        jwksUri: this.config.jwksUri,
      });

      // Handle specific JWKS errors
      if (errorName === 'SigningKeyNotFoundError') {
        this.logger.warn('Signing key not found', { kid });
      } else if (errorName === 'JwksRateLimitError') {
        this.logger.warn('JWKS rate limit exceeded - consider increasing cache TTL');
      } else if (errorName === 'JwksError') {
        this.logger.warn('JWKS endpoint error - check network connectivity');
      }

      return null;
    }
  }

  /**
   * Validate token payload structure and claims
   */
  private validateTokenPayload(payload: CognitoJWTPayload): string | null {
    // Check required claims
    if (!payload.sub) {
      return 'Missing subject (sub) claim';
    }

    if (!payload.aud || payload.aud !== this.config.clientId) {
      return 'Invalid audience claim';
    }

    if (!payload.iss || payload.iss !== this.config.issuer) {
      return 'Invalid issuer claim';
    }

    if (!payload.token_use || !['id', 'access'].includes(payload.token_use)) {
      return 'Invalid token_use claim';
    }

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) {
      return 'Token has expired';
    }

    return null;
  }

  /**
   * Convert token payload to user object
   */
  private payloadToUser(payload: CognitoJWTPayload): CognitoUser {
    // Safely extract preferred_username if it exists
    const preferredUsername = typeof payload.preferred_username === 'string' ? payload.preferred_username : undefined;

    return {
      id: payload.sub,
      username: payload['cognito:username'] || preferredUsername || payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified,
      name: payload.name,
      groups: payload['cognito:groups'] || [],
      attributes: {
        sub: payload.sub,
        email: payload.email || '',
        email_verified: payload.email_verified?.toString() || 'false',
        preferred_username: payload['cognito:username'] || '',
        name: payload.name || '',
        given_name: payload.given_name || '',
        family_name: payload.family_name || '',
      },
    };
  }

  /**
   * Validate Cognito configuration
   */
  validateConfig(): CognitoConfigValidation {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Required fields
    if (!this.config.userPoolId) {
      errors.push('User Pool ID is required');
    } else if (!this.config.userPoolId.match(/^[a-zA-Z0-9_-]+$/)) {
      errors.push('Invalid User Pool ID format');
    }

    if (!this.config.clientId) {
      errors.push('Client ID is required');
    }

    if (!this.config.region) {
      errors.push('Region is required');
    } else if (!this.config.region.match(/^[a-z0-9-]+$/)) {
      errors.push('Invalid region format');
    }

    // Optional fields validation
    if (this.config.jwksUri && !this.isValidUrl(this.config.jwksUri)) {
      warnings.push('Invalid JWKS URI format');
    }

    if (this.config.issuer && !this.isValidUrl(this.config.issuer)) {
      warnings.push('Invalid issuer URI format');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Create Cognito error
   */
  createCognitoError(message: string, code: string, statusCode: number = 401, retryable: boolean = false): CognitoError {
    const error = new Error(message) as CognitoError;
    error.code = code;
    error.statusCode = statusCode;
    error.retryable = retryable;
    return error;
  }

  /**
   * Extract user groups from token payload
   */
  extractUserGroups(payload: CognitoJWTPayload): string[] {
    return payload['cognito:groups'] || [];
  }

  /**
   * Check if user has specific group
   */
  hasGroup(payload: CognitoJWTPayload, groupName: string): boolean {
    const groups = this.extractUserGroups(payload);
    return groups.includes(groupName);
  }

  /**
   * Get token expiration time
   */
  getTokenExpiration(payload: CognitoJWTPayload): Date {
    return new Date(payload.exp * 1000);
  }

  /**
   * Check if token is expired or about to expire
   */
  isTokenExpired(payload: CognitoJWTPayload, bufferSeconds: number = 60): boolean {
    const expirationTime = this.getTokenExpiration(payload);
    const now = new Date();
    const buffer = bufferSeconds * 1000;
    
    return (expirationTime.getTime() - now.getTime()) <= buffer;
  }

  /**
   * Validate URL format
   */
  private isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get configuration status
   */
  getConfigStatus(): {
    configured: boolean;
    userPoolId: boolean;
    clientId: boolean;
    region: boolean;
    jwksUri: boolean;
    issuer: boolean;
  } {
    return {
      configured: this.validateConfig().isValid,
      userPoolId: !!this.config.userPoolId,
      clientId: !!this.config.clientId,
      region: !!this.config.region,
      jwksUri: !!this.config.jwksUri,
      issuer: !!this.config.issuer,
    };
  }
}

// Factory function to create Cognito utils with dependency injection
export const createCognitoUtils = (config: CognitoConfig, logger: LoggerService): CognitoUtils => {
  return new CognitoUtils(config, logger);
};