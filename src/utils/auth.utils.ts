/**
 * Authentication utilities for JWT validation and AWS Cognito integration
 * Provides flexible authentication mechanisms that can be easily extended
 */

import jwt from 'jsonwebtoken';
import {
  UserContext,
  AuthToken,
  TokenValidationResult,
  AuthenticationConfig,
  AuthenticationError,
} from '../types/auth.types';
import { LoggerService } from '../services/logger.service';
import { CognitoUtils } from './cognito.utils';

export class AuthenticationUtils {
  private config: AuthenticationConfig;

  constructor(
    config: AuthenticationConfig,
    private logger: LoggerService,
    private cognitoUtils: CognitoUtils,
  ) {
    this.config = config;
  }

  /**
   * Extract token from Authorization header
   */
  extractTokenFromHeader(authHeader: string | undefined): AuthToken | null {
    if (!authHeader) {
      return null;
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2) {
      return null;
    }

    const [type, token] = parts;
    if (!type || !token || (type !== 'Bearer' && type !== 'JWT')) {
      return null;
    }

    return {
      token,
      type: type as 'Bearer' | 'JWT',
    };
  }


  /**
   * Validate token using Cognito authentication
   */
  async validateToken(token: string): Promise<TokenValidationResult> {
    try {
      const result = await this.cognitoUtils.validateToken(token);

      if (!result.isValid) {
        return {
          isValid: false,
          error: result.error || 'Cognito token validation failed',
        };
      }

      if (!result.user) {
        return {
          isValid: false,
          error: 'Unable to extract user from Cognito token',
        };
      }

      // Convert Cognito user to UserContext
      const user: UserContext = {
        id: result.user.id,
        email: result.user.email,
        username: result.user.username,
        roles: result.user.groups || ['user'],
        isAuthenticated: true,
        tokenType: 'cognito',
        expiresAt: result.payload?.exp ? new Date(result.payload.exp * 1000) : undefined,
      };

      return {
        isValid: true,
        user,
        expiresAt: user.expiresAt,
      };
    } catch (error) {
      this.logger.error('Cognito token validation error', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        isValid: false,
        error: 'Cognito token validation failed',
      };
    }
  }

  /**
   * Extract user context from token using Cognito authentication
   */
  async extractUserContext(token: string): Promise<UserContext | null> {
    const result = await this.validateToken(token);
    return result.isValid ? result.user || null : null;
  }

  /**
   * Check if token is expired or about to expire
   */
  isTokenExpired(expiresAt: Date | undefined): boolean {
    if (!expiresAt) {
      return false; // No expiration means it doesn't expire
    }

    const now = new Date();
    const buffer = (this.config.tokenExpirationBuffer || 60) * 1000; // Convert to milliseconds
    
    return (expiresAt.getTime() - now.getTime()) <= buffer;
  }

  /**
   * Create authentication error
   */
  createAuthError(
    message: string, 
    code: AuthenticationError['code'], 
    statusCode: number = 401,
  ): AuthenticationError {
    const error = new Error(message) as AuthenticationError;
    error.code = code;
    error.statusCode = statusCode;
    return error;
  }

  /**
   * Sanitize user context for logging (remove sensitive information)
   */
  sanitizeUserContext(user: UserContext): Partial<UserContext> {
    return {
      id: user.id,
      username: user.username,
      roles: user.roles,
      isAuthenticated: user.isAuthenticated,
      tokenType: user.tokenType,
    };
  }
}

// Factory function for creating authentication utilities with dependency injection
export const createAuthUtils = (
  config: AuthenticationConfig,
  logger: LoggerService,
  cognitoUtils: CognitoUtils,
) => {
  return new AuthenticationUtils(config, logger, cognitoUtils);
};