/**
 * Product Impact Rollup Repository
 *
 * Data access layer for the user_product_impact_rollup derived read model.
 * Provides idempotent upsert and product-ranked queries for health impact aggregates.
 *
 * INVARIANTS:
 * - Upsert on (userId, productId, metricCode, windowMinutes, resolution, periodDays) — safe under at-least-once
 * - All writes go through Prisma typed operations (no raw SQL except findByUserAndMetric ranking)
 * - isReliable reflects aggregate reliability (not individual session reliability)
 *
 * @see health-projection-coordinator.service.ts ProductImpactProjectionHandler
 * @see product-impact-compute.ts computeProductImpactAggregate
 */

import { PrismaClient, UserProductImpactRollup, Prisma } from '@prisma/client';
import { BaseRepository } from './base.repository';
import { LoggerService } from '../services/logger.service';

// Types

/**
 * Input for upserting a product impact rollup.
 */
export interface UpsertProductImpactInput {
  readonly userId: string;
  readonly productId: string;
  readonly metricCode: string;
  readonly windowMinutes?: number;
  readonly resolution?: string;

  // Period dimension (internal design spec:2327 — lookback window variant)
  readonly periodDays?: number;

  // Aggregation period
  readonly periodStart?: Date | null;
  readonly periodEnd?: Date | null;
  readonly sessionCount: number;
  readonly minSessionsRequired?: number;

  // Aggregated effects
  readonly avgDeltaDuringAbs?: number | null;
  readonly avgDeltaDuringPct?: number | null;
  readonly avgDeltaAfterAbs?: number | null;
  readonly avgDeltaAfterPct?: number | null;
  readonly medianDeltaAfterPct?: number | null;

  // Baseline
  readonly baselineValue?: number | null;
  readonly baselineMethod?: string | null;
  readonly baselineN?: number | null;
  readonly baselineWindow?: string | null;

  // Quality
  readonly coverageScore?: number | null;
  readonly isReliable?: boolean;
  readonly qualityFlags?: string[];
  readonly exactness?: string;

  // Confidence
  readonly confidenceTier?: string;
  readonly confidenceScore?: number | null;
  readonly ciLow?: number | null;
  readonly ciHigh?: number | null;

  // Freshness
  readonly status: string;
  readonly sourceWatermark?: bigint | null;
  readonly computeVersion?: number;

  // Traceability
  readonly evidenceSessionCount?: number;
  readonly evidenceSessionIds?: string[];
}

// Helpers

/** Convert nullable number to Prisma.Decimal or null */
function toDecimalOrNull(value: number | null | undefined): Prisma.Decimal | null {
  return value != null ? new Prisma.Decimal(String(value)) : null;
}

// Repository

export class ProductImpactRollupRepository extends BaseRepository<UserProductImpactRollup> {
  constructor(
    prisma: PrismaClient,
    logger: LoggerService,
  ) {
    super(prisma, 'UserProductImpactRollup', logger);
  }

  /**
   * Upsert a product impact rollup.
   *
   * INSERT...ON CONFLICT DO UPDATE on (userId, productId, metricCode, windowMinutes, resolution, periodDays).
   * Idempotent: calling with the same data produces the same result.
   *
   * @param data - Impact data to upsert
   * @returns The upserted rollup row
   */
  async upsertImpact(data: UpsertProductImpactInput): Promise<UserProductImpactRollup> {
    try {
      const now = new Date();
      const windowMinutes = data.windowMinutes ?? 60;
      const resolution = data.resolution ?? '1min';
      const periodDays = data.periodDays ?? 90;

      const fields = {
        periodStart: data.periodStart ?? null,
        periodEnd: data.periodEnd ?? null,
        sessionCount: data.sessionCount,
        minSessionsRequired: data.minSessionsRequired ?? 3,
        avgDeltaDuringAbs: toDecimalOrNull(data.avgDeltaDuringAbs),
        avgDeltaDuringPct: toDecimalOrNull(data.avgDeltaDuringPct),
        avgDeltaAfterAbs: toDecimalOrNull(data.avgDeltaAfterAbs),
        avgDeltaAfterPct: toDecimalOrNull(data.avgDeltaAfterPct),
        medianDeltaAfterPct: toDecimalOrNull(data.medianDeltaAfterPct),
        baselineValue: toDecimalOrNull(data.baselineValue),
        baselineMethod: data.baselineMethod ?? null,
        baselineN: data.baselineN ?? null,
        baselineWindow: data.baselineWindow ?? null,
        coverageScore: toDecimalOrNull(data.coverageScore),
        isReliable: data.isReliable ?? false,
        qualityFlags: data.qualityFlags ?? [],
        exactness: data.exactness ?? 'ESTIMATED',
        confidenceTier: data.confidenceTier ?? 'INSUFFICIENT',
        confidenceScore: toDecimalOrNull(data.confidenceScore),
        ciLow: toDecimalOrNull(data.ciLow),
        ciHigh: toDecimalOrNull(data.ciHigh),
        status: data.status,
        sourceWatermark: data.sourceWatermark ?? null,
        computeVersion: data.computeVersion ?? 1,
        computedAt: now,
        evidenceSessionCount: data.evidenceSessionCount ?? 0,
        evidenceSessionIds: data.evidenceSessionIds ?? [],
      };

      return await this.prisma.userProductImpactRollup.upsert({
        where: {
          user_product_impact_rollup_unique: {
            userId: data.userId,
            productId: data.productId,
            metricCode: data.metricCode,
            windowMinutes,
            resolution,
            periodDays,
          },
        },
        create: {
          userId: data.userId,
          productId: data.productId,
          metricCode: data.metricCode,
          windowMinutes,
          resolution,
          periodDays,
          ...fields,
        },
        update: fields,
      });
    } catch (error) {
      this.handleError(error, 'upsertImpact');
    }
  }

  /**
   * Find product impact rollups for a user and metric, ranked by impact magnitude.
   *
   * JOINs to Product for name/type/variantCategory.
   * Filters by sessionCount >= minSessions and periodDays.
   * NO_DATA rows bypass the minSessions filter (they are state markers, not evidence).
   * Orders by ABS(avgDeltaAfterPct) DESC (most impactful first).
   *
   * SECURITY: User-scoped by userId.
   *
   * @param userId - User ID (authorization scope)
   * @param metricCode - Metric code to query
   * @param minSessions - Minimum session count for inclusion (default: 3)
   * @param limit - Maximum results to return
   * @param periodDays - Lookback window variant (default: 90)
   * @returns Rollup rows with joined product data
   */
  async findByUserAndMetric(
    userId: string,
    metricCode: string,
    minSessions: number = 3,
    limit: number = 20,
    periodDays: number = 90,
  ): Promise<(UserProductImpactRollup & {
    product: { id: string; name: string; type: string; variantCategory: string | null };
  })[]> {
    try {
      // Use raw SQL for ABS() ordering which Prisma ORM doesn't support directly
      const results = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT r.id
        FROM user_product_impact_rollup r
        WHERE r.user_id = ${userId}
          AND r.metric_code = ${metricCode}
          AND r.period_days = ${periodDays}
          AND (r.session_count >= ${minSessions} OR r.status = 'NO_DATA')
        ORDER BY ABS(r.avg_delta_after_pct) DESC NULLS LAST
        LIMIT ${limit}
      `;

      if (results.length === 0) return [];

      const ids = results.map((r) => r.id);

      // Fetch full rows with product join using Prisma (type-safe)
      const rows = await this.prisma.userProductImpactRollup.findMany({
        where: { id: { in: ids } },
        include: {
          product: {
            select: {
              id: true,
              name: true,
              type: true,
              variantCategory: true,
            },
          },
        },
      });

      // Preserve the ABS() ordering from the raw query
      const idToIndex = new Map(ids.map((id, idx) => [id, idx]));
      rows.sort((a, b) => (idToIndex.get(a.id) ?? 0) - (idToIndex.get(b.id) ?? 0));

      return rows;
    } catch (error) {
      this.handleError(error, 'findByUserAndMetric');
    }
  }

  /**
   * Find product impact rollups for a user and MULTIPLE metrics, ranked by impact.
   *
   * Multi-metric variant: returns rows for ALL specified metric codes, enabling
   * the grouped products[].impacts.{metricCode} response shape (internal design spec:3032).
   *
   * Each metric is independently ranked by ABS(avgDeltaAfterPct) DESC.
   * NO_DATA rows bypass the minSessions filter (they are state markers, not evidence).
   * Products that appear across multiple metrics are naturally grouped by client.
   *
   * SECURITY: User-scoped by userId.
   *
   * @param userId - User ID (authorization scope)
   * @param metricCodes - Array of metric codes (max 6, per API_CONSTRAINTS)
   * @param minSessions - Minimum session count for inclusion (default: 3)
   * @param limit - Maximum results to return PER METRIC
   * @param periodDays - Lookback window variant (default: 90)
   * @returns Rollup rows with joined product data
   */
  async findByUserAndMetrics(
    userId: string,
    metricCodes: string[],
    minSessions: number = 3,
    limit: number = 20,
    periodDays: number = 90,
  ): Promise<(UserProductImpactRollup & {
    product: { id: string; name: string; type: string; variantCategory: string | null };
  })[]> {
    try {
      if (metricCodes.length === 0) return [];

      // Use raw SQL for ABS() ordering + multi-metric IN clause.
      // ROW_NUMBER() per metric ensures each metric is independently ranked.
      const results = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM (
          SELECT r.id,
            ROW_NUMBER() OVER (
              PARTITION BY r.metric_code
              ORDER BY ABS(r.avg_delta_after_pct) DESC NULLS LAST
            ) AS rn
          FROM user_product_impact_rollup r
          WHERE r.user_id = ${userId}
            AND r.metric_code = ANY(${metricCodes}::text[])
            AND r.period_days = ${periodDays}
            AND (r.session_count >= ${minSessions} OR r.status = 'NO_DATA')
        ) ranked
        WHERE rn <= ${limit}
      `;

      if (results.length === 0) return [];

      const ids = results.map((r) => r.id);

      // Fetch full rows with product join using Prisma (type-safe)
      const rows = await this.prisma.userProductImpactRollup.findMany({
        where: { id: { in: ids } },
        include: {
          product: {
            select: {
              id: true,
              name: true,
              type: true,
              variantCategory: true,
            },
          },
        },
      });

      // Preserve the ranked ordering from the raw query
      const idToIndex = new Map(ids.map((id, idx) => [id, idx]));
      rows.sort((a, b) => (idToIndex.get(a.id) ?? 0) - (idToIndex.get(b.id) ?? 0));

      return rows;
    } catch (error) {
      this.handleError(error, 'findByUserAndMetrics');
    }
  }

  /**
   * Find product impact rollups for a specific user and product.
   *
   * Optionally filtered by metric code. Filtered by periodDays.
   * NO_DATA rows bypass the minSessions filter (they are state markers, not evidence).
   *
   * SECURITY: User-scoped by userId.
   *
   * @param userId - User ID (authorization scope)
   * @param productId - Product ID
   * @param metricCode - Optional metric code filter
   * @param minSessions - Minimum session count for inclusion (default: 3)
   * @param periodDays - Lookback window variant (default: 90)
   * @returns Rollup rows with joined product data
   */
  async findByUserAndProduct(
    userId: string,
    productId: string,
    metricCode?: string,
    minSessions: number = 3,
    periodDays: number = 90,
  ): Promise<(UserProductImpactRollup & {
    product: { id: string; name: string; type: string; variantCategory: string | null };
  })[]> {
    try {
      // NO_DATA rows bypass minSessions — they are state markers, not evidence rows.
      const where: Prisma.UserProductImpactRollupWhereInput = {
        userId,
        productId,
        periodDays,
        OR: [
          { sessionCount: { gte: minSessions } },
          { status: 'NO_DATA' },
        ],
      };

      if (metricCode) {
        where.metricCode = metricCode;
      }

      return await this.prisma.userProductImpactRollup.findMany({
        where,
        include: {
          product: {
            select: {
              id: true,
              name: true,
              type: true,
              variantCategory: true,
            },
          },
        },
        orderBy: { metricCode: 'asc' },
      });
    } catch (error) {
      this.handleError(error, 'findByUserAndProduct');
    }
  }

  /**
   * Natural key lookup for a single product impact rollup.
   *
   * @param userId - User ID
   * @param productId - Product ID
   * @param metricCode - Metric code
   * @param windowMinutes - Window size (default: 60)
   * @param resolution - Resolution (default: '1min')
   * @param periodDays - Lookback window variant (default: 90)
   * @returns Single rollup or null
   */
  async findByUserProductAndMetric(
    userId: string,
    productId: string,
    metricCode: string,
    windowMinutes: number = 60,
    resolution: string = '1min',
    periodDays: number = 90,
  ): Promise<UserProductImpactRollup | null> {
    try {
      return await this.prisma.userProductImpactRollup.findUnique({
        where: {
          user_product_impact_rollup_unique: {
            userId,
            productId,
            metricCode,
            windowMinutes,
            resolution,
            periodDays,
          },
        },
      });
    } catch (error) {
      this.handleError(error, 'findByUserProductAndMetric');
    }
  }

  /**
   * Bulk mark product impact rollups as STALE for a user.
   *
   * Transitions READY/NO_DATA/PARTIAL → STALE.
   *
   * @param userId - User ID
   * @param productIds - Optional: only mark these product IDs stale
   * @returns Number of rows updated
   */
  async markStaleByUser(
    userId: string,
    productIds?: string[],
  ): Promise<number> {
    try {
      const where: Prisma.UserProductImpactRollupWhereInput = {
        userId,
        status: { in: ['READY', 'NO_DATA', 'PARTIAL'] },
      };

      if (productIds && productIds.length > 0) {
        where.productId = { in: productIds };
      }

      const result = await this.prisma.userProductImpactRollup.updateMany({
        where,
        data: { status: 'STALE' },
      });

      return result.count;
    } catch (error) {
      this.handleError(error, 'markStaleByUser');
    }
  }
}
