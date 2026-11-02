import { describe, expect, it } from 'vitest';
import { createBuiltinTools } from '@momonga/tools';

const locationsOf = (name: string, input: unknown): { path: string }[] | undefined => {
  const tool = createBuiltinTools().find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool.locations?.(input);
};

describe('recorded locations of the search and shell tools', () => {
  it('records the directory or file a Grep searched, and the working directory when it has no path', () => {
    expect(locationsOf('Grep', { pattern: 'x', path: '/work/secrets' })).toEqual([{ path: '/work/secrets' }]);
    expect(locationsOf('Grep', { pattern: 'x' })).toEqual([{ path: '.' }]);
  });

  it('records the directory a Glob searched, and the working directory when it has no path', () => {
    expect(locationsOf('Glob', { pattern: '**/*.ts', path: '/work/src' })).toEqual([{ path: '/work/src' }]);
    expect(locationsOf('Glob', { pattern: '**/*.ts' })).toEqual([{ path: '.' }]);
  });

  it('records the read targets of a Bash command that the permission analysis computes', () => {
    expect(locationsOf('Bash', { command: 'cat secrets/prod.env' })).toEqual([{ path: 'secrets/prod.env' }]);
    expect(locationsOf('Bash', { command: 'cat /etc/hosts | head -1' })).toEqual([{ path: '/etc/hosts' }]);
  });

  it('records no path for a command whose targets are dynamic', () => {
    expect(locationsOf('Bash', { command: 'cat "$TARGET"' })).toEqual([]);
  });
});
