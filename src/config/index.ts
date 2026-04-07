import * as dotenv from 'dotenv';
import { ConfigSecurityService, ConfigValidationResult, ConfigValidationError } from '../services/configSecurity.service';
import { SecretsService } from '../services/secrets.service';
import { AuthConfig } from './auth.config';
import LoggerService, { LogLevel, LogCategory } from '../services/logger.service';
import { JwtSecretValidator } from '../utils/jwt-validation.utils';

// Import AppConfig type for local use within this module
import type { AppConfig } from '../services/configSecurity.service';

dotenv.config();

// APPLICATION CONFIGURATION TYPE - ZOD-DERIVED (SINGLE SOURCE OF TRUTH)
// AppConfig is now derived from the Zod schema in ConfigSecurityService
// This eliminates duplication and ensures type definitions always match
// validation rules. DO NOT define AppConfig manually here.

/**
 * Application Configuration Type
 * Represents the complete configuration structure for the AppPlatform backend
 *
 * derived from AppConfigSchema (Zod). This ensures:
 * 1. Type definitions always match runtime validation
 * 2. Single source of truth for configuration structure
 * 3. No duplication between type definitions and validation schemas
 *
 * To modify the configuration structure:
 * - Edit AppConfigSchema in src/services/configSecurity.service.ts
 * - The type will update automatically via z.infer<>
 *
 * @see {@link ConfigSecurityService} for the Zod schema definition
 */
export type { AppConfig };

/**
 * Cached configuration promise to prevent duplicate initialization
 * INTERNAL USE ONLY - do not access directly outside this module
 */
let configInitializationPromise: Promise<AppConfig> | null = null;

/**
 * Initialize configuration asynchronously
 * This MUST be called and awaited before starting the server
 *
 * IMPORTANT ARCHITECTURAL CHANGE:
 * - Returns an IMMUTABLE frozen configuration object
 * - NO global mutable state - config is returned and injected via bootstrap.ts
 * - ConfigSecurityService is the single source of truth for config values
 *
 * Initialization order:
 * 1. Load all secrets from AWS Secrets Manager
 * 2. Configure AuthConfig with secrets
 * 3. Initialize ConfigSecurityService with secrets
 * 4. Load and merge all configuration
 * 5. Validate JWT secrets for security compliance
 * 6. Return FROZEN immutable configuration
 *
 * @param logger - LoggerService instance for logging
 * @param configSecurityService - ConfigSecurityService instance for secure config
 * @param authConfig - AuthConfig instance for authentication config
 * @returns Promise<AppConfig> - Immutable frozen configuration object
 */
export async function initializeConfig(
  logger: LoggerService,
  configSecurityService: ConfigSecurityService,
  authConfig: AuthConfig,
): Promise<AppConfig> {
  // Return existing promise if initialization is already in progress
  if (configInitializationPromise) {
    logger.log(LogLevel.DEBUG, LogCategory.CONFIGURATION,
      'Configuration initialization already in progress, returning existing promise');
    return configInitializationPromise;
  }

  // Start initialization
  configInitializationPromise = (async (): Promise<AppConfig> => {
    try {
      logger.log(LogLevel.INFO, LogCategory.CONFIGURATION, 'Starting configuration initialization...');

      // Step 1: Load all secrets from AWS Secrets Manager
      logger.log(LogLevel.INFO, LogCategory.CONFIGURATION, 'Loading secrets from AWS Secrets Manager...');
      const secretsService = new SecretsService(logger);
      const allSecrets = await secretsService.getAllSecrets();
      logger.log(LogLevel.INFO, LogCategory.CONFIGURATION, 'Secrets loaded successfully');

      // Step 2: Configure AuthConfig with secrets
      logger.log(LogLevel.INFO, LogCategory.CONFIGURATION, 'Configuring AuthConfig with secrets...');
      await authConfig.configure(allSecrets);
      logger.log(LogLevel.INFO, LogCategory.CONFIGURATION, 'AuthConfig configured successfully');

      // Step 3: Initialize ConfigSecurityService (it will also load secrets internally)
      logger.log(LogLevel.INFO, LogCategory.CONFIGURATION, 'Initializing ConfigSecurityService...');
      await configSecurityService.initialize();

      // Step 4: Get the complete secure configuration
      logger.log(LogLevel.INFO, LogCategory.CONFIGURATION, 'Loading complete configuration...');
      const secureConfig = await configSecurityService.getSecureConfig();

      // Step 5: Validate JWT_SECRET exists before proceeding
      if (!allSecrets.JWT_SECRET) {
        throw new Error('CRITICAL: JWT_SECRET is required but not found in secrets');
      }

      // Step 6: Build authentication configuration from AuthConfig and secrets
      const authConfiguration = {
        ...authConfig.getAuthConfig(),
        googleWebClientId: allSecrets.GOOGLE_WEB_CLIENT_ID,
        googleClientId: allSecrets.GOOGLE_CLIENT_ID,
        googleClientSecret: allSecrets.GOOGLE_CLIENT_SECRET,
        appleClientId: allSecrets.APPLE_CLIENT_ID,
        facebookAppId: allSecrets.FACEBOOK_APP_ID,
        facebookAppSecret: allSecrets.FACEBOOK_APP_SECRET,
        cognitoIdentityPoolId: allSecrets.COGNITO_IDENTITY_POOL_ID,
        sessionsTableName: allSecrets.SESSIONS_TABLE_NAME,
        jwtSecret: allSecrets.JWT_SECRET,
        refreshTokenSecret: allSecrets.REFRESH_TOKEN_SECRET,
      };

      // Step 7: Build JWT configuration for WebSocket authentication
      const jwtConfiguration = {
        secret: allSecrets.JWT_SECRET,
        expiresIn: '24h',
        algorithm: 'HS256' as const,
      };

      logger.log(LogLevel.INFO, LogCategory.SECURITY, 'Validating JWT secrets for security compliance...');
      try {
        // Validate main JWT secret (already confirmed to exist above)
        // Note: authConfiguration.jwtSecret is the same value as allSecrets.JWT_SECRET,
        // so we only validate once to avoid duplicate warnings
        JwtSecretValidator.assertValid(allSecrets.JWT_SECRET, logger, 'Main JWT Secret');

        // Validate refresh token secret if it exists AND is different from the main secret
        if (authConfiguration.refreshTokenSecret && 
            authConfiguration.refreshTokenSecret !== allSecrets.JWT_SECRET) {
          JwtSecretValidator.assertValid(authConfiguration.refreshTokenSecret, logger, 'Refresh Token Secret');
        }

        logger.log(LogLevel.INFO, LogCategory.SECURITY, 'JWT secret validation passed - configuration is secure');
      } catch (jwtValidationError) {
        const errorMessage = jwtValidationError instanceof Error ? jwtValidationError.message : 'JWT secret validation failed';
        logger.log(LogLevel.ERROR, LogCategory.SECURITY, 'JWT secret validation failed - blocking configuration initialization', {
          error: errorMessage,
          context: 'config initialization',
          failFast: true,
        });

        // Fail fast - do not allow the application to start with insecure JWT secrets
        throw new Error(`Configuration initialization failed: ${errorMessage}. The application cannot start with insecure JWT secrets.`);
      }

      // Step 8: Build the complete immutable configuration object
      const initializedConfig: AppConfig = {
        port: secureConfig.port,
        nodeEnv: secureConfig.nodeEnv as 'development' | 'staging' | 'production' | 'test',
        aws: {
          region: secureConfig.aws.region,
          secretArn: secureConfig.aws.secretArn,
          accessKeyId: secureConfig.aws.accessKeyId,
          secretAccessKey: secureConfig.aws.secretAccessKey,
          s3BucketName: secureConfig.aws.s3BucketName,
          s3BackupBucketName: secureConfig.aws.s3BackupBucketName,
          s3ExportBucketName: secureConfig.aws.s3ExportBucketName,
        },
        database: {
          url: secureConfig.database.url,
        },
        redis: {
          url: secureConfig.redis.url,
          host: secureConfig.redis.host,
          port: secureConfig.redis.port,
          password: secureConfig.redis.password,
          db: secureConfig.redis.db,
          keyPrefix: secureConfig.redis.keyPrefix,
        },
        jwt: jwtConfiguration,
        cognito: authConfig.getCognitoConfig(),
        auth: authConfiguration,
        ANTHROPIC_API_KEY: secureConfig.ANTHROPIC_API_KEY,
        cors: {
          allowedOrigins: secureConfig.cors.allowedOrigins,
        },
        rateLimit: {
          windowMs: secureConfig.rateLimit.windowMs,
          max: secureConfig.rateLimit.max,
        },
        syncRateLimit: {
          windowMs: secureConfig.syncRateLimit.windowMs,
          max: secureConfig.syncRateLimit.max,
        },
        websocket: {
          pingTimeout: secureConfig.websocket.pingTimeout,
          pingInterval: secureConfig.websocket.pingInterval,
          enableHorizontalScaling: secureConfig.websocket.enableHorizontalScaling,
        },
        request: {
          maxSize: secureConfig.request.maxSize,
          timeout: secureConfig.request.timeout,
          bodyParser: {
            jsonLimit: secureConfig.request.bodyParser.jsonLimit,
            jsonInflatedLimit: secureConfig.request.bodyParser.jsonInflatedLimit,
            urlencodedLimit: secureConfig.request.bodyParser.urlencodedLimit,
          },
        },
        security: {
          helmet: {
            contentSecurityPolicy: {
              enabled: secureConfig.security.helmet.contentSecurityPolicy.enabled,
              directives: secureConfig.security.helmet.contentSecurityPolicy.directives,
            },
            crossOriginEmbedderPolicy: secureConfig.security.helmet.crossOriginEmbedderPolicy,
            crossOriginOpenerPolicy: secureConfig.security.helmet.crossOriginOpenerPolicy,
            crossOriginResourcePolicy: secureConfig.security.helmet.crossOriginResourcePolicy,
            hsts: {
              enabled: secureConfig.security.helmet.hsts.enabled,
              maxAge: secureConfig.security.helmet.hsts.maxAge,
              includeSubDomains: secureConfig.security.helmet.hsts.includeSubDomains,
              preload: secureConfig.security.helmet.hsts.preload,
            },
            noSniff: secureConfig.security.helmet.noSniff,
          },
        },
        validation: secureConfig.validation,
      };

      // Log validation results (without sensitive data)
      const validation = initializedConfig.validation;
      if (!validation.isValid) {
        logger.log(LogLevel.WARN, LogCategory.CONFIGURATION, 'Configuration has validation issues', {
          warnings: validation.warnings.length,
          errors: validation.errors.length,
        });

        // Log validation errors
        validation.errors.forEach((error: ConfigValidationError) => {
          const logLevel = error.severity === 'CRITICAL' || error.severity === 'HIGH'
            ? LogLevel.ERROR
            : LogLevel.WARN;
          logger.log(logLevel, LogCategory.CONFIGURATION,
            `Configuration validation error: ${error.message}`, {
              field: error.field,
              severity: error.severity,
            });
        });
      }

      logger.log(LogLevel.INFO, LogCategory.CONFIGURATION,
        'Configuration initialization complete', {
          securityScore: validation.securityScore,
          environment: initializedConfig.nodeEnv,
        });

      // This prevents runtime tampering and ensures configuration integrity
      return Object.freeze(initializedConfig);

    } catch (error) {
      logger.log(LogLevel.ERROR, LogCategory.CONFIGURATION,
        'Failed to initialize configuration', {
          error: error instanceof Error ? error.message : String(error),
        });

      // Reset promise so it can be retried
      configInitializationPromise = null;
      throw error;
    }
  })();

  return configInitializationPromise;
}

// Basic validation for critical deployment settings
if (process.env.NODE_ENV !== 'development') {
  if (!process.env.AWS_REGION || !process.env.AWS_SECRET_ARN) {
    throw new Error('AWS_REGION and AWS_SECRET_ARN must be configured in environment');
  }
}

/**
 * DEPRECATED: Legacy config export removed
 *
 * ARCHITECTURAL CHANGE:
 * - Global mutable config object has been REMOVED
 * - Configuration is now returned from initializeConfig() and injected via bootstrap.ts
 * - All services receive config via constructor injection from bootstrap.ts
 *
 * Migration Path:
 * 1. Call initializeConfig() in bootstrap.ts or index.ts
 * 2. Pass the returned config to initializeServices()
 * 3. Services receive config via dependency injection
 *
 * Example (bootstrap.ts):
 * ```typescript
 * const config = await initializeConfig(logger, configSecurityService, authConfig);
 * const services = await initializeServices(config);
 * ```
 */
