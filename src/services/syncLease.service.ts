import { randomUUID } from 'crypto';
import type { SyncLeaseKind } from '@shared/contracts';
import { CacheService } from './cache.service';
import { LoggerService } from './logger.service';
import { AppError, ErrorCodes } from '../utils/AppError';

export interface SyncLeaseConfig {
  enabled: boolean;
  leaseWindowMs: number;
  maxRequestsPerLease: number;
  maxLeasesPerUser: number;
  maxLeasesGlobal: number;
  requestWindowMs: number;
  maxRequestsPerWindowGlobal: number;
  maxRequestsPerWindowUser: number;
  retryAfterMs: number;
}

interface StoredLease {
  leaseId: string;
  userId: string;
  kind: SyncLeaseKind;
  issuedAt: number;
  expiresAt: number;
  windowMs: number;
  maxRequests: number;
}

export interface SyncLeaseDecision {
  status: 'GRANTED' | 'DENIED';
  lease?: {
    leaseId: string;
    kind: SyncLeaseKind;
    issuedAt: string;
    expiresAt: string;
    windowMs: number;
    maxRequests: number;
  };
  retryAfterMs?: number;
  reason?: string;
}

export interface SyncLeaseConsumeResult {
  allowed: boolean;
  retryAfterMs?: number;
  reason?: string;
}

export class SyncLeaseService {
  private readonly config: SyncLeaseConfig;

  constructor(
    private cacheService: CacheService,
    private logger: LoggerService,
  ) {
    if (!cacheService || !logger) {
      throw new Error('SyncLeaseService: cacheService and logger are required');
    }

    this.config = {
      enabled: process.env.FF_SYNC_LEASE === 'true',
      leaseWindowMs: parseInt(process.env.SYNC_LEASE_WINDOW_MS || '3600000', 10), // 1 hour
      maxRequestsPerLease: parseInt(process.env.SYNC_LEASE_MAX_REQUESTS || '80', 10),
      maxLeasesPerUser: parseInt(process.env.SYNC_LEASE_MAX_ACTIVE_PER_USER || '2', 10),
      maxLeasesGlobal: parseInt(process.env.SYNC_LEASE_MAX_ACTIVE_GLOBAL || '500', 10),
      requestWindowMs: parseInt(process.env.SYNC_LEASE_REQUEST_WINDOW_MS || '60000', 10),
      maxRequestsPerWindowGlobal: parseInt(process.env.SYNC_LEASE_GLOBAL_MAX_REQUESTS || '5000', 10),
      maxRequestsPerWindowUser: parseInt(process.env.SYNC_LEASE_USER_MAX_REQUESTS || '120', 10),
      retryAfterMs: parseInt(process.env.SYNC_LEASE_RETRY_AFTER_MS || '60000', 10),
    };
  }

  public isEnabled(): boolean {
    return this.config.enabled;
  }

  public getDefaultRetryAfterMs(): number {
    return this.config.retryAfterMs;
  }

  public async requestLease(params: {
    userId: string;
    kind: SyncLeaseKind;
    requestedBatchSize?: number;
    requestedMaxRequests?: number;
  }): Promise<SyncLeaseDecision> {
    if (!this.config.enabled) {
      return { status: 'DENIED', reason: 'SYNC_LEASE_DISABLED' };
    }

    if (!this.cacheService.isReady()) {
      throw new AppError(
        503,
        ErrorCodes.SERVICE_UNAVAILABLE,
        'Sync lease service unavailable (cache not ready)',
        true,
      );
    }

    const now = Date.now();
    const leaseId = randomUUID();
    const maxRequests = Math.min(
      params.requestedMaxRequests ?? this.config.maxRequestsPerLease,
      this.config.maxRequestsPerLease
    );
    const expiresAt = now + this.config.leaseWindowMs;

    const admission = await this.reserveLeaseSlot(params.userId, params.kind, now);
    if (!admission.allowed) {
      return {
        status: 'DENIED',
        retryAfterMs: admission.retryAfterMs ?? this.config.retryAfterMs,
        reason: admission.reason ?? 'LEASE_LIMIT_REACHED',
      };
    }

    const storedLease: StoredLease = {
      leaseId,
      userId: params.userId,
      kind: params.kind,
      issuedAt: now,
      expiresAt,
      windowMs: this.config.leaseWindowMs,
      maxRequests,
    };

    const ttlSeconds = Math.ceil(this.config.leaseWindowMs / 1000);
    await this.cacheService.set(this.buildLeaseKey(leaseId), storedLease, { ttl: ttlSeconds });

    this.logger.info('Sync lease granted', {
      context: 'SyncLeaseService.requestLease',
      leaseId,
      userId: params.userId,
      kind: params.kind,
      maxRequests,
      windowMs: this.config.leaseWindowMs,
      requestedBatchSize: params.requestedBatchSize,
    });

    return {
      status: 'GRANTED',
      lease: {
        leaseId,
        kind: params.kind,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        windowMs: this.config.leaseWindowMs,
        maxRequests,
      },
    };
  }

  public async consumeLease(params: {
    userId: string;
    kind: SyncLeaseKind;
    leaseId: string;
  }): Promise<SyncLeaseConsumeResult> {
    if (!this.config.enabled) {
      return { allowed: true };
    }

    if (!this.cacheService.isReady()) {
      return {
        allowed: false,
        retryAfterMs: this.config.retryAfterMs,
        reason: 'CACHE_UNAVAILABLE',
      };
    }

    const lease = await this.cacheService.get<StoredLease>(this.buildLeaseKey(params.leaseId));
    if (!lease) {
      return {
        allowed: false,
        retryAfterMs: this.config.retryAfterMs,
        reason: 'LEASE_NOT_FOUND',
      };
    }

    if (lease.userId !== params.userId || lease.kind !== params.kind) {
      return {
        allowed: false,
        retryAfterMs: this.config.retryAfterMs,
        reason: 'LEASE_MISMATCH',
      };
    }

    const now = Date.now();
    if (now >= lease.expiresAt) {
      return {
        allowed: false,
        retryAfterMs: Math.max(0, lease.expiresAt - now),
        reason: 'LEASE_EXPIRED',
      };
    }

    const admission = await this.enforceRequestWindow(params.userId, params.kind, now);
    if (!admission.allowed) {
      return admission;
    }

    const usedKey = this.buildLeaseUsedKey(params.leaseId);
    const used = await this.cacheService.increment(usedKey, 1);
    if (used == null) {
      return {
        allowed: false,
        retryAfterMs: this.config.retryAfterMs,
        reason: 'LEASE_COUNTER_ERROR',
      };
    }

    if (used === 1) {
      const ttlSeconds = Math.ceil((lease.expiresAt - now) / 1000);
      await this.cacheService.expire(usedKey, ttlSeconds);
    }

    if (used > lease.maxRequests) {
      await this.cacheService.decrement(usedKey, 1);
      return {
        allowed: false,
        retryAfterMs: Math.max(0, lease.expiresAt - now),
        reason: 'LEASE_EXHAUSTED',
      };
    }

    return { allowed: true };
  }

  private async reserveLeaseSlot(userId: string, kind: SyncLeaseKind, now: number): Promise<SyncLeaseConsumeResult> {
    const windowKey = this.windowKey(now, this.config.leaseWindowMs);
    const globalKey = `sync:lease:global:${kind}:${windowKey}`;
    const userKey = `sync:lease:user:${userId}:${kind}:${windowKey}`;
    const ttlSeconds = Math.ceil(this.config.leaseWindowMs / 1000);

    const globalCount = await this.cacheService.increment(globalKey, 1);
    if (globalCount == null) {
      return { allowed: false, retryAfterMs: this.config.retryAfterMs, reason: 'GLOBAL_COUNTER_ERROR' };
    }
    if (globalCount === 1) {
      await this.cacheService.expire(globalKey, ttlSeconds);
    }
    if (globalCount > this.config.maxLeasesGlobal) {
      await this.cacheService.decrement(globalKey, 1);
      return { allowed: false, retryAfterMs: this.config.retryAfterMs, reason: 'GLOBAL_LEASE_LIMIT' };
    }

    const userCount = await this.cacheService.increment(userKey, 1);
    if (userCount == null) {
      await this.cacheService.decrement(globalKey, 1);
      return { allowed: false, retryAfterMs: this.config.retryAfterMs, reason: 'USER_COUNTER_ERROR' };
    }
    if (userCount === 1) {
      await this.cacheService.expire(userKey, ttlSeconds);
    }
    if (userCount > this.config.maxLeasesPerUser) {
      await this.cacheService.decrement(userKey, 1);
      await this.cacheService.decrement(globalKey, 1);
      return { allowed: false, retryAfterMs: this.config.retryAfterMs, reason: 'USER_LEASE_LIMIT' };
    }

    return { allowed: true };
  }

  private async enforceRequestWindow(userId: string, kind: SyncLeaseKind, now: number): Promise<SyncLeaseConsumeResult> {
    const windowKey = this.windowKey(now, this.config.requestWindowMs);
    const globalKey = `sync:lease:req:global:${kind}:${windowKey}`;
    const userKey = `sync:lease:req:user:${userId}:${kind}:${windowKey}`;
    const ttlSeconds = Math.ceil(this.config.requestWindowMs / 1000);

    const globalCount = await this.cacheService.increment(globalKey, 1);
    if (globalCount == null) {
      return { allowed: false, retryAfterMs: this.config.retryAfterMs, reason: 'GLOBAL_REQUEST_COUNTER_ERROR' };
    }
    if (globalCount === 1) {
      await this.cacheService.expire(globalKey, ttlSeconds);
    }
    if (globalCount > this.config.maxRequestsPerWindowGlobal) {
      await this.cacheService.decrement(globalKey, 1);
      return {
        allowed: false,
        retryAfterMs: this.windowRetryAfter(now, this.config.requestWindowMs),
        reason: 'GLOBAL_REQUEST_LIMIT',
      };
    }

    const userCount = await this.cacheService.increment(userKey, 1);
    if (userCount == null) {
      await this.cacheService.decrement(globalKey, 1);
      return { allowed: false, retryAfterMs: this.config.retryAfterMs, reason: 'USER_REQUEST_COUNTER_ERROR' };
    }
    if (userCount === 1) {
      await this.cacheService.expire(userKey, ttlSeconds);
    }
    if (userCount > this.config.maxRequestsPerWindowUser) {
      await this.cacheService.decrement(userKey, 1);
      await this.cacheService.decrement(globalKey, 1);
      return {
        allowed: false,
        retryAfterMs: this.windowRetryAfter(now, this.config.requestWindowMs),
        reason: 'USER_REQUEST_LIMIT',
      };
    }

    return { allowed: true };
  }

  private buildLeaseKey(leaseId: string): string {
    return `sync:lease:${leaseId}`;
  }

  private buildLeaseUsedKey(leaseId: string): string {
    return `sync:lease:${leaseId}:used`;
  }

  private windowKey(now: number, windowMs: number): number {
    return Math.floor(now / windowMs);
  }

  private windowRetryAfter(now: number, windowMs: number): number {
    const windowStart = Math.floor(now / windowMs) * windowMs;
    return Math.max(0, windowStart + windowMs - now);
  }
}
