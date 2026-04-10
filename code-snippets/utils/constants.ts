/**
 * System Constants
 * Defines system-wide constants for consistent behavior across the application
 */

/**
 * Special User IDs for System Operations
 */
export const SYSTEM_USER_IDS = {
  /**
   * Catalog User ID - Used for public/catalog products instead of NULL
   * This ensures unique constraints work properly in PostgreSQL
   * Format: Special UUID that represents the "system catalog" user
   */
  CATALOG_USER_ID: '00000000-0000-0000-0000-000000000001',

  /**
   * System Admin User ID - Used for system-generated content
   */
  SYSTEM_ADMIN_ID: '00000000-0000-0000-0000-000000000002',
} as const;

/**
 * Database Constraint Constants
 */
export const DB_CONSTRAINTS = {
  /**
   * Maximum lengths for various fields
   */
  MAX_LENGTHS: {
    PRODUCT_NAME: 255,
    PRODUCT_DESCRIPTION: 1000,
    JOURNAL_TITLE: 200,
    JOURNAL_CONTENT: 10000,
    EFFECT_NAME: 100,
    USER_NOTES: 1000,
  },

  /**
   * Validation patterns for Decimal fields
   */
  DECIMAL_PATTERNS: {
    MONEY: /^\d+(\.\d{1,2})?$/, // 2 decimal places for currency
    WEIGHT: /^\d+(\.\d{1,3})?$/, // 3 decimal places for weight
    PRECISE_PRICE: /^\d+(\.\d{1,4})?$/, // 4 decimal places for price per unit
    PERCENTAGE: /^\d+(\.\d{1,2})?$/, // 2 decimal places for percentages
  },
} as const;

/**
 * Business Logic Constants
 */
export const BUSINESS_LOGIC = {
  /**
   * Session timeout in milliseconds (1 hour)
   */
  SESSION_IDLE_TIMEOUT_MS: 60 * 60 * 1000,

  /**
   * Maximum offline sync period in days
   */
  MAX_OFFLINE_SYNC_DAYS: 30,

  /**
   * Default pagination limits
   */
  PAGINATION: {
    DEFAULT_LIMIT: 20,
    MAX_LIMIT: 100,
  },
} as const;

/**
 * Type exports for strict typing
 */
export type SystemUserId = typeof SYSTEM_USER_IDS[keyof typeof SYSTEM_USER_IDS];
export type DecimalPattern = typeof DB_CONSTRAINTS.DECIMAL_PATTERNS[keyof typeof DB_CONSTRAINTS.DECIMAL_PATTERNS];