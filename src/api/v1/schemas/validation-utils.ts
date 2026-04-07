/**
 * Validation Utilities
 * Common validation helpers and transformers for API schemas using proper Zod patterns
 *
 * **Why Strings for API Validation:**
 * JSON has no native Decimal type. API requests send decimal values as strings
 * to avoid JavaScript floating-point precision errors (0.1 + 0.2 !== 0.3).
 *
 * **Layer Separation:**
 * - API Layer (Zod): Validates string format and precision
 * - Repository Layer (Prisma): Converts to Prisma.Decimal for database storage
 * - Service Layer: Works with Prisma.Decimal types
 *
 * **Conversion Pattern:**
 * ```typescript
 * // Zod validates string: "10.50"
 * const validated = validators.money().parse(req.body.price);
 *
 * // Repository converts to Prisma.Decimal
 * import { Prisma } from '@prisma/client';
 * const decimal = new Prisma.Decimal(validated);
 * await prisma.purchase.create({ data: { costSpent: decimal } });
 * ```
 *
 * **DO NOT use z.instanceof(Decimal)** - This would break API validation as
 * JSON payloads never contain Decimal instances.
 *
 * See repository README files for conversion examples
 */

import { z } from 'zod';
import { Prisma } from '@prisma/client';

// Decimal string validation using Zod's coerce and transform
export const decimalString = (scale: number, options?: {
  min?: number;
  max?: number;
  positive?: boolean;
}) => {
  const { min, max, positive = false } = options || {};

  return z.string()
    .transform((val) => {
      // Validate it's a valid decimal string
      const num = parseFloat(val);
      if (isNaN(num) || !isFinite(num)) {
        throw new Error('Invalid decimal format');
      }

      // Check decimal places
      const decimalPart = val.split('.')[1];
      if (decimalPart && decimalPart.length > scale) {
        throw new Error(`Maximum ${scale} decimal places allowed`);
      }

      return val; // Return as string to preserve precision
    })
    .refine((val) => {
      const num = parseFloat(val);

      // Check positive constraint
      if (positive && num <= 0) return false;

      // Check min constraint
      if (min !== undefined && num < min) return false;

      // Check max constraint
      if (max !== undefined && num > max) return false;

      return true;
    }, {
      message: `Invalid decimal value${positive ? ' (must be positive)' : ''}${min !== undefined ? ` (min: ${min})` : ''}${max !== undefined ? ` (max: ${max})` : ''}`,
    });
};

// Specific decimal validators matching Prisma schema
export const validators = {
  // Money amounts - Decimal(12,2)
  money: () => decimalString(2, { positive: true }),

  // Precise prices - Decimal(12,4) for price per unit
  precisePrice: () => decimalString(4, { positive: true }),

  // Weight/quantity - Decimal(12,3) for weight
  weight: () => decimalString(3, { positive: true }),

  // Small quantities - Decimal(10,2) for inventory
  smallQuantity: () => decimalString(2, { positive: true }),

  // Very precise quantities - Decimal(10,5) for precise measurements
  preciseQuantity: () => decimalString(5, { positive: true }),

  // Loss factor - Decimal(5,3) with specific range
  lossFactor: () => decimalString(3, { min: 0.1, max: 99.9 }),

  // Percentages - Decimal(5,2) for primary/secondary compound content
  percentage: () => decimalString(2, { min: 0, max: 100 }),

  // Primary compound content in mg - Decimal(10,2)
  compoundMg: () => decimalString(2, { positive: true }),

  // AI cost tracking - Decimal(12,6) for precise billing
  aiCost: () => decimalString(6, { positive: true }),
};

// UUID validation with better error messages
export const uuid = (fieldName: string = 'ID') =>
  z.string().uuid(`Invalid ${fieldName} format`);

// Optional UUID
export const optionalUuid = (fieldName: string = 'ID') =>
  z.string().uuid(`Invalid ${fieldName} format`).optional();

// Timestamp validation
export const timestamp = () =>
  z.string().datetime('Invalid timestamp format');

// Optional timestamp
export const optionalTimestamp = () =>
  z.string().datetime('Invalid timestamp format').optional();

// Transform string to boolean for query parameters
export const booleanQuery = () =>
  z.string().transform(val => val === 'true');

// Transform string to number with validation
export const numberQuery = (min?: number, max?: number) =>
  z.string()
    .transform(Number)
    .device(
      z.number()
        .int('Must be an integer')
        .min(min || 0, min !== undefined ? `Must be at least ${min}` : undefined)
        .max(max || Number.MAX_SAFE_INTEGER, max !== undefined ? `Must be at most ${max}` : undefined),
    );

// Array from comma-separated string
export const csvArray = (itemSchema: z.ZodSchema) =>
  z.string()
    .transform(val => val.split(',').map(s => s.trim()).filter(s => s.length > 0))
    .device(z.array(itemSchema));

// Pagination helpers
export const paginationQuery = (maxLimit: number = 100) => ({
  limit: numberQuery(1, maxLimit).optional(),
  offset: numberQuery(0).optional(),
  page: numberQuery(1).optional(),
  pageSize: numberQuery(1, maxLimit).optional(),
});

/**
 * Creates a case-insensitive Zod enum that accepts lowercase input and transforms to uppercase.
 * This follows Postel's Law: "Be conservative in what you send, be liberal in what you accept."
 *
 * @param values - Array of uppercase enum values (matching Prisma schema)
 * @returns Zod schema that accepts case-insensitive input and outputs uppercase
 *
 * @example
 * const SessionStatus = caseInsensitiveEnum(['ACTIVE', 'COMPLETED', 'PAUSED', 'CANCELLED']);
 * SessionStatus.parse('completed') // Returns 'COMPLETED'
 * SessionStatus.parse('COMPLETED') // Returns 'COMPLETED'
 */
export const caseInsensitiveEnum = <T extends string>(values: readonly [T, ...T[]]) => {
  const uppercaseSet = new Set(values.map(v => v.toUpperCase()));
  return z.string()
    .transform(val => val.toUpperCase() as T)
    .refine((val): val is T => uppercaseSet.has(val), {
      message: `Invalid value. Expected one of: ${values.join(', ')} (case-insensitive)`,
    });
};

// Common enums aligned with Prisma schema
export const enums = {
  // Product related
  ProductType: z.enum(['NATURAL', 'INGESTIBLE', 'EXTRACT', 'TINCTURE', 'TOPICAL', 'INHALER', 'CARTRIDGE', 'PREPARED', 'OTHER']),
  VariantCategory: z.enum(['TYPE_A', 'TYPE_B', 'BLENDED', 'UNKNOWN']),

  // Journal related
  JournalEffectKind: z.enum(['EFFECT', 'SIDE_EFFECT', 'SYMPTOM_RELIEF']),
  EffectPolarity: z.enum(['POSITIVE', 'NEGATIVE', 'NEUTRAL']),

  // Device related
  DeviceType: z.enum(['BLUETOOTH_SENSOR', 'TEMPERATURE_SENSOR', 'HUMIDITY_SENSOR', 'SCALE', 'SENSOR', 'OTHER']),
  DeviceStatus: z.enum(['UNPAIRED', 'ACTIVE', 'INACTIVE', 'OFFLINE', 'CALIBRATING', 'ERROR', 'DECOMMISSIONED']),

  // Inventory related
  AdjustmentType: z.enum(['CONSUMPTION', 'DISPOSAL', 'CORRECTION', 'RETURN']),

  // Achievement related
  AchievementCategory: z.enum(['GENERAL', 'CONSUMPTION', 'SOCIAL', 'ANALYTICS', 'SAVINGS', 'SAFETY', 'MILESTONES', 'AI', 'DEVICE', 'JOURNAL', 'STREAK', 'USAGE', 'SPECIAL']),
  AchievementRarity: z.enum(['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY']),

  // Goal related
  GoalType: z.enum(['USAGE_REDUCTION', 'COST_SAVINGS', 'SESSION_FREQUENCY', 'HABIT_TRACKING', 'HEALTH_METRIC', 'CUSTOM']),
  GoalStatus: z.enum(['ACTIVE', 'COMPLETED', 'PAUSED', 'FAILED', 'ARCHIVED']),
  MetricType: z.enum(['UNITS_PER_DAY', 'UNITS_PER_WEEK', 'UNITS_PER_MONTH', 'SESSIONS_PER_DAY', 'SESSIONS_PER_WEEK', 'COST_PER_DAY', 'COST_PER_WEEK', 'COST_PER_MONTH', 'DURATION_PER_SESSION', 'CUSTOM_NUMERIC']),

  // User related
  AuthProvider: z.enum(['COGNITO', 'GOOGLE', 'PHONE', 'EMAIL']),
  UserType: z.enum(['CONSUMER', 'MEDICAL', 'RESEARCHER', 'ADMIN']),
  AccountStatus: z.enum(['ACTIVE', 'SUSPENDED', 'PENDING_VERIFICATION', 'DELETED']), // Aligned with schema.prisma

  // Safety related
  SafetyRecordType: z.enum(['USAGE_EXCESS', 'UNUSUAL_PATTERN', 'DEVICE_MALFUNCTION', 'USER_REPORT', 'SYSTEM_ALERT']),
  SafetySeverity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),

  // AI related
  AiRequestType: z.enum(['CHAT', 'VARIANT_MATCH', 'JOURNAL_ANALYSIS', 'WEEKLY_REPORT', 'VARIANT_ANALYSIS', 'RECOMMENDATION', 'GENERAL']),

  // Sync related
  SyncType: z.enum(['PUSH', 'PULL', 'FULL']),
  SyncStatus: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CONFLICT']),

  // Outbox related
  OutboxStatus: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD_LETTER']),

  // Session related - aligned with Prisma SessionStatus enum
  // Uses case-insensitive validation to accept both 'completed' and 'COMPLETED' from frontend
  SessionStatus: caseInsensitiveEnum(['ACTIVE', 'COMPLETED', 'PAUSED', 'CANCELLED'] as const),
};

// Export validators alias for compatibility
export { validators as decimal };

// DECIMAL CONVERSION UTILITIES (for Repositories)

/**
 * Safely converts a validated string to Prisma.Decimal
 *
 * **Usage:**
 * ```typescript
 * // In repositories only, after Zod validation
 * const validated = validators.money().parse(input);
 * const decimal = toDecimal(validated); // Prisma.Decimal
 * await prisma.purchase.create({ data: { costSpent: decimal } });
 * ```
 *
 * **NEVER use in API schemas** - Schemas validate strings, repositories convert
 *
 * @param value - Pre-validated decimal string from Zod
 * @returns Prisma.Decimal instance
 * @throws Error if conversion fails (should never happen after Zod validation)
 */
export function toDecimal(value: string): Prisma.Decimal {
  try {
    return new Prisma.Decimal(value);
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    throw new Error(`Failed to convert "${value}" to Prisma.Decimal: ${err.message}`);
  }
}

/**
 * Safely converts Prisma.Decimal to string for API responses
 *
 * **Usage:**
 * ```typescript
 * // In repositories when returning data
 * const purchase = await prisma.purchase.findUnique({ where: { id } });
 * return {
 *   ...purchase,
 *   costSpent: fromDecimal(purchase.costSpent) // string
 * };
 * ```
 *
 * @param value - Prisma.Decimal from database
 * @returns String representation with full precision
 */
export function fromDecimal(value: Prisma.Decimal | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.toString();
}

/**
 * Type guard to check if a value is a Prisma.Decimal
 *
 * @param value - Value to check
 * @returns true if value is Prisma.Decimal
 */
export function isDecimal(value: unknown): value is Prisma.Decimal {
  return value instanceof Prisma.Decimal;
}
