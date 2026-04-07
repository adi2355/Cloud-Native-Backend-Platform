/**
 * Secure ID Generation Utilities
 * 
 * Provides cryptographically secure ID and password generation for AppPlatform backend.
 * Uses Node.js crypto module to replace insecure Math.random() usage throughout the application.
 * 
 * Critical Security Requirements:
 * - Minimum 256-bit entropy for passwords
 * - AWS Cognito password requirements (uppercase, lowercase, numbers, symbols)
 * - Secure random number generation for all security-sensitive operations
 * 
 * @see https://nodejs.org/api/crypto.html
 * @see https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-policies.html
 */

import * as crypto from 'crypto';
import { AppError, ErrorCodes } from './AppError';

/**
 * Character sets for secure password generation
 */
const PASSWORD_CHARS = {
  UPPERCASE: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  LOWERCASE: 'abcdefghijklmnopqrstuvwxyz',
  NUMBERS: '0123456789',
  SYMBOLS: '!@#$%^&*()_+-=[]{}|;:,.<>?',
} as const;

/**
 * Base62 character set for secure ID generation (URL-safe)
 */
const BASE62_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Generates a cryptographically secure password meeting AWS Cognito requirements
 * 
 * @param length - Password length (minimum 12, recommended 16-32)
 * @returns Secure password with guaranteed character set requirements
 * 
 * @example
 * const password = generateSecurePassword(16);
 * // Returns: "K9#mN2$pQ7&vX3@z"
 */
export function generateSecurePassword(length: number = 16): string {
  if (length < 12) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Password length must be at least 12 characters for security');
  }

  if (length > 128) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Password length cannot exceed 128 characters');
  }

  try {
    // Ensure at least one character from each required set
    const requiredChars = [
      getSecureRandomChar(PASSWORD_CHARS.UPPERCASE),
      getSecureRandomChar(PASSWORD_CHARS.LOWERCASE),
      getSecureRandomChar(PASSWORD_CHARS.NUMBERS),
      getSecureRandomChar(PASSWORD_CHARS.SYMBOLS),
    ];

    // Fill remaining length with random characters from all sets
    const allChars = Object.values(PASSWORD_CHARS).join('');
    const remainingChars = [];
    
    for (let i = 0; i < length - 4; i++) {
      remainingChars.push(getSecureRandomChar(allChars));
    }

    // Combine and shuffle all characters securely
    const allPasswordChars = [...requiredChars, ...remainingChars];
    return secureArrayShuffle(allPasswordChars).join('');
    
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    throw new AppError(500, ErrorCodes.INTERNAL_SERVER_ERROR, `Failed to generate secure password: ${err.message}`);
  }
}

/**
 * Generates a cryptographically secure ID for logging, tracking, and correlation
 * 
 * @param prefix - ID prefix for categorization (e.g., 'req', 'session', 'trace')
 * @param length - Random component length (default 12, minimum 8)
 * @returns Secure ID in format: prefix_timestamp_secureRandom
 * 
 * @example
 * const requestId = generateSecureId('req', 12);
 * // Returns: "req_1672531200000_K9mN2pQ7vX3z"
 */
export function generateSecureId(prefix: string = 'id', length: number = 12): string {
  if (length < 8) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Secure ID length must be at least 8 characters');
  }

  if (prefix.length === 0 || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(prefix)) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Prefix must start with letter and contain only alphanumeric, underscore, or dash characters');
  }

  try {
    const timestamp = Date.now();
    const secureRandom = generateSecureBase62String(length);
    return `${prefix}_${timestamp}_${secureRandom}`;
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    throw new AppError(500, ErrorCodes.INTERNAL_SERVER_ERROR, `Failed to generate secure ID: ${err.message}`);
  }
}

/**
 * Generates cryptographically secure jitter for retry logic and rate limiting
 * 
 * @param min - Minimum value (inclusive)
 * @param max - Maximum value (inclusive)
 * @returns Secure random integer within range
 * 
 * @example
 * const jitter = generateSecureJitter(100, 1000);
 * // Returns: random integer between 100-1000 (inclusive)
 */
export function generateSecureJitter(min: number, max: number): number {
  if (!Number.isInteger(min) || !Number.isInteger(max)) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Jitter bounds must be integers');
  }

  if (min >= max) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Maximum jitter value must be greater than minimum');
  }

  if (max - min > 2147483647) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Jitter range too large for crypto.randomInt');
  }

  try {
    return crypto.randomInt(min, max + 1);
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    throw new AppError(500, ErrorCodes.INTERNAL_SERVER_ERROR, `Failed to generate secure jitter: ${err.message}`);
  }
}

/**
 * Generates a cryptographically secure Base62 string
 * 
 * @param length - Length of the generated string
 * @returns Secure Base62 string (URL-safe, no special characters)
 */
function generateSecureBase62String(length: number): string {
  const result = [];
  
  for (let i = 0; i < length; i++) {
    const randomIndex = crypto.randomInt(0, BASE62_CHARS.length);
    result.push(BASE62_CHARS[randomIndex]);
  }
  
  return result.join('');
}

/**
 * Gets a cryptographically secure random character from a character set
 * 
 * @param charset - Character set to choose from
 * @returns Single random character from the set
 */
function getSecureRandomChar(charset: string): string {
  const randomIndex = crypto.randomInt(0, charset.length);
  const char = charset[randomIndex];
  if (char === undefined) {
    throw new Error('Failed to get random character from charset');
  }
  return char;
}

/**
 * Securely shuffles an array using Fisher-Yates algorithm with crypto.randomInt
 * 
 * @param array - Array to shuffle
 * @returns New shuffled array (does not mutate original)
 */
function secureArrayShuffle<T>(array: T[]): T[] {
  const shuffled = [...array];
  
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    const temp = shuffled[i];
    const target = shuffled[j];
    if (temp !== undefined && target !== undefined) {
      shuffled[i] = target;
      shuffled[j] = temp;
    }
  }
  
  return shuffled;
}

/**
 * Generates a cryptographically secure session token
 * 
 * @param length - Token length in bytes (default 32 for 256-bit entropy)
 * @returns Base64-encoded secure token
 * 
 * @example
 * const sessionToken = generateSecureSessionToken(32);
 * // Returns: "K9mN2pQ7vX3zL8bF4cH6jM1nR5sT9wY0..."
 */
export function generateSecureSessionToken(length: number = 32): string {
  if (length < 16) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Session token must be at least 16 bytes for security');
  }

  try {
    return crypto.randomBytes(length).toString('base64url');
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    throw new AppError(500, ErrorCodes.INTERNAL_SERVER_ERROR, `Failed to generate secure session token: ${err.message}`);
  }
}

/**
 * Validation function for testing secure ID generation
 * Tests all functions with various inputs and edge cases
 */
async function validateSecureIdUtils(): Promise<void> {
  console.log(' Validating Secure ID Generation Utilities...\n');
  
  let passedTests = 0;
  let totalTests = 0;
  const failures: string[] = [];

  // Test generateSecurePassword
  totalTests++;
  try {
    const password = generateSecurePassword(16);
    const hasUpper = /[A-Z]/.test(password);
    const hasLower = /[a-z]/.test(password);
    const hasNumber = /[0-9]/.test(password);
    const hasSymbol = /[!@#$%^&*()_+\-=\[\]{}|;:,.<>?]/.test(password);
    
    if (password.length === 16 && hasUpper && hasLower && hasNumber && hasSymbol) {
      console.log(' generateSecurePassword: PASSED');
      passedTests++;
    } else {
      const missing = [];
      if (!hasUpper) missing.push('uppercase');
      if (!hasLower) missing.push('lowercase');
      if (!hasNumber) missing.push('numbers');
      if (!hasSymbol) missing.push('symbols');
      failures.push(`generateSecurePassword: Missing ${missing.join(', ')}`);
      console.log(' generateSecurePassword: FAILED - Missing required character types');
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    failures.push(`generateSecurePassword: Error - ${message}`);
    console.log(' generateSecurePassword: FAILED - Error thrown');
  }

  // Test generateSecureId
  totalTests++;
  try {
    const id = generateSecureId('test', 12);
    const parts = id.split('_');
    
    if (parts.length === 3 && parts[0] === 'test' && parts[1] && /^\d+$/.test(parts[1]) && parts[2] && parts[2].length === 12) {
      console.log(' generateSecureId: PASSED');
      passedTests++;
    } else {
      failures.push('generateSecureId: Invalid format');
      console.log(' generateSecureId: FAILED - Invalid format');
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    failures.push(`generateSecureId: Error - ${message}`);
    console.log(' generateSecureId: FAILED - Error thrown');
  }

  // Test generateSecureJitter
  totalTests++;
  try {
    const jitter = generateSecureJitter(100, 1000);
    
    if (Number.isInteger(jitter) && jitter >= 100 && jitter <= 1000) {
      console.log(' generateSecureJitter: PASSED');
      passedTests++;
    } else {
      failures.push('generateSecureJitter: Value out of range');
      console.log(' generateSecureJitter: FAILED - Value out of range');
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    failures.push(`generateSecureJitter: Error - ${message}`);
    console.log(' generateSecureJitter: FAILED - Error thrown');
  }

  // Test generateSecureSessionToken
  totalTests++;
  try {
    const token = generateSecureSessionToken(32);
    
    if (token.length > 0 && /^[A-Za-z0-9_-]+$/.test(token)) {
      console.log(' generateSecureSessionToken: PASSED');
      passedTests++;
    } else {
      failures.push('generateSecureSessionToken: Invalid token format');
      console.log(' generateSecureSessionToken: FAILED - Invalid token format');
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    failures.push(`generateSecureSessionToken: Error - ${message}`);
    console.log(' generateSecureSessionToken: FAILED - Error thrown');
  }

  // Test basic validation (simplified for production)
  totalTests++;
  try {
    // Test that functions don't throw errors with valid inputs
    const validPassword = generateSecurePassword(16);
    const validId = generateSecureId('test', 10);
    const validJitter = generateSecureJitter(10, 100);
    const validToken = generateSecureSessionToken(32);
    
    if (validPassword && validId && Number.isInteger(validJitter) && validToken) {
      console.log(' All functions work with valid inputs: PASSED');
      passedTests++;
    } else {
      failures.push('Basic validation: Functions did not return valid results');
      console.log(' Basic validation: FAILED - Functions did not return valid results');
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    failures.push(`Basic validation: Unexpected error - ${message}`);
    console.log(' Basic validation: FAILED - Unexpected error');
  }

  // Summary
  console.log('\n Validation Summary:');
  console.log(`Passed: ${passedTests}/${totalTests} tests`);
  
  if (failures.length > 0) {
    console.log('\n Failures:');
    failures.forEach(failure => console.log(`  - ${failure}`));
    process.exit(1);
  } else {
    console.log(' All secure ID utility tests passed successfully');
    process.exit(0);
  }
}

// Self-validation for Node.js execution
if (require.main === module) {
  validateSecureIdUtils().catch(error => {
    console.error('Validation failed:', error);
    process.exit(1);
  });
}