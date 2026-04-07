import type { PrismaClient } from '@prisma/client';
import type { LoggerService } from '../services/logger.service';

const DB_POOL_METRICS_ENABLED = process.env.HEALTH_METRICS_DB_POOL === 'true';
const DB_POOL_METRICS_INTERVAL_MS = parseInt(process.env.HEALTH_METRICS_DB_POOL_INTERVAL_MS || '60000', 10);

let lastCollectedAt = 0;

interface DbConnectionStats {
  active: number;
  idle: number;
  total: number;
}

export async function recordDbConnectionMetrics(
  prisma: PrismaClient,
  logger: LoggerService,
  context: string,
  tags?: Record<string, string>
): Promise<void> {
  if (!DB_POOL_METRICS_ENABLED) return;
  if (process.env.NODE_ENV === 'test') return;

  const now = Date.now();
  if (now - lastCollectedAt < DB_POOL_METRICS_INTERVAL_MS) return;
  lastCollectedAt = now;

  try {
    const result = await prisma.$queryRaw<DbConnectionStats[]>`
      SELECT
        COUNT(*) FILTER (WHERE state = 'active')::int AS active,
        COUNT(*) FILTER (WHERE state = 'idle')::int AS idle,
        COUNT(*)::int AS total
      FROM pg_stat_activity
      WHERE datname = current_database()
    `;

    const stats = result?.[0];
    if (!stats) return;

    logger.info('Database connection pool metrics', {
      context,
      event: 'db_pool_metrics',
      active: stats.active,
      idle: stats.idle,
      total: stats.total,
      ...(tags ?? {}),
    });
  } catch (error: unknown) {
    logger.warn('Failed to collect DB connection metrics', {
      context,
      event: 'db_pool_metrics_error',
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    });
  }
}
