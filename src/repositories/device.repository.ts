/**
 * Device Repository
 * 
 * Handles all device-related database operations for the AppPlatform backend.
 * Extends BaseRepository to provide consistent error handling and transaction support.
 * 
 * @module DeviceRepository
 */

import { PrismaClient, Device, DeviceType, DeviceStatus, Prisma } from '@prisma/client';
import { BaseRepository } from './base.repository';
import { PaginationOptions, PaginatedResponse } from '../types/database.types';
import { AppError, ErrorCodes } from '../utils/AppError';
import { LoggerService } from '../services/logger.service';
import { DeviceSpecificationsSchema, DeviceCalibrationDataSchema, validateJsonbField } from '../models';
import { z } from 'zod';

export interface DeviceCreateInput {
  userId: string;
  name: string;
  type: DeviceType;
  brand?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  macAddress?: string | null;
  bluetoothId?: string | null;
  firmwareVersion?: string | null;
  specifications?: z.infer<typeof DeviceSpecificationsSchema> | null;
  notes?: string | null;
  status?: DeviceStatus;
  isPaired?: boolean;
  batteryLevel?: number | null;
  calibrationData?: z.infer<typeof DeviceCalibrationDataSchema> | null;
}

export interface DeviceUpdateInput {
  name?: string;
  type?: DeviceType;
  brand?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  macAddress?: string | null;
  bluetoothId?: string | null;
  firmwareVersion?: string | null;
  specifications?: z.infer<typeof DeviceSpecificationsSchema> | null;
  notes?: string | null;
  status?: DeviceStatus;
  isPaired?: boolean;
  lastSeen?: Date | string | null;
  batteryLevel?: number | null;
  calibrationData?: z.infer<typeof DeviceCalibrationDataSchema> | null;
  expectedVersion?: number;
}

export interface DeviceTelemetry {
  id: string;
  batteryLevel?: number | null;
  connectionType?: string;
  signalStrength?: number;
  memoryUsage?: number;
  storageUsage?: number;
  timestamp: Date;
}

export class DeviceRepository extends BaseRepository<Device> {
  constructor(prisma: PrismaClient, entityName: string, logger: LoggerService) {
    super(prisma, entityName, logger);
  }

  /**
   * Creates a new device record
   *
   * @param data - Device creation data
   * @param tx - Optional transaction client for atomicity
   * @returns Created device
   */
  async create(data: DeviceCreateInput, tx?: Prisma.TransactionClient): Promise<Device> {
    const client = tx || this.prisma; // Use transaction client if provided, else default Prisma client
    try {
      // Validate JSONB fields before storing
      const validatedSpecifications = data.specifications === null
        ? Prisma.DbNull
        : data.specifications
        ? validateJsonbField(data.specifications, DeviceSpecificationsSchema, 'specifications')
        : undefined;

      const validatedCalibrationData = data.calibrationData === null
        ? Prisma.DbNull
        : data.calibrationData
        ? validateJsonbField(data.calibrationData, DeviceCalibrationDataSchema, 'calibrationData')
        : undefined;

      // DO NOT use ...data spread - it would pass `name` which is NOT a Prisma field.
      // Prisma schema has `deviceName`, not `name`.
      // NOTE: isPaired is NOT in Prisma schema - use status/isActive instead
      const device = await client.device.create({
        data: {
          userId: data.userId,
          deviceName: data.name, // Map DeviceCreateInput.name → Prisma.deviceName
          type: data.type,
          status: data.status || DeviceStatus.UNPAIRED,
          macAddress: data.macAddress,
          bluetoothId: data.bluetoothId,
          serialNumber: data.serialNumber,
          brand: data.brand,
          model: data.model,
          firmwareVersion: data.firmwareVersion,
          batteryLevel: data.batteryLevel,
          isActive: data.isPaired ?? true, // Map isPaired → isActive (closest semantic equivalent)
          specifications: validatedSpecifications as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined,
          calibrationData: validatedCalibrationData as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined,
          version: 1,
          lastSeen: new Date(),
        },
      });

      this.logSuccess('create', { deviceId: device.id, userId: device.userId });
      return device;
    } catch (error) {
      throw this.handleError(error, 'create device');
    }
  }

  /**
   * Finds a device by ID with user authorization
   *
   * @param id - Device ID
   * @param userId - User ID for authorization
   * @param includeRelations - Include related data (not used for Device currently)
   * @param tx - Optional transaction client for consistency
   * @returns Device or null if not found
   */
  async findById(id: string, userId: string, includeRelations: boolean = false, tx?: Prisma.TransactionClient): Promise<Device | null> {
    const client = tx || this.prisma;
    try {
      const device = await client.device.findFirst({
        where: { id, userId },
      });

      // This helps diagnose sync issues where UPDATE is sent for non-existent devices
      if (device) {
        this.logSuccess('findById', { deviceId: id, found: true });
      } else {
        this.logger.debug('Device not found for user', {
          context: `${this.entityName}Repository.findById`,
          deviceId: id,
          userId,
          found: false,
        });
      }
      return device;
    } catch (error) {
      throw this.handleError(error, 'find device by id');
    }
  }

  /**
   * Finds a device by hardware identifier (macAddress, bluetoothId, or serialNumber).
   *
   * Used for idempotent replay reconstruction: when a COMPLETED sync operation
   * has lost its resultPayload, this method locates the canonical server entity
   * by the same hardware identifiers that DeviceHandler.create() uses for dedup.
   *
   * **READ-ONLY**: No mutations. No transaction required.
   * **USER-SCOPED**: Only returns devices owned by the specified user.
   *
   * Lookup priority: macAddress > bluetoothId > serialNumber (matches create() order).
   *
   * @param userId - User ID for authorization scoping
   * @param identifiers - Hardware identifiers to search by (at least one required)
   * @returns The matching device, or null if no match found
   */
  async findByHardwareIdentifier(
    userId: string,
    identifiers: {
      macAddress?: string | null;
      bluetoothId?: string | null;
      serialNumber?: string | null;
    },
  ): Promise<Device | null> {
    try {
      // Mirror the lookup priority from DeviceHandler.create():
      // macAddress > bluetoothId > serialNumber
      if (identifiers.macAddress) {
        const device = await this.prisma.device.findUnique({
          where: { macAddress: identifiers.macAddress },
        });
        if (device && device.userId === userId) {
          return device;
        }
      }

      if (identifiers.bluetoothId) {
        const device = await this.prisma.device.findUnique({
          where: { bluetoothId: identifiers.bluetoothId },
        });
        if (device && device.userId === userId) {
          return device;
        }
      }

      if (identifiers.serialNumber) {
        const device = await this.prisma.device.findUnique({
          where: { serialNumber: identifiers.serialNumber },
        });
        if (device && device.userId === userId) {
          return device;
        }
      }

      return null;
    } catch (error) {
      throw this.handleError(error, 'find device by hardware identifier');
    }
  }

  /**
   * Finds all devices for a user
   * Uses retry logic for transient database failures (Neon cold starts, pool exhaustion)
   */
  async findByUserId(
    userId: string,
    options?: PaginationOptions,
  ): Promise<PaginatedResponse<Device>> {
    try {
      // Wrap database operations with retry logic for transient failures
      return await this.executeWithRetry(async () => {
        const where: Prisma.DeviceWhereInput = { userId };

        const [devices, total] = await Promise.all([
          this.prisma.device.findMany({
            where,
            skip: options?.offset || 0,
            take: options?.limit || 20,
            orderBy: { lastSeen: 'desc' },
          }),
          this.prisma.device.count({ where }),
        ]);

        const offset = options?.offset || 0;
        const pageSize = options?.pageSize || 20;

        this.logSuccess('find devices by user', { userId, count: devices.length, total });

        return {
          items: devices,
          total,
          page: Math.floor(offset / pageSize) + 1,
          pageSize,
          hasMore: devices.length === pageSize,
          totalPages: Math.ceil(total / pageSize),
          offset,
        };
      }, 'findByUserId');
    } catch (error) {
      throw this.handleError(error, 'find devices by user');
    }
  }

  /**
   * Finds devices by type with user authorization
   *
   * @param type - Device type to filter by
   * @param userId - User ID for authorization
   * @param options - Pagination options
   * @returns Paginated devices owned by the user of the specified type
   */
  async findByDeviceType(
    type: DeviceType,
    userId: string,
    options?: PaginationOptions,
  ): Promise<PaginatedResponse<Device>> {
    try {
      // SECURITY: Enforce user ownership
      const where = this._enforceUserOwnership({ type }, userId);

      const [devices, total] = await Promise.all([
        this.prisma.device.findMany({
          where,
          skip: options?.offset || 0,
          take: options?.limit || 20,
          orderBy: { createdAt: 'desc' },
        }),
        this.prisma.device.count({ where }),
      ]);

      const offset = options?.offset || 0;
      const pageSize = options?.pageSize || 20;

      return {
        items: devices,
        total,
        page: Math.floor(offset / pageSize) + 1,
        pageSize,
        hasMore: devices.length === pageSize,
        totalPages: Math.ceil(total / pageSize),
        offset,
      };
    } catch (error) {
      throw this.handleError(error, 'find devices by type');
    }
  }

  /**
   * Updates a device with user authorization and optimistic locking
   *
   * @param id - Device ID
   * @param userId - User ID for authorization
   * @param data - Device update data
   * @param tx - Optional transaction client for atomicity
   * @returns Updated device
   * @throws AppError if device not found or version conflict
   */
  async update(id: string, userId: string, data: DeviceUpdateInput, tx?: Prisma.TransactionClient): Promise<Device> {
    const client = tx || this.prisma;
    try {
      // First verify ownership and get current version
      const existing = await this.findById(id, userId, false, tx);
      if (!existing) {
        throw new AppError(
          404,
          ErrorCodes.NOT_FOUND,
          'Device not found or access denied',
          true,
        );
      }

      // Validate JSONB fields before updating
      const validatedSpecifications = data.specifications === null
        ? Prisma.DbNull
        : data.specifications
        ? validateJsonbField(data.specifications, DeviceSpecificationsSchema, 'specifications')
        : undefined;

      const validatedCalibrationData = data.calibrationData === null
        ? Prisma.DbNull
        : data.calibrationData
        ? validateJsonbField(data.calibrationData, DeviceCalibrationDataSchema, 'calibrationData')
        : undefined;

      // Optimistic locking check against client expectation
      if (data.expectedVersion !== undefined && data.expectedVersion !== existing.version) {
        throw new AppError(
          409,
          ErrorCodes.CONFLICT,
          `Device has been modified by another process. Please refresh and try again.`,
          true,
        );
      }

      // Optimistic locking: Update only if version matches + atomically increment version
      // DO NOT use ...data spread - it would pass `name` which is NOT a Prisma field.
      // Prisma schema has `deviceName`, not `name`.
      // NOTE: isPaired is NOT in Prisma schema - use isActive instead
      const device = await client.device.update({
        where: {
          id,
          version: existing.version, // Optimistic lock check
        },
        data: {
          // Map DeviceUpdateInput fields → Prisma schema fields
          ...(data.name && { deviceName: data.name }), // Map name → deviceName
          ...(data.type && { type: data.type }),
          ...(data.status && { status: data.status }),
          ...(data.macAddress !== undefined && { macAddress: data.macAddress }),
          ...(data.bluetoothId !== undefined && { bluetoothId: data.bluetoothId }),
          ...(data.serialNumber !== undefined && { serialNumber: data.serialNumber }),
          ...(data.brand !== undefined && { brand: data.brand }),
          ...(data.model !== undefined && { model: data.model }),
          ...(data.firmwareVersion !== undefined && { firmwareVersion: data.firmwareVersion }),
          ...(data.batteryLevel !== undefined && { batteryLevel: data.batteryLevel }),
          ...(data.isPaired !== undefined && { isActive: data.isPaired }), // Map isPaired → isActive
          ...(data.lastSeen && { lastSeen: new Date(data.lastSeen) }),
          // JSONB fields with validation
          specifications: validatedSpecifications as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined,
          calibrationData: validatedCalibrationData as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined,
          lastSeen: new Date(),
          version: { increment: 1 }, // Atomic version increment
        },
      });

      this.logSuccess('update', {
        deviceId: id,
        oldVersion: existing.version,
        newVersion: device.version,
      });
      return device;
    } catch (error) {
      throw this.handleError(error, 'update device', { isOptimisticUpdate: true });
    }
  }

  /**
   * Updates device last sync timestamp with user authorization
   *
   * @param id - Device ID
   * @param userId - User ID for authorization
   * @param syncAt - Sync timestamp (optional)
   * @returns Updated device
   */
  async updateLastSync(id: string, userId: string, syncAt?: Date): Promise<Device> {
    try {
      // First verify ownership
      const existing = await this.findById(id, userId);
      if (!existing) {
        throw new AppError(
          404,
          ErrorCodes.NOT_FOUND,
          'Device not found or access denied',
          true,
        );
      }

      const device = await this.prisma.device.update({
        where: { id },
        data: {
          lastSeen: syncAt || new Date(),
        },
      });

      return device;
    } catch (error) {
      throw this.handleError(error, 'update device last sync');
    }
  }

  /**
   * Updates device status with user authorization
   *
   * @param id - Device ID
   * @param userId - User ID for authorization
   * @param status - New device status
   * @returns Updated device
   */
  async updateDeviceStatus(
    id: string,
    userId: string,
    status: DeviceStatus,
  ): Promise<Device> {
    try {
      // First verify ownership
      const existing = await this.findById(id, userId);
      if (!existing) {
        throw new AppError(
          404,
          ErrorCodes.NOT_FOUND,
          'Device not found or access denied',
          true,
        );
      }

      const device = await this.prisma.device.update({
        where: { id },
        data: {
          status,
          lastSeen: new Date(),
        },
      });

      return device;
    } catch (error) {
      throw this.handleError(error, 'update device status');
    }
  }

  /**
   * Records device telemetry data with user authorization
   *
   * @param telemetry - Device telemetry data
   * @param userId - User ID for authorization
   * @returns Success boolean
   */
  async recordTelemetry(telemetry: DeviceTelemetry, userId: string): Promise<boolean> {
    try {
      // First verify device ownership
      const existing = await this.findById(telemetry.id, userId);
      if (!existing) {
        throw new AppError(
          404,
          ErrorCodes.NOT_FOUND,
          'Device not found or access denied',
          true,
        );
      }

      // Store telemetry in a separate table or time-series database
      // For now, update device with last active timestamp
      // Note: Only updating fields that exist in the Device schema
      // Additional telemetry fields (connectionType, signalStrength, etc.)
      // should be stored in DeviceTelemetry table
      await this.prisma.device.update({
        where: { id: telemetry.id },
        data: {
          lastSeen: telemetry.timestamp,
          batteryLevel: telemetry.batteryLevel,
        },
      });

      return true;
    } catch (error) {
      throw this.handleError(error, 'record device telemetry');
    }
  }

  /**
   * Finds inactive devices for a specific user
   *
   * @param userId - User ID for authorization
   * @param inactiveSinceDays - Number of days of inactivity to consider (default: 30)
   * @returns Array of inactive devices owned by the user
   */
  async findInactiveDevices(
    userId: string,
    inactiveSinceDays: number = 30,
  ): Promise<Device[]> {
    try {
      const inactiveDate = new Date();
      inactiveDate.setDate(inactiveDate.getDate() - inactiveSinceDays);

      // SECURITY: Enforce user ownership
      const where = this._enforceUserOwnership(
        {
          lastSeen: {
            lt: inactiveDate,
          },
          status: DeviceStatus.ACTIVE,
        },
        userId
      );

      const devices = await this.prisma.device.findMany({
        where,
        orderBy: { lastSeen: 'asc' },
      });

      return devices;
    } catch (error) {
      throw this.handleError(error, 'find inactive devices');
    }
  }

  /**
   * Finds inactive devices across all users (ADMIN ONLY)
   * Use this method for system-wide maintenance or monitoring
   *
   * @param inactiveSinceDays - Number of days of inactivity to consider (default: 30)
   * @returns Array of all inactive devices
   */
  async findInactiveDevicesAdmin(
    inactiveSinceDays: number = 30,
  ): Promise<Device[]> {
    try {
      const inactiveDate = new Date();
      inactiveDate.setDate(inactiveDate.getDate() - inactiveSinceDays);

      const devices = await this.prisma.device.findMany({
        where: {
          lastSeen: {
            lt: inactiveDate,
          },
          status: DeviceStatus.ACTIVE,
        },
        orderBy: { lastSeen: 'asc' },
      });

      this.logSuccess('findInactiveDevicesAdmin', {
        count: devices.length,
        inactiveSinceDays,
      });

      return devices;
    } catch (error) {
      throw this.handleError(error, 'findInactiveDevicesAdmin');
    }
  }

  /**
   * Deletes a device with user authorization
   *
   * @param id - Device ID
   * @param userId - User ID for authorization
   * @param tx - Optional transaction client for atomicity
   * @returns Deleted device (for audit logging)
   * @throws AppError if device not found
   */
  async delete(id: string, userId: string, tx?: Prisma.TransactionClient): Promise<Device> {
    const client = tx || this.prisma;
    try {
      // First verify ownership
      const existing = await this.findById(id, userId, false, tx);
      if (!existing) {
        throw new AppError(
          404,
          ErrorCodes.NOT_FOUND,
          'Device not found or access denied',
          true,
        );
      }

      const device = await client.device.delete({
        where: { id },
      });

      this.logSuccess('delete', { deviceId: id });
      return device;
    } catch (error) {
      throw this.handleError(error, 'delete device');
    }
  }

  /**
   * Bulk update device status with user authorization
   *
   * @param ids - Array of device IDs
   * @param userId - User ID for authorization
   * @param status - New device status
   * @returns Number of updated devices
   */
  async bulkUpdateStatus(
    ids: string[],
    userId: string,
    status: DeviceStatus,
  ): Promise<number> {
    try {
      // First verify ALL devices belong to the user
      const ownedDevices = await this.prisma.device.findMany({
        where: { id: { in: ids }, userId },
        select: { id: true },
      });

      const ownedIds = ownedDevices.map(d => d.id);

      // Reject if any devices don't belong to user
      if (ownedIds.length !== ids.length) {
        const unauthorizedIds = ids.filter(id => !ownedIds.includes(id));
        throw new AppError(
          403,
          ErrorCodes.FORBIDDEN,
          `Cannot access devices: ${unauthorizedIds.join(', ')}`,
          true,
        );
      }

      const result = await this.prisma.device.updateMany({
        where: { id: { in: ownedIds }, userId },
        data: {
          status,
          lastSeen: new Date(),
        },
      });

      return result.count;
    } catch (error) {
      throw this.handleError(error, 'bulk update device status');
    }
  }
}