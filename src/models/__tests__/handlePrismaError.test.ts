/**
 * handlePrismaError Test Suite
 * Tests for Prisma error handling utility
 */

import { handlePrismaError } from '../index';
import { AppError, ErrorCodes } from '../../utils/AppError';

describe('handlePrismaError', () => {
  const originalEnv = process.env.NODE_ENV;
  const originalConsoleError = console.error;

  beforeEach(() => {
    // Mock console.error to prevent noise in test output
    console.error = jest.fn();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    console.error = originalConsoleError;
  });

  describe('P2002 - Unique constraint violation', () => {
    it('should handle unique constraint with single field', () => {
      const prismaError = {
        code: 'P2002',
        meta: { target: ['email'] },
      };

      const result = handlePrismaError(prismaError);

      expect(result).toBeInstanceOf(AppError);
      expect(result.statusCode).toBe(409);
      expect(result.errorCode).toBe(ErrorCodes.DUPLICATE_ENTRY);
      expect(result.message).toBe('A record with this email already exists.');
      expect(result.isOperational).toBe(true);
    });

    it('should handle unique constraint with multiple fields', () => {
      const prismaError = {
        code: 'P2002',
        meta: { target: ['userId', 'productId'] },
      };

      const result = handlePrismaError(prismaError);

      expect(result.statusCode).toBe(409);
      expect(result.message).toBe('A record with this userId, productId already exists.');
    });

    it('should handle unique constraint without target metadata', () => {
      const prismaError = {
        code: 'P2002',
        meta: {},
      };

      const result = handlePrismaError(prismaError);

      expect(result.statusCode).toBe(409);
      expect(result.message).toBe('A record with this field already exists.');
    });

    it('should include meta details in development mode', () => {
      process.env.NODE_ENV = 'development';
      
      const prismaError = {
        code: 'P2002',
        meta: { 
          target: ['email'],
          modelName: 'User',
        },
      };

      const result = handlePrismaError(prismaError);

      expect(result.details).toEqual({
        target: ['email'],
        modelName: 'User',
      });
    });

    it('should not include meta details in production mode', () => {
      process.env.NODE_ENV = 'production';
      
      const prismaError = {
        code: 'P2002',
        meta: { 
          target: ['email'],
          modelName: 'User',
        },
      };

      const result = handlePrismaError(prismaError);

      expect(result.details).toBeUndefined();
    });
  });

  describe('P2025 - Record not found', () => {
    it('should handle record not found error', () => {
      const prismaError = {
        code: 'P2025',
        meta: { cause: 'Record to update not found.' },
      };

      const result = handlePrismaError(prismaError);

      expect(result).toBeInstanceOf(AppError);
      expect(result.statusCode).toBe(404);
      expect(result.errorCode).toBe(ErrorCodes.RESOURCE_NOT_FOUND);
      expect(result.message).toBe('The requested record was not found.');
      expect(result.isOperational).toBe(true);
    });

    it('should handle record not found without meta', () => {
      const prismaError = {
        code: 'P2025',
      };

      const result = handlePrismaError(prismaError);

      expect(result.statusCode).toBe(404);
      expect(result.errorCode).toBe(ErrorCodes.RESOURCE_NOT_FOUND);
    });
  });

  describe('P2003 - Foreign key constraint violation', () => {
    it('should handle foreign key constraint error', () => {
      const prismaError = {
        code: 'P2003',
        meta: { 
          field_name: 'userId',
          modelName: 'Product',
        },
      };

      const result = handlePrismaError(prismaError);

      expect(result).toBeInstanceOf(AppError);
      expect(result.statusCode).toBe(400);
      expect(result.errorCode).toBe(ErrorCodes.BAD_REQUEST);
      expect(result.message).toBe('Invalid reference: the related record does not exist.');
      expect(result.isOperational).toBe(true);
    });
  });

  describe('P2011 - Required field missing', () => {
    it('should handle missing required field with column metadata', () => {
      const prismaError = {
        code: 'P2011',
        meta: { column: 'email' },
      };

      const result = handlePrismaError(prismaError);

      expect(result).toBeInstanceOf(AppError);
      expect(result.statusCode).toBe(400);
      expect(result.errorCode).toBe(ErrorCodes.VALIDATION_ERROR);
      expect(result.message).toBe('Missing required field: email');
      expect(result.isOperational).toBe(true);
    });

    it('should handle missing required field without metadata', () => {
      const prismaError = {
        code: 'P2011',
        meta: {},
      };

      const result = handlePrismaError(prismaError);

      expect(result.statusCode).toBe(400);
      expect(result.message).toBe('Missing required field: field');
    });
  });

  describe('Unknown/Generic database errors', () => {
    it('should handle unknown Prisma error code', () => {
      const prismaError = {
        code: 'P9999',
        message: 'Unknown database error',
      };

      const result = handlePrismaError(prismaError);

      expect(result).toBeInstanceOf(AppError);
      expect(result.statusCode).toBe(500);
      expect(result.errorCode).toBe(ErrorCodes.DATABASE_ERROR);
      expect(result.message).toBe('A database error occurred while processing your request.');
      expect(result.isOperational).toBe(false);
      expect(console.error).toHaveBeenCalledWith('[PrismaError]:', prismaError);
    });

    it('should handle error without code', () => {
      const prismaError = {
        message: 'Database connection failed',
      };

      const result = handlePrismaError(prismaError);

      expect(result.statusCode).toBe(500);
      expect(result.errorCode).toBe(ErrorCodes.DATABASE_ERROR);
      expect(result.isOperational).toBe(false);
    });

    it('should handle null error', () => {
      const result = handlePrismaError(null);

      expect(result).toBeInstanceOf(AppError);
      expect(result.statusCode).toBe(500);
      expect(result.errorCode).toBe(ErrorCodes.DATABASE_ERROR);
      expect(result.isOperational).toBe(false);
    });

    it('should handle undefined error', () => {
      const result = handlePrismaError(undefined);

      expect(result).toBeInstanceOf(AppError);
      expect(result.statusCode).toBe(500);
      expect(result.errorCode).toBe(ErrorCodes.DATABASE_ERROR);
      expect(result.isOperational).toBe(false);
    });
  });

  describe('Additional Prisma error codes', () => {
    it('should handle P2000 - Value too long for column', () => {
      const prismaError = {
        code: 'P2000',
        meta: { column_name: 'description' },
      };

      const result = handlePrismaError(prismaError);

      expect(result.statusCode).toBe(500);
      expect(result.errorCode).toBe(ErrorCodes.DATABASE_ERROR);
      expect(console.error).toHaveBeenCalled();
    });

    it('should handle P2001 - Record not found (where condition)', () => {
      const prismaError = {
        code: 'P2001',
        meta: { modelName: 'User' },
      };

      const result = handlePrismaError(prismaError);

      expect(result.statusCode).toBe(500);
      expect(result.errorCode).toBe(ErrorCodes.DATABASE_ERROR);
    });

    it('should handle P2004 - Constraint failed', () => {
      const prismaError = {
        code: 'P2004',
        meta: { database_error: 'constraint failed' },
      };

      const result = handlePrismaError(prismaError);

      expect(result.statusCode).toBe(500);
      expect(result.errorCode).toBe(ErrorCodes.DATABASE_ERROR);
    });

    it('should handle P2005 - Invalid value for field', () => {
      const prismaError = {
        code: 'P2005',
        meta: { 
          field_value: 'invalid-uuid',
          field_name: 'id',
        },
      };

      const result = handlePrismaError(prismaError);

      expect(result.statusCode).toBe(500);
      expect(result.errorCode).toBe(ErrorCodes.DATABASE_ERROR);
    });

    it('should handle P2006 - Invalid value provided', () => {
      const prismaError = {
        code: 'P2006',
        meta: { 
          field_name: 'status',
          field_value: 'INVALID_STATUS',
        },
      };

      const result = handlePrismaError(prismaError);

      expect(result.statusCode).toBe(500);
      expect(result.errorCode).toBe(ErrorCodes.DATABASE_ERROR);
    });

    it('should handle P2007 - Data validation error', () => {
      const prismaError = {
        code: 'P2007',
        meta: { database_error: 'validation failed' },
      };

      const result = handlePrismaError(prismaError);

      expect(result.statusCode).toBe(500);
      expect(result.errorCode).toBe(ErrorCodes.DATABASE_ERROR);
    });
  });

  describe('Error logging', () => {
    it('should log unknown errors to console', () => {
      const prismaError = {
        code: 'UNKNOWN',
        message: 'Something went wrong',
        meta: { details: 'Additional info' },
      };

      handlePrismaError(prismaError);

      expect(console.error).toHaveBeenCalledWith('[PrismaError]:', prismaError);
    });

    it('should log errors without code', () => {
      const prismaError = {
        message: 'No code provided',
        someOtherField: 'value',
      };

      handlePrismaError(prismaError);

      expect(console.error).toHaveBeenCalledWith('[PrismaError]:', prismaError);
    });
  });

  describe('Complex error scenarios', () => {
    it('should handle nested metadata', () => {
      const prismaError = {
        code: 'P2002',
        meta: {
          target: ['user.email'],
          modelName: 'User',
          details: {
            nested: {
              value: 'test@example.com',
            },
          },
        },
      };

      const result = handlePrismaError(prismaError);

      expect(result.statusCode).toBe(409);
      expect(result.message).toBe('A record with this user.email already exists.');
    });

    it('should handle array of targets', () => {
      const prismaError = {
        code: 'P2002',
        meta: {
          target: ['field1', 'field2', 'field3'],
        },
      };

      const result = handlePrismaError(prismaError);

      expect(result.message).toBe('A record with this field1, field2, field3 already exists.');
    });

    it('should handle error with additional properties', () => {
      const prismaError = {
        code: 'P2025',
        clientVersion: '4.0.0',
        batchRequestIdx: 2,
        meta: {
          cause: 'Record not found',
          modelName: 'Product',
        },
      };

      const result = handlePrismaError(prismaError);

      expect(result.statusCode).toBe(404);
      expect(result.errorCode).toBe(ErrorCodes.RESOURCE_NOT_FOUND);
    });
  });
});