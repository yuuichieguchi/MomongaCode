import { describe, expect, it } from 'vitest';
import { suggestAllowRule } from '@momonga/policy';
import type { PolicyTool } from '@momonga/policy';

const MEMORY_SAVE: PolicyTool = { name: 'MemorySave', kind: 'other', sideEffect: 'write' };

describe('memory subjects', () => {
  it('suggests no allow rule, because a bare tool rule would let injected saves in every scope pass silently', () => {
    const canonicalise = () => {
      throw new Error('a memory subject names no path');
    };
    expect(suggestAllowRule(MEMORY_SAVE, { kind: 'memory', tool: 'MemorySave', scope: 'user', text: 'a note', memoryKind: 'fact', paths: [], supersedes: [] }, '/work', canonicalise)).toBeUndefined();
    expect(suggestAllowRule(MEMORY_SAVE, { kind: 'memory', tool: 'MemorySave', scope: 'project', text: 'a note', memoryKind: 'fact', paths: [], supersedes: [] }, '/work', canonicalise)).toBeUndefined();
  });
});
