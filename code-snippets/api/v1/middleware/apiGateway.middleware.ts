/**
 * API Gateway Middleware
 * Provides comprehensive API gateway functionality including circuit breakers,
 * request/response transformation, and service discovery
 * 
 * @module apiGateway.middleware
 * @description Completes Express.js's role as a full-featured API Gateway with
 * enterprise-grade patterns for reliability, observability, and performance.
 */

import { Request, Response, NextFunction } from 'express';
import axios, { AxiosInstance, AxiosRequestConfig, AxiosError } from 'axios';
import { LoggerService } from '../../../services/logger.service';
import { PerformanceMonitoringService } from '../../../services/performanceMonitoring.service';
import { getCurrentCorrelationId, CorrelationContextManager } from './correlationContext.middleware';

/**
 * Circuit breaker states
 */
enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN'
}

/**
 * Circuit breaker configuration
 */
interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeout: number;
  monitoringPeriod: number;
  halfOpenRequests: number;
  timeout: number;
}

/**
 * Service registry entry
 */
interface ServiceEndpoint {
  name: string;
  baseUrl: string;
  healthCheck?: string;
  timeout?: number;
  retries?: number;
  circuitBreaker?: Partial<CircuitBreakerConfig>;
  headers?: Record<string, string>;
  client?: AxiosInstance;
}

/**
 * Request transformation function
 */
type RequestTransformer = (req: Request) => Request | Promise<Request>;

/**
 * Response transformation function
 */
type ResponseTransformer = (res: Response, data: unknown) => unknown | Promise<unknown>;

/**
 * API version configuration
 */
interface APIVersionConfig {
  version: string;
  deprecated?: boolean;
  sunsetDate?: Date;
  transformRequest?: RequestTransformer;
  transformResponse?: ResponseTransformer;
}

/**
 * Circuit breaker status information
 */
interface CircuitBreakerStatus {
  state: CircuitState;
  failures: number;
  nextAttempt?: Date;
}

/**
 * Service endpoint status
 */
interface ServiceStatus {
  url: string;
  circuitBreaker: CircuitBreakerStatus | null;
}

/**
 * Circuit Breaker implementation
 */
class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private lastFailureTime?: number;
  private successCount: number = 0;
  private nextAttempt?: number;
  private readonly config: CircuitBreakerConfig;
  private readonly name: string;
  private readonly logger: LoggerService;

  constructor(name: string, logger: LoggerService, config: Partial<CircuitBreakerConfig> = {}) {
    this.name = name;
    this.logger = logger;
    this.config = {
      failureThreshold: 5,
      resetTimeout: 60000, // 1 minute
      monitoringPeriod: 10000, // 10 seconds
      halfOpenRequests: 3,
      timeout: 5000, // 5 seconds
      ...config,
    };
  }

  /**
   * Execute function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const correlationId = getCurrentCorrelationId();

    // Check if circuit is open
    if (this.state === CircuitState.OPEN) {
      if (Date.now() < (this.nextAttempt || 0)) {
        this.logger.warn(`Circuit breaker OPEN for ${this.name}`, {
          correlationId,
          nextAttempt: new Date(this.nextAttempt || 0).toISOString(),
        });
        throw new Error(`Circuit breaker is OPEN for ${this.name}`);
      }
      
      // Try half-open state
      this.state = CircuitState.HALF_OPEN;
      this.successCount = 0;
      this.logger.info(`Circuit breaker HALF-OPEN for ${this.name}`, { correlationId });
    }

    try {
      // Add timeout wrapper
      const result = await Promise.race([
        fn(),
        new Promise<T>((_, reject) => 
          setTimeout(() => reject(new Error('Circuit breaker timeout')), this.config.timeout),
        ),
      ]);

      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Handle successful execution
   */
  private onSuccess(): void {
    this.failureCount = 0;
    
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      
      if (this.successCount >= this.config.halfOpenRequests) {
        this.state = CircuitState.CLOSED;
        this.logger.info(`Circuit breaker CLOSED for ${this.name}`, {
          correlationId: getCurrentCorrelationId(),
        });
      }
    }
  }

  /**
   * Handle failed execution
   */
  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.config.failureThreshold) {
      this.state = CircuitState.OPEN;
      this.nextAttempt = Date.now() + this.config.resetTimeout;
      
      this.logger.error(`Circuit breaker OPEN for ${this.name}`, {
        correlationId: getCurrentCorrelationId(),
        failures: this.failureCount,
        resetIn: this.config.resetTimeout,
      });
    }
  }

  /**
   * Get circuit breaker status
   */
  getStatus(): { state: CircuitState; failures: number; nextAttempt?: Date } {
    return {
      state: this.state,
      failures: this.failureCount,
      nextAttempt: this.nextAttempt ? new Date(this.nextAttempt) : undefined,
    };
  }

  /**
   * Reset circuit breaker
   */
  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.nextAttempt = undefined;
    this.lastFailureTime = undefined;
  }
}

/**
 * Service Registry for managing external service endpoints
 */
class ServiceRegistry {
  private services: Map<string, ServiceEndpoint> = new Map();
  private httpClients: Map<string, AxiosInstance> = new Map();
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();
  private logger: LoggerService;

  constructor(logger: LoggerService) {
    this.logger = logger;
    this.initializeDefaultServices();
  }

  /**
   * Initialize default service endpoints
   */
  private initializeDefaultServices(): void {
    // Anthropic AI Service
    this.registerService({
      name: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      timeout: 30000,
      retries: 3,
      circuitBreaker: {
        failureThreshold: 3,
        resetTimeout: 120000, // 2 minutes
      },
    });

    // AWS Services
    this.registerService({
      name: 'aws-cognito',
      baseUrl: `https://cognito-idp.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com`,
      timeout: 10000,
      retries: 3,
    });

    // Internal microservices (if any)
    if (process.env.ANALYTICS_SERVICE_URL) {
      this.registerService({
        name: 'analytics',
        baseUrl: process.env.ANALYTICS_SERVICE_URL,
        healthCheck: '/health',
        timeout: 5000,
        retries: 2,
      });
    }
  }

  /**
   * Register a service endpoint
   */
  registerService(endpoint: ServiceEndpoint): void {
    this.services.set(endpoint.name, endpoint);
    
    // Create HTTP client for the service
    const client = axios.create({
      baseURL: endpoint.baseUrl,
      timeout: endpoint.timeout || 5000,
      headers: {
        'Content-Type': 'application/json',
        ...endpoint.headers,
      },
    });

    // Ensure client and interceptors exist (defensive programming for testing/edge cases)
    if (!client) {
      this.logger.error('Failed to create HTTP client for service', { 
        serviceName: endpoint.name, 
        baseUrl: endpoint.baseUrl, 
      });
      throw new Error('Failed to create HTTP client for service');
    }

    if (!client.interceptors) {
      // Fallback for testing environments or corrupted axios instances
      this.logger.warn(`HTTP client interceptors not available for service: ${endpoint.name}`);
      this.services.set(endpoint.name, {
        ...endpoint,
        client,
      });
      return;
    }

    // Add request interceptor for correlation headers
    client.interceptors.request.use((config) => {
      const correlationHeaders = CorrelationContextManager.getOutgoingHeaders();
      // Ensure headers exist
      config.headers = config.headers || {};
      // Add correlation headers
      for (const [key, value] of Object.entries(correlationHeaders)) {
        config.headers[key] = value;
      }
      return config;
    });

    // Add response interceptor for logging
    client.interceptors.response.use(
      (response) => {
        this.logger.debug(`Service call successful: ${endpoint.name}`, {
          correlationId: getCurrentCorrelationId(),
          status: response.status,
          url: response.config.url,
        });
        return response;
      },
      (error: AxiosError) => {
        this.logger.error(`Service call failed: ${endpoint.name}`, {
          correlationId: getCurrentCorrelationId(),
          status: error.response?.status,
          url: error.config?.url,
          message: error.message,
        });
        return Promise.reject(error);
      },
    );

    this.httpClients.set(endpoint.name, client);

    // Create circuit breaker if configured
    if (endpoint.circuitBreaker) {
      this.circuitBreakers.set(
        endpoint.name,
        new CircuitBreaker(endpoint.name, this.logger, endpoint.circuitBreaker),
      );
    }
  }

  /**
   * Get service client
   */
  getClient(serviceName: string): AxiosInstance | null {
    return this.httpClients.get(serviceName) || null;
  }

  /**
   * Call external service with circuit breaker protection
   */
  async callService<T = unknown>(
    serviceName: string,
    config: AxiosRequestConfig,
  ): Promise<T> {
    const client = this.getClient(serviceName);
    if (!client) {
      throw new Error(`Service ${serviceName} not registered`);
    }

    const circuitBreaker = this.circuitBreakers.get(serviceName);
    const endpoint = this.services.get(serviceName)!;

    // Execute with circuit breaker if configured
    if (circuitBreaker) {
      return await circuitBreaker.execute(async () => {
        const response = await this.executeWithRetry(client, config, endpoint.retries || 1);
        return response.data as T;
      });
    }

    // Execute without circuit breaker
    const response = await this.executeWithRetry(client, config, endpoint.retries || 1);
    return response.data as T;
  }

  /**
   * Execute request with retry logic
   */
  private async executeWithRetry(
    client: AxiosInstance,
    config: AxiosRequestConfig,
    maxRetries: number,
  ): Promise<import('axios').AxiosResponse<unknown>> {
    let lastError: Error | undefined;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await client.request(config);
        return response;
      } catch (error) {
        lastError = error as Error;
        
        // Don't retry on client errors (4xx)
        if ((error as AxiosError).response?.status && 
            (error as AxiosError).response!.status >= 400 && 
            (error as AxiosError).response!.status < 500) {
          throw error;
        }

        // Log retry attempt
        if (attempt < maxRetries) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          this.logger.warn(`Retrying service call (attempt ${attempt}/${maxRetries})`, {
            correlationId: getCurrentCorrelationId(),
            backoffMs,
          });
          
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      }
    }

    throw lastError;
  }

  /**
   * Get service health status
   */
  async checkHealth(serviceName: string): Promise<boolean> {
    const endpoint = this.services.get(serviceName);
    if (!endpoint || !endpoint.healthCheck) {
      return false;
    }

    try {
      const client = this.getClient(serviceName);
      if (!client) return false;

      const response = await client.get(endpoint.healthCheck, { timeout: 3000 });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  /**
   * Get all service statuses
   */
  getServiceStatuses(): Record<string, ServiceStatus> {
    const statuses: Record<string, ServiceStatus> = {};
    
    this.services.forEach((endpoint, name) => {
      const circuitBreaker = this.circuitBreakers.get(name);
      statuses[name] = {
        url: endpoint.baseUrl,
        circuitBreaker: circuitBreaker?.getStatus() || null,
      };
    });
    
    return statuses;
  }
}

/**
 * API Gateway Manager
 */
export class APIGatewayManager {
  private serviceRegistry: ServiceRegistry;
  private versions: Map<string, APIVersionConfig> = new Map();
  private requestTransformers: RequestTransformer[] = [];
  private responseTransformers: ResponseTransformer[] = [];

  /**
   * Constructor with explicit dependency injection (Pure DI - no singleton)
   * All dependencies are required and injected by bootstrap.ts
   */
  public constructor(
    private logger: LoggerService,
    private performanceMonitoring: PerformanceMonitoringService,
  ) {
    // Pure constructor injection - all dependencies provided by bootstrap.ts
    if (!logger || !performanceMonitoring) {
      throw new Error('APIGatewayManager: All dependencies must be provided');
    }
    this.serviceRegistry = new ServiceRegistry(this.logger);
    this.initializeVersions();
  }

  /**
   * Initialize the service with dependencies
   * Dependencies are already injected via constructor
   */
  public initialize(): void {
    // Dependencies are already injected via constructor
    // This method is kept for compatibility but no longer needed
  }

  /**
   * Initialize API versions
   */
  private initializeVersions(): void {
    // Current version
    this.versions.set('v1', {
      version: 'v1',
      deprecated: false,
    });

    // Future version placeholder
    this.versions.set('v2', {
      version: 'v2',
      deprecated: false,
      transformRequest: async (req) => {
        // V2 specific request transformations
        return req;
      },
      transformResponse: async (res, data) => {
        // V2 specific response transformations
        return data;
      },
    });
  }

  /**
   * Register service endpoint
   */
  public registerService(endpoint: ServiceEndpoint): void {
    this.serviceRegistry.registerService(endpoint);
  }

  /**
   * Call external service
   */
  public async callService<T>(serviceName: string, config: AxiosRequestConfig): Promise<T> {
    const correlationId = getCurrentCorrelationId();
    const startTime = Date.now();

    try {
      const result = await this.serviceRegistry.callService<T>(serviceName, config);
      
      // Record performance metrics
      this.performanceMonitoring.recordExternalAPIResponseTime(
        serviceName,
        config.url || '',
        Date.now() - startTime,
        200,
        correlationId,
      );

      return result;
    } catch (error) {
      // Record error metrics
      this.performanceMonitoring.recordExternalAPIResponseTime(
        serviceName,
        config.url || '',
        Date.now() - startTime,
        (error as AxiosError).response?.status || 0,
        correlationId,
      );

      throw error;
    }
  }

  /**
   * Add request transformer
   */
  public addRequestTransformer(transformer: RequestTransformer): void {
    this.requestTransformers.push(transformer);
  }

  /**
   * Add response transformer
   */
  public addResponseTransformer(transformer: ResponseTransformer): void {
    this.responseTransformers.push(transformer);
  }

  /**
   * Apply request transformations
   */
  private async applyRequestTransformations(req: Request): Promise<Request> {
    let transformedReq = req;
    
    for (const transformer of this.requestTransformers) {
      transformedReq = await transformer(transformedReq);
    }
    
    return transformedReq;
  }

  /**
   * Apply response transformations
   */
  private async applyResponseTransformations(res: Response, data: unknown): Promise<unknown> {
    let transformedData = data;
    
    for (const transformer of this.responseTransformers) {
      transformedData = await transformer(res, transformedData);
    }
    
    return transformedData;
  }

  /**
   * Get service registry
   */
  public getServiceRegistry(): ServiceRegistry {
    return this.serviceRegistry;
  }

  /**
   * Create API gateway middleware
   */
  public createMiddleware() {
    return async (req: Request, res: Response, next: NextFunction) => {
      const correlationId = getCurrentCorrelationId();
      
      try {
        // Apply request transformations
        req = await this.applyRequestTransformations(req);

        // Add API version headers
        const version = this.extractVersion(req);
        const versionConfig = this.versions.get(version);
        
        if (versionConfig) {
          res.set('X-API-Version', versionConfig.version);
          
          if (versionConfig.deprecated) {
            res.set('X-API-Deprecated', 'true');
            
            if (versionConfig.sunsetDate) {
              res.set('X-API-Sunset', versionConfig.sunsetDate.toISOString());
            }
          }
        }

        // Intercept response for transformations
        const originalJson = res.json.bind(res);
        const self = this;

        // Type-safe response interception with safety checks
        (res as Response & { json: (data: unknown) => Response }).json = function(data: unknown) {
          // SAFETY CHECK: If headers already sent, do not attempt to transform
          if (res.headersSent) {
            self.logger.warn('Response already sent, skipping transformation', {
              correlationId,
              path: req.path,
              method: req.method,
            });
            return res;
          }

          // Apply transformations synchronously to avoid race conditions
          try {
            // For simple cases, skip async transformation and call directly
            if (self.responseTransformers.length === 0) {
              return originalJson(data);
            }

            // Apply transformations and send response
            self.applyResponseTransformations(res, data)
              .then(transformedData => {
                // Double-check headers not sent by another middleware
                if (!res.headersSent) {
                  originalJson(transformedData);
                }
              })
              .catch(error => {
                self.logger.error('Response transformation failed', {
                  correlationId,
                  error: (error as Error).message,
                });
                // Only send fallback if headers not sent
                if (!res.headersSent) {
                  originalJson(data);
                }
              });
            
            // Return res for chaining (caller should not expect immediate send)
            return res;
          } catch (syncError) {
            self.logger.error('Sync response transformation error', {
              correlationId,
              error: (syncError as Error).message,
            });
            if (!res.headersSent) {
              return originalJson(data);
            }
            return res;
          }
        };

        next();
      } catch (error) {
        this.logger.error('API gateway middleware error', {
          correlationId,
          error: (error as Error).message,
        });
        next(error);
      }
    };
  }

  /**
   * Extract API version from request
   */
  private extractVersion(req: Request): string {
    // Check header first
    const headerVersion = req.get('X-API-Version');
    if (headerVersion) return headerVersion;

    // Extract from URL path
    const pathMatch = req.path.match(/\/api\/v(\d+)/);
    if (pathMatch) return `v${pathMatch[1]}`;

    // Default to v1
    return 'v1';
  }

  /**
   * Get gateway health status
   */
  public async getHealthStatus(): Promise<{
    status: string;
    services: Record<string, ServiceStatus>;
    versions: Array<{ version: string; deprecated?: boolean; sunsetDate?: Date }>;
    timestamp: string;
  }> {
    const services = this.serviceRegistry.getServiceStatuses();
    const versions = Array.from(this.versions.values()).map(v => ({
      version: v.version,
      deprecated: v.deprecated,
      sunsetDate: v.sunsetDate,
    }));

    return {
      status: 'healthy',
      services,
      versions,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Create API gateway middleware
 */
export function createAPIGatewayMiddleware(manager: APIGatewayManager): (req: Request, res: Response, next: NextFunction) => void {
  return manager.createMiddleware();
}

/**
 * Service proxy middleware for internal service calls
 */
export function createServiceProxyMiddleware(manager: APIGatewayManager, serviceName: string, pathRewrite?: (path: string) => string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const correlationId = getCurrentCorrelationId();
    
    try {
      const path = pathRewrite ? pathRewrite(req.path) : req.path;
      
      const response = await manager.callService(serviceName, {
        method: req.method as import('../../../core/controller.types').HttpMethod,
        url: path,
        params: req.query,
        data: req.body,
        headers: req.headers as Record<string, string>,
      });

      res.json(response);
    } catch (error) {
      const axiosError = error as AxiosError;
      
      if (axiosError.response) {
        res.status(axiosError.response.status).json(axiosError.response.data);
      } else {
        res.status(503).json({
          error: 'Service Unavailable',
          message: `Failed to reach ${serviceName}`,
          correlationId,
        });
      }
    }
  };
}

// Legacy exports removed - Use createAPIGatewayMiddleware and createServiceProxyMiddleware factory functions instead

export default APIGatewayManager;