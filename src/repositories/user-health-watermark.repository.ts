/**
 * User Health Watermark Repository
 *
 * Provides atomic watermark increment operations for health data freshness tracking.
 * The watermark is a monotonically increasing sequence number that tracks health data changes.
 *
 * - Uses UPSERT with atomic increment (INSERT ON CONFLICT DO UPDATE SET seq = seq + 1)
 * - NEVER uses read-modify-write pattern (race condition prone)
 * - Supports transaction client for atomic operations with health sample upsert
 * - One row per user (userId is primary key)
 *
 * INVARIANTS:
 * - sequenceNumber is monotonically increasing (never decremented)
 * - sequenceNumber >= 0 (enforced by CHECK constraint in DB)
 * - Only one watermark row per user
 *
 * @module UserHealthWatermarkRepository
 */

import { PrismaClient, UserHealthWatermark, Prisma } from '@prisma/client';
import { BaseRepository } from './base.repository';
import { LoggerService } from '../services/logger.service';

/**
 * Repository for UserHealthWatermark CRUD and atomic increment operations.
 *
 * USAGE:
 * - Call incrementSequenceNumber() inside the same transaction as health sample upsert
 * - Call getSequenceNumber() for staleness detection (compare with cache's sourceWatermark)
 */
export class UserHealthWatermarkRepository extends BaseRepository<UserHealthWatermark> {
  constructor(prisma: PrismaClient, logger: LoggerService) {
    super(prisma, 'UserHealthWatermark', logger);
  }

  /**
   * Atomically increment the user's health watermark sequence number.
   *
   * - First call for a user creates row with sequenceNumber = 1
   * - Subsequent calls atomically increment the existing value
   * - Safe under concurrent requests (no lost updates)
   *
   * TRANSACTION SUPPORT:
   * - Pass `tx` to execute within an existing transaction
   * - This ensures watermark increment is atomic with health sample upsert
   *
   * @param userId - The user ID
   * @param lastSampleAt - Timestamp of the most recent sample (for audit)
   * @param tx - Optional transaction client for atomic operations
   * @returns The new sequence number after increment
   */
  async incrementSequenceNumber(
    userId: string,
    lastSampleAt: Date | null,
    tx?: Prisma.TransactionClient
  ): Promise<bigint> {
    const client = tx ?? this.prisma;

    try {
      // Use raw SQL for truly atomic increment
      // Prisma's upsert with { increment: 1 } has edge cases with initial creation
      const result = await client.$queryRaw<{ sequence_number: bigint }[]>`
        INSERT INTO "user_health_watermarks" ("user_id", "sequence_number", "last_sample_at", "last_changed_at", "created_at", "updated_at")
        VALUES (${userId}, 1, ${lastSampleAt}, NOW(), NOW(), NOW())
        ON CONFLICT ("user_id")
        DO UPDATE SET
          "sequence_number" = "user_health_watermarks"."sequence_number" + 1,
          "last_sample_at" = COALESCE(${lastSampleAt}, "user_health_watermarks"."last_sample_at"),
          "last_changed_at" = NOW(),
          "updated_at" = NOW()
        RETURNING "sequence_number"
      `;

      const newSequence = result[0]?.sequence_number ?? BigInt(1);

      this.logger.info('Incremented user health watermark', {
        context: 'UserHealthWatermarkRepository.incrementSequenceNumber',
        userId,
        newSequenceNumber: newSequence.toString(),
        lastSampleAt: lastSampleAt?.toISOString(),
      });

      return newSequence;
    } catch (error) {
      throw this.handleError(error, 'incrementSequenceNumber');
    }
  }

  /**
   * Get the current sequence number for a user.
   *
   * Used for staleness detection: compare with cache's sourceWatermark.
   * - If watermark doesn't exist, returns null (user has no health data yet)
   * - If watermark.sequenceNumber > cache.sourceWatermark, cache is stale
   *
   * @param userId - The user ID
   * @returns The current sequence number, or null if no watermark exists
   */
  async getSequenceNumber(userId: string): Promise<bigint | null> {
    try {
      const watermark = await this.prisma.userHealthWatermark.findUnique({
        where: { userId },
        select: { sequenceNumber: true },
      });

      this.logSuccess('getSequenceNumber', {
        userId,
        sequenceNumber: watermark?.sequenceNumber?.toString() ?? null,
        exists: !!watermark,
      });

      return watermark?.sequenceNumber ?? null;
    } catch (error) {
      throw this.handleError(error, 'getSequenceNumber');
    }
  }

  /**
   * Get the full watermark record for a user.
   *
   * Includes all metadata: sequenceNumber, lastSampleAt, lastChangedAt, etc.
   *
   * @param userId - The user ID
   * @returns The full watermark record, or null if not exists
   */
  async getWatermark(userId: string): Promise<UserHealthWatermark | null> {
    try {
      const watermark = await this.prisma.userHealthWatermark.findUnique({
        where: { userId },
      });

      this.logSuccess('getWatermark', {
        userId,
        found: !!watermark,
      });

      return watermark;
    } catch (error) {
      throw this.handleError(error, 'getWatermark');
    }
  }

  /**
   * Check if a user has any health data (watermark exists).
   *
   * @param userId - The user ID
   * @returns True if watermark exists
   */
  async exists(userId: string): Promise<boolean> {
    try {
      const count = await this.prisma.userHealthWatermark.count({
        where: { userId },
      });

      return count > 0;
    } catch (error) {
      throw this.handleError(error, 'exists');
    }
  }

  /**
   * Delete watermark for a user (used in cleanup/testing).
   *
   * Note: In production, watermarks are CASCADE deleted when user is deleted.
   *
   * @param userId - The user ID
   * @returns True if watermark was deleted, false if it didn't exist
   */
  async delete(userId: string): Promise<boolean> {
    try {
      const result = await this.prisma.userHealthWatermark.deleteMany({
        where: { userId },
      });

      this.logSuccess('delete', {
        userId,
        deleted: result.count > 0,
      });

      return result.count > 0;
    } catch (error) {
      throw this.handleError(error, 'delete');
    }
  }

  /**
   * Get watermarks for multiple users (batch query).
   *
   * Useful for bulk staleness checks.
   *
   * @param userIds - Array of user IDs
   * @returns Map of userId to sequenceNumber (missing users have null)
   */
  async getSequenceNumbersBatch(userIds: string[]): Promise<Map<string, bigint | null>> {
    if (userIds.length === 0) {
      return new Map();
    }

    try {
      const watermarks = await this.prisma.userHealthWatermark.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, sequenceNumber: true },
      });

      const result = new Map<string, bigint | null>();

      // Initialize all requested users with null
      for (const userId of userIds) {
        result.set(userId, null);
      }

      // Fill in actual values
      for (const wm of watermarks) {
        result.set(wm.userId, wm.sequenceNumber);
      }

      this.logSuccess('getSequenceNumbersBatch', {
        requestedCount: userIds.length,
        foundCount: watermarks.length,
      });

      return result;
    } catch (error) {
      throw this.handleError(error, 'getSequenceNumbersBatch');
    }
  }
}
