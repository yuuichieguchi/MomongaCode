import { describe, expect, it } from 'vitest';
import type { GoverningFactView, MemoryView } from '@momonga/protocol';
import { formatGovernanceVerification, formatRuleAdded, formatRuleHistory, formatRuleList } from '../src/rule/format.ts';
import { formatMemory, formatMemoryList } from '../src/memory/format.ts';
import { DEFAULT_SLASH_COMMANDS } from '../src/tui/commands/index.ts';
import { createSlashRegistry } from '../src/tui/slash.ts';
import type { SlashContext } from '../src/tui/slash.ts';
import { fakeBackend } from './fake-backend.ts';

const fact = (id: string, overrides: Partial<GoverningFactView> = {}): GoverningFactView => ({
  id,
  kind: 'constraint',
  target: 'pandas',
  text: `text of ${id}`,
  scope: { level: 'user' },
  validFrom: 0,
  validUntil: null,
  retiredAt: null,
  supersedes: [],
  enforcement: null,
  source: { kind: 'command', at: 0 },
  ...overrides,
});

const ENFORCED = fact('g1', { enforcement: { behavior: 'deny', rule: 'Bash(rm:*)' } });

const MEMORY: MemoryView = {
  id: 'mem-1',
  scope: 'user',
  origin: 'trusted',
  project: null,
  text: 'note',
  source: { kind: 'tool', sessionId: 's', runId: 'r', step: 1, callId: 'c', seq: 1 },
  createdAt: 0,
  lastUsedAt: 0,
  kind: 'fact',
  state: 'active',
  duplicateOf: null,
  supersedes: [],
  supersededBy: [],
  retiredAt: null,
  evidence: [],
  contributedAt: null,
  status: 'stale',
};

describe('rule formats', () => {
  it('shows enforced versus text-only per fact', () => {
    const lines = formatRuleList([ENFORCED, fact('g2')]).split('\n');
    expect(lines[0]).toContain('g1');
    expect(lines[0]).toContain('enforced: deny Bash(rm:*)');
    expect(lines[1]).toContain('g2');
    expect(lines[1]).toContain('text-only');
  });

  it('says when there are no rules', () => {
    expect(formatRuleList([])).toBe('no rules');
  });

  it('reports the size against each window and repeats warnings', () => {
    const text = formatRuleAdded({ fact: fact('g1'), size: [{ target: 'small', contextWindow: 1000, tokens: 100, percent: 10 }], warnings: ['overlaps g9'] });
    expect(text).toContain('added rule g1');
    expect(text).toContain('100 tokens, 10% of the 1000-token window of small');
    expect(text).toContain('warning: overlaps g9');
  });

  it('shows validity and retirement in the history', () => {
    const text = formatRuleHistory([fact('g1', { retiredAt: 86_400_000 }), fact('g2', { supersedes: ['g1'] })]);
    expect(text).toContain('retired 1970-01-02T00:00:00.000Z');
    expect(text).toContain('supersedes g1');
  });

  it('says per fact when a fact is text-only in policy verify', () => {
    const text = formatGovernanceVerification({ rules: [{ id: 'g1', behavior: 'deny', rule: 'Bash(rm:*)' }], textOnly: [fact('g2')] }, true);
    expect(text).toContain('g1: verified as deny Bash(rm:*)');
    expect(text).toContain('g2: text-only, no guarantee');
  });
});

describe('memory formats', () => {
  it('shows the status in the list and in show', () => {
    expect(formatMemoryList([MEMORY])).toContain('stale');
    expect(formatMemory(MEMORY)).toContain('status: stale');
  });

  it('says that a person added a memory, and when', () => {
    expect(formatMemory({ ...MEMORY, source: { kind: 'command', at: 86_400_000 } })).toContain('source: added by a person with momonga memory add at 1970-01-02T00:00:00.000Z');
  });
});

describe('/rule', () => {
  const contextWith = () => {
    const infos: string[] = [];
    const calls: string[] = [];
    const backend = {
      ...fakeBackend(),
      rules: async () => [ENFORCED],
      addRule: async (input: { text: string; target: string }) => {
        calls.push(`add:${input.target}:${input.text}`);
        return { fact: fact('g3'), size: [], warnings: [] };
      },
      retireRule: async (id: string) => {
        calls.push(`retire:${id}`);
        return fact(id, { retiredAt: 1 });
      },
      ruleHistory: async () => [ENFORCED],
    };
    const context = { backend, info: (text: string) => void infos.push(text) } as unknown as SlashContext;
    return { context, infos, calls };
  };
  const rule = createSlashRegistry(DEFAULT_SLASH_COMMANDS).find('rule');

  it('lists by default', async () => {
    const { context, infos } = contextWith();
    await rule?.run('', context);
    expect(infos.at(-1)).toContain('enforced: deny Bash(rm:*)');
  });

  it('adds with a target and the rest as text', async () => {
    const { context, infos, calls } = contextWith();
    await rule?.run('add pandas do not use pandas', context);
    expect(calls).toEqual(['add:pandas:do not use pandas']);
    expect(infos.at(-1)).toContain('added rule g3');
  });

  it('retires and shows history', async () => {
    const { context, infos, calls } = contextWith();
    await rule?.run('retire g1', context);
    expect(calls).toEqual(['retire:g1']);
    await rule?.run('history g1', context);
    expect(infos.at(-1)).toContain('g1');
  });

  it('prints its usage for anything else', async () => {
    const { context, infos } = contextWith();
    await rule?.run('forget g1', context);
    expect(infos.at(-1)).toMatch(/^usage: \/rule/);
  });
});
