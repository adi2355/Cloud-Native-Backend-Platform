/**
 * Conflict Merge Helper (Backend)
 *
 * PURPOSE: Use the shared, config-driven merge engine for entities that do NOT
 * require custom merge logic. This reduces FE/BE drift and enforces a single
 * merge contract for simple entities.
 *
 * DESIGN:
 * - Pure function (no I/O)
 * - Fail-fast: returns null for unsupported entity types or custom-merge entities
 * - Defensive extraction of version/updatedAt fields
 *
 * @module services/sync/conflict-merge
 */

import {
  createMergeContext,
  mergeEntity,
  requiresCustomMerge,
  tryCanonicalizeEntityType,
  type EntityType,
} from '@shared/contracts';

export interface SharedMergeResult {
  /** Canonical entity type used for shared merge */
  readonly canonicalType: EntityType;
  /** Merged data */
  readonly data: Record<string, unknown>;
}

/**
 * Attempt to merge conflict data using shared config-driven merge.
 *
 * Returns null if:
 * - entityType is not canonicalizable, or
 * - entity requires custom merge logic
 */
export function tryMergeConflictWithSharedConfig(
  entityType: string,
  server: Record<string, unknown>,
  local: Record<string, unknown>,
  nowIso: string
): SharedMergeResult | null {
  const canonicalType = resolveCanonicalEntityType(entityType);
  if (!canonicalType) {
    return null;
  }

  if (requiresCustomMerge(canonicalType)) {
    return null;
  }

  const context = createMergeContext(
    {
      version: getVersion(local),
      updatedAt: getUpdatedAt(local),
    },
    {
      version: getVersion(server),
      updatedAt: getUpdatedAt(server),
    },
    nowIso
  );

  const result = mergeEntity(canonicalType, local, server, context);
  return { canonicalType, data: result.data as Record<string, unknown> };
}

/**
 * Resolve canonical entity type for conflict merge.
 *
 * NOTE: Backend still uses legacy names in some paths (e.g., "journals").
 * This helper maps those to the shared canonical entity types.
 */
function resolveCanonicalEntityType(entityType: string): EntityType | null {
  if (entityType === 'journals') {
    return 'journal_entries';
  }

  return tryCanonicalizeEntityType(entityType);
}

function getVersion(entity: Record<string, unknown>): number | undefined {
  const version = entity.version;
  return typeof version === 'number' && !isNaN(version) ? version : undefined;
}

function getUpdatedAt(entity: Record<string, unknown>): string | undefined {
  const updatedAt = entity.updatedAt ?? entity.updated_at;
  return typeof updatedAt === 'string' ? updatedAt : undefined;
}
