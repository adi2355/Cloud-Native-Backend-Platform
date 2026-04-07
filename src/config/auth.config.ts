/**
 * Authentication Configuration Management
 * Centralized configuration for authentication services
 * Uses secrets from AWS Secrets Manager instead of direct environment access
 */

import { AuthenticationConfig } from '../types/auth.types';
import { CognitoConfig } from '../types/cognito.types';
import LoggerService, { LogLevel, LogCategory } from '../services/logger.service';

export interface AuthConfigValidation {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  recommendations: string[];
}

export class AuthConfig {
  private authConfig: AuthenticationConfig | null = null;
  private cognitoConfig: CognitoConfig | null = null;
  private isInitialized: boolean = false;

  /**
   * Constructor with dependency injection
   */
  constructor(private logger: LoggerService) {}

  /**
   * Configure the instance with secrets from AWS Secrets Manager
   * This method should be called once during server initialization
   */
  public async configure(secrets: Record<string, string>): Promise<void> {
    if (this.isInitialized) {
      this.logger.log(LogLevel.WARN, LogCategory.CONFIGURATION,
        'AuthConfig.configure() called multiple times. Skipping reconfiguration.');
      return;
    }

    try {
      this.authConfig = this.loadAuthConfig(secrets);
      this.cognitoConfig = this.loadCognitoConfig(secrets);
      this.isInitialized = true;

      const validation = this.validateConfig();

      this.logger.log(LogLevel.INFO, LogCategory.CONFIGURATION,
        'AuthConfig successfully configured from secrets', {
          isValid: validation.isValid,
          warnings: validation.warnings.length,
          errors: validation.errors.length,
        });

      // Log any validation issues
      if (validation.errors.length > 0) {
        this.logger.log(LogLevel.ERROR, LogCategory.CONFIGURATION,
          'AuthConfig has validation errors', { errors: validation.errors });
      }

      if (validation.warnings.length > 0) {
        this.logger.log(LogLevel.WARN, LogCategory.CONFIGURATION,
          'AuthConfig has validation warnings', { warnings: validation.warnings });
      }
    } catch (error) {
      this.logger.log(LogLevel.ERROR, LogCategory.CONFIGURATION,
        'Failed to configure AuthConfig', {
          error: error instanceof Error ? error.message : String(error),
        });
      throw error;
    }
  }

  /**
   * Load authentication configuration from secrets
   */
  private loadAuthConfig(secrets: Record<string, string>): AuthenticationConfig {
    return {
      cognitoUserPoolId: secrets.COGNITO_USER_POOL_ID,
      cognitoClientId: secrets.COGNITO_CLIENT_ID,
      cognitoRegion: secrets.COGNITO_REGION || 'us-east-1',
      tokenExpirationBuffer: parseInt(secrets.TOKEN_EXPIRATION_BUFFER || '60'),
      jwtSecret: secrets.JWT_SECRET,
    };
  }

  /**
   * Load Cognito configuration from secrets
   */
  private loadCognitoConfig(secrets: Record<string, string>): CognitoConfig {
    return {
      userPoolId: secrets.COGNITO_USER_POOL_ID || '',
      clientId: secrets.COGNITO_CLIENT_ID || '',
      region: secrets.COGNITO_REGION || 'us-east-1',
    };
  }

  /**
   * Get authentication configuration
   * @throws Error if not initialized
   */
  public getAuthConfig(): AuthenticationConfig {
    if (!this.isInitialized || !this.authConfig) {
      throw new Error('AuthConfig not initialized. Call AuthConfig.configure() first.');
    }
    return { ...this.authConfig };
  }

  /**
   * Get Cognito configuration
   * @throws Error if not initialized
   */
  public getCognitoConfig(): CognitoConfig {
    if (!this.isInitialized || !this.cognitoConfig) {
      throw new Error('AuthConfig not initialized. Call AuthConfig.configure() first.');
    }
    return { ...this.cognitoConfig };
  }

  /**
   * Validate authentication configuration
   */
  public validateConfig(): AuthConfigValidation {
    const errors: string[] = [];
    const warnings: string[] = [];
    const recommendations: string[] = [];

    if (!this.isInitialized || !this.authConfig || !this.cognitoConfig) {
      errors.push('AuthConfig not initialized');
      return {
        isValid: false,
        errors,
        warnings,
        recommendations,
      };
    }

    // Check for production readiness
    if (process.env.NODE_ENV === 'production') {
      if (!this.authConfig.cognitoUserPoolId) {
        errors.push('Cognito User Pool ID is required in production');
      }
      if (!this.authConfig.cognitoClientId) {
        errors.push('Cognito Client ID is required in production');
      }
    }

    // Cognito configuration validation
    if (this.authConfig.cognitoUserPoolId) {
      if (!this.authConfig.cognitoClientId) {
        errors.push('Cognito client ID is required when user pool ID is provided');
      }

      if (!this.authConfig.cognitoRegion) {
        warnings.push('Cognito region not specified, using default us-east-1');
      }
    }

    // Token expiration buffer validation
    if (this.authConfig.tokenExpirationBuffer && this.authConfig.tokenExpirationBuffer < 30) {
      warnings.push('Token expiration buffer should be at least 30 seconds');
    }

    // Recommendations
    if (!this.authConfig.cognitoUserPoolId && process.env.NODE_ENV !== 'production') {
      recommendations.push('Configure Cognito authentication for production use');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      recommendations,
    };
  }

  /**
   * Check if authentication is properly configured
   */
  public isConfigured(): boolean {
    if (!this.isInitialized) {
      return false;
    }
    const validation = this.validateConfig();
    return validation.isValid;
  }

  /**
   * Get Cognito configuration status
   */
  public getConfigStatus(): {
    strategy: 'cognito';
    configured: boolean;
    features: string[];
    environment: string;
  } {
    if (!this.isInitialized) {
      return {
        strategy: 'cognito',
        configured: false,
        features: [],
        environment: process.env.NODE_ENV || 'unknown',
      };
    }

    const features: string[] = [];
    if (this.authConfig?.cognitoUserPoolId) features.push('Cognito');

    return {
      strategy: 'cognito',
      configured: this.isConfigured(),
      features,
      environment: process.env.NODE_ENV || 'unknown',
    };
  }

  /**
   * Reset configuration (mainly for testing)
   */
  public reset(): void {
    this.authConfig = null;
    this.cognitoConfig = null;
    this.isInitialized = false;
    this.logger.log(LogLevel.INFO, LogCategory.CONFIGURATION, 'AuthConfig reset');
  }

  /**
   * Get environment variables template
   * This is for documentation purposes only
   */
  public getEnvTemplate(): string {
    return `
# AWS Secrets Manager Configuration
AWS_SECRET_ARN=arn:aws:secretsmanager:region:account:secret:name
AWS_REGION=us-east-1

# The following should be stored in AWS Secrets Manager:
# - COGNITO_USER_POOL_ID
# - COGNITO_CLIENT_ID
# - COGNITO_REGION
# - GOOGLE_WEB_CLIENT_ID
# - JWT_SECRET
# - TOKEN_EXPIRATION_BUFFER
    `.trim();
  }
}

// Factory function to create AuthConfig with dependency injection
export function createAuthConfig(logger: LoggerService): AuthConfig {
  return new AuthConfig(logger);
}

