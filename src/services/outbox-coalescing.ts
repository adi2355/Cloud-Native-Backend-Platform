import { HealthSamplesChangedPayload } from './health-projection-coordinator.service';

/**
 * Coalesce multiple health.samples.changed payloads for the same user into one
 * deterministic payload so projections can execute once per claim batch.
 */
export function coalesceHealthPayloads(
  payloads: readonly HealthSamplesChangedPayload[],
): HealthSamplesChangedPayload {
  if (payloads.length === 0) {
    throw new Error('coalesceHealthPayloads requires at least one payload');
  }

  const first = payloads[0]!;
  const userId = first.userId;

  for (const payload of payloads) {
    if (payload.userId !== userId) {
      throw new Error(
        `Cannot coalesce health payloads for different users: ${userId} and ${payload.userId}`,
      );
    }
  }

  const metricCodes = new Set<string>();
  const affectedLocalDates = new Set<string>();
  let rangeStartMs = Number.POSITIVE_INFINITY;
  let rangeEndMs = Number.NEGATIVE_INFINITY;
  let sampleCount = 0;
  let deletedCount = 0;
  let hasDeletions = false;
  let timezoneExplicit = false;

  const offsetCandidates: number[] = [];
  const seqCandidates: Array<string | number> = [];
  let deviceId: string | undefined;

  for (const payload of payloads) {
    for (const metricCode of payload.metricCodes) {
      metricCodes.add(metricCode);
    }
    for (const date of payload.affectedLocalDates) {
      affectedLocalDates.add(date);
    }

    rangeStartMs = Math.min(rangeStartMs, payload.rangeStartMs);
    rangeEndMs = Math.max(rangeEndMs, payload.rangeEndMs);
    sampleCount += payload.sampleCount;
    deletedCount += payload.deletedCount;
    hasDeletions = hasDeletions || payload.hasDeletions;
    timezoneExplicit = timezoneExplicit || (payload.timezoneExplicit === true);

    if (!deviceId && payload.deviceId) {
      deviceId = payload.deviceId;
    }

    if (payload.offsetRange) {
      offsetCandidates.push(payload.offsetRange.min, payload.offsetRange.max);
    } else if (payload.timezoneOffsetMinutes != null) {
      offsetCandidates.push(payload.timezoneOffsetMinutes);
    }

    if (payload.minRequiredSeq != null) {
      seqCandidates.push(payload.minRequiredSeq);
    }
  }

  const offsetRange = offsetCandidates.length > 0
    ? {
        min: Math.min(...offsetCandidates),
        max: Math.max(...offsetCandidates),
      }
    : undefined;

  const minRequiredSeq = seqCandidates.length > 0
    ? seqCandidates.reduce((currentMax, candidate) => {
        return BigInt(candidate) > BigInt(currentMax) ? candidate : currentMax;
      }).toString()
    : undefined;

  // FINDING 5 FIX: Derive timezoneOffsetMinutes from merged offset data.
  // Previously took first.timezoneOffsetMinutes blindly — if first payload
  // lacked a TZ (undefined), handlers defaulted to UTC (0) even when other
  // payloads had valid offsets. Now:
  //   1. When merged offsetRange is single-valued, use that authoritative value.
  //   2. Otherwise, use the first non-undefined scalar TZ from any payload.
  //   3. If none exist, leave undefined (handlers default to UTC correctly).
  const coalescedTimezoneOffset: number | undefined =
    (offsetRange != null && offsetRange.min === offsetRange.max)
      ? offsetRange.min
      : payloads.find(p => p.timezoneOffsetMinutes != null)?.timezoneOffsetMinutes;

  return {
    userId,
    requestId: `coalesced-${payloads.length}`,
    correlationId: first.correlationId,
    deviceId,
    sampleCount,
    deletedCount,
    hasDeletions,
    metricCodes: Array.from(metricCodes).sort(),
    affectedLocalDates: Array.from(affectedLocalDates).sort(),
    rangeStartMs,
    rangeEndMs,
    timezoneOffsetMinutes: coalescedTimezoneOffset,
    timezoneExplicit,
    offsetRange,
    minRequiredSeq,
  };
}
