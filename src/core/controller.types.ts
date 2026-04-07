/**
 * Controller Type Definitions
 * Provides strict typing for all controller-related operations
 *
 * This module defines comprehensive type safety for the controller registry
 * and all controller dependencies, eliminating any 'any' types.
 */

import { LoggerService } from '../services/logger.service';

/**
 * Base controller interface that all controllers must implement
 */
export interface IController {
  initialize?(): Promise<void>;
}

/**
 * Controller service dependencies base interface
 */
export interface BaseControllerDependencies {
  logger: LoggerService;
}

/**
 * Specific controller dependency interfaces
 */
export interface UserControllerDependencies extends BaseControllerDependencies {
  userService: import('../services/user.service').UserService;
  s3Service?: import('../services/s3.service').S3Service;
}

export interface ConsumptionControllerDependencies extends BaseControllerDependencies {
  consumptionService: import('../services/consumption.service').ConsumptionService;
  socketService: import('../websocket/socket.service').SocketService;
}

export interface AIControllerDependencies extends BaseControllerDependencies {
  costTracking: import('../services/aiCostTracking.service').AICostTrackingService;
  database: import('../services/database.service').DatabaseService;
  secretsService: import('../services/secrets.service').SecretsService;
}

export interface AnalyticsControllerDependencies extends BaseControllerDependencies {
  analyticsService: import('../services/analytics.service').AnalyticsService;
  dailyStatRepository: import('../repositories/daily-stat.repository').DailyStatRepository;
  socketService: import('../websocket/socket.service').SocketService;
}

export interface JournalControllerDependencies extends BaseControllerDependencies {
  journalService: import('../services/journal.service').JournalService;
}

export interface ProductControllerDependencies extends BaseControllerDependencies {
  productService: import('../services/product.service').ProductService;
}

export interface InventoryControllerDependencies extends BaseControllerDependencies {
  inventoryService: import('../services/inventory.service').InventoryService;
}

export interface GoalsControllerDependencies extends BaseControllerDependencies {
  goalsService: import('../services/goals.service').GoalsService;
}

export interface AchievementsControllerDependencies extends BaseControllerDependencies {
  achievementsService: import('../services/achievements.service').AchievementsService;
}

export interface SessionControllerDependencies extends BaseControllerDependencies {
  sessionService: import('../services/session.service').SessionService;
}

export interface PurchaseControllerDependencies extends BaseControllerDependencies {
  purchaseService: import('../services/purchase.service').PurchaseService;
}

export interface DeviceControllerDependencies extends BaseControllerDependencies {
  deviceService: import('../services/device.service').DeviceService;
}

export interface SyncControllerDependencies extends BaseControllerDependencies {
  syncService: import('../services/sync.service').SyncService;
  database: import('../services/database.service').DatabaseService;
}

export interface WebSocketControllerDependencies extends BaseControllerDependencies {
  socketService: import('../websocket/socket.service').SocketService;
}

export interface AIUsageControllerDependencies extends BaseControllerDependencies {
  costTracking: import('../services/aiCostTracking.service').AICostTrackingService;
  aiService: import('../services/ai.service').AIService;
}

export interface TelemetryControllerDependencies extends BaseControllerDependencies {
  telemetryService: import('../services/deviceTelemetry.service').DeviceTelemetryService;
  socketService: import('../websocket/socket.service').SocketService;
}

export interface ConsumptionAnalyticsControllerDependencies extends BaseControllerDependencies {
  consumptionService: import('../services/consumption.service').ConsumptionService;
  socketService: import('../websocket/socket.service').SocketService;
}

/**
 * Union of all possible controller types
 */
export type AnyController =
  | import('../api/v1/controllers/user.controller').UserController
  | import('../api/v1/controllers/consumption.controller').ConsumptionController
  | import('../api/v1/controllers/ai.controller').AIController
  | import('../api/v1/controllers/ai-analysis.controller').AiAnalysisController
  | import('../api/v1/controllers/ai-administration.controller').AiAdministrationController
  | import('../api/v1/controllers/ai-cache.controller').AiCacheController
  | import('../api/v1/controllers/ai-chat.controller').AiChatController
  | import('../api/v1/controllers/analytics.controller').AnalyticsController
  | import('../api/v1/controllers/journal.controller').JournalController
  | import('../api/v1/controllers/product.controller').ProductController
  | import('../api/v1/controllers/inventory.controller').InventoryController
  | import('../api/v1/controllers/goals.controller').GoalsController
  | import('../api/v1/controllers/achievements.controller').AchievementsController
  | import('../api/v1/controllers/session.controller').SessionController
  | import('../api/v1/controllers/purchase.controller').PurchaseController
  | import('../api/v1/controllers/device.controller').DeviceController
  | import('../api/v1/controllers/sync.controller').SyncController
  | import('../api/v1/controllers/websocket.controller').WebSocketController
  | import('../api/v1/controllers/aiUsage.controller').AIUsageController
  | import('../api/v1/controllers/telemetry.controller').TelemetryController
  | import('../api/v1/controllers/consumption-analytics.controller').ConsumptionAnalyticsController
  | import('../api/v1/controllers/user-profiling.controller').UserProfilingController
  | import('../api/v1/controllers/safety.controller').SafetyController
  | import('../api/v1/controllers/health.controller').HealthController;

/**
 * Controller registry type-safe storage
 */
export type ControllerRegistryMap = Map<string, AnyController>;

/**
 * Health check detail types for strict typing
 */
export interface ServiceHealthDetails {
  status: 'healthy' | 'unhealthy' | 'degraded';
  responseTime?: number;
  lastCheck?: Date;
  version?: string;
  error?: {
    code: string;
    message: string;
    stack?: string;
  };
  metrics?: {
    uptime?: number;
    memory?: number;
    connections?: number;
    cacheSize?: number;
  };
}

/**
 * Strongly typed health check result
 */
export interface HealthCheckResult {
  service: string;
  healthy: boolean;
  details: ServiceHealthDetails;  // No more 'any' types
}

/**
 * Health check function return type
 */
export interface HealthCheckSummary {
  allHealthy: boolean;
  checks: HealthCheckResult[];
}

/**
 * HTTP method types for strong typing
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

/**
 * API Gateway request configuration with strong typing
 */
export interface ApiGatewayRequestConfig {
  method: HttpMethod;
  url: string;
  params?: Record<string, unknown>;
  data?: unknown;
  headers: Record<string, string>;
  timeout?: number;
}

/**
 * API Gateway response type
 */
export interface ApiGatewayResponse<T = unknown> {
  data: T;
  status: number;
  statusText: string;
  headers: Record<string, string>;
}