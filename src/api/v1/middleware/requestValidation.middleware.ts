import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';
import { RequestValidationService } from '../../../services/requestValidation.service';
import { LoggerService } from '../../../services/logger.service';

/**
 * Extended request interface with validation results
 */
export interface ValidatedRequest extends Request {
  validatedBody?: unknown;
  validatedParams?: unknown;
  validatedQuery?: unknown;
  validationWarnings?: string[];
}

/**
 * Request Validation Middleware
 * Provides comprehensive request validation and sanitization
 */
export class RequestValidationMiddleware {
  constructor(
    private validationService: RequestValidationService,
    private logger: LoggerService,
  ) {}

  /**
   * Validate request body against schema
   */
  public validateBody = (schema: ZodSchema) => {
    return (req: ValidatedRequest, res: Response, next: NextFunction): void => {
      try {
        const validation = this.validationService.validateRequestBody(req.body, schema);

        if (!validation.isValid) {
          try {
            this.logger.warn('Request body validation failed', {
              url: req.url,
              method: req.method,
              errors: validation.errors,
              ip: req.ip,
              timestamp: new Date().toISOString(),
            });
          } catch {
            console.warn('Request body validation failed', {
              url: req.url,
              method: req.method,
              errors: validation.errors,
              ip: req.ip,
            });
          }

          res.status(400).json({
            success: false,
            error: 'Invalid request body',
            code: 'VALIDATION_ERROR',
            details: validation.errors.map(err => ({
              field: err.field,
              message: err.message,
            })),
          });
          return;
        }

        // Attach validated and sanitized data to request
        req.validatedBody = validation.sanitizedData;
        req.validationWarnings = validation.warnings;

        // Log warnings if any
        if (validation.warnings.length > 0) {
          try {
            this.logger.warn('Request validation warnings', {
              url: req.url,
              method: req.method,
              warnings: validation.warnings,
              ip: req.ip,
              timestamp: new Date().toISOString(),
            });
          } catch {
            console.warn('Request validation warnings', {
              url: req.url,
              method: req.method,
              warnings: validation.warnings,
              ip: req.ip,
            });
          }
        }

        next();
      } catch (error) {
        try {
          this.logger.error('Request validation middleware error', {
            error: (error as Error).message,
            url: req.url,
            method: req.method,
            timestamp: new Date().toISOString(),
          });
        } catch {
          console.error('Request validation middleware error', {
            error: (error as Error).message,
            url: req.url,
            method: req.method,
          });
        }

        res.status(500).json({
          success: false,
          error: 'Internal validation error',
          code: 'VALIDATION_MIDDLEWARE_ERROR',
        });
      }
    };
  };

  /**
   * Validate request parameters against schema
   */
  public validateParams = (schema: ZodSchema) => {
    return (req: ValidatedRequest, res: Response, next: NextFunction): void => {
      try {
        const validation = this.validationService.validateRequestParams(req.params, schema);

        if (!validation.isValid) {
          try {
            this.logger.warn('Request params validation failed', {
              url: req.url,
              method: req.method,
              errors: validation.errors,
              ip: req.ip,
              timestamp: new Date().toISOString(),
            });
          } catch {
            console.warn('Request params validation failed', {
              url: req.url,
              method: req.method,
              errors: validation.errors,
              ip: req.ip,
            });
          }

          res.status(400).json({
            success: false,
            error: 'Invalid request parameters',
            code: 'PARAMS_VALIDATION_ERROR',
            details: validation.errors.map(err => ({
              field: err.field,
              message: err.message,
            })),
          });
          return;
        }

        req.validatedParams = validation.sanitizedData;
        req.validationWarnings = [...(req.validationWarnings || []), ...validation.warnings];

        next();
      } catch (error) {
        try {
          this.logger.error('Params validation middleware error', {
            error: (error as Error).message,
            url: req.url,
            method: req.method,
            timestamp: new Date().toISOString(),
          });
        } catch {
          console.error('Params validation middleware error', {
            error: (error as Error).message,
            url: req.url,
            method: req.method,
          });
        }

        res.status(500).json({
          success: false,
          error: 'Internal validation error',
          code: 'PARAMS_VALIDATION_MIDDLEWARE_ERROR',
        });
      }
    };
  };

  /**
   * Validate query parameters against schema
   */
  public validateQuery = (schema: ZodSchema) => {
    return (req: ValidatedRequest, res: Response, next: NextFunction): void => {
      try {
        const validation = this.validationService.validateQueryParams(req.query, schema);

        if (!validation.isValid) {
          try {
            this.logger.warn('Query params validation failed', {
              url: req.url,
              method: req.method,
              errors: validation.errors,
              ip: req.ip,
              timestamp: new Date().toISOString(),
            });
          } catch {
            console.warn('Query params validation failed', {
              url: req.url,
              method: req.method,
              errors: validation.errors,
              ip: req.ip,
            });
          }

          res.status(400).json({
            success: false,
            error: 'Invalid query parameters',
            code: 'QUERY_VALIDATION_ERROR',
            details: validation.errors.map(err => ({
              field: err.field,
              message: err.message,
            })),
          });
          return;
        }

        req.validatedQuery = validation.sanitizedData;
        req.validationWarnings = [...(req.validationWarnings || []), ...validation.warnings];

        next();
      } catch (error) {
        try {
          this.logger.error('Query validation middleware error', {
            error: (error as Error).message,
            url: req.url,
            method: req.method,
            timestamp: new Date().toISOString(),
          });
        } catch {
          console.error('Query validation middleware error', {
            error: (error as Error).message,
            url: req.url,
            method: req.method,
          });
        }

        res.status(500).json({
          success: false,
          error: 'Internal validation error',
          code: 'QUERY_VALIDATION_MIDDLEWARE_ERROR',
        });
      }
    };
  };

  /**
   * General request sanitization middleware
   */
  public sanitizeRequest = (req: ValidatedRequest, res: Response, next: NextFunction): void => {
    try {
      // Sanitize request body
      if (req.body) {
        req.body = this.validationService.sanitizeInput(req.body);
      }

      // Sanitize query parameters
      if (req.query) {
        req.query = this.validationService.sanitizeInput(req.query) as typeof req.query;
      }

      // Sanitize parameters
      if (req.params) {
        req.params = this.validationService.sanitizeInput(req.params) as typeof req.params;
      }

      next();
    } catch (error) {
      try {
        this.logger.error('Request sanitization error', {
          error: (error as Error).message,
          url: req.url,
          method: req.method,
          timestamp: new Date().toISOString(),
        });
      } catch {
        console.error('Request sanitization error', {
          error: (error as Error).message,
          url: req.url,
          method: req.method,
        });
      }

      res.status(500).json({
        success: false,
        error: 'Request processing error',
        code: 'SANITIZATION_ERROR',
      });
    }
  };

  /**
   * Response validation and sanitization middleware
   */
  public validateResponse = (req: Request, res: Response, next: NextFunction): void => {
    // Store original json method
    const originalJson = res.json;

    // Capture dependencies in closure scope
    const validationService = this.validationService;
    const logger = this.logger;

    // Override json method to validate response
    res.json = function(data: unknown) {
      try {
        const validation = validationService.validateResponse(data);

        if (!validation.isValid) {
          try {
            logger.error('Response validation failed', {
              url: req.url,
              method: req.method,
              errors: validation.errors,
              timestamp: new Date().toISOString(),
            });
          } catch {
            console.error('Response validation failed', {
              url: req.url,
              method: req.method,
              errors: validation.errors,
            });
          }

          // Send error response instead
          return originalJson.call(this, {
            success: false,
            error: 'Response validation failed',
            code: 'RESPONSE_VALIDATION_ERROR',
          });
        }

        // Log warnings if any
        if (validation.warnings.length > 0) {
          try {
            logger.warn('Response validation warnings', {
              url: req.url,
              method: req.method,
              warnings: validation.warnings,
              timestamp: new Date().toISOString(),
            });
          } catch {
            console.warn('Response validation warnings', {
              url: req.url,
              method: req.method,
              warnings: validation.warnings,
            });
          }
        }

        // Send sanitized response
        return originalJson.call(this, validation.sanitizedData);

      } catch (error) {
        try {
          logger.error('Response validation middleware error', {
            error: (error as Error).message,
            url: req.url,
            method: req.method,
            timestamp: new Date().toISOString(),
          });
        } catch {
          console.error('Response validation middleware error', {
            error: (error as Error).message,
            url: req.url,
            method: req.method,
          });
        }

        return originalJson.call(this, {
          success: false,
          error: 'Response processing error',
          code: 'RESPONSE_MIDDLEWARE_ERROR',
        });
      }
    };

    next();
  };

  /**
   * Malformed request detection middleware
   */
  public detectMalformedRequests = (req: Request, res: Response, next: NextFunction): void => {
    try {
      // Check content-type for JSON requests
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        const contentType = req.get('Content-Type');
        
        if (contentType && !contentType.includes('application/json') && !contentType.includes('text/plain')) {
          try {
            this.logger.warn('Unsupported content type', {
              contentType,
              url: req.url,
              method: req.method,
              ip: req.ip,
              timestamp: new Date().toISOString(),
            });
          } catch {
            console.warn('Unsupported content type', {
              contentType,
              url: req.url,
              method: req.method,
              ip: req.ip,
            });
          }

          res.status(415).json({
            success: false,
            error: 'Unsupported content type',
            code: 'UNSUPPORTED_CONTENT_TYPE',
          });
          return;
        }
      }

      // Check for excessively large headers
      const headerSize = JSON.stringify(req.headers).length;
      if (headerSize > 8192) { // 8KB limit
        try {
          this.logger.warn('Excessive header size detected', {
            headerSize,
            url: req.url,
            method: req.method,
            ip: req.ip,
            timestamp: new Date().toISOString(),
          });
        } catch {
          console.warn('Excessive header size detected', {
            headerSize,
            url: req.url,
            method: req.method,
            ip: req.ip,
          });
        }

        res.status(431).json({
          success: false,
          error: 'Request headers too large',
          code: 'HEADERS_TOO_LARGE',
        });
        return;
      }

      next();
    } catch (error) {
      try {
        this.logger.error('Malformed request detection error', {
          error: (error as Error).message,
          url: req.url,
          method: req.method,
          timestamp: new Date().toISOString(),
        });
      } catch {
        console.error('Malformed request detection error', {
          error: (error as Error).message,
          url: req.url,
          method: req.method,
        });
      }

      res.status(500).json({
        success: false,
        error: 'Request validation error',
        code: 'MALFORMED_REQUEST_DETECTION_ERROR',
      });
    }
  };
}

// Factory function to create RequestValidationMiddleware with dependency injection
export function createRequestValidationMiddleware(
  validationService: RequestValidationService,
  logger: LoggerService,
): RequestValidationMiddleware {
  return new RequestValidationMiddleware(validationService, logger);
}

// Legacy exports - DEPRECATED - Use factory function above with explicit dependencies
export const validateBody = () => {
  throw new Error('DEPRECATED: Use createRequestValidationMiddleware factory function with explicit LoggerService dependency');
};

export const validateParams = () => {
  throw new Error('DEPRECATED: Use createRequestValidationMiddleware factory function with explicit LoggerService dependency');
};

export const validateQuery = () => {
  throw new Error('DEPRECATED: Use createRequestValidationMiddleware factory function with explicit LoggerService dependency');
};

export const sanitizeRequest = () => {
  // DEPRECATED: This function should not be used. Use createRequestValidationMiddleware factory instead.
  // Return a no-op middleware to prevent application crashes while we identify the source.
  console.warn('DEPRECATED: sanitizeRequest standalone function called. Use createRequestValidationMiddleware factory instead.');
  return (req: Request, res: Response, next: NextFunction) => {
    // No-op middleware - just continue to next middleware
    next();
  };
};

export const validateResponse = () => {
  throw new Error('DEPRECATED: Use createRequestValidationMiddleware factory function with explicit LoggerService dependency');
};

export const detectMalformedRequests = () => {
  throw new Error('DEPRECATED: Use createRequestValidationMiddleware factory function with explicit LoggerService dependency');
};

export const validateRequest = () => {
  throw new Error('DEPRECATED: Use createRequestValidationMiddleware factory function with explicit LoggerService dependency');
};