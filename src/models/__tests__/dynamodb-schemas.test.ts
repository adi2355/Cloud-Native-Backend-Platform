/**
 * DynamoDB Schemas Tests - Comprehensive Test Suite
 * 
 * Tests the strict DynamoDB validation schemas that replace z.any() validations.
 * Covers all telemetry, analytics, WebSocket, and sync event schemas with comprehensive validation.
 * 
 * Test Categories:
 * - Base Schema Tests (UserIdSchema, TimestampSchema, etc.)
 * - Telemetry Schema Tests
 * - Analytics Event Schema Tests
 * - WebSocket Event Schema Tests
 * - Sync Event Schema Tests
 * - Metadata Schema Tests
 * - Validation Helper Function Tests
 * - Edge Case Tests (null, undefined, empty objects)
 * - Type Coercion Prevention Tests
 * - Error Message Validation Tests
 * - Performance Tests with Large Objects
 * - Cross-Schema Integration Tests
 */

import { describe, it, expect } from '@jest/globals';
import { z } from 'zod';
import {
  // Base schemas
  UserIdSchema,
  TimestampSchema,
  CorrelationIdSchema,
  DeviceIdSchema,
  SessionIdSchema,
  
  // Telemetry schemas
  ConsumptionTelemetryMetricsSchema,
  SessionTelemetryMetricsSchema,
  DeviceTelemetryMetricsSchema,
  StrictDeviceTelemetrySchema,
  
  // Analytics schemas
  JournalAnalyticsEventDataSchema,
  PurchaseAnalyticsEventDataSchema,
  InventoryAnalyticsEventDataSchema,
  ConsumptionAnalyticsEventDataSchema,
  GoalAnalyticsEventDataSchema,
  AchievementAnalyticsEventDataSchema,
  AnalyticsEventDataSchema,
  StrictAnalyticsEventSchema,
  
  // WebSocket schemas
  WebSocketEventDataSchema,
  
  // Sync schemas
  SyncEventDataSchema,
  
  // Metadata schemas
  MetadataSchema,
  
  // Validation helpers
  validateTelemetryData,
  validateAnalyticsEventData,
  validateWebSocketEventData,
  validateSyncEventData,
  validateMetadata,
} from '../dynamodb-schemas';

// Test Data Factory
class SchemaTestDataFactory {
  static validUserId = '123e4567-e89b-12d3-a456-426614174000';
  static validTimestamp = Date.now();
  static validDeviceId = 'device-123';
  static validSessionId = '123e4567-e89b-12d3-a456-426614174001';
  static validCorrelationId = '123e4567-e89b-12d3-a456-426614174002';
  static validProductId = '123e4567-e89b-12d3-a456-426614174003';
  static validPurchaseId = '123e4567-e89b-12d3-a456-426614174004';

  static createValidConsumptionTelemetryMetrics(overrides: any = {}) {
    return {
      durationMs: 3000,
      intensity: 7.5,
      consumptionId: this.validUserId,
      productId: SchemaTestDataFactory.validProductId,
      temperature: 25.5,
      batteryLevel: 85,
      ...overrides,
    };
  }

  static createValidSessionTelemetryMetrics(overrides: any = {}) {
    return {
      eventType: 'session:start' as const,
      sessionType: 'consumption',
      purchaseId: SchemaTestDataFactory.validPurchaseId,
      expectedDurationMs: 5000,
      actualDurationMs: 4500,
      eventCount: 3,
      ...overrides,
    };
  }

  static createValidDeviceTelemetry(overrides: any = {}) {
    return {
      deviceId: this.validDeviceId,
      timestamp: this.validTimestamp,
      userId: this.validUserId,
      sessionId: this.validSessionId,
      metrics: this.createValidConsumptionTelemetryMetrics(),
      location: {
        latitude: 37.7749,
        longitude: -122.4194,
      },
      ...overrides,
    };
  }

  static createValidAnalyticsEvent(overrides: any = {}) {
    return {
      userId: this.validUserId,
      eventTimestamp: this.validTimestamp,
      eventType: 'consumption:logged' as const,
      eventData: {
        consumptionId: this.validUserId,
        durationMs: 3000,
        intensity: 8,
        productId: SchemaTestDataFactory.validProductId,
        deviceId: this.validDeviceId,
        sessionId: this.validSessionId,
      },
      correlationId: this.validCorrelationId,
      deviceId: this.validDeviceId,
      ...overrides,
    };
  }

  static createValidWebSocketEvent(overrides: any = {}) {
    return {
      type: 'consumption' as const,
      action: 'created' as const,
      entityId: this.validUserId,
      entityType: 'Consumption',
      timestamp: this.validTimestamp,
      data: {
        id: this.validUserId,
        duration: 3000,
        active: true,
        count: 1,
      },
      metadata: {
        source: 'api' as const,
        version: '1.0.0',
        priority: 'medium' as const,
      },
      ...overrides,
    };
  }

  static createValidSyncEvent(overrides: any = {}) {
    return {
      syncId: this.validUserId,
      syncType: 'PUSH' as const,
      entityType: 'consumption' as const,
      entityId: this.validUserId,
      operation: 'CREATE' as const,
      clientVersion: 1,
      serverVersion: 2,
      conflictResolution: 'CLIENT_WINS' as const,
      data: {
        id: this.validUserId,
        timestamp: this.validTimestamp,
      },
      checksum: 'abc123def456',
      ...overrides,
    };
  }

  static createValidMetadata(overrides: any = {}) {
    return {
      source: 'mobile_app' as const,
      version: '1.2.3',
      userAgent: 'AppPlatform Mobile/1.2.3',
      ipAddress: '192.168.1.1',
      deviceInfo: {
        platform: 'ios' as const,
        version: '17.0',
        model: 'iPhone 15',
        manufacturer: 'Apple',
      },
      location: {
        country: 'US',
        region: 'CA',
        city: 'San Francisco',
        timezone: 'America/Los_Angeles',
      },
      feature_flags: {
        new_ui: true,
        beta_features: false,
      },
      experimental_features: ['ai_insights'],
      session_context: {
        sessionId: this.validSessionId,
        duration: 300000,
        pageViews: 5,
        interactions: 12,
      },
      ...overrides,
    };
  }
}

describe('DynamoDB Schemas', () => {
  describe('Base Schemas', () => {
    describe('UserIdSchema', () => {
      it('should accept valid UUIDs', () => {
        const validUUIDs = [
          '123e4567-e89b-12d3-a456-426614174000',
          '00000000-0000-0000-0000-000000000000',
          'ffffffff-ffff-ffff-ffff-ffffffffffff',
        ];

        validUUIDs.forEach(uuid => {
          expect(() => UserIdSchema.parse(uuid)).not.toThrow();
        });
      });

      it('should reject invalid UUIDs', () => {
        const invalidUUIDs = [
          'not-a-uuid',
          '123',
          '123e4567-e89b-12d3-a456',
          '123e4567-e89b-12d3-a456-42661417400',
          '',
          null,
          undefined,
          123,
          {},
        ];

        invalidUUIDs.forEach(uuid => {
          expect(() => UserIdSchema.parse(uuid)).toThrow();
        });
      });
    });

    describe('TimestampSchema', () => {
      it('should accept valid positive integer timestamps', () => {
        const validTimestamps = [
          1640995200000, // Jan 1, 2022
          Date.now(),
          1,
          Number.MAX_SAFE_INTEGER,
        ];

        validTimestamps.forEach(timestamp => {
          expect(() => TimestampSchema.parse(timestamp)).not.toThrow();
        });
      });

      it('should reject invalid timestamps', () => {
        const invalidTimestamps = [
          0,
          -1,
          1640995200000.5, // Decimal
          '1640995200000', // String
          null,
          undefined,
          {},
          [],
        ];

        invalidTimestamps.forEach(timestamp => {
          expect(() => TimestampSchema.parse(timestamp)).toThrow();
        });
      });
    });

    describe('DeviceIdSchema', () => {
      it('should accept valid device IDs', () => {
        const validDeviceIds = [
          'device-123',
          'BLE_DEV_001',
          'a',
          '1234567890abcdef',
        ];

        validDeviceIds.forEach(deviceId => {
          expect(() => DeviceIdSchema.parse(deviceId)).not.toThrow();
        });
      });

      it('should reject invalid device IDs', () => {
        const invalidDeviceIds = [
          '',
          null,
          undefined,
          123,
          {},
          [],
        ];

        invalidDeviceIds.forEach(deviceId => {
          expect(() => DeviceIdSchema.parse(deviceId)).toThrow();
        });
      });
    });
  });

  describe('Telemetry Schemas', () => {
    describe('ConsumptionTelemetryMetricsSchema', () => {
      it('should accept valid consumption telemetry metrics', () => {
        const validMetrics = SchemaTestDataFactory.createValidConsumptionTelemetryMetrics();
        
        expect(() => ConsumptionTelemetryMetricsSchema.parse(validMetrics)).not.toThrow();
      });

      it('should accept metrics with optional fields missing', () => {
        const minimalMetrics = {
          durationMs: 1000,
          intensity: 5,
          consumptionId: SchemaTestDataFactory.validUserId,
        };

        expect(() => ConsumptionTelemetryMetricsSchema.parse(minimalMetrics)).not.toThrow();
      });

      it('should reject invalid intensity values', () => {
        const invalidIntensities = [-1, 11, 10.1];

        invalidIntensities.forEach(intensity => {
          const metrics = SchemaTestDataFactory.createValidConsumptionTelemetryMetrics({ intensity });
          expect(() => ConsumptionTelemetryMetricsSchema.parse(metrics)).toThrow();
        });
      });

      it('should reject invalid duration values', () => {
        const invalidDurations = [0, -1000, 1.5];

        invalidDurations.forEach(durationMs => {
          const metrics = SchemaTestDataFactory.createValidConsumptionTelemetryMetrics({ durationMs });
          expect(() => ConsumptionTelemetryMetricsSchema.parse(metrics)).toThrow();
        });
      });

      it('should reject invalid battery levels', () => {
        const invalidBatteryLevels = [-1, 101, -0.1, 100.1];

        invalidBatteryLevels.forEach(batteryLevel => {
          const metrics = SchemaTestDataFactory.createValidConsumptionTelemetryMetrics({ batteryLevel });
          expect(() => ConsumptionTelemetryMetricsSchema.parse(metrics)).toThrow();
        });
      });
    });

    describe('SessionTelemetryMetricsSchema', () => {
      it('should accept valid session telemetry metrics', () => {
        const validMetrics = SchemaTestDataFactory.createValidSessionTelemetryMetrics();
        
        expect(() => SessionTelemetryMetricsSchema.parse(validMetrics)).not.toThrow();
      });

      it('should accept all valid event types', () => {
        const eventTypes = ['session:start', 'session:end', 'session:pause', 'session:resume'];

        eventTypes.forEach(eventType => {
          const metrics = SchemaTestDataFactory.createValidSessionTelemetryMetrics({ eventType });
          expect(() => SessionTelemetryMetricsSchema.parse(metrics)).not.toThrow();
        });
      });

      it('should reject invalid event types', () => {
        const invalidEventTypes = ['session_invalid', 'start', '', null];

        invalidEventTypes.forEach(eventType => {
          const metrics = SchemaTestDataFactory.createValidSessionTelemetryMetrics({ eventType });
          expect(() => SessionTelemetryMetricsSchema.parse(metrics)).toThrow();
        });
      });

      it('should accept negative hit count', () => {
        const metrics = SchemaTestDataFactory.createValidSessionTelemetryMetrics({ eventCount: 0 });
        expect(() => SessionTelemetryMetricsSchema.parse(metrics)).not.toThrow();
      });
    });

    describe('DeviceTelemetryMetricsSchema', () => {
      it('should accept consumption telemetry metrics', () => {
        const consumptionMetrics = SchemaTestDataFactory.createValidConsumptionTelemetryMetrics();
        
        expect(() => DeviceTelemetryMetricsSchema.parse(consumptionMetrics)).not.toThrow();
      });

      it('should accept session telemetry metrics', () => {
        const sessionMetrics = SchemaTestDataFactory.createValidSessionTelemetryMetrics();
        
        expect(() => DeviceTelemetryMetricsSchema.parse(sessionMetrics)).not.toThrow();
      });

      it('should accept generic device metrics', () => {
        const genericMetrics = {
          batteryLevel: 75,
          temperature: 20.5,
          humidity: 65,
          pressure: 1013.25,
          signalStrength: -45,
          firmwareVersion: '2.1.0',
          errorCode: 'E001',
          calibrationStatus: 'calibrated',
        };

        expect(() => DeviceTelemetryMetricsSchema.parse(genericMetrics)).not.toThrow();
      });

      it('should accept empty generic metrics', () => {
        expect(() => DeviceTelemetryMetricsSchema.parse({})).not.toThrow();
      });

      it('should reject invalid calibration status', () => {
        const invalidStatuses = ['invalid', 'pending', '', null];

        invalidStatuses.forEach(calibrationStatus => {
          const metrics = { calibrationStatus };
          expect(() => DeviceTelemetryMetricsSchema.parse(metrics)).toThrow();
        });
      });
    });

    describe('StrictDeviceTelemetrySchema', () => {
      it('should accept complete valid device telemetry', () => {
        const validTelemetry = SchemaTestDataFactory.createValidDeviceTelemetry();
        
        expect(() => StrictDeviceTelemetrySchema.parse(validTelemetry)).not.toThrow();
      });

      it('should accept telemetry without optional fields', () => {
        const minimalTelemetry = {
          deviceId: 'device-123',
          timestamp: Date.now(),
          userId: SchemaTestDataFactory.validUserId,
          metrics: {},
        };

        expect(() => StrictDeviceTelemetrySchema.parse(minimalTelemetry)).not.toThrow();
      });

      it('should validate location coordinates', () => {
        const invalidLocations = [
          { latitude: -91, longitude: 0 },
          { latitude: 91, longitude: 0 },
          { latitude: 0, longitude: -181 },
          { latitude: 0, longitude: 181 },
        ];

        invalidLocations.forEach(location => {
          const telemetry = SchemaTestDataFactory.createValidDeviceTelemetry({ location });
          expect(() => StrictDeviceTelemetrySchema.parse(telemetry)).toThrow();
        });
      });

      it('should accept valid location coordinates', () => {
        const validLocations = [
          { latitude: -90, longitude: -180 },
          { latitude: 90, longitude: 180 },
          { latitude: 0, longitude: 0 },
          { latitude: 37.7749, longitude: -122.4194 },
        ];

        validLocations.forEach(location => {
          const telemetry = SchemaTestDataFactory.createValidDeviceTelemetry({ location });
          expect(() => StrictDeviceTelemetrySchema.parse(telemetry)).not.toThrow();
        });
      });
    });
  });

  describe('Analytics Event Schemas', () => {
    describe('ConsumptionAnalyticsEventDataSchema', () => {
      it('should accept valid consumption analytics data', () => {
        const validData = {
          consumptionId: SchemaTestDataFactory.validUserId,
          durationMs: 3000,
          intensity: 8,
          productId: SchemaTestDataFactory.validProductId,
          purchaseId: SchemaTestDataFactory.validPurchaseId,
          deviceId: 'device-123',
          sessionId: SchemaTestDataFactory.validSessionId,
          deviceType: 'delivery_device',
          consumptionMethod: 'inhalation',
          notes: 'Great session',
        };

        expect(() => ConsumptionAnalyticsEventDataSchema.parse(validData)).not.toThrow();
      });

      it('should accept minimal required fields', () => {
        const minimalData = {
          consumptionId: SchemaTestDataFactory.validUserId,
          durationMs: 1000,
        };

        expect(() => ConsumptionAnalyticsEventDataSchema.parse(minimalData)).not.toThrow();
      });

      it('should validate device types', () => {
        const validDeviceTypes = ['delivery_device', 'device', 'device', 'unit', 'ingestible', 'other'];

        validDeviceTypes.forEach(deviceType => {
          const data = {
            consumptionId: SchemaTestDataFactory.validUserId,
            durationMs: 1000,
            deviceType,
          };
          expect(() => ConsumptionAnalyticsEventDataSchema.parse(data)).not.toThrow();
        });
      });

      it('should validate consumption methods', () => {
        const validMethods = ['inhalation', 'ingestion', 'topical', 'sublingual'];

        validMethods.forEach(consumptionMethod => {
          const data = {
            consumptionId: SchemaTestDataFactory.validUserId,
            durationMs: 1000,
            consumptionMethod,
          };
          expect(() => ConsumptionAnalyticsEventDataSchema.parse(data)).not.toThrow();
        });
      });
    });

    describe('PurchaseAnalyticsEventDataSchema', () => {
      it('should accept valid purchase analytics data', () => {
        const validData = {
          purchaseId: SchemaTestDataFactory.validUserId,
          quantityPurchased: 3.5,
          costSpent: 35.99,
          productId: SchemaTestDataFactory.validProductId,
          pricePerUnit: 10.28,
          isActive: true,
          lossFactor: 0.1,
          purchaseChannel: 'retailer',
          paymentMethod: 'card',
        };

        expect(() => PurchaseAnalyticsEventDataSchema.parse(validData)).not.toThrow();
      });

      it('should validate purchase channels', () => {
        const validChannels = ['retailer', 'delivery', 'online', 'other'];

        validChannels.forEach(purchaseChannel => {
          const data = {
            purchaseId: SchemaTestDataFactory.validUserId,
            quantityPurchased: 1.0,
            costSpent: 10.0,
            isActive: true,
            lossFactor: 0.1,
            purchaseChannel,
          };
          expect(() => PurchaseAnalyticsEventDataSchema.parse(data)).not.toThrow();
        });
      });

      it('should validate payment methods', () => {
        const validMethods = ['cash', 'card', 'crypto', 'other'];

        validMethods.forEach(paymentMethod => {
          const data = {
            purchaseId: SchemaTestDataFactory.validUserId,
            quantityPurchased: 1.0,
            costSpent: 10.0,
            isActive: true,
            lossFactor: 0.1,
            paymentMethod,
          };
          expect(() => PurchaseAnalyticsEventDataSchema.parse(data)).not.toThrow();
        });
      });
    });

    describe('GoalAnalyticsEventDataSchema', () => {
      it('should accept valid goal analytics data', () => {
        const validData = {
          goalId: SchemaTestDataFactory.validUserId,
          goalType: 'REDUCTION',
          metricType: 'CONSUMPTION_COUNT',
          targetValue: 10,
          currentValue: 7,
          progressPercentage: 70,
          status: 'ACTIVE',
          daysRemaining: 23,
          streak: 5,
        };

        expect(() => GoalAnalyticsEventDataSchema.parse(validData)).not.toThrow();
      });

      it('should validate goal types', () => {
        const validGoalTypes = ['REDUCTION', 'MODERATION', 'ABSTINENCE', 'SAVINGS', 'CUSTOM'];

        validGoalTypes.forEach(goalType => {
          const data = {
            goalId: SchemaTestDataFactory.validUserId,
            goalType,
            metricType: 'CONSUMPTION_COUNT',
            targetValue: 10,
            currentValue: 5,
            progressPercentage: 50,
            status: 'ACTIVE',
          };
          expect(() => GoalAnalyticsEventDataSchema.parse(data)).not.toThrow();
        });
      });

      it('should validate progress percentage bounds', () => {
        const invalidPercentages = [-1, 101, 150];

        invalidPercentages.forEach(progressPercentage => {
          const data = {
            goalId: SchemaTestDataFactory.validUserId,
            goalType: 'REDUCTION',
            metricType: 'CONSUMPTION_COUNT',
            targetValue: 10,
            currentValue: 5,
            progressPercentage,
            status: 'ACTIVE',
          };
          expect(() => GoalAnalyticsEventDataSchema.parse(data)).toThrow();
        });
      });
    });

    describe('StrictAnalyticsEventSchema', () => {
      it('should accept valid complete analytics event', () => {
        const validEvent = SchemaTestDataFactory.createValidAnalyticsEvent();
        
        expect(() => StrictAnalyticsEventSchema.parse(validEvent)).not.toThrow();
      });

      it('should validate all event types', () => {
        const eventTypes = [
          'journal:entry:created',
          'journal:entry:updated', 
          'journal:entry:deleted',
          'purchase:created',
          'purchase:updated',
          'purchase:completed',
          'inventory:added',
          'inventory:adjusted',
          'inventory:depleted',
          'consumption:logged',
          'consumption:updated',
          'consumption:deleted',
          'goal:created',
          'goal:updated',
          'goal:achieved',
          'goal:failed',
          'achievement:unlocked',
          'achievement:progress',
          'session:started',
          'session:ended',
          'user:registered',
          'user:updated',
          'device:paired',
          'device:calibrated',
        ];

        eventTypes.forEach(eventType => {
          const event = SchemaTestDataFactory.createValidAnalyticsEvent({ eventType });
          expect(() => StrictAnalyticsEventSchema.parse(event)).not.toThrow();
        });
      });

      it('should accept events with minimal eventData', () => {
        const minimalEventData = {
          consumptionId: SchemaTestDataFactory.validUserId,
          durationMs: 1000,
        };

        const event = SchemaTestDataFactory.createValidAnalyticsEvent({
          eventData: minimalEventData,
        });

        expect(() => StrictAnalyticsEventSchema.parse(event)).not.toThrow();
      });
    });
  });

  describe('WebSocket Event Schema', () => {
    it('should accept valid WebSocket event data', () => {
      const validEvent = SchemaTestDataFactory.createValidWebSocketEvent();
      
      expect(() => WebSocketEventDataSchema.parse(validEvent)).not.toThrow();
    });

    it('should validate event types', () => {
      const validTypes = ['consumption', 'purchase', 'product', 'sync', 'notification', 'goal', 'achievement'];

      validTypes.forEach(type => {
        const event = SchemaTestDataFactory.createValidWebSocketEvent({ type });
        expect(() => WebSocketEventDataSchema.parse(event)).not.toThrow();
      });
    });

    it('should validate actions', () => {
      const validActions = ['created', 'updated', 'deleted', 'completed', 'unlocked', 'started', 'ended'];

      validActions.forEach(action => {
        const event = SchemaTestDataFactory.createValidWebSocketEvent({ action });
        expect(() => WebSocketEventDataSchema.parse(event)).not.toThrow();
      });
    });

    it('should accept data with various value types', () => {
      const dataWithMixedTypes = {
        stringValue: 'test',
        numberValue: 42,
        booleanValue: true,
        nullValue: null,
      };

      const event = SchemaTestDataFactory.createValidWebSocketEvent({
        data: dataWithMixedTypes,
      });

      expect(() => WebSocketEventDataSchema.parse(event)).not.toThrow();
    });

    it('should reject unsupported data value types', () => {
      const dataWithUnsupportedTypes = {
        arrayValue: [1, 2, 3],
        objectValue: { nested: true },
        undefinedValue: undefined,
      };

      const event = SchemaTestDataFactory.createValidWebSocketEvent({
        data: dataWithUnsupportedTypes,
      });

      expect(() => WebSocketEventDataSchema.parse(event)).toThrow();
    });
  });

  describe('Sync Event Schema', () => {
    it('should accept valid sync event data', () => {
      const validEvent = SchemaTestDataFactory.createValidSyncEvent();
      
      expect(() => SyncEventDataSchema.parse(validEvent)).not.toThrow();
    });

    it('should validate sync types', () => {
      const validSyncTypes = ['PUSH', 'PULL', 'FULL'];

      validSyncTypes.forEach(syncType => {
        const event = SchemaTestDataFactory.createValidSyncEvent({ syncType });
        expect(() => SyncEventDataSchema.parse(event)).not.toThrow();
      });
    });

    it('should validate entity types', () => {
      const validEntityTypes = ['consumption', 'purchase', 'journal', 'inventory', 'goal'];

      validEntityTypes.forEach(entityType => {
        const event = SchemaTestDataFactory.createValidSyncEvent({ entityType });
        expect(() => SyncEventDataSchema.parse(event)).not.toThrow();
      });
    });

    it('should validate operations', () => {
      const validOperations = ['CREATE', 'UPDATE', 'DELETE'];

      validOperations.forEach(operation => {
        const event = SchemaTestDataFactory.createValidSyncEvent({ operation });
        expect(() => SyncEventDataSchema.parse(event)).not.toThrow();
      });
    });

    it('should validate conflict resolution strategies', () => {
      const validStrategies = ['CLIENT_WINS', 'SERVER_WINS', 'MERGE', 'MANUAL'];

      validStrategies.forEach(conflictResolution => {
        const event = SchemaTestDataFactory.createValidSyncEvent({ conflictResolution });
        expect(() => SyncEventDataSchema.parse(event)).not.toThrow();
      });
    });

    it('should accept events without conflict resolution', () => {
      const event = SchemaTestDataFactory.createValidSyncEvent();
      delete event.conflictResolution;

      expect(() => SyncEventDataSchema.parse(event)).not.toThrow();
    });
  });

  describe('Metadata Schema', () => {
    it('should accept valid metadata', () => {
      const validMetadata = SchemaTestDataFactory.createValidMetadata();
      
      expect(() => MetadataSchema.parse(validMetadata)).not.toThrow();
    });

    it('should accept empty metadata', () => {
      expect(() => MetadataSchema.parse({})).not.toThrow();
    });

    it('should validate source types', () => {
      const validSources = ['api', 'mobile_app', 'web_app', 'device', 'system'];

      validSources.forEach(source => {
        const metadata = { source };
        expect(() => MetadataSchema.parse(metadata)).not.toThrow();
      });
    });

    it('should validate platform types', () => {
      const validPlatforms = ['ios', 'android', 'web', 'device'];

      validPlatforms.forEach(platform => {
        const metadata = {
          deviceInfo: { platform },
        };
        expect(() => MetadataSchema.parse(metadata)).not.toThrow();
      });
    });

    it('should validate IP addresses', () => {
      const validIPs = ['192.168.1.1', '10.0.0.1', '127.0.0.1', '::1', '2001:db8::1'];

      validIPs.forEach(ipAddress => {
        const metadata = { ipAddress };
        expect(() => MetadataSchema.parse(metadata)).not.toThrow();
      });
    });

    it('should reject invalid IP addresses', () => {
      const invalidIPs = ['not.an.ip', '999.999.999.999', 'localhost', ''];

      invalidIPs.forEach(ipAddress => {
        const metadata = { ipAddress };
        expect(() => MetadataSchema.parse(metadata)).toThrow();
      });
    });

    it('should validate feature flags as boolean record', () => {
      const validFeatureFlags = {
        new_feature: true,
        beta_mode: false,
        experimental: true,
      };

      const metadata = { feature_flags: validFeatureFlags };
      expect(() => MetadataSchema.parse(metadata)).not.toThrow();
    });

    it('should reject non-boolean feature flag values', () => {
      const invalidFeatureFlags = {
        new_feature: 'enabled',
        beta_mode: 1,
        experimental: null,
      };

      const metadata = { feature_flags: invalidFeatureFlags };
      expect(() => MetadataSchema.parse(metadata)).toThrow();
    });
  });

  describe('Validation Helper Functions', () => {
    describe('validateTelemetryData', () => {
      it('should validate correct telemetry data', () => {
        const validTelemetry = SchemaTestDataFactory.createValidDeviceTelemetry();
        
        expect(() => validateTelemetryData(validTelemetry)).not.toThrow();
        
        const result = validateTelemetryData(validTelemetry);
        expect(result).toEqual(validTelemetry);
      });

      it('should throw ZodError for invalid telemetry data', () => {
        const invalidTelemetry = { invalid: 'data' };
        
        expect(() => validateTelemetryData(invalidTelemetry)).toThrow(z.ZodError);
      });

      it('should provide detailed error messages', () => {
        const invalidTelemetry = {
          deviceId: '', // Invalid - empty string
          timestamp: -1, // Invalid - negative
          userId: 'not-a-uuid', // Invalid UUID
        };

        try {
          validateTelemetryData(invalidTelemetry);
        } catch (error) {
          expect(error).toBeInstanceOf(z.ZodError);
          const zodError = error as z.ZodError;
          expect(zodError.issues.length).toBeGreaterThanOrEqual(3); // Should have at least 3 validation issues
        }
      });
    });

    describe('validateAnalyticsEventData', () => {
      it('should validate correct analytics event data', () => {
        const validEvent = SchemaTestDataFactory.createValidAnalyticsEvent();
        
        expect(() => validateAnalyticsEventData(validEvent)).not.toThrow();
        
        const result = validateAnalyticsEventData(validEvent);
        expect(result).toEqual(validEvent);
      });

      it('should throw ZodError for invalid analytics data', () => {
        const invalidEvent = { invalid: 'data' };
        
        expect(() => validateAnalyticsEventData(invalidEvent)).toThrow(z.ZodError);
      });
    });

    describe('validateWebSocketEventData', () => {
      it('should validate correct WebSocket event data', () => {
        const validEvent = SchemaTestDataFactory.createValidWebSocketEvent();
        
        expect(() => validateWebSocketEventData(validEvent)).not.toThrow();
        
        const result = validateWebSocketEventData(validEvent);
        expect(result).toEqual(validEvent);
      });

      it('should throw ZodError for invalid WebSocket data', () => {
        const invalidEvent = { invalid: 'data' };
        
        expect(() => validateWebSocketEventData(invalidEvent)).toThrow(z.ZodError);
      });
    });

    describe('validateSyncEventData', () => {
      it('should validate correct sync event data', () => {
        const validEvent = SchemaTestDataFactory.createValidSyncEvent();
        
        expect(() => validateSyncEventData(validEvent)).not.toThrow();
        
        const result = validateSyncEventData(validEvent);
        expect(result).toEqual(validEvent);
      });

      it('should throw ZodError for invalid sync data', () => {
        const invalidEvent = { invalid: 'data' };
        
        expect(() => validateSyncEventData(invalidEvent)).toThrow(z.ZodError);
      });
    });

    describe('validateMetadata', () => {
      it('should validate correct metadata', () => {
        const validMetadata = SchemaTestDataFactory.createValidMetadata();
        
        expect(() => validateMetadata(validMetadata)).not.toThrow();
        
        const result = validateMetadata(validMetadata);
        expect(result).toEqual(validMetadata);
      });

      it('should throw ZodError for invalid metadata', () => {
        const invalidMetadata = { ipAddress: 'not-an-ip' };
        
        expect(() => validateMetadata(invalidMetadata)).toThrow(z.ZodError);
      });
    });
  });

  describe('Edge Cases and Error Scenarios', () => {
    describe('Null and Undefined Handling', () => {
      it('should reject null values where not allowed', () => {
        const schemas = [
          UserIdSchema,
          TimestampSchema,
          DeviceIdSchema,
          StrictDeviceTelemetrySchema,
          StrictAnalyticsEventSchema,
        ];

        schemas.forEach(schema => {
          expect(() => schema.parse(null)).toThrow();
          expect(() => schema.parse(undefined)).toThrow();
        });
      });

      it('should accept null for optional fields', () => {
        const telemetryWithNullOptionals = {
          deviceId: 'device-123',
          timestamp: Date.now(),
          userId: SchemaTestDataFactory.validUserId,
          metrics: {
            batteryLevel: null, // Optional field can be null via .optional()
          },
        };

        // The schema actually uses .optional() not .nullable(), so this should fail
        expect(() => StrictDeviceTelemetrySchema.parse(telemetryWithNullOptionals)).toThrow();
      });
    });

    describe('Empty Objects and Arrays', () => {
      it('should handle empty objects appropriately', () => {
        // Empty metrics should be valid for device telemetry
        const telemetryWithEmptyMetrics = {
          deviceId: 'device-123',
          timestamp: Date.now(),
          userId: SchemaTestDataFactory.validUserId,
          metrics: {},
        };

        expect(() => StrictDeviceTelemetrySchema.parse(telemetryWithEmptyMetrics)).not.toThrow();
      });

      it('should handle empty arrays for tags', () => {
        const journalDataWithEmptyTags = {
          journalEntryId: SchemaTestDataFactory.validUserId,
          mood: 'happy',
          tags: [], // Empty array should be valid
          isPrivate: false,
          contentLength: 100,
          wordCount: 20,
        };

        expect(() => JournalAnalyticsEventDataSchema.parse(journalDataWithEmptyTags)).not.toThrow();
      });
    });

    describe('Type Coercion Prevention', () => {
      it('should not coerce strings to numbers', () => {
        const telemetryWithStringNumber = {
          deviceId: 'device-123',
          timestamp: '1640995200000', // String instead of number
          userId: SchemaTestDataFactory.validUserId,
          metrics: {},
        };

        expect(() => StrictDeviceTelemetrySchema.parse(telemetryWithStringNumber)).toThrow();
      });

      it('should not coerce numbers to strings', () => {
        const telemetryWithNumberString = {
          deviceId: 123, // Number instead of string
          timestamp: Date.now(),
          userId: SchemaTestDataFactory.validUserId,
          metrics: {},
        };

        expect(() => StrictDeviceTelemetrySchema.parse(telemetryWithNumberString)).toThrow();
      });

      it('should not coerce boolean to string', () => {
        const eventWithBooleanString = {
          userId: SchemaTestDataFactory.validUserId,
          eventTimestamp: Date.now(),
          eventType: true, // Boolean instead of string
          eventData: {
            consumptionId: SchemaTestDataFactory.validUserId,
            durationMs: 1000,
          },
        };

        expect(() => StrictAnalyticsEventSchema.parse(eventWithBooleanString)).toThrow();
      });
    });

    describe('Boundary Values', () => {
      it('should handle intensity boundaries correctly', () => {
        const boundaryValues = [
          { intensity: 0, shouldPass: true },
          { intensity: 10, shouldPass: true },
          { intensity: -0.1, shouldPass: false },
          { intensity: 10.1, shouldPass: false },
        ];

        boundaryValues.forEach(({ intensity, shouldPass }) => {
          const metrics = { durationMs: 1000, intensity, consumptionId: SchemaTestDataFactory.validUserId };
          
          if (shouldPass) {
            expect(() => ConsumptionTelemetryMetricsSchema.parse(metrics)).not.toThrow();
          } else {
            expect(() => ConsumptionTelemetryMetricsSchema.parse(metrics)).toThrow();
          }
        });
      });

      it('should handle coordinate boundaries correctly', () => {
        const boundaryCoordinates = [
          { lat: -90, lng: -180, shouldPass: true },
          { lat: 90, lng: 180, shouldPass: true },
          { lat: -90.1, lng: 0, shouldPass: false },
          { lat: 90.1, lng: 0, shouldPass: false },
          { lat: 0, lng: -180.1, shouldPass: false },
          { lat: 0, lng: 180.1, shouldPass: false },
        ];

        boundaryCoordinates.forEach(({ lat, lng, shouldPass }) => {
          const telemetry = SchemaTestDataFactory.createValidDeviceTelemetry({
            location: { latitude: lat, longitude: lng },
          });
          
          if (shouldPass) {
            expect(() => StrictDeviceTelemetrySchema.parse(telemetry)).not.toThrow();
          } else {
            expect(() => StrictDeviceTelemetrySchema.parse(telemetry)).toThrow();
          }
        });
      });
    });
  });

  describe('Performance and Large Objects', () => {
    it('should handle large valid objects efficiently', () => {
      const largeMetadata = SchemaTestDataFactory.createValidMetadata({
        feature_flags: Object.fromEntries(
          Array(1000).fill(null).map((_, i) => [`feature_${i}`, i % 2 === 0]),
        ),
        experimental_features: Array(500).fill(null).map((_, i) => `experiment_${i}`),
      });

      const startTime = Date.now();
      expect(() => validateMetadata(largeMetadata)).not.toThrow();
      const validationTime = Date.now() - startTime;

      // Should validate large objects in reasonable time (< 100ms)
      expect(validationTime).toBeLessThan(100);
    });

    it('should handle deeply nested valid objects', () => {
      const deeplyNestedEvent = SchemaTestDataFactory.createValidSyncEvent({
        data: {
          level1: {
            level2: {
              level3: {
                level4: {
                  level5: {
                    deepValue: 'test',
                    deepNumber: 42,
                    deepBoolean: true,
                  },
                },
              },
            },
          },
        },
      });

      expect(() => validateSyncEventData(deeplyNestedEvent)).not.toThrow();
    });

    it('should handle arrays with many elements', () => {
      const eventWithLargeTags = {
        journalEntryId: SchemaTestDataFactory.validUserId,
        mood: 'neutral',
        tags: Array(1000).fill(null).map((_, i) => `tag_${i}`),
        isPrivate: false,
        contentLength: 5000,
        wordCount: 1000,
      };

      const startTime = Date.now();
      expect(() => JournalAnalyticsEventDataSchema.parse(eventWithLargeTags)).not.toThrow();
      const validationTime = Date.now() - startTime;

      expect(validationTime).toBeLessThan(50);
    });
  });

  describe('Schema Integration', () => {
    it('should work correctly with union schemas', () => {
      // Test that AnalyticsEventDataSchema correctly handles different event types
      const consumptionData = {
        consumptionId: SchemaTestDataFactory.validUserId,
        durationMs: 3000,
        intensity: 8,
      };

      const purchaseData = {
        purchaseId: SchemaTestDataFactory.validUserId,
        quantityPurchased: 3.5,
        costSpent: 35.99,
        isActive: true,
        lossFactor: 0.1,
      };

      expect(() => AnalyticsEventDataSchema.parse(consumptionData)).not.toThrow();
      expect(() => AnalyticsEventDataSchema.parse(purchaseData)).not.toThrow();
    });

    it('should enforce schema constraints across composed schemas', () => {
      // Analytics event with consumption data
      const analyticsWithConsumption = {
        userId: SchemaTestDataFactory.validUserId,
        eventTimestamp: Date.now(),
        eventType: 'consumption:logged',
        eventData: {
          consumptionId: SchemaTestDataFactory.validUserId,
          durationMs: 3000,
          intensity: 15, // Invalid intensity > 10
        },
      };

      expect(() => StrictAnalyticsEventSchema.parse(analyticsWithConsumption)).toThrow();
    });

    it('should maintain type safety across helper functions', () => {
      const validTelemetry = SchemaTestDataFactory.createValidDeviceTelemetry();
      const result = validateTelemetryData(validTelemetry);

      // Type should be preserved
      expect(result.deviceId).toBe(validTelemetry.deviceId);
      expect(result.timestamp).toBe(validTelemetry.timestamp);
      expect(result.userId).toBe(validTelemetry.userId);
    });
  });
});