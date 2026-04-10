import { Request, Response } from 'express';
import { z, ZodSchema, ZodError } from 'zod';

/**
 * Validation result interface
 */
export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  sanitizedData?: unknown;
  warnings: string[];
}

/**
 * Validation error interface
 */
export interface ValidationError {
  field: string;
  message: string;
  code: string;
  value?: unknown;
}

/**
 * Request validation configuration
 */
export interface RequestValidationConfig {
  maxBodySize: number;
  maxStringLength: number;
  allowedContentTypes: string[];
  sanitizeInput: boolean;
  strictMode: boolean;
}

/**
 * Response validation configuration
 */
export interface ResponseValidationConfig {
  validateStructure: boolean;
  sanitizeOutput: boolean;
  maxResponseSize: number;
  allowedFields: string[];
}

/**
 * Request Validation Service
 * Provides comprehensive validation and sanitization for API requests and responses
 * Stateless service with configuration-based initialization
 */
export class RequestValidationService {
  private config: RequestValidationConfig;
  private responseConfig: ResponseValidationConfig;

  /**
   * Constructor - initializes validation configuration based on environment
   */
  public constructor() {
    this.config = {
      maxBodySize: 1024 * 1024, // 1MB
      maxStringLength: 10000,
      allowedContentTypes: ['application/json', 'text/plain'],
      sanitizeInput: true,
      strictMode: process.env.NODE_ENV === 'production',
    };

    this.responseConfig = {
      validateStructure: true,
      sanitizeOutput: true,
      maxResponseSize: 5 * 1024 * 1024, // 5MB
      allowedFields: [],
    };
  }

  /**
   * Validate request body against schema
   */
  public validateRequestBody<T>(body: unknown, schema: ZodSchema<T>): ValidationResult {
    const result: ValidationResult = {
      isValid: false,
      errors: [],
      warnings: [],
    };

    try {
      // Pre-validation sanitization
      const sanitizedBody = this.config.sanitizeInput ? this.sanitizeInput(body) : body;

      // Validate against schema
      const validatedData = schema.parse(sanitizedBody);

      result.isValid = true;
      result.sanitizedData = validatedData;

      // Additional security checks
      const securityWarnings = this.performSecurityChecks(sanitizedBody);
      result.warnings.push(...securityWarnings);

    } catch (error) {
      if (error instanceof ZodError) {
        result.errors = error.errors.map(err => ({
          field: err.path.join('.'),
          message: err.message,
          code: err.code,
          value: undefined, // ZodIssue doesn't have 'input' property, omit it
        }));
      } else {
        result.errors.push({
          field: 'unknown',
          message: (error as Error).message,
          code: 'VALIDATION_ERROR',
        });
      }
    }

    return result;
  }

  /**
   * Validate request parameters
   */
  public validateRequestParams(params: unknown, schema: ZodSchema): ValidationResult {
    return this.validateRequestBody(params, schema);
  }

  /**
   * Validate query parameters
   */
  public validateQueryParams(query: unknown, schema: ZodSchema): ValidationResult {
    const result = this.validateRequestBody(query, schema);

    // Additional query parameter security checks
    if (result.isValid && result.sanitizedData) {
      const queryWarnings = this.validateQuerySecurity(result.sanitizedData);
      result.warnings.push(...queryWarnings);
    }

    return result;
  }

  /**
   * Sanitize input data to prevent injection attacks
   */
  public sanitizeInput(data: unknown): unknown {
    if (data === null || data === undefined) {
      return data;
    }

    if (typeof data === 'string') {
      return this.sanitizeString(data);
    }

    if (Array.isArray(data)) {
      return data.map(item => this.sanitizeInput(item));
    }

    if (typeof data === 'object') {
      const sanitized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data)) {
        const sanitizedKey = this.sanitizeString(key);
        sanitized[sanitizedKey] = this.sanitizeInput(value);
      }
      return sanitized;
    }

    return data;
  }

  /**
   * Sanitize string input
   *
   * NOTE ON ENCODING STRATEGY:
   * This is a JSON API consumed by mobile apps, NOT HTML rendered in browsers.
   * Therefore, we only remove truly dangerous characters (null bytes, control chars)
   * and do NOT apply HTML entity encoding.
   *
   * HTML encoding (e.g., / → &#x2F;) breaks validation for strings that legitimately
   * contain forward slashes, such as health metric units: "breaths/min", "count/min", "kg/m²".
   *
   * XSS protection should be applied at the PRESENTATION layer (output encoding),
   * not at the data INGESTION layer (input encoding). Encoding inputs corrupts data
   * integrity and breaks downstream validation logic.
   *
   * Security measures retained:
   * - Null byte removal (prevents string truncation attacks)
   * - Control character removal (prevents log injection, terminal escape sequences)
   * - String length limiting (prevents memory exhaustion)
   * - SQL/XSS pattern detection in performSecurityChecks() (logs warnings without corrupting data)
   */
  private sanitizeString(str: string): string {
    if (typeof str !== 'string') return str;

    // Limit string length to prevent memory exhaustion
    if (str.length > this.config.maxStringLength) {
      str = str.substring(0, this.config.maxStringLength);
    }

    // Remove truly dangerous characters that could cause security issues
    // regardless of the rendering context (JSON, HTML, etc.)
    str = str
      // Remove null bytes - prevents string truncation attacks in C-based systems
      .replace(/\0/g, '')
      // Remove control characters except newlines (\n=0x0A) and tabs (\t=0x09)
      // These can cause log injection, terminal escape sequences, etc.
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    // NOTE: We intentionally do NOT apply HTML entity encoding here.
    // - This is a JSON API, not HTML output
    // - HTML encoding breaks valid data containing special characters
    // - Example: "breaths/min" would become "breaths&#x2F;min" and fail validation
    // - XSS protection should be at the presentation layer, not here

    return str;
  }

  /**
   * Perform security checks on input data
   */
  private performSecurityChecks(data: unknown): string[] {
    const warnings: string[] = [];

    if (typeof data === 'string') {
      warnings.push(...this.checkStringForThreats(data));
    } else if (typeof data === 'object' && data !== null) {
      for (const [key, value] of Object.entries(data)) {
        warnings.push(...this.checkStringForThreats(key));
        if (typeof value === 'string') {
          warnings.push(...this.checkStringForThreats(value));
        }
      }
    }

    return warnings;
  }

  /**
   * Check string for security threats
   */
  private checkStringForThreats(str: string): string[] {
    const warnings: string[] = [];
    const lowerStr = str.toLowerCase();

    // SQL injection patterns
    const sqlPatterns = [
      /union.*select/i,
      /insert.*into/i,
      /delete.*from/i,
      /drop.*table/i,
      /exec.*sp_/i,
      /xp_cmdshell/i,
    ];

    for (const pattern of sqlPatterns) {
      if (pattern.test(str)) {
        warnings.push('Potential SQL injection attempt detected');
        break;
      }
    }

    // XSS patterns
    const xssPatterns = [
      /<script/i,
      /javascript:/i,
      /on\w+\s*=/i,
      /<iframe/i,
      /<object/i,
      /<embed/i,
    ];

    for (const pattern of xssPatterns) {
      if (pattern.test(str)) {
        warnings.push('Potential XSS attempt detected');
        break;
      }
    }

    // Path traversal
    if (str.includes('..') || str.includes('~')) {
      warnings.push('Potential path traversal attempt detected');
    }

    // Command injection
    const cmdPatterns = [
      /;\s*(rm|del|format|shutdown)/i,
      /\|\s*(nc|netcat|wget|curl)/i,
      /`.*`/,
      /\$\(.*\)/,
    ];

    for (const pattern of cmdPatterns) {
      if (pattern.test(str)) {
        warnings.push('Potential command injection attempt detected');
        break;
      }
    }

    return warnings;
  }

  /**
   * Validate query parameter security
   */
  private validateQuerySecurity(query: unknown): string[] {
    const warnings: string[] = [];

    // Only validate if query is an object
    if (typeof query !== 'object' || query === null) {
      return warnings;
    }

    // Check for excessive parameters
    const paramCount = Object.keys(query).length;
    if (paramCount > 50) {
      warnings.push('Excessive number of query parameters');
    }

    // Check for suspicious parameter names
    const suspiciousParams = ['eval', 'exec', 'system', 'cmd', 'shell'];
    for (const param of Object.keys(query)) {
      if (suspiciousParams.includes(param.toLowerCase())) {
        warnings.push(`Suspicious parameter name: ${param}`);
      }
    }

    return warnings;
  }

  /**
   * Validate response data before sending
   */
  public validateResponse(data: unknown): ValidationResult {
    const result: ValidationResult = {
      isValid: false,
      errors: [],
      warnings: [],
    };

    try {
      // Check response size
      const responseSize = JSON.stringify(data).length;
      if (responseSize > this.responseConfig.maxResponseSize) {
        result.errors.push({
          field: 'response',
          message: 'Response size exceeds maximum allowed',
          code: 'RESPONSE_TOO_LARGE',
        });
        return result;
      }

      // Sanitize response if configured
      const sanitizedData = this.responseConfig.sanitizeOutput ?
        this.sanitizeResponseData(data) : data;

      // Validate response structure
      if (this.responseConfig.validateStructure) {
        const structureWarnings = this.validateResponseStructure(sanitizedData);
        result.warnings.push(...structureWarnings);
      }

      result.isValid = true;
      result.sanitizedData = sanitizedData;

    } catch (error) {
      result.errors.push({
        field: 'response',
        message: (error as Error).message,
        code: 'RESPONSE_VALIDATION_ERROR',
      });
    }

    return result;
  }

  /**
   * Sanitize response data to prevent information leakage
   */
  private sanitizeResponseData(data: unknown): unknown {
    if (data === null || data === undefined) {
      return data;
    }

    if (typeof data === 'string') {
      // Remove potential sensitive information patterns
      return data.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[EMAIL_REDACTED]')
                .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN_REDACTED]')
                .replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '[CARD_REDACTED]');
    }

    if (Array.isArray(data)) {
      return data.map(item => this.sanitizeResponseData(item));
    }

    if (typeof data === 'object') {
      const sanitized: Record<string, unknown> = {};
      const sensitiveKeys = ['password', 'secret', 'key', 'token', 'auth', 'credential'];

      for (const [key, value] of Object.entries(data)) {
        if (sensitiveKeys.some(sensitive => key.toLowerCase().includes(sensitive))) {
          sanitized[key] = '[REDACTED]';
        } else {
          sanitized[key] = this.sanitizeResponseData(value);
        }
      }
      return sanitized;
    }

    return data;
  }

  /**
   * Validate response structure for consistency
   */
  private validateResponseStructure(data: unknown): string[] {
    const warnings: string[] = [];

    if (typeof data === 'object' && data !== null) {
      // Check for common response structure
      if (!data.hasOwnProperty('success') && !data.hasOwnProperty('data') && !data.hasOwnProperty('error')) {
        warnings.push('Response does not follow standard structure (missing success/data/error fields)');
      }

      // Check for potential information leakage
      const dangerousFields = ['stack', 'trace', 'debug', 'internal'];
      for (const field of dangerousFields) {
        if (data.hasOwnProperty(field)) {
          warnings.push(`Response contains potentially sensitive field: ${field}`);
        }
      }
    }

    return warnings;
  }

  /**
   * Create validation schemas for common AI API requests
   */
  public getAIRequestSchemas() {
    return {
      chatRequest: z.object({
        message: z.string().min(1).max(10000),
        context: z.string().optional(),
        temperature: z.number().min(0).max(2).optional(),
        maxTokens: z.number().min(1).max(4000).optional(),
      }),

      recommendationRequest: z.object({
        context: z.string().optional(),
        userProfile: z.object({
          experienceLevel: z.enum(['beginner', 'intermediate', 'experienced']).optional(),
          preferredEffects: z.array(z.string()).optional(),
          medicalConditions: z.array(z.string()).optional(),
        }).optional(),
        recentActivity: z.object({
          consumptions: z.number().optional(),
          averageRating: z.number().optional(),
          topVariants: z.array(z.string()).optional(),
        }).optional(),
        preferences: z.object({
          timeOfDay: z.enum(['morning', 'afternoon', 'evening', 'night']).optional(),
          purpose: z.string().optional(),
          avoidEffects: z.array(z.string()).optional(),
        }).optional(),
      }),

      variantMatchRequest: z.object({
        preferences: z.object({
          effects: z.array(z.string()).optional(),
          flavors: z.array(z.string()).optional(),
          type: z.enum(['type_a', 'type_b', 'blended']).optional(),
        }),
        excludeVariants: z.array(z.string()).optional(),
        limit: z.number().min(1).max(20).optional(),
      }),

      journalAnalysisRequest: z.object({
        entries: z.array(z.object({
          date: z.string(),
          variant: z.string().optional(),
          effects: z.array(z.string()).optional(),
          mood: z.string().optional(),
          notes: z.string().optional(),
        })).min(1).max(100),
        analysisType: z.enum(['patterns', 'recommendations', 'insights']).optional(),
      }),

      weeklyReportRequest: z.object({
        startDate: z.string(),
        endDate: z.string(),
        includeRecommendations: z.boolean().optional(),
        includeInsights: z.boolean().optional(),
      }),

      variantAnalysisRequest: z.object({
        variantName: z.string().min(1).max(100),
        userPreferences: z.object({
          effects: z.array(z.string()).optional(),
          medicalConditions: z.array(z.string()).optional(),
        }).optional(),
      }),
    };
  }

  /**
   * Update configuration
   */
  public updateConfig(config: Partial<RequestValidationConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Update response configuration
   */
  public updateResponseConfig(config: Partial<ResponseValidationConfig>): void {
    this.responseConfig = { ...this.responseConfig, ...config };
  }

  /**
   * Get current configuration
   */
  public getConfig(): RequestValidationConfig {
    return { ...this.config };
  }

  /**
   * Get response configuration
   */
  public getResponseConfig(): ResponseValidationConfig {
    return { ...this.responseConfig };
  }
}