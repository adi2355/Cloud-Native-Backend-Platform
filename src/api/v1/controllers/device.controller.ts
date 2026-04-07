/**
 * Device Controller
 * Handles HTTP requests for device management
 */

import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../../types/authenticated-request.types';
import { getUserId, getRequestId, getUser, getRouteParam } from '../../../utils/auth-guards';
import { DeviceService, CreateDeviceSchema, UpdateDeviceSchema, DevicePairingSchema, DeviceCalibrationSchema } from '../../../services/device.service';
import { ApiResponse } from '../../../models';
import { LoggerService } from '../../../services/logger.service';
import { AppError } from '../../../utils/AppError';
import { getErrorMessage, getErrorStack } from '../../../utils/error-handler';

export class DeviceController {
  /**
   * Constructor with explicit dependency injection (Pure DI - no singleton)
   * All dependencies are required and injected by bootstrap.ts
   */
  public constructor(
    private deviceService: DeviceService,
    private logger: LoggerService,
  ) {
    // Pure constructor injection - all dependencies provided by bootstrap.ts
    if (!deviceService || !logger) {
      throw new Error('DeviceController: All dependencies (DeviceService, LoggerService) must be provided');
    }
  }

  /**
   * List all devices for authenticated user
   * GET /api/v1/devices
   */
  public async listDevices(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = getUserId(req);
      const correlationId = getRequestId(req);


      const page = parseInt(req.query.page as string) || 1;
      const pageSize = Math.min(parseInt(req.query.pageSize as string) || 20, 100);

      const result = await this.deviceService.getUserDevices(userId, page, pageSize, correlationId);

      res.json({
        success: true,
        data: result,
        metadata: {
          timestamp: new Date().toISOString(),
        },
      } as ApiResponse);
    } catch (error) {
      this.logger.error('Failed to list devices', {
        context: 'DeviceController',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  /**
   * Create a new device
   * POST /api/v1/devices
   */
  public async createDevice(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = getUserId(req);
      const correlationId = getRequestId(req);


      // Validate request body
      const validationResult = CreateDeviceSchema.safeParse(req.body);

      if (!validationResult.success) {
        throw AppError.validation('Invalid request data', validationResult.error.errors);
      }

      const device = await this.deviceService.createDevice(userId, validationResult.data, correlationId);

      res.status(201).json({
        success: true,
        data: device,
        message: 'Device created successfully',
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: correlationId,
        },
      } as ApiResponse);
    } catch (error) {
      this.logger.error('Failed to create device', {
        context: 'DeviceController',
        userId: getUserId(req),
        body: req.body,
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  /**
   * Get device by ID
   * GET /api/v1/devices/{id}
   */
  public async getDevice(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = getUserId(req);
      const deviceId = getRouteParam(req, 'id');
      const correlationId = getRequestId(req);


      const device = await this.deviceService.getDevice(deviceId, userId, correlationId);

      res.json({
        success: true,
        data: device,
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: correlationId,
        },
      } as ApiResponse);
    } catch (error) {
      this.logger.error('Failed to get device', {
        context: 'DeviceController',
        deviceId: getRouteParam(req, 'id'),
        userId: getUserId(req),
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  /**
   * Update device
   * PUT /api/v1/devices/{id}
   */
  public async updateDevice(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = getUserId(req);
      const deviceId = getRouteParam(req, 'id');
      const correlationId = getRequestId(req);


      // Validate request body
      const validationResult = UpdateDeviceSchema.safeParse(req.body);

      if (!validationResult.success) {
        throw AppError.validation('Invalid request data', validationResult.error.errors);
      }

      const device = await this.deviceService.updateDevice(deviceId, userId, validationResult.data, correlationId);

      res.json({
        success: true,
        data: device,
        message: 'Device updated successfully',
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: correlationId,
        },
      } as ApiResponse);
    } catch (error) {
      this.logger.error('Failed to update device', {
        context: 'DeviceController',
        deviceId: getRouteParam(req, 'id'),
        userId: getUserId(req),
        body: req.body,
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  /**
   * Delete device
   * DELETE /api/v1/devices/{id}
   */
  public async deleteDevice(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = getUserId(req);
      const deviceId = getRouteParam(req, 'id');
      const correlationId = getRequestId(req);


      await this.deviceService.deleteDevice(deviceId, userId, correlationId);

      res.json({
        success: true,
        message: 'Device deleted successfully',
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: correlationId,
        },
      } as ApiResponse);
    } catch (error) {
      this.logger.error('Failed to delete device', {
        context: 'DeviceController',
        deviceId: getRouteParam(req, 'id'),
        userId: getUserId(req),
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  /**
   * Pair device with user account
   * POST /api/v1/devices/{id}/pair
   */
  public async pairDevice(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = getUserId(req);
      const deviceId = getRouteParam(req, 'id');
      const correlationId = getRequestId(req);


      // Validate request body
      const validationResult = DevicePairingSchema.safeParse(req.body);

      if (!validationResult.success) {
        throw AppError.validation('Invalid pairing data', validationResult.error.errors);
      }

      const device = await this.deviceService.pairDevice(deviceId, userId, validationResult.data, correlationId);

      res.json({
        success: true,
        data: device,
        message: 'Device paired successfully',
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: correlationId,
        },
      } as ApiResponse);
    } catch (error) {
      this.logger.error('Failed to pair device', {
        context: 'DeviceController',
        deviceId: getRouteParam(req, 'id'),
        userId: getUserId(req),
        body: req.body,
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  /**
   * Unpair device from user account
   * POST /api/v1/devices/{id}/unpair
   */
  public async unpairDevice(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = getUserId(req);
      const deviceId = getRouteParam(req, 'id');
      const correlationId = getRequestId(req);


      const device = await this.deviceService.unpairDevice(deviceId, userId, correlationId);

      res.json({
        success: true,
        data: device,
        message: 'Device unpaired successfully',
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: correlationId,
        },
      } as ApiResponse);
    } catch (error) {
      this.logger.error('Failed to unpair device', {
        context: 'DeviceController',
        deviceId: getRouteParam(req, 'id'),
        userId: getUserId(req),
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  /**
   * Get device telemetry data
   * GET /api/v1/devices/{id}/telemetry
   */
  public async getDeviceTelemetry(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = getUserId(req);
      const deviceId = getRouteParam(req, 'id');
      const correlationId = getRequestId(req);


      const startTime = req.query.startTime ? new Date(req.query.startTime as string) : undefined;
      const endTime = req.query.endTime ? new Date(req.query.endTime as string) : undefined;

      // Validate date parameters
      if (startTime && isNaN(startTime.getTime())) {
        throw AppError.validation('Invalid startTime format');
      }

      if (endTime && isNaN(endTime.getTime())) {
        throw AppError.validation('Invalid endTime format');
      }

      const telemetryData = await this.deviceService.getDeviceTelemetry(
        deviceId,
        userId,
        startTime,
        endTime,
        correlationId,
      );

      res.json({
        success: true,
        data: {
          deviceId,
          telemetry: telemetryData,
          period: {
            startTime: startTime?.toISOString() || 'last 24 hours',
            endTime: endTime?.toISOString() || 'now',
          },
          count: telemetryData.length,
        },
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: correlationId,
        },
      } as ApiResponse);
    } catch (error) {
      this.logger.error('Failed to get device telemetry', {
        context: 'DeviceController',
        deviceId: getRouteParam(req, 'id'),
        userId: getUserId(req),
        startTime: req.query.startTime,
        endTime: req.query.endTime,
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  /**
   * Calibrate device
   * POST /api/v1/devices/{id}/calibrate
   */
  public async calibrateDevice(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = getUserId(req);
      const deviceId = getRouteParam(req, 'id');
      const correlationId = getRequestId(req);


      // Validate request body
      const validationResult = DeviceCalibrationSchema.safeParse(req.body);

      if (!validationResult.success) {
        throw AppError.validation('Invalid calibration data', validationResult.error.errors);
      }

      const device = await this.deviceService.calibrateDevice(deviceId, userId, validationResult.data, correlationId);

      res.json({
        success: true,
        data: {
          device,
          calibration: (device.calibrationData as Record<string, unknown> | null)?.lastCalibration,
        },
        message: 'Device calibrated successfully',
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: correlationId,
        },
      } as ApiResponse);
    } catch (error) {
      this.logger.error('Failed to calibrate device', {
        context: 'DeviceController',
        deviceId: getRouteParam(req, 'id'),
        userId: getUserId(req),
        body: req.body,
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  /**
   * Get device health status
   * GET /api/v1/devices/{id}/health
   */
  public async getDeviceHealth(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = getUserId(req);
      const deviceId = getRouteParam(req, 'id');
      const correlationId = getRequestId(req);


      const health = await this.deviceService.getDeviceHealth(deviceId, userId, correlationId);

      res.json({
        success: true,
        data: health,
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: correlationId,
        },
      } as ApiResponse);
    } catch (error) {
      this.logger.error('Failed to get device health', {
        context: 'DeviceController',
        deviceId: getRouteParam(req, 'id'),
        userId: getUserId(req),
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }
}
