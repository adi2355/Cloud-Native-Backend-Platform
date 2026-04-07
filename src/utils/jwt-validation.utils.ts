/**
 * JWT Secret Validation Utility
 * 
 * Provides cryptographically secure JWT secret validation and generation
 * for production authentication systems. Ensures JWT secrets meet security
 * requirements and prevents common vulnerabilities.
 * 
 * Features:
 * - Cryptographically secure secret validation
 * - Development/production environment checks
 * - Entropy and complexity analysis
 * - Secure random secret generation
 * - Comprehensive security logging
 * 
 * Security Requirements:
 * - Minimum 32 characters (256+ bits of entropy recommended)
 * - Mixed character sets (letters, numbers, symbols)
 * - No common development keywords in production
 * - Sufficient entropy to prevent brute force attacks
 */

import { randomBytes } from 'crypto';
import { AppError, ErrorCodes } from './AppError';
import LoggerService, { LogLevel, LogCategory } from '../services/logger.service';

export interface JwtValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  securityScore?: number;
}

export class JwtSecretValidator {
  private static readonly MIN_SECRET_LENGTH = 32;
  private static readonly RECOMMENDED_SECRET_LENGTH = 64;
  private static readonly MIN_ENTROPY_CHARACTERS = 10;
  private static readonly DEV_KEYWORDS = [
    'dummy', 'test', 'dev', 'development', 'example', 'secret', 
    'demo', 'sample', 'temp', 'temporary', 'default', 'changeme',
    'password', 'admin', 'root', 'user', '123', 'abc',
  ];
  
  /**
   * Validates a JWT secret for security requirements
   *
   * @param secret - The JWT secret to validate
   * @param logger - Logger service for logging validation results
   * @param context - Context for logging (e.g., 'JWT Access Token', 'Refresh Token')
   * @returns Validation result with errors and warnings
   */
  static validate(secret: string | undefined, logger: LoggerService, context: string = 'JWT'): JwtValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    let securityScore = 100;
    
    // Check existence and type
    if (!secret || typeof secret !== 'string') {
      errors.push(`${context} secret is required and must be a string`);
      return { isValid: false, errors, warnings, securityScore: 0 };
    }
    
    // Trim whitespace for analysis
    const trimmedSecret = secret.trim();
    if (trimmedSecret.length !== secret.length) {
      warnings.push(`${context} secret contains leading/trailing whitespace`);
      securityScore -= 5;
    }
    
    // Check minimum length
    if (trimmedSecret.length < this.MIN_SECRET_LENGTH) {
      errors.push(
        `${context} secret must be at least ${this.MIN_SECRET_LENGTH} characters ` +
        `(current: ${trimmedSecret.length})`,
      );
      securityScore -= 30;
    } else if (trimmedSecret.length < this.RECOMMENDED_SECRET_LENGTH) {
      warnings.push(
        `${context} secret is shorter than recommended ${this.RECOMMENDED_SECRET_LENGTH} characters ` +
        `(current: ${trimmedSecret.length})`,
      );
      securityScore -= 10;
    }
    
    // Check for development keywords
    const lowerSecret = trimmedSecret.toLowerCase();
    const containsDevKeyword = this.DEV_KEYWORDS.some(keyword => 
      lowerSecret.includes(keyword.toLowerCase()),
    );
    
    if (containsDevKeyword) {
      const foundKeywords = this.DEV_KEYWORDS.filter(keyword => 
        lowerSecret.includes(keyword.toLowerCase()),
      );
      
      if (process.env.NODE_ENV === 'production') {
        errors.push(
          `${context} secret contains development/test keywords in production: ` +
          `[${foundKeywords.join(', ')}] - critical security risk`,
        );
        securityScore -= 50;
      } else {
        warnings.push(
          `${context} secret contains development/test keywords: [${foundKeywords.join(', ')}] - ` +
          'ensure this is not used in production',
        );
        securityScore -= 15;
      }
    }
    
    // Check for weak patterns
    if (/^[a-zA-Z]+$/.test(trimmedSecret)) {
      errors.push(`${context} secret lacks complexity - contains only letters`);
      securityScore -= 25;
    } else if (/^[0-9]+$/.test(trimmedSecret)) {
      errors.push(`${context} secret lacks complexity - contains only numbers`);
      securityScore -= 25;
    } else if (/^(.)\1+$/.test(trimmedSecret)) {
      errors.push(`${context} secret is a repeating character - extremely insecure`);
      securityScore -= 60;
    }
    
    // Check for common weak patterns
    if (/^[a-zA-Z0-9]+$/.test(trimmedSecret) && trimmedSecret.length < 48) {
      warnings.push(`${context} secret lacks special characters and may be vulnerable to attacks`);
      securityScore -= 10;
    }
    
    // Check entropy (simplified check using unique character count)
    const uniqueChars = new Set(trimmedSecret).size;
    if (uniqueChars < this.MIN_ENTROPY_CHARACTERS) {
      errors.push(
        `${context} secret has low entropy - only ${uniqueChars} unique characters ` +
        `(minimum: ${this.MIN_ENTROPY_CHARACTERS})`,
      );
      securityScore -= 20;
    }
    
    // Check for sequential or keyboard patterns
    if (this.hasSequentialPattern(trimmedSecret)) {
      warnings.push(`${context} secret contains sequential patterns (e.g., '123', 'abc')`);
      securityScore -= 15;
    }
    
    if (this.hasKeyboardPattern(trimmedSecret)) {
      warnings.push(`${context} secret contains keyboard patterns (e.g., 'qwerty', 'asdf')`);
      securityScore -= 15;
    }
    
    // Advanced entropy check using Shannon entropy
    const shannonEntropy = this.calculateShannonEntropy(trimmedSecret);
    if (shannonEntropy < 3.5) {
      warnings.push(
        `${context} secret has low Shannon entropy (${shannonEntropy.toFixed(2)}) - ` +
        'consider using more random characters',
      );
      securityScore -= 10;
    }
    
    // Ensure minimum security score
    securityScore = Math.max(0, securityScore);
    
    // Log validation results with appropriate level
    if (errors.length > 0) {
      logger.log(LogLevel.ERROR, LogCategory.SECURITY, `${context} secret validation failed`, {
        context: 'JwtSecretValidator',
        errors,
        warnings,
        secretLength: trimmedSecret.length,
        uniqueCharacters: uniqueChars,
        shannonEntropy: shannonEntropy.toFixed(2),
        securityScore,
      });
    } else if (warnings.length > 0) {
      logger.log(LogLevel.WARN, LogCategory.SECURITY, `${context} secret validation has warnings`, {
        context: 'JwtSecretValidator',
        warnings,
        secretLength: trimmedSecret.length,
        uniqueCharacters: uniqueChars,
        shannonEntropy: shannonEntropy.toFixed(2),
        securityScore,
      });
    } else {
      logger.log(LogLevel.INFO, LogCategory.SECURITY, `${context} secret validation passed`, {
        context: 'JwtSecretValidator',
        secretLength: trimmedSecret.length,
        uniqueCharacters: uniqueChars,
        shannonEntropy: shannonEntropy.toFixed(2),
        securityScore,
      });
    }
    
    return { 
      isValid: errors.length === 0, 
      errors,
      warnings,
      securityScore,
    };
  }
  
  /**
   * Asserts that a JWT secret is valid, throwing an error if not
   *
   * @param secret - The JWT secret to validate
   * @param logger - Logger service for logging validation results
   * @param context - Context for error messages
   * @throws {AppError} If secret validation fails
   */
  static assertValid(secret: string | undefined, logger: LoggerService, context: string = 'JWT'): void {
    const validation = this.validate(secret, logger, context);
    
    if (!validation.isValid) {
      const errorMessage = `${context} Secret validation failed: ${validation.errors.join(', ')}`;
      
      logger.log(LogLevel.ERROR, LogCategory.SECURITY, errorMessage, {
        context: 'JwtSecretValidator',
        validationErrors: validation.errors,
        validationWarnings: validation.warnings,
      });
      
      throw new AppError(
        500,
        ErrorCodes.CONFIGURATION_ERROR,
        errorMessage,
      );
    }
    
    // Log warnings but don't fail
    if (validation.warnings.length > 0) {
      logger.log(LogLevel.WARN, LogCategory.SECURITY, `${context} secret validation warnings`, {
        context: 'JwtSecretValidator',
        warnings: validation.warnings,
        securityScore: validation.securityScore,
      });
    }
  }
  
  /**
   * Generates a cryptographically secure JWT secret
   *
   * @param logger - Logger service for logging generation results
   * @param length - Length of the secret to generate (default: 64)
   * @returns Cryptographically secure random string
   */
  static generateSecureSecret(logger: LoggerService, length: number = 64): string {
    if (length < this.MIN_SECRET_LENGTH) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `Secret length must be at least ${this.MIN_SECRET_LENGTH} characters`,
      );
    }
    
    // Generate random bytes
    const buffer = randomBytes(Math.ceil(length * 3 / 4)); // Account for base64 encoding overhead
    
    // Convert to base64 and remove padding/URL-unsafe characters
    let secret = buffer
      .toString('base64')
      .replace(/[+/=]/g, '') // Remove URL-unsafe characters
      .substring(0, length);
    
    // Ensure we have the exact length requested
    while (secret.length < length) {
      const additionalBytes = randomBytes(8);
      secret += additionalBytes.toString('base64').replace(/[+/=]/g, '');
    }
    
    secret = secret.substring(0, length);
    
    // Validate the generated secret
    const validation = this.validate(secret, logger, 'Generated JWT Secret');
    if (!validation.isValid) {
      // This should never happen with proper generation, but safety check
      throw new AppError(
        500,
        ErrorCodes.INTERNAL_SERVER_ERROR,
        'Generated secret failed validation',
      );
    }
    
    logger.log(LogLevel.INFO, LogCategory.SECURITY, 'Generated secure JWT secret', {
      context: 'JwtSecretValidator',
      secretLength: secret.length,
      securityScore: validation.securityScore,
    });
    
    return secret;
  }
  
  /**
   * Checks for sequential patterns in the secret
   * 
   * @param secret - The secret to check
   * @returns True if sequential patterns are found
   */
  private static hasSequentialPattern(secret: string): boolean {
    const sequences = [
      '012', '123', '234', '345', '456', '567', '678', '789',
      'abc', 'bcd', 'cde', 'def', 'efg', 'fgh', 'ghi', 'hij',
      'ijk', 'jkl', 'klm', 'lmn', 'mno', 'nop', 'opq', 'pqr',
      'qrs', 'rst', 'stu', 'tuv', 'uvw', 'vwx', 'wxy', 'xyz',
    ];
    
    const lowerSecret = secret.toLowerCase();
    return sequences.some(seq => lowerSecret.includes(seq));
  }
  
  /**
   * Checks for keyboard patterns in the secret
   * 
   * @param secret - The secret to check
   * @returns True if keyboard patterns are found
   */
  private static hasKeyboardPattern(secret: string): boolean {
    const keyboardPatterns = [
      'qwe', 'wer', 'ert', 'rty', 'tyu', 'yui', 'uio', 'iop',
      'asd', 'sdf', 'dfg', 'fgh', 'ghj', 'hjk', 'jkl',
      'zxc', 'xcv', 'cvb', 'vbn', 'bnm',
      'qwerty', 'asdf', 'zxcv', '1234', '4321',
    ];
    
    const lowerSecret = secret.toLowerCase();
    return keyboardPatterns.some(pattern => lowerSecret.includes(pattern));
  }
  
  /**
   * Calculates Shannon entropy of the secret
   * 
   * @param secret - The secret to analyze
   * @returns Shannon entropy value
   */
  private static calculateShannonEntropy(secret: string): number {
    const frequencies = new Map<string, number>();
    
    // Count character frequencies
    for (const char of secret) {
      frequencies.set(char, (frequencies.get(char) || 0) + 1);
    }
    
    // Calculate entropy
    let entropy = 0;
    const length = secret.length;
    
    // Convert map values to array for compatibility
    const frequencyValues = Array.from(frequencies.values());
    for (const frequency of frequencyValues) {
      const probability = frequency / length;
      if (probability > 0) {
        entropy -= probability * Math.log2(probability);
      }
    }
    
    return entropy;
  }
  
  /**
   * Validates multiple JWT secrets at once
   *
   * @param secrets - Object containing named secrets to validate
   * @param logger - Logger service for logging validation results
   * @returns Map of validation results
   */
  static validateMultiple(secrets: Record<string, string | undefined>, logger: LoggerService): Map<string, JwtValidationResult> {
    const results = new Map<string, JwtValidationResult>();

    for (const [name, secret] of Object.entries(secrets)) {
      results.set(name, this.validate(secret, logger, name));
    }

    return results;
  }
  
  /**
   * Gets security recommendations for JWT secret management
   * 
   * @returns Array of security recommendations
   */
  static getSecurityRecommendations(): string[] {
    return [
      `Use secrets with at least ${this.RECOMMENDED_SECRET_LENGTH} characters for maximum security`,
      'Include a mix of uppercase, lowercase, numbers, and special characters',
      'Avoid common words, patterns, or keyboard sequences',
      'Use cryptographically secure random generation (crypto.randomBytes)',
      'Never hardcode secrets in source code - use environment variables',
      'Rotate secrets regularly in production environments',
      'Store secrets in secure key management systems (AWS Secrets Manager, etc.)',
      'Monitor secret access and usage patterns',
      'Use different secrets for different environments (dev/staging/prod)',
      'Implement proper secret backup and recovery procedures',
    ];
  }
}

/**
 * Convenience function for quick JWT secret validation
 *
 * @param secret - The JWT secret to validate
 * @param logger - Logger service for logging validation results
 * @param context - Context for error messages
 * @throws {AppError} If secret validation fails
 */
export function validateJwtSecret(secret: string | undefined, logger: LoggerService, context: string = 'JWT'): void {
  return JwtSecretValidator.assertValid(secret, logger, context);
}

/**
 * Convenience function for generating secure JWT secrets
 *
 * @param logger - Logger service for logging generation results
 * @param length - Length of the secret (default: 64)
 * @returns Cryptographically secure JWT secret
 */
export function generateSecureJwtSecret(logger: LoggerService, length: number = 64): string {
  return JwtSecretValidator.generateSecureSecret(logger, length);
}