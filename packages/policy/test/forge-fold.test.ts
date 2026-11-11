import { describe, expect, it } from 'vitest';
import { matchPathlessRule } from '@momonga/policy';
import type { PermissionSubject } from '@momonga/policy';
import { makeLayout, ruleIn } from './helpers.ts';

type ForgeSubject = Extract<PermissionSubject, { kind: 'forge' }>;

const create = (host: string, repo: string): ForgeSubject => ({ kind: 'forge', tool: 'PullRequestCreate', operation: 'PullRequestCreate', host, repo, approval: 'rule' });

const SPELLINGS = [
  ['github.com', 'acme/app'],
  ['github.com', 'Acme/App'],
  ['GitHub.com', 'Acme/App'],
  ['GITHUB.COM', 'ACME/APP'],
] as const;

describe('a rule on a forge subject', () => {
  it.each(['deny', 'ask'] as const)('a %s rule matches every case spelling of the host and the repository', (effect) => {
    const rule = ruleIn(makeLayout())(effect, 'PullRequestCreate(github.com:acme/app)');

    expect(SPELLINGS.map(([host, repo]) => matchPathlessRule(rule, create(host, repo)))).toEqual([true, true, true, true]);
  });

  it.each(['deny', 'ask'] as const)('a %s rule written in another case matches the lower-case spelling', (effect) => {
    const rule = ruleIn(makeLayout())(effect, 'PullRequestCreate(GitHub.com:Acme/*)');

    expect(matchPathlessRule(rule, create('github.com', 'acme/app'))).toBe(true);
    expect(matchPathlessRule(rule, create('github.com', 'other/app'))).toBe(false);
  });

  it('an allow rule matches only the spelling it was written in', () => {
    const rule = ruleIn(makeLayout())('allow', 'PullRequestCreate(github.com:acme/app)');

    expect(SPELLINGS.map(([host, repo]) => matchPathlessRule(rule, create(host, repo)))).toEqual([true, false, false, false]);
  });
});
