import crypto from 'crypto';

const METRICS_ENABLED = process.env.HEALTH_METRICS_ENABLED === 'true';
const METRICS_SAMPLE_PERCENT = parseInt(process.env.HEALTH_METRICS_SAMPLE_PCT || '100', 10);

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function hashToBucket(input: string): number {
  const digest = crypto.createHash('sha256').update(input).digest();
  const bucket = digest.readUInt32BE(0) % 100;
  return bucket;
}

export function shouldEmitHealthMetrics(userId?: string | null): boolean {
  if (!METRICS_ENABLED) return false;
  const percent = clampPercent(METRICS_SAMPLE_PERCENT);
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  if (!userId) return false;
  return hashToBucket(userId) < percent;
}

export function getHealthMetricsTags(userId?: string | null): Record<string, string> {
  if (!userId) return {};
  return {
    user_bucket: String(hashToBucket(userId)),
  };
}

export function isHealthMetricsEnabled(): boolean {
  return METRICS_ENABLED;
}
