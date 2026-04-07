/**
 * Device Routes
 * Defines API endpoints for device management
 * 
 * @swagger
 * tags:
 *   name: Devices
 *   description: Device management and telemetry endpoints
 */

import { Router, RequestHandler } from 'express';
import { DeviceController } from '../controllers/device.controller';
import type { MiddlewareFactory } from '../../../core/middleware-factory';
import type { InitializedServices } from '../../../bootstrap';
import { ControllerRegistry } from '../../../core/controller-registry';

// Route services interface
export interface RouteServices {
  middlewareFactory: MiddlewareFactory;
  controllerRegistry: ControllerRegistry;
  services: InitializedServices;
}

const router = Router();

// Service injection support
let routeServices: RouteServices | null = null;

/**
 * Initialize route services and register routes
 */
export function initializeRouteServices(services: RouteServices): void {
  routeServices = services;
  
  // Register all routes after services are initialized
  registerDeviceRoutes();
}

/**
 * Get DeviceController from ControllerRegistry with dependency injection
 */
const getDeviceController = (): DeviceController => {
  if (!routeServices) {
    throw new Error('Route services not initialized. Call initializeRouteServices() first.');
  }
  return routeServices.controllerRegistry.getController<DeviceController>('device');
};

/**
 * Get rate limiter from MiddlewareFactory
 */
const getRateLimiter = (type: 'strict' | 'standard' | 'ai' | 'auth' = 'standard') => {
  if (!routeServices) {
    throw new Error('Route services not initialized');
  }
  return routeServices.middlewareFactory.getRateLimiter(type);
};

/**
 * Get cache middleware from MiddlewareFactory
 */
const getCacheMiddleware = (invalidationKeys?: string[]) => {
  if (!routeServices) {
    throw new Error('Route services not initialized');
  }
  return routeServices.middlewareFactory.createCachingMiddleware(invalidationKeys);
};

/**
 * Register all device routes after services are initialized
 */
function registerDeviceRoutes() {
  // Clear any existing routes first
  router.stack.length = 0;

  // Apply middleware stack to all routes - handled by RouteRegistry via MiddlewareFactory

  /**
   * @swagger
   * /api/v1/devices:
 *   get:
 *     summary: List all devices for authenticated user
 *     tags: [Devices]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: pageSize
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Items per page
 *     responses:
 *       200:
 *         description: List of devices retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     devices:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Device'
 *                     total:
 *                       type: integer
 *                     page:
 *                       type: integer
 *                     pageSize:
 *                       type: integer
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/',
  getRateLimiter('standard'),
  ...getCacheMiddleware(['devices', 'user-devices']),
  getDeviceController().listDevices.bind(getDeviceController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/devices:
 *   post:
 *     summary: Register a new device
 *     tags: [Devices]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - type
 *             properties:
 *               name:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 100
 *                 description: Device display name
 *               type:
 *                 type: string
 *                 enum: [bluetooth_sensor, temperature_sensor, humidity_sensor, scale, sensor, other]
 *                 description: Type of device
 *               brand:
 *                 type: string
 *                 maxLength: 50
 *                 description: Device brand/manufacturer
 *               model:
 *                 type: string
 *                 maxLength: 50
 *                 description: Device model
 *               serialNumber:
 *                 type: string
 *                 maxLength: 100
 *                 description: Device serial number
 *               macAddress:
 *                 type: string
 *                 pattern: '^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$'
 *                 description: Device MAC address
 *               bluetoothId:
 *                 type: string
 *                 description: Bluetooth identifier
 *               firmwareVersion:
 *                 type: string
 *                 maxLength: 20
 *                 description: Current firmware version
 *               specifications:
 *                 type: object
 *                 description: Device specifications and capabilities
 *               notes:
 *                 type: string
 *                 maxLength: 500
 *                 description: Additional notes about the device
 *     responses:
 *       201:
 *         description: Device registered successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Device'
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid input data
 *       409:
 *         description: Device already exists (duplicate MAC/serial)
 */
router.post(
  '/',
  getRateLimiter('strict'),
  getDeviceController().createDevice.bind(getDeviceController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/devices/{id}:
 *   get:
 *     summary: Get device by ID
 *     tags: [Devices]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Device ID
 *     responses:
 *       200:
 *         description: Device retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Device'
 *       404:
 *         description: Device not found
 */
router.get(
  '/:id',
  getRateLimiter('standard'),
  getDeviceController().getDevice.bind(getDeviceController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/devices/{id}:
 *   put:
 *     summary: Update device information
 *     tags: [Devices]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Device ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 100
 *               type:
 *                 type: string
 *                 enum: [bluetooth_sensor, temperature_sensor, humidity_sensor, scale, sensor, other]
 *               brand:
 *                 type: string
 *                 maxLength: 50
 *               model:
 *                 type: string
 *                 maxLength: 50
 *               serialNumber:
 *                 type: string
 *                 maxLength: 100
 *               macAddress:
 *                 type: string
 *                 pattern: '^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$'
 *               bluetoothId:
 *                 type: string
 *               firmwareVersion:
 *                 type: string
 *                 maxLength: 20
 *               specifications:
 *                 type: object
 *               notes:
 *                 type: string
 *                 maxLength: 500
 *     responses:
 *       200:
 *         description: Device updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Device'
 *                 message:
 *                   type: string
 *       404:
 *         description: Device not found
 */
router.put(
  '/:id',
  getRateLimiter('standard'),
  getDeviceController().updateDevice.bind(getDeviceController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/devices/{id}:
 *   delete:
 *     summary: Delete device
 *     tags: [Devices]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Device ID
 *     responses:
 *       200:
 *         description: Device deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       404:
 *         description: Device not found
 */
router.delete(
  '/:id',
  getRateLimiter('strict'),
  getDeviceController().deleteDevice.bind(getDeviceController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/devices/{id}/pair:
 *   post:
 *     summary: Pair device with user account
 *     tags: [Devices]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Device ID
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               pairingCode:
 *                 type: string
 *                 description: Device-specific pairing code
 *               bluetoothAddress:
 *                 type: string
 *                 description: Bluetooth MAC address for pairing
 *               wifiCredentials:
 *                 type: object
 *                 properties:
 *                   ssid:
 *                     type: string
 *                   password:
 *                     type: string
 *                 description: WiFi credentials for network devices
 *               verificationCode:
 *                 type: string
 *                 description: Manual verification code
 *     responses:
 *       200:
 *         description: Device paired successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Device'
 *                 message:
 *                   type: string
 *       404:
 *         description: Device not found
 *       400:
 *         description: Invalid pairing data
 */
router.post(
  '/:id/pair',
  getRateLimiter('standard'),
  getDeviceController().pairDevice.bind(getDeviceController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/devices/{id}/unpair:
 *   post:
 *     summary: Unpair device from user account
 *     tags: [Devices]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Device ID
 *     responses:
 *       200:
 *         description: Device unpaired successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Device'
 *                 message:
 *                   type: string
 *       404:
 *         description: Device not found
 */
router.post(
  '/:id/unpair',
  getRateLimiter('standard'),
  getDeviceController().unpairDevice.bind(getDeviceController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/devices/{id}/telemetry:
 *   get:
 *     summary: Get device telemetry data
 *     tags: [Devices]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Device ID
 *       - in: query
 *         name: startTime
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Start time for telemetry data (ISO 8601 format)
 *       - in: query
 *         name: endTime
 *         schema:
 *           type: string
 *           format: date-time
 *         description: End time for telemetry data (ISO 8601 format)
 *     responses:
 *       200:
 *         description: Telemetry data retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     deviceId:
 *                       type: string
 *                     telemetry:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/DeviceTelemetry'
 *                     period:
 *                       type: object
 *                       properties:
 *                         startTime:
 *                           type: string
 *                         endTime:
 *                           type: string
 *                     count:
 *                       type: integer
 *       404:
 *         description: Device not found
 *       400:
 *         description: Invalid time parameters
 */
router.get(
  '/:id/telemetry',
  getRateLimiter('standard'),
  getDeviceController().getDeviceTelemetry.bind(getDeviceController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/devices/{id}/calibrate:
 *   post:
 *     summary: Calibrate device sensors
 *     tags: [Devices]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Device ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - calibrationType
 *               - referenceValue
 *               - measuredValue
 *             properties:
 *               calibrationType:
 *                 type: string
 *                 enum: [weight, temperature, pressure, battery, sensors]
 *                 description: Type of calibration to perform
 *               referenceValue:
 *                 type: number
 *                 description: Known reference value (ground truth)
 *               measuredValue:
 *                 type: number
 *                 description: Value measured by the device
 *               units:
 *                 type: string
 *                 description: Units of measurement (g, °C, PSI, etc.)
 *               notes:
 *                 type: string
 *                 maxLength: 200
 *                 description: Calibration notes or conditions
 *     responses:
 *       200:
 *         description: Device calibrated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     device:
 *                       $ref: '#/components/schemas/Device'
 *                     calibration:
 *                       type: object
 *                       properties:
 *                         type:
 *                           type: string
 *                         referenceValue:
 *                           type: number
 *                         measuredValue:
 *                           type: number
 *                         calibrationFactor:
 *                           type: number
 *                         calibrationOffset:
 *                           type: number
 *                         calibratedAt:
 *                           type: string
 *                           format: date-time
 *                 message:
 *                   type: string
 *       404:
 *         description: Device not found
 *       400:
 *         description: Invalid calibration data
 */
router.post(
  '/:id/calibrate',
  getRateLimiter('strict'),
  getDeviceController().calibrateDevice.bind(getDeviceController()) as RequestHandler,
);

/**
 * @swagger
 * /api/v1/devices/{id}/health:
 *   get:
 *     summary: Get device health status
 *     tags: [Devices]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Device ID
 *     responses:
 *       200:
 *         description: Device health status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     status:
 *                       type: string
 *                       enum: [healthy, warning, critical, offline]
 *                     batteryLevel:
 *                       type: number
 *                       minimum: 0
 *                       maximum: 100
 *                     lastSeen:
 *                       type: string
 *                       format: date-time
 *                     issues:
 *                       type: array
 *                       items:
 *                         type: string
 *                     telemetryHealth:
 *                       type: object
 *       404:
 *         description: Device not found
 */
router.get(
  '/:id/health',
  getRateLimiter('standard'),
  getDeviceController().getDeviceHealth.bind(getDeviceController()) as RequestHandler,
);

/**
 * @swagger
 * components:
 *   schemas:
 *     Device:
 *       type: object
 *       required:
 *         - id
 *         - userId
 *         - name
 *         - type
 *         - status
 *         - isPaired
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *         userId:
 *           type: string
 *           format: uuid
 *         name:
 *           type: string
 *         type:
 *           type: string
 *           enum: [bluetooth_sensor, temperature_sensor, humidity_sensor, scale, sensor, other]
 *         brand:
 *           type: string
 *         model:
 *           type: string
 *         serialNumber:
 *           type: string
 *         macAddress:
 *           type: string
 *         bluetoothId:
 *           type: string
 *         firmwareVersion:
 *           type: string
 *         specifications:
 *           type: object
 *         notes:
 *           type: string
 *         status:
 *           type: string
 *           enum: [active, inactive, paired, unpaired, calibrating, error]
 *         isPaired:
 *           type: boolean
 *         lastSeen:
 *           type: string
 *           format: date-time
 *         batteryLevel:
 *           type: number
 *           minimum: 0
 *           maximum: 100
 *         calibrationData:
 *           type: object
 *         createdAt:
 *           type: string
 *           format: date-time
 *         updatedAt:
 *           type: string
 *           format: date-time
 *     
 *     DeviceTelemetry:
 *       type: object
 *       required:
 *         - deviceId
 *         - timestamp
 *         - metrics
 *       properties:
 *         deviceId:
 *           type: string
 *           format: uuid
 *         userId:
 *           type: string
 *           format: uuid
 *         timestamp:
 *           type: integer
 *           description: Unix timestamp in milliseconds
 *         metrics:
 *           type: object
 *           description: Device-specific metrics and sensor data
 *         metadata:
 *           type: object
 *           description: Additional telemetry metadata
 */
}

export default router;