/**
 * Device Sync Handler
 *
 * Implements SyncEntityHandler for Device entities.
 * Handles device-specific sync operations including pairing status,
 * calibration data, battery level, and device metadata.
 *
 * **ARCHITECTURE:**
 * - Pure constructor injection (DeviceRepository dependency)
 * - Transactional operations using Prisma.TransactionClient
 * - Zod validation for type-safe data transformation
 * - Idempotency via macAddress/bluetoothId/serialNumber unique constraints
 *
 * @see SyncEntityHandler interface
 */

import { Device, DeviceType, DeviceStatus, Prisma } from '@prisma/client';
import { SyncEntityHandler } from '../sync.types';
import { DeviceRepository, DeviceCreateInput, DeviceUpdateInput } from '../../../repositories/device.repository';
import { AppError, ErrorCodes } from '../../../utils/AppError';
import { CreateDeviceSchema, UpdateDeviceSchema } from '../../../models';
import { LoggerService } from '../../logger.service';

/**
 * Device-specific synchronization handler
 *
 * 1. Validates Prisma.JsonValue → CreateDeviceInput/UpdateDeviceInput via Zod
 * 2. Uses macAddress/bluetoothId/serialNumber for idempotency (checks for existing device)
 * 3. Optimistic locking via version field
 * 4. Last-write-wins merge strategy with intelligent metadata merging
 */
export class DeviceHandler implements SyncEntityHandler<Device> {
  /**
   *  MODERN DI PATTERN: Constructor Injection
   *
   * @param deviceRepository - Device repository for database operations
   * @param logger - Logger service for audit trail
   */
  constructor(
    private readonly deviceRepository: DeviceRepository,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Create device within transaction context
   *
   * **IDEMPOTENCY:** Returns existing device if macAddress/bluetoothId/serialNumber matches
   *
   * @param userId - User ID for authorization
   * @param entityId - Entity ID (server-assigned or client-provided)
   * @param changeData - Raw sync change data
   * @param tx - Transaction client for atomicity
   * @returns Created or existing device
   */
  async create(
    userId: string,
    entityId: string,
    changeData: Prisma.JsonValue,
    tx: Prisma.TransactionClient,
  ): Promise<Device> {
    try {
      // STEP 1: Validate and transform JsonValue → CreateDeviceInput
      const parseResult = CreateDeviceSchema.safeParse(changeData);
      if (!parseResult.success) {
        this.logger.error('Device sync data validation failed', {
          context: 'DeviceHandler.create',
          userId,
          entityId,
          errors: parseResult.error.flatten().fieldErrors,
        });
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          'Invalid device data for sync creation',
          true,
          { validationErrors: parseResult.error.flatten().fieldErrors },
        );
      }

      const deviceData = parseResult.data;

      // STEP 2: Check for existing device via unique identifiers (macAddress, bluetoothId, serialNumber)
      let existingDevice: Device | null = null;

      if (deviceData.macAddress) {
        existingDevice = await tx.device.findUnique({
          where: { macAddress: deviceData.macAddress },
        });
      }

      if (!existingDevice && deviceData.bluetoothId) {
        existingDevice = await tx.device.findUnique({
          where: { bluetoothId: deviceData.bluetoothId },
        });
      }

      if (!existingDevice && deviceData.serialNumber) {
        existingDevice = await tx.device.findUnique({
          where: { serialNumber: deviceData.serialNumber },
        });
      }

      if (existingDevice) {
        // Verify ownership
        if (existingDevice.userId !== userId) {
          throw new AppError(
            403,
            ErrorCodes.FORBIDDEN,
            'Device already paired to another user',
            true,
            { deviceId: existingDevice.id },
          );
        }

        this.logger.info('Returning existing device for idempotency', {
          deviceId: existingDevice.id,
          userId,
          macAddress: deviceData.macAddress,
          bluetoothId: deviceData.bluetoothId,
          serialNumber: deviceData.serialNumber,
        });
        return existingDevice;
      }

      // STEP 3: Transform Zod-validated data to repository input
      const repositoryInput: DeviceCreateInput = {
        userId,
        name: deviceData.name,
        type: (deviceData.type as DeviceType) || 'OTHER', // Default to OTHER if not provided
        status: deviceData.status as DeviceStatus | undefined,
        macAddress: deviceData.macAddress || undefined,
        bluetoothId: deviceData.bluetoothId || undefined,
        serialNumber: deviceData.serialNumber || undefined,
        brand: deviceData.brand || undefined,
        model: deviceData.model || undefined,
        firmwareVersion: deviceData.firmwareVersion || undefined,
        batteryLevel: deviceData.batteryLevel ?? undefined,
        isPaired: deviceData.status === 'ACTIVE' ? true : false,
        specifications: (deviceData.specifications as Record<string, unknown>) || undefined,
        calibrationData: (deviceData.calibrationData as Record<string, unknown>) || undefined,
        notes: undefined, // Not in CreateDeviceSchema
      };

      // STEP 4: Create device via repository with transaction
      const device = await this.deviceRepository.create(repositoryInput, tx);

      this.logger.info('Device created via sync', {
        context: 'DeviceHandler.create',
        userId,
        deviceId: device.id,
        deviceName: device.deviceName,
        type: device.type,
      });

      return device;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Failed to create device via sync', {
        context: 'DeviceHandler.create',
        userId,
        entityId,
        error: err.message,
        stack: err.stack,
      });

      throw new AppError(
        500,
        ErrorCodes.DATABASE_ERROR,
        'Failed to create device during synchronization',
        true,
        { originalError: err.message },
      );
    }
  }

  /**
   * Update device within transaction context
   *
   * **OPTIMISTIC LOCKING:** Uses version field to prevent concurrent update conflicts
   *
   * @param userId - User ID for authorization
   * @param entityId - Device ID to update
   * @param changeData - Raw sync change data
   * @param tx - Transaction client for atomicity
   * @returns Updated device
   */
  async update(
    userId: string,
    entityId: string,
    changeData: Prisma.JsonValue,
    tx: Prisma.TransactionClient,
  ): Promise<Device> {
    try {
      // STEP 1: Validate and transform JsonValue → UpdateDeviceInput
      const parseResult = UpdateDeviceSchema.safeParse(changeData);
      if (!parseResult.success) {
        this.logger.error('Device update data validation failed', {
          context: 'DeviceHandler.update',
          userId,
          entityId,
          errors: parseResult.error.flatten().fieldErrors,
        });
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          'Invalid device data for sync update',
          true,
          { validationErrors: parseResult.error.flatten().fieldErrors },
        );
      }

      const updateData = parseResult.data;

      // STEP 2: Transform Zod-validated data to repository input
      const repositoryInput: DeviceUpdateInput = {
        ...(updateData.name && { name: updateData.name }),
        ...(updateData.type && { type: updateData.type }),
        ...(updateData.status && { status: updateData.status }),
        ...(updateData.macAddress !== undefined && { macAddress: updateData.macAddress ?? undefined }),
        ...(updateData.bluetoothId !== undefined && { bluetoothId: updateData.bluetoothId ?? undefined }),
        ...(updateData.serialNumber !== undefined && { serialNumber: updateData.serialNumber ?? undefined }),
        ...(updateData.brand !== undefined && { brand: updateData.brand ?? undefined }),
        ...(updateData.model !== undefined && { model: updateData.model ?? undefined }),
        ...(updateData.firmwareVersion !== undefined && { firmwareVersion: updateData.firmwareVersion ?? undefined }),
        ...(updateData.batteryLevel !== undefined && { batteryLevel: updateData.batteryLevel ?? undefined }),
        ...(updateData.lastSeen && { lastSeen: new Date(updateData.lastSeen) }),
        ...(updateData.specifications && { specifications: updateData.specifications as Record<string, unknown> }),
        ...(updateData.calibrationData && { calibrationData: updateData.calibrationData as Record<string, unknown> }),
      };

      // STEP 3: Call repository method with transaction
      // Repository handles ownership validation, optimistic locking, and version increment
      const device = await this.deviceRepository.update(entityId, userId, repositoryInput, tx);

      this.logger.info('Device updated via sync', {
        context: 'DeviceHandler.update',
        userId,
        deviceId: device.id,
        newVersion: device.version,
      });

      return device;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      // Check for optimistic locking conflict (Prisma P2025: Record not found)
      const err = error instanceof Error ? error : new Error(String(error));
      if (err.message.includes('P2025')) {
        throw new AppError(
          409,
          ErrorCodes.CONFLICT,
          'Device version conflict - concurrent modification detected',
          true,
          { entityId, userId },
        );
      }

      this.logger.error('Failed to update device via sync', {
        context: 'DeviceHandler.update',
        userId,
        entityId,
        error: err.message,
        stack: err.stack,
      });

      throw new AppError(
        500,
        ErrorCodes.DATABASE_ERROR,
        'Failed to update device during synchronization',
        true,
        { originalError: err.message },
      );
    }
  }

  /**
   * Delete device within transaction context
   *
   * @param userId - User ID for authorization
   * @param entityId - Device ID to delete
   * @param tx - Transaction client for atomicity
   * @returns Deleted device (for audit logging)
   */
  async delete(
    userId: string,
    entityId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Device> {
    try {
      // Call repository method with transaction
      // Repository handles ownership verification and deletion
      const device = await this.deviceRepository.delete(entityId, userId, tx);

      this.logger.info('Device deleted via sync', {
        context: 'DeviceHandler.delete',
        userId,
        deviceId: device.id,
      });

      return device;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Failed to delete device via sync', {
        context: 'DeviceHandler.delete',
        userId,
        entityId,
        error: err.message,
        stack: err.stack,
      });

      throw new AppError(
        500,
        ErrorCodes.DATABASE_ERROR,
        'Failed to delete device during synchronization',
        true,
        { originalError: err.message },
      );
    }
  }

  /**
   * Fetch current server version for conflict detection
   *
   *
   * @param userId - User ID for authorization
   * @param entityId - Device ID to fetch
   * @param tx - Transaction client for consistency
   * @returns Current server device or null
   */
  async fetchServerVersion(
    userId: string,
    entityId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Device | null> {
    try {
      // Call repository method with transaction
      // Repository handles user authorization check
      const device = await this.deviceRepository.findById(entityId, userId, false, tx);

      return device;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Failed to fetch server device version', {
        context: 'DeviceHandler.fetchServerVersion',
        userId,
        entityId,
        error: err.message,
      });

      throw new AppError(
        500,
        ErrorCodes.DATABASE_ERROR,
        'Failed to fetch device for conflict detection',
        true,
        { originalError: err.message },
      );
    }
  }

  /**
   * Resolve the canonical server entity ID for a CREATE operation.
   *
   * DeviceHandler is the primary handler that needs this because its idempotency
   * logic finds existing devices by hardware identifiers (macAddress, bluetoothId,
   * serialNumber), which can return an entity with a DIFFERENT ID than the client's
   * entityId.
   *
   * **LOOKUP PRIORITY** (mirrors create() order):
   * 1. Direct ID lookup — if entity exists with clientEntityId, it IS the serverId
   * 2. Hardware identifier lookup — macAddress > bluetoothId > serialNumber
   *
   * @param userId - User ID for authorization scoping
   * @param clientEntityId - The entity ID from the client's original push request
   * @param changeData - Raw change data containing hardware identifiers
   * @returns The canonical server entity ID, or null if not found
   */
  async resolveServerIdForCreate(
    userId: string,
    clientEntityId: string,
    changeData: Prisma.JsonValue,
  ): Promise<string | null> {
    try {
      // Step 1: Direct ID lookup — most common case (entity created with client's ID)
      const directLookup = await this.deviceRepository.findById(clientEntityId, userId);
      if (directLookup) {
        return directLookup.id;
      }

      // Step 2: Parse changeData for hardware identifiers
      // Use Zod validation to safely extract fields (same schema as create())
      const parseResult = CreateDeviceSchema.safeParse(changeData);
      if (!parseResult.success) {
        // Can't parse changeData — can't look up by hardware ID
        this.logger.warn('Cannot resolve server ID: changeData validation failed', {
          context: 'DeviceHandler.resolveServerIdForCreate',
          userId,
          clientEntityId,
          errors: parseResult.error.flatten().fieldErrors,
        });
        return null;
      }

      const deviceData = parseResult.data;

      // Step 3: Hardware identifier lookup (mirrors create() priority order)
      const device = await this.deviceRepository.findByHardwareIdentifier(userId, {
        macAddress: deviceData.macAddress || null,
        bluetoothId: deviceData.bluetoothId || null,
        serialNumber: deviceData.serialNumber || null,
      });

      if (device) {
        this.logger.info('Resolved server ID via hardware identifier for replay reconstruction', {
          context: 'DeviceHandler.resolveServerIdForCreate',
          userId,
          clientEntityId,
          resolvedServerId: device.id,
        });
        return device.id;
      }

      // Entity not found by any identifier
      return null;
    } catch (error) {
      // Read-only operation — log and return null (caller falls back to heuristic)
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Failed to resolve server ID for CREATE during reconstruction', {
        context: 'DeviceHandler.resolveServerIdForCreate',
        userId,
        clientEntityId,
        error: err.message,
      });
      return null;
    }
  }

  /**
   * Validate raw change data before processing
   *
   * @param changeData - Raw sync change data
   * @returns true if valid for device creation/update
   */
  validate(changeData: Prisma.JsonValue): boolean {
    // Try validating as either create or update schema
    const createValid = CreateDeviceSchema.safeParse(changeData).success;
    const updateValid = UpdateDeviceSchema.safeParse(changeData).success;

    return createValid || updateValid;
  }

  /**
   * Merge conflicting client and server device data
   *
   * **STRATEGY: Last-Write-Wins with Intelligent Metadata Merging**
   * - Client data takes precedence for most fields
   * - Calibration data and specifications are intelligently merged
   * - Version incremented
   * - Timestamp updated to reflect merge
   *
   * @param serverData - Current server device state
   * @param clientData - Client's proposed changes
   * @returns Merged device data (partial update)
   */
  merge(serverData: Device, clientData: Prisma.JsonValue): Partial<Device> {
    try {
      // Validate client data first
      const parseResult = UpdateDeviceSchema.safeParse(clientData);
      if (!parseResult.success) {
        this.logger.warn('Invalid client data during merge, using server data', {
          context: 'DeviceHandler.merge',
          deviceId: serverData.id,
          userId: serverData.userId,
        });
        // Return server data unchanged if client data is invalid
        return {
          version: serverData.version + 1, // Still increment version to mark as processed
          updatedAt: new Date(),
        };
      }

      const clientUpdate = parseResult.data;

      // Last-write-wins: Client data overrides server (with type conversions)
      const merged: Partial<Device> = {
        // Only include fields that are present in client update
        ...(clientUpdate.name && { deviceName: clientUpdate.name }),
        ...(clientUpdate.type && { type: clientUpdate.type }),
        ...(clientUpdate.status && { status: clientUpdate.status }),
        ...(clientUpdate.macAddress !== undefined && { macAddress: clientUpdate.macAddress }),
        ...(clientUpdate.bluetoothId !== undefined && { bluetoothId: clientUpdate.bluetoothId }),
        ...(clientUpdate.serialNumber !== undefined && { serialNumber: clientUpdate.serialNumber }),
        ...(clientUpdate.brand !== undefined && { brand: clientUpdate.brand }),
        ...(clientUpdate.model !== undefined && { model: clientUpdate.model }),
        ...(clientUpdate.firmwareVersion !== undefined && { firmwareVersion: clientUpdate.firmwareVersion }),
        ...(clientUpdate.batteryLevel !== undefined && { batteryLevel: clientUpdate.batteryLevel }),
        ...(clientUpdate.isActive !== undefined && { isActive: clientUpdate.isActive }),
        ...(clientUpdate.lastSeen && { lastSeen: new Date(clientUpdate.lastSeen) }),
        ...(clientUpdate.requiresCalibration !== undefined && { requiresCalibration: clientUpdate.requiresCalibration }),
        ...(clientUpdate.lastCalibrated && { lastCalibrated: new Date(clientUpdate.lastCalibrated) }),
        ...(clientUpdate.calibrationData && { calibrationData: clientUpdate.calibrationData as Prisma.JsonValue }),
        ...(clientUpdate.settings && { settings: clientUpdate.settings as Prisma.JsonValue }),
        ...(clientUpdate.specifications && { specifications: clientUpdate.specifications as Prisma.JsonValue }),
        ...(clientUpdate.pairedAt && { pairedAt: new Date(clientUpdate.pairedAt) }),
        version: serverData.version + 1,
        updatedAt: new Date(), // Update timestamp to reflect merge
      } as Partial<Device>;

      this.logger.info('Device data merged for conflict resolution', {
        context: 'DeviceHandler.merge',
        deviceId: serverData.id,
        userId: serverData.userId,
        oldVersion: serverData.version,
        newVersion: merged.version,
      });

      return merged;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Error during device merge, using server data', {
        context: 'DeviceHandler.merge',
        deviceId: serverData.id,
        error: err.message,
      });

      // Fallback: Return server data with incremented version
      return {
        version: serverData.version + 1,
        updatedAt: new Date(),
      };
    }
  }
}
