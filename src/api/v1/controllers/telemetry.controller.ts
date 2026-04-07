/**
 * Device Telemetry Controller
 * Handles HTTP requests for device telemetry data management
 * 
 * Production-ready controller following AppPlatform patterns with:
 * - Comprehensive error handling
 * - Input validation
 * - Proper authentication
 * - Structured logging
 */

import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../../types/authenticated-request.types';
import { getUserId, getCorrelationId, getRouteParam } from '../../../utils/auth-guards';
import { DeviceTelemetryService } from '../../../services/deviceTelemetry.service';
import { LoggerService } from '../../../services/logger.service';
import { SocketService } from '../../../websocket/socket.service';
import { AppError, ErrorCodes } from '../../../utils/AppError';
import { getErrorMessage, getErrorStack } from '../../../utils/error-handler';
import { z } from 'zod';

// Validation schemas
const TelemetryIngestionSchema = z.object({
  deviceId: z.string().min(1).max(128),
  timestamp: z.string().datetime().optional(),
  metrics: z.record(z.number()),
  metadata: z.record(z.unknown()).optional(),
  firmwareVersion: z.string().optional(),
  batteryLevel: z.number().min(0).max(100).optional(),
});

const TelemetryQuerySchema = z.object({
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  limit: z.coerce.number().min(1).max(1000).default(100),
  nextToken: z.string().optional(),
});

const AggregationQuerySchema = z.object({
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  interval: z.enum(['minute', 'hour', 'day', 'week']).default('hour'),
  metrics: z.array(z.string()).optional(),
});

class TelemetryController {
  private initialized: boolean = false;

  /**
   * Constructor with explicit dependency injection (Pure DI - no singleton)
   * All dependencies are required and injected by bootstrap.ts
   */
  public constructor(
    private telemetryService: DeviceTelemetryService,
    private socketService: SocketService,
    private logger: LoggerService,
  ) {
    // Pure constructor injection - all dependencies provided by bootstrap.ts
    if (!telemetryService || !socketService || !logger) {
      throw new Error('TelemetryController: All dependencies (DeviceTelemetryService, SocketService, LoggerService) must be provided');
    }
    this.initialized = true; // Mark as initialized since dependencies are provided
  }



  /**
   * Ingest device telemetry data
   * POST /api/v1/telemetry
   */
  public async ingestTelemetry(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const correlationId = getCorrelationId(req);
      

      // Validate input
      const validationResult = TelemetryIngestionSchema.safeParse(req.body);
      if (!validationResult.success) {
        throw AppError.validation('Invalid telemetry data', validationResult.error.errors);
      }

      const telemetryData = validationResult.data;

      this.logger.info('Ingesting device telemetry', {
        context: 'TelemetryController',
        userId,
        deviceId: telemetryData.deviceId,
        correlationId,
      });

      // Record telemetry
      await this.telemetryService.recordDeviceTelemetry(
        userId,
        {
          deviceId: telemetryData.deviceId,
          timestamp: new Date(telemetryData.timestamp || Date.now()).getTime(),
          metrics: telemetryData.metrics,
        },
        correlationId,
      );

      // Emit real-time update via WebSocket
      this.socketService.emitToUser(userId, 'telemetry:update', {
        deviceId: telemetryData.deviceId,
        timestamp: telemetryData.timestamp || new Date().toISOString(),
        metrics: telemetryData.metrics,
      });

      res.status(201).json({
        success: true,
        data: telemetryData,
        metadata: {
          timestamp: new Date().toISOString(),
          correlationId,
        },
      });
    } catch (error) {
      this.logger.error('Failed to ingest telemetry', {
        context: 'TelemetryController',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  /**
   * Get telemetry data for a specific device
   * GET /api/v1/telemetry/device/:deviceId
   */
  public async getDeviceTelemetry(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const deviceId = getRouteParam(req, 'deviceId');
      const correlationId = getCorrelationId(req);
      

      if (!deviceId) {
        throw AppError.validation('Device ID is required');
      }

      // Validate query parameters
      const validationResult = TelemetryQuerySchema.safeParse(req.query);
      if (!validationResult.success) {
        throw AppError.validation('Invalid query parameters', validationResult.error.errors);
      }

      const queryParams = validationResult.data;

      this.logger.info('Fetching device telemetry', {
        context: 'TelemetryController',
        userId,
        deviceId,
        queryParams,
        correlationId,
      });

      // Get telemetry data
      const telemetryData = await this.telemetryService.getDeviceTelemetry(
        deviceId,
        userId,
        queryParams.startTime ? new Date(queryParams.startTime) : new Date(Date.now() - 86400000),
        queryParams.endTime ? new Date(queryParams.endTime) : new Date(),
        correlationId,
      );

      res.json({
        success: true,
        data: telemetryData,
        metadata: {
          timestamp: new Date().toISOString(),
          correlationId,
          count: Array.isArray(telemetryData) ? telemetryData.length : 0,
        },
      });
    } catch (error) {
      this.logger.error('Failed to get device telemetry', {
        context: 'TelemetryController',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  /**
   * Get device health status
   * GET /api/v1/telemetry/device/:deviceId/health
   */
  public async getDeviceHealth(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const deviceId = getRouteParam(req, 'deviceId');
      const correlationId = getCorrelationId(req);
      

      if (!deviceId) {
        throw AppError.validation('Device ID is required');
      }

      this.logger.info('Fetching device health', {
        context: 'TelemetryController',
        userId,
        deviceId,
        correlationId,
      });

      // Get device health
      const healthStatus = await this.telemetryService.getDeviceHealth(userId, deviceId);

      res.json({
        success: true,
        data: healthStatus,
        metadata: {
          timestamp: new Date().toISOString(),
          correlationId,
        },
      });
    } catch (error) {
      this.logger.error('Failed to get device health', {
        context: 'TelemetryController',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  /**
   * Get aggregated telemetry metrics
   * GET /api/v1/telemetry/device/:deviceId/aggregate
   */
  public async getAggregatedMetrics(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const deviceId = getRouteParam(req, 'deviceId');
      const correlationId = getCorrelationId(req);
      

      if (!deviceId) {
        throw AppError.validation('Device ID is required');
      }

      // Validate query parameters
      const validationResult = AggregationQuerySchema.safeParse(req.query);
      if (!validationResult.success) {
        throw AppError.validation('Invalid aggregation parameters', validationResult.error.errors);
      }

      const queryParams = validationResult.data;

      this.logger.info('Fetching aggregated metrics', {
        context: 'TelemetryController',
        userId,
        deviceId,
        queryParams,
        correlationId,
      });

      // Get aggregated metrics
      const aggregation = await this.telemetryService.getAggregatedTelemetry(
        deviceId,
        userId,
        new Date(queryParams.startTime),
        new Date(queryParams.endTime),
        correlationId,
      );

      res.json({
        success: true,
        data: aggregation,
        metadata: {
          timestamp: new Date().toISOString(),
          correlationId,
          interval: queryParams.interval,
        },
      });
    } catch (error) {
      this.logger.error('Failed to get aggregated metrics', {
        context: 'TelemetryController',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  /**
   * Batch ingest telemetry data
   * POST /api/v1/telemetry/batch
   */
  public async batchIngestTelemetry(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getUserId(req);
      const correlationId = getCorrelationId(req);
      

      // Validate batch data
      const BatchSchema = z.array(TelemetryIngestionSchema).min(1).max(100);
      const validationResult = BatchSchema.safeParse(req.body);
      if (!validationResult.success) {
        throw AppError.validation('Invalid batch telemetry data', validationResult.error.errors);
      }

      const telemetryBatch = validationResult.data;

      this.logger.info('Batch ingesting telemetry', {
        context: 'TelemetryController',
        userId,
        batchSize: telemetryBatch.length,
        correlationId,
      });

      // Process batch
      const results = await this.telemetryService.batchWriteTelemetry(
        telemetryBatch.map(item => ({
          timestamp: new Date(item.timestamp || Date.now()),
          userId,
          deviceId: item.deviceId,
          metrics: item.metrics,
        })),
      );

      // Emit real-time updates for successful records
      if (results.success) {
        this.socketService.emitToUser(userId, 'telemetry:batch-update', {
          count: telemetryBatch.length,
          devices: [...new Set(telemetryBatch.map(item => item.deviceId))],
        });
      }

      res.status(201).json({
        success: true,
        data: {
          successful: results.success ? telemetryBatch.length : 0,
          failed: results.errors ? results.errors.length : 0,
          results: results.errors || [],
        },
        metadata: {
          timestamp: new Date().toISOString(),
          correlationId,
        },
      });
    } catch (error) {
      this.logger.error('Failed to batch ingest telemetry', {
        context: 'TelemetryController',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }
}

// Export the class for dependency injection in bootstrap.ts
export { TelemetryController };
