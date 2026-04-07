/**
 * Session Repository
 * 
 * Implements the Repository Pattern for Session entity database operations
 * Handles all session-related database interactions including real-time tracking,
 * analytics, and session lifecycle management for the AppPlatform product tracking system
 * 
 * @see https://docs.microsoft.com/en-us/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/infrastructure-persistence-layer-design
 */

import { Session, Consumption, JournalEntry, Prisma, PrismaClient } from '@prisma/client';
import { BaseRepository, PaginatedResponse } from './base.repository';
import { AppError, ErrorCodes } from '../utils/AppError';
import { LoggerService } from '../services/logger.service';

/**
 * Validation schemas removed - validation now handled at controller layer
 * Controllers validate using schemas from src/models before calling repositories
 * This ensures repositories focus solely on data access, following Repository Pattern
 */

/**
 * Input types for repository methods
 */
export interface CreateSessionInput {
  id?: string; // Optional if client pre-allocates
  clientSessionId?: string | null; // Strongly recommended for idempotency
  deviceId?: string | null;
  userId: string;
  purchaseId?: string | null;
  primaryProductId?: string | null; // Primary product for analytics
  sessionStartTimestamp: Date;
  sessionEndTimestamp?: Date | null; // Nullable for active sessions (local-first)
  eventCount?: number;
  totalDurationMs?: number;
  avgEventDurationMs?: number;
  sessionTypeHeuristic?: string | null;
  observationFeature?: number | null;
  status?: 'ACTIVE' | 'COMPLETED' | 'PAUSED' | 'CANCELLED'; // Session status (defaults to ACTIVE)
  notes?: string | null; // User-provided session notes (synced from local-first app)
}

export interface UpdateSessionInput {
  purchaseId?: string | null;
  deviceId?: string | null;
  primaryProductId?: string | null;
  sessionStartTimestamp?: Date;
  sessionEndTimestamp?: Date | null; // Nullable for active sessions (local-first)
  eventCount?: number;
  totalDurationMs?: number;
  avgEventDurationMs?: number;
  sessionTypeHeuristic?: string | null;
  observationFeature?: number | null;
  status?: 'ACTIVE' | 'COMPLETED' | 'PAUSED' | 'CANCELLED'; // Session status
  notes?: string | null; // User-provided session notes (synced from local-first app)
  lastKnownUpdatedAt?: Date; // Optional optimistic concurrency
}

export interface SessionFilters {
  userId?: string;
  purchaseId?: string | null;
  dateFrom?: Date;
  dateTo?: Date;
  minEventCount?: number;
  maxEventCount?: number;
  minDuration?: number;
  maxDuration?: number;
  sessionType?: string;
  isActive?: boolean;
}

export interface SessionWithConsumptions extends Session {
  consumptions?: Consumption[];
  journalEntries?: JournalEntry[];
  consumptionStats?: {
    totalConsumptions: number;
    totalDurationMs: number;
    avgDurationMs: number;
    minDurationMs: number;
    maxDurationMs: number;
  };
}

export interface SessionAnalytics {
  sessionId: string;
  userId: string;
  startTime: Date;
  endTime: Date;
  duration: number;
  eventCount: number;
  avgHitDuration: number;
  intensity: number;
  sessionType: string | null;
  productUsed: string | null;
  journalCount: number;
  safetyAlerts: number;
}

export interface UserSessionStats {
  totalSessions: number;
  activeSessions: number;
  totalEvents: number;
  totalDurationMs: number;
  avgSessionDurationMs: number;
  avgHitsPerSession: number;
  longestSessionMs: number;
  shortestSessionMs: number;
  mostCommonSessionType: string | null;
  dailyAverage: number;
  weeklyAverage: number;
}

/**
 * Validation schemas for input data
 * Note: These are internal to the repository for validation
 * The service layer should use its own schemas
 */

/**
 * Session Repository - Handles all database operations for Session entity
 * Extends BaseRepository to inherit common functionality
 */
export class SessionRepository extends BaseRepository<Session> {
  constructor(prisma: PrismaClient, entityName: string, logger: LoggerService) {
    super(prisma, entityName, logger);
  }

  /**
   * Create a new consumption session
   * Supports deduplication via clientSessionId
   * 
   * @param data - Session creation data
   * @returns Created session
   * @throws AppError if validation fails or duplicate detected
   */
  async create(
    data: CreateSessionInput,
    tx?: Prisma.TransactionClient,
  ): Promise<Session> {
    const client = tx || this.prisma; // Use transaction client if provided, else default Prisma client
    try {
      // Repository layer trusts that service layer has validated input
      const validatedData = data;

      // Check for duplicate if clientSessionId provided
      if (validatedData.clientSessionId) {
        const existing = await client.consumptionSession.findUnique({
          where: {
            user_clientSessionId_unique: {
              userId: validatedData.userId,
              clientSessionId: validatedData.clientSessionId,
            },
          },
        });

        if (existing) {
          this.logger.warn('Duplicate session detected', {
            userId: validatedData.userId,
            clientSessionId: validatedData.clientSessionId,
          });
          return existing; // Return existing record for idempotency
        }
      }

      // Calculate session duration if not provided (only if sessionEndTimestamp is set)
      // For active sessions (sessionEndTimestamp = null), duration is 0 initially
      const sessionDurationMs = validatedData.sessionEndTimestamp 
        ? validatedData.sessionEndTimestamp.getTime() - validatedData.sessionStartTimestamp.getTime()
        : 0;

      // Set default values
      const sessionData = {
        ...validatedData,
        eventCount: validatedData.eventCount ?? 0,
        totalDurationMs: validatedData.totalDurationMs ?? sessionDurationMs,
        avgEventDurationMs: validatedData.avgEventDurationMs ?? 0,
        // status defaults to ACTIVE via Prisma schema if not provided
        version: 1,
      };

      // Create session
      const session = await client.consumptionSession.create({
        data: sessionData,
        include: {
          user: true,
          purchase: true,
        },
      });

      this.logSuccess('create', {
        sessionId: session.id,
        userId: session.userId,
      });
      return session;
    } catch (error) {
      throw this.handleError(error, 'create');
    }
  }

  /**
   * Find session by ID with user authorization
   *
   * Uses automatic retry for transient database errors (connection issues,
   * pool exhaustion, timeouts) to improve reliability during sync operations.
   *
   * @param id - Session ID
   * @param userId - User ID for authorization
   * @param includeRelations - Include related data
   * @param tx - Optional transaction client (retries disabled within transactions)
   * @returns Session or null if not found
   * @throws AppError if database error occurs after all retries exhausted
   */
  async findById(
    id: string,
    userId: string,
    includeRelations: boolean = false,
    tx?: Prisma.TransactionClient,
  ): Promise<Session | null> {
    const client = tx || this.prisma;

    // If within a transaction, don't use retry (transaction must be atomic)
    // Otherwise, use executeWithRetry for transient failure handling
    const operation = async () => {
      const session = await client.consumptionSession.findFirst({
        where: { id, userId },
        ...(includeRelations && {
          include: {
            user: true,
            purchase: true,
            primaryProduct: true,
            sessionProducts: {
              include: {
                product: true,
              },
            },
            consumptions: {
              include: {
                product: true,
              },
            },
            journalEntries: true,
          },
        }),
      });

      if (session) {
        this.logSuccess('findById', { sessionId: id, found: true });
      }

      return session;
    };

    try {
      // Transactions must be atomic, so don't retry within them
      // (the sync service will retry the entire transaction if needed)
      if (tx) {
        return await operation();
      }

      // Use retry logic for standalone queries
      return await this.executeWithRetry(operation, 'findById');
    } catch (error) {
      throw this.handleError(error, 'findById');
    }
  }

  /**
   * Find session by ID for system-internal operations ONLY (bypasses user authorization)
   *
   *  SECURITY WARNING: This method bypasses user ownership checks!
   * ONLY use for trusted system-internal operations where:
   * - The caller has already performed authorization
   * - The operation is system-level (e.g., background jobs, WebSocket broadcasts)
   * - Cross-user access is explicitly required and authorized
   *
   * For standard user-facing operations, ALWAYS use findById(id, userId) instead.
   *
   * @param id - Session ID
   * @returns Session or null if not found (regardless of user ownership)
   * @throws AppError if database error occurs
   */
  async findByIdSystemInternal(id: string): Promise<Session | null> {
    try {
      this.logger.warn('System-internal session access (bypassing user auth)', {
        context: 'SessionRepository.findByIdSystemInternal',
        sessionId: id,
      });

      const session = await this.prisma.consumptionSession.findUnique({
        where: { id },
      });

      if (session) {
        this.logSuccess('findByIdSystemInternal', { sessionId: id, found: true });
      }

      return session;
    } catch (error) {
      throw this.handleError(error, 'findByIdSystemInternal');
    }
  }

  /**
   * Find session by user ID and session ID
   *
   * @param userId - User ID
   * @param sessionId - Client session ID
   * @returns Session or null if not found
   */
  async findByUserAndSessionId(userId: string, sessionId: string): Promise<Session | null> {
    try {
      const session = await this.prisma.consumptionSession.findFirst({
        where: {
          userId,
          clientSessionId: sessionId,
        },
        include: {
          purchase: true,
          consumptions: true,
        },
      });

      if (session) {
        this.logSuccess('findByUserAndSessionId', { 
          userId,
          sessionId,
          found: true, 
        });
      }

      return session;
    } catch (error) {
      throw this.handleError(error, 'findByUserAndSessionId');
    }
  }

  /**
   * Find active session for a user.
   *
   * Returns sessions with status=ACTIVE whose end window is either:
   * - Still in the future (truly active), OR
   * - Recently expired (within STALE_GRACE_WINDOW_MS)
   *
   * The grace window allows the service layer's stale cleanup logic to
   * detect and durably complete recently-expired sessions (via completeSession()
   * which emits session.ended domain events). Without it, recently-expired
   * sessions would be invisible to getActiveSessions(), leaving them stuck
   * in ACTIVE state with no cleanup trigger.
   *
   * @param userId - User ID
   * @returns Active or recently-expired session, or null if none found
   */
  async findActiveSession(userId: string): Promise<Session | null> {
    try {
      const now = new Date();
      // Grace window: include sessions that expired within the last hour.
      // This ensures the service layer can detect and durably complete them
      // (with outbox events) instead of them being silently filtered out.
      const STALE_GRACE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
      const graceThreshold = new Date(now.getTime() - STALE_GRACE_WINDOW_MS);

      const session = await this.prisma.consumptionSession.findFirst({
        where: {
          userId,
          status: 'ACTIVE',
          // Include sessions whose end window is in the future OR recently expired
          sessionEndTimestamp: {
            gt: graceThreshold,
          },
        },
        orderBy: {
          sessionEndTimestamp: 'desc',
        },
        include: {
          purchase: true,
          consumptions: true,
        },
      });

      if (session) {
        this.logSuccess('findActiveSession', { 
          userId,
          sessionId: session.id,
          found: true, 
        });
      }

      return session;
    } catch (error) {
      throw this.handleError(error, 'findActiveSession');
    }
  }

  /**
   * Find sessions by date range
   * 
   * @param filters - Filter parameters including userId and date range
   * @returns Paginated list of sessions
   */
  async findByDateRange(
    filters: {
      userId: string;
      dateFrom?: Date;
      dateTo?: Date;
      page?: number;
      pageSize?: number;
    },
  ): Promise<PaginatedResponse<Session>> {
    try {
      const where: Prisma.SessionWhereInput = { 
        userId: filters.userId, 
      };

      // Apply date filters
      if (filters.dateFrom || filters.dateTo) {
        where.sessionStartTimestamp = {};
        if (filters.dateFrom) {
          where.sessionStartTimestamp.gte = filters.dateFrom;
        }
        if (filters.dateTo) {
          where.sessionStartTimestamp.lte = filters.dateTo;
        }
      }

      const result = await this.findManyWithPagination<
        Prisma.SessionFindManyArgs,
        Prisma.SessionCountArgs
      >(
        (args) => this.prisma.consumptionSession.findMany(args),
        (args) => this.prisma.consumptionSession.count(args),
        {
          page: filters.page,
          pageSize: filters.pageSize,
          where,
          orderBy: { sessionStartTimestamp: 'desc' },
          include: {
            purchase: true,
            consumptions: true,
          },
        },
      );

      this.logSuccess('findByDateRange', { 
        userId: filters.userId,
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
        count: result.items.length, 
      });

      return result;
    } catch (error) {
      throw this.handleError(error, 'findByDateRange');
    }
  }

  /**
   * Find sessions by user ID
   * 
   * @param userId - User ID
   * @param params - Pagination and filter parameters
   * @returns Paginated list of sessions
   */
  async findByUserId(
    userId: string,
    params: {
      page?: number;
      pageSize?: number;
      orderBy?: Record<string, 'asc' | 'desc'>;
      dateFrom?: Date;
      dateTo?: Date;
      includeRelations?: boolean;
    } = {},
  ): Promise<PaginatedResponse<Session>> {
    try {
      const where: Prisma.SessionWhereInput = { userId };

      // Apply date filters
      if (params.dateFrom || params.dateTo) {
        where.sessionStartTimestamp = {};
        if (params.dateFrom) {
          where.sessionStartTimestamp.gte = params.dateFrom;
        }
        if (params.dateTo) {
          where.sessionStartTimestamp.lte = params.dateTo;
        }
      }

      const result = await this.findManyWithPagination<
        Prisma.SessionFindManyArgs,
        Prisma.SessionCountArgs
      >(
        (args) => this.prisma.consumptionSession.findMany(args),
        (args) => this.prisma.consumptionSession.count(args),
        {
          ...params,
          where,
          orderBy: params.orderBy || { sessionStartTimestamp: 'desc' },
          ...(params.includeRelations && {
            include: {
              purchase: true,
              primaryProduct: true,
              sessionProducts: {
                include: {
                  product: true,
                },
              },
              consumptions: {
                include: {
                  product: true,
                },
              },
              _count: {
                select: {
                  consumptions: true,
                  journalEntries: true,
                  safetyRecords: true,
                },
              },
            },
          }),
        },
      );

      this.logSuccess('findByUserId', {
        userId,
        totalResults: result.total,
      });

      return result;
    } catch (error) {
      throw this.handleError(error, 'findByUserId');
    }
  }

  /**
   * Find sessions for a user that overlap a time range.
   *
   * P0-G.1: Used by TelemetryCacheProjectionHandler to find sessions
   * affected by health sample changes.
   *
   * A session overlaps the range if:
   * - Session starts before range ends AND
   * - Session ends after range starts (or is still active)
   *
   * @param userId - The user ID
   * @param rangeStart - Start of the time range
   * @param rangeEnd - End of the time range
   * @returns List of sessions that overlap the time range
   */
  async findByUserAndTimeRange(
    userId: string,
    rangeStart: Date,
    rangeEnd: Date
  ): Promise<Session[]> {
    try {
      const sessions = await this.prisma.consumptionSession.findMany({
        where: {
          userId,
          // Session must start before rangeEnd
          sessionStartTimestamp: { lt: rangeEnd },
          // Session must end at or after rangeStart (half-open interval: [rangeStart, rangeEnd))
          // Using gte instead of gt ensures sessions ending exactly at rangeStart are included
          OR: [
            { sessionEndTimestamp: { gte: rangeStart } },
            { sessionEndTimestamp: null }, // Active sessions
          ],
        },
        orderBy: { sessionStartTimestamp: 'desc' },
      });

      this.logSuccess('findByUserAndTimeRange', {
        userId,
        rangeStart: rangeStart.toISOString(),
        rangeEnd: rangeEnd.toISOString(),
        found: sessions.length,
      });

      return sessions;
    } catch (error) {
      throw this.handleError(error, 'findByUserAndTimeRange');
    }
  }

  /**
   * Update session with user authorization and optimistic locking
   *
   * @param id - Session ID
   * @param userId - User ID for authorization
   * @param data - Update data
   * @returns Updated session
   * @throws AppError if session not found, validation fails, or version conflict
   */
  async update(
    id: string,
    userId: string,
    data: UpdateSessionInput,
    tx?: Prisma.TransactionClient,
  ): Promise<Session> {
    const client = tx || this.prisma;
    try {
      // Fetch existing session once for version check and calculations
      const existing = await this.findById(id, userId, false, tx);
      if (!existing) {
        throw new AppError(
          404,
          ErrorCodes.NOT_FOUND,
          'Session not found or access denied',
          true,
        );
      }

      // Repository layer trusts that service layer has validated input
      const { lastKnownUpdatedAt, ...validatedData } = data;

      // If updating end time, recalculate duration.
      // Use the updated start timestamp when both fields are updated together.
      if (validatedData.sessionEndTimestamp) {
        const effectiveStartTimestamp =
          validatedData.sessionStartTimestamp ?? existing.sessionStartTimestamp;
        const newDuration = validatedData.sessionEndTimestamp.getTime() -
          effectiveStartTimestamp.getTime();
        if (!validatedData.totalDurationMs) {
          validatedData.totalDurationMs = newDuration;
        }
      }

      // Recalculate average hit duration if hit count or total duration updated
      if (validatedData.eventCount !== undefined || validatedData.totalDurationMs !== undefined) {
        const eventCount = validatedData.eventCount ?? existing.eventCount;
        const totalDuration = validatedData.totalDurationMs ?? existing.totalDurationMs;
        if (eventCount > 0) {
          validatedData.avgEventDurationMs = totalDuration / eventCount;
        }
      }

      // Optimistic locking: Update only if version matches + atomically increment version
      const session = await client.consumptionSession.update({
        where: {
          id,
          userId,
          version: existing.version, // Optimistic lock check
        },
        data: {
          ...validatedData,
          version: { increment: 1 }, // Atomic version increment
        },
        include: {
          purchase: true,
        },
      });

      this.logSuccess('update', {
        sessionId: id,
        oldVersion: existing.version,
        newVersion: session.version,
      });
      return session;
    } catch (error) {
      throw this.handleError(error, 'update', { isOptimisticUpdate: true });
    }
  }

  /**
   * Update session status (active/ended) with user authorization
   *
   * @param id - Session ID
   * @param userId - User ID for authorization
   * @param endTimestamp - Session end timestamp
   * @returns Updated session
   */
  async updateSessionStatus(
    id: string,
    userId: string,
    endTimestamp: Date,
  ): Promise<Session> {
    try {
      // Get session with consumptions to calculate statistics
      const session = await this.prisma.consumptionSession.findFirst({
        where: { id, userId },
        include: {
          consumptions: true,
        },
      });

      if (!session) {
        throw new AppError(
          404,
          ErrorCodes.NOT_FOUND,
          'Session not found',
          true,
        );
      }

      // Calculate session statistics from consumptions
      const eventCount = session.consumptions.length;
      const totalDurationMs = session.consumptions.reduce(
        (sum, c) => sum + c.durationMs,
        0,
      );
      const avgEventDurationMs = eventCount > 0 ? totalDurationMs / eventCount : 0;

      // Update session with calculated statistics
      const updatedSession = await this.prisma.consumptionSession.update({
        where: { id },
        data: {
          sessionEndTimestamp: endTimestamp,
          eventCount,
          totalDurationMs,
          avgEventDurationMs,
        },
      });

      this.logSuccess('updateSessionStatus', { 
        sessionId: id,
        endTimestamp,
        eventCount,
        totalDurationMs, 
      });

      return updatedSession;
    } catch (error) {
      throw this.handleError(error, 'updateSessionStatus');
    }
  }

  /**
   * Delete session with user authorization
   *
   * @param id - Session ID
   * @param userId - User ID for authorization
   * @returns Deleted session
   * @throws AppError if session not found
   */
  async delete(
    id: string,
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Session> {
    const client = tx || this.prisma;
    try {
      // First verify ownership
      const existing = await this.findById(id, userId, false, tx);
      if (!existing) {
        throw new AppError(
          404,
          ErrorCodes.NOT_FOUND,
          'Session not found or access denied',
          true,
        );
      }

      const session = await client.consumptionSession.delete({
        where: { id },
      });

      this.logSuccess('delete', { sessionId: id });
      return session;
    } catch (error) {
      throw this.handleError(error, 'delete');
    }
  }

  /**
   * Get session with all consumptions and statistics with user authorization
   *
   * @param sessionId - Session ID
   * @param userId - User ID for authorization
   * @returns Session with consumptions and calculated statistics
   */
  async getSessionWithConsumptions(
    sessionId: string,
    userId: string,
  ): Promise<SessionWithConsumptions | null> {
    try {
      const session = await this.prisma.consumptionSession.findFirst({
        where: { id: sessionId, userId },
        include: {
          user: true,
          purchase: {
            include: {
              product: true,
            },
          },
          consumptions: {
            orderBy: {
              timestamp: 'asc',
            },
          },
          journalEntries: true,
        },
      });

      if (!session) {
        return null;
      }

      // Calculate consumption statistics
      const consumptionStats = {
        totalConsumptions: session.consumptions.length,
        totalDurationMs: session.consumptions.reduce((sum, c) => sum + c.durationMs, 0),
        avgDurationMs: 0,
        minDurationMs: 0,
        maxDurationMs: 0,
      };

      if (session.consumptions.length > 0) {
        consumptionStats.avgDurationMs = Math.round(
          consumptionStats.totalDurationMs / consumptionStats.totalConsumptions,
        );
        consumptionStats.minDurationMs = Math.min(...session.consumptions.map(c => c.durationMs));
        consumptionStats.maxDurationMs = Math.max(...session.consumptions.map(c => c.durationMs));
      }

      const sessionWithStats: SessionWithConsumptions = {
        ...session,
        consumptionStats,
      };

      this.logSuccess('getSessionWithConsumptions', { sessionId });
      return sessionWithStats;
    } catch (error) {
      throw this.handleError(error, 'getSessionWithConsumptions');
    }
  }

  /**
   * List sessions with filters - ADMIN ONLY
   * Only accessible to admin users for cross-user session analysis
   *
   * @param params - Pagination and filter parameters
   * @returns Paginated list of sessions
   */
  async listAdmin(params: {
    page?: number;
    pageSize?: number;
    orderBy?: Record<string, 'asc' | 'desc'>;
    filters?: SessionFilters;
    includeRelations?: boolean;
  }): Promise<PaginatedResponse<Session>> {
    try {
      const { filters = {} } = params;
      const where: Prisma.SessionWhereInput = {};

      // Apply filters
      if (filters.userId) {
        where.userId = filters.userId;
      }

      if (filters.purchaseId !== undefined) {
        where.purchaseId = filters.purchaseId;
      }

      // Date range filters
      if (filters.dateFrom || filters.dateTo) {
        where.sessionStartTimestamp = {};
        if (filters.dateFrom) {
          where.sessionStartTimestamp.gte = filters.dateFrom;
        }
        if (filters.dateTo) {
          where.sessionStartTimestamp.lte = filters.dateTo;
        }
      }

      // Hit count filters
      if (filters.minEventCount !== undefined || filters.maxEventCount !== undefined) {
        where.eventCount = {};
        if (filters.minEventCount !== undefined) {
          where.eventCount.gte = filters.minEventCount;
        }
        if (filters.maxEventCount !== undefined) {
          where.eventCount.lte = filters.maxEventCount;
        }
      }

      // Duration filters
      if (filters.minDuration !== undefined || filters.maxDuration !== undefined) {
        where.totalDurationMs = {};
        if (filters.minDuration !== undefined) {
          where.totalDurationMs.gte = filters.minDuration;
        }
        if (filters.maxDuration !== undefined) {
          where.totalDurationMs.lte = filters.maxDuration;
        }
      }

      // Session type filter
      if (filters.sessionType) {
        where.sessionTypeHeuristic = filters.sessionType;
      }

      // Active sessions filter
      if (filters.isActive) {
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        where.sessionEndTimestamp = {
          gte: oneHourAgo,
        };
      }

      const result = await this.findManyWithPagination<
        Prisma.SessionFindManyArgs,
        Prisma.SessionCountArgs
      >(
        (args) => this.prisma.consumptionSession.findMany(args),
        (args) => this.prisma.consumptionSession.count(args),
        {
          ...params,
          where,
          orderBy: params.orderBy || { sessionStartTimestamp: 'desc' },
          ...(params.includeRelations && {
            include: {
              user: true,
              purchase: {
                include: {
                  product: true,
                },
              },
              _count: {
                select: {
                  consumptions: true,
                  journalEntries: true,
                  safetyRecords: true,
                },
              },
            },
          }),
        },
      );

      this.logSuccess('listAdmin', {
        page: params.page,
        pageSize: params.pageSize,
        totalResults: result.total,
      });

      return result;
    } catch (error) {
      throw this.handleError(error, 'listAdmin');
    }
  }

  /**
   * Find completed sessions overlapping a given time range.
   *
   * Overlap condition:
   * - sessionStartTimestamp <= rangeEnd
   * - sessionEndTimestamp >= rangeStart
   *
   * Only COMPLETED sessions with non-null end timestamps are returned.
   */
  async findCompletedSessionsOverlappingRange(params: {
    userId: string;
    rangeStart: Date;
    rangeEnd: Date;
    limit?: number;
  }): Promise<Array<{
    id: string;
    userId: string;
    sessionStartTimestamp: Date;
    sessionEndTimestamp: Date | null;
  }>> {
    try {
      return await this.prisma.consumptionSession.findMany({
        where: {
          userId: params.userId,
          status: 'COMPLETED',
          sessionEndTimestamp: { not: null, gte: params.rangeStart },
          sessionStartTimestamp: { lte: params.rangeEnd },
        },
        select: {
          id: true,
          userId: true,
          sessionStartTimestamp: true,
          sessionEndTimestamp: true,
        },
        orderBy: { sessionStartTimestamp: 'desc' },
        take: params.limit,
      });
    } catch (error) {
      throw this.handleError(error, 'findCompletedSessionsOverlappingRange');
    }
  }

  /**
   * Get session analytics with detailed metrics and user authorization
   *
   * @param sessionId - Session ID
   * @param userId - User ID for authorization
   * @returns Detailed session analytics
   */
  async getSessionAnalytics(sessionId: string, userId: string): Promise<SessionAnalytics | null> {
    try {
      const session = await this.prisma.consumptionSession.findFirst({
        where: { id: sessionId, userId },
        include: {
          user: true,
          purchase: {
            include: {
              product: true,
            },
          },
          consumptions: true,
          journalEntries: true,
          safetyRecords: true,
        },
      });

      if (!session) {
        return null;
      }

      // Use end timestamp or current time for active sessions
      const endTime = session.sessionEndTimestamp ?? new Date();
      
      // Calculate intensity based on hit count and duration
      const sessionDuration = endTime.getTime() - 
                            session.sessionStartTimestamp.getTime();
      const intensity = session.eventCount > 0 
        ? (session.eventCount / (sessionDuration / (60 * 60 * 1000))) * 10 // events per hour * 10
        : 0;

      const analytics: SessionAnalytics = {
        sessionId: session.id,
        userId: session.userId,
        startTime: session.sessionStartTimestamp,
        endTime: endTime,
        duration: sessionDuration,
        eventCount: session.eventCount,
        avgHitDuration: session.avgEventDurationMs,
        intensity: Math.min(10, intensity), // Cap at 10
        sessionType: session.sessionTypeHeuristic,
        productUsed: session.purchase?.product?.name || null,
        journalCount: session.journalEntries.length,
        safetyAlerts: session.safetyRecords.length,
      };

      this.logSuccess('getSessionAnalytics', { sessionId });
      return analytics;
    } catch (error) {
      throw this.handleError(error, 'getSessionAnalytics');
    }
  }

  /**
   * Get user session statistics
   * 
   * @param userId - User ID
   * @param dateFrom - Optional start date
   * @param dateTo - Optional end date
   * @returns Aggregated session statistics
   */
  async getUserSessionStats(
    userId: string,
    dateFrom?: Date,
    dateTo?: Date,
  ): Promise<UserSessionStats> {
    try {
      const where: Prisma.SessionWhereInput = { userId };

      if (dateFrom || dateTo) {
        where.sessionStartTimestamp = {};
        if (dateFrom) {
          where.sessionStartTimestamp.gte = dateFrom;
        }
        if (dateTo) {
          where.sessionStartTimestamp.lte = dateTo;
        }
      }

      // Main aggregation
      const stats = await this.prisma.consumptionSession.aggregate({
        where,
        _count: { id: true },
        _sum: {
          eventCount: true,
          totalDurationMs: true,
        },
        _avg: {
          totalDurationMs: true,
          eventCount: true,
        },
        _min: {
          totalDurationMs: true,
        },
        _max: {
          totalDurationMs: true,
        },
      });

      // Count active sessions
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const activeSessions = await this.prisma.consumptionSession.count({
        where: {
          ...where,
          sessionEndTimestamp: {
            gte: oneHourAgo,
          },
        },
      });

      // Get most common session type
      const sessionTypes = await this.prisma.consumptionSession.groupBy({
        by: ['sessionTypeHeuristic'],
        where: {
          ...where,
          sessionTypeHeuristic: { not: null },
        },
        _count: { id: true },
        orderBy: {
          _count: {
            id: 'desc',
          },
        },
        take: 1,
      });

      // Calculate daily and weekly averages
      const dateRange = dateTo && dateFrom 
        ? (dateTo.getTime() - dateFrom.getTime()) / (1000 * 60 * 60 * 24)
        : 30; // Default to 30 days

      const dailyAverage = stats._count.id / Math.max(1, dateRange);
      const weeklyAverage = dailyAverage * 7;

      const userStats: UserSessionStats = {
        totalSessions: stats._count.id,
        activeSessions,
        totalEvents: stats._sum.eventCount || 0,
        totalDurationMs: stats._sum.totalDurationMs || 0,
        avgSessionDurationMs: Math.round(stats._avg.totalDurationMs || 0),
        avgHitsPerSession: Math.round(stats._avg.eventCount || 0),
        longestSessionMs: stats._max.totalDurationMs || 0,
        shortestSessionMs: stats._min.totalDurationMs || 0,
        mostCommonSessionType: sessionTypes[0]?.sessionTypeHeuristic || null,
        dailyAverage: Math.round(dailyAverage * 10) / 10,
        weeklyAverage: Math.round(weeklyAverage * 10) / 10,
      };

      this.logSuccess('getUserSessionStats', { userId, dateFrom, dateTo });
      return userStats;
    } catch (error) {
      throw this.handleError(error, 'getUserSessionStats');
    }
  }

  /**
   * Batch create sessions for sync operations with user authorization
   * All sessions must belong to the same requesting user
   *
   * @param sessions - Array of session data
   * @param requestingUserId - ID of user making the request
   * @returns Created sessions
   * @throws AppError if any session doesn't belong to requesting user
   */
  async batchCreate(
    sessions: CreateSessionInput[],
    requestingUserId: string,
  ): Promise<Session[]> {
    try {
      // SECURITY: Validate that all sessions belong to the requesting user
      for (const session of sessions) {
        if (session.userId !== requestingUserId) {
          throw new Error(`Access denied: Session userId ${session.userId} does not match requesting user ${requestingUserId}`);
        }
      }

      // Validate all inputs first - repository layer trusts service layer validation
      const validatedData = sessions.map((data) => {
        // Calculate session duration if not provided (use current time for active sessions)
        const endTime = data.sessionEndTimestamp ?? new Date();
        const sessionDurationMs = endTime.getTime() - 
                                 data.sessionStartTimestamp.getTime();

        return {
          ...data,
          eventCount: data.eventCount ?? 0,
          totalDurationMs: data.totalDurationMs ?? sessionDurationMs,
          avgEventDurationMs: data.avgEventDurationMs ?? 0,
        };
      });

      // Use transaction for atomicity
      const result = await this.executeTransaction(async (tx) => {
        const created: Session[] = [];

        for (const data of validatedData) {
          // Check for duplicates if clientSessionId provided
          if (data.clientSessionId) {
            const existing = await tx.consumptionSession.findUnique({
              where: {
                user_clientSessionId_unique: {
                  userId: data.userId,
                  clientSessionId: data.clientSessionId,
                },
              },
            });

            if (existing) {
              created.push(existing);
              continue;
            }
          }

          const session = await tx.consumptionSession.create({
            data,
          });
          created.push(session);
        }

        return created;
      });

      this.logSuccess('batchCreate', {
        count: result.length,
        requestingUserId,
        sessionCount: sessions.length,
      });

      return result;
    } catch (error) {
      throw this.handleError(error, 'batchCreate');
    }
  }

  /**
   * Identify and classify session types using heuristics
   * 
   * @param sessionId - Session ID
   * @returns Updated session with classified type
   */
  async classifySessionType(sessionId: string, userId: string): Promise<Session> {
    try {
      const session = await this.getSessionWithConsumptions(sessionId, userId);
      
      if (!session) {
        throw new AppError(
          404,
          ErrorCodes.NOT_FOUND,
          'Session not found',
          true,
        );
      }

      // Classify session based on patterns (use current time for active sessions)
      let sessionType: string;
      const endTime = session.sessionEndTimestamp ?? new Date();
      const duration = endTime.getTime() - 
                      session.sessionStartTimestamp.getTime();
      const durationMinutes = duration / (1000 * 60);
      const hitsPerMinute = session.eventCount / Math.max(1, durationMinutes);

      if (session.eventCount <= 2 && durationMinutes <= 10) {
        sessionType = 'micro';
      } else if (session.eventCount <= 5 && durationMinutes <= 30) {
        sessionType = 'quick';
      } else if (hitsPerMinute < 0.5) {
        sessionType = 'relaxed';
      } else if (hitsPerMinute > 2) {
        sessionType = 'intensive';
      } else if (durationMinutes > 120) {
        sessionType = 'extended';
      } else {
        sessionType = 'standard';
      }

      // Update session with classified type
      const updatedSession = await this.prisma.consumptionSession.update({
        where: { id: sessionId },
        data: {
          sessionTypeHeuristic: sessionType,
          observationFeature: hitsPerMinute,
        },
      });

      this.logSuccess('classifySessionType', { 
        sessionId,
        sessionType,
        hitsPerMinute, 
      });

      return updatedSession;
    } catch (error) {
      throw this.handleError(error, 'classifySessionType');
    }
  }

  /**
   * Find many sessions - ADMIN ONLY
   * Raw Prisma query access for administrative operations
   *
   * @param args - Prisma findMany arguments
   * @returns Array of consumption sessions
   */
  async findManyAdmin(args?: Prisma.SessionFindManyArgs): Promise<Session[]> {
    try {
      const sessions = await this.prisma.consumptionSession.findMany(args);
      this.logSuccess('findManyAdmin', { count: sessions.length });
      return sessions;
    } catch (error) {
      throw this.handleError(error, 'findManyAdmin');
    }
  }

  /**
   * Count sessions - ADMIN ONLY
   * Raw count query for administrative operations
   *
   * @param where - Prisma where clause for filtering
   * @returns Count of matching sessions
   */
  async countAdmin(where?: Prisma.SessionWhereInput): Promise<number> {
    try {
      const count = await this.prisma.consumptionSession.count({ where });
      this.logSuccess('countAdmin', { count });
      return count;
    } catch (error) {
      throw this.handleError(error, 'countAdmin');
    }
  }

  /**
   * Find many sessions with user authorization enforcement
   * Enforces userId security - only returns sessions owned by the specified user
   *
   * @param args - Prisma findMany arguments
   * @returns Array of sessions owned by the user
   */
  async findMany(args: Prisma.SessionFindManyArgs & { where: { userId: string } }): Promise<Session[]> {
    try {
      // Security: Ensure userId is always included in where clause
      if (!args.where || !args.where.userId) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'userId is required in where clause for findMany');
      }

      const sessions = await this.prisma.consumptionSession.findMany(args);
      this.logSuccess('findMany', { count: sessions.length, userId: args.where.userId });
      return sessions;
    } catch (error) {
      throw this.handleError(error, 'findMany');
    }
  }

  /**
   * Count sessions with user authorization enforcement
   * Enforces userId security - only counts sessions owned by the specified user
   *
   * @param where - Prisma where clause (must include userId)
   * @returns Count of sessions owned by the user
   */
  async count(where: Prisma.SessionWhereInput & { userId: string }): Promise<number> {
    try {
      // Security: Ensure userId is always included in where clause
      if (!where || !where.userId) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'userId is required in where clause for count');
      }

      const count = await this.prisma.consumptionSession.count({ where });
      this.logSuccess('count', { count, userId: where.userId });
      return count;
    } catch (error) {
      throw this.handleError(error, 'count');
    }
  }

  /**
   * Create session with outbox event in a single transaction.
   * Also closes any existing active sessions for the user with per-session
   * durable lifecycle events.
   *
   * @param data - Session creation data
   * @param closeActiveSessions - Whether to close active sessions first
   * @param outboxCallback - Function to add event to outbox for the NEW session
   * @param onCloseActiveSession - Callback invoked per closed active session within the
   *   same transaction. The SERVICE provides this to compute canonical aggregates and
   *   emit durable session.ended events. If omitted, sessions are closed without events
   *   (backward compat — NOT recommended for production paths).
   * @returns Created session
   */
  async createWithOutboxEvent(
    data: CreateSessionInput & { id?: string },
    closeActiveSessions: boolean,
    outboxCallback: (tx: Prisma.TransactionClient, session: Session) => Promise<void>,
    onCloseActiveSession?: (tx: Prisma.TransactionClient, closedSession: Session) => Promise<void>,
  ): Promise<Session> {
    try {
      // Controllers already validate input - repositories trust validated data

      return await this.executeTransaction(async (tx) => {
        // IDEMPOTENCY FIRST: if clientSessionId already exists, return existing
        // without side effects (no close-active, no outbox callback).
        if (data.clientSessionId) {
          const existing = await tx.consumptionSession.findUnique({
            where: {
              user_clientSessionId_unique: {
                userId: data.userId,
                clientSessionId: data.clientSessionId,
              },
            },
            include: {
              consumptions: true,
              purchase: true,
            },
          });

          if (existing) {
            this.logSuccess('createWithOutboxEvent.idempotentHit', {
              sessionId: existing.id,
              userId: existing.userId,
              clientSessionId: data.clientSessionId,
            });
            return existing;
          }
        }

        // Close any existing active sessions first if requested.
        // Each session is closed individually so the service-provided callback
        // can emit a durable session.ended outbox event per session.
        if (closeActiveSessions) {
          const activeSessions = await tx.consumptionSession.findMany({
            where: {
              userId: data.userId,
              status: 'ACTIVE',
            },
          });

          for (const activeSession of activeSessions) {
            const closedSession = await tx.consumptionSession.update({
              where: { id: activeSession.id },
              data: {
                sessionEndTimestamp: new Date(),
                status: 'COMPLETED',
              },
            });

            // Delegate aggregate computation + outbox event to service layer
            if (onCloseActiveSession) {
              await onCloseActiveSession(tx, closedSession);
            }
          }

          if (activeSessions.length > 0) {
            this.logSuccess('createWithOutboxEvent.closedActiveSessions', {
              userId: data.userId,
              closedCount: activeSessions.length,
              closedIds: activeSessions.map(s => s.id),
              hadCallback: !!onCloseActiveSession,
            });
          }
        }

        // Use UPSERT for deduplication with clientSessionId
        const session = await tx.consumptionSession.upsert({
          where: data.clientSessionId ? {
            user_clientSessionId_unique: {
              userId: data.userId,
              clientSessionId: data.clientSessionId,
            },
          } : {
            // If no clientSessionId, use a condition that will never match
            id: 'never-match-this-id',
          },
          update: {}, // Return existing record unchanged if found
          create: {
            id: data.id,
            clientSessionId: data.clientSessionId,
            userId: data.userId,
            sessionStartTimestamp: data.sessionStartTimestamp,
            sessionEndTimestamp: data.sessionEndTimestamp,
            sessionTypeHeuristic: data.sessionTypeHeuristic,
            purchaseId: data.purchaseId,
            // FIX: Include status and primaryProductId — service passes both
            // (session.service.ts:147,150) but they were silently dropped here.
            // status defaults to ACTIVE via Prisma schema if not provided.
            primaryProductId: data.primaryProductId ?? null,
            status: data.status, // ACTIVE, COMPLETED, etc. — Prisma defaults to ACTIVE if undefined
            eventCount: data.eventCount || 0,
            totalDurationMs: data.totalDurationMs || 0,
            avgEventDurationMs: data.avgEventDurationMs,
            observationFeature: data.observationFeature,
            notes: data.notes ?? null, // User-provided notes (synced from local-first app)
          },
          include: {
            consumptions: true,
            purchase: true,
          },
        });

        // Execute the outbox callback within the same transaction
        await outboxCallback(tx, session);

        this.logSuccess('createWithOutboxEvent', {
          sessionId: session.id,
          userId: session.userId,
        });

        return session;
      });
    } catch (error) {
      throw this.handleError(error, 'createWithOutboxEvent');
    }
  }

  /**
   * Update session with outbox event in a single transaction.
   * Ensures atomicity: if either the session update or the outbox write fails,
   * both are rolled back. Mirrors the createWithOutboxEvent pattern.
   *
   * @param id - Session ID
   * @param userId - User ID for authorization
   * @param data - Update data
   * @param outboxCallback - Function to add event to outbox within the transaction
   * @returns Updated session
   */
  async updateWithOutboxEvent(
    id: string,
    userId: string,
    data: UpdateSessionInput,
    outboxCallback: (tx: Prisma.TransactionClient, session: Session) => Promise<void>,
  ): Promise<Session> {
    try {
      return await this.executeTransaction(async (tx) => {
        const session = await this.update(id, userId, data, tx);

        // Execute the outbox callback within the same transaction
        await outboxCallback(tx, session);

        this.logSuccess('updateWithOutboxEvent', {
          sessionId: session.id,
          userId: session.userId,
        });

        return session;
      });
    } catch (error) {
      throw this.handleError(error, 'updateWithOutboxEvent');
    }
  }

  /**
   * Update observation features for multiple sessions with user authorization
   * All sessions must belong to the requesting user
   *
   * @param sessionUpdates - Array of session updates with observation features
   * @param requestingUserId - ID of user making the request
   * @returns Number of sessions updated
   * @throws AppError if any session doesn't belong to requesting user
   */
  async updateSessionObservations(
    sessionUpdates: Array<{
      sessionId: string;
      observationFeature?: number | null;
      sessionTypeHeuristic?: string | null;
      metadata?: Record<string, unknown>;
    }>,
    requestingUserId: string,
  ): Promise<number> {
    try {
      let totalUpdated = 0;

      await this.executeTransaction(async (tx) => {
        for (const update of sessionUpdates) {
          // SECURITY: Verify session belongs to requesting user before updating
          const existingSession = await tx.consumptionSession.findFirst({
            where: {
              id: update.sessionId,
              userId: requestingUserId,
            },
          });

          if (!existingSession) {
            throw new Error(`Access denied: Session ${update.sessionId} not found or doesn't belong to user ${requestingUserId}`);
          }
          const updateData: Prisma.SessionUpdateInput = {};

          if (update.observationFeature !== undefined) {
            updateData.observationFeature = update.observationFeature;
          }

          if (update.sessionTypeHeuristic !== undefined) {
            updateData.sessionTypeHeuristic = update.sessionTypeHeuristic;
          }

          // If metadata provided, store in a flexible way (this could be extended to use a metadata JSONB field)
          if (update.metadata) {
            // For now, we'll store specific metadata fields that exist in the schema
            if (update.metadata.eventCount !== undefined && typeof update.metadata.eventCount === 'number') {
              updateData.eventCount = update.metadata.eventCount;
            }
            if (update.metadata.totalDurationMs !== undefined && typeof update.metadata.totalDurationMs === 'number') {
              updateData.totalDurationMs = update.metadata.totalDurationMs;
            }
            if (update.metadata.avgEventDurationMs !== undefined && typeof update.metadata.avgEventDurationMs === 'number') {
              updateData.avgEventDurationMs = update.metadata.avgEventDurationMs;
            }
          }

          if (Object.keys(updateData).length > 0) {
            await tx.consumptionSession.update({
              where: {
                id: update.sessionId,
                userId: requestingUserId, // Double-check authorization
              },
              data: updateData,
            });
            totalUpdated++;
          }
        }
      });

      this.logSuccess('updateSessionObservations', {
        requestedUpdates: sessionUpdates.length,
        actualUpdates: totalUpdated,
        requestingUserId,
      });

      return totalUpdated;
    } catch (error) {
      throw this.handleError(error, 'updateSessionObservations');
    }
  }

  /**
   * Prune old sessions for storage management
   * Keeps the most recent sessions and deletes older ones
   *
   * @param userId - User ID
   * @param keepCount - Number of most recent sessions to keep
   * @returns Number of sessions deleted
   */
  async pruneOldSessions(userId: string, keepCount: number = 1000): Promise<number> {
    try {
      if (keepCount <= 0) {
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          'keepCount must be greater than 0',
          true,
        );
      }

      // First, get total count to see if pruning is needed
      const totalCount = await this.prisma.consumptionSession.count({
        where: { userId },
      });

      if (totalCount <= keepCount) {
        this.logSuccess('pruneOldSessions', {
          userId,
          totalCount,
          keepCount,
          deleted: 0,
          message: 'No pruning needed',
        });
        return 0;
      }

      // Get the sessions to keep (most recent ones)
      const sessionsToKeep = await this.prisma.consumptionSession.findMany({
        where: { userId },
        select: { id: true },
        orderBy: { sessionStartTimestamp: 'desc' },
        take: keepCount,
      });

      const keepIds = sessionsToKeep.map(s => s.id);

      // Delete old sessions not in the keep list
      const deleteResult = await this.prisma.consumptionSession.deleteMany({
        where: {
          userId,
          id: {
            notIn: keepIds,
          },
        },
      });

      this.logSuccess('pruneOldSessions', {
        userId,
        totalCount,
        keepCount,
        deleted: deleteResult.count,
      });

      return deleteResult.count;
    } catch (error) {
      throw this.handleError(error, 'pruneOldSessions');
    }
  }
}
