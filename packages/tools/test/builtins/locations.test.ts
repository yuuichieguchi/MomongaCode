import { describe, expect, it } from 'vitest';
import { createBuiltinTools } from '@momonga/tools';
import { testPaths } from '@momonga/testkit';

const CONTEXT = { cwd: '/work/shell-moved-here', workingDirectory: '/work', home: '/home/me', roots: ['/work'], paths: testPaths() };

const locationsOf = (name: string, input: unknown): { path: string }[] | undefined => {
  const tool = createBuiltinTools().find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool.locations?.(input, CONTEXT);
};

describe('recorded locations of the search and shell tools', () => {
  it('records the absolute directory or file a Grep searched, and the working directory when it has no path', () => {
    expect(locationsOf('Grep', { pattern: 'x', path: '/work/secrets' })).toEqual([{ path: '/work/secrets' }]);
    expect(locationsOf('Grep', { pattern: 'x', path: 'secrets' })).toEqual([{ path: '/work/secrets' }]);
    expect(locationsOf('Grep', { pattern: 'x', path: '.' })).toEqual([{ path: '/work' }]);
    expect(locationsOf('Grep', { pattern: 'x' })).toEqual([{ path: '/work' }]);
  });

  it('records the absolute directory a Glob searched, and the working directory when it has no path', () => {
    expect(locationsOf('Glob', { pattern: '**/*.ts', path: '/work/src' })).toEqual([{ path: '/work/src' }]);
    expect(locationsOf('Glob', { pattern: '**/*.ts', path: 'src' })).toEqual([{ path: '/work/src' }]);
    expect(locationsOf('Glob', { pattern: '**/*.ts', path: '../other' })).toEqual([{ path: '/other' }]);
    expect(locationsOf('Glob', { pattern: '**/*.ts' })).toEqual([{ path: '/work' }]);
  });

  it.each(['Read', 'Write', 'Edit'])('records the absolute file a %s names, resolving a relative one against the working directory', (name) => {
    expect(locationsOf(name, { file_path: 'src/a.ts', content: '', old_string: 'a', new_string: 'b' })).toEqual([{ path: '/work/src/a.ts' }]);
    expect(locationsOf(name, { file_path: '/elsewhere/a.ts', content: '', old_string: 'a', new_string: 'b' })).toEqual([{ path: '/elsewhere/a.ts' }]);
  });

  it('records the read targets of a Bash command as absolute paths, resolving relative ones against the shell directory', () => {
    expect(locationsOf('Bash', { command: 'cat secrets/prod.env' })).toEqual([{ path: '/work/shell-moved-here/secrets/prod.env' }]);
    expect(locationsOf('Bash', { command: 'cat /etc/hosts | head -1' })).toEqual([{ path: '/etc/hosts' }]);
  });

  it('records no path for a command whose targets are dynamic', () => {
    expect(locationsOf('Bash', { command: 'cat "$TARGET"' })).toEqual([]);
  });
});
