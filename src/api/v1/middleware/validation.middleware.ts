
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

export const validate = (schema: z.AnyZodObject) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      // Parse the entire request object (body, query, params) instead of just req.body
      // This allows schemas to validate query parameters for GET requests and body for POST/PUT
      const requestData = {
        body: req.body,
        query: req.query,
        params: req.params,
      };

      const validatedData = schema.parse(requestData);

      // Update request with validated and possibly transformed data
      req.body = validatedData.body || req.body;
      req.query = validatedData.query || req.query;
      req.params = validatedData.params || req.params;

      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: 'Validation failed',
          details: error.errors,
        });
      }
      return next(error);
    }
  };
};

// Export validateRequest as an alias for consistency with existing code
export const validateRequest = validate;

export const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) => {
  return (req: Request, res: Response, next: NextFunction) => {
    return Promise.resolve(fn(req, res, next)).catch(next);
  };
};
