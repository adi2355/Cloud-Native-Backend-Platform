/**
 * Authenticated Request Types for AppPlatform Backend
 *
 * Provides type-safe interfaces for Express requests with authentication context.
 * Eliminates the need for unsafe (req as any) type assertions across controllers.
 *
 * @see https://expressjs.com/en/guide/using-middleware.html
 * @see ../api/v1/middleware/auth.middleware.ts
 */

import { Request } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { UserContext } from './auth.types';

/**
 * Request interface for routes that REQUIRE authentication
 * All properties are guaranteed to exist after auth middleware validation
 */
export interface AuthenticatedRequest extends Request {
  /** User context - guaranteed to exist after authenticate middleware */
  user: UserContext;
  /** User ID - guaranteed to exist after authenticate middleware */  
  userId: string;
  /** Request ID for tracing - set by correlationContext middleware */
  requestId: string;
  /** Correlation ID for distributed tracing */
  correlationId?: string;
  /** User context (legacy compatibility) */
  userContext?: UserContext;
  /** Request start time for performance tracking */
  requestStartTime?: number;
  /** Session ID (if using session middleware) */
  sessionId?: string;
  /** Device ID (for device-specific operations) */
  deviceId?: string;
  /** Socket.io instance (for real-time operations) */
  io?: SocketIOServer;
}

/**
 * Request interface for routes with OPTIONAL authentication
 * User properties may be undefined if no authentication provided
 */
export interface OptionalAuthRequest extends Request {
  /** User context - may be undefined if not authenticated */
  user?: UserContext;
  /** User ID - may be undefined if not authenticated */
  userId?: string;
  /** Request ID for tracing - set by correlationContext middleware */
  requestId: string;
  /** Correlation ID for distributed tracing */
  correlationId?: string;
  /** User context (legacy compatibility) */
  userContext?: UserContext;
  /** Request start time for performance tracking */
  requestStartTime?: number;
  /** Session ID (if using session middleware) */
  sessionId?: string;
  /** Device ID (for device-specific operations) */
  deviceId?: string;
  /** Socket.io instance (for real-time operations) */
  io?: SocketIOServer;
}

/**
 * Request interface for admin-only routes
 * Extends AuthenticatedRequest with admin role validation
 */
export interface AdminRequest extends AuthenticatedRequest {
  user: UserContext & {
    roles: string[];
    isAdmin?: boolean;
  };
}

/**
 * Request interface for WebSocket-enabled routes
 * Includes Socket.io instance for real-time communication
 */
export interface WebSocketRequest extends AuthenticatedRequest {
  io: SocketIOServer; // Socket.io instance
}

/**
 * Request interface for file upload operations
 * Includes Multer file handling (file/files properties inherited from Express.Request via Multer)
 */
export interface FileUploadRequest extends AuthenticatedRequest {
  // Note: file and files properties are already defined in Express.Request via @types/multer
  // No need to redeclare them here - they're available through inheritance
}

/**
 * Type guard to check if request has authenticated user
 */
export type RequestWithAuth = AuthenticatedRequest | OptionalAuthRequest;

/**
 * Union type for all possible request types
 */
export type TypedRequest = 
  | AuthenticatedRequest 
  | OptionalAuthRequest 
  | AdminRequest 
  | WebSocketRequest 
  | FileUploadRequest;