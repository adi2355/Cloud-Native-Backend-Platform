/**
 * WebSocket Management Controller
 * Handles HTTP requests for WebSocket service monitoring and management
 */

import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../../types/authenticated-request.types';
import { getUserId, getCorrelationId, getRouteParam } from '../../../utils/auth-guards';
import { SocketService } from '../../../websocket/socket.service';
import { ApiResponse } from '../../../models';
import { LoggerService } from '../../../services/logger.service';
import { AppError } from '../../../utils/AppError';
import { getErrorMessage, getErrorStack } from '../../../utils/error-handler';

export class WebSocketController {
  /**
   * Constructor with explicit dependency injection (Pure DI - no singleton)
   * All dependencies are required and injected by bootstrap.ts
   */
  public constructor(
    private socketService: SocketService,
    private logger: LoggerService,
  ) {
    // Pure constructor injection - all dependencies provided by bootstrap.ts
    if (!socketService || !logger) {
      throw new Error('WebSocketController: All dependencies (SocketService, LoggerService) must be provided');
    }
  }

  /**
   * Get WebSocket service health status
   * GET /api/v1/websocket/health
   */
  public async getHealthStatus(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const healthStatus = this.socketService.getHealthStatus();
      const correlationId = getCorrelationId(req);

      this.logger.debug('WebSocket health status requested', {
        context: 'WebSocketController',
        status: healthStatus.status,
        correlationId,
      });

      res.json({
        success: true,
        data: healthStatus,
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: correlationId,
        },
      } as ApiResponse);
    } catch (error) {
      this.logger.error('Failed to get WebSocket health status', {
        context: 'WebSocketController',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  /**
   * Get WebSocket connection statistics
   * GET /api/v1/websocket/stats
   */
  public async getConnectionStats(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const correlationId = getCorrelationId(req);
      
      const stats = {
        connectedUsers: this.socketService.getConnectedUsersCount(),
        activeSessions: this.socketService.getActiveSessionsCount(),
        totalConnections: this.socketService.getConnectedUsersCount(), // This could be enhanced to track total sockets
        uptime: process.uptime(),
        status: 'operational',
      };

      this.logger.debug('WebSocket stats requested', {
        context: 'WebSocketController',
        stats,
        correlationId,
      });

      res.json({
        success: true,
        data: stats,
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: correlationId,
        },
      } as ApiResponse);
    } catch (error) {
      this.logger.error('Failed to get WebSocket stats', {
        context: 'WebSocketController',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  /**
   * Check if a user is online
   * GET /api/v1/websocket/users/:userId/status
   */
  public async getUserOnlineStatus(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getRouteParam(req, 'userId');
      const requesterId = getUserId(req);
      const correlationId = getCorrelationId(req);

      // Only allow checking own status or admin users
      if (requesterId !== userId) {
        throw AppError.forbidden('You can only check your own online status');
      }

      const isOnline = this.socketService.isUserOnline(userId);
      const userSockets = this.socketService.getUserSockets(userId);

      res.json({
        success: true,
        data: {
          userId,
          isOnline,
          connectionCount: userSockets?.size || 0,
          checkedAt: new Date().toISOString(),
        },
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: correlationId,
        },
      } as ApiResponse);
    } catch (error) {
      this.logger.error('Failed to check user online status', {
        context: 'WebSocketController',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
        userId: req.params.userId,
      });
      next(error);
    }
  }

  /**
   * Validate JWT token for WebSocket authentication
   * POST /api/v1/websocket/validate-token
   */
  public async validateToken(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const { token } = req.body;
      const correlationId = getCorrelationId(req);

      if (!token || typeof token !== 'string') {
        throw AppError.validation('Token is required');
      }

      const validation = this.socketService.validateToken(token);

      // Don't expose the decoded token data for security
      const responseData = {
        valid: validation.valid,
        error: validation.error,
        validatedAt: new Date().toISOString(),
      };

      if (!validation.valid) {
        this.logger.warn('Invalid WebSocket token validation attempt', {
          context: 'WebSocketController',
          error: validation.error,
          correlationId,
        });
      }

      res.json({
        success: true,
        data: responseData,
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: correlationId,
        },
      } as ApiResponse);
    } catch (error) {
      this.logger.error('Failed to validate WebSocket token', {
        context: 'WebSocketController',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  /**
   * Send a message to a specific user via WebSocket
   * POST /api/v1/websocket/users/:userId/message
   */
  public async sendUserMessage(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = getRouteParam(req, 'userId');
      const { event, data } = req.body;
      const senderId = getUserId(req);
      const correlationId = getCorrelationId(req);

      if (!event || !data) {
        throw AppError.validation('Event and data are required');
      }

      // Add sender information to the message
      const messageData = {
        ...data,
        from: senderId,
        timestamp: new Date().toISOString(),
        correlationId,
      };

      this.socketService.emitToUser(userId, event, messageData);

      this.logger.info('Message sent via WebSocket', {
        context: 'WebSocketController',
        targetUserId: userId,
        senderId,
        event,
        correlationId,
      });

      res.json({
        success: true,
        data: {
          message: 'Message sent successfully',
          targetUserId: userId,
          event,
          sentAt: new Date().toISOString(),
        },
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: correlationId,
        },
      } as ApiResponse);
    } catch (error) {
      this.logger.error('Failed to send WebSocket message', {
        context: 'WebSocketController',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
        targetUserId: req.params.userId,
      });
      next(error);
    }
  }

  /**
   * Broadcast a message to all connected users
   * POST /api/v1/websocket/broadcast
   */
  public async broadcastMessage(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const { event, data, target, roomId } = req.body;
      const senderId = getUserId(req);
      const correlationId = getCorrelationId(req);

      if (!event || !data) {
        throw AppError.validation('Event and data are required');
      }

      // Add metadata to broadcast
      const broadcastData = {
        ...data,
        from: 'system',
        broadcastBy: senderId,
        timestamp: new Date().toISOString(),
        correlationId,
      };

      // Handle different broadcast targets
      if (target === 'room' && roomId) {
        this.socketService.emitToSession(roomId, event, broadcastData);
        this.logger.info('Message broadcasted to room via WebSocket', {
          context: 'WebSocketController',
          senderId,
          event,
          roomId,
          correlationId,
        });
      } else {
        this.socketService.broadcast(event, broadcastData);
        this.logger.info('Message broadcasted via WebSocket', {
          context: 'WebSocketController',
          senderId,
          event,
          target: target || 'all',
          connectedUsers: this.socketService.getConnectedUsersCount(),
          correlationId,
        });
      }

      res.json({
        success: true,
        data: {
          message: 'Message broadcasted successfully',
          event,
          target: target || 'all',
          roomId,
          connectedUsers: this.socketService.getConnectedUsersCount(),
          broadcastAt: new Date().toISOString(),
        },
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: correlationId,
        },
      } as ApiResponse);
    } catch (error) {
      this.logger.error('Failed to broadcast WebSocket message', {
        context: 'WebSocketController',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  /**
   * Get active WebSocket connections count
   * GET /api/v1/websocket/connections
   */
  public async getConnectionCount(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const correlationId = getCorrelationId(req);
      
      const connectionStats = {
        total: this.socketService.getConnectedUsersCount(),
        authenticated: this.socketService.getConnectedUsersCount(), // All connections are authenticated
        anonymous: 0, // We don't allow anonymous connections
        activeSessions: this.socketService.getActiveSessionsCount(),
        timestamp: new Date().toISOString(),
      };

      this.logger.debug('WebSocket connection count requested', {
        context: 'WebSocketController',
        stats: connectionStats,
        correlationId,
      });

      res.json({
        success: true,
        data: connectionStats,
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: correlationId,
        },
      } as ApiResponse);
    } catch (error) {
      this.logger.error('Failed to get connection count', {
        context: 'WebSocketController',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  /**
   * Get active WebSocket sessions
   * GET /api/v1/websocket/sessions
   */
  public async getActiveSessions(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const { userId, roomId } = req.query;
      const correlationId = getCorrelationId(req);

      // Since we don't have direct access to socket sessions from SocketService,
      // we'll return a summary instead
      const sessionsSummary = {
        totalSessions: this.socketService.getActiveSessionsCount(),
        connectedUsers: this.socketService.getConnectedUsersCount(),
        // If filtering by userId, check if user is online
        userStatus: userId ? {
          userId: userId as string,
          isOnline: this.socketService.isUserOnline(userId as string),
          sockets: this.socketService.getUserSockets(userId as string)?.size || 0,
        } : undefined,
        timestamp: new Date().toISOString(),
      };

      this.logger.debug('Active sessions requested', {
        context: 'WebSocketController',
        userId,
        roomId,
        summary: sessionsSummary,
        correlationId,
      });

      res.json({
        success: true,
        data: sessionsSummary,
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: correlationId,
        },
      } as ApiResponse);
    } catch (error) {
      this.logger.error('Failed to get active sessions', {
        context: 'WebSocketController',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      next(error);
    }
  }

  // REMOVED: Duplicate of sendUserMessage method above

  /**
   * Manage room membership
   * POST /api/v1/websocket/room
   */
  public async manageRoom(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const { userId, roomId, action } = req.body;
      const adminId = getUserId(req);
      const correlationId = getCorrelationId(req);

      if (!userId || !roomId || !action) {
        throw AppError.validation('userId, roomId and action are required');
      }

      // Check if user is online
      if (!this.socketService.isUserOnline(userId)) {
        throw AppError.notFound('User is not connected');
      }

      // Note: The current SocketService doesn't expose methods to manage room membership
      // from outside the WebSocket connection. This would need to be added to SocketService
      // For now, we'll send a command to the user to join/leave the room
      
      const roomCommand = {
        command: action === 'join' ? 'JOIN_ROOM' : 'LEAVE_ROOM',
        roomId,
        initiatedBy: adminId,
        timestamp: new Date().toISOString(),
      };

      this.socketService.emitToUser(userId, 'room:command', roomCommand);

      this.logger.info('Room management command sent', {
        context: 'WebSocketController',
        userId,
        roomId,
        action,
        adminId,
        correlationId,
      });

      res.json({
        success: true,
        data: {
          message: `Room ${action} command sent successfully`,
          userId,
          roomId,
          action,
          sentAt: new Date().toISOString(),
        },
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: correlationId,
        },
      } as ApiResponse);
    } catch (error) {
      this.logger.error('Failed to manage room', {
        context: 'WebSocketController',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
        userId: req.body.userId,
        roomId: req.body.roomId,
      });
      next(error);
    }
  }

  /**
   * Force disconnect a user
   * POST /api/v1/websocket/disconnect
   */
  public async disconnectUser(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const { userId, reason } = req.body;
      const adminId = getUserId(req);
      const correlationId = getCorrelationId(req);

      if (!userId) {
        throw AppError.validation('userId is required');
      }

      // Check if user is online
      if (!this.socketService.isUserOnline(userId)) {
        throw AppError.notFound('User is not connected');
      }

      // Send disconnect command to the user
      const disconnectCommand = {
        command: 'FORCE_DISCONNECT',
        reason: reason || 'Disconnected by administrator',
        initiatedBy: adminId,
        timestamp: new Date().toISOString(),
      };

      this.socketService.emitToUser(userId, 'disconnect:force', disconnectCommand);

      this.logger.warn('User force disconnected', {
        context: 'WebSocketController',
        userId,
        reason,
        adminId,
        correlationId,
      });

      res.json({
        success: true,
        data: {
          message: 'User disconnect command sent successfully',
          userId,
          reason: reason || 'Disconnected by administrator',
          disconnectedAt: new Date().toISOString(),
        },
        metadata: {
          timestamp: new Date().toISOString(),
          requestId: correlationId,
        },
      } as ApiResponse);
    } catch (error) {
      this.logger.error('Failed to disconnect user', {
        context: 'WebSocketController',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
        userId: req.body.userId,
      });
      next(error);
    }
  }
}
