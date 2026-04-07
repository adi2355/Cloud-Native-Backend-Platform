/**
 * Socket.IO Type Extensions
 * Extends Socket.IO Socket interface with typed socket.data properties
 *
 * This ensures type safety when accessing socket.data.* properties
 * and prevents implicit 'any' type violations.
 *
 * Pattern follows Express.Request extension pattern from express.d.ts
 */

import { Socket as SocketIOSocket } from 'socket.io';

/**
 * User context stored in socket.data after authentication
 */
export interface SocketUserContext {
  userId: string;
  deviceId: string;
  sessionId?: string;
  status?: 'online' | 'away' | 'busy' | 'offline';
  authenticatedAt: string;
  clientIp: string;
}

/**
 * Extend Socket.IO's Socket interface to add typed socket.data
 */
declare module 'socket.io' {
  interface Socket {
    data: SocketUserContext;
  }
}

// Ensure this is treated as a module
export {};
