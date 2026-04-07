/**
 * WebSocket Service
 * Handles real-time communication for live sessions and data synchronization
 * 
 * Security Features:
 * - Dynamic JWT secret loaded from AWS Secrets Manager via ConfigSecurityService
 * - Robust token verification with proper error handling
 * - Fail-fast configuration validation to prevent insecure startups
 * 
 * Dependencies:
 * - JWT secret must be loaded from centralized config (config.jwt.secret)
 * - Requires proper initialization via configure() before initialize()
 */

import { Server, Socket } from 'socket.io';
import { Server as HTTPServer } from 'http';
import * as jwt from 'jsonwebtoken';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { Prisma } from '@prisma/client';
import { LoggerService } from '../services/logger.service';
import { CognitoService } from '../services/cognito.service';
import { WebSocketEventRepository } from '../repositories/websocket-event.repository';
import { LiveConsumptionRepository } from '../repositories/live-consumption.repository';
import { SessionMessageRepository } from '../repositories/session-message.repository';
import { SessionRepository } from '../repositories/session.repository';
import { UserRepository } from '../repositories/user.repository';
import { v4 as uuidv4 } from 'uuid';
import { getErrorMessage, getErrorStack } from '../utils/error-handler';
import { JwtSecretValidator, JwtValidationResult } from '../utils/jwt-validation.utils';
import type { JwtPayload } from 'jsonwebtoken';

// Type Definitions for WebSocket Events

interface SocketUser {
  userId: string;
  deviceId?: string;
  sessionId?: string;
  status?: string;
}

interface SocketServiceConfig {
  jwtSecret: string;
  clientUrl?: string;
  corsOrigins?: string[];
  redis?: RedisConfig;
  enableHorizontalScaling?: boolean;
  // WebSocket configuration
  pingTimeout?: number;
  pingInterval?: number;
}

interface RedisConfig {
  url?: string;     // Preferred: Redis URL for proper authentication
  host?: string;
  port?: number;
  username?: string; // Redis 6+ ACL username (Render managed Redis)
  password?: string;
  db?: number;
}

// Session Event Payloads
interface SessionStartData {
  sessionId?: string;
  purchaseId?: string;
  deviceId?: string;
  clientSessionId?: string;
  metadata?: Record<string, unknown>;
}

interface SessionJoinData {
  sessionId: string;
  role?: 'host' | 'participant';
}

interface SessionUpdateData {
  sessionId: string;
  updates: {
    eventCount?: number;
    totalDurationMs?: number;
    sessionTypeHeuristic?: string;
  };
}

interface SessionEndData {
  sessionId: string;
  reason?: string;
  finalStats?: {
    eventCount: number;
    totalDurationMs: number;
  };
}

interface SessionLeaveData {
  sessionId: string;
}

interface SessionMessageData {
  text: string;
  metadata?: Record<string, unknown>;
}

// Consumption Event Payloads
interface LiveConsumptionData {
  hitDurationMs: number;
  intensity?: number;
  deviceData?: Record<string, unknown>;
  timestamp?: string;
}

interface ConsumptionRateData {
  rate: number; // events per minute
  timestamp?: string;
}

// Sync Event Payloads
interface SyncRequestData {
  entities?: string[];
  lastSyncTimestamp?: number;
  deviceId?: string;
}

interface SyncPushData {
  changes: Array<{
    entityType: string;
    entityId: string;
    operation: 'CREATE' | 'UPDATE' | 'DELETE';
    data?: Record<string, unknown>;
    timestamp: number;
  }>;
  syncId?: string;
}

// User Interaction Event Payloads
interface TypingIndicatorData {
  isTyping: boolean;
}

interface ReactionData {
  targetId: string; // ID of message/consumption being reacted to
  type: 'like' | 'love' | 'fire' | 'celebrate';
}

interface UserStatusData {
  status: 'online' | 'away' | 'busy' | 'offline';
}

// Database Types
interface SessionStateData {
  id: string;
  userId: string;
  sessionStartTimestamp: Date;
  sessionEndTimestamp?: Date;
  eventCount: number;
  totalDurationMs: number;
  avgEventDurationMs: number;
  sessionTypeHeuristic?: string;
  createdAt: Date;
  updatedAt: Date;
}

// JWT Payload Type
interface DecodedJWTPayload extends JwtPayload {
  userId: string;
  deviceId?: string;
  [key: string]: unknown;
}

export class SocketService {
  private io: Server | null = null;
  private userSockets: Map<string, Set<string>> = new Map();
  private sessionRooms: Map<string, Set<string>> = new Map();
  private config: SocketServiceConfig | null = null;
  private isInitialized: boolean = false;
  private pubClient: Redis | null = null;
  private subClient: Redis | null = null;
  private cachedJwtValidation: JwtValidationResult | null = null;

  /**
   * Constructor with explicit dependency injection (Pure DI - no singleton)
   * All dependencies are required and injected by bootstrap.ts
   *
   *  FIXED: Uses Repository Pattern instead of direct DatabaseService.query()
   *  SECURITY FIX: CognitoService injected for consistent JWT validation with HTTP API
   *    This ensures WebSocket userId matches HTTP API userId for consistency
   */
  public constructor(
    private logger: LoggerService,
    private cognitoService: CognitoService,
    private userRepository: UserRepository,
    private webSocketEventRepository: WebSocketEventRepository,
    private liveConsumptionRepository: LiveConsumptionRepository,
    private sessionMessageRepository: SessionMessageRepository,
    private sessionRepository: SessionRepository,
  ) {
    // Lightweight constructor - all dependencies injected explicitly
    // No internal service resolution, no getInstance() calls
    // All database operations go through repositories (Repository Pattern)
    // CognitoService used for JWT validation (same as HTTP middleware)
    // UserRepository used for Cognito sub → internal userId mapping
  }

  /**
   * Configure the service with secure configuration
   * Must be called before initialize()
   * 
   * Security Requirements:
   * - jwtSecret must be a non-empty string (loaded from AWS Secrets Manager)
   * - jwtSecret must meet minimum security standards using JwtSecretValidator
   */
  public async configure(config: SocketServiceConfig): Promise<void> {
    try {
      // Dependencies are already injected via constructor

      // Validate JWT secret once and cache the result
      // This avoids duplicate validation logs during startup
      const validation = JwtSecretValidator.validate(config.jwtSecret, this.logger, 'WebSocket JWT Secret');
      
      // Fail fast if validation fails
      if (!validation.isValid) {
        throw new Error(`WebSocket JWT secret validation failed: ${validation.errors.join(', ')}`);
      }
      
      this.config = config;
      this.cachedJwtValidation = validation; // Cache for health checks
      
      // Log successful configuration with security metrics (no duplicate validation call)
      this.logger.info('SocketService configured successfully with secure JWT authentication', { 
        context: 'SocketService',
        corsOriginsCount: config.corsOrigins?.length || 0,
        jwtSecretConfigured: true,
        jwtSecretLength: config.jwtSecret.length,
        securityScore: validation.securityScore,
        validationWarnings: validation.warnings,
      });
      
    } catch (error) {
      this.logger.error('SocketService configuration failed - JWT secret validation failed', { 
        context: 'SocketService',
        error: error instanceof Error ? error.message : 'Unknown error',
        hasJwtSecret: !!config.jwtSecret,
        jwtSecretType: typeof config.jwtSecret,
      });
      throw error; // Re-throw validation error to fail fast
    }
  }

  /**
   * Initialize WebSocket server with optional Redis adapter for horizontal scaling
   */
  public async initialize(httpServer: HTTPServer): Promise<void> {
    if (!this.config) {
      throw new Error('SocketService must be configured before initialization. Call configure() first.');
    }

    // Determine CORS origins based on environment and configuration
    const isProduction = process.env.NODE_ENV === 'production';
    const isDevelopment = process.env.NODE_ENV === 'development';
    
    // Get configured origins or use safe defaults
    let corsOrigin: string[] | boolean = this.config.corsOrigins || [];
    
    // Filter out wildcards and localhost in production
    if (isProduction) {
      // In production, strictly use configured origins, no wildcards
      corsOrigin = corsOrigin.filter(origin => 
        origin !== '*' && 
        !origin.includes('localhost') && 
        !origin.includes('127.0.0.1') &&
        !origin.includes('0.0.0.0'),
      );
      
      // If no valid origins after filtering, throw error in production
      if (corsOrigin.length === 0) {
        const error = new Error('No valid CORS origins configured for production. Configure specific allowed origins.');
        this.logger.error('WebSocket CORS configuration error', {
          context: 'SocketService',
          environment: 'production',
          configuredOrigins: this.config.corsOrigins,
          error: error.message,
        });
        throw error;
      }
      
      this.logger.info('WebSocket CORS origins configured for production', {
        context: 'SocketService',
        allowedOrigins: corsOrigin,
        filteredCount: (this.config.corsOrigins?.length || 0) - corsOrigin.length,
      });
    } else if (isDevelopment) {
      // In development, allow configured origins or localhost fallback
      if (corsOrigin.length === 0) {
        corsOrigin = ['http://localhost:3000', 'http://localhost:8081', 'exp://'];
        this.logger.warn('No CORS origins configured, using development defaults', {
          context: 'SocketService',
          defaultOrigins: corsOrigin,
        });
      }
    } else {
      // Test or other environments - use configured or minimal defaults
      if (corsOrigin.length === 0) {
        corsOrigin = ['http://localhost:3000'];
      }
    }
    
    // Log security warning if wildcard was attempted in production
    if (isProduction && this.config.corsOrigins?.includes('*')) {
      this.logger.error('SECURITY WARNING: Wildcard CORS origin (*) detected in production configuration', {
        context: 'SocketService',
        severity: 'CRITICAL',
        action: 'Wildcard origin has been filtered out',
      });
    }
    
    // Initialize Redis clients for Socket.IO adapter if horizontal scaling is enabled
    if (this.config.enableHorizontalScaling && this.config.redis) {
      try {
        // Check if we have a Redis URL (preferred) or fall back to individual components
        type RedisConnectionConfig = string | {
          host: string;
          port: number;
          password?: string;
          db?: number;
          tls?: Record<string, unknown>;
          maxRetriesPerRequest: null;
          retryDelayOnFailover?: number;
          enableReadyCheck: boolean;
        };

        let redisConnectionConfig: RedisConnectionConfig;

        if (this.config.redis.url) {
          // Use URL directly - same approach as CacheService
          this.logger.debug('ioredis Socket.IO adapter using direct URL (same as CacheService):', {
            context: 'SocketService',
            method: 'url-direct',
            urlProtocol: this.config.redis.url.split('://')[0],
            hasCredentials: this.config.redis.url.includes('@')
          });

          redisConnectionConfig = this.config.redis.url;
        } else {
          // Fallback to individual components (legacy approach)
          this.logger.debug('ioredis Socket.IO adapter using individual components:', {
            context: 'SocketService',
            method: 'individual-components',
            host: this.config.redis.host || 'localhost',
            port: this.config.redis.port || 6379,
            passwordPresent: !!this.config.redis.password,
            db: this.config.redis.db
          });

          redisConnectionConfig = {
            host: this.config.redis.host || 'localhost',
            port: this.config.redis.port || 6379,
            ...(this.config.redis.username && { username: this.config.redis.username }), // Redis 6+ ACL username (Render managed Redis)
            ...(this.config.redis.password && { password: this.config.redis.password }),
            ...(this.config.redis.db && { db: this.config.redis.db }),
            // TLS support for managed Redis services (Render, AWS ElastiCache, etc.)
            tls: {},
            maxRetriesPerRequest: null, // Disable retries for Socket.IO adapter
            retryDelayOnFailover: 100,
            enableReadyCheck: false,
          };
        }
        
        // Create Redis clients using the same approach as CacheService
        if (typeof redisConnectionConfig === 'string') {
          // URL approach - same as CacheService
          this.pubClient = new Redis(redisConnectionConfig, {
            tls: {},
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
          });
        } else {
          // Individual components approach - redisConnectionConfig already has retryDelayOnFailover
          this.pubClient = new Redis(redisConnectionConfig);
        }
        
        this.subClient = this.pubClient.duplicate();
        
        // ioredis automatically connects, but we wait for the connection to be ready
        await Promise.all([
          this.pubClient.ping(),
          this.subClient.ping(),
        ]);
        
        this.pubClient.on('error', (err) => {
          this.logger.error('Redis PubClient Error', { 
            context: 'SocketService',
            error: err.message,
            stack: err.stack,
          });
        });
        
        this.subClient.on('error', (err) => {
          this.logger.error('Redis SubClient Error', {
            context: 'SocketService',
            error: err.message,
            stack: err.stack,
          });
        });
        
        this.logger.info('Redis clients for Socket.IO adapter connected', {
          context: 'SocketService',
          host: this.config.redis.host || 'localhost',
          port: this.config.redis.port || 6379,
        });
      } catch (error) {
        this.logger.error('Failed to connect Redis for Socket.IO adapter', {
          context: 'SocketService',
          error: getErrorMessage(error),
          stack: getErrorStack(error),
        });
        // Continue without Redis adapter - single instance mode
        this.pubClient = null;
        this.subClient = null;
      }
    }
    
    this.io = new Server(httpServer, {
      cors: {
        origin: corsOrigin,
        credentials: true,
        methods: ['GET', 'POST'],
      },
      transports: ['websocket', 'polling'],
      pingTimeout: this.config.pingTimeout || 60000,  // Configurable, defaults to 60 seconds
      pingInterval: this.config.pingInterval || 25000, // Configurable, defaults to 25 seconds
    });
    
    // Configure Socket.IO to use Redis adapter for horizontal scaling
    if (this.pubClient && this.subClient) {
      this.io.adapter(createAdapter(this.pubClient, this.subClient));
      this.logger.info('Socket.IO configured with Redis adapter for horizontal scaling', {
        context: 'SocketService',
      });
    } else {
      this.logger.warn('Socket.IO running in single-instance mode. Horizontal scaling disabled', {
        context: 'SocketService',
        reason: !this.config.enableHorizontalScaling ? 'Not enabled in config' : 'Redis connection failed',
      });
    }

    // Enhanced Authentication middleware with comprehensive security checks
    //  SECURITY FIX: Use CognitoService for JWT validation (same as HTTP middleware)
    this.io.use(async (socket, next) => {
      const startTime = Date.now();
      const clientIp = socket.handshake.address;
      const userAgent = socket.handshake.headers['user-agent'];

      try {
        // Extract token from auth object or Authorization header
        const token = socket.handshake.auth.token ||
          socket.handshake.headers.authorization?.replace(/^Bearer\s+/, '');

        if (!token || typeof token !== 'string') {
          this.logger.warn('WebSocket authentication failed - no valid token provided', {
            context: 'SocketService',
            clientIp,
            userAgent,
            hasAuthToken: !!socket.handshake.auth.token,
            hasAuthHeader: !!socket.handshake.headers.authorization,
            tokenType: typeof token,
          });
          return next(new Error('Authentication token required'));
        }

        // This validates Cognito-signed JWTs (same as HTTP API middleware)
        // Previously used custom JWT_SECRET which failed for Cognito tokens
        this.logger.debug('Validating Cognito JWT token for WebSocket connection', {
          context: 'SocketService',
          tokenLength: token.length,
          tokenPrefix: token.substring(0, 30) + '...',
          clientIp,
        });

        const validationResult = await this.cognitoService.validateToken(token);

        if (!validationResult.isValid || !validationResult.user) {
          this.logger.warn('WebSocket authentication failed - Cognito token validation failed', {
            context: 'SocketService',
            error: validationResult.error,
            errorCode: validationResult.errorCode,
            clientIp,
            userAgent,
            authDurationMs: Date.now() - startTime,
          });
          return next(new Error(validationResult.error || 'Authentication failed'));
        }

        // Extract Cognito sub from validated token
        const cognitoSub = validationResult.user.id;
        const username = validationResult.user.username;

        // This ensures WebSocket userId matches HTTP API userId (same as auth.middleware.ts)
        // Without this mapping, frontend receives Cognito sub but expects internal DB user ID,
        // causing a userId mismatch that triggers disconnect → reconnect loop
        const internalUser = await this.userRepository.findByCognitoSub(cognitoSub);

        if (!internalUser) {
          this.logger.error('WebSocket authentication failed - User not found in internal database', {
            context: 'SocketService',
            cognitoSub,
            username,
            clientIp,
            userAgent,
            authDurationMs: Date.now() - startTime,
          });
          return next(new Error('User not found. Please complete account setup.'));
        }

        // Store user data in socket with INTERNAL database user ID (not Cognito sub)
        socket.data.userId = internalUser.id;
        socket.data.cognitoSub = cognitoSub;  // Store Cognito sub separately for reference
        socket.data.username = username;
        socket.data.deviceId = socket.handshake.auth.deviceId || `unknown-${Date.now()}`;
        socket.data.authenticatedAt = new Date().toISOString();
        socket.data.clientIp = clientIp;
        socket.data.tokenType = 'cognito'; // Track that this is a Cognito token

        const authDuration = Date.now() - startTime;
        this.logger.info('WebSocket authentication successful with Cognito JWT', {
          context: 'SocketService',
          internalUserId: socket.data.userId,
          cognitoSub: socket.data.cognitoSub,
          username: socket.data.username,
          deviceId: socket.data.deviceId,
          clientIp,
          authDurationMs: authDuration,
          tokenExp: validationResult.payload?.exp ? new Date(validationResult.payload.exp * 1000).toISOString() : 'unknown',
        });

        next();
      } catch (err) {
        const authDuration = Date.now() - startTime;

        // Enhanced error logging with security context
        this.logger.error('WebSocket authentication failed - unexpected error', {
          context: 'SocketService',
          error: getErrorMessage(err),
          stack: getErrorStack(err),
          clientIp,
          userAgent,
          authDurationMs: authDuration,
        });

        next(new Error('Authentication failed'));
      }
    });

    // Connection handling
    this.io.on('connection', (socket) => {
      this.handleConnection(socket);
    });

    this.isInitialized = true;
    this.logger.info('WebSocket service initialized', { context: 'SocketService' });
  }

  /**
   * Handle new socket connection
   */
  private handleConnection(socket: Socket): void {
    const userId = socket.data.userId;
    const deviceId = socket.data.deviceId;

    this.logger.info(`User connected: ${userId}, Socket: ${socket.id}`, { context: 'SocketService' });

    // Track user sockets
    if (!this.userSockets.has(userId)) {
      this.userSockets.set(userId, new Set());
    }
    this.userSockets.get(userId)?.add(socket.id);

    // Join user room
    socket.join(`user:${userId}`);
    if (deviceId) {
      socket.join(`device:${deviceId}`);
    }

    // Register event handlers
    this.registerEventHandlers(socket);

    // Send connection confirmation
    socket.emit('connected', {
      socketId: socket.id,
      userId,
      deviceId,
      serverTime: new Date().toISOString(),
    });

    // Handle disconnection
    socket.on('disconnect', (reason) => {
      this.handleDisconnection(socket, reason);
    });
  }

  /**
   * Register socket event handlers
   */
  private registerEventHandlers(socket: Socket): void {
    // Session events
    socket.on('session:start', (data) => this.handleSessionStart(socket, data));
    socket.on('session:join', (data) => this.handleSessionJoin(socket, data));
    socket.on('session:leave', (data) => this.handleSessionLeave(socket, data));
    socket.on('session:update', (data) => this.handleSessionUpdate(socket, data));
    socket.on('session:end', (data) => this.handleSessionEnd(socket, data));

    // Live consumption events
    socket.on('consumption:live', (data) => this.handleLiveConsumption(socket, data));
    socket.on('consumption:rate', (data) => this.handleConsumptionRate(socket, data));

    // Sync events
    socket.on('sync:request', (data) => this.handleSyncRequest(socket, data));
    socket.on('sync:push', (data) => this.handleSyncPush(socket, data));

    // Collaboration events
    socket.on('session:message', (data) => this.handleSessionMessage(socket, data));
    socket.on('session:typing', (data) => this.handleTypingIndicator(socket, data));
    socket.on('session:reaction', (data) => this.handleReaction(socket, data));

    // Status events
    socket.on('user:status', (data) => this.handleUserStatus(socket, data));
    socket.on('ping', () => socket.emit('pong'));
  }

  /**
   * Handle session start
   */
  private async handleSessionStart(socket: Socket, data: SessionStartData): Promise<void> {
    try {
      const userId = socket.data.userId;
      const sessionId = data.sessionId || uuidv4();

      // Create session room
      const roomName = `session:${sessionId}`;
      socket.join(roomName);
      socket.data.sessionId = sessionId;

      // Track session participants
      if (!this.sessionRooms.has(sessionId)) {
        this.sessionRooms.set(sessionId, new Set());
      }
      this.sessionRooms.get(sessionId)?.add(userId);

      // Notify other devices of the same user
      this.emitToUser(userId, 'session:started', {
        sessionId,
        startedBy: socket.id,
        timestamp: new Date().toISOString(),
      });

      // Store session start event using repository
      await this.webSocketEventRepository.create({
        userId,
        eventType: 'session:start',
        data: { sessionId, ...data } as Prisma.InputJsonValue,
      });

      socket.emit('session:started', { sessionId, success: true });
      this.logger.info(`Session started: ${sessionId} by user: ${userId}`, { context: 'SocketService' });
    } catch (error) {
      this.logger.error('Failed to start session:', { context: 'SocketService', error: getErrorMessage(error), stack: getErrorStack(error) });
      socket.emit('error', { type: 'session:start', message: 'Failed to start session' });
    }
  }

  /**
   * Handle session join
   */
  private async handleSessionJoin(socket: Socket, data: SessionJoinData): Promise<void> {
    try {
      const userId = socket.data.userId;
      const { sessionId, role = 'participant' } = data;

      // Join session room
      const roomName = `session:${sessionId}`;
      socket.join(roomName);
      socket.data.sessionId = sessionId;

      // Track participant
      if (!this.sessionRooms.has(sessionId)) {
        this.sessionRooms.set(sessionId, new Set());
      }
      this.sessionRooms.get(sessionId)?.add(userId);

      // Notify other participants
      socket.to(roomName).emit('participant:joined', {
        userId,
        role,
        timestamp: new Date().toISOString(),
      });

      // Get current session state
      const sessionState = await this.getSessionState(sessionId);
      socket.emit('session:joined', {
        sessionId,
        participants: Array.from(this.sessionRooms.get(sessionId) || []),
        state: sessionState,
      });

      this.logger.info(`User ${userId} joined session: ${sessionId}`, { context: 'SocketService' });
    } catch (error) {
      this.logger.error('Failed to join session:', { context: 'SocketService', error: getErrorMessage(error), stack: getErrorStack(error) });
      socket.emit('error', { type: 'session:join', message: 'Failed to join session' });
    }
  }

  /**
   * Handle live consumption update
   */
  private async handleLiveConsumption(socket: Socket, data: LiveConsumptionData): Promise<void> {
    try {
      const userId = socket.data.userId;
      const sessionId = socket.data.sessionId;

      if (!sessionId) {
        socket.emit('error', { type: 'consumption:live', message: 'No active session' });
        return;
      }

      // Validate and process consumption data
      const consumption = {
        id: uuidv4(),
        userId,
        sessionId,
        ...data,
        timestamp: new Date().toISOString(),
      };

      // Broadcast to session participants
      this.io?.to(`session:${sessionId}`).emit('consumption:update', consumption);

      // Store live consumption using repository
      await this.liveConsumptionRepository.create({
        userId,
        sessionId,
        data: consumption,
      });

      // Send to user's other devices
      this.emitToUser(userId, 'consumption:synced', consumption);

      this.logger.info(`Live consumption recorded for session: ${sessionId}`, { context: 'SocketService' });
    } catch (error) {
      this.logger.error('Failed to handle live consumption:', { context: 'SocketService', error: getErrorMessage(error), stack: getErrorStack(error) });
      socket.emit('error', { type: 'consumption:live', message: 'Failed to record consumption' });
    }
  }

  /**
   * Handle sync request
   */
  private async handleSyncRequest(socket: Socket, data: SyncRequestData): Promise<void> {
    try {
      const userId = socket.data.userId;
      const deviceId = socket.data.deviceId;

      // Trigger sync for all user devices
      this.emitToUser(userId, 'sync:required', {
        requestedBy: deviceId,
        timestamp: new Date().toISOString(),
        entities: data.entities,
      });

      socket.emit('sync:initiated', { success: true });
      this.logger.info(`Sync requested by user: ${userId}, device: ${deviceId}`, { context: 'SocketService' });
    } catch (error) {
      this.logger.error('Failed to handle sync request:', { context: 'SocketService', error: getErrorMessage(error), stack: getErrorStack(error) });
      socket.emit('error', { type: 'sync:request', message: 'Failed to initiate sync' });
    }
  }

  /**
   * Handle session message
   */
  private async handleSessionMessage(socket: Socket, data: SessionMessageData): Promise<void> {
    const userId = socket.data.userId;
    const sessionId = socket.data.sessionId;

    if (!sessionId) {
      socket.emit('error', { type: 'session:message', message: 'No active session' });
      return;
    }

    // Store message using repository (returns full message with user/session data)
    const message = await this.sessionMessageRepository.create({
      sessionId,
      userId,
      text: data.text,
      metadata: data.metadata,
    });

    // Broadcast to session participants
    this.io?.to(`session:${sessionId}`).emit('message:new', message);
  }

  /**
   * Handle typing indicator
   */
  private handleTypingIndicator(socket: Socket, data: TypingIndicatorData): void {
    const userId = socket.data.userId;
    const sessionId = socket.data.sessionId;

    if (!sessionId) return;

    socket.to(`session:${sessionId}`).emit('user:typing', {
      userId,
      isTyping: data.isTyping,
    });
  }

  /**
   * Handle reaction
   */
  private async handleReaction(socket: Socket, data: ReactionData): Promise<void> {
    const userId = socket.data.userId;
    const sessionId = socket.data.sessionId;

    if (!sessionId) return;

    const reaction = {
      userId,
      targetId: data.targetId,
      type: data.type,
      timestamp: new Date().toISOString(),
    };

    // Broadcast to session
    this.io?.to(`session:${sessionId}`).emit('reaction:new', reaction);
  }

  /**
   * Handle user status update
   */
  private handleUserStatus(socket: Socket, data: UserStatusData): void {
    const userId = socket.data.userId;
    
    // Update user status
    socket.data.status = data.status;

    // Broadcast to user's sessions
    const sessionId = socket.data.sessionId;
    if (sessionId) {
      socket.to(`session:${sessionId}`).emit('participant:status', {
        userId,
        status: data.status,
      });
    }
  }

  /**
   * Handle session update
   */
  private async handleSessionUpdate(socket: Socket, data: SessionUpdateData): Promise<void> {
    const sessionId = socket.data.sessionId;
    
    if (!sessionId) {
      socket.emit('error', { type: 'session:update', message: 'No active session' });
      return;
    }

    // Broadcast update to session participants
    this.io?.to(`session:${sessionId}`).emit('session:updated', {
      ...data,
      updatedBy: socket.data.userId,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Handle session end
   */
  private async handleSessionEnd(socket: Socket, data: SessionEndData): Promise<void> {
    const userId = socket.data.userId;
    const sessionId = socket.data.sessionId || data.sessionId;

    if (!sessionId) return;

    // Notify participants
    this.io?.to(`session:${sessionId}`).emit('session:ended', {
      endedBy: userId,
      reason: data.reason,
      timestamp: new Date().toISOString(),
    });

    // Clean up room
    this.sessionRooms.delete(sessionId);
    
    // Leave room
    const room = this.io?.sockets.adapter.rooms.get(`session:${sessionId}`);
    if (room) {
      room.forEach((socketId) => {
        const s = this.io?.sockets.sockets.get(socketId);
        if (s) {
          s.leave(`session:${sessionId}`);
          delete s.data.sessionId;
        }
      });
    }

    this.logger.info(`Session ended: ${sessionId}`, { context: 'SocketService' });
  }

  /**
   * Handle session leave
   */
  private handleSessionLeave(socket: Socket, data: SessionLeaveData): void {
    const userId = socket.data.userId;
    const sessionId = socket.data.sessionId || data.sessionId;

    if (!sessionId) return;

    // Remove from session room
    socket.leave(`session:${sessionId}`);
    delete socket.data.sessionId;

    // Update participants list
    const participants = this.sessionRooms.get(sessionId);
    if (participants) {
      participants.delete(userId);
      if (participants.size === 0) {
        this.sessionRooms.delete(sessionId);
      }
    }

    // Notify other participants
    socket.to(`session:${sessionId}`).emit('participant:left', {
      userId,
      timestamp: new Date().toISOString(),
    });

    this.logger.info(`User ${userId} left session: ${sessionId}`, { context: 'SocketService' });
  }

  /**
   * Handle sync push
   */
  private async handleSyncPush(socket: Socket, data: SyncPushData): Promise<void> {
    const userId = socket.data.userId;
    const deviceId = socket.data.deviceId;

    // Broadcast sync data to user's other devices
    socket.to(`user:${userId}`).emit('sync:data', {
      fromDevice: deviceId,
      changes: data.changes,
      timestamp: new Date().toISOString(),
    });

    socket.emit('sync:pushed', { success: true });
  }

  /**
   * Handle consumption rate
   */
  private handleConsumptionRate(socket: Socket, data: ConsumptionRateData): void {
    const sessionId = socket.data.sessionId;
    
    if (!sessionId) return;

    // Broadcast consumption rate to session
    this.io?.to(`session:${sessionId}`).emit('consumption:rate', {
      userId: socket.data.userId,
      rate: data.rate,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Handle disconnection
   */
  private handleDisconnection(socket: Socket, reason: string): void {
    const userId = socket.data.userId;
    const sessionId = socket.data.sessionId;

    this.logger.info(`User disconnected: ${userId}, Reason: ${reason}`, { context: 'SocketService' });

    // Remove from user sockets
    const userSocketSet = this.userSockets.get(userId);
    if (userSocketSet) {
      userSocketSet.delete(socket.id);
      if (userSocketSet.size === 0) {
        this.userSockets.delete(userId);
      }
    }

    // Handle session cleanup if in session
    if (sessionId) {
      this.handleSessionLeave(socket, { sessionId });
    }

    // Notify other devices
    this.emitToUser(userId, 'device:disconnected', {
      deviceId: socket.data.deviceId,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Get session state from database using repository
   *
   *  FIXED: Uses SessionRepository instead of direct db.query()
   */
  private async getSessionState(sessionId: string): Promise<SessionStateData | null> {
    try {
      // Using system-internal method for WebSocket broadcasts (authorized operation)
      const session = await this.sessionRepository.findByIdSystemInternal(sessionId);
      if (!session) {
        return null;
      }

      // Map repository session to SocketService session state format
      // Convert null to undefined for sessionEndTimestamp (SocketService type uses undefined)
      return {
        id: session.id,
        userId: session.userId,
        sessionStartTimestamp: session.sessionStartTimestamp,
        sessionEndTimestamp: session.sessionEndTimestamp ?? undefined,
        eventCount: session.eventCount,
        totalDurationMs: session.totalDurationMs,
        avgEventDurationMs: session.avgEventDurationMs,
        sessionTypeHeuristic: session.sessionTypeHeuristic || undefined,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      };
    } catch (error) {
      this.logger.error('Failed to get session state', {
        context: 'SocketService.getSessionState',
        sessionId,
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  /**
   * Emit event to specific user (all devices)
   */
  public emitToUser(userId: string, event: string, data: unknown): void {
    this.io?.to(`user:${userId}`).emit(event, data);
  }

  /**
   * Emit event to specific device
   */
  public emitToDevice(deviceId: string, event: string, data: unknown): void {
    this.io?.to(`device:${deviceId}`).emit(event, data);
  }

  /**
   * Emit event to session participants
   */
  public emitToSession(sessionId: string, event: string, data: unknown): void {
    this.io?.to(`session:${sessionId}`).emit(event, data);
  }

  /**
   * Broadcast to all connected users
   */
  public broadcast(event: string, data: unknown): void {
    this.io?.emit(event, data);
  }

  /**
   * Get connected users count
   */
  public getConnectedUsersCount(): number {
    return this.userSockets.size;
  }

  /**
   * Get active sessions count
   */
  public getActiveSessionsCount(): number {
    return this.sessionRooms.size;
  }

  /**
   * Check if user is online
   */
  public isUserOnline(userId: string): boolean {
    return this.userSockets.has(userId);
  }

  /**
   * Get user's active sockets
   */
  public getUserSockets(userId: string): Set<string> | undefined {
    return this.userSockets.get(userId);
  }

  /**
   * Get the Socket.IO server instance.
   * Used by WebSocketBroadcaster for advanced operations.
   *
   * @returns Socket.IO Server instance or null if not initialized
   */
  public getServer(): Server | null {
    return this.io;
  }

  /**
   * Gracefully close WebSocket server and Redis connections
   */
  public async close(): Promise<void> {
    try {
      if (this.io) {
        this.io.close();
        this.logger.info('Socket.IO server closed', { context: 'SocketService' });
      }
      
      if (this.pubClient) {
        await this.pubClient.disconnect();
        this.logger.info('Redis PubClient disconnected', { context: 'SocketService' });
      }
      
      if (this.subClient) {
        await this.subClient.disconnect();
        this.logger.info('Redis SubClient disconnected', { context: 'SocketService' });
      }
      
      this.isInitialized = false;
    } catch (error) {
      this.logger.error('Error during SocketService shutdown', {
        context: 'SocketService',
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
    }
  }

  /**
   * Health check for WebSocket authentication configuration
   * Validates that the service is properly configured for secure operation
   */
  public getHealthStatus(): {
    status: 'healthy' | 'warning' | 'unhealthy';
    details: Record<string, unknown>;
    timestamp: string;
  } {
    const details: Record<string, unknown> = {
      isConfigured: !!this.config,
      isInitialized: this.isInitialized,
      hasJwtSecret: !!(this.config?.jwtSecret),
      jwtSecretLength: this.config?.jwtSecret?.length || 0,
      connectedUsers: this.getConnectedUsersCount(),
      activeSessions: this.getActiveSessionsCount(),
      corsOriginsConfigured: this.config?.corsOrigins?.length || 0,
      horizontalScalingEnabled: !!this.config?.enableHorizontalScaling,
      redisAdapterConnected: !!(this.pubClient && this.subClient),
      scalingMode: (this.pubClient && this.subClient) ? 'multi-instance' : 'single-instance',
    };

    let status: 'healthy' | 'warning' | 'unhealthy' = 'healthy';

    // Initialize issues array with explicit type
    const issues: string[] = [];
    details.issues = issues;

    // Check critical configuration issues using cached JWT validation
    // This avoids redundant validation during health checks (JWT secret doesn't change at runtime)
    if (!this.config || !this.config.jwtSecret) {
      status = 'unhealthy';
      issues.push('JWT secret not configured - WebSocket authentication will fail');
    } else if (this.cachedJwtValidation) {
      // Use cached validation result (populated during configure())
      const validation = this.cachedJwtValidation;
      details.jwtValidation = {
        isValid: validation.isValid,
        securityScore: validation.securityScore,
        errorCount: validation.errors.length,
        warningCount: validation.warnings.length,
      };

      if (!validation.isValid) {
        status = 'unhealthy';
        issues.push(`JWT secret validation failed: ${validation.errors.join(', ')}`);
      } else if (validation.warnings.length > 0 && status === 'healthy') {
        status = 'warning';
        issues.push(`JWT secret validation warnings: ${validation.warnings.join(', ')}`);
      }
    } else {
      // Fallback: if no cached validation, perform validation (shouldn't happen normally)
      const validation = JwtSecretValidator.validate(this.config.jwtSecret, this.logger, 'WebSocket JWT Secret');
      details.jwtValidation = {
        isValid: validation.isValid,
        securityScore: validation.securityScore,
        errorCount: validation.errors.length,
        warningCount: validation.warnings.length,
      };

      if (!validation.isValid) {
        status = 'unhealthy';
        issues.push(`JWT secret validation failed: ${validation.errors.join(', ')}`);
      } else if (validation.warnings.length > 0 && status === 'healthy') {
        status = 'warning';
        issues.push(`JWT secret validation warnings: ${validation.warnings.join(', ')}`);
      }
    }

    // Check initialization state
    if (this.config && !this.isInitialized) {
      if (status === 'healthy') {
        status = 'warning';
      }
      issues.push('Service configured but not initialized');
    }

    return {
      status,
      details,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Validate JWT token without socket context (for testing/debugging)
   * Should only be used for diagnostic purposes
   */
  public validateToken(token: string): { valid: boolean; decoded?: DecodedJWTPayload; error?: string } {
    try {
      if (!this.config?.jwtSecret) {
        return { valid: false, error: 'JWT secret not configured' };
      }

      const decoded = jwt.verify(token, this.config.jwtSecret, {
        algorithms: ['HS256'],
        maxAge: '24h',
      }) as DecodedJWTPayload;

      return { valid: true, decoded };
    } catch (error) {
      return { 
        valid: false, 
        error: error instanceof Error ? error.message : 'Token validation failed', 
      };
    }
  }
}