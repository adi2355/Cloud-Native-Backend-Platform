/**
 * Middleware Type Helpers
 * Provides type-safe middleware composition for Express
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthenticatedRequest, OptionalAuthRequest, AdminRequest } from './authenticated-request.types';

/**
 * Authentication middleware that transforms Request -> AuthenticatedRequest
 */
export type AuthMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => void | Promise<void>;

/**
 * Handler that expects an authenticated request
 */
export type AuthenticatedHandler = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => void | Promise<void>;

/**
 * Handler that expects an admin request
 */
export type AdminHandler = (
  req: AdminRequest,
  res: Response,
  next: NextFunction
) => void | Promise<void>;

/**
 * Helper to create a typed route handler that expects authentication
 */
export const withAuth = (handler: AuthenticatedHandler): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    // After authentication middleware, we know req has user property
    return handler(req as AuthenticatedRequest, res, next);
  };
};

/**
 * Helper to create a typed route handler that expects admin authentication
 */
export const withAdmin = (handler: AdminHandler): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    // After authentication + admin middleware, we know req has admin user
    return handler(req as AdminRequest, res, next);
  };
};

/**
 * Utility type for middleware chains
 */
export type MiddlewareChain = Array<RequestHandler | AuthMiddleware>;



























