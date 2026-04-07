/**
 * index.ts - Main Application Entry Point
 *
 *  MODERN DI PATTERN: Pure Orchestration Layer
 *
 * This file is the minimal entry point that:
 * 1. Calls bootstrap.initializeServices() (composition root)
 * 2. Orchestrates middleware setup and route registration
 * 3. Starts the server
 * 4. Sets up graceful shutdown handlers
 *
 * NO service instantiation happens here - all creation is delegated to bootstrap.ts
 *
 * @module index
 */

import { initializeServices } from './bootstrap';
import { createErrorHandler, notFoundHandler } from './api/v1/middleware/error.middleware';
import { Server } from './server';

/**
 * Main application initialization and startup
 *
 *  MODERN DI PATTERN: Orchestration Only
 * - NO logger creation (bootstrap.ts handles it)
 * - NO config loading (bootstrap.ts handles it)
 * - NO service instantiation (bootstrap.ts handles it)
 * - Just coordinate the startup sequence
 */
async function main() {
  try {
    // Step 1: Initialize ALL services (bootstrap.ts is the composition root)
    // This handles: OpenTelemetry, Logger, Config, and ALL services
    // eslint-disable-next-line no-console
    console.log('Initializing application services...'); //  OK: Before logger exists
    const services = await initializeServices();
    // eslint-disable-next-line no-console
    console.log(' All services initialized successfully'); //  OK: Fallback before switching to logger

    // From this point forward, use services.logger for all logging
    const { logger, app, config, socketService, middlewareFactory, routeRegistry } = services;

    // Step 2: Initialize middleware factory with config and services
    logger.info('Initializing middleware factory...');
    middlewareFactory.initialize(config, services);
    const middlewareStack = middlewareFactory.createMiddlewareStack();
    logger.info(' Middleware factory initialized');

    // Step 3: Setup Express middleware and documentation
    logger.info('Setting up Express middleware...');
    await app.setupMiddleware(middlewareStack);
    app.setupDocumentation();
    logger.info(' Express middleware configured');

    // Step 4: Register all routes (logging handled by RouteRegistry)
    await routeRegistry.registerAllRoutes(
      app.getExpressApp(),
      middlewareFactory,
      services,
    );
    logger.info(' API routes registered');

    // Step 5: Setup error handlers (must be after routes)
    logger.info('Setting up error handlers...');
    app.setupErrorHandlers(
      notFoundHandler,
      middlewareStack.errorLogging,
      createErrorHandler(logger),
    );
    logger.info(' Error handlers configured');

    // Step 6: Start the HTTP server
    logger.info('Starting HTTP server...');
    const server = new Server(
      logger,
      services.securityLoggerService,
      services.cacheService,
    );

    await server.start(
      app.getExpressApp(),
      config,
      socketService,
    );
    logger.info(' HTTP server started successfully');

    // Step 7: Start deferred background services (AFTER server is fully ready)
    // This prevents race conditions where events might be processed before consumers are ready
    logger.info('Starting deferred background services...');
    try {
      await services.outboxProcessorService.start();
      logger.info(' OutboxProcessor started (deferred until after server ready)');
    } catch (error) {
      logger.warn(' Failed to start OutboxProcessor', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Non-fatal - server can still operate without outbox processing
    }

    // Step 8: Setup graceful shutdown handlers
    const gracefulShutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully...`);
      try {
        await services.shutdown();
        logger.info(' Graceful shutdown completed');
        process.exit(0);
      } catch (error) {
        logger.error(' Error during graceful shutdown:', error);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  } catch (error) {
    // Critical startup error - console is acceptable here as logger may not exist
    console.error('=== CRITICAL APPLICATION INITIALIZATION ERROR ===');
    console.error('Error type:', error instanceof Error ? error.constructor.name : typeof error);
    console.error('Error message:', error instanceof Error ? error.message : String(error));
    console.error('Error stack:', error instanceof Error ? error.stack : 'No stack trace');
    console.error('================================================');

    process.exit(1);
  }
}

// Start the application
main().catch(error => {
  // Critical startup error - console is appropriate here as logger may not exist
  console.error('=== FATAL APPLICATION STARTUP ERROR ===');
  console.error('Fatal error during application startup:', error);
  console.error('=======================================');
  process.exit(1);
});