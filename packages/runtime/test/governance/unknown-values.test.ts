import { describe, expect, it } from 'vitest';
import { resolveGoverning } from '@momonga/memory';
import type { GoverningFactView } from '@momonga/protocol';
import { governanceRulesOf, isEnforced } from '../../src/governance/rules.ts';

const fact = (overrides: Partial<GoverningFactView>): GoverningFactView => ({
  id: 'fact-1',
  kind: 'constraint',
  target: 'shell',
  text: 'never push',
  scope: { level: 'project', project: '/work/a', paths: [] },
  validFrom: 0,
  validUntil: null,
  retiredAt: null,
  supersedes: [],
  enforcement: { behavior: 'ask', rule: 'Bash(git push:*)' },
  source: { kind: 'command', at: 0 },
  ...overrides,
});

describe('governing facts holding a value this build does not know (11.4, safety floors)', () => {
  it('an unknown enforcement behaviour is enforced as deny, never as the weaker ask', () => {
    const enforced = [fact({ enforcement: { behavior: 'unknown', rule: 'Bash(git push:*)' } })].filter(isEnforced);
    const rules = governanceRulesOf(enforced, { home: '/home/u', project: '/work/a' });
    expect(rules.map((rule) => rule.effect)).toEqual(['deny']);
  });

  it('a fact of an unknown scope is applied in no scope', () => {
    const resolved = resolveGoverning([fact({ scope: { level: 'unknown' } })], { now: 1, project: '/work/a', touchedPaths: [], ignorePaths: true });
    expect(resolved.active).toEqual([]);
  });
});
