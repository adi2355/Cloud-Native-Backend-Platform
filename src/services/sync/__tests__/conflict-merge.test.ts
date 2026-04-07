import { describe, it, expect } from '@jest/globals';
import { tryMergeConflictWithSharedConfig } from '../conflict-merge';

describe('tryMergeConflictWithSharedConfig', () => {
  it('should merge config-driven entities via shared merger', () => {
    const now = '2024-01-01T00:00:00.000Z';
    const server = {
      id: 'goal-1',
      userId: 'user-1',
      currentValue: 10,
      version: 2,
      updatedAt: '2023-12-31T00:00:00.000Z',
    };
    const local = {
      id: 'goal-1',
      userId: 'user-1',
      currentValue: 5,
      version: 1,
      updatedAt: '2023-12-30T00:00:00.000Z',
    };

    const result = tryMergeConflictWithSharedConfig('goals', server, local, now);
    expect(result).not.toBeNull();
    expect(result?.canonicalType).toBe('goals');
    expect(result?.data.currentValue).toBe(10);
    expect(result?.data.version).toBe(3);
    expect(result?.data.updatedAt).toBe(now);
  });

  it('should return null for entities requiring custom merge', () => {
    const result = tryMergeConflictWithSharedConfig(
      'sessions',
      { id: 's1', userId: 'u1' },
      { id: 's1', userId: 'u1' },
      '2024-01-01T00:00:00.000Z'
    );
    expect(result).toBeNull();
  });

  it('should return null for unknown entity types', () => {
    const result = tryMergeConflictWithSharedConfig(
      'unknown_entity',
      { id: 'x' },
      { id: 'x' },
      '2024-01-01T00:00:00.000Z'
    );
    expect(result).toBeNull();
  });
});
