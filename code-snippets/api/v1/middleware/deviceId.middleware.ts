/**
 * Device ID Middleware
 *
 * Extracts device ID from X-Device-ID request header and attaches it to the request object.
 * Enables device-specific operations like distributed sync locks and device tracking.
 *
 * Architecture:
 * - Frontend: DeviceIdManager generates stable UUID → BackendAPIClient adds X-Device-ID header
 * - Backend: This middleware extracts header → Sets req.deviceId
 * - Controllers: Use getDeviceId(req) helper to access validated device ID
 *
 * Security Considerations:
 * - Device ID is NOT an authentication mechanism (requires separate JWT)
 * - Used for tracking and sync operations, not authorization
 * - Validates UUID format to prevent injection attacks
 *
 * Related:
 * - Frontend: DeviceIdManager (packages/app/src/utils/DeviceIdManager.ts)
 * - Frontend: BackendAPIClient (packages/app/src/services/api/BackendAPIClient.ts)
 * - Utils: getDeviceId() (src/utils/auth-guards.ts)
 */

import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest, OptionalAuthRequest } from '../../../types/authenticated-request.types';
import { LoggerService } from '../../../services/logger.service';
import { AppError, ErrorCodes } from '../../../utils/AppError';

/**
 * Device ID extraction modes
 */
export enum DeviceIdMode {
  /**
   * OPTIONAL: Extract deviceId if present, but don't fail if missing
   * Used for: Non-sync endpoints where deviceId provides additional context
   */
  OPTIONAL = 'optional',

  /**
   * REQUIRED: Fail with 400 if deviceId header is missing or invalid
   * Used for: Sync endpoints that rely on deviceId for distributed locks
   */
  REQUIRED = 'required',
}

/**
 * Factory function to create deviceId extraction middleware with dependency injection
 *
 * @param logger LoggerService instance for structured logging
 * @param mode Extraction mode (OPTIONAL or REQUIRED)
 * @returns Express middleware function
 */
export function createDeviceIdMiddleware(
  logger: LoggerService,
  mode: DeviceIdMode = DeviceIdMode.OPTIONAL,
  options: { useAppError?: boolean } = {},
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      // Extract X-Device-ID header (case-insensitive)
      const deviceIdHeader = req.get('X-Device-ID') || req.get('x-device-id');

      // If no header provided
      if (!deviceIdHeader) {
        if (mode === DeviceIdMode.REQUIRED) {
          logger.warn('Device ID required but not provided', {
            context: 'DeviceIdMiddleware',
            endpoint: req.path,
            method: req.method,
            mode,
          });

          if (options.useAppError) {
            return next(new AppError(
              400,
              ErrorCodes.VALIDATION_ERROR,
              'Device ID is required for this operation',
              true,
              { code: 'DEVICE_ID_REQUIRED' },
            ));
          }

          res.status(400).json({
            success: false,
            error: {
              message: 'Device ID is required for this operation',
              code: 'DEVICE_ID_REQUIRED',
              userMessage: 'Device identification is required for sync operations. Please ensure your app is up to date.',
            },
          });
          return;
        }

        // OPTIONAL mode: Continue without deviceId
        const typedReq = req as AuthenticatedRequest | OptionalAuthRequest;
        typedReq.deviceId = undefined;
        next();
        return;
      }

      // Validate UUID format (basic check to prevent injection)
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(deviceIdHeader)) {
        logger.warn('Invalid device ID format provided', {
          context: 'DeviceIdMiddleware',
          endpoint: req.path,
          method: req.method,
          invalidDeviceId: `${deviceIdHeader.substring(0, 8)}...`,
          mode,
        });

        if (options.useAppError) {
          return next(new AppError(
            400,
            ErrorCodes.VALIDATION_ERROR,
            'Invalid device ID format',
            true,
            { code: 'INVALID_DEVICE_ID' },
          ));
        }

        res.status(400).json({
          success: false,
          error: {
            message: 'Invalid device ID format',
            code: 'INVALID_DEVICE_ID',
            userMessage: 'Device ID must be a valid UUID. Please update your app or contact support.',
          },
        });
        return;
      }

      // Attach validated deviceId to request
      const typedReq = req as AuthenticatedRequest | OptionalAuthRequest;
      typedReq.deviceId = deviceIdHeader;

      logger.debug('Device ID extracted successfully', {
        context: 'DeviceIdMiddleware',
        deviceId: `${deviceIdHeader.substring(0, 8)}...`,
        endpoint: req.path,
        method: req.method,
        mode,
      });

      next();
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));

      logger.error('Device ID middleware error', {
        context: 'DeviceIdMiddleware',
        error: err.message,
        stack: err.stack,
        endpoint: req.path,
        method: req.method,
      });

      // For errors, treat as OPTIONAL mode (continue without deviceId)
      const typedReq = req as AuthenticatedRequest | OptionalAuthRequest;
      typedReq.deviceId = undefined;
      next();
    }
  };
}

/**
 * Convenience middleware for optional device ID extraction
 * (Default mode - most common use case)
 */
export function deviceIdMiddleware(logger: LoggerService, options?: { useAppError?: boolean }) {
  return createDeviceIdMiddleware(logger, DeviceIdMode.OPTIONAL, options);
}

/**
 * Convenience middleware for required device ID extraction
 * (Use for sync endpoints only)
 */
export function requireDeviceId(logger: LoggerService, options?: { useAppError?: boolean }) {
  return createDeviceIdMiddleware(logger, DeviceIdMode.REQUIRED, options);
}
