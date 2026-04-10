/**
 * Express Type Extensions
 * Extends Express types with custom properties
 * 
 * This file provides global extensions for Express Request interface
 * for backward compatibility. For type-safe request handling, use the 
 * typed request interfaces from authenticated-request.types.ts
 * 
 * Authentication Boundary Pattern:
 * - Routes with authenticate middleware guarantee req.user is populated
 * - Controllers can trust middleware boundaries without manual checks
 * - Use AuthenticatedRequest type for compile-time safety
 * - No withAuth wrapper needed when authenticate middleware is present
 */

import { UserContext, AuthToken } from './auth.types';
import { Request as ExpressRequest } from 'express';
import { Multer } from 'multer';
import type { Server as SocketIOServer } from 'socket.io';

declare global {
  namespace Express {
    interface Request {
      user?: UserContext;
      userId?: string;
      userContext?: UserContext;
      authToken?: AuthToken;
      requestId?: string;
      correlationId?: string;
      requestStartTime?: number;
      sessionId?: string;
      sessionID?: string; // Express session compatibility
      deviceId?: string;
      io?: SocketIOServer; // Socket.io server instance - type-safe
      file?: Multer.File;
      files?: Multer.File[] | { [fieldname: string]: Multer.File[] };
    }
  }
}

// Ensure this is treated as a module
export {};