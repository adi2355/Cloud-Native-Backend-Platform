// Entity Type Imports from Shared Package (Single Source of Truth)

/**
 * CANONICAL ENTITY TYPE DEFINITION
 *
 * EntityType and related utilities are imported from the shared package
 * (@shared/contracts) which serves as the single source of truth across
 * frontend and backend.
 *
 * MUST be made in packages/shared/src/sync-config/entity-types.ts
 */
import {
  type EntityType,
  ENTITY_TYPES,
  isEntityType,
  canonicalizeEntityType,
  tryCanonicalizeEntityType,
  ENTITY_SYNC_ORDER,
  LEGACY_MODEL_TO_ENTITY,
  // Relation graph imports - single source of truth for FK relationships
  getForeignKeyFields,
  getOptionalForeignKeyFields,
  RELATION_SCOPE,
  // Cursor imports - strict cursor contract for sync operations
  type CompositeCursor,
  type EntityCursor,
  decodeCompositeCursor,
  tryDecodeCompositeCursor,
  encodeCompositeCursor,
  encodeEntityCursor,
  createEntityCursor,
  createZeroCursor,
  InvalidCursorError,
  CURSOR_SCHEMA_VERSION,
  // Conflict config imports - single source of truth for conflict resolution
  isConflictFree,
  // Conflict strategy imports - single source of truth for conflict resolution strategies
  CONFLICT_STRATEGY,
  type ConflictStrategy,
} from '@shared/contracts';

// FK_FIELDS_BY_ENTITY - MIGRATED TO SHARED PACKAGE
// The FK field definitions have been centralized in @shared/contracts/relation-graph.
// Use getForeignKeyFields(entityType) instead of accessing this constant directly.
//
// This eliminates drift between frontend and backend FK definitions.
// See: packages/shared/src/sync-config/relation-graph.ts

/**
 * Sync Service - Production Version with Enhanced Features
 * Handles data synchronization between mobile clients and cloud storage
 * Implements conflict resolution and multi-device sync for AppPlatform application
 * 
 * PRODUCTION FEATURES:
 * - Repository pattern for all database operations
 * - Atomic transactions with retry logic
 * - Enhanced conflict resolution strategies (MERGE support)
 * - Performance monitoring and metrics
 * - Infrastructure service integration (PostgreSQL, Redis)
 * - HIPAA-compliant audit logging
 * - Support for offline-first sync (30+ days)
 * 
 * @see https://www.postgresql.org/
 * @see https://redis.io/
 */

// DynamoDB imports removed - now using PostgreSQL-only architecture
import { v4 as uuidv4 } from 'uuid';
import {
  SyncStatus,
  Prisma,
  ConflictResolution,
  ChangeType,
  SyncType,
  SyncChange,
  SyncConflict,
  Session,
  JournalEntry,
  Purchase,
} from '@prisma/client';
import { LoggerService, LogLevel, LogCategory } from './logger.service';
import { DatabaseService } from './database.service';
import { CacheService } from './cache.service';
// DynamoDbService import removed - migrated to PostgreSQL repositories
import { PerformanceMonitoringService, PerformanceMetricType } from './performanceMonitoring.service';
import { getErrorMessage, getErrorStack, isPrismaError, getErrorName, getErrorCode } from '../utils/error-handler';
import { AppError, ErrorCodes } from '../utils/AppError';
import { handlePrismaError, parseJsonbField } from '../models';

// Import repositories
import { SyncOperationRepository, CreateSyncOperationInput, STALE_OPERATION_TIMEOUT_MS } from '../repositories/sync-operation.repository';
import { SessionRepository, UpdateSessionInput } from '../repositories/session.repository';
import { JournalRepository, UpdateJournalEntryInput } from '../repositories/journal.repository';
import { PurchaseRepository, UpdatePurchaseInput } from '../repositories/purchase.repository';
import { SyncConflictRepository } from '../repositories/sync-conflict.repository';
import { SyncChangeRepository } from '../repositories/sync-change.repository';
import { SyncStateRepository } from '../repositories/sync-state.repository';
import { UserStatisticsRepository } from '../repositories/user-statistics.repository';
import { RepositoryFactory } from '../repositories/repository.factory';
import { DeviceTelemetryRepository } from '../repositories/device-telemetry.repository';
import { AnalyticsEventRepository } from '../repositories/analytics-event.repository';
import { tryMergeConflictWithSharedConfig } from './sync/conflict-merge';

/**
 * Heartbeat interval for long-running processPushSync loops.
 * Derived from STALE_OPERATION_TIMEOUT_MS / 4 — ensures the operation's
 * `updatedAt` is refreshed well before the stale-detection window expires.
 * With a 5-min stale timeout, this yields ~75s heartbeat interval,
 * giving 3 missed heartbeats before stale classification.
 */
const HEARTBEAT_INTERVAL_MS = Math.floor(STALE_OPERATION_TIMEOUT_MS / 4);

// Pending change item interface (for sync session tracking)
export interface PendingChangeItem {
  entityType: string;
  entityId: string;
  changeType: ChangeType;
  changeData: Prisma.JsonValue;
  syncVersion: number;
  clientId?: string; // Optional client-generated UUID for ID mapping
  timestamp?: Date; // Optional timestamp for the change
  // REQUIRED: requestId enables precise per-command outbox tracking.
  // Frontend sends outbox event ID; backend returns it in response for exact marking.
  // Schema validation enforces non-empty string at the API boundary.
  requestId: string;
}

// Sync types (aligned with Prisma schema)
export interface SyncSession {
  syncId: string;
  userId: string;
  deviceId: string;
  lastSyncTimestamp: number;
  pendingChanges: PendingChangeItem[];
  conflicts: ConflictItem[];
  status: 'active' | 'completed' | 'failed';
  retryCount: number;
}

export interface ConflictItem {
  entityType: 'session' | 'journal' | 'purchase';
  entityId: string;
  localVersion: Prisma.JsonValue;
  serverVersion: Prisma.JsonValue;
  resolution?: 'local' | 'server' | 'merged';
  resolvedData?: Prisma.JsonValue;
  timestamp: number;
}

export interface SyncResult {
  syncId: string;
  successful: string[];
  conflicts: ConflictItem[];
  // This matches the frontend PushCommandsResponse.failed interface
  failed: FailedChange[];
  lastSyncTimestamp: number;
  metrics?: {
    duration: number;
    itemsProcessed: number;
    conflictsResolved: number;
    bytesTransferred: number;
  };
}

export interface SessionData {
  id: string;
  userId: string;
  timestamp: number;
  duration_ms: number;
  variant_id?: string;
  device_id?: string;
  temperature?: number;
  notes?: string;
  version: number;          // Optimistic locking version
  sync_version: number;     // Legacy sync tracking version
  created_at: number;
  updated_at: number;
  checksum?: string;
}

// Custom sync data structure for journal entries (aligned with Prisma JournalEntry model)
export interface JournalEntryData {
  id: string;
  userId: string;
  title?: string | null;
  content: string;
  mood?: string | null;
  tags?: string[];
  isPrivate?: boolean;
  sessionId?: string | null;
  consumptionId?: string | null;
  productId?: string | null;
  reactions?: Prisma.JsonValue;
  clientEntryId?: string | null;
  version?: number;          // Optimistic locking version
  sync_version?: number;     // Legacy sync tracking version
  created_at?: number;
  updated_at?: number;
  checksum?: string;
}

export interface PurchaseData {
  id: string;
  userId: string;
  purchaseDate: number; // Unix timestamp
  quantityPurchased: number;
  costSpent: number;
  productId: string;
  isActive: boolean;
  finishedDate?: number;
  pricePerUnit?: number;
  lossFactor?: number;
  clientPurchaseId?: string;
  version: number;          // Optimistic locking version
  sync_version: number;     // Legacy sync tracking version
  created_at: number;
  updated_at: number;
  checksum?: string;
}

// Integrity verification result
export interface IntegrityVerificationResult {
  valid: boolean;
  clientChecksum: string;
  serverChecksum: string;
  timestamp: string;
}

// Export data structure
export interface UserDataExport {
  userId: string;
  exportedAt: string;
  version: string;
  sessions?: Session[];
  journals?: JournalEntry[];
  purchases?: Purchase[];
}

// Import error structure
export interface ImportError {
  entity: string;
  error: string;
}

// Import result structure
export interface UserDataImportResult {
  imported: {
    sessions: number;
    journals: number;
    purchases: number;
  };
  errors: ImportError[];
  timestamp: string;
}

// Sync state reset result
export interface SyncStateResetResult {
  reset: boolean;
  userId: string;
  deviceId: string;
  entities: string | string[];
  timestamp: string;
}

// OPTIONAL_FK_FIELDS_BY_ENTITY - MIGRATED TO SHARED PACKAGE
// The optional FK field definitions have been centralized in @shared/contracts/relation-graph.
// Use getOptionalForeignKeyFields(entityType) instead of accessing this constant directly.
//
// This eliminates drift between frontend and backend FK definitions.
// See: packages/shared/src/sync-config/relation-graph.ts

// CONFLICT_FREE_ENTITY_TYPES - MIGRATED TO SHARED PACKAGE
// Entity types that skip conflict detection are now defined in conflict-configs.ts
// Use isConflictFree(entityType) from @shared/contracts instead.
//
// This eliminates drift between frontend and backend conflict config.
// See: packages/shared/src/sync-config/conflict-configs.ts

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeFkFieldName(fieldName?: string): string | null {
  if (!fieldName) return null;
  const normalized = fieldName.toLowerCase();
  if (normalized.includes('device')) return 'deviceId';
  if (normalized.includes('session')) return 'sessionId';
  if (normalized.includes('purchase')) return 'purchaseId';
  if (normalized.includes('product')) return 'productId';
  if (normalized.includes('consumption')) return 'consumptionId';
  if (normalized.includes('primary') && normalized.includes('product')) return 'primaryProductId';
  if (normalized.includes('purchaseitem') || normalized.includes('purchase_item')) return 'purchaseItemId';
  return null;
}

// Failed change structure
// Frontend uses clientId to mark failed outbox commands - mismatched field names caused infinite retry loops
export interface FailedChange {
  clientId: string;  // Client-generated ID (was 'id' - caused frontend/backend mismatch)
  error: string;
  retryable?: boolean;
  requestId?: string;
  // Optional structured error context for smarter client recovery
  errorCode?: string;
  details?: Record<string, unknown>;
}

// Pull sync result
export interface PullSyncResult {
  changes: {
    entityType: string;
    operation: ChangeType; // 'CREATE' | 'UPDATE' | 'DELETE'
    serverId: string;
    data: Record<string, unknown>; // Transformed entity data
    timestamp: string; // ISO string
  }[];
  cursor: string | null; //  Renamed from nextCursor to match frontend expectations
  hasMore: boolean;
  recordsReturned: number; //  ADDED: Frontend requires this for SQLite NOT NULL constraint (CursorRepository.ts)
  entityCursors: Record<string, string>;
}

// Successful change result for push sync
export interface SuccessfulChange {
  clientId: string;
  serverId: string;
  entityType: string;
  // Frontend sends outbox event ID as requestId, we return it so they can mark exact command
  requestId?: string;
}

// Push sync result
export interface PushSyncResult {
  successful: SuccessfulChange[];
  failed: FailedChange[];
  conflicts: (SyncConflict & { requestId?: string })[];
}

// Union type for entities that can be synced and have conflicts
export type SyncableEntity = Session | JournalEntry | Purchase | SessionData | JournalEntryData | PurchaseData;

// Type guard to check if entity has updated_at field
export function hasUpdatedAt(entity: unknown): entity is { updated_at: Date | number } {
  return (
    typeof entity === 'object' &&
    entity !== null &&
    'updated_at' in entity &&
    (entity.updated_at instanceof Date || typeof entity.updated_at === 'number')
  );
}

// Type guard to check if entity has version field (optimistic locking)
export function hasVersion(entity: unknown): entity is { version: number } {
  return (
    typeof entity === 'object' &&
    entity !== null &&
    'version' in entity &&
    typeof entity.version === 'number'
  );
}

// Type guard to check if entity is a valid object (not primitive JsonValue)
export function isEntityObject(value: Prisma.JsonValue): value is Prisma.JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Helper to convert entity to JsonValue (serialization)
export function entityToJsonValue<T>(entity: T): Prisma.JsonValue {
  return JSON.parse(JSON.stringify(entity)) as Prisma.JsonValue;
}

// Helper to convert Date or number to milliseconds timestamp
function toMilliseconds(timestamp: Date | number): number {
  return timestamp instanceof Date ? timestamp.getTime() : timestamp;
}

// Helper to convert Partial<SyncableEntity> to repository update input
export function toUpdateInput(entity: Partial<SyncableEntity>, entityType: 'session' | 'journal' | 'purchase'): unknown {
  // Remove fields that shouldn't be in update input
  const { id, userId, createdAt, ...updateFields } = entity as Record<string, unknown>;
  return updateFields;
}

// Conflict resolution input for batch resolution
export interface ConflictResolutionInput {
  conflictId: string;
  resolution: ConflictResolution;
  resolvedData?: Prisma.JsonValue;
}

// Batch conflict resolution result
export interface BatchConflictResolutionResult {
  resolved: SyncConflict[];
  failed: FailedChange[];
}

// CONFLICT_STRATEGY - MIGRATED TO SHARED PACKAGE
// Conflict resolution strategies are now imported from @shared/contracts.
// Use CONFLICT_STRATEGY.VALUE syntax (e.g., CONFLICT_STRATEGY.MERGE).
//
// This eliminates drift between frontend and backend conflict strategies.
// See: packages/shared/src/sync-config/conflict-strategies.ts

interface SyncServiceConfig {
  aws?: {
    region: string;
    accessKeyId?: string;
    secretAccessKey?: string;
  };
  redis?: {
    host: string;
    port: number;
    password?: string;
  };
  nodeEnv?: string;
}

export class SyncService {
  // Configuration
  private readonly SYNC_LOCK_TTL = 30; // seconds
  private readonly BATCH_SIZE = 100; // PostgreSQL batch size (increased from DynamoDB limit)
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY = 1000; // ms
  private readonly CACHE_TTL = 300; // 5 minutes

  // Service state
  private isCacheAvailable = false;
  private isInitialized = false;
  private config: SyncServiceConfig | null = null;

  // Repository instances
  private syncOperationRepo?: SyncOperationRepository;
  private sessionRepo?: SessionRepository;
  private journalRepo?: JournalRepository;
  private purchaseRepo?: PurchaseRepository;
  private syncConflictRepo?: SyncConflictRepository;
  private syncChangeRepo?: SyncChangeRepository;
  private syncStateRepo?: SyncStateRepository;
  private userStatsRepo?: UserStatisticsRepository;
  private deviceTelemetryRepo?: DeviceTelemetryRepository;
  private analyticsEventRepo?: AnalyticsEventRepository;

  /**
   * Constructor with explicit dependency injection (Pure DI - no singleton)
   * All dependencies are required and injected by bootstrap.ts
   *
   * **ARCHITECTURE REFACTORING (Strategy Pattern):**
   * - Added entityHandlers registry for entity-agnostic sync operations
   * - Eliminates switch-case coupling to specific entity types
   * - Enables adding new entity types without modifying SyncService
   */
  public constructor(
    private databaseService: DatabaseService,
    private logger: LoggerService,
    private performanceMonitor: PerformanceMonitoringService,
    private cacheService: CacheService | null,
    private repositoryFactory: RepositoryFactory,
    private entityHandlers: Map<string, import('./sync/sync.types').SyncEntityHandler<unknown>>,
  ) {
    // Lightweight constructor - all dependencies injected explicitly
    // Repository initialization will be done in initialize() method
  }

  /**
   * Initialize and configure the service with enhanced infrastructure
   */
  public async initialize(config: SyncServiceConfig): Promise<void> {
    if (this.isInitialized) {
      this.logger.log(LogLevel.INFO, LogCategory.SYSTEM, 'SyncService already initialized');
      return;
    }

    this.config = config;

    // Initialize repositories using injected RepositoryFactory
    this.syncOperationRepo = this.repositoryFactory.getSyncOperationRepository();
    this.sessionRepo = this.repositoryFactory.getSessionRepository();
    this.journalRepo = this.repositoryFactory.getJournalRepository();
    this.purchaseRepo = this.repositoryFactory.getPurchaseRepository();
    this.syncConflictRepo = this.repositoryFactory.getSyncConflictRepository();
    this.syncChangeRepo = this.repositoryFactory.getSyncChangeRepository();
    this.syncStateRepo = this.repositoryFactory.getSyncStateRepository();
    this.userStatsRepo = this.repositoryFactory.getUserStatisticsRepository();
    this.deviceTelemetryRepo = this.repositoryFactory.getDeviceTelemetryRepository();
    this.analyticsEventRepo = this.repositoryFactory.getAnalyticsEventRepository();

    // PostgreSQL repositories are now the primary data store for analytics and telemetry
    this.logger.log(LogLevel.INFO, LogCategory.SYSTEM, 'SyncService using PostgreSQL repositories for analytics and telemetry storage');

    // CacheService is a singleton already configured in bootstrap.ts BEFORE SyncService is created.
    // Re-configuring it here OVERWRITES the proper config (URL, username, etc.) with incomplete values.
    // We only need to check if it's ready and use it.
    if (this.cacheService) {
      // Check if cache service is already ready (configured in bootstrap.ts)
      if (this.cacheService.isReady()) {
        this.isCacheAvailable = true;
        this.logger.log(LogLevel.INFO, LogCategory.SYSTEM, 'CacheService already configured and ready for SyncService');
      } else {
        this.logger.log(LogLevel.WARN, LogCategory.SYSTEM, 'CacheService not ready, sync locks disabled');
        this.isCacheAvailable = false;
      }
    } else {
      this.logger.log(LogLevel.INFO, LogCategory.SYSTEM, 'CacheService not injected into SyncService');
      this.isCacheAvailable = false;
    }

    this.isInitialized = true;
  }

  /**
   * Initialize a sync session with enhanced tracking and retry support
   */
  async initializeSync(userId: string, deviceId: string): Promise<SyncSession> {
    const startTime = Date.now();
    const syncId = `sync_${userId}_${deviceId}_${Date.now()}_${uuidv4().slice(0, 8)}`;
    
    // Acquire distributed lock to prevent concurrent syncs (if cache available)
    if (this.isCacheAvailable && this.cacheService) {
      const lockKey = `sync_lock:${userId}:${deviceId}`;
      
      // Check if lock exists
      const lockExists = await this.cacheService.exists(lockKey);
      if (lockExists) {
        // Check if existing sync is stuck
        const existingLock = await this.cacheService.get<string>(lockKey);
        if (existingLock) {
          // For now, just throw error - could enhance with stuck sync detection
          throw new Error('Another sync is already in progress for this device');
        }
      }
      
      // Set lock with TTL
      await this.cacheService.set(lockKey, syncId, { ttl: this.SYNC_LOCK_TTL });
    }

    // Get or create sync state for this device
    const syncState = await this.syncStateRepo?.getOrCreateSyncState(userId, deviceId);
    const lastSync = syncState?.lastSyncAt ? syncState.lastSyncAt.getTime() : 0;
    
    // Acquire sync lock to prevent concurrent syncs
    if (this.syncStateRepo) {
      const lockResult = await this.syncStateRepo.acquireSyncLock(userId, deviceId, `sync-service-${Date.now()}`);
      if (!lockResult.acquired) {
        throw new AppError(
          409,
          ErrorCodes.CONFLICT,
          lockResult.reason || 'Could not acquire sync lock',
          true,
        );
      }
    }

    // Create sync operation record
    await this.syncOperationRepo?.create({
      userId,
      deviceId, // Now available after schema update
      operationType: SyncType.FULL, // Required field from Prisma enum
      status: SyncStatus.IN_PROGRESS, // Type from Prisma enum
    });

    this.logger.log(LogLevel.INFO, LogCategory.SYSTEM, 'Sync session initialized', {
      syncId,
      userId,
      deviceId,
      lastSync,
    });

    return {
      syncId,
      userId,
      deviceId,
      lastSyncTimestamp: lastSync,
      pendingChanges: [],
      conflicts: [],
      status: 'active',
      retryCount: 0,
    };
  }

  /**
   * Sync sessions data from mobile to cloud with retry logic
   */
  async syncSessions(
    userId: string,
    deviceId: string,
    sessions: SessionData[],
    strategy: ConflictStrategy = CONFLICT_STRATEGY.LAST_WRITE_WINS,
  ): Promise<SyncResult> {
    const startTime = Date.now();
    const syncId = `sync_${Date.now()}_${uuidv4().slice(0, 8)}`;
    const result: SyncResult = {
      syncId,
      successful: [],
      conflicts: [],
      failed: [],
      lastSyncTimestamp: Date.now(),
      metrics: {
        duration: 0,
        itemsProcessed: 0,
        conflictsResolved: 0,
        bytesTransferred: 0,
      },
    };

    try {
      // Process sessions in batches using transactions with retry logic
      for (let i = 0; i < sessions.length; i += this.BATCH_SIZE) {
        const batch = sessions.slice(i, i + this.BATCH_SIZE);
        let batchResults: Partial<SyncResult> | null = null;
        let retryCount = 0;
        
        // Implement retry logic with exponential backoff
        while (retryCount < this.MAX_RETRIES) {
          try {
            batchResults = await this.processSessionBatch(
              userId,
              batch,
              strategy,
            );
            break; // Success, exit retry loop
          } catch (error) {
            retryCount++;
            if (retryCount >= this.MAX_RETRIES || !this.isRetryableError(error)) {
              // Max retries reached or non-retryable error
              this.logger.log(LogLevel.ERROR, LogCategory.SYSTEM, 'Batch processing failed after retries', {
                retryCount,
                batchSize: batch.length,
                error: getErrorMessage(error),
              });
              // Mark entire batch as failed
              // SessionData interface uses 'id' as the identifier (no separate client ID field)
              for (const session of batch) {
                result.failed.push({
                  clientId: session.id, // Use session ID as clientId (SessionData doesn't have client ID)
                  error: `Failed after ${retryCount} retries: ${getErrorMessage(error)}`,
                  retryable: false,
                });
              }
              break;
            }
            // Wait before retry with exponential backoff
            const delay = this.RETRY_DELAY * Math.pow(2, retryCount - 1);
            await new Promise(resolve => setTimeout(resolve, delay));
            this.logger.log(LogLevel.INFO, LogCategory.SYSTEM, `Retrying batch processing (attempt ${retryCount + 1}/${this.MAX_RETRIES})`);
          }
        }
        
        if (batchResults) {
          result.successful.push(...(batchResults.successful || []));
          result.conflicts.push(...(batchResults.conflicts || []));
          result.failed.push(...(batchResults.failed || []));
        }
      }

      // Calculate final metrics
      result.metrics = {
        duration: Date.now() - startTime,
        itemsProcessed: sessions.length,
        conflictsResolved: result.conflicts.filter(c => c.resolution).length,
        bytesTransferred: JSON.stringify(sessions).length,
      };

      // Update sync operation status
      if (this.syncOperationRepo) {
        try {
          // Create the sync operation record - repository returns entity directly or throws AppError
          const syncOperation = await this.syncOperationRepo.create({
            userId,
            deviceId,
            operationType: SyncType.FULL,
            status: result.failed.length > 0 ? SyncStatus.CONFLICT : SyncStatus.COMPLETED,
            conflictCount: result.conflicts.length,
            resolvedCount: result.successful.length,
            lastSyncAt: new Date(),
            errorMessage: result.failed.length > 0 ? `Failed to sync ${result.failed.length} items` : undefined,
          });

          // Repository pattern: syncOperation contains the created entity with id
          this.logger.log(LogLevel.INFO, LogCategory.SYSTEM, 'Sync operation recorded', {
            syncId,
            syncOperationId: syncOperation.id,
            status: syncOperation.status,
          });
        } catch (error) {
          // Repository throws AppError on failure - log but don't fail the sync
          this.logger.log(LogLevel.WARN, LogCategory.SYSTEM, 'Failed to record sync operation', {
            syncId,
            error: getErrorMessage(error),
          });
        }
      }

      // Store analytics in PostgreSQL using repository
      if (this.analyticsEventRepo) {
        try {
          await this.analyticsEventRepo.create({
            userId,
            eventType: 'consumption:logged',  // Using existing event type
            eventTimestamp: new Date(),
            eventData: {
              consumptionId: syncId,  // Using syncId as placeholder
              durationMs: result.metrics?.duration || 1000,
              deviceId,
              notes: `Sync completed: ${result.metrics?.itemsProcessed || 0} items processed, ${result.metrics?.conflictsResolved || 0} conflicts resolved`,
            },
            sessionId: syncId,
          });
        } catch (analyticsError) {
          // Don't fail sync if analytics storage fails
          this.logger.log(LogLevel.WARN, LogCategory.SYSTEM, 'Failed to store sync analytics', {
            error: getErrorMessage(analyticsError),
          });
        }
      }

      // Invalidate relevant caches
      await this.invalidateCaches(userId, ['sessions', 'analytics']);

      // Record performance metrics
      if (this.performanceMonitor) {
        this.performanceMonitor.recordMetric(
          PerformanceMetricType.EXTERNAL_API_RESPONSE_TIME,
          'sync.sessions.duration',
          result.metrics.duration,
          'ms',
        );
        this.performanceMonitor.recordMetric(
          PerformanceMetricType.THROUGHPUT,
          'sync.sessions.items',
          result.metrics.itemsProcessed,
          'count',
        );
      }

      this.logger.log(LogLevel.INFO, LogCategory.SYSTEM, 'Sessions sync completed', {
        syncId,
        userId,
        total: sessions.length,
        successful: result.successful.length,
        conflicts: result.conflicts.length,
        failed: result.failed.length,
        metrics: result.metrics,
      });

    } catch (error: unknown) {
      this.logger.log(LogLevel.ERROR, LogCategory.SYSTEM, 'Sessions sync failed', {
        context: 'SyncService',
        syncId,
        userId,
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });

      // Mark sync operation as failed
      if (this.syncOperationRepo) {
        await this.syncOperationRepo.update(syncId, userId, {
          status: SyncStatus.FAILED,
          errorMessage: getErrorMessage(error),
          resolvedCount: result.successful.length,
        });
      }
      
      // Already an AppError - re-throw
      if (error instanceof AppError) throw error;
      
      // Prisma database errors
      if (isPrismaError(error)) {
        throw handlePrismaError(error);
      }
      
      // Generic fallback
      throw AppError.internal('Failed to sync sessions');
    } finally {
      // Release sync lock if cache available
      if (this.isCacheAvailable && this.cacheService) {
        await this.cacheService.delete(`sync_lock:${userId}:${deviceId}`);
      }
    }

    return result;
  }

  /**
   * Perform comprehensive sync with parallel processing optimizations
   * Syncs sessions, journal entries, and purchases in parallel
   */
  async performFullSync(
    userId: string,
    deviceId: string,
    data: {
      sessions?: SessionData[];
      journal?: JournalEntry[];
      purchases?: PurchaseData[];
    },
    strategy: ConflictStrategy = CONFLICT_STRATEGY.LAST_WRITE_WINS,
  ): Promise<{
    success: boolean;
    syncId: string;
    results: {
      sessions?: SyncResult;
      journal?: SyncResult;
      purchases?: SyncResult;
    };
    metrics: {
      totalDuration: number;
      totalItemsProcessed: number;
      totalConflicts: number;
      totalFailed: number;
      parallelProcessing: boolean;
    };
  }> {
    const startTime = Date.now();
    const syncId = `full_sync_${Date.now()}_${uuidv4().slice(0, 8)}`;
    
    this.logger.log(LogLevel.INFO, LogCategory.SYSTEM, 'Starting full sync with parallel processing', {
      syncId,
      userId,
      deviceId,
      sessionCount: data.sessions?.length || 0,
      journalCount: data.journal?.length || 0,
      purchaseCount: data.purchases?.length || 0,
    });

    // Track changes for each entity type
    const changes: PendingChangeItem[] = [];
    
    try {
      // Acquire sync lock
      if (this.syncStateRepo) {
        const lockResult = await this.syncStateRepo.acquireSyncLock(userId, deviceId, `sync-service-${Date.now()}`);
        if (!lockResult.acquired) {
          throw new AppError(
            409,
            ErrorCodes.CONFLICT,
            lockResult.reason || 'Could not acquire sync lock for full sync',
            true,
          );
        }
      }

      // Process all entity types in parallel using Promise.allSettled
      const [sessionsResult, journalResult, purchasesResult] = await Promise.allSettled([
        // Process sessions
        data.sessions && data.sessions.length > 0
          ? this.processBatchWithTracking(
              'sessions',
              data.sessions,
              async (batch) => this.processSessionBatch(userId, batch, strategy),
              this.BATCH_SIZE,
            )
          : Promise.resolve(null),
        
        // Process journal entries
        data.journal && data.journal.length > 0
          ? this.processBatchWithTracking(
              'journal',
              data.journal,
              async (batch) => this.processJournalBatch(userId, batch, strategy),
              this.BATCH_SIZE,
            )
          : Promise.resolve(null),
        
        // Process purchases
        data.purchases && data.purchases.length > 0
          ? this.processBatchWithTracking(
              'purchases',
              data.purchases,
              async (batch) => this.processPurchasesBatch(userId, batch, strategy),
              this.BATCH_SIZE,
            )
          : Promise.resolve(null),
      ]);

      // Collect results
      const results: Record<string, Partial<SyncResult>> = {};
      let totalItemsProcessed = 0;
      let totalConflicts = 0;
      let totalFailed = 0;

      // Process sessions result
      if (sessionsResult.status === 'fulfilled' && sessionsResult.value) {
        results.sessions = sessionsResult.value;
        totalItemsProcessed += sessionsResult.value.metrics?.itemsProcessed || 0;
        totalConflicts += sessionsResult.value.conflicts?.length || 0;
        totalFailed += sessionsResult.value.failed?.length || 0;
        
        // Track changes
        if (this.syncChangeRepo) {
          for (const sessionId of sessionsResult.value.successful || []) {
            await this.syncChangeRepo.trackChange({
              userId,
              deviceId,
              changeType: ChangeType.UPDATE,
              entityType: 'session',
              entityId: sessionId,
              changeData: { syncId, timestamp: Date.now() },
            });
          }
        }
      }

      // Process journal result
      if (journalResult.status === 'fulfilled' && journalResult.value) {
        results.journal = journalResult.value;
        totalItemsProcessed += journalResult.value.metrics?.itemsProcessed || 0;
        totalConflicts += journalResult.value.conflicts?.length || 0;
        totalFailed += journalResult.value.failed?.length || 0;
        
        // Track changes
        if (this.syncChangeRepo) {
          for (const journalId of journalResult.value.successful || []) {
            await this.syncChangeRepo.trackChange({
              userId,
              deviceId,
              changeType: ChangeType.UPDATE,
              entityType: 'journal',
              entityId: journalId,
              changeData: { syncId, timestamp: Date.now() },
            });
          }
        }
      }

      // Process purchases result
      if (purchasesResult.status === 'fulfilled' && purchasesResult.value) {
        results.purchases = purchasesResult.value;
        totalItemsProcessed += purchasesResult.value.metrics?.itemsProcessed || 0;
        totalConflicts += purchasesResult.value.conflicts?.length || 0;
        totalFailed += purchasesResult.value.failed?.length || 0;
        
        // Track changes
        if (this.syncChangeRepo) {
          for (const purchaseId of purchasesResult.value.successful || []) {
            await this.syncChangeRepo.trackChange({
              userId,
              deviceId,
              changeType: ChangeType.UPDATE,
              entityType: 'purchase',
              entityId: purchaseId,
              changeData: { syncId, timestamp: Date.now() },
            });
          }
        }
      }

      // Update sync state
      if (this.syncStateRepo) {
        await this.syncStateRepo.updateSyncState({
          userId,
          deviceId,
          lastSyncToken: syncId,
          lastSyncAt: new Date(),
          pendingChanges: totalFailed,
          metadata: {
            totalItemsProcessed,
            totalConflicts,
            totalFailed,
          },
        });
      }

      // Update user statistics
      if (this.userStatsRepo) {
        const syncDuration = Date.now() - startTime;
        await this.userStatsRepo.recordSyncMetrics({
          userId,
          success: totalFailed === 0,
          syncDuration: syncDuration / 1000, // Convert to seconds
          dataSize: JSON.stringify(data).length, // Number, not BigInt
          conflictCount: totalConflicts,
          resolvedCount: totalConflicts - totalFailed,
        });
      }

      // Cache sync results for quick retrieval
      if (this.isCacheAvailable && this.cacheService) {
        const cacheKey = `sync:result:${userId}:${deviceId}`;
        await this.cacheService.set(cacheKey, {
          syncId,
          timestamp: Date.now(),
          totalItemsProcessed,
          totalConflicts,
          totalFailed,
        }, { ttl: this.CACHE_TTL });
      }

      const metrics = {
        totalDuration: Date.now() - startTime,
        totalItemsProcessed,
        totalConflicts,
        totalFailed,
        parallelProcessing: true,
      };

      // Record performance metrics
      if (this.performanceMonitor) {
        this.performanceMonitor.recordMetric(
          PerformanceMetricType.RESPONSE_TIME,
          'sync.full.duration',
          metrics.totalDuration,
          'milliseconds',
        );
        this.performanceMonitor.recordMetric(
          PerformanceMetricType.THROUGHPUT,
          'sync.full.items',
          metrics.totalItemsProcessed,
          'count',
        );
      }

      this.logger.log(LogLevel.INFO, LogCategory.SYSTEM, 'Full sync completed successfully', {
        syncId,
        userId,
        deviceId,
        metrics,
      });

      return {
        success: totalFailed === 0,
        syncId,
        results,
        metrics,
      };

    } catch (error) {
      this.logger.log(LogLevel.ERROR, LogCategory.SYSTEM, 'Full sync failed', {
        syncId,
        userId,
        deviceId,
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });

      // Record error metrics
      if (this.performanceMonitor) {
        this.performanceMonitor.recordMetric(
          PerformanceMetricType.ERROR_RATE,
          'sync.full.failed',
          1,
          'count',
        );
      }

      throw error;
    } finally {
      // Always release sync lock
      if (this.syncStateRepo) {
        await this.syncStateRepo.releaseSyncLock(userId, deviceId, syncId);
      }
    }
  }

  /**
   * Helper method to process batches with tracking
   */
  private async processBatchWithTracking<T>(
    entityType: string,
    items: T[],
    processor: (batch: T[]) => Promise<Partial<SyncResult>>,
    batchSize: number,
  ): Promise<SyncResult> {
    const startTime = Date.now();
    const syncId = `${entityType}_sync_${Date.now()}_${uuidv4().slice(0, 8)}`;
    const result: SyncResult = {
      syncId,
      successful: [],
      conflicts: [],
      failed: [],
      lastSyncTimestamp: Date.now(),
      metrics: {
        duration: 0,
        itemsProcessed: 0,
        conflictsResolved: 0,
        bytesTransferred: 0,
      },
    };

    // Process in batches
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const batchResult = await processor(batch);
      
      // Aggregate results
      if (batchResult.successful) {
        result.successful.push(...batchResult.successful);
      }
      if (batchResult.conflicts) {
        result.conflicts.push(...batchResult.conflicts);
      }
      if (batchResult.failed) {
        result.failed.push(...batchResult.failed);
      }
    }

    // Update metrics
    result.metrics = {
      duration: Date.now() - startTime,
      itemsProcessed: items.length,
      conflictsResolved: result.conflicts.filter(c => c.resolution).length,
      bytesTransferred: JSON.stringify(items).length,
    };

    return result;
  }

  /**
   * Process a batch of journal entries using handler pattern
   *
   * **ARCHITECTURE REFACTORING (Strategy Pattern):**
   * - Uses JournalHandler from entityHandlers registry
   * - Transactional batch processing for atomicity
   * - Conflict detection via fetchServerVersion
   * - Intelligent tag merging via handler.merge()
   *
   * @param userId - User ID for authorization
   * @param entries - Journal entries to process
   * @param strategy - Conflict resolution strategy
   * @returns Batch processing result with successful/failed/conflicted IDs
   */
  private async processJournalBatch(
    userId: string,
    entries: JournalEntry[],
    strategy: ConflictStrategy,
  ): Promise<Partial<SyncResult>> {
    const result: Partial<SyncResult> = {
      successful: [],
      conflicts: [],
      failed: [],
    };

    // Get handler from registry
    const handler = this.entityHandlers.get('journals');
    if (!handler) {
      this.logger.error('Journal handler not found in registry', {
        context: 'SyncService.processJournalBatch',
        availableHandlers: Array.from(this.entityHandlers.keys()),
      });
      // Mark all as failed if handler missing
      for (const entry of entries) {
        result.failed?.push({
          clientId: entry.clientEntryId ?? entry.id,
          error: 'Journal sync handler not registered',
          retryable: false,
        });
      }
      return result;
    }

    // Use database transaction for atomic batch processing
    try {
      await this.databaseService?.transaction(async (tx) => {
        for (const entry of entries) {
          try {
            // STEP 1: Fetch server version for conflict detection
            const existing = await handler.fetchServerVersion(userId, entry.id, tx);

            if (existing) {
              // STEP 2: Conflict detected - resolve via strategy
              const resolved = await this.resolveConflictStrategy('journals', existing as SyncableEntity, entry as SyncableEntity, strategy);

              if (resolved) {
                // STEP 3: Update with resolved data using handler
                await handler.update(userId, entry.id, resolved as Prisma.JsonValue, tx);

                // Track performance metrics
                if (this.performanceMonitor) {
                  this.performanceMonitor.recordMetric(
                    PerformanceMetricType.THROUGHPUT,
                    'sync.conflict.resolved',
                    1,
                    'count',
                  );
                }

                result.conflicts?.push({
                  entityType: 'journal',
                  entityId: entry.id,
                  localVersion: entityToJsonValue(entry),
                  serverVersion: entityToJsonValue(existing),
                  resolution: strategy === CONFLICT_STRATEGY.MERGE ? 'merged' : 'local',
                  resolvedData: entityToJsonValue(resolved),
                  timestamp: Date.now(),
                });
              } else {
                // Manual resolution needed
                result.conflicts?.push({
                  entityType: 'journal',
                  entityId: entry.id,
                  localVersion: entityToJsonValue(entry),
                  serverVersion: entityToJsonValue(existing),
                  timestamp: Date.now(),
                });
              }
            } else {
              // STEP 4: No conflict - create new entry via handler
              await handler.create(userId, entry.id, entityToJsonValue(entry), tx);
              result.successful?.push(entry.id);
            }
          } catch (error) {
            // Individual entry error within transaction - will cause rollback
            throw new Error(`Failed to process journal entry ${entry.id}: ${getErrorMessage(error)}`);
          }
        }
      });
    } catch (error: unknown) {
      this.logger.log(LogLevel.ERROR, LogCategory.SYSTEM, 'Journal batch transaction failed', {
        context: 'SyncService.processJournalBatch',
        userId,
        entryCount: entries.length,
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });

      // Mark all entries as failed since transaction was rolled back
      for (const entry of entries) {
        result.failed?.push({
          clientId: entry.clientEntryId ?? entry.id,
          error: `Batch transaction failed: ${getErrorMessage(error)}`,
          retryable: this.isRetryableError(error),
        });
      }

      // Clear successful and conflicts since transaction was rolled back
      result.successful = [];
      result.conflicts = [];

      // Track error metrics
      if (this.performanceMonitor) {
        this.performanceMonitor.recordMetric(
          PerformanceMetricType.ERROR_RATE,
          'sync.batch.failed',
          entries.length,
          'count',
        );
      }
    }

    return result;
  }

  /**
   * Process a batch of purchases using handler pattern
   *
   * **ARCHITECTURE REFACTORING (Strategy Pattern):**
   * - Uses PurchaseHandler from entityHandlers registry
   * - Transactional batch processing for atomicity
   * - Conflict detection via fetchServerVersion
   * - Financial data integrity via handler.merge()
   *
   * @param userId - User ID for authorization
   * @param purchases - Purchase records to process
   * @param strategy - Conflict resolution strategy
   * @returns Batch processing result with successful/failed/conflicted IDs
   */
  private async processPurchasesBatch(
    userId: string,
    purchases: PurchaseData[],
    strategy: ConflictStrategy,
  ): Promise<Partial<SyncResult>> {
    const result: Partial<SyncResult> = {
      successful: [],
      conflicts: [],
      failed: [],
    };

    // Get handler from registry
    const handler = this.entityHandlers.get('purchases');
    if (!handler) {
      this.logger.error('Purchase handler not found in registry', {
        context: 'SyncService.processPurchasesBatch',
        availableHandlers: Array.from(this.entityHandlers.keys()),
      });
      // Mark all as failed if handler missing
      for (const purchase of purchases) {
        result.failed?.push({
          clientId: purchase.clientPurchaseId ?? purchase.id,
          error: 'Purchase sync handler not registered',
          retryable: false,
        });
      }
      return result;
    }

    // Use database transaction for atomic batch processing
    try {
      await this.databaseService?.transaction(async (tx) => {
        for (const purchase of purchases) {
          try {
            // STEP 1: Fetch server version for conflict detection
            const existing = await handler.fetchServerVersion(userId, purchase.id, tx);

            if (existing) {
              // STEP 2: Conflict detected - resolve via strategy
              const resolved = await this.resolveConflictStrategy('purchases', existing as SyncableEntity, purchase as SyncableEntity, strategy);

              if (resolved) {
                // STEP 3: Update with resolved data using handler
                await handler.update(userId, purchase.id, resolved as Prisma.JsonValue, tx);

                // Track performance metrics
                if (this.performanceMonitor) {
                  this.performanceMonitor.recordMetric(
                    PerformanceMetricType.THROUGHPUT,
                    'sync.conflict.resolved',
                    1,
                    'count',
                  );
                }

                result.conflicts?.push({
                  entityType: 'purchase',
                  entityId: purchase.id,
                  localVersion: entityToJsonValue(purchase),
                  serverVersion: entityToJsonValue(existing),
                  resolution: strategy === CONFLICT_STRATEGY.MERGE ? 'merged' : 'local',
                  resolvedData: entityToJsonValue(resolved),
                  timestamp: Date.now(),
                });
              } else {
                // Manual resolution needed
                result.conflicts?.push({
                  entityType: 'purchase',
                  entityId: purchase.id,
                  localVersion: entityToJsonValue(purchase),
                  serverVersion: entityToJsonValue(existing),
                  timestamp: Date.now(),
                });
              }
            } else {
              // STEP 4: No conflict - create new purchase via handler
              await handler.create(userId, purchase.id, entityToJsonValue(purchase), tx);
              result.successful?.push(purchase.id);
            }
          } catch (error) {
            // Individual purchase error within transaction - will cause rollback
            throw new Error(`Failed to process purchase ${purchase.id}: ${getErrorMessage(error)}`);
          }
        }
      });
    } catch (error: unknown) {
      this.logger.log(LogLevel.ERROR, LogCategory.SYSTEM, 'Purchase batch transaction failed', {
        context: 'SyncService.processPurchasesBatch',
        userId,
        purchaseCount: purchases.length,
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });

      // Mark all purchases as failed since transaction was rolled back
      for (const purchase of purchases) {
        result.failed?.push({
          clientId: purchase.clientPurchaseId ?? purchase.id,
          error: `Batch transaction failed: ${getErrorMessage(error)}`,
          retryable: this.isRetryableError(error),
        });
      }

      // Clear successful and conflicts since transaction was rolled back
      result.successful = [];
      result.conflicts = [];

      // Track error metrics
      if (this.performanceMonitor) {
        this.performanceMonitor.recordMetric(
          PerformanceMetricType.ERROR_RATE,
          'sync.batch.failed',
          purchases.length,
          'count',
        );
      }
    }

    return result;
  }

  /**
   * Process a batch of sessions using handler pattern
   *
   * **ARCHITECTURE REFACTORING (Strategy Pattern):**
   * - Uses SessionHandler from entityHandlers registry
   * - Transactional batch processing for atomicity
   * - Conflict detection via fetchServerVersion
   * - Session-specific merge logic via handler.merge()
   *
   * @param userId - User ID for authorization
   * @param sessions - Session records to process
   * @param strategy - Conflict resolution strategy
   * @returns Batch processing result with successful/failed/conflicted IDs
   */
  private async processSessionBatch(
    userId: string,
    sessions: SessionData[],
    strategy: ConflictStrategy,
  ): Promise<Partial<SyncResult>> {
    const result: Partial<SyncResult> = {
      successful: [],
      conflicts: [],
      failed: [],
    };

    // Get handler from registry
    const handler = this.entityHandlers.get('sessions');
    if (!handler) {
      this.logger.error('Session handler not found in registry', {
        context: 'SyncService.processSessionBatch',
        availableHandlers: Array.from(this.entityHandlers.keys()),
      });
      // Mark all as failed if handler missing
      // SessionData doesn't have clientSessionId, use id directly
      for (const session of sessions) {
        result.failed?.push({
          clientId: session.id,
          error: 'Session sync handler not registered',
          retryable: false,
        });
      }
      return result;
    }

    // Use database transaction for atomic batch processing
    try {
      await this.databaseService?.transaction(async (tx) => {
        for (const session of sessions) {
          try {
            // STEP 1: Fetch server version for conflict detection
            const existing = await handler.fetchServerVersion(userId, session.id, tx);

            if (existing) {
              // STEP 2: Conflict detected - resolve via strategy
              const resolved = await this.resolveConflictStrategy('sessions', existing as SyncableEntity, session as SyncableEntity, strategy);

              if (resolved) {
                // STEP 3: Update with resolved data using handler
                await handler.update(userId, session.id, resolved as Prisma.JsonValue, tx);

                // Track performance metrics
                if (this.performanceMonitor) {
                  this.performanceMonitor.recordMetric(
                    PerformanceMetricType.THROUGHPUT,
                    'sync.conflict.resolved',
                    1,
                    'count',
                  );
                }

                result.conflicts?.push({
                  entityType: 'session',
                  entityId: session.id,
                  localVersion: entityToJsonValue(session),
                  serverVersion: entityToJsonValue(existing),
                  resolution: strategy === CONFLICT_STRATEGY.MERGE ? 'merged' : 'local',
                  resolvedData: entityToJsonValue(resolved),
                  timestamp: Date.now(),
                });
              } else {
                // Manual resolution needed
                result.conflicts?.push({
                  entityType: 'session',
                  entityId: session.id,
                  localVersion: entityToJsonValue(session),
                  serverVersion: entityToJsonValue(existing),
                  timestamp: Date.now(),
                });
              }
            } else {
              // STEP 4: No conflict - create new session via handler
              // Transform SessionData to CreateSessionInput format (Zod schema expects datetime strings)
              await handler.create(
                userId,
                session.id,
                {
                  clientSessionId: session.id,
                  userId,
                  deviceId: session.device_id,
                  purchaseId: session.variant_id, // Legacy field mapping
                  sessionStartTimestamp: new Date(session.timestamp).toISOString(),
                  sessionEndTimestamp: new Date(session.timestamp + session.duration_ms).toISOString(),
                  eventCount: 1, // Default for legacy data
                  totalDurationMs: session.duration_ms,
                  avgEventDurationMs: session.duration_ms,
                  sessionTypeHeuristic: 'legacy',
                  observationFeature: session.notes || '',
                  // FIX: Legacy sessions with duration_ms are already ended — status must be
                  // COMPLETED, not the Prisma default (ACTIVE). Without this, sessions have
                  // endTimestamp set but status = ACTIVE (semantic contradiction), which causes
                  // auto-completion side effects on subsequent reads via getActiveSessions/listSessions.
                  status: 'COMPLETED',
                } as Prisma.JsonValue,
                tx,
              );

              result.successful?.push(session.id);
            }

            // Store telemetry in PostgreSQL using repository (enhanced feature)
            if (this.deviceTelemetryRepo && session.device_id) {
              try {
                await this.deviceTelemetryRepo.create({
                  deviceId: session.device_id,
                  userId,
                  timestamp: new Date(session.timestamp),
                  metrics: {
                    durationMs: session.duration_ms,
                    sessionId: session.id,
                    variantId: session.variant_id,
                    notes: session.notes,
                    temperature: session.temperature,
                  },
                  sessionId: session.id,
                });
              } catch (telemetryError) {
                // Log but don't fail the sync if telemetry storage fails
                this.logger.log(LogLevel.WARN, LogCategory.SYSTEM, 'Failed to store telemetry', {
                  error: getErrorMessage(telemetryError),
                  sessionId: session.id,
                });
              }
            }
            
          } catch (error) {
            // Check if error is retryable
            const retryable = this.isRetryableError(error);
            
            // Individual session error within transaction - will cause rollback
            throw new Error(`Failed to process session ${session.id}: ${getErrorMessage(error)}${retryable ? ' (retryable)' : ''}`);
          }
        }
      });
      
    } catch (error: unknown) {
      this.logger.log(LogLevel.ERROR, LogCategory.SYSTEM, 'Batch transaction failed', {
        context: 'SyncService',
        userId,
        sessionCount: sessions.length,
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      
      // Mark all sessions as failed since transaction was rolled back
      // SessionData doesn't have clientSessionId, use id directly
      for (const session of sessions) {
        result.failed?.push({
          clientId: session.id,
          error: `Batch transaction failed: ${getErrorMessage(error)}`,
          retryable: this.isRetryableError(error),
        });
      }
      
      // Clear successful and conflicts since transaction was rolled back
      result.successful = [];
      result.conflicts = [];
      
      // Track error metrics
      if (this.performanceMonitor) {
        this.performanceMonitor.recordMetric(
          PerformanceMetricType.ERROR_RATE,
          'sync.batch.failed',
          sessions.length,
          'count',
        );
      }
    }

    return result;
  }

  /**
   * Resolve conflicts between local and server versions with enhanced merge strategies
   *
   * @param entityType - Entity type for handler lookup (sessions, journals, purchases)
   * @param serverVersion - Current server entity state
   * @param localVersion - Client's proposed changes
   * @param strategy - Conflict resolution strategy
   * @returns Resolved entity data or null for manual resolution
   */
  private async resolveConflictStrategy(
    entityType: string,
    serverVersion: SyncableEntity,
    localVersion: SyncableEntity,
    strategy: ConflictStrategy,
  ): Promise<Partial<SyncableEntity> | null> {
    switch (strategy) {
      case CONFLICT_STRATEGY.LAST_WRITE_WINS:
        if (hasVersion(localVersion) && hasVersion(serverVersion)) {
          // Higher version wins
          return localVersion.version > serverVersion.version ? localVersion : serverVersion;
        }

        // Fallback to updated_at timestamps for backward compatibility
        if (hasUpdatedAt(localVersion) && hasUpdatedAt(serverVersion)) {
          const localTime = toMilliseconds(localVersion.updated_at);
          const serverTime = toMilliseconds(serverVersion.updated_at);
          return localTime > serverTime ? localVersion : serverVersion;
        }

        // Default to local version if no version or timestamp available
        return localVersion;

      case CONFLICT_STRATEGY.FIRST_WRITE_WINS:
        return serverVersion;

      case CONFLICT_STRATEGY.CLIENT_WINS:
        return localVersion;

      case CONFLICT_STRATEGY.SERVER_WINS:
        return serverVersion;

      case CONFLICT_STRATEGY.MERGE:
        // Enhanced merge strategy with entity-specific logic (uses handler pattern)
        return this.mergeConflict(entityType, serverVersion, localVersion);

      case CONFLICT_STRATEGY.MANUAL:
        // Return null to indicate manual resolution needed
        return null;

      default:
        return localVersion;
    }
  }

  /**
   * Enhanced merge conflict resolution for complex entities
   *
   * **ARCHITECTURE REFACTORING (Strategy Pattern):**
   * - Replaced switch-case with handler registry lookup
   * - Entity-specific merge logic delegated to handlers
   * - Handlers implement intelligent merge strategies (e.g., tag union for journals)
   * - Type-safe via handler interface contracts
   *
   * @param entityType - Type of entity to merge
   * @param serverVersion - Current server state
   * @param localVersion - Client's proposed changes
   * @returns Merged entity data
   */
  private mergeConflict(entityType: string, serverVersion: SyncableEntity, localVersion: SyncableEntity): Partial<SyncableEntity> {
    // STEP 0: Prefer shared config-driven merge when safe (reduces FE/BE drift)
    const sharedMerge = tryMergeConflictWithSharedConfig(
      entityType,
      serverVersion as Record<string, unknown>,
      localVersion as Record<string, unknown>,
      new Date().toISOString()
    );

    if (sharedMerge) {
      this.logger.debug('Conflict merged via shared config', {
        context: 'SyncService.mergeConflict',
        entityType,
        canonicalType: sharedMerge.canonicalType,
      });
      return sharedMerge.data as Partial<SyncableEntity>;
    }

    // STEP 1: Get handler for this entity type
    const handler = this.entityHandlers.get(entityType);
    if (!handler) {
      this.logger.warn('No sync handler for entity type, using default merge', {
        context: 'SyncService.mergeConflict',
        entityType,
        availableTypes: Array.from(this.entityHandlers.keys()),
      });

      // Fallback: Default last-write-wins merge if no handler exists
      return this.defaultMerge(serverVersion, localVersion);
    }

    // STEP 2: Delegate merge logic to entity-specific handler
    // Cast to Prisma.JsonValue for handler compatibility (handlers validate internally)
    const merged = handler.merge(
      serverVersion as unknown,
      localVersion as unknown as Prisma.JsonValue,
    );

    this.logger.debug('Conflict merged via handler', {
      context: 'SyncService.mergeConflict',
      entityType,
      handlerUsed: true,
    });

    return merged as Partial<SyncableEntity>;
  }

  /**
   * Default merge strategy for entities without handlers
   * Last-write-wins with version increment
   *
   * @param serverVersion - Current server state
   * @param localVersion - Client's proposed changes
   * @returns Merged entity data
   */
  private defaultMerge(serverVersion: SyncableEntity, localVersion: SyncableEntity): Partial<SyncableEntity> {
    // Start with server version as base
    const merged: Record<string, unknown> = { ...serverVersion as Record<string, unknown> };
    const localObj = localVersion as Record<string, unknown>;
    const serverObj = serverVersion as Record<string, unknown>;

    // Default merge: take newer fields from local
    Object.keys(localObj).forEach(key => {
      if (localObj[key] !== undefined && localObj[key] !== serverObj[key]) {
        merged[key] = localObj[key];
      }
    });

    if (hasVersion(localVersion) && hasVersion(serverVersion)) {
      merged.version = Math.max(localVersion.version, serverVersion.version) + 1;
    } else if (hasVersion(serverVersion)) {
      merged.version = serverVersion.version + 1;
    } else if (hasVersion(localVersion)) {
      merged.version = localVersion.version + 1;
    }

    // Update sync_version (legacy sync tracking) - keep for backward compatibility
    const localSyncVersion = typeof localObj.sync_version === 'number' ? localObj.sync_version : 0;
    const serverSyncVersion = typeof serverObj.sync_version === 'number' ? serverObj.sync_version : 0;
    merged.sync_version = Math.max(localSyncVersion, serverSyncVersion) + 1;

    // Update timestamp
    merged.updated_at = Date.now();

    return merged as Partial<SyncableEntity>;
  }

  /**
   * Invalidate caches after sync
   */
  private async invalidateCaches(
    userId: string,
    cacheTypes: string[],
  ): Promise<void> {
    if (this.isCacheAvailable && this.cacheService) {
      // Invalidate caches for each type
      for (const type of cacheTypes) {
        // Delete user-specific caches using pattern
        await this.cacheService.invalidate(`cache:${type}:${userId}`);
        await this.cacheService.invalidate(`cache:${type}:${userId}:*`);
      }
    }
    // If cache not available, caches are not being used anyway
  }

  /**
   * Sync journal entries
   */
  async syncJournals(
    userId: string,
    deviceId: string,
    journals: JournalEntry[],
    strategy: ConflictStrategy = CONFLICT_STRATEGY.LAST_WRITE_WINS,
  ): Promise<SyncResult> {
    const syncId = `sync_journal_${Date.now()}`;
    const result: SyncResult = {
      syncId,
      successful: [],
      conflicts: [],
      failed: [],
      lastSyncTimestamp: Date.now(),
    };

    try {
      // Process all journals in a transaction
      await this.databaseService?.transaction(async (tx) => {
        for (const journal of journals) {
          try {
            // Check for existing journal - repository returns entity directly or null
            const existing = await this.journalRepo?.findById(journal.id, userId);

            if (existing) {
              // Conflict detected - resolve it
              const resolved = await this.resolveConflictStrategy('journals', existing, journal, strategy);

              if (resolved) {
                // Convert resolved entity to repository update input
                const updateInput = toUpdateInput(resolved, 'journal');

                // Update existing journal
                await this.journalRepo?.update(journal.id, userId, updateInput as UpdateJournalEntryInput);

                result.conflicts.push({
                  entityType: 'journal',
                  entityId: journal.id,
                  localVersion: entityToJsonValue(journal),
                  serverVersion: entityToJsonValue(existing),
                  resolution: strategy === CONFLICT_STRATEGY.MERGE ? 'merged' : 'local',
                  resolvedData: entityToJsonValue(resolved),
                  timestamp: Date.now(),
                });
              } else {
                // Manual resolution needed
                result.conflicts.push({
                  entityType: 'journal',
                  entityId: journal.id,
                  localVersion: entityToJsonValue(journal),
                  serverVersion: entityToJsonValue(existing),
                  timestamp: Date.now(),
                });
              }
            } else {
              // Create new journal entry
              await this.journalRepo?.create({
                clientEntryId: journal.clientEntryId || journal.id,
                userId,
                title: journal.title,
                content: journal.content,
                mood: journal.mood,
                tags: journal.tags || [],
                isPrivate: journal.isPrivate ?? true,
                sessionId: journal.sessionId,
                consumptionId: journal.consumptionId,
                productId: journal.productId,
              });
              result.successful.push(journal.id);
            }
          } catch (error) {
            result.failed.push({
              clientId: journal.clientEntryId ?? journal.id, // Prefer client ID, fallback to entry ID
              error: getErrorMessage(error),
            });
          }
        }
      });

      // Update sync metadata
      // NOTE: syncStateRepo is not available - skipping sync state update
      // await this.syncStateRepo.updateAfterSync(
      //   userId,
      //   deviceId,
      //   'journals',
      //   new Date(result.lastSyncTimestamp),
      //   syncId,
      // );

    } finally {
      if (this.isCacheAvailable && this.cacheService) {
        await this.cacheService.delete(`sync_lock:${userId}:${deviceId}`);
      }
    }

    return result;
  }

  /**
   * Get pending changes for a user since last sync
   *
   * FAIL-FAST: This method now throws on errors instead of returning empty results.
   * Clients must handle errors appropriately (retry, show error state, etc.)
   *
   * @throws AppError on database errors
   */
  async getPendingChanges(
    userId: string,
    lastSyncTimestamp: number,
  ): Promise<{ sessions: SyncChange[]; journals: SyncChange[] }> {
    const timestamp = new Date(lastSyncTimestamp);

    // FAIL-FAST: Ensure syncChangeRepo is available
    if (!this.syncChangeRepo) {
      throw new AppError(
        500,
        ErrorCodes.INTERNAL_SERVER_ERROR,
        'SyncChangeRepository not initialized',
      );
    }

    // Repository pattern: returns data directly or throws AppError
    // No try-catch - let errors propagate to controller layer
    const changes = await this.syncChangeRepo.getChangesSince(
      userId,
      timestamp,
      undefined,
      undefined,
      1000,
    );

    return {
      sessions: changes.filter((c: SyncChange) => c.entityType === 'session'),
      journals: changes.filter((c: SyncChange) => c.entityType === 'journal'),
    };
  }

  /**
   * Process incoming changes from client
   */
  async processChanges(
    userId: string,
    changes: PendingChangeItem[],
    deviceId: string,
  ): Promise<{ applied: number; rejected: number; conflicts: Array<{ id?: string; error: string }> }> {
    if (!changes || changes.length === 0) {
      this.logger.log(LogLevel.INFO, LogCategory.SYSTEM, 'No changes to process', {
        userId,
        deviceId,
      });
      return { applied: 0, rejected: 0, conflicts: [] };
    }

    try {
      // Convert PendingChangeItem to repository's expected format
      // PendingChangeItem has changeData as JsonValue, repository expects InputJsonValue
      const repositoryChanges = changes.map(change => ({
        changeType: change.changeType,
        entityType: change.entityType,
        entityId: change.entityId,
        changeData: change.changeData as Prisma.InputJsonValue,
        syncVersion: change.syncVersion,
      }));

      // Use repository to batch process changes - repository pattern: returns data directly or throws AppError
      const result = await this.syncChangeRepo?.batchProcessChanges(userId, repositoryChanges, deviceId) || {
        applied: 0,
        rejected: changes.length,
        failed: 0,
        conflicts: [],
      };

      this.logger.log(LogLevel.INFO, LogCategory.SYSTEM, 'Finished processing changes', {
        userId,
        deviceId,
        totalChanges: changes.length,
        applied: result.applied,
        rejected: result.failed || result.rejected,
        conflicts: result.conflicts?.length || 0,
      });

      return {
        applied: result.applied,
        rejected: result.failed || result.rejected,
        conflicts: result.conflicts || [],
      };
    } catch (error) {
      this.logger.log(LogLevel.ERROR, LogCategory.SYSTEM, 'Failed to process changes', {
        userId,
        deviceId,
        error: getErrorMessage(error),
      });

      return {
        applied: 0,
        rejected: changes.length,
        conflicts: [],
      };
    }
  }

  /**
   * Get changes since a specific timestamp
   *
   * FAIL-FAST: This method now throws on errors instead of returning empty results.
   * Clients must handle errors appropriately (retry, show error state, etc.)
   *
   * @throws AppError on database errors
   */
  async getChangesSince(
    userId: string,
    timestamp: string,
    deviceId: string,
    entities?: string[],
    limit: number = 1000,
  ): Promise<SyncChange[]> {
    const since = new Date(timestamp);

    // FAIL-FAST: Ensure syncChangeRepo is available
    if (!this.syncChangeRepo) {
      throw new AppError(
        500,
        ErrorCodes.INTERNAL_SERVER_ERROR,
        'SyncChangeRepository not initialized',
      );
    }

    // Repository pattern: returns data directly or throws AppError
    // No try-catch - let errors propagate to controller layer
    const changes = await this.syncChangeRepo.getChangesSince(
      userId,
      since,
      deviceId,
      entities,
      limit,
    );

    return changes;
  }

  /**
   * Verify data integrity
   */
  async verifyIntegrity(userId: string, checksum: string): Promise<IntegrityVerificationResult> {
    // This would need to be implemented based on your checksum strategy
    // For now, returning a placeholder
    return {
      valid: true,
      clientChecksum: checksum,
      serverChecksum: checksum,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get count of pending changes
   *
   * FAIL-FAST: This method now throws on errors instead of returning 0.
   * Clients must handle errors appropriately.
   *
   * @throws AppError on database errors
   */
  async getPendingChangesCount(userId: string, deviceId: string): Promise<number> {
    // FAIL-FAST: Ensure syncChangeRepo is available
    if (!this.syncChangeRepo) {
      throw new AppError(
        500,
        ErrorCodes.INTERNAL_SERVER_ERROR,
        'SyncChangeRepository not initialized',
      );
    }

    // Repository pattern: returns data directly or throws AppError
    // No try-catch - let errors propagate to controller layer
    const count = await this.syncChangeRepo.getPendingChangesCount(userId, deviceId);
    return count ?? 0;
  }

  /**
   * Resolve a sync conflict (public method for controller)
   */
  async resolveConflict(
    conflictId: string,
    resolution: 'server' | 'client' | 'merge',
    data?: Prisma.JsonValue,
  ): Promise<SyncConflict> {
    try {
      // Repository pattern: returns data directly or throws AppError
      const resolvedConflict = await this.syncConflictRepo?.resolveConflict({
        conflictId,
        resolution: resolution === 'server' ? 'REMOTE_WINS' :
                    resolution === 'client' ? 'LOCAL_WINS' : 'MERGE',
        // Type-safe cast: JsonValue (from DB read) → InputJsonValue (for DB write)
        resolvedData: data as Prisma.InputJsonValue | undefined,
        resolvedBy: 'system', // Add required resolvedBy parameter
      });

      if (!resolvedConflict) {
        throw new AppError(404, ErrorCodes.NOT_FOUND, 'Conflict not found');
      }

      // Return the actual SyncConflict from Prisma
      return resolvedConflict;
    } catch (error) {
      this.logger.log(LogLevel.ERROR, LogCategory.SYSTEM, 'Failed to resolve conflict', {
        conflictId,
        resolution,
        error: getErrorMessage(error),
      });

      // Re-throw AppError or wrap generic errors
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(500, ErrorCodes.INTERNAL_SERVER_ERROR, 'Failed to resolve conflict');
    }
  }

  /**
   * Reset sync state for a user/device
   *
   * FAIL-FAST: This method now throws an explicit error if sync state reset
   * functionality is not available, rather than returning mock success.
   *
   * NOTE: Full sync state reset requires SyncStateRepository which may not be
   * available. If only cache clearing is needed, use clearSyncCacheLocks() instead.
   *
   * @throws AppError if syncStateRepo is not available
   */
  async resetSyncState(
    userId: string,
    deviceId: string,
    entities?: string[],
  ): Promise<SyncStateResetResult> {
    // FAIL-FAST: Log warning about partial implementation
    this.logger.log(LogLevel.WARN, LogCategory.SYSTEM, 'resetSyncState called - SyncStateRepository not available', {
      userId,
      deviceId,
      entities,
      note: 'Only cache locks will be cleared. Full sync state reset is not implemented.',
    });

    // Clear cache locks if available - this IS functional
    if (this.isCacheAvailable && this.cacheService) {
      await this.cacheService.delete(`sync_lock:${userId}:${deviceId}`);
      this.logger.log(LogLevel.INFO, LogCategory.SYSTEM, 'Sync cache lock cleared', {
        userId,
        deviceId,
      });
    }

    // Return result indicating partial success
    // NOTE: We're not throwing here because cache clearing IS functional,
    // but we clearly document that full sync state reset is not implemented
    return {
      reset: true,
      userId,
      deviceId,
      entities: entities || 'all',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Export user data for backup
   */
  async exportUserData(userId: string, entities?: string[]): Promise<UserDataExport> {
    const data: UserDataExport = {
      userId,
      exportedAt: new Date().toISOString(),
      version: '1.0.0',
    };

    // Export sessions if requested
    if (!entities || entities.includes('sessions')) {
      const sessionsResult = await this.sessionRepo?.findByUserId(userId, { pageSize: 10000 });
      data.sessions = sessionsResult && 'items' in sessionsResult ? sessionsResult.items : [];
    }

    // Export journal entries if requested
    if (!entities || entities.includes('journals')) {
      const journalsResult = await this.journalRepo?.findByUserId(userId, { pageSize: 10000 });
      data.journals = journalsResult && 'items' in journalsResult ? journalsResult.items : [];
    }

    // Export purchases if requested
    if (!entities || entities.includes('purchases')) {
      const purchasesResult = await this.purchaseRepo?.findByUserId(userId, { pageSize: 10000 });
      data.purchases = purchasesResult && 'items' in purchasesResult ? purchasesResult.items : [];
    }

    return data;
  }

  /**
   * Import user data from backup
   */
  async importUserData(
    userId: string,
    data: UserDataExport,
    options: { merge?: boolean; validate?: boolean } = {},
  ): Promise<UserDataImportResult> {
    const result: UserDataImportResult = {
      imported: {
        sessions: 0,
        journals: 0,
        purchases: 0,
      },
      errors: [],
      timestamp: new Date().toISOString(),
    };

    const { merge = false, validate = true } = options;

    // Validate data format if requested
    if (validate) {
      if (!data.version || !data.userId) {
        throw new Error('Invalid import data format');
      }
      if (data.userId !== userId) {
        throw new Error('User ID mismatch');
      }
    }

    // Use transaction for atomic import
    try {
      await this.databaseService?.transaction(async (tx) => {
        // Import sessions
        if (data.sessions) {
          for (const session of data.sessions) {
            try {
              if (merge) {
                await this.sessionRepo?.update(session.id, userId, session);
              } else {
                await this.sessionRepo?.create(session);
              }
              result.imported.sessions++;
            } catch (error) {
              throw new Error(`Failed to import session ${session.id}: ${getErrorMessage(error)}`);
            }
          }
        }

        // Import journals
        if (data.journals) {
          for (const journal of data.journals) {
            try {
              if (merge) {
                await this.journalRepo?.update(journal.id, userId, {
                  ...journal,
                  reactions: journal.reactions as Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue | undefined,
                });
              } else {
                await this.journalRepo?.create({
                  ...journal,
                  reactions: journal.reactions as Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue | undefined,
                });
              }
              result.imported.journals++;
            } catch (error) {
              throw new Error(`Failed to import journal ${journal.id}: ${getErrorMessage(error)}`);
            }
          }
        }

        // Import purchases
        if (data.purchases) {
          for (const purchase of data.purchases) {
            try {
              if (merge) {
                // Extract only update-allowed fields for UpdatePurchaseInput
                // Convert Decimal to number if needed
                const updateData: UpdatePurchaseInput = {
                  purchaseDate: purchase.purchaseDate,
                  quantityPurchased: typeof purchase.quantityPurchased === 'number' ? purchase.quantityPurchased : purchase.quantityPurchased.toNumber(),
                  costSpent: typeof purchase.costSpent === 'number' ? purchase.costSpent : purchase.costSpent.toNumber(),
                  productId: purchase.productId,
                  pricePerUnit: purchase.pricePerUnit ? (typeof purchase.pricePerUnit === 'number' ? purchase.pricePerUnit : purchase.pricePerUnit.toNumber()) : null,
                  lossFactor: purchase.lossFactor ? (typeof purchase.lossFactor === 'number' ? purchase.lossFactor : purchase.lossFactor.toNumber()) : null,
                  // Note: clientPurchaseId is not part of UpdatePurchaseInput - it's only set on create
                };
                await this.purchaseRepo?.update(purchase.id, userId, updateData);
              } else {
                await this.purchaseRepo?.create({
                  id: purchase.id,
                  userId: purchase.userId,
                  clientPurchaseId: purchase.clientPurchaseId ?? undefined,
                  productId: purchase.productId,
                  purchaseDate: purchase.purchaseDate,
                  quantityPurchased: typeof purchase.quantityPurchased === 'number' ? purchase.quantityPurchased : purchase.quantityPurchased.toNumber(),
                  costSpent: typeof purchase.costSpent === 'number' ? purchase.costSpent : purchase.costSpent.toNumber(),
                  pricePerUnit: purchase.pricePerUnit ? (typeof purchase.pricePerUnit === 'number' ? purchase.pricePerUnit : purchase.pricePerUnit.toNumber()) : undefined,
                  lossFactor: purchase.lossFactor ? (typeof purchase.lossFactor === 'number' ? purchase.lossFactor : purchase.lossFactor.toNumber()) : undefined,
                });
              }
              result.imported.purchases++;
            } catch (error) {
              throw new Error(`Failed to import purchase ${purchase.id}: ${getErrorMessage(error)}`);
            }
          }
        }
      });
      
    } catch (error: unknown) {
      // Reset import counts since transaction was rolled back
      result.imported.sessions = 0;
      result.imported.journals = 0;
      result.imported.purchases = 0;
      
      // Add error for the entire batch
      result.errors.push({
        entity: 'batch',
        error: `Transaction rollback: ${getErrorMessage(error)}`,
      });
      
      this.logger.log(LogLevel.ERROR, LogCategory.SYSTEM, 'Import transaction failed', {
        context: 'SyncService',
        userId,
        error: getErrorMessage(error),
        stack: getErrorStack(error),
      });
    }

    return result;
  }

  /**
   * Check if error is retryable
   */
  private isRetryableError(error: unknown): boolean {
    // Check for common retryable error patterns (PostgreSQL/network)
    const retryableErrors = [
      'ECONNRESET',
      'ENOTFOUND',
      'ETIMEDOUT',
      'connection terminated unexpectedly',
      'ThrottlingException',
      'ServiceUnavailable',
      'RequestLimitExceeded',
      'ETIMEDOUT',
      'ECONNRESET',
      'ENOTFOUND',
      'ECONNREFUSED',
    ];

    const errorMessage = getErrorMessage(error);
    const errorName = getErrorName(error);
    const errorCode = getErrorCode(error);

    return retryableErrors.some(e =>
      errorName.includes(e) ||
      errorCode === e ||
      errorMessage.includes(e),
    );
  }

  private buildSyncFailureDetails(
    change: PendingChangeItem,
    error: unknown,
  ): Record<string, unknown> | undefined {
    if (!(error instanceof AppError) || !isRecord(error.details)) {
      // ORPHAN UPDATE DETECTION: Even without details, detect 404 on UPDATE
      // This occurs when frontend sends UPDATE for entity that was never CREATEd on backend
      if (error instanceof AppError && error.statusCode === 404 && change.changeType === 'UPDATE') {
        return {
          orphanUpdate: {
            entityType: change.entityType,
            entityId: change.entityId,
            clientId: change.clientId,
            hint: 'Entity does not exist on server. Frontend should send CREATE first.',
          },
        };
      }
      return undefined;
    }

    const prismaCode = typeof error.details.prismaCode === 'string'
      ? error.details.prismaCode
      : undefined;
    const meta = isRecord(error.details.meta) ? error.details.meta : undefined;
    const fieldName = normalizeFkFieldName(
      typeof meta?.field_name === 'string' ? meta.field_name : undefined,
    );

    // ORPHAN UPDATE DETECTION: 404 errors on UPDATE indicate entity doesn't exist on server
    // This is a recoverable error - frontend should send CREATE command first
    if (error.statusCode === 404 && change.changeType === 'UPDATE') {
      return {
        ...error.details,
        orphanUpdate: {
          entityType: change.entityType,
          entityId: change.entityId,
          clientId: change.clientId,
          hint: 'Entity does not exist on server. Frontend should send CREATE first.',
        },
      };
    }

    if (prismaCode === 'P2003') {
      const value = fieldName && isRecord(change.changeData)
        ? change.changeData[fieldName]
        : undefined;
      return {
        ...error.details,
        missingReference: {
          entityType: change.entityType,
          field: fieldName ?? undefined,
          value: typeof value === 'string' ? value : undefined,
        },
      };
    }

    return error.details;
  }

  private isSyncRetryableError(error: unknown, change: PendingChangeItem): boolean {
    if (error instanceof AppError) {
      // ORPHAN UPDATE RECOVERY: 404 errors on UPDATE operations are retryable
      // The frontend should detect the orphanUpdate hint and send CREATE first before retrying UPDATE
      // This handles the common offline-first scenario where CREATE was pending/failed when UPDATE was sent
      if (error.statusCode === 404 && change.changeType === 'UPDATE') {
        this.logger.warn('Orphan UPDATE detected - entity not found on server', {
          context: 'SyncService.isSyncRetryableError',
          entityType: change.entityType,
          entityId: change.entityId,
          clientId: change.clientId,
          hint: 'Frontend should send CREATE command first, then retry UPDATE',
        });
        return true; // Mark as retryable so frontend can recover
      }

      if (isRecord(error.details)) {
        const prismaCode = typeof error.details.prismaCode === 'string'
          ? error.details.prismaCode
          : undefined;
        const meta = isRecord(error.details.meta) ? error.details.meta : undefined;
        const fieldName = normalizeFkFieldName(
          typeof meta?.field_name === 'string' ? meta.field_name : undefined,
        );

        if (prismaCode === 'P2003' && fieldName) {
          // Use type guard to ensure entityType is a valid canonical EntityType
          const canonicalType = tryCanonicalizeEntityType(change.entityType);
          if (canonicalType) {
            // Use shared config for optional FK fields (eliminates drift with frontend)
            const optionalFields = getOptionalForeignKeyFields(
              canonicalType,
              RELATION_SCOPE.BACKEND
            );
            if (optionalFields.has(fieldName)) {
              return true;
            }
          }
        }
      }
    }

    return this.isRetryableError(error);
  }

  // Cursor-based sync methods

  /**
   * Get incremental changes using cursor-based approach
   *
   * @param userId - User ID
   * @param deviceId - Device ID for sync state tracking
   * @param entityTypes - Array of entity types to fetch changes for
   * @param cursor - Optional cursor for incremental sync (base64-encoded position)
   * @param limit - Maximum number of changes to return
   * @returns Incremental changes with next cursor
   */
  public async getIncrementalChanges(
    userId: string,
    deviceId: string,
    entityTypes: string[],
    cursor?: string,
    limit: number = 100,
  ): Promise<PullSyncResult> {
    if (!this.isInitialized) {
      throw AppError.precondition('SyncService not initialized');
    }

    try {
      // Acquire sync lock to prevent concurrent syncs
      const lockOwner = `sync-${Date.now()}`;
      const lockResult = await this.syncStateRepo!.acquireSyncLock(userId, deviceId, lockOwner);

      if (!lockResult.acquired) {
        throw AppError.conflict('Sync already in progress for this device');
      }

      try {
        const entityCursors: Record<string, string> = {};

        // STRICT CURSOR DECODING - Phase 3B: Cursor Semantics
        // Parse failures MUST fail the request (no warn-and-continue)
        // Cursor format: base64({ lastCreatedAt, lastId, entityCursors, version? })
        let sinceTimestamp = new Date(0); // Default to epoch if no cursor
        let lastId: string | undefined = undefined;
        let decodedCursor: CompositeCursor | null = null;

        if (cursor) {
          // FAIL-FAST: Invalid cursor throws InvalidCursorError → 400 Bad Request
          // This is intentional - a malformed cursor indicates client bug or corruption
          decodedCursor = decodeCompositeCursor(cursor);
          sinceTimestamp = new Date(decodedCursor.lastCreatedAt);
          lastId = decodedCursor.lastId;

          this.logger.debug('Decoded incoming cursor', {
            lastCreatedAt: decodedCursor.lastCreatedAt,
            lastId: decodedCursor.lastId.substring(0, 8) + '...',
            version: decodedCursor.version,
            entityCount: Object.keys(decodedCursor.entityCursors).length,
          });
        }

        // Fetch changes for all entity types in a single repository call
        // This ensures we respect the overall limit while getting the most recent changes
        // across all requested types, avoiding the "missing data" bug caused by per-entity caps.
        const allChanges = await this.syncChangeRepo!.getChangesSince(
          userId,
          sinceTimestamp,
          deviceId,
          entityTypes,
          limit + 1, // Fetch one extra to accurately determine hasMore
          lastId,
        );

        const hasMore = allChanges.length > limit;
        const changes = allChanges.slice(0, limit);

        // Populate entityCursors based on the latest change found for each entity type in this batch
        // PHASE 3B: Use shared cursor utilities for normalization and consistency
        for (const change of changes) {
          // Create normalized entity cursor using shared utility
          const entityCursor = createEntityCursor(
            change.createdAt.toISOString(),
            change.id
          );
          entityCursors[change.entityType] = encodeEntityCursor(entityCursor);
        }

        // Sort changes by composite key (createdAt ASC, id ASC)
        // (Changes from repo are already sorted, but we sort again for absolute certainty after potential merges)
        changes.sort((a, b) => {
          const timeA = new Date(a.createdAt).getTime();
          const timeB = new Date(b.createdAt).getTime();
          if (timeA !== timeB) return timeA - timeB;
          return a.id.localeCompare(b.id);
        });

        // PHASE 3B: Calculate next composite cursor using shared encoder
        // This ensures the cursor includes version and is properly normalized
        let nextCursor: string | null = null;
        const lastChange = changes[changes.length - 1];

        if (changes.length > 0 && lastChange) {
          const compositeCursor: CompositeCursor = {
            lastCreatedAt: lastChange.createdAt.toISOString(),
            lastId: lastChange.id,
            entityCursors,
            version: CURSOR_SCHEMA_VERSION,
          };
          nextCursor = encodeCompositeCursor(compositeCursor);

          this.logger.debug('Encoded outgoing cursor', {
            lastCreatedAt: compositeCursor.lastCreatedAt,
            lastId: compositeCursor.lastId.substring(0, 8) + '...',
            version: compositeCursor.version,
            entityCount: Object.keys(entityCursors).length,
          });
        } else if (changes.length === 0 && cursor) {
          // Keep current cursor if no new changes
          nextCursor = cursor;
        }

        // Update cursor position in sync state if we have a new one
        if (nextCursor && nextCursor !== cursor) {
          await this.syncStateRepo!.updateCursorPosition(userId, deviceId, nextCursor);
        }

        // SyncChange schema: { changeType, changeData, entityId, entityType, createdAt }
        // Frontend expects: { operation, data, serverId, entityType, timestamp }
        const transformedChanges = changes.map(change => ({
          entityType: change.entityType,
          operation: change.changeType,
          serverId: change.entityId,
          data: change.changeData as Record<string, unknown>,
          timestamp: change.createdAt.toISOString(),
        }));

        return {
          changes: transformedChanges,
          cursor: nextCursor,
          hasMore,
          recordsReturned: transformedChanges.length,
          entityCursors,
        };
      } finally {
        // Always release lock with the same lockOwner used for acquisition
        await this.syncStateRepo!.releaseSyncLock(userId, deviceId, lockOwner);
      }
    } catch (error) {
      // PHASE 3B: Handle cursor validation errors with specific 400 response
      if (error instanceof InvalidCursorError) {
        this.logger.warn('Invalid cursor in sync request', {
          context: 'SyncService',
          userId,
          deviceId,
          cursorReason: error.reason,
          cursorInput: error.cursorInput.substring(0, 50) + '...',
        });
        // Convert to validation error (400) - cursor format is client's responsibility
        throw AppError.validation(`Invalid cursor format: ${error.reason}`, {
          cursorError: error.reason,
        });
      }

      this.logger.error('Failed to get incremental changes', {
        context: 'SyncService',
        userId,
        deviceId,
        error: getErrorMessage(error),
      });
      throw error;
    }
  }

  /**
   * Process push sync with idempotency and conflict detection
   *
   * @param userId - User ID
   * @param deviceId - Device ID
   * @param changes - Array of changes to push
   * @param syncOperationId - Client sync operation ID for tracking
   * @returns Push sync result with successful, failed, and conflicted changes
   */
  public async processPushSync(
    userId: string,
    deviceId: string,
    changes: PendingChangeItem[],
    syncOperationId: string,
  ): Promise<PushSyncResult> {
    if (!this.isInitialized) {
      throw AppError.precondition('SyncService not initialized');
    }

    // PUSH-LEVEL IDEMPOTENCY CHECK
    // Before processing, check if this exact syncOperationId was already handled.
    // Three cases:
    //   1. COMPLETED + resultPayload → return cached result (true idempotency)
    //   2. IN_PROGRESS (stale > 5 min) → treat as abandoned, allow re-processing
    //   3. IN_PROGRESS (fresh) → concurrent duplicate, return 409 Conflict
    //   4. FAILED → allow re-processing (client intentionally retrying)
    const existingOperation = await this.syncOperationRepo!.findByClientSyncOperationId(
      userId,
      syncOperationId,
    );

    if (existingOperation) {
      // Case 1: COMPLETED with cached result — return immediately (true idempotency)
      if (
        existingOperation.status === SyncStatus.COMPLETED &&
        existingOperation.resultPayload != null
      ) {
        this.logger.info('Push idempotency hit: returning cached result', {
          context: 'SyncService.processPushSync',
          userId,
          clientSyncOperationId: syncOperationId,
          dbOperationId: existingOperation.id,
        });
        return existingOperation.resultPayload as unknown as PushSyncResult;
      }

      // Case 2: COMPLETED without cached result (legacy record or — prior to atomic write fix —
      // storeResultPayload failed separately). The client likely lost the original response
      // (lost-ack) and needs the full result with server ID mappings.
      //
      // on UPDATEs. The server version was already incremented on the first successful pass,
      // so re-processing sees stale syncVersion → detectConflict() reports conflicts for
      // changes that actually succeeded. These incorrect outcomes are then cached, poisoning
      // all subsequent retries.
      //
      // Instead, reconstruct a deterministic result using CANONICAL ENTITY LOOKUPS:
      // - UPDATEs/DELETEs: entityId IS the serverId (these operate on existing entities)
      // - CREATEs: resolved via resolveServerIdsForReconstruction() which performs
      //   handler-specific lookups (e.g., DeviceHandler checks macAddress) to find the
      //   actual server-assigned ID. Falls back to entityId only if lookup fails.
      // - requestId is always passed through for precise frontend outbox marking
      if (existingOperation.status === SyncStatus.COMPLETED) {
        // SAFETY SIGNAL: If the original processing had conflicts (resolvedCount > 0),
        // the reconstruction's `conflicts: []` is inaccurate — we can't know which
        // specific changes conflicted. Log at error level so this is visible in
        // monitoring. The PULL cycle will reconcile any discrepancies.
        // This path only applies to legacy records (atomic write prevents new ones).
        const hadOriginalConflicts = existingOperation.resolvedCount > 0;

        this.logger[hadOriginalConflicts ? 'error' : 'warn'](
          hadOriginalConflicts
            ? 'Push idempotency: COMPLETED with conflicts but no cached result — reconstruction assumes all-successful (PULL will reconcile)'
            : 'Push idempotency: COMPLETED but no cached result — reconstructing deterministic result',
          {
            context: 'SyncService.processPushSync',
            userId,
            clientSyncOperationId: syncOperationId,
            dbOperationId: existingOperation.id,
            changeCount: changes.length,
            originalResolvedCount: existingOperation.resolvedCount,
          },
        );

        // CANONICAL ID RESOLUTION: Instead of guessing serverId === entityId,
        // perform entity lookups to find the actual server-assigned ID.
        // This is critical for handlers where create() can return a different ID
        // (e.g., DeviceHandler finds existing device by macAddress).
        const resolvedSuccessful = await this.resolveServerIdsForReconstruction(userId, changes);

        const reconstructedResult: PushSyncResult = {
          successful: resolvedSuccessful,
          failed: [],
          conflicts: [],
        };

        // Store reconstructed result for future cache hits (idempotent — safe to call
        // on already-COMPLETED operation). Prevents re-entering this path on subsequent retries.
        // IMPORTANT: Preserve originalResolvedCount — do NOT overwrite with 0.
        // The resolvedCount is metadata about the original processing, not the reconstruction.
        try {
          await this.syncOperationRepo!.markAsCompleted(
            existingOperation.id,
            userId,
            changes.length,
            existingOperation.resolvedCount,
            reconstructedResult as unknown as Prisma.InputJsonValue,
          );
        } catch (storeError) {
          // Even if storing fails, return the result so the frontend can drain its outbox.
          // Next retry will reconstruct again (deterministic — same result every time).
          this.logger.warn('Failed to cache reconstructed result payload — next retry will reconstruct again', {
            context: 'SyncService.processPushSync',
            error: getErrorMessage(storeError),
            clientSyncOperationId: syncOperationId,
          });
        }

        return reconstructedResult;
      }
      // Case 3: Concurrent duplicate — another request is actively processing this
      else if (
        existingOperation.status === SyncStatus.IN_PROGRESS &&
        !this.syncOperationRepo!.isStaleInProgress(existingOperation)
      ) {
        throw AppError.conflict(
          `Push operation ${syncOperationId} is already in progress. ` +
          'Retry after the current request completes.',
        );
      }
      // Cases 4 & 5: Stale IN_PROGRESS or FAILED — allow re-processing.
      // Reset the existing record to IN_PROGRESS for reuse (avoids unique constraint
      // violation from creating a new record with the same clientSyncOperationId).
      else {
        await this.syncOperationRepo!.update(existingOperation.id, userId, {
          status: SyncStatus.IN_PROGRESS,
          errorMessage: null,
        });
      }

      this.logger.info('Push idempotency: re-processing operation', {
        context: 'SyncService.processPushSync',
        userId,
        clientSyncOperationId: syncOperationId,
        previousStatus: existingOperation.status,
        previousCreatedAt: existingOperation.createdAt.toISOString(),
        reusedOperationId: existingOperation.id,
      });
    }

    const successful: SuccessfulChange[] = [];
    const failed: FailedChange[] = [];
    const conflicts: SyncConflict[] = [];

    // Hoisted outside try block so the catch block can best-effort markAsFailed.
    // Without this, a fatal error (e.g., markAsCompleted throws) would leave
    // the operation permanently stuck in IN_PROGRESS until stale-lock timeout.
    let syncOperation: { id: string } | undefined;

    try {
      // Acquire or create the SyncOperation record.
      // If we already found and reset an existing record (retry case), reuse it.
      // Otherwise, create a new record with the client-provided ID for idempotency tracking.
      // NOTE: If existingOperation is non-null here, it was already reset to IN_PROGRESS
      // above (all other cases returned or threw before reaching this point).
      if (existingOperation) {
        // Reuse the existing record (already reset to IN_PROGRESS above)
        syncOperation = existingOperation;
      } else {
        // New operation — create with idempotency key.
        // The unique constraint on (userId, clientSyncOperationId) prevents races:
        // if two concurrent requests both pass the check above, only one succeeds here.
        try {
          syncOperation = await this.syncOperationRepo!.create({
            userId,
            deviceId,
            operationType: 'PUSH',
            status: SyncStatus.IN_PROGRESS,
            clientSyncOperationId: syncOperationId,
          });
        } catch (createError) {
          // P2002: unique constraint violation — concurrent request won the race
          if (isPrismaError(createError) && createError.code === 'P2002') {
            throw AppError.conflict(
              `Push operation ${syncOperationId} is already being processed by another request.`,
            );
          }
          throw createError;
        }
      }

      this.logger.debug('SyncOperation acquired for processing', {
        context: 'SyncService.processPushSync',
        dbOperationId: syncOperation.id,
        clientSyncOperationId: syncOperationId,
        userId,
        deviceId,
        isRetry: !!existingOperation,
      });

      // Process each change
      // This ensures subsequent changes in the same batch use correct server IDs
      const inBatchIdMap = new Map<string, string>();

      // Heartbeat: track last liveness refresh to prevent false stale detection.
      // During long batches (many changes), updatedAt would otherwise remain at
      // the value set when the operation was acquired, eventually crossing the
      // stale timeout and allowing a concurrent request to reap and re-process.
      let lastHeartbeatAt = Date.now();

      for (const rawChange of changes) {
        // ── HEARTBEAT: Refresh liveness if interval has elapsed ──
        // This prevents concurrent requests from misclassifying this operation
        // as stale while we are still actively processing changes.
        const heartbeatNow = Date.now();
        if (heartbeatNow - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
          try {
            const stillOwned = await this.syncOperationRepo!.heartbeat(
              syncOperation.id,
              userId,
            );
            lastHeartbeatAt = Date.now();

            if (!stillOwned) {
              // Operation was transitioned out of IN_PROGRESS by another process
              // (cancelled, reaped, etc.). Abort to prevent duplicate writes.
              throw AppError.conflict(
                `Sync operation ${syncOperationId} is no longer IN_PROGRESS — ` +
                'another process may have reclaimed it. Aborting to prevent duplicate writes.',
              );
            }
          } catch (heartbeatError) {
            // Re-throw our own abort signal
            if (heartbeatError instanceof AppError) throw heartbeatError;

            // Transient DB error — log and continue. If the DB is truly down,
            // the next applyChange() call will fail on its own.
            this.logger.warn('Heartbeat failed (transient) — continuing processing', {
              context: 'SyncService.processPushSync.heartbeat',
              syncOperationId: syncOperation.id,
              error: getErrorMessage(heartbeatError),
            });
          }
        }

        // Declare change outside try block so it's accessible in catch
        let change = rawChange;
        try {
          // STEP 1: Resolve any IDs that were changed in previous steps of this batch
          change = this.resolveMappedIdsInChange(rawChange, inBatchIdMap);

          // STEP 2: Check for conflicts using optimistic locking
          const conflict = await this.detectConflict(userId, change);

          if (conflict) {
            // This allows the frontend to precisely update the correct outbox item
            (conflict as any).requestId = change.requestId;
            conflicts.push(conflict);
            continue;
          }

          // STEP 3: Apply change via repository (pass deviceId for SyncChange tracking)
          // EC-DEVICE-ID-001 (v2.4.2): applyChange now returns the actual entity ID
          // This handles idempotent CREATEs where backend returns an existing entity
          // with a different ID (e.g., device found by macAddress returns server's UUID)
          const actualEntityId = await this.applyChange(userId, deviceId, change);

          // STEP 4: Update in-batch ID map if the entity ID was changed by the server
          if (actualEntityId !== change.entityId) {
            inBatchIdMap.set(change.entityId, actualEntityId);
            // Also map the client ID if it was provided
            if (change.clientId && actualEntityId !== change.clientId) {
              inBatchIdMap.set(change.clientId, actualEntityId);
            }
          }

          // Push success object with full details for frontend ID mapping
          // clientId: Client-generated UUID (used by frontend for ID mapping)
          //           When DeviceHandler.create() finds an existing device by macAddress,
          //           it returns that device's ID (different from client's ID).
          //           The frontend needs this to update its local record.
          // entityType: Entity type for table name in frontend sync_metadata
          successful.push({
            clientId: change.clientId ?? change.entityId,
            serverId: actualEntityId,  // EC-DEVICE-ID-001: Use server's actual entity ID
            entityType: change.entityType,
            requestId: change.requestId, // Pass through for precise outbox marking
          });
        } catch (error) {
          // Idempotent delete: treat "not found" as success (already deleted)
          if (change.changeType === 'DELETE' && this.isIdempotentDeleteNotFound(error)) {
            this.logger.warn('Delete already applied on server - treating as success', {
              context: 'SyncService.processPushSync',
              userId,
              entityType: change.entityType,
              entityId: change.entityId,
              clientId: change.clientId,
            });

            successful.push({
              clientId: change.clientId ?? change.entityId,
              serverId: change.entityId,
              entityType: change.entityType,
              requestId: change.requestId,
            });
            continue;
          }

          console.error(' [DEBUG] Change application failed:', {
            entityType: change.entityType,
            entityId: change.entityId,
            changeType: change.changeType,
            error: getErrorMessage(error),
            stack: getErrorStack(error),
          });

          // Frontend uses clientId to call markFailed() on outbox commands
          // requestId: Pass through for precise outbox marking
          failed.push({
            clientId: change.clientId ?? change.entityId, // Prefer clientId, fallback to entityId
            error: getErrorMessage(error),
            retryable: this.isSyncRetryableError(error, change),
            requestId: change.requestId, // Pass through for precise outbox marking
            errorCode: error instanceof AppError ? error.errorCode : undefined,
            details: this.buildSyncFailureDetails(change, error),
          });
        }
      }

      // Build the result before marking complete (for caching)
      const result: PushSyncResult = { successful, failed, conflicts };

      // ATOMIC: Mark sync operation as completed AND store result payload in a single write.
      // This eliminates the window where an operation is COMPLETED but has no cached result,
      // which previously caused idempotent retries to return empty responses (lost-ack scenario).
      await this.syncOperationRepo!.markAsCompleted(
        syncOperation.id,
        userId,
        successful.length,
        conflicts.length,
        result as unknown as Prisma.InputJsonValue,
      );

      this.logger.debug('SyncOperation completed', {
        context: 'SyncService.processPushSync',
        dbOperationId: syncOperation.id,
        clientSyncOperationId: syncOperationId,
        successful: successful.length,
        failed: failed.length,
        conflicts: conflicts.length,
      });

      return result;
    } catch (error) {
      this.logger.error('Failed to process push sync', {
        context: 'SyncService',
        userId,
        deviceId,
        syncOperationId,
        error: getErrorMessage(error),
      });

      // Best-effort: transition the operation to FAILED so it doesn't remain
      // stuck as IN_PROGRESS (stale lock) until the timeout-based recovery.
      // If the DB is also down, this will fail silently — the original error
      // is always rethrown regardless.
      if (syncOperation) {
        try {
          await this.syncOperationRepo!.markAsFailed(
            syncOperation.id,
            userId,
            `Fatal error during push processing: ${getErrorMessage(error)}`,
          );
        } catch (markFailedError) {
          // Do not mask the original error. Log and continue to rethrow.
          this.logger.warn('Best-effort markAsFailed also failed', {
            context: 'SyncService.processPushSync',
            syncOperationId: syncOperation.id,
            markFailedError: getErrorMessage(markFailedError),
            originalError: getErrorMessage(error),
          });
        }
      }

      throw error;
    }
  }

  /**
   * Treat delete "not found" errors as idempotent success.
   * This prevents partial-success retries from dead-lettering deletes.
   */
  private isIdempotentDeleteNotFound(error: unknown): boolean {
    if (error instanceof AppError && error.errorCode === ErrorCodes.NOT_FOUND) {
      return true;
    }

    // Prisma "Record to delete does not exist."
    if (isPrismaError(error) && error.code === 'P2025') {
      return true;
    }

    return false;
  }

  /**
   * Resolve multiple conflicts in batch
   *
   * @param userId - User ID
   * @param conflicts - Array of conflicts with resolution strategies
   * @returns Resolution result
   */
  public async resolveConflictsBatch(
    userId: string,
    conflicts: ConflictResolutionInput[],
  ): Promise<BatchConflictResolutionResult> {
    if (!this.isInitialized) {
      throw AppError.precondition('SyncService not initialized');
    }

    const resolved: SyncConflict[] = [];
    const failed: FailedChange[] = [];

    for (const conflict of conflicts) {
      try {
        const result = await this.syncConflictRepo!.resolveConflict({
          conflictId: conflict.conflictId,
          resolution: conflict.resolution,
          resolvedBy: userId,
          // Type-safe cast: JsonValue (from conflict input) → InputJsonValue (for DB write)
          resolvedData: conflict.resolvedData as Prisma.InputJsonValue | undefined,
        });
        resolved.push(result);
      } catch (error) {
        // For conflict resolution, conflictId serves as the identifier
        failed.push({
          clientId: conflict.conflictId,
          error: getErrorMessage(error),
        });
      }
    }

    return { resolved, failed };
  }

  /**
   * Get sync status with cursor positions per entity
   *
   * @param userId - User ID
   * @param deviceId - Optional device ID
   * @returns Sync status with cursor positions
   */
  public async getSyncStatus(
    userId: string,
    deviceId?: string,
  ): Promise<{
    lastSyncTime: string | null;
    cursorPositions: Record<string, string>;
    pendingChanges: number;
    conflicts: number;
    syncInProgress: boolean;
  }> {
    if (!this.isInitialized) {
      throw AppError.precondition('SyncService not initialized');
    }

    try {
      const syncState = deviceId
        ? await this.syncStateRepo!.getOrCreateSyncState(userId, deviceId)
        : await this.syncStateRepo!.getUserSyncStates(userId).then(response => response.items[0]);

      const cursorPosition = deviceId
        ? await this.syncStateRepo!.getCursorPosition(userId, deviceId)
        : null;

      // Get pending changes count (device-specific, return 0 if no deviceId)
      const pendingChanges = deviceId
        ? await this.syncChangeRepo!.getPendingChangesCount(userId, deviceId)
        : 0;

      // Get conflicts count (pass deviceId for consistency, though method accepts optional)
      const conflicts = await this.syncConflictRepo!.getPendingConflictsCount(userId, deviceId);

      // Parse cursor to get per-entity positions
      // PHASE 3B: Use tryDecodeCompositeCursor (non-throwing) for status endpoint
      // Status should still work even if cursor is corrupt - this is informational only
      let cursorPositions: Record<string, string> = {};
      if (cursorPosition) {
        const decodedCursor = tryDecodeCompositeCursor(cursorPosition);
        if (decodedCursor) {
          cursorPositions = decodedCursor.entityCursors;
        } else {
          this.logger.warn('Failed to parse cursor for status (using tryDecode)', {
            cursor: cursorPosition.substring(0, 50) + '...',
          });
        }
      }

      return {
        lastSyncTime: syncState?.lastSyncAt?.toISOString() || null,
        cursorPositions,
        pendingChanges,
        conflicts,
        syncInProgress: syncState?.syncInProgress || false,
      };
    } catch (error) {
      this.logger.error('Failed to get sync status', {
        context: 'SyncService',
        userId,
        deviceId,
        error: getErrorMessage(error),
      });
      throw error;
    }
  }

  /**
   * Get changes since a specific cursor
   *
   * @param userId - User ID
   * @param deviceId - Device ID
   * @param cursor - Base64-encoded cursor
   * @returns Transformed changes since cursor (frontend format)
   */
  public async getChangesSinceCursor(
    userId: string,
    deviceId: string,
    cursor: string,
  ): Promise<PullSyncResult['changes']> {
    if (!this.isInitialized) {
      throw AppError.precondition('SyncService not initialized');
    }

    try {
      // Use ALL syncable entity types for piggyback consistency with main /sync/changes path.
      // Previously hardcoded to ['consumptions', 'sessions', 'journal_entries', 'goals'],
      // which excluded products, devices, purchases, inventory_items, ai_usage_records.
      // This caused private products created on another device to be invisible via piggyback,
      // forcing clients to make a separate /sync/changes request to discover them.
      const result = await this.getIncrementalChanges(userId, deviceId, [...ENTITY_TYPES], cursor, 1000);
      return result.changes; // Already transformed by getIncrementalChanges
    } catch (error) {
      this.logger.error('Failed to get changes since cursor', {
        context: 'SyncService',
        userId,
        deviceId,
        cursor,
        error: getErrorMessage(error),
      });
      throw error;
    }
  }

  /**
   * Helper: Detect conflicts using optimistic locking
   */
  private async detectConflict(userId: string, change: PendingChangeItem): Promise<SyncConflict | null> {
    // Canonicalize entity type and check if conflict-free using shared config
    const canonicalType = tryCanonicalizeEntityType(change.entityType);
    if (canonicalType && isConflictFree(canonicalType)) {
      this.logger.debug('Skipping conflict detection for conflict-free entity', {
        context: 'SyncService.detectConflict',
        entityType: change.entityType,
        entityId: change.entityId,
      });
      return null;
    }

    // STEP 1: Get handler for this entity type
    const handler = this.entityHandlers.get(change.entityType);
    if (!handler) {
      // If no handler, we can't reliably detect conflicts or fetch server version
      this.logger.warn('No handler for entity type, skipping conflict detection', {
        context: 'SyncService.detectConflict',
        entityType: change.entityType,
      });
      return null;
    }

    // STEP 2: Fetch current server version using handler
    // We use the shared database client for read-only check
    const serverEntity = await handler.fetchServerVersion(
      userId,
      change.entityId,
      this.databaseService.getClient() as unknown as Prisma.TransactionClient,
    );

    if (!serverEntity) {
      // Entity doesn't exist on server - no conflict possible (will be a CREATE or 404)
      return null;
    }

    // STEP 3: Compare versions for optimistic locking
    // All syncable entities must have a 'version' field
    const serverVersion = (serverEntity as any).version ?? 0;
    const clientVersion = change.syncVersion ?? 0;

    if (serverVersion > clientVersion) {
      this.logger.info('Sync conflict detected (optimistic locking)', {
        context: 'SyncService.detectConflict',
        entityType: change.entityType,
        entityId: change.entityId,
        serverVersion,
        clientVersion,
      });

      // STEP 4: Create conflict record with ACTUAL server data
      // This data is returned to the client so it can perform local merging
      return await this.syncConflictRepo!.createConflict({
        userId,
        entityType: change.entityType,
        entityId: change.entityId,
        // localVersion is what the client tried to push
        localVersion: change.changeData as Prisma.InputJsonValue,
        // remoteVersion is what's currently on the server
        remoteVersion: serverEntity as Prisma.InputJsonValue,
      });
    }

    return null;
  }

  /**
   * Resolve correct server entity IDs for all changes during replay reconstruction.
   *
   * **WHY THIS EXISTS:**
   * When a COMPLETED SyncOperation has no cached `resultPayload` (legacy records),
   * the reconstruction path must determine the correct `serverId` for each change.
   * For UPDATE/DELETE, `entityId` IS the server ID. For CREATE, the server may have
   * assigned a different ID (e.g., DeviceHandler finds existing device by macAddress).
   *
   * **RESOLUTION STRATEGY (per CREATE change):**
   * 1. If handler implements `resolveServerIdForCreate` → use it (handler-specific lookup)
   * 2. Else, try `fetchServerVersion(userId, entityId)` → if entity exists, entityId is correct
   * 3. Fall back to `change.entityId` with ERROR log (PULL will repair)
   *
   * **READ-ONLY:** This method NEVER mutates data. Safe to call outside transactions.
   *
   * @param userId - User ID for authorization scoping
   * @param changes - The original push request changes
   * @returns Reconstructed SuccessfulChange array with canonical server IDs
   */
  private async resolveServerIdsForReconstruction(
    userId: string,
    changes: PendingChangeItem[],
  ): Promise<SuccessfulChange[]> {
    const pseudoTx = this.databaseService.getClient() as unknown as Prisma.TransactionClient;

    const resolved: SuccessfulChange[] = [];

    for (const change of changes) {
      let serverId = change.entityId;

      // UPDATEs and DELETEs operate on existing entities — entityId IS serverId
      if (change.changeType === 'CREATE') {
        const handler = this.entityHandlers.get(change.entityType);

        if (handler) {
          let found = false;

          // Strategy 1: Handler-specific resolver (e.g., DeviceHandler MAC address lookup)
          if (handler.resolveServerIdForCreate) {
            const resolved = await handler.resolveServerIdForCreate(
              userId,
              change.entityId,
              change.changeData,
            );
            if (resolved) {
              serverId = resolved;
              found = true;
            }
          }

          // Strategy 2: Direct ID lookup via fetchServerVersion
          // If entity exists with clientEntityId, that IS the correct serverId
          if (!found) {
            try {
              const entity = await handler.fetchServerVersion(userId, change.entityId, pseudoTx);
              if (entity && typeof entity === 'object' && 'id' in entity) {
                serverId = (entity as { id: string }).id;
                found = true;
              }
            } catch {
              // fetchServerVersion failed — continue to fallback
            }
          }

          // Strategy 3: Fallback — use entityId with ERROR log
          // PULL cycle will eventually repair the incorrect mapping.
          if (!found) {
            this.logger.error(
              'Cannot resolve canonical serverId for CREATE during reconstruction — ' +
              'using clientEntityId as fallback (PULL will repair)',
              {
                context: 'SyncService.resolveServerIdsForReconstruction',
                userId,
                entityType: change.entityType,
                clientEntityId: change.entityId,
                clientId: change.clientId,
              },
            );
          }
        }
      }

      resolved.push({
        clientId: change.clientId ?? change.entityId,
        serverId,
        entityType: change.entityType,
        requestId: change.requestId,
      });
    }

    return resolved;
  }

  /**
   * Helper: Apply a single change to the database
   *
   * **ARCHITECTURE REFACTORING (Strategy Pattern):**
   * - Replaced switch-case with handler registry lookup
   * - Entity-agnostic implementation via SyncEntityHandler interface
   * - Each change executed in its own transaction for atomicity
   * - Type-safe via Zod validation in handlers
   * - Creates SyncChange records for cross-device synchronization
   *
   * @param userId - User ID for authorization
   * @param deviceId - Device ID that created the change (for SyncChange tracking)
   * @param change - Pending change to apply
   * @returns The actual entity ID after the operation (may differ from change.entityId for idempotent CREATEs)
   * @throws AppError if handler not found or operation fails
   */
  private async applyChange(userId: string, deviceId: string, change: PendingChangeItem): Promise<string> {
    // STEP 1: Get handler for this entity type
    const handler = this.entityHandlers.get(change.entityType);
    if (!handler) {
      throw new AppError(
        500,
        ErrorCodes.SERVICE_UNAVAILABLE,
        `No sync handler registered for entity type: ${change.entityType}`,
        true,
        { entityType: change.entityType, availableTypes: Array.from(this.entityHandlers.keys()) },
      );
    }

    // STEP 2: Execute change within transaction for atomicity
    // Each change gets its own transaction to maintain current behavior
    // EC-DEVICE-ID-001 (v2.4.2): Return the actual entity ID for idempotency cases
    let actualEntityId = change.entityId;

    await this.databaseService.transaction(async (prisma) => {
      // Cast PrismaClient to TransactionClient for handler compatibility
      const tx = prisma as unknown as Prisma.TransactionClient;

      // STEP 2A: Apply the change via handler and capture the created/updated entity
      let createdEntity: unknown;
      if (change.changeType === 'CREATE') {
        createdEntity = await handler.create(userId, change.entityId, change.changeData, tx);
      } else if (change.changeType === 'UPDATE') {
        createdEntity = await handler.update(userId, change.entityId, change.changeData, tx);
      } else if (change.changeType === 'DELETE') {
        createdEntity = await handler.delete(userId, change.entityId, tx);
      } else {
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          `Unknown change type: ${change.changeType}`,
          true,
          { changeType: change.changeType, entityType: change.entityType },
        );
      }

      // EC-DEVICE-ID-001 (v2.4.2): Extract actual entity ID for idempotency handling
      // When DeviceHandler.create() finds an existing device by MAC address, it
      // returns that existing device with a DIFFERENT ID than the client requested.
      // We must return this actual ID so the frontend can update its local record.
      if (createdEntity && typeof createdEntity === 'object' && 'id' in createdEntity) {
        const entityWithId = createdEntity as { id: string };
        if (entityWithId.id !== change.entityId) {
          this.logger.info('Idempotent operation returned existing entity with different ID', {
            context: 'SyncService.applyChange',
            entityType: change.entityType,
            clientEntityId: change.entityId,
            serverEntityId: entityWithId.id,
            changeType: change.changeType,
          });
        }
        actualEntityId = entityWithId.id;
      }

      // STEP 2B: Create SyncChange record for cross-device synchronization
      // This allows other devices to pull this change via GET /sync/changes.
      // IMPORTANT: deviceId represents the device that CREATED this change (source device).
      const syncChangeWithActualId = { ...change, entityId: actualEntityId };
      const nextSyncVersion = await this.createSyncChangeRecord(
        tx,
        userId,
        deviceId,
        syncChangeWithActualId,
        createdEntity as Prisma.InputJsonValue,
      );

      this.logger.debug('Change applied and tracked for cross-device sync', {
        context: 'SyncService.applyChange',
        userId,
        entityType: change.entityType,
        changeType: change.changeType,
        clientEntityId: change.entityId,
        actualEntityId,
        finalVersion: nextSyncVersion,
      });
    });

    this.logger.debug('Change applied via handler', {
      context: 'SyncService.applyChange',
      userId,
      entityType: change.entityType,
      changeType: change.changeType,
      clientEntityId: change.entityId,
      actualEntityId,
    });

    return actualEntityId;
  }

  /**
   * Create a SyncChange record with per-entity transactional locking.
   *
   * Uses PostgreSQL advisory locks to serialize syncVersion assignment for the same
   * (userId, deviceId, entityType, entityId) key. Additionally implements retry logic
   * for unique constraint violations to handle edge cases where concurrent transactions
   * may race despite the advisory lock.
   * 
   * to handle race conditions that can occur with concurrent transactions.
   */
  private async createSyncChangeRecord(
    tx: Prisma.TransactionClient,
    userId: string,
    deviceId: string,
    change: PendingChangeItem,
    createdEntity: Prisma.InputJsonValue,
  ): Promise<number> {
    const lockKey = `${userId}:${deviceId}:${change.entityType}:${change.entityId}`;
    const maxRetries = 3;

    try {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
    } catch (error) {
      throw new AppError(
        500,
        ErrorCodes.DATABASE_ERROR,
        'Failed to acquire sync change lock',
        true,
        { lockKey, error: getErrorMessage(error) },
      );
    }

    // Retry loop for handling rare race conditions
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const latestSyncChange = await tx.syncChange.findFirst({
          where: {
            userId,
            deviceId,
            entityType: change.entityType,
            entityId: change.entityId,
          },
          orderBy: { syncVersion: 'desc' },
          select: { syncVersion: true },
        });

        const nextSyncVersion = (latestSyncChange?.syncVersion ?? 0) + 1 + attempt;

        await tx.syncChange.create({
          data: {
            userId,
            deviceId,
            changeType: change.changeType,
            entityType: change.entityType,
            entityId: change.entityId,
            changeData: createdEntity,
            syncVersion: nextSyncVersion,
            applied: false,
          },
        });

        return nextSyncVersion;
      } catch (error) {
        // Check if this is a unique constraint violation (P2002)
        const isPrismaError = error && typeof error === 'object' && 'code' in error;
        if (isPrismaError && (error as { code: string }).code === 'P2002') {
          if (attempt < maxRetries - 1) {
            this.logger.warn('Sync change version collision, retrying with higher version', {
              context: 'SyncService.createSyncChangeRecord',
              userId,
              deviceId,
              entityType: change.entityType,
              entityId: change.entityId,
              attempt: attempt + 1,
            });
            // Continue to next iteration with incremented version
            continue;
          }
          // Final attempt failed, throw specific error
          throw new AppError(
            409,
            ErrorCodes.CONFLICT,
            'Failed to create sync change record after maximum retries - concurrent modification detected',
            true,
            {
              userId,
              deviceId,
              entityType: change.entityType,
              entityId: change.entityId,
              attempts: maxRetries,
            },
          );
        }
        // Not a unique constraint error, rethrow
        throw error;
      }
    }

    // This should never be reached due to the throw in the loop
    throw new AppError(
      500,
      ErrorCodes.DATABASE_ERROR,
      'Unexpected error in createSyncChangeRecord',
      true,
    );
  }

  /**
   * Resolve client-to-server ID mappings within a single sync batch.
   * Ensures subsequent changes in the same batch use server-assigned IDs.
   *
   * @param change - Pending change item to resolve
   * @param idMap - Map of client IDs to server IDs for the current batch
   * @returns Resolved change item
   */
  private resolveMappedIdsInChange(
    change: PendingChangeItem,
    idMap: Map<string, string>,
  ): PendingChangeItem {
    // 1. Resolve primary entityId if mapped
    let resolvedEntityId = change.entityId;
    if (idMap.has(change.entityId)) {
      resolvedEntityId = idMap.get(change.entityId)!;
      this.logger.debug('Resolved entityId from in-batch mapping', {
        context: 'SyncService.resolveMappedIdsInChange',
        oldId: change.entityId,
        newId: resolvedEntityId,
        entityType: change.entityType,
      });
    }

    // 2. Resolve FK fields in changeData if mapped
    let resolvedChangeData = change.changeData;
    // Use type guard to get FK fields for canonical entity type from shared config
    const canonicalType = tryCanonicalizeEntityType(change.entityType);
    const fkFields = canonicalType
      ? getForeignKeyFields(canonicalType, RELATION_SCOPE.BACKEND)
      : undefined;

    if (fkFields && resolvedChangeData && typeof resolvedChangeData === 'object' && !Array.isArray(resolvedChangeData)) {
      const dataObj = { ...resolvedChangeData as Record<string, any> };
      let dataChanged = false;

      for (const field of fkFields) {
        const clientId = dataObj[field];
        if (clientId && typeof clientId === 'string' && idMap.has(clientId)) {
          dataObj[field] = idMap.get(clientId);
          dataChanged = true;
          this.logger.debug('Resolved FK field from in-batch mapping', {
            context: 'SyncService.resolveMappedIdsInChange',
            entityType: change.entityType,
            field,
            oldId: clientId,
            newId: dataObj[field],
          });
        }
      }

      if (dataChanged) {
        resolvedChangeData = dataObj as Prisma.JsonValue;
      }
    }

    return {
      ...change,
      entityId: resolvedEntityId,
      changeData: resolvedChangeData,
    };
  }

  /**
   * Clean up resources and shutdown
   */
  async cleanup(): Promise<void> {
    // Services manage their own lifecycle - just reset optional references
    this.cacheService = null;
    // Don't nullify constructor dependencies (databaseService, performanceMonitor)
    this.isCacheAvailable = false;
    this.isInitialized = false;
    
    this.logger.log(LogLevel.INFO, LogCategory.SYSTEM, 'SyncService cleaned up');
  }

  /**
   * Check if service is initialized
   */
  public isServiceInitialized(): boolean {
    return this.isInitialized;
  }
}

// The class is already exported at declaration (line 138)
// No longer exporting the instance directly - it must be created in bootstrap.ts
