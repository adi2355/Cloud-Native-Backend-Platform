/**
 * Request type definitions for authenticated endpoints
 * Provides type safety for Express requests with authentication context
 */

import { Request } from 'express';
import { Server } from 'socket.io';
import { UserContext } from './auth.types';

/**
 * Authenticated request interface for routes that require authentication
 * This interface guarantees that user context is available (non-optional)
 */
export interface AuthenticatedRequest extends Request {
  user: UserContext; // Non-optional for authenticated routes
  requestId: string;
  correlationId: string;
  io?: Server; // Socket.io instance for real-time events
}

/**
 * Optional authenticated request interface for routes that may have authentication
 * Use this when authentication is optional but you still need type safety
 */
export interface OptionallyAuthenticatedRequest extends Request {
  user?: UserContext; // Optional for routes where auth is not required
  requestId: string;
  correlationId: string;
  io?: Server; // Socket.io instance
}