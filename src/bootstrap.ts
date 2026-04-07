/**
 * Bootstrap.ts - Service Initialization Module
 * 
 * This module handles the initialization of all backend services in the correct order,
 * managing dependencies and ensuring proper startup sequence. It encapsulates all
 * service initialization logic that was previously in index.ts.
 * 
 * @module bootstrap
 */

// NOTE: This file has been redacted for the public portfolio.
// Domain-specific services (AI, inventory, safety, analytics, etc.) have been
// removed. The DI composition-root pattern and wiring approach are preserved
// to demonstrate the architectural style.

import { Config } from './core/types';
import { CognitoService } from './services/cognito.service';
import { AuthenticationService } from './services/auth.service';
import { CacheService } from './services/cache.service';
import { SocketService } from './websocket/socket.service';
import { WebSocketBroadcaster } from './realtime/WebSocketBroadcaster';
import { SecurityMonitoringService } from './services/securityMonitoring.service';
import { PerformanceMonitoringService } from './services/performanceMonitoring.service';
import { APIGatewayManager } from './api/v1/middleware/apiGateway.middleware';
import { APICacheManager } from './api/v1/middleware/apiCache.middleware';
import { DatabaseService } from './services/database.service';
import { ControllerRegistry } from './core/controller-registry';
import { MiddlewareFactory } from './core/middleware-factory';
import { RouteRegistry } from './core/route-registry';
import { RepositoryFactory } from './repositories/repository.factory';
import { DomainEventService } from './events/domain-event.service';
import { initializeDomainSubscribers, shutdownDomainSubscribers } from './subscribers/domain.subscribers';
import { LoggerService, LogLevel } from './services/logger.service';
import { OutboxService } from './services/outbox.service';
import { RateLimitingQueueService } from './services/rateLimitingQueue.service';
import { SecurityLoggerService } from './services/securityLogger.service';
import { AuthRateLimitService } from './services/authRateLimit.service';
import { SessionSecurityService } from './services/sessionSecurity.service';

// Core business services
import { SessionService } from './services/session.service';
import { SyncService } from './services/sync.service';
import { OutboxProcessorService } from './services/outbox-processor.service';
import { HealthSampleService } from './services/healthSample.service';
import { SessionTelemetryService } from './services/session-telemetry.service';
import { SessionTelemetryQueueService } from './services/sessionTelemetryQueue.service';
import { SyncLeaseService } from './services/syncLease.service';
import { HealthIngestQueueService } from './services/healthIngestQueue.service';

// Health Projection Infrastructure
import { ProjectionCheckpointRepository } from './repositories/projection-checkpoint.repository';
import {
  HealthProjectionCoordinatorService,
  HealthRollupProjectionHandler,
  SleepSummaryProjectionHandler,
  SessionImpactProjectionHandler,
  ProductImpactProjectionHandler,
  TelemetryCacheProjectionHandler,
} from './services/health-projection-coordinator.service';
import { HealthAggregationService } from './services/health-aggregation.service';
import { HealthProjectionReadService } from './services/health-projection-read.service';
import { HealthInsightEngineService } from './services/health-insight-engine.service';
import { DriftDetectorService } from './services/drift-detector.service';

// Controller classes
import { UserController } from './api/v1/controllers/user.controller';
import { SessionController } from './api/v1/controllers/session.controller';
import { DeviceController } from './api/v1/controllers/device.controller';
import { SyncController } from './api/v1/controllers/sync.controller';
import { WebSocketController } from './api/v1/controllers/websocket.controller';
import { TelemetryController } from './api/v1/controllers/telemetry.controller';
import { HealthController } from './api/v1/controllers/health.controller';
import { RequestValidationService } from './services/requestValidation.service';
import { CorrelationTrackerService } from './services/correlationTracker.service';
import { HTTPSValidationService } from './services/httpsValidation.service';
import { JobManagerService } from './jobs/job-manager.service';
import { JobProcessor } from './jobs/job-processor';
import { JobNames } from './jobs/job.types';

// Sync entity handlers (Strategy Pattern)
import { SessionHandler } from './services/sync/handlers/session.handler';
import { DeviceHandler } from './services/sync/handlers/device.handler';
import { SYNC_ENTITY_TYPES } from './services/sync/sync.types';

// Import health check types for strong typing
import { HealthCheckResult, HealthCheckSummary } from './core/controller.types';

/**
 * Initialization mode for services
 */
export type InitializationMode = 'web' | 'worker';

/**
 * Options for service initialization
 */
export interface InitializationOptions {
  mode?: InitializationMode;  // Default: 'web'
  enableWorkers?: boolean;     // Enable job workers (worker mode only)
}

export interface InitializedServices {
  // Configuration
  config: Config;

  // Foundational services (created first)
  logger: LoggerService;
  databaseService: DatabaseService;
  cacheService: CacheService;
  repositoryFactory: RepositoryFactory;

  // Core services
  domainEventService: DomainEventService;
  outboxService: OutboxService;

  // Auth services
  cognitoService: CognitoService;
  authenticationService: AuthenticationService;
  authRateLimitService: AuthRateLimitService;
  sessionSecurityService: SessionSecurityService;

  // Business services
  sessionService: SessionService;
  healthSampleService: HealthSampleService;
  sessionTelemetryService: SessionTelemetryService;
  outboxProcessorService: OutboxProcessorService;

  // Infrastructure services
  socketService: SocketService;
  webSocketBroadcaster: WebSocketBroadcaster;
  securityLoggerService: SecurityLoggerService;
  securityMonitoringService: SecurityMonitoringService;
  performanceMonitoringService: PerformanceMonitoringService;
  rateLimitingQueueService: RateLimitingQueueService;
  syncService: SyncService;
  syncLeaseService: SyncLeaseService;
  healthIngestQueueService: HealthIngestQueueService;
  sessionTelemetryQueueService: SessionTelemetryQueueService;
  requestValidationService: RequestValidationService;
  correlationTracker: CorrelationTrackerService;
  httpsValidationService: HTTPSValidationService;

  // Job processing services
  jobProcessor: JobProcessor;
  jobManagerService: JobManagerService;

  // API layer
  app: import('./app').App;
  apiGatewayManager: APIGatewayManager;
  apiCacheManager: APICacheManager;
  controllerRegistry: ControllerRegistry;
  middlewareFactory: import('./core/middleware-factory').MiddlewareFactory;
  routeRegistry: import('./core/route-registry').RouteRegistry;

  // Lifecycle management
  shutdown(): Promise<void>;
}

/**
 * Initialize all backend services in the correct order
 *
 *  MODERN DI PATTERN: Composition Root - handles ALL initialization
 * This function is the single entry point for creating all application services.
 * It manages:
 * 1. Early logger creation
 * 2. Configuration loading (ConfigSecurityService + initializeConfig)
 * 3. All service instantiation with explicit dependencies
 * 4. Returns frozen InitializedServices object
 *
 * Supports two initialization modes:
 * - 'web': Full initialization with all services (controllers, API, WebSocket, etc.)
 * - 'worker': Minimal initialization for background job processing only
 *
 * @param options - Initialization options (mode, enableWorkers)
 * @returns Promise resolving to initialized services (including config and logger)
 */
export async function initializeServices(
  options: InitializationOptions = { mode: 'web' },
): Promise<InitializedServices> {
  const mode = options.mode || 'web';
  const isWorkerMode = mode === 'worker';

  //  ISSUE #5 FIX: Replace console.log with logger (after logger is created)
  // These initial console statements are ACCEPTABLE - they occur before logger exists
  // eslint-disable-next-line no-console
  console.log(` Initializing backend services in ${mode} mode with explicit dependency injection...`);

  // PHASE 0: OpenTelemetry (must be first - before any imports)
  // NOTE: OpenTelemetry should be preloaded via -r instrumentation.ts for proper instrumentation
  // This fallback initializes it if preload wasn't used
  // eslint-disable-next-line no-console
  console.log('\n=== PHASE 0: OpenTelemetry Initialization ===');
  const { initializeOpenTelemetryForProduction, isOpenTelemetryInitialized } = await import('./observability/opentelemetry');
  if (isOpenTelemetryInitialized()) {
    // eslint-disable-next-line no-console
    console.log(' OpenTelemetry already initialized (via preload)');
  } else {
    await initializeOpenTelemetryForProduction('app-platform-backend');
    // eslint-disable-next-line no-console
    console.log(' OpenTelemetry initialized (fallback - preload recommended for full instrumentation)');
  }

  // PHASE 1: Create foundational services (no dependencies)
  // eslint-disable-next-line no-console
  console.log('\n=== PHASE 1: Foundational Services ===');

  // 1.1 Logger service (foundation for everything)
  //  ACCEPTABLE EARLY PROCESS.ENV: Before ConfigSecurityService exists
  // eslint-disable-next-line no-console
  console.log('Creating logger service...'); // Console acceptable during logger creation
  const nodeEnv = process.env.NODE_ENV || 'development';
  const logger = new LoggerService({
    level: nodeEnv === 'development' ? LogLevel.DEBUG : LogLevel.INFO,
    enableConsole: true,
    enableFile: true,
    logDirectory: process.env.LOG_DIRECTORY || './logs', //  OK: Early bootstrap
    maxFileSize: 10 * 1024 * 1024,
    maxFiles: 10,
    enableStructuredLogging: true,
    sanitizeData: true,
    includeStackTrace: nodeEnv === 'development',
  });
  logger.info(' Logger service created - switching to structured logging');

  // PHASE 2: Configuration Loading (before any other services)
  logger.info('\n=== PHASE 2: Configuration Loading ===');

  // 2.1 Import configuration modules
  logger.info('Importing configuration modules...');
  const { initializeConfig } = await import('./config');
  const { createAuthConfig } = await import('./config/auth.config');
  logger.info(' Configuration modules imported');

  // 2.2 Create ConfigSecurityService (with logger dependency)
  logger.info('Creating ConfigSecurityService...');
  const configSecurityService = new ConfigSecurityService(logger);
  await configSecurityService.initialize();
  logger.info(' ConfigSecurityService created');

  // 2.3 Create AuthConfig (with logger dependency)
  logger.info('Creating AuthConfig...');
  const authConfig = createAuthConfig(logger);
  logger.info(' AuthConfig created');

  // 2.4 Load complete immutable configuration
  logger.info('Loading complete application configuration...');
  const config = await initializeConfig(logger, configSecurityService, authConfig);
  logger.info(' Configuration loaded successfully', {
    environment: config.nodeEnv,
    securityScore: config.validation.securityScore,
  });

  // PHASE 3: Infrastructure Services (depend on logger + config)
  logger.info('\n=== PHASE 3: Infrastructure Services ===');

  // 3.1 S3 Service (required for DatabaseService)
  logger.info('Creating S3 service...');
  const s3Service = new S3Service(logger);
  // S3Service initialization will be done later when AWS config is available
  logger.info(' S3 service created');

  // 3.2 Database service (pure constructor injection - no singleton)
  logger.info('Creating and connecting database service...');
  const databaseService = new DatabaseService(logger, s3Service);
  await databaseService.connect();
  logger.info(' Database service connected');

  // 3.3 Cache service (with explicit dependency injection)
  logger.info('Creating cache service...');
  const cacheService = new CacheService(logger);
  logger.info(' Cache service created');

  // Moved from PHASE 6 to fix TDZ error - RepositoryFactory requires this service
  logger.info('Creating performance monitoring service...');
  const performanceMonitoringService = new PerformanceMonitoringService(logger);
  logger.info(' Performance monitoring service created with explicit dependencies');

  // PHASE 4: Repository layer (depends on database)
  logger.info('\n=== PHASE 4: Repository Layer ===');
  logger.info('Creating repository factory with database client...');
  const repositoryFactory = new RepositoryFactory(
    databaseService.getClient(),
    logger,
    performanceMonitoringService
  );
  logger.info(' Repository factory created with explicit database dependency');

  // Get PostgreSQL repositories for time-series data from RepositoryFactory
  logger.info('Getting device telemetry repository from factory...');
  const deviceTelemetryRepository = repositoryFactory.getDeviceTelemetryRepository();
  logger.info(' Device telemetry repository retrieved from factory');

  logger.info('Getting analytics event repository from factory...');
  const analyticsEventRepository = repositoryFactory.getAnalyticsEventRepository();
  logger.info(' Analytics event repository retrieved from factory');

  // PHASE 5: Core services (depends on foundational services + config)
  logger.info('\n=== PHASE 5: Core Services ===');

  // 5.1 Domain Event Service (with explicit dependency injection)
  logger.info('Creating domain event service...');
  const domainEventService = new DomainEventService(logger);
  await domainEventService.initialize({
    enableMetrics: true,
    enableReplay: false,
    enableDeadLetter: true,
    maxListeners: 100,
  });
  logger.info(' Domain event service created');

  // Domain event subscribers will be initialized after all services are created

  // 5.2 Configure CacheService with Redis (using config from PHASE 2)
  logger.info('Configuring cache service with Redis connection...');
  try {
    const secureConfig = await configSecurityService.getSecureConfig();

    logger.info(' bootstrap.ts received secureConfig.redis:', {
      hasUrl: !!secureConfig.redis?.url,
      urlProtocol: secureConfig.redis?.url?.split('://')[0],
      host: secureConfig.redis?.host,
      port: secureConfig.redis?.port,
      hasUsername: !!secureConfig.redis?.username,
      hasPassword: !!secureConfig.redis?.password,
      db: secureConfig.redis?.db,
      keyPrefix: secureConfig.redis?.keyPrefix
    });

    if (secureConfig.redis) {
      const cacheConfigToPass = {
        url: secureConfig.redis.url,
        host: secureConfig.redis.host,
        port: secureConfig.redis.port,
        username: secureConfig.redis.username, // Redis 6+ ACL username (Render managed Redis)
        password: secureConfig.redis.password,
        db: secureConfig.redis.db || 0,
        keyPrefix: secureConfig.redis.keyPrefix || 'appplatform:',
      };

      logger.info(' bootstrap.ts passing to cacheService.configure():', {
        hasUrl: !!cacheConfigToPass.url,
        urlProtocol: cacheConfigToPass.url?.split('://')[0],
        host: cacheConfigToPass.host,
        port: cacheConfigToPass.port,
        hasUsername: !!cacheConfigToPass.username,
        hasPassword: !!cacheConfigToPass.password,
        db: cacheConfigToPass.db,
        keyPrefix: cacheConfigToPass.keyPrefix
      });

      await cacheService.configure(cacheConfigToPass);

      // FIXED: CacheService.configure() now properly awaits Redis connection
      // This ensures cacheService.isReady() will always be true here
      if (cacheService.isReady()) {
        logger.info(' Cache service configured and Redis connection established');
      } else {
        // This should never happen now, but kept as safety check
        logger.error(' Unexpected: Cache service not ready after awaiting configuration');
      }
    } else {
      logger.info('  Redis not configured - cache service running without Redis');
    }
  } catch (error) {
    logger.warn('  Failed to configure cache service with Redis', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // 5.2.1 Sync lease service (admission control)
  logger.info('Creating sync lease service...');
  const syncLeaseService = new SyncLeaseService(cacheService, logger);
  logger.info(' Sync lease service created');

  // 5.3 Configure CloudWatch Logs Service (optional - controlled via environment)
  logger.info('Configuring CloudWatch Logs service...');
  let cloudWatchLogsService: CloudWatchLogsService | null = null;
  try {
    //  ACCEPTABLE EARLY PROCESS.ENV: CloudWatch config not in SecureConfig
    const enableCloudWatchLogs = process.env.ENABLE_CLOUDWATCH_LOGS === 'true';
    if (enableCloudWatchLogs) {
      cloudWatchLogsService = new CloudWatchLogsService(logger);

      // Generate log stream name with timestamp for uniqueness
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0]; // YYYY-MM-DD
      //  ACCEPTABLE: RENDER_INSTANCE_ID is deployment-specific, not in SecureConfig
      const instanceId = process.env.RENDER_INSTANCE_ID || 'local';
      const logStreamName = `appplatform-backend-${instanceId}-${timestamp}`;

      await cloudWatchLogsService.configure({
        //  ACCEPTABLE: CloudWatch-specific env vars, fallback to config.aws.region
        logGroupName: process.env.CLOUDWATCH_LOG_GROUP_NAME || '/ecs/app-platform-backend/application',
        logStreamName,
        region: config.aws.region || process.env.CLOUDWATCH_REGION || 'us-east-1', //  FIXED: Use config first
        batchSize: parseInt(process.env.CLOUDWATCH_BATCH_SIZE || '10', 10),
        flushInterval: parseInt(process.env.CLOUDWATCH_FLUSH_INTERVAL || '5000', 10),
        retryAttempts: 3,
        enabled: true,
      });

      // Integrate CloudWatch with LoggerService
      logger.setCloudWatchLogsService(cloudWatchLogsService);
      logger.info(' CloudWatch Logs service configured and integrated with LoggerService', {
        logGroup: process.env.CLOUDWATCH_LOG_GROUP_NAME || '/ecs/app-platform-backend/application',
        logStream: logStreamName,
        region: config.aws.region,
      });
    } else {
      logger.info('  CloudWatch Logs disabled (ENABLE_CLOUDWATCH_LOGS not set to true)');
    }
  } catch (error) {
    logger.warn('  Failed to configure CloudWatch Logs service', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    // CloudWatch Logs failure should not prevent application startup
    cloudWatchLogsService = null;
  }

  // 3.3 Request Validation Service (stateless service)
  logger.info('Creating request validation service...');
  const requestValidationService = new RequestValidationService();
  logger.info(' Request validation service created');

  logger.info('Creating HTTPS validation service...');
  const httpsValidationService = new HTTPSValidationService();
  logger.info(' HTTPS validation service created');

  // 3.4 Optional services (Legacy DynamoDB service removed - now using PostgreSQL repositories)
  logger.info(' DynamoDB service replaced with PostgreSQL repositories for time-series data');

  // P0-A/B: HEALTH PROJECTION INFRASTRUCTURE
  // Create projection checkpoint tracking and health projection coordinator
  // BEFORE OutboxService so it can be injected for health event routing.
  logger.info('Creating health projection infrastructure (P0-A/B)...');

  // 3.4.1 ProjectionCheckpointRepository - tracks per-projection processing status
  const projectionCheckpointRepository = new ProjectionCheckpointRepository(
    databaseService.getClient(),
    logger,
  );
  logger.info('✓ ProjectionCheckpointRepository created');

  // 3.4.2 HealthProjectionCoordinatorService - fanout pattern for health events
  const healthProjectionCoordinator = new HealthProjectionCoordinatorService(
    projectionCheckpointRepository,
    logger,
  );

  // Register projection handlers
  // Phase 1: All 4 handlers registered in execution order:
  //   1. health-rollup → daily numeric aggregates
  //   2. sleep-summary → nightly sleep summaries
  //   3. session-impact → before/during/after session deltas
  //   4. telemetry-cache → session telemetry cache invalidation (P0-G.1)

  const healthAggregationService = new HealthAggregationService(logger);

  healthProjectionCoordinator.registerProjection(new HealthRollupProjectionHandler(
    logger,
    healthAggregationService,
    repositoryFactory.getHealthRollupDayRepository(),
    repositoryFactory.getHealthSampleRepository(),
    repositoryFactory.getUserHealthWatermarkRepository()
  ));

  healthProjectionCoordinator.registerProjection(new SleepSummaryProjectionHandler(
    logger,
    repositoryFactory.getSleepNightSummaryRepository(),
    repositoryFactory.getHealthSampleRepository(),
    repositoryFactory.getSessionRepository(),
    repositoryFactory.getUserHealthWatermarkRepository()
  ));

  healthProjectionCoordinator.registerProjection(new SessionImpactProjectionHandler(
    logger,
    repositoryFactory.getSessionImpactSummaryRepository(),
    repositoryFactory.getHealthSampleRepository(),
    repositoryFactory.getSessionRepository(),
    healthAggregationService,
    repositoryFactory.getUserHealthWatermarkRepository()
  ));

  // Phase E: Product impact projection — runs AFTER session-impact (reads its data)
  healthProjectionCoordinator.registerProjection(new ProductImpactProjectionHandler(
    logger,
    repositoryFactory.getProductImpactRollupRepository(),
    repositoryFactory.getSessionImpactSummaryRepository(),
    repositoryFactory.getSessionRepository(),
    repositoryFactory.getUserHealthWatermarkRepository()
  ));

  healthProjectionCoordinator.registerProjection(new TelemetryCacheProjectionHandler(
    logger,
    repositoryFactory.getSessionTelemetryCacheRepository(),
    repositoryFactory.getSessionRepository()
  ));

  logger.info('✓ HealthProjectionCoordinatorService created with 5 projection handlers');

  // 3.4.3 HealthProjectionReadService - thin read service for projection API
  // FINDING 1 FIX: Now requires UserHealthWatermarkRepository for read-time
  // freshness checks (internal design spec:1145 contract). On read, compares current
  // watermark against each row's sourceWatermark to detect staleness.
  const healthProjectionReadService = new HealthProjectionReadService(
    repositoryFactory.getHealthRollupDayRepository(),
    repositoryFactory.getSleepNightSummaryRepository(),
    repositoryFactory.getSessionImpactSummaryRepository(),
    repositoryFactory.getProductImpactRollupRepository(),
    logger,
    repositoryFactory.getUserHealthWatermarkRepository(),
  );
  logger.info('✓ HealthProjectionReadService created (with watermark freshness)');

  // 3.4.3.1 HealthInsightEngineService — read-time insight computation
  const healthInsightEngine = new HealthInsightEngineService(
    repositoryFactory.getHealthRollupDayRepository(),
    repositoryFactory.getSessionImpactSummaryRepository(),
    repositoryFactory.getProductImpactRollupRepository(),
    repositoryFactory.getUserHealthWatermarkRepository(),
    logger,
  );
  healthProjectionReadService.setInsightEngine(healthInsightEngine);
  logger.info('✓ HealthInsightEngineService created and wired into ReadService');

  // 3.4 Outbox Service (with explicit dependency injection - now using PostgreSQL repositories)
  // NOTE: DomainEventService injected for outbox-backed domain event emission (GAP A fix)
  // P0-A/B: HealthProjectionCoordinatorService injected for health event fanout
  logger.info('Creating outbox service...');
  const outboxService = new OutboxService(
    repositoryFactory.getOutboxEventRepository(),
    databaseService,
    logger,
    deviceTelemetryRepository,  // PostgreSQL repository for telemetry
    analyticsEventRepository,   // PostgreSQL repository for analytics
    domainEventService,         // GAP A: Process domain_event outbox entries through DomainEventService
    healthProjectionCoordinator, // P0-A/B: Health event fanout routing
  );
  await outboxService.initialize();
  logger.info(' Outbox service created with PostgreSQL repositories, DomainEventService, and HealthProjectionCoordinator');

  // Get validated configuration from ConfigSecurityService (needed for subsequent services)
  const secureConfig = await configSecurityService.getSecureConfig();

  // 3.4.5 Auth Services - Create CognitoService BEFORE SocketService (dependency)
  logger.info('Creating cognito service...');
  const cognitoService = new CognitoService(logger);
  await cognitoService.initialize(secureConfig.cognito);
  logger.info(' Cognito service initialized');

  // 3.5 Socket Service (with explicit dependency injection)
  //  SECURITY FIX: CognitoService injected for consistent JWT validation with HTTP API
  logger.info('Creating socket service...');
  const socketService = new SocketService(
    logger,
    cognitoService,
    repositoryFactory.getUserRepository(),
    repositoryFactory.getWebSocketEventRepository(),
    repositoryFactory.getLiveConsumptionRepository(),
    repositoryFactory.getSessionMessageRepository(),
    repositoryFactory.getSessionRepository(),
  );

  // Configure SocketService with validated configuration
  await socketService.configure({
    jwtSecret: secureConfig.jwt.secret,
    corsOrigins: secureConfig.cors.allowedOrigins || ['http://localhost:3000'],
    redis: secureConfig.redis ? {
      url: secureConfig.redis.url,
      host: secureConfig.redis.host,
      port: secureConfig.redis.port || 6379,
      username: secureConfig.redis.username, // Redis 6+ ACL username (Render managed Redis)
      password: secureConfig.redis.password,
      db: secureConfig.redis.db || 0,
    } : undefined,
    enableHorizontalScaling: secureConfig.redis && process.env.ENABLE_WEBSOCKET_SCALING === 'true',
  });
  logger.info(' Socket service created and configured');

  // 3.5.1 WebSocket Broadcaster (DI-friendly wrapper for real-time events)
  logger.info('Creating WebSocket broadcaster...');
  const webSocketBroadcaster = new WebSocketBroadcaster(socketService, logger);
  logger.info(' WebSocket broadcaster created');

  // 3.6.1 Create CognitoUtils with JWKS configuration
  logger.info('Creating CognitoUtils with JWKS configuration...');
  const { CognitoUtils } = await import('./utils/cognito.utils');
  const cognitoUtils = new CognitoUtils(
    {
      userPoolId: secureConfig.cognito?.userPoolId || '',
      clientId: secureConfig.cognito?.clientId || '',
      region: secureConfig.cognito?.region || secureConfig.aws?.region || 'us-east-1',
      jwksConfig: {
        cacheMaxAge: 24 * 60 * 60 * 1000, // 24 hours (from ConfigSecurityService)
        rateLimit: true,
        jwksRequestsPerMinute: 10,
      },
    },
    logger,
  );
  logger.info(' CognitoUtils created with explicit dependencies');

  // 3.6.2 Create AuthenticationUtils with injected CognitoUtils
  logger.info('Creating AuthenticationUtils with injected CognitoUtils...');
  const { AuthenticationUtils } = await import('./utils/auth.utils');
  const authenticationUtils = new AuthenticationUtils(
    {
      cognitoUserPoolId: secureConfig.cognito?.userPoolId,
      cognitoClientId: secureConfig.cognito?.clientId,
      cognitoRegion: secureConfig.cognito?.region || secureConfig.aws?.region || 'us-east-1',
      tokenExpirationBuffer: 300, // 5 minutes
    },
    logger,
    cognitoUtils,
  );
  logger.info(' AuthenticationUtils created with explicit dependencies');

  // Create SecurityLoggerService early (needed by other services)
  logger.info('Creating security logger service...');
  const securityLoggerService = new SecurityLoggerService(logger);
  logger.info(' Security logger service created with explicit dependencies');

  // Create AuthRateLimit service with explicit dependencies
  logger.info('Creating auth rate limit service...');
  const authRateLimitService = new AuthRateLimitService(
    logger,
    securityLoggerService,
  );
  logger.info(' Auth rate limit service created with explicit dependencies');

  // Create SessionSecurity service with explicit dependencies
  logger.info('Creating session security service...');
  const sessionSecurityService = new SessionSecurityService(
    logger,
    securityLoggerService,
  );
  await sessionSecurityService.initialize();
  logger.info(' Session security service created with explicit dependencies');

  // 3.7 SecretsService (needed by AIController)
  logger.info('Creating secrets service...');
  const secretsService = new SecretsService(logger);
  logger.info(' Secrets service created with explicit dependencies');

  // PHASE 6: Business services with explicit dependency injection
  logger.info('\n=== PHASE 6: Business Services ===');

  // Initialize S3 service (already created above with dependencies)
  if (config.aws?.accessKeyId && config.aws?.secretAccessKey) {
    try {
      await s3Service.initialize({
        region: config.aws.region || 'us-east-1',
        bucketName: config.aws.s3BucketName || 'appplatform-user-content',
        accessKeyId: config.aws.accessKeyId,
        secretAccessKey: config.aws.secretAccessKey,
      });
      logger.info(' S3 service initialized');
    } catch (error) {
      logger.warn('  S3 service initialization failed:', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  // 4.1 ConsumptionService (moved to after CorrelationTrackerService creation)

  // 4.2 JournalService (refactored - PostgreSQL only)
  logger.info('Creating journal service...');
  const journalService = new JournalService(
    repositoryFactory.getJournalRepository(),
    repositoryFactory.getSessionRepository(),
    repositoryFactory.getConsumptionRepository(),
    repositoryFactory.getProductRepository(),
    logger,
    s3Service,
    outboxService,
    domainEventService,
  );
  await journalService.initialize();
  logger.info(' Journal service created with PostgreSQL repository dependencies');

  // 4.3 UserService (already refactored)
  logger.info('Creating user service...');
  const userService = new UserService(
    repositoryFactory.getUserRepository(),
    repositoryFactory.getConsumptionRepository(),
    repositoryFactory.getPurchaseRepository(),
    repositoryFactory.getProductRepository(),
    repositoryFactory.getJournalRepository(),
    repositoryFactory.getSessionRepository(),
    repositoryFactory.getGoalRepository(),
    repositoryFactory.getUserAchievementRepository(),
    repositoryFactory.getInventoryRepository(),
    databaseService,
    logger,
    domainEventService,
  );
  await userService.initialize();
  logger.info(' User service created with explicit dependencies');

  // Create AuthenticationService with explicit dependencies (requires UserService and AuthenticationUtils)
  logger.info('Creating authentication service...');
  const authenticationService = new AuthenticationService(
    logger,
    cognitoService,
    userService,
    authenticationUtils, //  Now injecting AuthenticationUtils via constructor
  );
  await authenticationService.initialize(
    {
      cognitoUserPoolId: secureConfig.cognito?.userPoolId,
      cognitoClientId: secureConfig.cognito?.clientId,
      cognitoRegion: secureConfig.cognito?.region || secureConfig.aws?.region || 'us-east-1',
      tokenExpirationBuffer: 300,
    },
    {
      googleWebClientId: secureConfig.google?.webClientId,
      googleClientId: secureConfig.google?.clientId,
      googleClientSecret: secureConfig.google?.clientSecret,
      appleClientId: secureConfig.apple?.clientId,
      facebookAppId: secureConfig.facebook?.appId,
    },
  );
  logger.info(' Authentication service created with explicit dependencies');

  // 4.4 AchievementsService (moved up - needed by AnalyticsService)
  logger.info('Creating achievements service...');
  const achievementsService = new AchievementsService(
    repositoryFactory.getAchievementRepository(),
    repositoryFactory.getUserAchievementRepository(),
    repositoryFactory.getConsumptionRepository(),
    repositoryFactory.getPurchaseRepository(),
    repositoryFactory.getGoalRepository(),
    repositoryFactory.getAiUsageRecordRepository(),
    repositoryFactory.getJournalRepository(),
    databaseService,
    logger,
    cacheService,
  );
  await achievementsService.initialize();
  logger.info(' Achievements service created with explicit dependencies');

  // 4.5 GoalsService (moved up - needed by AnalyticsService)
  logger.info('Creating goals service...');
  const goalsService = new GoalsService(
    repositoryFactory.getGoalRepository(),
    repositoryFactory.getConsumptionRepository(),
    repositoryFactory.getPurchaseRepository(),
    repositoryFactory.getSessionRepository(),
    databaseService,
    logger,
    cacheService,
    domainEventService,
  );
  await goalsService.initialize();
  logger.info(' Goals service created with explicit dependencies');

  // Analytics service will be created after consumption service due to dependency

  // 4.5.1 AICostTrackingService (refactored with explicit dependencies)
  logger.info('Creating AI cost tracking service...');
  const aiCostTrackingService = new AICostTrackingService(
    repositoryFactory.getAiUsageRecordRepository(),
    logger,
    cacheService,
    configSecurityService,
  );
  await aiCostTrackingService.initialize();
  logger.info(' AI cost tracking service created with explicit dependencies');

  // NOTE: PerformanceMonitoringService was moved to PHASE 3 (before RepositoryFactory)
  // to fix TDZ error - it's now available for all services that need it

  // 4.5.1.2 CorrelationTrackerService (moved up - needed by AI services)
  logger.info('Creating correlation tracker service...');
  const correlationTracker = new CorrelationTrackerService(
    logger,
    performanceMonitoringService,
  );
  logger.info(' Correlation tracker service created with explicit dependencies');

  // 4.5.2 AiContextAggregationService
  logger.info('Creating AI context aggregation service...');
  const aiContextAggregationService = new AiContextAggregationService(
    repositoryFactory.getUserRepository(),
    repositoryFactory.getConsumptionRepository(),
    repositoryFactory.getProductRepository(),
    repositoryFactory.getSessionRepository(),
    repositoryFactory.getPurchaseRepository(),
    repositoryFactory.getJournalRepository(),
    repositoryFactory.getDailyStatRepository(),
    repositoryFactory.getGoalRepository(),
    repositoryFactory.getAchievementRepository(),
    repositoryFactory.getUserAchievementRepository(),
    logger,
    performanceMonitoringService,
    correlationTracker,
  );
  await aiContextAggregationService.initialize();
  logger.info(' AI context aggregation service created with explicit dependencies');

  // 4.5.3 AiPhiRedactionService
  logger.info('Creating AI PHI redaction service...');
  const aiPhiRedactionService = new AiPhiRedactionService(
    logger,
    performanceMonitoringService,
    correlationTracker,
  );
  await aiPhiRedactionService.initialize();
  logger.info(' AI PHI redaction service created with explicit dependencies');

  // 4.5.4 RateLimitingQueueService (now with explicit logger dependency)
  logger.info('Creating rate limiting queue service...');
  const rateLimitingQueueService = new RateLimitingQueueService(logger);

  // Apply configuration from environment (config.rateLimit comes from ConfigSecurityService)
  // This ensures environment variables RATE_LIMIT_WINDOW_MS and RATE_LIMIT_MAX_REQUESTS are respected
  rateLimitingQueueService.updateConfig({
    windowMs: config.rateLimit.windowMs,
    maxRequests: config.rateLimit.max,
  });
  logger.info(' Rate limiting queue service created and configured', {
    windowMs: config.rateLimit.windowMs,
    maxRequests: config.rateLimit.max,
  });

  // 4.5.5 AIService (refactored with explicit dependencies)
  logger.info('Creating AI service...');
  const aiService = new AIService(
    logger,
    cacheService,
    aiCostTrackingService, // Now properly injected
    configSecurityService, // Now properly injected
    rateLimitingQueueService, // Now properly injected
    aiContextAggregationService, // Now properly injected
    aiPhiRedactionService, // Now properly injected
    repositoryFactory.getAiResponseCacheRepository(), // Now properly injected
    repositoryFactory.getAiChatThreadRepository(), // Now properly injected
  );
  await aiService.initialize();
  logger.info(' AI service created with explicit dependencies');

  // 4.5.6 AiProductRecommendationService (added for end-to-end integration)
  logger.info('Creating AI product recommendation service...');
  const aiProductRecommendationService = new AiProductRecommendationService(
    repositoryFactory.getProductRepository(),
    repositoryFactory.getConsumptionRepository(),
    repositoryFactory.getAiRecommendationSetRepository(),
    repositoryFactory.getAiRecommendationItemRepository(),
    repositoryFactory.getAiUsageRecordRepository(),
    aiContextAggregationService,
    aiPhiRedactionService,
    logger,
    performanceMonitoringService,
    correlationTracker,
  );
  await aiProductRecommendationService.initialize();
  logger.info(' AI product recommendation service created with explicit dependencies');

  // 4.5.7 AiJournalAnalysisService (added for end-to-end integration)
  logger.info('Creating AI journal analysis service...');
  const aiJournalAnalysisService = new AiJournalAnalysisService(
    repositoryFactory.getJournalRepository(),
    repositoryFactory.getAiAnalysisRepository(),
    repositoryFactory.getAiUsageRecordRepository(),
    aiContextAggregationService,
    aiPhiRedactionService,
    logger,
    performanceMonitoringService,
    correlationTracker,
  );
  await aiJournalAnalysisService.initialize();
  logger.info(' AI journal analysis service created with explicit dependencies');

  // 4.5.8 AiWeeklyReportService (added for end-to-end integration)
  logger.info('Creating AI weekly report service...');
  const aiWeeklyReportService = new AiWeeklyReportService(
    repositoryFactory.getConsumptionRepository(),
    repositoryFactory.getJournalRepository(),
    repositoryFactory.getGoalRepository(),
    repositoryFactory.getUserAchievementRepository(),
    repositoryFactory.getDailyStatRepository(),
    repositoryFactory.getAiAnalysisRepository(),
    repositoryFactory.getAiUsageRecordRepository(),
    aiContextAggregationService,
    aiPhiRedactionService,
    logger,
    performanceMonitoringService,
    correlationTracker,
  );
  await aiWeeklyReportService.initialize();
  logger.info(' AI weekly report service created with explicit dependencies');

  // 4.6 DeviceTelemetryService (refactored to use PostgreSQL repository)
  logger.info('Creating device telemetry service...');
  const deviceTelemetryService = new DeviceTelemetryService(
    repositoryFactory.getDeviceTelemetryRepository(),
    logger,
  );
  await deviceTelemetryService.initialize();
  logger.info(' Device telemetry service created with PostgreSQL repository dependencies');

  // 4.7 DeviceService (refactored with explicit dependencies - using PostgreSQL repository)
  logger.info('Creating device service...');
  const deviceService = new DeviceService(
    repositoryFactory.getDeviceRepository(),
    databaseService,
    logger,
    deviceTelemetryService,  // DeviceTelemetryService using PostgreSQL repository
  );
  await deviceService.initialize();
  logger.info(' Device service created with PostgreSQL repository dependencies');

  // 4.8 SessionService (refactored with explicit dependencies - PostgreSQL only)
  logger.info('Creating session service...');
  const sessionService = new SessionService(
    repositoryFactory.getSessionRepository(),
    repositoryFactory.getConsumptionRepository(),
    repositoryFactory.getProductRepository(),
    logger,
    deviceTelemetryService,  // Now using DeviceTelemetryService with PostgreSQL repository
    outboxService,
    domainEventService,
  );
  await sessionService.initialize();
  logger.info(' Session service created with PostgreSQL repository dependencies');

  // PIPELINE FIX: Create PopulationStatsService early so PurchaseService can use it
  // PopulationStatsService only depends on repositoryFactory, cacheService, logger (all available)
  // It is also created later for UserConsumptionProfileService wiring — using the same instance.
  const populationStatsService = new PopulationStatsService(
    repositoryFactory.getUserConsumptionProfileRepository(),
    cacheService,
    logger,
  );

  // 4.9 PurchaseService (refactored with explicit dependencies - PostgreSQL only)
  logger.info('Creating purchase service...');
  const purchaseService = new PurchaseService(
    repositoryFactory.getPurchaseRepository(),
    repositoryFactory.getConsumptionRepository(),
    repositoryFactory.getInventoryRepository(),
    logger,
    outboxService,
    domainEventService,
    populationStatsService, // PIPELINE FIX: Population priors for cold-start estimation
    databaseService, // TRANSACTIONAL OUTBOX: For $transaction orchestration in finishPurchase
  );
  await purchaseService.initialize();
  logger.info(' Purchase service created with PostgreSQL repository dependencies');

  // 4.10 InventoryService (refactored with explicit dependencies - PostgreSQL only)
  logger.info('Creating inventory service...');
  const inventoryService = new InventoryService(
    repositoryFactory.getInventoryRepository(),
    repositoryFactory.getInventoryAdjustmentRepository(),
    repositoryFactory.getProductRepository(),
    logger,
    cacheService,
    outboxService,
  );
  await inventoryService.initialize();
  logger.info(' Inventory service created with PostgreSQL repository dependencies');

  // 4.11 ProductService (refactored with explicit dependencies)
  // Now includes DatabaseService and SyncChangeRepository for catalog sync support
  logger.info('Creating product service...');
  const productService = new ProductService(
    logger,
    repositoryFactory.getProductRepository(),
    repositoryFactory.getConsumptionRepository(),
    databaseService,
    repositoryFactory.getSyncChangeRepository(),
  );
  await productService.initialize();
  logger.info(' Product service created with explicit dependencies (incl. sync change support)');

  // 4.12 SafetyService (refactored with explicit dependencies)
  logger.info('Creating safety service...');
  const safetyService = new SafetyService(
    repositoryFactory.getSafetyRecordRepository(),
    logger,
    outboxService,
    domainEventService,
  );
  await safetyService.initialize();
  logger.info(' Safety service created with explicit dependencies');

  // 4.13 HealthSampleService (HealthKit/Health Connect data ingestion)
  // Uses RepositoryFactory for consistent DI pattern (repository injected, not created inline)
  // PHASE 6: Added UserRepository for health privacy gating
  // P0-A: Added OutboxEventRepository for transactional outbox pattern
  logger.info('Creating health sample service...');
  const healthSampleService = new HealthSampleService(
    repositoryFactory.getHealthSampleRepository(),
    logger,
    performanceMonitoringService,
    repositoryFactory.getUserRepository(), // PHASE 6: For privacy settings lookup
    domainEventService, // DEPRECATED: Legacy in-memory events, will be removed after P0-A full rollout
    repositoryFactory.getOutboxEventRepository(), // P0-A: Transactional outbox for health.samples.changed events
  );
  logger.info('✓ Health sample service created with explicit dependencies (including privacy gating and transactional outbox)');

  // 4.14 SessionTelemetryService (precompute and cache session vitals)
  // P0-G.1: Added watermark repo for watermark-based staleness detection
  logger.info('Creating session telemetry service...');
  const sessionTelemetryService = new SessionTelemetryService(
    repositoryFactory.getHealthSampleRepository(),
    repositoryFactory.getSessionTelemetryCacheRepository(),
    repositoryFactory.getSessionRepository(),
    logger,
    repositoryFactory.getUserHealthWatermarkRepository(),
  );
  logger.info('✓ Session telemetry service created with explicit dependencies (including watermark repo)');

  // 4.7 REMOVED: EnhancedConsumptionService - functionality merged into ConsumptionService

  // 4.15 OutboxProcessorService (refactored with explicit dependencies)
  logger.info('Creating outbox processor service...');
  const outboxProcessorService = new OutboxProcessorService(
    outboxService,
    logger,
    configSecurityService, //  FIXED: Inject ConfigSecurityService for config access
  );
  await outboxProcessorService.initialize();
  logger.info(' Outbox processor service created with explicit dependencies');

  // 4.16 SecurityMonitoringService (refactored with explicit dependencies)
  logger.info('Creating security monitoring service...');
  const securityMonitoringService = new SecurityMonitoringService(
    securityLoggerService,
    logger,
  );
  logger.info(' Security monitoring service created with explicit dependencies');

  // Performance monitoring and correlation tracker services moved up before AI services

  //  ISSUE #2.1.4: Create UserConsumptionProfileService and PersonalizedConsumptionRateService BEFORE ConsumptionService
  // PIPELINE FIX: populationStatsService already created above (before PurchaseService) — reusing same instance
  logger.info('Creating user consumption profile service...');
  const driftDetectorService = new DriftDetectorService(
    repositoryFactory.getUserConsumptionProfileRepository(),
    logger,
  );
  const userConsumptionProfileService = new UserConsumptionProfileService(
    repositoryFactory.getUserConsumptionProfileRepository(),
    repositoryFactory.getPurchaseRepository(),
    repositoryFactory.getConsumptionRepository(),
    domainEventService,
    populationStatsService,
    driftDetectorService,
    logger,
    cacheService, // For EMA learning distributed lock (prevents concurrent execution)
  );
  logger.info(' User consumption profile service created');

  logger.info('Creating personalized consumption rate service...');
  const personalizedConsumptionRateService = new PersonalizedConsumptionRateService(
    userConsumptionProfileService,
    repositoryFactory.getConsumptionRepository(),
    logger,
  );
  logger.info(' Personalized consumption rate service created');

  // 4.14.2 Now create ConsumptionService with all dependencies - PostgreSQL only
  logger.info('Creating consumption service...');
  const consumptionService = new ConsumptionService(
    repositoryFactory.getConsumptionRepository(),
    repositoryFactory.getSessionRepository(),
    repositoryFactory.getDailyStatRepository(),
    repositoryFactory.getProductRepository(),
    repositoryFactory.getPurchaseRepository(), //  ISSUE #2.2: Inject PurchaseRepository for cost calculations
    repositoryFactory.getInventoryRepository(),
    logger,
    outboxService,
    domainEventService,
    performanceMonitoringService,
    correlationTracker,
    personalizedConsumptionRateService, //  ISSUE #2.1.4: Inject PersonalizedConsumptionRateService
    databaseService, // Finding 7 FIX: Inject DatabaseService for transactional outbox writes
  );
  await consumptionService.initialize();
  logger.info(' Consumption service created with PostgreSQL repository dependencies, personalized rate service, and purchase repository');

  // 4.6 AnalyticsService (moved here due to dependency on consumptionService - PostgreSQL only)
  logger.info('Creating analytics service...');
  const analyticsService = new AnalyticsService(
    repositoryFactory.getConsumptionRepository(),
    repositoryFactory.getPurchaseRepository(),
    repositoryFactory.getProductRepository(),
    repositoryFactory.getSessionRepository(),
    repositoryFactory.getDailyStatRepository(),
    repositoryFactory.getJournalRepository(),
    databaseService,
    logger,
    s3Service,
    analyticsEventRepository,  // Using PostgreSQL AnalyticsEventRepository instead of DynamoDB
    cacheService,
    goalsService,
    achievementsService,
    journalService,
    consumptionService,
  );
  await analyticsService.initialize();
  logger.info(' Analytics service created with PostgreSQL repository dependencies');

  // NOTE: Domain event subscribers initialization moved to after userRoutineService is created (line ~1301)

  // 4.15 ControllerRegistry (pure constructor DI - no singleton)
  logger.info('Creating controller registry...');
  const controllerRegistry = new ControllerRegistry(logger);
  logger.info(' Controller registry created with pure constructor injection');

  // 4.16 APIGatewayManager (refactored with explicit dependencies)
  logger.info('Creating API gateway manager...');
  const apiGatewayManager = new APIGatewayManager(logger, performanceMonitoringService);
  logger.info(' API gateway manager created with explicit dependencies');

  // 4.16.1 APICacheManager (refactored with explicit dependencies)
  logger.info('Creating API cache manager...');
  const apiCacheManager = new APICacheManager(
    cacheService,
    logger,
    performanceMonitoringService,
  );
  logger.info(' API cache manager created with explicit dependencies');

  // 4.16.2 MiddlewareFactory (pure constructor DI - no singleton)
  logger.info('Creating middleware factory...');
  const middlewareFactory = new MiddlewareFactory(
    logger,
    performanceMonitoringService,
    securityLoggerService,
  );
  logger.info(' Middleware factory created with pure constructor injection');

  // 4.16.3 RouteRegistry (pure constructor DI - no singleton)
  logger.info('Creating route registry...');
  const routeRegistry = new RouteRegistry(logger);
  logger.info(' Route registry created with pure constructor injection');

  // 4.16.4 App (pure constructor DI - no singleton)
  logger.info('Creating App instance with explicit dependencies...');
  const { App: AppClass } = await import('./app');
  const app = new AppClass(logger, configSecurityService);
  logger.info(' App instance created with pure constructor injection (LoggerService, ConfigSecurityService)');

  // 4.17 SyncService (refactored with Strategy Pattern for entity handlers)
  logger.info('Creating sync entity handlers...');

  // Create entity-specific sync handlers with explicit DI
  const sessionHandler = new SessionHandler(
    repositoryFactory.getSessionRepository(),
    repositoryFactory.getConsumptionRepository(),
    logger,
    outboxService, // Injected for durable session.ended emission during sync
  );

  const journalHandler = new JournalHandler(
    repositoryFactory.getJournalRepository(),
    logger,
  );

  const purchaseHandler = new PurchaseHandler(
    repositoryFactory.getPurchaseRepository(),
    logger,
    outboxService,
  );

  const consumptionHandler = new ConsumptionHandler(
    repositoryFactory.getConsumptionRepository(),
    repositoryFactory.getInventoryRepository(),
    repositoryFactory.getPurchaseRepository(),
    logger,
    outboxService,
    personalizedConsumptionRateService, // PIPELINE FIX: Sync handler uses personalized rates matching online path
  );

  const goalHandler = new GoalHandler(
    repositoryFactory.getGoalRepository(),
    logger,
  );

  const deviceHandler = new DeviceHandler(
    repositoryFactory.getDeviceRepository(),
    logger,
  );

  const userAchievementHandler = new UserAchievementHandler(
    repositoryFactory.getUserAchievementRepository(),
    logger,
  );

  const inventoryItemHandler = new InventoryItemHandler(
    repositoryFactory.getInventoryRepository(),
    logger,
  );

  // Implements security guards: Users CANNOT modify public catalog products
  const productHandler = new ProductHandler(
    repositoryFactory.getProductRepository(),
    logger,
  );

  // Register handlers in Map for entity-agnostic sync operations
  const entityHandlers = new Map<string, import('./services/sync/sync.types').SyncEntityHandler<unknown>>([
    [SYNC_ENTITY_TYPES.SESSIONS, sessionHandler],
    [SYNC_ENTITY_TYPES.JOURNALS, journalHandler],
    [SYNC_ENTITY_TYPES.PURCHASES, purchaseHandler],
    [SYNC_ENTITY_TYPES.CONSUMPTIONS, consumptionHandler],
    [SYNC_ENTITY_TYPES.GOALS, goalHandler],
    [SYNC_ENTITY_TYPES.DEVICES, deviceHandler],
    [SYNC_ENTITY_TYPES.USER_ACHIEVEMENTS, userAchievementHandler],
    [SYNC_ENTITY_TYPES.INVENTORY_ITEMS, inventoryItemHandler],
    [SYNC_ENTITY_TYPES.PRODUCTS, productHandler],
  ]);

  logger.info(' Sync entity handlers created', {
    registeredTypes: Array.from(entityHandlers.keys()),
    handlerCount: entityHandlers.size,
  });

  // Create SyncService with handler registry
  logger.info('Creating sync service with handler pattern...');
  const syncService = new SyncService(
    databaseService,
    logger,
    performanceMonitoringService,
    cacheService,
    repositoryFactory,
    entityHandlers,
  );

  // Initialize SyncService with configuration
  logger.info('Initializing sync service with AWS and Redis configuration...');
  await syncService.initialize({
    aws: {
      region: config.aws.region,
      accessKeyId: config.aws.accessKeyId,
      secretAccessKey: config.aws.secretAccessKey,
    },
    redis: {
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
    },
    nodeEnv: config.nodeEnv,
  });
  logger.info(' Sync service created and initialized with Strategy Pattern (9 handlers registered)');

  // 4.18 BackupService (refactored with explicit dependencies)
  logger.info('Creating backup service...');
  const backupService = new BackupService(
    s3Service,
    databaseService,
    logger,
    configSecurityService, //  FIXED: Inject ConfigSecurityService for DATABASE_URL access
  );
  await backupService.initialize();
  logger.info(' Backup service created with explicit dependencies');

  // 4.19 JobProcessor (new with explicit dependencies)
  // NOTE: JobProcessor requires:
  // - HealthSampleRepository for the health ingest reaper job
  // - SessionTelemetryCacheRepository for the session telemetry lock reaper job
  // - PerformanceMonitoringService for metrics emission
  logger.info('Creating job processor...');
  const jobProcessor = new JobProcessor(
    logger,
    analyticsService,
    cacheService,
    databaseService,
    repositoryFactory.getHealthSampleRepository(),       // Required for health ingest reaper job
    healthSampleService,                                  // Required for queued ingest jobs
    sessionTelemetryService,                              // Required for session telemetry compute jobs
    performanceMonitoringService,                         // Required for metrics emission
    repositoryFactory.getSessionTelemetryCacheRepository(), // Required for session telemetry lock reaper job
    repositoryFactory.getInventoryRepository(),            // Required for inventory reconciliation job (GAP D fix)
    sessionService,                                        // Required for stale session reconciliation job
  );
  await jobProcessor.initialize();
  logger.info(' Job processor created with explicit dependencies (incl. SessionTelemetryCacheRepository, InventoryRepository)');

  // 4.20 JobManagerService (new with explicit dependencies)
  // NOTE: JobManagerService no longer depends on CacheService because BullMQ
  // requires a SEPARATE Redis instance with `noeviction` policy
  logger.info('Creating job manager service...');
  const jobManagerService = new JobManagerService(
    logger,
    jobProcessor,
  );
  
  // Get BullMQ-specific Redis URL (separate from cache Redis)
  // Cache Redis uses `volatile-ttl` for optimal cache management
  const bullmqRedisUrl = configSecurityService.getBullMQRedisUrl();
  
  if (!bullmqRedisUrl) {
    logger.error(' BULLMQ_REDIS_URL not configured. BullMQ requires a dedicated Redis instance with noeviction policy.');
    throw new Error('BULLMQ_REDIS_URL is required for job queue functionality');
  }

  // Web service (mode='web', enableWorkers=false): Creates queues, adds jobs (producer only)
  // Background Worker service (mode='worker', enableWorkers=true): Processes jobs (consumer only)
  // This prevents resource conflicts and allows independent scaling
  const enableJobWorkers = options.enableWorkers ?? (isWorkerMode && config.nodeEnv !== 'test');

  await jobManagerService.initialize({
    redisUrl: bullmqRedisUrl,
    queueNames: [
      JobNames.EXPORT_ANALYTICS,
      JobNames.GENERATE_WEEKLY_REPORT,
      JobNames.SCHEMA_MIGRATION,
      JobNames.CACHE_WARMING,
      JobNames.REFRESH_ANALYTICS_MVS,
      JobNames.HEALTH_INGEST_REAPER,  // Proactive stale request recovery
      JobNames.HEALTH_SAMPLE_SOFT_DELETE_PURGER, // Periodic purge of soft-deleted health samples
      JobNames.HEALTH_INGEST_BATCH,
      JobNames.SESSION_TELEMETRY_COMPUTE,
      JobNames.SESSION_TELEMETRY_LOCK_REAPER,  // Reap stale COMPUTING rows
      JobNames.INVENTORY_RECONCILIATION,  // Reconcile unlinked consumptions with inventory
      JobNames.STALE_SESSION_RECONCILIATION,  // Proactive global stale session cleanup
    ],
    enableWorker: enableJobWorkers, // Use explicit option or fallback to WORKER_MODE env var
    workerConcurrency: 5,
  });
  logger.info(` Job manager service initialized ${enableJobWorkers ? 'with workers enabled' : 'as producer only'}`);

  // Initialize recurring job schedules
  // BullMQ repeatable jobs are idempotent by jobId, but cleaner to schedule from one place
  if (enableJobWorkers) {
    logger.info('Initializing recurring job schedules (worker mode)...');
    try {
      await initializeAllSchedules(logger, jobManagerService);
      logger.info('✓ All recurring job schedules initialized successfully');
    } catch (scheduleError) {
      // Log but don't fail startup - schedules can be retried or added manually
      logger.error('✗ Failed to initialize recurring job schedules', {
        context: 'bootstrap.initializeAllSchedules',
        error: scheduleError instanceof Error ? scheduleError.message : String(scheduleError),
      });
    }
  } else {
    logger.info('Skipping job schedule initialization (producer-only mode)');
  }

  // Post-init health verification: confirm repeatable jobs are registered in BullMQ.
  // This runs in BOTH worker and producer modes to provide observability into job health.
  // In worker mode: verifies that initializeAllSchedules succeeded.
  // In producer mode: verifies that the worker service has registered its schedules.
  try {
    const jobHealth = await jobManagerService.verifyRepeatableJobs();
    const totalRepeatable = jobHealth.reduce((sum, q) => sum + q.repeatableJobs.length, 0);
    if (enableJobWorkers && totalRepeatable === 0) {
      logger.error('CRITICAL: Worker mode active but no repeatable jobs registered. Recurring jobs (reconciliation, analytics) will NOT run.', {
        context: 'bootstrap.jobHealthVerification',
      });
    }
  } catch (healthError) {
    logger.warn('Job health verification failed (non-fatal)', {
      context: 'bootstrap.jobHealthVerification',
      error: healthError instanceof Error ? healthError.message : String(healthError),
    });
  }

  // 4.21 Health ingest queue service (async ingestion)
  logger.info('Creating health ingest queue service...');
  const healthIngestQueueService = new HealthIngestQueueService(
    repositoryFactory.getHealthSampleRepository(),
    healthSampleService,
    jobManagerService,
    logger,
    performanceMonitoringService,
  );
  logger.info(' Health ingest queue service created');

  // 4.22 Session telemetry queue service (precompute scheduling)
  logger.info('Creating session telemetry queue service...');
  const sessionTelemetryQueueService = new SessionTelemetryQueueService(
    repositoryFactory.getSessionRepository(),
    repositoryFactory.getSessionTelemetryCacheRepository(),
    jobManagerService,
    logger,
  );
  logger.info(' Session telemetry queue service created');
  
  // TEMPORARILY DISABLE: Initialize analytics job schedules
  // NOTE: Job scheduling disabled during startup to prevent immediate execution
  // Jobs will be scheduled after application is fully initialized and stable
  logger.info(' Analytics job schedules disabled during startup - will schedule after server is ready');
  // try {
  //   await initializeAnalyticsSchedules(logger, jobManagerService); //  FIXED: Pass logger and jobManager dependencies
  //   logger.info(' Analytics job schedules initialized');
  // } catch (error) {
  //   logger.warn('  Failed to initialize analytics schedules', {
  //     error: error instanceof Error ? error.message : String(error)
  //   });
  // }

  // PHASE 7: User Profiling Services (depends on business services)
  logger.info('\n=== PHASE 7: User Profiling Services ===');

  // 4.5.1 UserConsumptionProfileService - MOVED EARLIER (before ConsumptionService)
  // Already created in line ~894 for PersonalizedConsumptionRateService dependency

  // 4.5.2 UserRoutineService (simplified — HMM deps removed, now 4 params)
  // ConsumptionRepository, SessionRepository, SafetyRecordRepository removed:
  // HMM training/detection/prediction retired → replaced by TemporalPatternService
  logger.info('Creating user routine service...');
  const userRoutineService = new UserRoutineService(
    repositoryFactory.getUserRoutineProfileRepository(),
    logger,
    cacheService,
    domainEventService,
  );
  logger.info(' User routine service created with explicit dependencies');

  // 4.5.2b TemporalPatternService (Dirichlet-multinomial histogram engine)
  logger.info('Creating temporal pattern service...');
  const temporalPatternService = new TemporalPatternService(
    repositoryFactory.getUserRoutineProfileRepository(),
    repositoryFactory.getConsumptionRepository(),
    repositoryFactory.getDailyStatRepository(),
    logger,
  );
  logger.info(' Temporal pattern service created');

  // 4.5.3 InventoryPredictionService (with explicit dependencies)
  logger.info('Creating inventory prediction service...');
  const inventoryPredictionService = new InventoryPredictionService(
    userConsumptionProfileService,
    userRoutineService,
    safetyService,
    repositoryFactory.getInventoryRepository(),
    repositoryFactory.getPurchaseRepository(),
    repositoryFactory.getConsumptionRepository(),
    repositoryFactory.getPredictionRecordRepository(),
    domainEventService,
    logger,
    temporalPatternService, // DRY FIX: Delegates Dirichlet temporal computation to single source of truth
    outboxService, // Durable outbox for prediction domain events
  );
  logger.info(' Inventory prediction service created with explicit dependencies');

  // Initialize domain event subscribers now that all required services are available
  //  ARCHITECTURAL FIX: Removed databaseService from dependencies
  // Subscribers use repositories directly, which already have PrismaClient injected
  logger.info('Initializing domain event subscribers...');
  await initializeDomainSubscribers({
    domainEventService,
    achievementsService,
    goalsService,
    userRoutineService,
    logger,
    repositoryFactory, // Inject repositoryFactory for subscribers to access repositories
    sessionTelemetryQueueService,
    webSocketBroadcaster,
    userConsumptionProfileService, // Required for PurchaseFinishedSubscriber (EMA learning)
    temporalPatternService, // Required for TemporalPatternSubscriber (Dirichlet histogram)
  }, {
    enableAchievements: true,
    enableAnalytics: true,
    enableGoals: true,
    enableWebSocket: true,
    enableTemporalPattern: true,
    analyticsConfig: {
      bufferSize: 100,
      flushIntervalMs: 30000,
      enableRealTimeAnalytics: true,
    },
  });
  logger.info(' Domain event subscribers initialized');

  // PHASE 8: Controller instantiation and registration
  logger.info('\n=== PHASE 8: Controller Instantiation ===');

  logger.info('Instantiating controllers with explicit dependencies...');

  // 5.1 User Controller
  logger.info('Creating user controller...');
  const userController = new UserController(
    userService,
    logger,
    s3Service,
  );
  controllerRegistry.registerController('user', userController);

  // 5.2 Consumption Controller
  logger.info('Creating consumption controller...');
  const consumptionController = new ConsumptionController(
    consumptionService,
    socketService,
    logger,
  );
  controllerRegistry.registerController('consumption', consumptionController);

  // 5.3 AI Controller
  logger.info('Creating AI controller...');
  const aiController = new AIController(
    aiService,
    logger,
    config,
  );
  controllerRegistry.registerController('ai', aiController);

  // 5.3.1 AI Analysis Controller (requires all AI services)
  logger.info('Creating AI analysis controller...');
  const aiAnalysisController = new AiAnalysisController(
    aiJournalAnalysisService,
    aiProductRecommendationService,
    aiWeeklyReportService,
    repositoryFactory.getAiAnalysisRepository(),
    repositoryFactory.getAiRecommendationSetRepository(),
    socketService,
    logger,
  );
  controllerRegistry.registerController('ai-analysis', aiAnalysisController);

  // 5.3.2 AI Administration Controller (requires AI repositories)
  logger.info('Creating AI administration controller...');
  const aiAdministrationController = new AiAdministrationController(
    repositoryFactory.getAiResponseCacheRepository(),
    repositoryFactory.getAiAnalysisRepository(),
    repositoryFactory.getAiChatThreadRepository(),
    repositoryFactory.getAiRecommendationSetRepository(),
    aiCostTrackingService,
    logger,
  );
  controllerRegistry.registerController('ai-administration', aiAdministrationController);

  // 5.3.3 AI Cache Controller (requires cache repository)
  logger.info('Creating AI cache controller...');
  const aiCacheController = new AiCacheController(
    repositoryFactory.getAiResponseCacheRepository(),
    logger,
  );
  controllerRegistry.registerController('ai-cache', aiCacheController);

  // 5.3.4 AI Chat Controller (requires chat repositories)
  logger.info('Creating AI chat controller...');
  const aiChatController = new AiChatController(
    repositoryFactory.getAiChatThreadRepository(),
    repositoryFactory.getAiChatMessageRepository(),
    repositoryFactory.getAiResponseCacheRepository(),
    aiService,
    socketService,
    logger,
  );
  controllerRegistry.registerController('ai-chat', aiChatController);

  // 5.4 Analytics Controller (now using PostgreSQL repositories)
  logger.info('Creating analytics controller...');
  const analyticsController = new AnalyticsController(
    analyticsService,
    repositoryFactory.getDailyStatRepository(),
    repositoryFactory.getConsumptionRepository(),
    socketService,
    logger,
  );
  controllerRegistry.registerController('analytics', analyticsController);

  // 5.5 Journal Controller
  logger.info('Creating journal controller...');
  const journalController = new JournalController(
    journalService,
    logger,
  );
  controllerRegistry.registerController('journal', journalController);

  // 5.6 Product Controller
  logger.info('Creating product controller...');
  const productController = new ProductController(
    productService,
    logger,
  );
  controllerRegistry.registerController('product', productController);

  // 5.7 Inventory Controller
  logger.info('Creating inventory controller...');
  const inventoryController = new InventoryController(
    inventoryService,
    logger,
  );
  controllerRegistry.registerController('inventory', inventoryController);

  // 5.8 Goals Controller
  logger.info('Creating goals controller...');
  const goalsController = new GoalsController(
    goalsService,
    logger,
  );
  controllerRegistry.registerController('goals', goalsController);

  // 5.9 Achievements Controller
  logger.info('Creating achievements controller...');
  const achievementsController = new AchievementsController(
    achievementsService,
    logger,
  );
  controllerRegistry.registerController('achievements', achievementsController);

  // 5.10 Session Controller
  logger.info('Creating session controller...');
  const sessionController = new SessionController(
    sessionService,
    logger,
    sessionTelemetryService,
    sessionTelemetryQueueService,
  );
  controllerRegistry.registerController('session', sessionController);

  // 5.11 Purchase Controller
  logger.info('Creating purchase controller...');
  const purchaseController = new PurchaseController(
    purchaseService,
    logger,
  );
  controllerRegistry.registerController('purchase', purchaseController);

  // 5.12 Device Controller
  logger.info('Creating device controller...');
  const deviceController = new DeviceController(
    deviceService,
    logger,
  );
  controllerRegistry.registerController('device', deviceController);

  // 5.13 Sync Controller
  logger.info('Creating sync controller...');
  const syncController = new SyncController(
    syncService,
    socketService, // Enhanced: SocketService for real-time sync notifications
    logger,
    repositoryFactory.getSyncOperationRepository(),
    repositoryFactory.getSyncConflictRepository(),
    syncLeaseService,
  );
  controllerRegistry.registerController('sync', syncController);

  // 5.14 WebSocket Controller
  logger.info('Creating websocket controller...');
  const websocketController = new WebSocketController(
    socketService,
    logger,
  );
  controllerRegistry.registerController('websocket', websocketController);

  // 5.15 AI Usage Controller
  logger.info('Creating AI usage controller...');
  const aiUsageController = new AIUsageController(
    aiCostTrackingService,
    aiService,
    logger,
    databaseService,
  );
  controllerRegistry.registerController('aiUsage', aiUsageController);

  // 5.16 Telemetry Controller (using PostgreSQL repository)
  logger.info('Creating telemetry controller...');
  const telemetryController = new TelemetryController(
    deviceTelemetryService,
    socketService,
    logger,
  );
  controllerRegistry.registerController('telemetry', telemetryController);

  // 5.17 Consumption Analytics Controller
  logger.info('Creating consumption analytics controller...');
  const consumptionAnalyticsController = new ConsumptionAnalyticsController(
    consumptionService,
    socketService,
    logger,
  );
  controllerRegistry.registerController('consumption-analytics', consumptionAnalyticsController);

  // 5.18 User Profiling Controller
  logger.info('Creating user profiling controller...');
  const userProfilingController = new UserProfilingController(
    userConsumptionProfileService,
    userRoutineService,
    inventoryPredictionService,
    logger,
  );
  controllerRegistry.registerController('userProfiling', userProfilingController);

  // 5.19 Safety Controller
  logger.info('Creating safety controller...');
  const safetyController = new SafetyController(
    safetyService,
    logger,
  );
  controllerRegistry.registerController('safety', safetyController);

  // 5.20 Health Controller (HealthKit/Health Connect data)
  logger.info('Creating health controller...');
  const healthController = new HealthController(
    healthSampleService,
    healthIngestQueueService,
    logger,
    healthProjectionReadService,
  );
  controllerRegistry.registerController('health', healthController);

  // All controllers created and registered
  logger.info(` All controllers created and registered (${controllerRegistry.getControllerNames().length} total)`);

  // Return initialized services with explicit dependencies
  logger.info('\n=== All services initialized successfully ===\n');
  
  // Define shutdown functionality
  async function shutdown(): Promise<void> {
    logger.info(' Shutting down application services...');

    try {
      // Shutdown services in reverse dependency order
      // Only call methods that actually exist on the services
      await jobManagerService.shutdown?.();
      await domainEventService.shutdown?.();
      await socketService.close?.();
      await syncService.cleanup?.();
      await databaseService.disconnect();

      // Flush and shutdown CloudWatch Logs (if configured)
      if (cloudWatchLogsService) {
        await cloudWatchLogsService.shutdown();
      }

      logger.info(' All services shut down successfully');
    } catch (error) {
      logger.error(' Error during service shutdown', error);
      throw error;
    }
  }

  const initializedServices: InitializedServices = {
    // Configuration
    config,

    // Foundational services
    logger,
    cloudWatchLogsService,
    databaseService,
    cacheService,
    repositoryFactory,

    // Core services
    domainEventService,
    outboxService,

    // PostgreSQL repositories for time-series data
    deviceTelemetryRepository,
    analyticsEventRepository,
    s3Service,
    
    // Auth services (refactored with explicit DI)
    cognitoService,
    cognitoUtils,  //  Added to initialized services for middleware-factory
    authenticationUtils,  //  Added to initialized services for middleware-factory
    authenticationService,
    authRateLimitService,
    sessionSecurityService,
    
    // Business services (refactored)
    consumptionService,
    journalService,
    userService,
    analyticsService,
    aiService,
    deviceService,
    sessionService,
    purchaseService,
    inventoryService,
    productService,
    achievementsService,
    goalsService,
    safetyService,
    healthSampleService,
    sessionTelemetryService,

    // Business services (now properly initialized)
    aiCostTrackingService,
    aiContextAggregationService,
    aiPhiRedactionService,
    aiProductRecommendationService,
    aiJournalAnalysisService,
    aiWeeklyReportService,
    deviceTelemetryService,
    outboxProcessorService,

    // User profiling services
    userConsumptionProfileService,
    userRoutineService,
    temporalPatternService,
    inventoryPredictionService,
    personalizedConsumptionRateService, //  ISSUE #2.1.4
    
    // Infrastructure services
    socketService,
    webSocketBroadcaster,
    securityConfigService: configSecurityService,
    securityLoggerService,
    securityMonitoringService,
    performanceMonitoringService,
    rateLimitingQueueService,
    syncService,
    syncLeaseService,
    healthIngestQueueService,
    sessionTelemetryQueueService,
    backupService,
    requestValidationService,
    correlationTracker,
    httpsValidationService,

    // Job processing services
    jobProcessor,
    jobManagerService,

    // API layer
    app,
    apiGatewayManager,
    apiCacheManager,
    controllerRegistry,
    middlewareFactory,
    routeRegistry,

    // Lifecycle management
    shutdown,
  };

  return Object.freeze(initializedServices);
}

/**
 * Perform health checks on all initialized services
 * 
 * @param services - The initialized services object
 * @returns Promise resolving to health check results
 */
export async function performHealthChecks(services: InitializedServices): Promise<HealthCheckSummary> {
  const checks: HealthCheckResult[] = [];  //  Strong typing

  // Check cache service with strong typing
  try {
    const cacheHealthy = services.cacheService.isReady();
    checks.push({
      service: 'cache',
      healthy: cacheHealthy,
      details: {
        status: cacheHealthy ? 'healthy' : 'unhealthy',
        lastCheck: new Date(),
        metrics: {
          connections: cacheHealthy ? 1 : 0,
        },
      },
    });
  } catch (error) {
    checks.push({
      service: 'cache',
      healthy: false,
      details: {
        status: 'unhealthy',
        lastCheck: new Date(),
        error: {
          code: 'CACHE_ERROR',
          message: error instanceof Error ? error.message : 'Unknown cache error',
        },
      },
    });
  }

  // Check socket service with strong typing
  try {
    const socketStatus = services.socketService.getHealthStatus();
    checks.push({
      service: 'websocket',
      healthy: socketStatus.status === 'healthy',
      details: {
        status: socketStatus.status === 'healthy' ? 'healthy' : 'unhealthy',
        lastCheck: new Date(),
        metrics: {
          connections: typeof socketStatus.details === 'object' &&
                      socketStatus.details !== null &&
                      'connections' in socketStatus.details
                      ? Number(socketStatus.details.connections) || 0
                      : 0,
        },
      },
    });
  } catch (error) {
    checks.push({
      service: 'websocket',
      healthy: false,
      details: {
        status: 'unhealthy',
        lastCheck: new Date(),
        error: {
          code: 'WEBSOCKET_ERROR',
          message: error instanceof Error ? error.message : 'Unknown websocket error',
        },
      },
    });
  }

  // Add more health checks as needed

  const allHealthy = checks.every(check => check.healthy);

  return { allHealthy, checks };
}
