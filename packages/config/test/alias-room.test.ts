import { describe, expect, it } from 'vitest';
import * as config from '@momonga/config';
import { loadSettings } from '@momonga/config';
import { makeTree, trusting, userSettingsPath, writeJson } from './helpers.ts';

type AliasMember = { target: string; outputBounded: boolean; contextWindow: number | undefined; maxOutputTokens: number | undefined; measuring: boolean };
type AliasVerdict = { kind: 'serve' } | { kind: 'wait' } | { kind: 'refuse'; message: string };

const aliasRoomVerdict = (alias: string, members: readonly AliasMember[]): AliasVerdict => {
  const value = (config as Record<string, unknown>)['aliasRoomVerdict'];
  if (value === undefined) throw new Error('@momonga/config does not export aliasRoomVerdict');
  return (value as (alias: string, members: readonly AliasMember[]) => AliasVerdict)(alias, members);
};

const member = (target: string, values: Partial<AliasMember>): AliasMember => ({ target, outputBounded: true, contextWindow: undefined, maxOutputTokens: undefined, measuring: false, ...values });

const unboundedRemote = member('remote', { outputBounded: false, contextWindow: 100_000, maxOutputTokens: 1_000 });

const rAliasText = (alias: string, unbounded: string, other: string): string =>
  `models.aliases.${alias}: target "${unbounded}" has no output bound, and the target "${other}" neither declares nor reports a contextWindow or maxOutputTokens, so the input room of the alias cannot be checked; declare them or remove one of the targets`;

describe('R-ALIAS with declared or measured values (design-managed-servers section 17, item 11)', () => {
  it('serves an alias whose members are all output-bounded, whatever their windows', () => {
    expect(aliasRoomVerdict('default', [member('apple', {}), member('banana', {})])).toEqual({ kind: 'serve' });
  });

  it('serves an alias with an unbounded member once every member value is known and the room is enough', () => {
    expect(aliasRoomVerdict('default', [unboundedRemote, member('apple', { contextWindow: 100_000, maxOutputTokens: 1_000 })])).toEqual({ kind: 'serve' });
  });

  it('makes the alias wait while a member whose values are missing is being measured, so no guessed value is used', () => {
    expect(aliasRoomVerdict('default', [unboundedRemote, member('apple', { measuring: true })])).toEqual({ kind: 'wait' });
  });

  it('refuses with the R-ALIAS text when a member value is still unknown after its probe', () => {
    expect(aliasRoomVerdict('default', [unboundedRemote, member('apple', { contextWindow: 8_192 })])).toEqual({ kind: 'refuse', message: rAliasText('default', 'remote', 'apple') });
  });

  it('refuses a known room that is too small for input, with the existing room check', () => {
    const verdict = aliasRoomVerdict('default', [member('remote', { outputBounded: false, contextWindow: 8_192, maxOutputTokens: 8_000 }), member('apple', { contextWindow: 8_192, maxOutputTokens: 8_000 })]);
    expect(verdict.kind).toBe('refuse');
    expect(verdict.kind === 'refuse' ? verdict.message : '').toContain('models.aliases.default holds a target that carries no output bound');
  });
});

describe('R-ALIAS at load: an alias whose values can be measured is not refused at load', () => {
  it('loads an alias of an unbounded chat-completions target and a managed target that declares no windows', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), {
      models: {
        targets: {
          remote: { adapter: 'chat-completions', provider: 'local', model: 'm', baseUrl: 'https://api.example.com/v1', capabilities: { contextWindow: 100_000, maxOutputTokens: 1_000, outputBoundField: 'none' } },
          apple: { adapter: 'managed', server: 'fm' },
        },
        aliases: { default: ['remote', 'apple'] },
      },
    });
    const { settings } = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(Object.keys(settings.models.targets).sort()).toEqual(['apple', 'remote']);
  });
});
