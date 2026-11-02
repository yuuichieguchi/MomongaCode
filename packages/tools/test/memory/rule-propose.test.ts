import { describe, expect, it } from 'vitest';
import { RULE_PROPOSE_TOOL_NAME, createGovernanceTools, createMemoryTools, subjectDigestOf } from '@momonga/tools';
import type { AnyTool, GovernancePort, MemoryStorePort, RuleProposalInput } from '@momonga/tools';

const INPUT: RuleProposalInput = { kind: 'constraint', target: 'pandas', text: 'do not use pandas', scope: 'project', paths: ['src/**'], enforcement: { behavior: 'deny', rule: 'Bash(pip install pandas)' }, supersedes: [] };

const CTX = { cwd: '/work/a', home: '/home/u', roots: ['/work/a'] };

const canonicalise = (absolute: string) => ({ ok: true as const, path: absolute });

const fakePort = (added: { runId: string; callId: string; factId: string }[] = []) => {
  const proposed: unknown[] = [];
  const port: GovernancePort = {
    propose: (request) => {
      proposed.push(request);
      return { factId: 'g1', created: proposed.length === 1 };
    },
    find: (runId, callId) => {
      const found = added.find((entry) => entry.runId === runId && entry.callId === callId);
      return found === undefined ? undefined : { factId: found.factId };
    },
  };
  return { port, proposed };
};

const tool = (trusted = true): AnyTool => {
  const [found] = createGovernanceTools({ port: fakePort().port, trusted });
  if (found === undefined) throw new Error('RulePropose was not offered');
  return found;
};

const digestOf = (input: RuleProposalInput): string => subjectDigestOf(tool().subject(input as never, CTX), '/work/a', canonicalise);

describe('RulePropose', () => {
  it('is offered in a trusted folder and not in an untrusted one', () => {
    expect(createGovernanceTools({ port: fakePort().port, trusted: true }).map((entry) => entry.name)).toEqual([RULE_PROPOSE_TOOL_NAME]);
    expect(createGovernanceTools({ port: fakePort().port, trusted: false })).toEqual([]);
  });

  describe('reconcile after a crash between the store commit and the recorded result', () => {
    const reconcileWith = async (added: { runId: string; callId: string; factId: string }[]) => {
      const [found] = createGovernanceTools({ port: fakePort(added).port, trusted: true });
      if (found?.reconcile === undefined) throw new Error('RulePropose has no reconcile');
      return found.reconcile(INPUT as never, {} as never, { runId: 'r1', callId: 'c1' } as never);
    };

    it('reports the rule as applied when the store holds a fact of this run and call', async () => {
      await expect(reconcileWith([{ runId: 'r1', callId: 'c1', factId: 'g9' }])).resolves.toEqual({ outcome: 'already_applied', output: 'Rule g9 was already added.' });
    });

    it('reports the rule as not applied when the store holds none, and for another call', async () => {
      await expect(reconcileWith([])).resolves.toEqual({ outcome: 'not_applied', output: '' });
      await expect(reconcileWith([{ runId: 'r1', callId: 'other', factId: 'g9' }])).resolves.toEqual({ outcome: 'not_applied', output: '' });
    });
  });

  it('has a governance subject', () => {
    expect(tool().subject(INPUT as never, CTX)).toMatchObject({ kind: 'governance', tool: RULE_PROPOSE_TOOL_NAME, target: 'pandas', text: INPUT.text });
  });

  it('shows the full text, target, scope and enforcement in the question', () => {
    const longText = `${'never call the production database directly '.repeat(20)}end-of-text`;
    const title = tool().title({ ...INPUT, text: longText } as never);
    expect(title).toContain(longText);
    expect(title).toContain('pandas');
    expect(title).toContain('src/**');
    expect(title).toContain('deny');
    expect(title).toContain('Bash(pip install pandas)');
  });

  it.each<[string, Partial<RuleProposalInput>]>([
    ['text', { text: 'do not use numpy' }],
    ['target', { target: 'numpy' }],
    ['scope', { scope: 'user', paths: [] }],
    ['paths', { paths: ['lib/**'] }],
    ['enforcement behavior', { enforcement: { behavior: 'ask', rule: 'Bash(pip install pandas)' } }],
    ['enforcement rule', { enforcement: { behavior: 'deny', rule: 'Bash(pip:*)' } }],
    ['no enforcement', { enforcement: null }],
  ])('changes the digest when %s changes, so an approval cannot apply', (_name, change) => {
    expect(digestOf({ ...INPUT, ...change })).not.toBe(digestOf(INPUT));
  });

  it('gives the same digest for the same content', () => {
    expect(digestOf({ ...INPUT })).toBe(digestOf(INPUT));
  });

  it('records the call as the source when it runs, and says so again on a replay', async () => {
    const { port, proposed } = fakePort();
    const [propose] = createGovernanceTools({ port, trusted: true });
    const ctx = { runId: 'r1', step: 2, callId: 'c1' } as never;
    const first = await propose?.execute(INPUT as never, ctx, undefined);
    const second = await propose?.execute(INPUT as never, ctx, undefined);
    expect(proposed[0]).toMatchObject({ runId: 'r1', callId: 'c1', target: 'pandas' });
    expect(first).toMatchObject({ status: 'completed', output: 'Added rule g1.' });
    expect(second).toMatchObject({ status: 'completed', output: 'Rule g1 was already added.' });
  });
});

describe('MemorySave input', () => {
  const port: MemoryStorePort = {
    save: () => {
      throw new Error('not reached');
    },
    search: () => [],
  };
  const [save, search] = createMemoryTools({ port, trusted: true });

  it('accepts kind, paths and supersedes, and no hash from the model', () => {
    const properties = (save?.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties).sort()).toEqual(['kind', 'paths', 'scope', 'supersedes', 'text']);
  });

  it('asks for self-contained text with absolute dates', () => {
    expect(save?.description).toMatch(/self-contained/);
    expect(save?.description).toMatch(/absolute dates/);
  });

  it('lets MemorySearch ask for all memories', () => {
    const properties = (search?.inputSchema as { properties: Record<string, { enum?: unknown }> }).properties;
    expect(properties['include']?.enum).toEqual(['live', 'all']);
  });
});
