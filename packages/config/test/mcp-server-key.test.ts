import { describe, expect, it } from 'vitest';
import * as config from '@momonga/config';
import { mcpServerNameProblem } from '../src/mcp-server-rules.ts';

type KeyOf = (label: string, taken: ReadonlySet<string>) => { kind: 'key'; key: string } | { kind: 'refused'; reason: string };

const serverKeyOfLabel: KeyOf = (label, taken) => {
  const derive = (config as Record<string, unknown>)['serverKeyOfLabel'];
  if (typeof derive !== 'function') throw new Error('@momonga/config does not export serverKeyOfLabel');
  return (derive as KeyOf)(label, taken);
};

const keyOf = (label: string, taken: readonly string[] = []): string => {
  const derived = serverKeyOfLabel(label, new Set(taken));
  if (derived.kind !== 'key') throw new Error(derived.reason);
  return derived.key;
};

describe('serverKeyOfLabel: a server label from an external protocol becomes a server key by one rule (config-C28)', () => {
  it.each([
    ['Sequential Thinking', 'sequential-thinking'],
    ['brave.search', 'brave-search'],
    ['@scope/server', 'scope-server'],
    ['files', 'files'],
    ['My__Tool_', 'my_tool'],
    ['  Git  Hub  ', 'git-hub'],
  ])('%j becomes %j, a name the server name rule accepts', (label, key) => {
    expect(keyOf(label)).toBe(key);
    expect(mcpServerNameProblem(key)).toBeUndefined();
  });

  it('two labels that derive the same key get distinct keys', () => {
    expect(keyOf('Brave Search', ['brave-search'])).toBe('brave-search-2');
    expect(keyOf('brave_search', [])).toBe('brave_search');
    expect(keyOf('brave.search', ['brave-search', 'brave-search-2'])).toBe('brave-search-3');
  });

  it.each(['', '   ', '@/.'])('a label %j with no letter or digit is refused naming it', (label) => {
    expect(serverKeyOfLabel(label, new Set())).toEqual({ kind: 'refused', reason: `the MCP server ${JSON.stringify(label)} has no letter or digit to make a server name from; give it a name with one` });
  });
});
