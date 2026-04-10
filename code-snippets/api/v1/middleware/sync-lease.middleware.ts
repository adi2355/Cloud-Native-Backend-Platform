import { Request, Response, NextFunction } from 'express';
import type { SyncLeaseKind } from '@shared/contracts';
import { AppError, ErrorCodes } from '../../../utils/AppError';
import { SyncLeaseService } from '../../../services/syncLease.service';
import { LoggerService } from '../../../services/logger.service';
import { getUserId } from '../../../utils/auth-guards';

export interface SyncLeaseMiddlewareOptions {
  kind: SyncLeaseKind;
  getLeaseId: (req: Request) => string | undefined;
  shouldRequire?: (req: Request) => boolean;
}

export function createSyncLeaseMiddleware(
  syncLeaseService: SyncLeaseService,
  logger: LoggerService,
  options: SyncLeaseMiddlewareOptions,
) {
  if (!syncLeaseService || !logger) {
    throw new Error('createSyncLeaseMiddleware requires SyncLeaseService and LoggerService');
  }

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!syncLeaseService.isEnabled()) {
        return next();
      }

      if (options.shouldRequire && !options.shouldRequire(req)) {
        return next();
      }

      // getUserId expects Express Request and uses assertAuthenticated internally
      // The req parameter is already the correct type
      const userId = getUserId(req);
      const leaseId = options.getLeaseId(req);
      const retryAfterMs = syncLeaseService.getDefaultRetryAfterMs();

      if (!leaseId) {
        res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000));
        logger.warn('Sync lease required but not provided', {
          context: 'SyncLeaseMiddleware',
          userId,
          kind: options.kind,
        });
        return next(new AppError(
          429,
          ErrorCodes.RATE_LIMIT_EXCEEDED,
          'Sync lease required for bulk operation',
          true,
          { retryAfterMs, reason: 'LEASE_REQUIRED', kind: options.kind }
        ));
      }

      const decision = await syncLeaseService.consumeLease({
        userId,
        kind: options.kind,
        leaseId,
      });

      if (!decision.allowed) {
        const retryMs = decision.retryAfterMs ?? retryAfterMs;
        res.setHeader('Retry-After', Math.ceil(retryMs / 1000));

        const isServiceUnavailable = decision.reason === 'CACHE_UNAVAILABLE';
        const statusCode = isServiceUnavailable ? 503 : 429;
        const errorCode = isServiceUnavailable ? ErrorCodes.SERVICE_UNAVAILABLE : ErrorCodes.RATE_LIMIT_EXCEEDED;

        logger.warn('Sync lease denied', {
          context: 'SyncLeaseMiddleware',
          userId,
          kind: options.kind,
          reason: decision.reason,
          retryAfterMs: retryMs,
        });

        return next(new AppError(
          statusCode,
          errorCode,
          'Sync lease denied for bulk operation',
          true,
          { retryAfterMs: retryMs, reason: decision.reason, kind: options.kind }
        ));
      }

      return next();
    } catch (error) {
      logger.error('Sync lease middleware error', {
        context: 'SyncLeaseMiddleware',
        error: error instanceof Error ? error.message : String(error),
      });
      return next(error);
    }
  };
}
