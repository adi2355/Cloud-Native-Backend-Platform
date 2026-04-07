/**
 * Worker Entry Point for BullMQ Background Job Processing
 *
 *  MODERN DI PATTERN: Pure Orchestration for Worker Process
 *
 * This is a dedicated entry point for Render Background Worker service.
 * It delegates ALL initialization to bootstrap.ts (composition root).
 *
 * Architecture:
 * - Web Service (mode='web'): Creates queues, adds jobs (producer only, enableWorkers=false)
 * - Worker Service (mode='worker'): Processes jobs from queues (consumer only, enableWorkers=true)
 *
 * Key Changes (DI Compliance):
 * - bootstrap.ts handles: OpenTelemetry, Logger, Config, ALL services
 * - No logger creation here (bootstrap.ts creates it)
 * - No config loading here (bootstrap.ts handles it)
 * - No service instantiation here (bootstrap.ts handles it)
 * - Just call initializeServices() with worker mode options
 *
 * Environment Requirements:
 * - WORKER_MODE=true (critical for enabling workers)
 * - REDIS_URL (connection to Render Key Value/Redis)
 * - DATABASE_URL (PostgreSQL connection)
 *
 * @see https://render.com/docs/background-workers
 * @see https://docs.bullmq.io/guide/workers
 * @see bootstrap.ts for initialization logic
 */

import * as dotenv from 'dotenv';
import { initializeServices, InitializedServices } from './bootstrap';

// Load environment variables
dotenv.config();

//  ACCEPTABLE EARLY PROCESS.ENV: Before bootstrap.ts runs
// Ensure WORKER_MODE is set
if (process.env.WORKER_MODE !== 'true') {
  console.error(' FATAL: WORKER_MODE must be set to "true" for worker processes');
  console.error('   This entry point is for Background Worker services only.');
  console.error('   For web services, use the main index.ts entry point.');
  process.exit(1);
}

/**
 * Start the background worker using bootstrap.ts for proper DI
 *
 *  MODERN DI PATTERN: Orchestration Only
 * - NO logger creation (bootstrap.ts handles it)
 * - NO config loading (bootstrap.ts handles it)
 * - NO service instantiation (bootstrap.ts handles it)
 */
async function startWorker() {
  console.log(' Starting BullMQ Background Worker...');
  console.log(`WORKER_MODE: ${process.env.WORKER_MODE}`);

  let services: InitializedServices | undefined;

  try {
    // Step 1: Initialize ALL services via bootstrap.ts (WORKER MODE)
    // This handles: OpenTelemetry, Logger, Config, and ALL services
    console.log('\n=== Initializing Worker Services ===');
    services = await initializeServices({
      mode: 'worker',        // Use worker-specific initialization
      enableWorkers: true,   // Enable job workers for processing
    });
    console.log(' All worker services initialized successfully');

    // From this point forward, use services.logger for all logging
    const { logger } = services;

    // Step 2: Verify critical worker services
    logger.info('Verifying critical worker services...');

    if (!services.jobManagerService) {
      throw new Error('JobManagerService not initialized - critical for worker');
    }
    if (!services.jobProcessor) {
      throw new Error('JobProcessor not initialized - critical for worker');
    }
    if (!services.databaseService) {
      throw new Error('DatabaseService not initialized - critical for worker');
    }
    if (!services.cacheService || !services.cacheService.isReady()) {
      throw new Error('CacheService not ready - Redis connection required for BullMQ');
    }

    logger.info(' All critical worker services verified');
    logger.info(' Background Worker is now processing jobs from Redis queues');

    // Graceful shutdown handling
    const shutdown = async (signal: string) => {
      logger?.info(` Received ${signal}, shutting down worker gracefully...`);

      try {
        if (services) {
          // Use the bootstrap shutdown function (handles reverse dependency order)
          await services.shutdown();
          logger?.info(' Worker shut down successfully via bootstrap');
        }

        process.exit(0);
      } catch (error: unknown) {
        logger?.error(' Error during worker shutdown', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        process.exit(1);
      }
    };

    // Register shutdown handlers
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    logger.info(' Background Worker is running - press Ctrl+C to stop');

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    const errorName = error instanceof Error ? error.name : 'Unknown';

    // Safely extract error code with type narrowing
    const isNodeError = (err: unknown): err is NodeJS.ErrnoException => {
      return error instanceof Error && 'code' in error;
    };
    const errorCode = isNodeError(error) ? error.code : undefined;

    console.error(' WORKER STARTUP FAILED - DETAILED ERROR:');
    console.error('Error Name:', errorName);
    console.error('Error Message:', errorMessage);
    console.error('Error Code:', errorCode);
    console.error('Error Stack:', errorStack);
    console.error('Environment:', {
      NODE_ENV: process.env.NODE_ENV,
      WORKER_MODE: process.env.WORKER_MODE,
      HAS_DATABASE_URL: !!process.env.DATABASE_URL,
      HAS_REDIS_URL: !!process.env.REDIS_URL,
    });

    // Cleanup on failure
    try {
      if (services) {
        await services.shutdown();
      }
    } catch (cleanupError: unknown) {
      console.error('Error during cleanup:', cleanupError);
    }

    process.exit(1);
  }
}

// Handle uncaught errors
process.on('unhandledRejection', (reason, promise) => {
  console.error(' Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

process.on('uncaughtException', (error: Error) => {
  console.error(' Uncaught Exception:', error);
  process.exit(1);
});

// Start the worker
startWorker().catch((error: unknown) => {
  console.error(' Fatal error starting worker:', error);
  process.exit(1);
});
