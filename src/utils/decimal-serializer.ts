/**
 * Decimal Serialization Utility
 *
 * BACKEND FIX #4: Decimal Hygiene
 *
 * Converts Prisma Decimal fields to strings for JSON serialization to prevent
 * precision loss when sending numeric data to frontend clients.
 *
 * Key Issues Addressed:
 * - JavaScript number precision limits (IEEE 754 double-precision)
 * - Decimal values like 0.001 can become 0.0010000000000000009
 * - Currency/cost calculations require exact decimal precision
 * - Frontend receives predictable string values: "0.001" not 0.0010000000000000009
 *
 * Usage:
 * ```typescript
 * import { serializeDecimals } from './utils/decimal-serializer';
 *
 * // In service layer before returning to controller
 * const consumption = await this.consumptionRepo.getById(id);
 * return serializeDecimals(consumption); // Converts all Decimal fields to strings
 * ```
 */

import { Decimal } from '@prisma/client/runtime/library';

/**
 * Type guard to check if a value is a Prisma Decimal
 */
function isDecimal(value: unknown): value is Decimal {
  // Check instanceof first (most reliable)
  if (value instanceof Decimal) {
    return true;
  }

  // Check for Decimal-like object structure (has internal properties d, e, s)
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return 'd' in obj && 'e' in obj && 's' in obj;
  }

  return false;
}

/**
 * Recursively serialize Decimal and Date fields to strings in an object or array
 *
 * BACKEND FIX #4: Converts all Decimal and Date values to strings for safe JSON serialization
 *
 * @param data - Object, array, or primitive value to serialize
 * @returns Deep copy with all Decimal and Date fields converted to strings
 */
export function serializeDecimals<T>(data: T): T {
  // Null/undefined pass through
  if (data === null || data === undefined) {
    return data;
  }

  // Decimal conversion
  if (isDecimal(data)) {
    return data.toString() as T;
  }

  if (data instanceof Date) {
    return data.toISOString() as T;
  }

  // Array recursion
  if (Array.isArray(data)) {
    return data.map((item) => serializeDecimals(item)) as T;
  }

  // Object recursion
  if (typeof data === 'object') {
    const serialized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      serialized[key] = serializeDecimals(value);
    }
    return serialized as T;
  }

  // Primitives (string, number, boolean) pass through
  return data;
}

/**
 * Serialize a single Decimal value to string (convenience function)
 *
 * @param decimal - Prisma Decimal value
 * @returns String representation or null
 */
export function serializeDecimal(decimal: Decimal | null | undefined): string | null {
  if (decimal === null || decimal === undefined) {
    return null;
  }
  return decimal.toString();
}

/**
 * Parse a string back to Decimal (for input validation/processing)
 *
 * @param value - String representation of decimal
 * @returns Prisma Decimal instance or null
 */
export function parseDecimal(value: string | null | undefined): Decimal | null {
  if (!value) {
    return null;
  }
  try {
    return new Decimal(value);
  } catch (error) {
    return null;
  }
}

/**
 * Common entity types with Decimal fields (for reference)
 */
export const DECIMAL_FIELD_ENTITIES = {
  Consumption: ['quantity', 'dosageMg'],
  Purchase: ['quantityPurchased', 'costSpent', 'pricePerUnit', 'lossFactor'],
  PurchaseLineItem: ['quantity', 'unitPrice', 'totalPrice'],
  InventoryItem: ['quantityRemaining', 'quantityInitial'],
  InventoryAdjustment: ['quantityChange', 'quantityBefore', 'quantityAfter'],
  DailyStat: [
    'quantityUsed',
    'costSpentActual',
    'costSpentBaseline',
    'costSavedDirect',
    'costSavedWaste',
    'costSavedTotal',
  ],
  UserConsumptionProfile: [
    'learnedAvgQuantityPerEvent',
    'avgConsumptionRate',
    'lossFactor',
    'minInventoryThreshold',
    'maxDailyConsumption',
    'maxWeeklyConsumption',
  ],
  AIUsageRecord: ['inputCost', 'outputCost', 'totalCost'],
} as const;
