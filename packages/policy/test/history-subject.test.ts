import { testSecretLocations } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import { decide, suggestAllowRule } from '@momonga/policy';
import type { PermissionRule, PermissionSubject, PolicyTool } from '@momonga/policy';
import type { PermissionMode } from '@momonga/protocol';
import { EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { TEST_SEARCH_PATH, fakeFs, fileRulesFor, makeLayout, ruleIn } from './helpers.ts';

const HISTORY_SEARCH: PolicyTool = { name: 'HistorySearch', kind: 'search', sideEffect: 'read_only' };

const SUBJECT = { kind: 'history', tool: 'HistorySearch', project: '/work/other' } as PermissionSubject;

const decideHistory = async (mode: PermissionMode, rules: PermissionRule[] = [], subject: PermissionSubject = SUBJECT) => {
  const layout = makeLayout();
  return decide({ secretLocations: testSecretLocations(layout.home),
    tool: HISTORY_SEARCH,
    subject,
    mode,
    rules,
    roots: [layout.project],
    home: layout.home,
    cwd: layout.project,
    fileRules: await fileRulesFor(rules, [layout.project]),
    protectedSet: EMPTY_PROTECTED_SET,
    fs: fakeFs(),
    searchPath: TEST_SEARCH_PATH,
    isWritable: () => true,
  });
};

describe('history subjects', () => {
  it.each(['manual', 'acceptEdits', 'plan'] as const)('asks before reaching another project in %s mode', async (mode) => {
    const decision = await decideHistory(mode);
    expect((await decision).kind).toBe('ask');
    expect((await decision).source).toBe('mode');
    expect((await decision).reason).toContain('/work/other');
  });

  it('lets bypassPermissions through, as for every subject not explicitly denied', async () => {
    expect((await decideHistory('bypassPermissions')).kind).toBe('allow');
  });

  it('honours a deny rule on the tool in every mode', async () => {
    const rule = ruleIn(makeLayout())('deny', 'HistorySearch');
    expect((await decideHistory('bypassPermissions', [rule])).kind).toBe('deny');
  });

  it('asks nothing for a search within the project', async () => {
    expect((await decideHistory('manual', [], { kind: 'none', tool: 'HistorySearch' })).kind).toBe('allow');
  });

  it('suggests no allow rule, because a bare tool rule would open every project', async () => {
    const canonicalise = () => {
      throw new Error('a history subject names no path');
    };
    expect(await suggestAllowRule(HISTORY_SEARCH, SUBJECT, '/work', canonicalise)).toBeUndefined();
  });
});
