/**
 * Server.ts - HTTP Server Management Module
 * 
 * This module manages the HTTP server lifecycle, including creation, startup,
 * WebSocket attachment, and graceful shutdown handling.
 * 
 * @module server
 * @see https://nodejs.org/api/http.html
 */

import { createServer, Server as HTTPServer } from 'http';
import { Application } from 'express';
import { SocketService } from './websocket/socket.service';
import { CacheService } from './services/cache.service';
import { SecurityLoggerService, SecurityEventType, SecurityEventSeverity } from './services/securityLogger.service';
import { LoggerService } from './services/logger.service';
import { Config } from './core/types';

/**
 * Server class - Manages HTTP server lifecycle
 * 
 * Responsibilities:
 * - HTTP server creation and management
 * - WebSocket service initialization
 * - Graceful shutdown handling
 * - Signal handlers for SIGTERM and SIGINT
 */
export class Server {
  private httpServer?: HTTPServer;
  private isShuttingDown: boolean = false;
  private config?: Config;
  private app?: Application;

  /**
   * Constructor with explicit dependency injection (Pure DI - no singleton)
   * All dependencies are required and injected by index.ts
   */
  public constructor(
    private logger: LoggerService,
    private securityLogger: SecurityLoggerService,
    private cacheService: CacheService,
  ) {
    if (!logger || !securityLogger || !cacheService) {
      throw new Error('Server: All dependencies (LoggerService, SecurityLoggerService, CacheService) must be provided');
    }
  }

  /**
   * Start the HTTP server with the configured Express app
   * 
   * @param app - Express application instance
   * @param config - Server configuration
   * @param socketService - WebSocket service instance
   * @returns Promise that resolves when server is started
   */
  public async start(
    app: Application, 
    config: Config,
    socketService: SocketService,
  ): Promise<void> {
    if (this.httpServer) {
      throw new Error('Server is already running');
    }

    this.app = app;
    this.config = config;
    this.httpServer = createServer(app);

    // Setup signal handlers for graceful shutdown
    this.setupSignalHandlers();

    // Setup unhandled rejection and exception handlers
    this.setupErrorHandlers();

    return new Promise((resolve, reject) => {
      // This is REQUIRED for:
      // - iOS Simulators running on a different machine (Mac → Linux backend)
      // - Physical mobile devices on the same WiFi network
      // - Docker containers accessing the host
      // Without this, the server may only bind to localhost (127.0.0.1) on some systems
      const HOST = '0.0.0.0';
      
      this.httpServer!.listen(config.port, HOST, async () => {
        this.logger.info('Server started successfully', {
          port: config.port,
          host: HOST,
          url: `http://localhost:${config.port}`,
          externalUrl: `http://<your-ip>:${config.port}`,
        });

        try {
          // Initialize WebSocket service with the HTTP server
          // (logging handled by SocketService.initialize)
          await socketService.initialize(this.httpServer!);

          // Log server configuration
          this.logServerConfiguration(config);

          try {
            // Use injected logger: this.logger
            this.logger.info('Server initialization complete');
          } catch {
            try {
              // Use injected logger: this.logger
              this.logger.info('Server initialization complete');
            } catch {
              console.log('\n Server initialization complete');
            }
          }
          resolve();
        } catch (error) {
          try {
            // Use injected logger: this.logger
            this.logger.error('Failed to initialize WebSocket service:', {
              error: error instanceof Error ? error.message : String(error),
            });
          } catch {
            try {
              // Use injected logger: this.logger
              this.logger.error('Failed to initialize WebSocket service', { error: error instanceof Error ? error.message : String(error) });
            } catch {
              console.error('Failed to initialize WebSocket service:', error);
            }
          }
          reject(error);
        }
      });

      this.httpServer!.on('error', (error: Error) => {
        try {
          // Use injected logger: this.logger
          this.logger.error('Server failed to start:', {
            error: error instanceof Error ? error.message : String(error),
          });
        } catch {
          try {
            // Use injected logger: this.logger
            this.logger.error('Server failed to start', { error: error.message });
          } catch {
            console.error('Server failed to start:', error);
          }
        }
        reject(error);
      });
    });
  }

  /**
   * Perform graceful shutdown
   */
  public async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      try {
        // Use injected logger: this.logger
        this.logger.info('Shutdown already in progress...');
      } catch {
        try {
          // Use injected logger: this.logger
          this.logger.warn('Shutdown already in progress');
        } catch {
          console.log('Shutdown already in progress...');
        }
      }
      return;
    }

    this.isShuttingDown = true;
    try {
      // Use injected logger: this.logger
      this.logger.info('Initiating graceful shutdown...');
    } catch {
      try {
        // Use injected logger: this.logger
        this.logger.info('Initiating graceful shutdown');
      } catch {
        console.log('Initiating graceful shutdown...');
      }
    }

    // Shutdown domain event system first to stop processing new events
    try {
      const { shutdownDomainSubscribers } = await import('./subscribers/domain.subscribers');
      await shutdownDomainSubscribers();
      try {
        // Use injected logger: this.logger
        this.logger.info('Domain event system shut down');
      } catch {
        try {
          // Use injected logger: this.logger
          this.logger.info('Domain event system shut down');
        } catch {
          console.log('Domain event system shut down');
        }
      }
    } catch (error) {
      try {
        // Use injected logger: this.logger
        this.logger.error('Error shutting down domain event system:', {
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        try {
          // Use injected logger: this.logger
          this.logger.error('Error shutting down domain event system', { error: error instanceof Error ? error.message : String(error) });
        } catch {
          console.error('Error shutting down domain event system:', error);
        }
      }
    }

    if (this.httpServer) {
      return new Promise((resolve) => {
        // Stop accepting new connections
        this.httpServer!.close(() => {
          try {
            // Use injected logger: this.logger
            this.logger.info('HTTP server closed');
          } catch {
            try {
              // Use injected logger: this.logger
              this.logger.info('HTTP server closed');
            } catch {
              console.log('HTTP server closed');
            }
          }
          resolve();
        });

        // Force shutdown after 30 seconds
        setTimeout(() => {
          try {
            // Use injected logger: this.logger
            this.logger.error('Could not close connections in time, forcefully shutting down');
          } catch {
            try {
              // Use injected logger: this.logger
              this.logger.error('Could not close connections in time, forcefully shutting down');
            } catch {
              console.error('Could not close connections in time, forcefully shutting down');
            }
          }
          resolve();
        }, 30000);
      });
    }
  }

  /**
   * Setup signal handlers for graceful shutdown
   */
  private setupSignalHandlers(): void {
    process.on('SIGTERM', async () => {
      try {
        // Use injected logger: this.logger
        this.logger.info('SIGTERM signal received: closing HTTP server');
      } catch {
        try {
          // Use injected logger: this.logger
          this.logger.info('SIGTERM signal received: closing HTTP server');
        } catch {
          console.log('SIGTERM signal received: closing HTTP server');
        }
      }
      await this.shutdown();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      try {
        // Use injected logger: this.logger
        this.logger.info('SIGINT signal received: closing HTTP server');
      } catch {
        try {
          // Use injected logger: this.logger
          this.logger.info('SIGINT signal received: closing HTTP server');
        } catch {
          console.log('SIGINT signal received: closing HTTP server');
        }
      }
      await this.shutdown();
      process.exit(0);
    });
  }

  /**
   * Setup handlers for unhandled rejections and exceptions
   */
  private setupErrorHandlers(): void {
    process.on('unhandledRejection', (reason, promise) => {
      try {
        // Use injected logger: this.logger
        this.logger.error('Unhandled Promise Rejection', {
          reason: reason instanceof Error ? reason.message : String(reason),
          stack: reason instanceof Error ? reason.stack : undefined,
        });
      } catch {
        try {
          // Use injected logger: this.logger
          this.logger.error('Unhandled Rejection detected', { promise: String(promise), reason: String(reason) });
        } catch {
          console.error('Unhandled Rejection at:', promise, 'reason:', reason);
        }
      }

      //  FIXED: Use config.nodeEnv instead of process.env.NODE_ENV
      // Don't exit in production - log and continue
      if (this.config && this.config.nodeEnv === 'production') {
        // Send alert to security logger service
        // Use injected securityLogger: this.securityLogger
        if (this.securityLogger) {
          this.securityLogger.logSecurityEvent(
            SecurityEventType.AUTHENTICATION_FAILURE, // Using closest available type
            SecurityEventSeverity.HIGH,
            'Unhandled Promise Rejection',
            {
              errorMessage: reason instanceof Error ? reason.message : String(reason),
            },
            undefined,
            {
              stack: reason instanceof Error ? reason.stack : undefined,
            },
          );
        }
      }
    });

    process.on('uncaughtException', (error) => {
      try {
        // Use injected logger: this.logger
        this.logger.error('Uncaught Exception:', {
          error: error.message,
          stack: error.stack,
        });
      } catch {
        try {
          // Use injected logger: this.logger
          this.logger.error('Uncaught Exception detected', { error: error.message, stack: error.stack });
        } catch {
          console.error('Uncaught Exception:', error);
        }
      }
      // Exit gracefully
      process.exit(1);
    });
  }

  /**
   * Log server configuration details
   *  FIXED: Uses config.nodeEnv instead of process.env.NODE_ENV
   */
  private logServerConfiguration(config: Config): void {
    // Security headers are configured via SecurityConfigService, not in AppConfig
    // This will always be an empty object for now
    const securityConfig: Record<string, unknown> = {};

    // Check cache service status
    if (this.cacheService.isReady()) {
      try {
        // Use injected logger: this.logger
        this.logger.info('Redis cache service connected');
      } catch {
        try {
          // Use injected logger: this.logger
          this.logger.info('Redis cache service connected');
        } catch {
          console.log(' Redis cache service connected');
        }
      }
    } else {
      try {
        // Use injected logger: this.logger
        this.logger.warn('Redis cache service not available - running without cache');
      } catch {
        try {
          // Use injected logger: this.logger
          this.logger.warn('Redis cache service not available - running without cache');
        } catch {
          console.log('  Redis cache service not available - running without cache');
        }
      }
    }

    // Log security configuration status
    try {
      // Use injected logger: this.logger
      this.logger.info('Security Configuration loaded');
    } catch {
      try {
        // Use injected logger: this.logger
        this.logger.info('Security Configuration loaded');
      } catch {
        console.log(' Security Configuration:');
      }
    }
    try {
      // Use injected logger: this.logger
      //  FIXED: Use config.nodeEnv instead of process.env.NODE_ENV
      this.logger.info('Security configuration details', {
        environment: config.nodeEnv,
        corsOrigins: config.cors?.allowedOrigins?.length ?? 0,
        rateLimitMax: config.rateLimit?.max ?? 100,
        rateLimitWindow: config.rateLimit?.windowMs ?? 900000,
        syncRateLimitMax: config.syncRateLimit?.max ?? 200,
        syncRateLimitWindow: config.syncRateLimit?.windowMs ?? 900000,
        securityHeaders: securityConfig.contentSecurityPolicy ? 'Enhanced' : 'Basic',
        cacheStrategy: this.cacheService.isReady() ? 'Redis' : 'Disabled',
      });
    } catch {
      try {
        // Use injected logger: this.logger
        //  FIXED: Use config.nodeEnv instead of process.env.NODE_ENV
        this.logger.info('Environment configuration', { environment: config.nodeEnv });
      } catch {
        console.log(`  - Environment: ${config.nodeEnv}`);
      }
      try {
        // Use injected logger: this.logger
        const originsCount = config.cors?.allowedOrigins?.length || 0;
        this.logger.info('CORS configuration', { originsCount });
      } catch {
        const originsCount = config.cors?.allowedOrigins?.length || 0;
        console.log(`  - CORS Origins: ${originsCount} configured`);
      }
      try {
        // Use injected logger: this.logger
        const max = config.rateLimit?.max || 100;
        const windowMs = config.rateLimit?.windowMs || 900000;
        const syncMax = config.syncRateLimit?.max || 200;
        const syncWindowMs = config.syncRateLimit?.windowMs || 900000;
        this.logger.info('Rate limiting configuration', { max, windowMs, syncMax, syncWindowMs });
      } catch {
        const max = config.rateLimit?.max || 100;
        const windowMs = config.rateLimit?.windowMs || 900000;
        const syncMax = config.syncRateLimit?.max || 200;
        const syncWindowMs = config.syncRateLimit?.windowMs || 900000;
        console.log(`  - Rate Limiting: ${max} requests per ${windowMs}ms (sync: ${syncMax} per ${syncWindowMs}ms)`);
      }
      try {
        // Use injected logger: this.logger
        this.logger.info('Security headers configuration', { type: securityConfig.contentSecurityPolicy ? 'Enhanced' : 'Basic' });
      } catch {
        console.log(`  - Security Headers: ${securityConfig.contentSecurityPolicy ? 'Enhanced' : 'Basic'}`);
      }
      try {
        // Use injected logger: this.logger
        this.logger.info('Cache strategy configuration', { strategy: this.cacheService.isReady() ? 'Redis' : 'Disabled' });
      } catch {
        console.log(`  - Cache Strategy: ${this.cacheService.isReady() ? 'Redis' : 'Disabled'}`);
      }
    }

    // Log application routes
    const routes = [
      '/api/v1/auth',
      '/api/v1/users',
      '/api/v1/consumptions',
      '/api/v1/products',
      '/api/v1/inventory',
      '/api/v1/analytics',
      '/api/v1/sessions',
      '/api/v1/sync',
      '/api/v1/journal',
      '/api/v1/purchases',
      '/api/v1/goals',
      '/api/v1/achievements',
      '/api/v1/ai',
      '/api/v1/ai/usage',
      '/api/v1/telemetry      - Device telemetry ingestion and queries',
      '/api/v1/websocket      - WebSocket management API',
      '/api/v1/security',
      '/api/v1/monitoring',
      '/api/v1/performance',
      '/api/v1/storage',
      '/api/v1/gateway',
      '/api-docs (Swagger UI)',
      '/health (Health Check)',
    ];
    
    // Log the routes
    try {
      // Use injected logger: this.logger
      this.logger.info('API Routes registered', { routeCount: routes.length });
    } catch {
      // Fallback only - structured logging handled above
    }
    
    try {
      // Use injected logger: this.logger
      this.logger.info('Available API endpoints', { routes });
    } catch {
      routes.forEach(route => console.log(`  - ${route}`)); // Fallback only
    }
  }

  /**
   * Get the HTTP server instance
   */
  public getHttpServer(): HTTPServer | undefined {
    return this.httpServer;
  }

  /**
   * Check if server is running
   */
  public isRunning(): boolean {
    return !!this.httpServer && !this.isShuttingDown;
  }
}
