/**
 * Device Telemetry Repository
 * Handles time-series device telemetry data operations in PostgreSQL
 *
 * Features:
 * - High-volume telemetry data ingestion
 * - Time-series data querying with efficient indexing
 * - Flexible JSONB metrics storage
 * - Batch operations for performance
 * - TTL-based cleanup support
 *
 * Migrated from DynamoDB to PostgreSQL with JSONB for schema flexibility
 *
 * @see https://www.postgresql.org/docs/current/datatype-json.html
 */

import { PrismaClient, DeviceTelemetry, Prisma } from '@prisma/client';
import { BaseRepository, PaginatedResponse, PaginationParams } from './base.repository';
import { LoggerService } from '../services/logger.service';
import { AppError, ErrorCodes } from '../utils/AppError';

export type CreateDeviceTelemetryInput = {
  userId: string;
  deviceId: string;
  timestamp: Date;
  metrics: Record<string, unknown>; // Flexible JSONB metrics
  sessionId?: string;
  ttl?: number;
};

export type DeviceTelemetryQueryParams = PaginationParams & {
  startTime?: Date;
  endTime?: Date;
  deviceId?: string;
  userId?: string;
  sessionId?: string;
};

/**
 * Repository for device telemetry operations
 * Handles time-series data with PostgreSQL JSONB for flexible metrics
 */
export class DeviceTelemetryRepository extends BaseRepository<DeviceTelemetry> {
  constructor(prisma: PrismaClient, logger: LoggerService) {
    super(prisma, 'DeviceTelemetry', logger);
  }

  /**
   * Create a single device telemetry record
   */
  async create(data: CreateDeviceTelemetryInput): Promise<DeviceTelemetry> {
    try {
      // Controllers already validate input - repositories trust validated data

      const telemetry = await this.prisma.deviceTelemetry.create({
        data: {
          userId: data.userId,
          deviceId: data.deviceId,
          timestamp: data.timestamp,
          metrics: data.metrics as Prisma.JsonObject,
          sessionId: data.sessionId,
          ttl: data.ttl,
          // NOTE: DeviceTelemetry does NOT have a version field - append-only time-series data
        },
      });

      this.logSuccess('create', {
        telemetryId: telemetry.id,
        deviceId: telemetry.deviceId,
        timestamp: telemetry.timestamp.toISOString(),
      });

      return telemetry;
    } catch (error) {
      throw this.handleError(error, 'create');
    }
  }

  /**
   * Query device telemetry by device and time range
   * Optimized for time-series queries using indexed timestamp
   */
  async queryByDeviceAndTimeRange(
    deviceId: string,
    startTime: Date,
    endTime: Date,
    params?: PaginationParams
  ): Promise<PaginatedResponse<DeviceTelemetry>> {
    try {
      const where: Prisma.DeviceTelemetryWhereInput = {
        deviceId,
        timestamp: {
          gte: startTime,
          lte: endTime
        },
      };

      return this.findManyWithPagination<
        Prisma.DeviceTelemetryFindManyArgs,
        Prisma.DeviceTelemetryCountArgs
      >(
        (args) => this.prisma.deviceTelemetry.findMany(args),
        (args) => this.prisma.deviceTelemetry.count(args),
        {
          ...params,
          where,
          orderBy: params?.orderBy || { timestamp: 'desc' }
        }
      );
    } catch (error) {
      throw this.handleError(error, 'queryByDeviceAndTimeRange');
    }
  }

  /**
   * Query device telemetry by user and time range
   * Useful for user-specific analytics
   */
  async queryByUserAndTimeRange(
    userId: string,
    startTime: Date,
    endTime: Date,
    params?: PaginationParams
  ): Promise<PaginatedResponse<DeviceTelemetry>> {
    try {
      const where: Prisma.DeviceTelemetryWhereInput = {
        userId,
        timestamp: {
          gte: startTime,
          lte: endTime
        },
      };

      return this.findManyWithPagination<
        Prisma.DeviceTelemetryFindManyArgs,
        Prisma.DeviceTelemetryCountArgs
      >(
        (args) => this.prisma.deviceTelemetry.findMany(args),
        (args) => this.prisma.deviceTelemetry.count(args),
        {
          ...params,
          where,
          orderBy: params?.orderBy || { timestamp: 'desc' }
        }
      );
    } catch (error) {
      throw this.handleError(error, 'queryByUserAndTimeRange');
    }
  }

  /**
   * Query device telemetry by session
   * Links telemetry data to consumption sessions
   */
  async queryBySession(
    sessionId: string,
    params?: PaginationParams
  ): Promise<PaginatedResponse<DeviceTelemetry>> {
    try {
      const where: Prisma.DeviceTelemetryWhereInput = {
        sessionId,
      };

      return this.findManyWithPagination<
        Prisma.DeviceTelemetryFindManyArgs,
        Prisma.DeviceTelemetryCountArgs
      >(
        (args) => this.prisma.deviceTelemetry.findMany(args),
        (args) => this.prisma.deviceTelemetry.count(args),
        {
          ...params,
          where,
          orderBy: params?.orderBy || { timestamp: 'desc' }
        }
      );
    } catch (error) {
      throw this.handleError(error, 'queryBySession');
    }
  }

  /**
   * Batch create multiple telemetry records
   * Optimized for high-volume data ingestion
   */
  async batchCreate(records: CreateDeviceTelemetryInput[]): Promise<number> {
    try {
      // Controllers already validate input - repositories trust validated data
      const preparedRecords = records.map(record => ({
        ...record,
        metrics: record.metrics as Prisma.JsonObject,
      }));

      const result = await this.prisma.deviceTelemetry.createMany({
        data: preparedRecords,
        skipDuplicates: true, // Handle potential duplicates gracefully
      });

      this.logSuccess('batchCreate', {
        recordCount: result.count,
        requestedCount: records.length,
      });

      return result.count;
    } catch (error) {
      throw this.handleError(error, 'batchCreate');
    }
  }

  /**
   * Delete old telemetry records based on TTL or cutoff date
   * Used for data cleanup and retention management
   */
  async deleteOldRecords(cutoffDate: Date): Promise<number> {
    try {
      const result = await this.prisma.deviceTelemetry.deleteMany({
        where: {
          OR: [
            { timestamp: { lt: cutoffDate } },
            {
              ttl: {
                not: null,
                lt: Math.floor(Date.now() / 1000) // TTL is in Unix seconds
              }
            }
          ],
        },
      });

      this.logSuccess('deleteOldRecords', {
        count: result.count,
        cutoffDate: cutoffDate.toISOString(),
      });

      return result.count;
    } catch (error) {
      throw this.handleError(error, 'deleteOldRecords');
    }
  }

  /**
   * Get the latest telemetry record for a device
   * Useful for device health monitoring
   */
  async getLatestForDevice(deviceId: string): Promise<DeviceTelemetry | null> {
    try {
      const telemetry = await this.prisma.deviceTelemetry.findFirst({
        where: { deviceId },
        orderBy: { timestamp: 'desc' },
      });

      if (telemetry) {
        this.logSuccess('getLatestForDevice', {
          telemetryId: telemetry.id,
          deviceId,
          timestamp: telemetry.timestamp.toISOString(),
        });
      }

      return telemetry;
    } catch (error) {
      throw this.handleError(error, 'getLatestForDevice');
    }
  }

  /**
   * Get telemetry count for a device within time range
   * Useful for analytics and monitoring
   */
  async getCountByDeviceAndTimeRange(
    deviceId: string,
    startTime: Date,
    endTime: Date
  ): Promise<number> {
    try {
      const count = await this.prisma.deviceTelemetry.count({
        where: {
          deviceId,
          timestamp: {
            gte: startTime,
            lte: endTime,
          },
        },
      });

      this.logSuccess('getCountByDeviceAndTimeRange', {
        count,
        deviceId,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      });

      return count;
    } catch (error) {
      throw this.handleError(error, 'getCountByDeviceAndTimeRange');
    }
  }

  /**
   * Query telemetry with complex filters using JSONB metrics
   * Allows querying on specific metric fields within the JSON
   */
  async queryWithMetricFilters(
    filters: {
      userId?: string;
      deviceId?: string;
      startTime?: Date;
      endTime?: Date;
      metricFilters?: Record<string, unknown>; // JSONB path filters
    },
    params?: PaginationParams
  ): Promise<PaginatedResponse<DeviceTelemetry>> {
    try {
      const where: Prisma.DeviceTelemetryWhereInput = {
        ...(filters.userId && { userId: filters.userId }),
        ...(filters.deviceId && { deviceId: filters.deviceId }),
        ...(filters.startTime || filters.endTime) && {
          timestamp: {
            ...(filters.startTime && { gte: filters.startTime }),
            ...(filters.endTime && { lte: filters.endTime }),
          },
        },
        // JSONB path filters for metrics
        ...(filters.metricFilters && Object.keys(filters.metricFilters).length > 0) && {
          AND: Object.entries(filters.metricFilters).map(([key, value]) => ({
            metrics: {
              path: [key],
              equals: value as Prisma.InputJsonValue,
            },
          })) as Prisma.DeviceTelemetryWhereInput[],
        },
      };

      return this.findManyWithPagination<
        Prisma.DeviceTelemetryFindManyArgs,
        Prisma.DeviceTelemetryCountArgs
      >(
        (args) => this.prisma.deviceTelemetry.findMany(args),
        (args) => this.prisma.deviceTelemetry.count(args),
        {
          ...params,
          where,
          orderBy: params?.orderBy || { timestamp: 'desc' }
        }
      );
    } catch (error) {
      throw this.handleError(error, 'queryWithMetricFilters');
    }
  }
}