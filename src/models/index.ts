/**
 * Database Models and Types
 * Central export for all database models and types
 * 
 * NOTE: Direct Prisma client access is deprecated.
 * Use repositories via RepositoryFactory instead.
 */

import { z } from 'zod';
import {
  JournalReactionsSchema,
  JournalEntrySchema,
  CreateJournalEntrySchema,
  UpdateJournalEntrySchema,
  CreateJournalEffectSchema,
} from '@shared/contracts';
import { AppError, ErrorCodes } from '../utils/AppError';
import { LoggerService } from '../services/logger.service';

// Export all model types from Prisma (types only, not the client)
export * from '@prisma/client';

// Validation Schemas
export const CreateUserSchema = z.object({
  email: z.string().email().optional(),
  phoneNumber: z.string().optional(),
  password: z.string().min(8),
  name: z.string().min(2).max(100),
  wellnessPreferences: z.string().optional(),
});

// User Preference Schemas
export const UserPrivacySettingsSchema = z.object({
  allowAnalytics: z.boolean().optional(),
  shareUsageData: z.boolean().optional(),
  marketingEmails: z.boolean().optional(),
  dataRetentionPeriod: z.number().int().min(0).optional(),
}).strict();

/**
 * Health-specific privacy settings schema.
 *
 * PHASE 6 ADDITION: Server-side privacy gating for health data.
 * These settings control what health data can be uploaded and processed.
 *
 * If not present in user's privacy settings, defaults to "allowed" for backward compatibility.
 */
export const HealthPrivacySettingsSchema = z.object({
  /** Whether health data upload is allowed. Default: true */
  allowHealthDataUpload: z.boolean().optional().default(true),

  /** Metric codes that are blocked from upload. Default: [] */
  blockedMetrics: z.array(z.string()).optional().default([]),

  /** Whether aggregation of health data is allowed. Default: true */
  allowAggregation: z.boolean().optional().default(true),
}).strict();

export type HealthPrivacySettings = z.infer<typeof HealthPrivacySettingsSchema>;

/**
 * Extended user privacy settings that includes health-specific settings.
 *
 * This schema is for parsing the full privacy settings JSON that may include
 * both general privacy settings and health privacy settings.
 */
export const ExtendedUserPrivacySettingsSchema = z.object({
  // General privacy settings
  allowAnalytics: z.boolean().optional(),
  shareUsageData: z.boolean().optional(),
  marketingEmails: z.boolean().optional(),
  dataRetentionPeriod: z.number().int().min(0).optional(),

  // Health privacy settings (nested under 'health' key)
  health: HealthPrivacySettingsSchema.optional(),
}).passthrough(); // Allow other fields for forward compatibility

export type ExtendedUserPrivacySettings = z.infer<typeof ExtendedUserPrivacySettingsSchema>;

export const UserNotificationSettingsSchema = z.object({
  pushNotifications: z.boolean().optional(),
  emailNotifications: z.boolean().optional(),
  achievementAlerts: z.boolean().optional(),
  goalReminders: z.boolean().optional(),
}).strict();

const OptionalDateOfBirthSchema = z.union([
  z.string().date().transform((value) => new Date(value)),
  z.date(),
  z.null(),
]).optional();

export const UpdateUserSchema = z.object({
  username: z.string().min(1).max(50).optional(),
  name: z.string().min(2).max(100).optional(),
  dateOfBirth: OptionalDateOfBirthSchema,
  wellnessPreferences: z.string().optional(),
  avatarUrl: z.string().url().optional().nullable(),
  userType: z.enum(['CONSUMER', 'MEDICAL', 'RESEARCHER', 'ADMIN']).optional(),
  privacySettings: UserPrivacySettingsSchema.optional(),
  notificationSettings: UserNotificationSettingsSchema.optional(),
});

export const CreateConsumptionDtoSchema = z.object({
  clientConsumptionId: z.string().min(1).max(100), // REQUIRED: Client-generated idempotency key for dedup (replay safety)
  deviceId: z.string().nullish(),
  sessionId: z.string().uuid().nullish(),
  productId: z.string().uuid().nullish(),
  purchaseId: z.string().uuid().nullish(),
  clientPurchaseId: z.string().nullish(),
  timestamp: z.string().datetime(), // ISO 8601 format
  durationMs: z.number().int().min(1),
  intensity: z.number().min(0).max(10).optional(),
  quantity: z.string().regex(/^-?\d+(\.\d+)?$/).nullish(),
  dosageMg: z.string().regex(/^-?\d+(\.\d+)?$/).nullish(),
  isJournaled: z.boolean().optional(),
  notes: z.string().max(2000).optional(),
}).strict();

// Keep legacy name for backward compatibility during transition
export const CreateConsumptionSchema = CreateConsumptionDtoSchema;

export const UpdateConsumptionDtoSchema = z.object({
  sessionId: z.string().uuid().nullish(),
  productId: z.string().uuid().nullish(),
  purchaseId: z.string().uuid().nullish(),
  deviceId: z.string().nullish(),
  timestamp: z.string().datetime().optional(),
  durationMs: z.number().int().min(1).optional(),
  intensity: z.number().min(0).max(10).optional(),
  quantity: z.string().regex(/^-?\d+(\.\d+)?$/).nullish(),
  dosageMg: z.string().regex(/^-?\d+(\.\d+)?$/).nullish(),
  isJournaled: z.boolean().optional(),
  notes: z.string().max(2000).nullish(),
  lastKnownUpdatedAt: z.string().datetime().optional(), // For conflict detection
}).strict();

// Keep legacy name for backward compatibility during transition
export const UpdateConsumptionSchema = UpdateConsumptionDtoSchema;

export const ConsumptionResponseSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  sessionId: z.string().uuid().nullable().optional(),
  productId: z.string().uuid().nullable().optional(),
  purchaseId: z.string().uuid().nullable().optional(),
  deviceId: z.string().nullable().optional(),
  clientConsumptionId: z.string().nullable().optional(),
  clientPurchaseId: z.string().nullable().optional(), // For resolving offline purchase links
  timestamp: z.string().datetime(),
  durationMs: z.number().int().min(1),
  intensity: z.number().min(0).max(10).nullable().optional(),
  isJournaled: z.boolean(),
  notes: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

// Domain DTO for product creation — aligned with Prisma Product model and API schema.
// Max lengths match API schema (200 name, 2000 description) to prevent validation mismatch.
export const CreateProductSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(['OTHER']),
  category: z.string().max(100).optional(),
  primaryCompound: z.number().min(0).max(100).optional(),
  secondaryCompound: z.number().min(0).max(100).optional(),
  compounds: z.record(z.unknown()).optional(),
  description: z.string().max(2000).optional(),
  effects: z.array(z.string()).optional(),
  medicalUses: z.array(z.string()).optional(),
  variantCategory: z.enum(['TYPE_A', 'TYPE_B', 'BLENDED', 'UNKNOWN']).optional(),
  typeBPercentage: z.number().min(0).max(100).optional(),
  typeAPercentage: z.number().min(0).max(100).optional(),
  genetics: z.string().max(200).optional(),
  isPublic: z.boolean().optional(),
  clientProductId: z.string().uuid().nullish(),
  version: z.number().int().positive().optional().default(1),
});

export const UpdateProductSchema = CreateProductSchema.omit({ version: true }).partial();

// Product Review Schemas
export const CreateProductReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  title: z.string().min(1).max(200).optional(),
  comment: z.string().min(1).max(1000).optional(),
});

export const UpdateProductReviewSchema = z.object({
  rating: z.number().int().min(1).max(5).optional(),
  title: z.string().min(1).max(200).optional(),
  comment: z.string().min(1).max(1000).optional(),
});

export const CreatePurchaseSchema = z.object({
  clientPurchaseId: z.string().min(1).max(100), // REQUIRED: Client-generated idempotency key for dedup (replay safety)
  purchaseDate: z.string().datetime().optional(), // Defaults to now() on server
  quantityPurchased: z.string().regex(/^\d+(\.\d{1,3})?$/, 'quantity bought must be a valid decimal string'), // Decimal @db.Decimal(12,3)
  costSpent: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Cost spent must be a valid decimal string'), // Decimal @db.Decimal(12,2)
  productId: z.string().uuid(), // REQUIRED: All purchases must link to a product
  pricePerUnit: z.string().regex(/^\d+(\.\d{1,4})?$/, 'Price per unit must be a valid decimal string').optional(), // Decimal @db.Decimal(12,4)
  lossFactor: z.string().regex(/^\d+(\.\d{1,3})?$/, 'Loss factor must be a valid decimal string').optional(), // Decimal @db.Decimal(5,3), defaults to 1.275 on server
}).strict();

export const UpdatePurchaseSchema = z.object({
  purchaseDate: z.string().datetime().optional(),
  quantityPurchased: z.string().regex(/^\d+(\.\d{1,3})?$/, 'quantity bought must be a valid decimal string').optional(), // Decimal @db.Decimal(12,3)
  costSpent: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Cost spent must be a valid decimal string').optional(), // Decimal @db.Decimal(12,2)
  productId: z.string().uuid().optional(),
  pricePerUnit: z.string().regex(/^\d+(\.\d{1,4})?$/, 'Price per unit must be a valid decimal string').optional(), // Decimal @db.Decimal(12,4)
  lossFactor: z.string().regex(/^(0?\.\d{1,3}|[1-9]\d*\.\d{1,3})$/, 'Loss factor must be a valid decimal string').optional(), // Decimal @db.Decimal(5,3)
  lastKnownUpdatedAt: z.string().datetime().optional(), // For optimistic concurrency
});

/**
 * Schema for POST /purchases/:id/finish request body.
 * Backward compatible: empty body (or no body) is valid — finishedDate defaults to now().
 * Uses .strict() to reject unknown fields.
 */
export const FinishPurchaseBodySchema = z.object({
  finishedDate: z.string().datetime('finishedDate must be a valid ISO 8601 datetime').optional(),
}).strict();

/**
 * Schema for POST /purchases/:id/append request body.
 * Appends additional quantity + cost to an existing active purchase.
 * Uses .strict() to reject unknown fields.
 * clientAppendId provides idempotency for append operations.
 */
export const AppendPurchaseSchema = z.object({
  clientAppendId: z.string().min(1).max(100), // REQUIRED: Client-generated idempotency key for append dedup
  quantityPurchased: z.string().regex(/^\d+(\.\d{1,3})?$/, 'quantity bought must be a valid decimal string'), // Decimal @db.Decimal(12,3) — additional quantity to add
  costSpent: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Cost spent must be a valid decimal string'), // Decimal @db.Decimal(12,2) — additional cost to add
}).strict();

/**
 * Schema for POST /purchases/:id/end-and-create request body.
 * Atomically finishes an existing purchase and creates a new one in a single transaction.
 * The existing purchase ID comes from the URL path parameter.
 * Uses .strict() to reject unknown fields.
 */
/**
 * Schema for POST /purchases/:id/end-and-create request body.
 * Atomically finishes the purchase identified by :id and creates a new purchase.
 *
 * Uses .strict() to reject unknown fields per codebase convention.
 * The clientPurchaseId is REQUIRED for idempotency of the entire compound operation.
 * finishedDate is optional (defaults to now() on server, matching finishPurchase behavior).
 */
export const EndAndCreatePurchaseSchema = z.object({
  // --- Finish parameters (for the old purchase being ended) ---
  finishedDate: z.string().datetime('finishedDate must be a valid ISO 8601 datetime').optional(),

  // --- Create parameters (for the new purchase being created) ---
  clientPurchaseId: z.string().min(1).max(100), // REQUIRED: Idempotency key for the new purchase
  purchaseDate: z.string().datetime().optional(), // Defaults to now() on server
  quantityPurchased: z.string().regex(/^\d+(\.\d{1,3})?$/, 'quantity bought must be a valid decimal string'),
  costSpent: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Cost spent must be a valid decimal string'),
  productId: z.string().uuid(), // REQUIRED: Product for the new purchase
  pricePerUnit: z.string().regex(/^\d+(\.\d{1,4})?$/, 'Price per unit must be a valid decimal string').optional(),
  lossFactor: z.string().regex(/^\d+(\.\d{1,3})?$/, 'Loss factor must be a valid decimal string').optional(),
}).strict();

export const PurchaseResponseSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  purchaseDate: z.string().datetime(),
  quantityPurchased: z.string(), // Decimal string @db.Decimal(12,3)
  costSpent: z.string(), // Decimal string @db.Decimal(12,2)
  productId: z.string().uuid(),
  isActive: z.boolean(),
  finishedDate: z.string().datetime().nullable().optional(),
  pricePerUnit: z.string().nullable().optional(), // Decimal string @db.Decimal(12,4)
  lossFactor: z.string().nullable().optional(), // Decimal string @db.Decimal(5,3)
  clientPurchaseId: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

// Journal schemas now sourced from shared contracts to avoid drift
export {
  JournalReactionsSchema,
  JournalEntrySchema,
  CreateJournalEntrySchema,
  UpdateJournalEntrySchema,
  CreateJournalEffectSchema,
};

// Session Status - Matches Prisma SessionStatus enum
export const SessionStatusSchema = z.enum(['ACTIVE', 'COMPLETED', 'PAUSED', 'CANCELLED']);

// Session Schemas - Following the final recommended schema
export const CreateSessionSchema = z.object({
  id: z.string().uuid().optional(), // optional if client pre-allocates
  clientSessionId: z.string().min(1).optional(), // strongly recommended for idempotency
  deviceId: z.string().optional(),
  purchaseId: z.string().uuid().optional(),
  primaryProductId: z.string().uuid().nullable().optional(), // Primary product for analytics
  sessionStartTimestamp: z.string().datetime(), // required
  sessionEndTimestamp: z.string().datetime().nullable().optional(), // nullable for active sessions
  eventCount: z.number().int().min(0).optional(),
  // Client may send; server will recompute/validate on write:
  totalDurationMs: z.number().int().min(0).optional(),
  avgEventDurationMs: z.number().min(0).optional(),
  sessionTypeHeuristic: z.string().optional(),
  observationFeature: z.number().optional(),
  // Session status for local-first sync
  status: SessionStatusSchema.optional(), // defaults to 'ACTIVE' in Prisma
  // User-provided notes (synced from local-first app)
  notes: z.string().max(2000).nullable().optional(),
});

export const UpdateSessionSchema = z.object({
  purchaseId: z.string().uuid().nullable().optional(),
  deviceId: z.string().nullable().optional(),
  primaryProductId: z.string().uuid().nullable().optional(),
  sessionStartTimestamp: z.string().datetime().optional(),
  sessionEndTimestamp: z.string().datetime().nullable().optional(), // nullable for active sessions
  eventCount: z.number().int().min(0).optional(),
  totalDurationMs: z.number().int().min(0).optional(),
  avgEventDurationMs: z.number().min(0).optional(),
  sessionTypeHeuristic: z.string().nullable().optional(),
  observationFeature: z.number().nullable().optional(),
  // Session status for local-first sync
  status: SessionStatusSchema.optional(),
  // User-provided notes (synced from local-first app)
  notes: z.string().max(2000).nullable().optional(),
  // Optional optimistic concurrency (recommended):
  lastKnownUpdatedAt: z.string().datetime().optional(),
});

export const SessionResponseSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  purchaseId: z.string().uuid().nullable().optional(),
  deviceId: z.string().nullable().optional(),
  clientSessionId: z.string().nullable().optional(),
  primaryProductId: z.string().uuid().nullable().optional(),
  sessionStartTimestamp: z.string().datetime(),
  sessionEndTimestamp: z.string().datetime().nullable(), // nullable for active sessions
  eventCount: z.number().int().min(0),
  totalDurationMs: z.number().int().min(0),
  avgEventDurationMs: z.number().min(0),
  sessionTypeHeuristic: z.string().nullable().optional(),
  observationFeature: z.number().nullable().optional(),
  status: SessionStatusSchema, // Session status
  notes: z.string().nullable().optional(), // User-provided notes
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const SyncPushSchema = z.object({
  lastSyncAt: z.string().datetime().optional(),
  data: z.object({
    consumptions: z.array(CreateConsumptionSchema).optional(),
    purchases: z.array(CreatePurchaseSchema).optional(),
    products: z.array(CreateProductSchema).optional(),
  }),
  dataHash: z.string().optional(),
});

export const SyncPullSchema = z.object({
  lastSyncAt: z.string().datetime().optional(),
  includeDeleted: z.boolean().optional(),
});

// DailyStat Analytics Schemas - Server-authoritative financial calculations
export const DailyStatQuerySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
  timezone: z.string().optional(),
  includeProjections: z.boolean().optional(),
});

export const DailyStatResponseSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'), // User's local date
  userId: z.string().uuid(),
  quantityUsed: z.string(), // Decimal string @db.Decimal(12,3) - Server-computed: Σ(eventQuantity)
  events: z.number().int().nonnegative(),
  costSpentActual: z.string(), // Decimal string @db.Decimal(12,2) - Server-computed: Σ(eventQuantity * pricePerUnit)
  costSpentBaseline: z.string(), // Decimal string @db.Decimal(12,2)
  costSavedDirect: z.string(), // Decimal string @db.Decimal(12,2)
  costSavedWaste: z.string(), // Decimal string @db.Decimal(12,2)
  costSavedTotal: z.string(), // Decimal string @db.Decimal(12,2)
  sessions: z.number().int().nonnegative(),
  avgSessionDuration: z.number().nonnegative().nullable().optional(), // Duration in milliseconds (integer)
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const DailyStatRecomputeSchema = z.object({
  userId: z.string().uuid().optional(), // If provided, recompute for specific user
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format').optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format').optional(),
  force: z.boolean().optional(), // Force recomputation even if stats exist
});

// Response Types
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  totalPages?: number;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  metadata?: {
    timestamp: string;
    requestId: string;
  };
}

// Analytics Types
export interface AnalyticsSummary {
  userId: string;
  period: {
    start: Date;
    end: Date;
  };
  totalConsumptions: number;
  totalDuration: number;
  averageDuration: number;
  totalCost: number;
  totalQuantity: number;
  averageIntensity: number;
  topProducts: Array<{
    productId: string;
    productName: string;
    count: number;
    percentage: number;
  }>;
  dailyAverage: number;
  weeklyPattern: Array<{
    dayOfWeek: number;
    average: number;
  }>;
}

export interface TrendData {
  date: string;
  value: number;
  change: number;
  changePercentage: number;
}

export interface ConsumptionTrends {
  daily: TrendData[];
  weekly: TrendData[];
  monthly: TrendData[];
  predictions: {
    nextDay: number;
    nextWeek: number;
    confidence: number;
  };
}

export interface CostSavings {
  period: {
    start: Date;
    end: Date;
  };
  totalActualSpent: number;
  totalBaselineSpent: number;
  totalDirectSavings: number;
  totalWasteSavings: number;
  totalSavings: number;
  savingsPercentage: number;
  dailySavings: Array<{
    date: Date;
    saved: number;
    spent: number;
    baseline: number;
  }>;
  averageDailySavings: number;
  projectedMonthlySavings: number;
  projectedYearlySavings: number;
}

// Sync Types
export interface SyncConflict {
  type: 'consumption' | 'purchase' | 'product';
  localData: Record<string, unknown>;
  remoteData: Record<string, unknown>;
  resolution?: 'local' | 'remote' | 'merge';
}

export interface SyncResult {
  success: boolean;
  syncedItems: {
    consumptions: number;
    purchases: number;
    products: number;
  };
  conflicts: SyncConflict[];
  lastSyncAt: Date;
}

// WebSocket Event Types
export interface RealtimeEvent {
  type: 'consumption' | 'purchase' | 'product' | 'sync' | 'notification' | 'goal' | 'achievement';
  action: 'created' | 'updated' | 'deleted' | 'completed' | 'unlocked';
  data: Record<string, unknown>;
  userId: string;
  timestamp: Date;
}

// Goal Data Transfer Objects
export interface CreateGoalData {
  type: 'USAGE_REDUCTION' | 'COST_SAVINGS' | 'SESSION_FREQUENCY' | 'HABIT_TRACKING' | 'HEALTH_METRIC' | 'CUSTOM';
  name: string;
  description?: string;
  targetValue: number;
  targetDate: Date;
  category?: string;
  metricType?: 'UNITS_PER_DAY' | 'UNITS_PER_WEEK' | 'UNITS_PER_MONTH' | 'SESSIONS_PER_DAY' | 'SESSIONS_PER_WEEK' | 'COST_PER_DAY' | 'COST_PER_WEEK' | 'COST_PER_MONTH' | 'DURATION_PER_SESSION' | 'CUSTOM_NUMERIC';
  reminderEnabled?: boolean;
  reminderFrequency?: string | null;
  metadata?: Record<string, unknown>;
}

export interface UpdateGoalData {
  type?: 'USAGE_REDUCTION' | 'COST_SAVINGS' | 'SESSION_FREQUENCY' | 'HABIT_TRACKING' | 'HEALTH_METRIC' | 'CUSTOM';
  name?: string;
  description?: string;
  targetValue?: number;
  currentValue?: number;
  targetDate?: Date;
  status?: 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'FAILED' | 'ARCHIVED';
  category?: string;
  metricType?: 'UNITS_PER_DAY' | 'UNITS_PER_WEEK' | 'UNITS_PER_MONTH' | 'SESSIONS_PER_DAY' | 'SESSIONS_PER_WEEK' | 'COST_PER_DAY' | 'COST_PER_WEEK' | 'COST_PER_MONTH' | 'DURATION_PER_SESSION' | 'CUSTOM_NUMERIC';
  reminderEnabled?: boolean;
  reminderFrequency?: string | null;
  metadata?: Record<string, unknown>;
}

// Goal Progress Interface
export interface GoalProgress {
  goalId: string;
  currentValue: number;
  targetValue: number;
  percentComplete: number;
  daysRemaining?: number;
  trend: 'improving' | 'stable' | 'declining';
  milestones?: Array<{
    value: number;
    completed: boolean;
    completedAt?: Date;
  }>;
  lastUpdated: Date;
}

// Achievement Progress Interface
export interface AchievementProgress {
  userId: string;
  total: number;
  earned: number;
  percentComplete: number;
  totalPoints: number;
  recentlyEarned: Array<{
    id: string;
    achievementId: string;
    name: string;
    description: string;
    points: number;
    rarity: string;
    earnedAt: Date;
  }>;
  nextToUnlock: Array<{
    id: string;
    name: string;
    description: string;
    progress: number;
    maxProgress: number;
    percentComplete: number;
  }>;
}

// DynamoDB Time-Series Data Models
export interface DeviceTelemetryRecord {
  deviceId: string;       // Partition Key (PK)
  timestamp: number;      // Sort Key (SK) - Unix timestamp in milliseconds
  userId: string;         // GSI1PK
  sessionId?: string;

  // Device Metadata (from Prisma Device schema)
  deviceName?: string;
  deviceType?: string;
  brand?: string;
  model?: string;
  serialNumber?: string;
  macAddress?: string;
  firmwareVersion?: string;
  hardwareVersion?: string;
  batteryLevel?: number;  // 0-100 percentage
  lastSeen?: number;      // Unix timestamp in milliseconds
  status?: 'UNPAIRED' | 'PAIRED' | 'ACTIVE' | 'INACTIVE' | 'ERROR';

  // Telemetry Metrics
  metrics: {
    // Core telemetry data
    temperature?: number;
    humidity?: number;
    pressure?: number;
    powerState?: 'on' | 'off' | 'standby';
    heatingElementTemp?: number;
    waterLevel?: number;
    airflowRate?: number;

    // Consumption-specific metrics
    durationMs?: number;
    intensity?: number;     // 0-10 scale
    consumptionId?: string;
    productId?: string;

    // Session-specific metrics
    eventType?: 'session:start' | 'session:end' | 'session:pause' | 'session:resume';
    sessionType?: string;
    purchaseId?: string;
    expectedDurationMs?: number;
    actualDurationMs?: number;
    eventCount?: number;

    // Generic device metrics
    signalStrength?: number;
    errorCode?: string;
    calibrationStatus?: 'calibrated' | 'needs_calibration' | 'calibrating' | 'error';

    // Allow additional custom metrics
    [key: string]: number | string | boolean | undefined;
  };

  location?: { latitude: number; longitude: number; };

  // TTL for automatic data expiration (Unix timestamp in seconds)
  ttl?: number;

  // Metadata
  createdAt: number;      // Unix timestamp in milliseconds for consistency
}

export interface AnalyticsEventRecord {
  userId: string;         // PK
  eventTimestamp: number; // SK - Unix timestamp in milliseconds
  eventType: string;      // GSI1PK - Analytics event type

  // Event Data (strongly typed based on event type)
  eventData: {
    // Journal Analytics Events
    journalEntryId?: string;
    mood?: string;
    tags?: string[];
    isPrivate?: boolean;
    contentLength?: number;
    wordCount?: number;
    sentiment?: 'positive' | 'neutral' | 'negative';
    topicCategories?: string[];

    // Purchase Analytics Events
    purchaseId?: string;
    quantityPurchased?: string;    // Decimal string for precision
    costSpent?: string;      // Decimal string for precision (Decimal(12,2))
    pricePerUnit?: string;   // Decimal string for precision (Decimal(12,4))
    isActive?: boolean;
    lossFactor?: string;    // Decimal string for precision (Decimal(5,3))
    purchaseChannel?: 'retailer' | 'delivery' | 'online' | 'other';
    paymentMethod?: 'cash' | 'card' | 'crypto' | 'other';

    // Inventory Analytics Events
    inventoryId?: string;
    quantity?: string;       // Decimal string for precision
    unit?: string;
    costPerUnit?: string;    // Decimal string for precision
    inventoryTotalCost?: string;      // Decimal string for precision
    location?: string;
    isNewProduct?: boolean;
    adjustmentType?: 'ADD' | 'REMOVE' | 'CONSUME' | 'EXPIRE' | 'ADJUST' | 'TRANSFER';
    previousQuantity?: string; // Decimal string for precision
    newQuantity?: string;      // Decimal string for precision
    reason?: string;
    isLowStock?: boolean;
    isOutOfStock?: boolean;

    // Consumption Analytics Events
    consumptionId?: string;
    durationMs?: number;
    intensity?: number;      // 0-10 scale
    deviceType?: 'delivery_device' | 'device' | 'device' | 'unit' | 'ingestible' | 'other';
    consumptionMethod?: 'inhalation' | 'ingestion' | 'topical' | 'sublingual';
    notes?: string;

    // Goal Analytics Events
    goalId?: string;
    goalType?: 'REDUCTION' | 'MODERATION' | 'ABSTINENCE' | 'SAVINGS' | 'CUSTOM';
    metricType?: 'CONSUMPTION_COUNT' | 'QUANTITY' | 'FREQUENCY' | 'SPENDING' | 'DAYS';
    targetValue?: string;      // Decimal string for precision
    currentValue?: string;     // Decimal string for precision
    progressPercentage?: number; // 0-100
    status?: 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'FAILED' | 'ARCHIVED';
    daysRemaining?: number;
    streak?: number;

    // Achievement Analytics Events
    achievementId?: string;
    achievementCode?: string;
    category?: 'MILESTONES' | 'STREAK' | 'SAVINGS' | 'USAGE' | 'SOCIAL' | 'SPECIAL' | 'DEVICE' | 'AI' | 'JOURNAL';
    rarity?: 'COMMON' | 'UNCOMMON' | 'RARE' | 'EPIC' | 'LEGENDARY';
    points?: number;
    progress?: number;
    maxProgress?: number;
    isCompleted?: boolean;
    earnedAt?: number;         // Unix timestamp in milliseconds

    // AI Usage Analytics Events
    aiUsageId?: string;
    endpoint?: string;
    requestType?: 'CHAT' | 'VARIANT_MATCH' | 'JOURNAL_ANALYSIS' | 'WEEKLY_REPORT' | 'VARIANT_ANALYSIS' | 'RECOMMENDATION' | 'GENERAL';
    requestId?: string;
    model?: string;
    provider?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    inputCost?: string;        // Decimal string for precision (Decimal(12,6))
    outputCost?: string;       // Decimal string for precision (Decimal(12,6))
    aiTotalCost?: string;        // Decimal string for precision (Decimal(12,6))
    latencyMs?: number;
    cached?: boolean;
    cacheHit?: boolean;
    success?: boolean;
    errorCode?: string;
    errorMessage?: string;

    // Allow additional event-specific data
    [key: string]: unknown;
  };

  correlationId?: string;
  deviceId?: string;
  sessionId?: string;
  productId?: string;         // For product-related events

  // TTL for automatic data expiration (Unix timestamp in seconds)
  ttl?: number;

  // Metadata
  createdAt: number;          // Unix timestamp in milliseconds for consistency
}

// AI Usage Analytics Record (specialized DynamoDB record for AI cost tracking)
export interface AiUsageAnalyticsRecord {
  userId: string;             // PK
  eventTimestamp: number;     // SK - Unix timestamp in milliseconds

  // AI Usage Details
  aiUsageId: string;
  endpoint: string;
  requestType: 'CHAT' | 'VARIANT_MATCH' | 'JOURNAL_ANALYSIS' | 'WEEKLY_REPORT' | 'VARIANT_ANALYSIS' | 'RECOMMENDATION' | 'GENERAL';
  requestId?: string;
  model: string;
  provider: string;

  // Token Usage
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;

  // Cost Information (as decimal strings for precision)
  inputCost: string;          // Decimal(12,6) precision
  outputCost: string;         // Decimal(12,6) precision
  totalCost: string;          // Decimal(12,6) precision

  // Performance Metrics
  latencyMs: number;
  cached: boolean;
  cacheHit: boolean;
  success: boolean;
  errorCode?: string;
  errorMessage?: string;

  // Metadata
  metadata?: {
    userAgent?: string;
    ipAddress?: string;
    sessionId?: string;
    deviceId?: string;
    correlationId?: string;
    [key: string]: unknown;
  };

  // TTL for automatic data expiration (Unix timestamp in seconds)
  ttl?: number;

  // Timestamps
  createdAt: number;          // Unix timestamp in milliseconds
}

// === ADDITIONAL ZOD SCHEMAS FOR JSONB FIELDS ===

// RefreshToken.deviceInfo Schema
export const RefreshTokenDeviceInfoSchema = z.object({
  platform: z.enum(['ios', 'android', 'web']).optional(),
  version: z.string().optional(),
  model: z.string().optional(),
  manufacturer: z.string().optional(),
  appVersion: z.string().optional(),
  buildNumber: z.string().optional(),
  deviceId: z.string().optional(),
  screenSize: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }).optional(),
  timezone: z.string().optional(),
}).strict();

// Device.specifications Schema
export const DeviceSpecificationsSchema = z.object({
  // Hardware specifications
  batteryCapacity: z.number().positive().optional(), // mAh
  chargingPower: z.number().positive().optional(), // watts
  connectivity: z.array(z.enum(['BLUETOOTH', 'WIFI', 'USB', 'NFC'])).optional(),
  sensors: z.array(z.enum(['TEMPERATURE', 'PRESSURE', 'HUMIDITY', 'ACCELEROMETER', 'GYROSCOPE'])).optional(),
  operatingTemperature: z.object({
    min: z.number(), // Celsius
    max: z.number(),
  }).optional(),
  dimensions: z.object({
    length: z.number().positive(), // mm
    width: z.number().positive(),
    height: z.number().positive(),
    weight: z.number().positive(), // grams
  }).optional(),
  materials: z.array(z.string()).optional(),
  certifications: z.array(z.string()).optional(), // CE, FCC, etc.
  
  // BLE-specific specifications (populated by BluetoothService.pairDevice)
  // Added Dec 2025 to support BLE device sync from frontend
  bleDeviceInfo: z.object({
    rssi: z.number().nullable().optional(), // Signal strength (dBm), null if unavailable
    mtu: z.number().int().positive().nullable().optional(), // Maximum Transmission Unit
    isConnectable: z.boolean().optional(),
  }).optional(),
  connectionMethod: z.enum(['bluetooth_le', 'bluetooth_classic', 'wifi', 'usb', 'manual']).optional(),
  deviceDiscoveredAt: z.string().datetime().optional(), // ISO 8601 timestamp of first discovery
  
  // Pairing metadata
  pairingData: z.object({
    pairedAt: z.string().datetime().optional(),
    pairingMethod: z.enum(['bluetooth', 'wifi', 'manual']).optional(),
  }).optional(),
  unpairedAt: z.string().datetime().optional(),
}).strict();

// Device.calibrationData Schema
export const DeviceCalibrationDataSchema = z.object({
  temperatureOffset: z.number().optional(), // Celsius offset
  pressureCalibration: z.number().optional(),
  scaleCalibration: z.object({
    offset: z.number(),
    multiplier: z.number().positive(),
  }).optional(),
  lastCalibrationDate: z.string().datetime().optional(),
  calibrationAccuracy: z.number().min(0).max(100).optional(), // percentage
  referenceValues: z.record(z.string(), z.number()).optional(),
  calibratedBy: z.string().optional(), // user ID or system
  calibrationNotes: z.string().max(500).optional(),
  lastCalibration: z.object({
    calibrationType: z.string(),
    timestamp: z.string().datetime(),
    value: z.number(),
    accuracy: z.number().min(0).max(100).optional(),
  }).optional(),
}).passthrough(); // Allow additional dynamic calibration fields

// SyncConflict schemas
export const SyncVersionDataSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().nonnegative(),
  timestamp: z.string().datetime(),
  data: z.record(z.unknown()),
  checksum: z.string().optional(),
}).strict();

export const SyncConflictResolvedDataSchema = z.object({
  resolution: z.enum(['LOCAL_WINS', 'SERVER_WINS', 'MERGE', 'MANUAL']),
  mergedData: z.record(z.unknown()).optional(),
  resolvedBy: z.string().uuid().optional(), // user ID
  resolutionNotes: z.string().max(1000).optional(),
  timestamp: z.string().datetime(),
}).strict();

// SyncChange.changeData Schema
export const SyncChangeDataSchema = z.object({
  operation: z.enum(['CREATE', 'UPDATE', 'DELETE']),
  entityType: z.string(),
  entityId: z.string().uuid(),
  changes: z.record(z.unknown()),
  previousValues: z.record(z.unknown()).optional(),
  metadata: z.object({
    source: z.enum(['mobile', 'web', 'api', 'system']),
    deviceId: z.string().optional(),
    timestamp: z.string().datetime(),
    userAgent: z.string().optional(),
  }).optional(),
}).strict();

// OutboxEvent.payload Schema
export const OutboxEventPayloadSchema = z.object({
  eventType: z.string(),
  aggregateId: z.string().uuid(),
  aggregateType: z.string(),
  version: z.number().int().nonnegative(),
  data: z.record(z.unknown()),
  metadata: z.object({
    userId: z.string().uuid().optional(),
    correlationId: z.string().uuid().optional(),
    causationId: z.string().uuid().optional(),
    timestamp: z.string().datetime(),
  }),
}).strict();

// SyncState.metadata Schema
export const SyncStateMetadataSchema = z.object({
  lastSyncToken: z.string().optional(),
  deviceFingerprint: z.string().optional(),
  syncStrategy: z.enum(['INCREMENTAL', 'FULL', 'DELTA']).optional(),
  compressionEnabled: z.boolean().optional(),
  encryptionEnabled: z.boolean().optional(),
  failureCount: z.number().int().nonnegative().optional(),
  lastFailureReason: z.string().optional(),
  syncStatistics: z.object({
    itemsReceived: z.number().int().nonnegative().optional(),
    itemsSent: z.number().int().nonnegative().optional(),
    bytesTransferred: z.number().int().nonnegative().optional(),
    duration: z.number().int().positive().optional(),
  }).optional(),
}).strict();

// Additional schemas for JSONB field validation
export const WeeklyPatternSchema = z.record(z.string(), z.number().nonnegative());

export const ConsumptionProductEffectsSchema = z.object({
  consumption: z.object({
    product: z.object({
      effects: EffectsArraySchema.optional(),
    }).optional(),
  }).optional(),
}).optional();

export const JournalEffectsSchema = z.array(z.string()).max(10);

export const InventoryAdjustmentMetadataSchema = z.object({
  reason: z.string().optional(),
  adjustedBy: z.string().optional(),
  notes: z.string().optional(),
  previousValue: z.number().optional(),
  systemGenerated: z.boolean().optional(),
}).passthrough();

// Import strict DynamoDB schemas (replaces loose z.any() validations)
import {
  MetadataSchema,
} from './dynamodb-schemas';

export {
  StrictDeviceTelemetrySchema as CreateDeviceTelemetrySchema,
  StrictAnalyticsEventSchema as CreateAnalyticsEventSchema,
  validateTelemetryData,
  validateAnalyticsEventData,
  validateWebSocketEventData,
  validateSyncEventData,
  validateMetadata,
  // Export specific schemas for use in services
  ConsumptionTelemetryMetricsSchema,
  SessionTelemetryMetricsSchema,
  JournalAnalyticsEventDataSchema,
  PurchaseAnalyticsEventDataSchema,
  InventoryAnalyticsEventDataSchema,
  ConsumptionAnalyticsEventDataSchema,
  GoalAnalyticsEventDataSchema,
  AchievementAnalyticsEventDataSchema,
  WebSocketEventDataSchema,
  SyncEventDataSchema,
  MetadataSchema,
} from './dynamodb-schemas';

// Enhanced Goal Schemas for Phase 3
export const CreateGoalSchema = z.object({
  type: z.enum(['REDUCTION', 'MODERATION', 'ABSTINENCE', 'SAVINGS', 'CUSTOM']),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  targetValue: z.number().positive(),
  targetDate: z.string().datetime(),
  startDate: z.string().datetime().optional(),
  category: z.string().max(100).optional(),
  metricType: z.enum(['CONSUMPTION_COUNT', 'QUANTITY', 'FREQUENCY', 'SPENDING', 'DAYS']).optional(),
  milestoneValues: GoalMilestoneValuesSchema.optional(),
  reminderEnabled: z.boolean().optional(),
  reminderFrequency: z.number().int().positive().optional(),
  metadata: MetadataSchema.optional(),
});

export const UpdateGoalSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  targetValue: z.number().positive().optional(),
  targetDate: z.string().datetime().optional(),
  currentValue: z.number().nonnegative().optional(),
  status: z.enum(['ACTIVE', 'PAUSED', 'COMPLETED', 'FAILED', 'ARCHIVED']).optional(),
  category: z.string().max(100).optional(),
  metricType: z.enum(['CONSUMPTION_COUNT', 'QUANTITY', 'FREQUENCY', 'SPENDING', 'DAYS']).optional(),
  milestoneValues: GoalMilestoneValuesSchema.optional(),
  progressPercentage: z.number().min(0).max(100).optional(),
  reminderEnabled: z.boolean().optional(),
  reminderFrequency: z.number().int().positive().optional(),
  metadata: MetadataSchema.optional(),
});

// === JSONB VALIDATION HELPER FUNCTIONS ===

/**
 * Validates and safely parses JSONB field data using the appropriate schema
 * Returns validated data or throws AppError with details
 */
export function validateJsonbField<T>(
  data: unknown, 
  schema: z.ZodSchema<T>, 
  fieldName: string,
  entityId?: string,
): T {
  try {
    return schema.parse(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorDetails = error.errors.map(err => 
        `${err.path.join('.')}: ${err.message}`,
      ).join('; ');
      
      throw new AppError(
        400, 
        ErrorCodes.VALIDATION_ERROR,
        `Invalid ${fieldName} data: ${errorDetails}`,
        true,
        { 
          field: fieldName,
          entityId,
          errors: error.errors,
          receivedData: data, 
        },
      );
    }
    throw error;
  }
}

/**
 * Safely parses JSONB field from database with error handling and logging
 * Returns validated data, default value, or throws if required
 */
export function parseJsonbField<T>(
  dbValue: unknown, 
  schema: z.ZodSchema<T>, 
  fieldName: string,
  options: {
    entityId?: string;
    defaultValue?: T;
    required?: boolean;
    logger?: LoggerService;
  } = {},
): T | null {
  const { entityId, defaultValue, required = false, logger } = options;
  
  // Handle null/undefined values
  if (dbValue === null || dbValue === undefined) {
    if (required) {
      throw new AppError(
        500,
        ErrorCodes.DATABASE_ERROR,
        `Required ${fieldName} is missing from database`,
        false,
        { field: fieldName, entityId },
      );
    }
    return defaultValue !== undefined ? defaultValue : null;
  }
  
  try {
    return schema.parse(dbValue);
  } catch (error) {
    const errorMessage = `Corrupted ${fieldName} data found in database`;
    const errorDetails = error instanceof z.ZodError 
      ? error.errors.map(err => `${err.path.join('.')}: ${err.message}`).join('; ')
      : 'Unknown validation error';
    
    if (logger) {
      logger.warn(errorMessage, { 
        field: fieldName, 
        entityId, 
        error: errorDetails,
        receivedData: dbValue, 
      });
    }
    
    if (required) {
      throw new AppError(
        500,
        ErrorCodes.DATABASE_ERROR,
        `${errorMessage}: ${errorDetails}`,
        false,
        { field: fieldName, entityId, receivedData: dbValue },
      );
    }
    
    return defaultValue !== undefined ? defaultValue : null;
  }
}

// InventoryItem Schemas
export const CreateInventoryItemSchema = z.object({
  clientInventoryId: z.string().optional(), // Client-generated ID for sync idempotency
  productId: z.string().uuid(),
  purchaseItemId: z.string().uuid().optional().nullable(),
  quantityRemaining: z.string().regex(/^\d+(\.\d{1,3})?$/, 'Quantity must be a valid decimal string'), // Decimal @db.Decimal(12,3)
  quantityInitial: z.string().regex(/^\d+(\.\d{1,3})?$/, 'Quantity must be a valid decimal string'), // Decimal @db.Decimal(12,3)
  expirationDate: z.string().datetime().optional().nullable(), // @db.Date - date only, no time
  batchNumber: z.string().max(100).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
  isActive: z.boolean().optional(), // Defaults to true
}).strict();

export const UpdateInventoryItemSchema = z.object({
  quantityRemaining: z.string().regex(/^\d+(\.\d{1,3})?$/, 'Quantity must be a valid decimal string').optional(), // Decimal @db.Decimal(12,3)
  quantityInitial: z.string().regex(/^\d+(\.\d{1,3})?$/, 'Quantity must be a valid decimal string').optional(), // Decimal @db.Decimal(12,3)
  expirationDate: z.string().datetime().optional().nullable(),
  batchNumber: z.string().max(100).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
  isActive: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional().nullable(),
}).strict();

// Achievement Master Definition Schemas
export const CreateAchievementSchema = z.object({
  code: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(500),
  category: z.enum(['MILESTONES', 'STREAK', 'SAVINGS', 'USAGE', 'SOCIAL', 'SPECIAL', 'DEVICE', 'AI', 'JOURNAL']).optional(),
  requirementType: z.string().min(1).max(100),
  requirementValue: z.number().nonnegative(),
  requirementDescription: z.string().max(300).optional(),
  points: z.number().int().nonnegative().optional(),
  badgeIcon: z.string().max(100).optional(),
  badgeColor: z.string().regex(/^#[0-9A-F]{6}$/i).optional(), // Hex color
  rarity: z.enum(['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY']).optional(),
  displayOrder: z.number().int().nonnegative().optional(),
  isHidden: z.boolean().optional(),
  isSecret: z.boolean().optional(),
});

export const UpdateAchievementSchema = CreateAchievementSchema.partial();

// User Achievement Progress Schemas  
export const CreateUserAchievementSchema = z.object({
  userId: z.string().uuid(),
  achievementId: z.string().uuid(),
  progress: z.number().nonnegative().optional(),
  maxProgress: z.number().positive().optional(),
  metadata: MetadataSchema.optional(),
});

export const UpdateUserAchievementSchema = z.object({
  progress: z.number().nonnegative().optional(),
  maxProgress: z.number().positive().optional(),
  isCompleted: z.boolean().optional(),
  earnedAt: z.string().datetime().optional(),
  notified: z.boolean().optional(),
  shared: z.boolean().optional(),
  metadata: MetadataSchema.optional(),
});

// User Achievement with Details Interface
export interface UserAchievementWithDetails {
  id: string;
  userId: string;
  achievementId: string;
  progress: number;
  maxProgress: number;
  isCompleted: boolean;
  earnedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  notified: boolean;
  shared: boolean;
  metadata: Record<string, unknown> | null;
  achievement: {
    id: string;
    code: string;
    name: string;
    description: string;
    category: string;
    requirementType: string;
    requirementValue: number;
    requirementDescription: string | null;
    points: number;
    badgeIcon: string | null;
    badgeColor: string | null;
    rarity: string;
    displayOrder: number;
    isHidden: boolean;
    isSecret: boolean;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
  };
}

// Device Schemas
// EC-DEVICE-SYNC-FIELD-001: Field Name Compatibility
// PROBLEM: Frontend sends 'deviceName' but schema expected 'name'.
// This caused sync CREATE to fail with "Invalid device data for sync creation"
// and commands were moved to dead letter queue.
//
// SOLUTION: Accept BOTH 'name' AND 'deviceName' with transform.
// - 'deviceName' takes precedence (frontend convention)
// - 'name' is accepted for backwards compatibility
// - Schema transforms to internal 'name' field for handler
//
// EVIDENCE:
// - Frontend: buildDeviceCreatePayload() sends { deviceName: ... }
// - Backend: CreateDeviceSchema expected { name: ... }
// - Logs: "Invalid device data for sync creation"
const BaseCreateDeviceSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  deviceName: z.string().min(1).max(100).optional(),
  type: z.enum(['BLUETOOTH_SENSOR', 'TEMPERATURE_SENSOR', 'HUMIDITY_SENSOR', 'SCALE', 'SENSOR', 'OTHER']).optional(),
  status: z.enum(['UNPAIRED', 'ACTIVE', 'INACTIVE', 'OFFLINE', 'CALIBRATING', 'ERROR', 'DECOMMISSIONED']).optional(),
  macAddress: z.string().max(17).optional().nullable(), // MAC address format XX:XX:XX:XX:XX:XX
  bluetoothId: z.string().max(100).optional().nullable(),
  serialNumber: z.string().max(100).optional().nullable(),
  brand: z.string().max(100).optional().nullable(),
  model: z.string().max(100).optional().nullable(),
  firmwareVersion: z.string().max(50).optional().nullable(),
  hardwareVersion: z.string().max(50).optional().nullable(),
  isActive: z.boolean().optional(),
  lastSeen: z.string().datetime().optional().nullable(),
  batteryLevel: z.number().min(0).max(100).optional().nullable(),
  requiresCalibration: z.boolean().optional(),
  lastCalibrated: z.string().datetime().optional().nullable(),
  calibrationData: z.record(z.unknown()).optional().nullable(),
  settings: z.record(z.unknown()).optional().nullable(),
  specifications: z.record(z.unknown()).optional().nullable(),
  pairedAt: z.string().datetime().optional().nullable(),
  deviceType: z.string().optional().nullable(), // Legacy field
});

export const CreateDeviceSchema = BaseCreateDeviceSchema
  .refine(
    (data) => data.name || data.deviceName,
    { message: 'Either name or deviceName is required' }
  )
  .transform((data) => ({
    ...data,
    // Normalize: Use deviceName if provided, otherwise fall back to name
    name: data.deviceName || data.name!,
    // Remove deviceName from output to avoid confusion
    deviceName: undefined,
  }))
  // Re-validate after transform to ensure name is present and correctly typed
  .device(z.object({
    name: z.string().min(1).max(100),
    type: z.enum(['BLUETOOTH_SENSOR', 'TEMPERATURE_SENSOR', 'HUMIDITY_SENSOR', 'SCALE', 'SENSOR', 'OTHER']).optional(),
    status: z.enum(['UNPAIRED', 'ACTIVE', 'INACTIVE', 'OFFLINE', 'CALIBRATING', 'ERROR', 'DECOMMISSIONED']).optional(),
    macAddress: z.string().max(17).optional().nullable(),
    bluetoothId: z.string().max(100).optional().nullable(),
    serialNumber: z.string().max(100).optional().nullable(),
    brand: z.string().max(100).optional().nullable(),
    model: z.string().max(100).optional().nullable(),
    firmwareVersion: z.string().max(50).optional().nullable(),
    hardwareVersion: z.string().max(50).optional().nullable(),
    isActive: z.boolean().optional(),
    lastSeen: z.string().datetime().optional().nullable(),
    batteryLevel: z.number().min(0).max(100).optional().nullable(),
    requiresCalibration: z.boolean().optional(),
    lastCalibrated: z.string().datetime().optional().nullable(),
    calibrationData: z.record(z.unknown()).optional().nullable(),
    settings: z.record(z.unknown()).optional().nullable(),
    specifications: z.record(z.unknown()).optional().nullable(),
    pairedAt: z.string().datetime().optional().nullable(),
    deviceType: z.string().optional().nullable(),
  }));

// EC-DEVICE-SYNC-FIELD-001: Accept both 'name' and 'deviceName' for updates
const BaseUpdateDeviceSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  deviceName: z.string().min(1).max(100).optional(),
  type: z.enum(['BLUETOOTH_SENSOR', 'TEMPERATURE_SENSOR', 'HUMIDITY_SENSOR', 'SCALE', 'SENSOR', 'OTHER']).optional(),
  status: z.enum(['UNPAIRED', 'ACTIVE', 'INACTIVE', 'OFFLINE', 'CALIBRATING', 'ERROR', 'DECOMMISSIONED']).optional(),
  macAddress: z.string().max(17).optional().nullable(),
  bluetoothId: z.string().max(100).optional().nullable(),
  serialNumber: z.string().max(100).optional().nullable(),
  brand: z.string().max(100).optional().nullable(),
  model: z.string().max(100).optional().nullable(),
  firmwareVersion: z.string().max(50).optional().nullable(),
  hardwareVersion: z.string().max(50).optional().nullable(),
  isActive: z.boolean().optional(),
  lastSeen: z.string().datetime().optional().nullable(),
  batteryLevel: z.number().min(0).max(100).optional().nullable(),
  requiresCalibration: z.boolean().optional(),
  lastCalibrated: z.string().datetime().optional().nullable(),
  calibrationData: z.record(z.unknown()).optional().nullable(),
  settings: z.record(z.unknown()).optional().nullable(),
  specifications: z.record(z.unknown()).optional().nullable(),
  pairedAt: z.string().datetime().optional().nullable(),
  deviceType: z.string().optional().nullable(), // Legacy field
  version: z.number().optional(), // For optimistic locking
});

export const UpdateDeviceSchema = BaseUpdateDeviceSchema.transform((data) => ({
  ...data,
  // Normalize: Use deviceName if provided, otherwise keep name
  name: data.deviceName || data.name,
  // Remove deviceName from output
  deviceName: undefined,
}));

export const DeviceResponseSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  deviceName: z.string(),
  type: z.enum(['BLUETOOTH_SENSOR', 'TEMPERATURE_SENSOR', 'HUMIDITY_SENSOR', 'SCALE', 'SENSOR', 'OTHER']),
  status: z.enum(['UNPAIRED', 'ACTIVE', 'INACTIVE', 'OFFLINE', 'CALIBRATING', 'ERROR', 'DECOMMISSIONED']),
  macAddress: z.string().nullable().optional(),
  bluetoothId: z.string().nullable().optional(),
  serialNumber: z.string().nullable().optional(),
  brand: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  firmwareVersion: z.string().nullable().optional(),
  hardwareVersion: z.string().nullable().optional(),
  isActive: z.boolean(),
  lastSeen: z.string().datetime().nullable().optional(),
  batteryLevel: z.number().nullable().optional(),
  requiresCalibration: z.boolean(),
  lastCalibrated: z.string().datetime().nullable().optional(),
  calibrationData: z.record(z.unknown()).nullable().optional(),
  settings: z.record(z.unknown()).nullable().optional(),
  specifications: z.record(z.unknown()).nullable().optional(),
  pairedAt: z.string().datetime().nullable().optional(),
  deviceType: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

// AI Usage Record Schemas
export const CreateAiUsageRecordSchema = z.object({
  endpoint: z.string().min(1).max(200),
  requestType: z.enum(['CHAT', 'VARIANT_MATCH', 'JOURNAL_ANALYSIS', 'WEEKLY_REPORT', 'VARIANT_ANALYSIS', 'RECOMMENDATION', 'GENERAL']),
  requestId: z.string().uuid().optional().nullable(),
  model: z.string().min(1).max(100),
  provider: z.string().min(1).max(50).default('anthropic'),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  inputCost: z.string().regex(/^\d+(\.\d{1,6})?$/, 'Input cost must be a valid decimal string'),    // Decimal @db.Decimal(12,6)
  outputCost: z.string().regex(/^\d+(\.\d{1,6})?$/, 'Output cost must be a valid decimal string'),  // Decimal @db.Decimal(12,6)
  totalCost: z.string().regex(/^\d+(\.\d{1,6})?$/, 'Total cost must be a valid decimal string'),    // Decimal @db.Decimal(12,6)
  latencyMs: z.number().int().nonnegative(),
  cached: z.boolean().default(false),
  cacheHit: z.boolean().default(false),
  success: z.boolean(),
  errorCode: z.string().max(100).optional().nullable(),
  errorMessage: z.string().max(1000).optional().nullable(),
  metadata: z.record(z.any()).optional().nullable(),
});

export const UpdateAiUsageRecordSchema = CreateAiUsageRecordSchema.partial();

export const AiUsageRecordResponseSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  endpoint: z.string(),
  requestType: z.enum(['CHAT', 'VARIANT_MATCH', 'JOURNAL_ANALYSIS', 'WEEKLY_REPORT', 'VARIANT_ANALYSIS', 'RECOMMENDATION', 'GENERAL']),
  requestId: z.string().nullable().optional(),
  model: z.string(),
  provider: z.string(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  totalTokens: z.number().int(),
  inputCost: z.string(),    // Decimal string
  outputCost: z.string(),   // Decimal string
  totalCost: z.string(),    // Decimal string
  latencyMs: z.number().int(),
  cached: z.boolean(),
  cacheHit: z.boolean(),
  success: z.boolean(),
  errorCode: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

// Helper functions for error handling


// Helper function to handle Prisma errors and convert them to AppError
interface PrismaError {
  code?: string;
  meta?: {
    target?: string[];
    column?: string;
    [key: string]: unknown;
  };
  message?: string;
}

function isPrismaError(error: unknown): error is PrismaError {
  return typeof error === 'object' && error !== null && 'code' in error;
}

export function handlePrismaError(error: unknown, logger?: LoggerService): AppError {
  // Use provided logger or fallback to console logging
  const logError = logger
    ? (msg: string, data: Record<string, unknown>) => logger.error(msg, data)
    : (msg: string, data: Record<string, unknown>) => console.error(msg, data);
  
  // Handle null/undefined errors
  if (!error) {
    logError('[PrismaError]:', { error, errorType: 'null_undefined' });
    return new AppError(
      500,
      ErrorCodes.DATABASE_ERROR,
      'A database error occurred while processing your request.',
      false,
      { errorType: 'null_undefined' },
      error,
    );
  }
  
  // Check if it's a Prisma error and handle accordingly
  if (isPrismaError(error)) {
    // Prisma unique constraint violation
    if (error.code === 'P2002') {
      const fields = error.meta?.target || ['field'];
      return new AppError(
        409, // HTTP Status for Conflict
        ErrorCodes.DUPLICATE_ENTRY,
        `A record with this ${fields.join(', ')} already exists.`,
        true,
        {
          prismaCode: error.code,
          meta: error.meta,
          ...(process.env.NODE_ENV === 'development' && { fullMeta: error.meta }),
        },
        error,
      );
    }

    // Prisma record not found
    if (error.code === 'P2025') {
      return new AppError(
        404, // HTTP Status for Not Found
        ErrorCodes.RESOURCE_NOT_FOUND,
        'The requested record was not found.',
        true,
        { prismaCode: error.code, meta: error.meta },
        error,
      );
    }

    // Foreign key constraint violation
    if (error.code === 'P2003') {
      return new AppError(
        400, // HTTP Status for Bad Request
        ErrorCodes.BAD_REQUEST,
        'Invalid reference: the related record does not exist.',
        true,
        { prismaCode: error.code, meta: error.meta },
        error,
      );
    }

    // Required field missing
    if (error.code === 'P2011') {
      const field = error.meta?.column || 'field';
      return new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `Missing required field: ${field}`,
        true,
        { prismaCode: error.code, meta: error.meta, field },
        error,
      );
    }

    // Schema drift: table or column does not exist in the database
    // Typically caused by a pending migration that hasn't been applied.
    if (error.code === 'P2021' || error.code === 'P2022') {
      const missingEntity = error.code === 'P2021' ? 'table' : 'column';
      logError(`[PrismaError] Schema drift detected: ${missingEntity} does not exist (${error.code})`, {
        error,
        errorCode: error.code,
        errorMeta: error.meta,
        hint: 'Run `npx prisma migrate deploy` to apply pending migrations.',
      });
      return new AppError(
        500,
        ErrorCodes.DATABASE_ERROR,
        `Schema drift: a ${missingEntity} referenced by the application does not exist in the database. A pending migration may need to be applied.`,
        false, // NOT operational — deployment bug, not user error
        { prismaCode: error.code, meta: error.meta, hint: 'Run npx prisma migrate deploy' },
        error,
      );
    }
  }

  // Default to a generic database error
  // Log the full error for debugging but don't expose to client
  const prismaError = isPrismaError(error) ? error : null;
  logError('[PrismaError]:', {
    error,
    errorCode: prismaError?.code,
    errorMeta: prismaError?.meta
  });
  return new AppError(
    500,
    ErrorCodes.DATABASE_ERROR,
    'A database error occurred while processing your request.',
    false, // This is not an operational error, but a bug/DB issue
    {
      prismaCode: prismaError?.code || 'unknown',
      meta: prismaError?.meta,
      errorType: 'unknown_prisma_error',
    },
    error,
  );
}
