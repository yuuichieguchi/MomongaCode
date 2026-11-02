import { describe, expect, it } from 'vitest';
import { suggestAllowRule } from '@momonga/policy';
import type { PolicyTool } from '@momonga/policy';

const MEMORY_SAVE: PolicyTool = { name: 'MemorySave', kind: 'other', sideEffect: 'write' };

describe('memory subjects', () => {
  it('suggests the tool name as the allow rule, so one rule covers both scopes', () => {
    const canonicalise = () => {
      throw new Error('a memory subject names no path');
    };
    expect(suggestAllowRule(MEMORY_SAVE, { kind: 'memory', tool: 'MemorySave', scope: 'user' }, '/work', canonicalise)).toBe('MemorySave');
    expect(suggestAllowRule(MEMORY_SAVE, { kind: 'memory', tool: 'MemorySave', scope: 'project' }, '/work', canonicalise)).toBe('MemorySave');
  });
});
