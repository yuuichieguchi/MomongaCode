import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from '@momonga/testkit/child-process';
import { testHostPath } from '@momonga/testkit';
import { directoryEntriesOf, listDirectoryEntries, listFileCandidates } from '@momonga/foundation';

const made: string[] = [];

afterEach(() => {
  for (const directory of made.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const treeOf = (files: Readonly<Record<string, string>>): string => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'momonga-candidates-')));
  made.push(root);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  return root;
};

const NO_PROGRAMS = { PATH: '' };
const never = new AbortController().signal;

describe('the candidate list of a directory that is not a git work tree', () => {
  it('walks the directory and lists every file with its path from the root', async () => {
    const root = treeOf({ 'a.txt': '', 'src/b.ts': '', 'src/deep/c.ts': '', '.hidden': '' });
    const listed = await listFileCandidates({ root, env: NO_PROGRAMS, signal: never });
    expect(listed.truncated).toBe(false);
    expect(listed.entries.toSorted()).toEqual(['.hidden', 'a.txt', 'src/b.ts', 'src/deep/c.ts']);
  });

  it('stops at the entry limit', async () => {
    const root = treeOf({ 'a.txt': '', 'b.txt': '', 'c.txt': '' });
    const listed = await listFileCandidates({ root, env: NO_PROGRAMS, signal: never, limit: 2 });
    expect(listed.truncated).toBe(true);
    expect(listed.entries).toHaveLength(2);
  });

  it('lists the entries of one directory with a trailing slash on directories', async () => {
    const root = treeOf({ 'a.txt': '', 'src/b.ts': '' });
    expect(await listDirectoryEntries({ root, env: NO_PROGRAMS, signal: never })).toEqual(['a.txt', 'src/']);
  });
});

describe('the candidate list inside a git work tree', () => {
  const env = { PATH: testHostPath(process.env['PATH']) };

  it('leaves out what .gitignore names and keeps untracked files', async () => {
    const root = treeOf({ '.gitignore': 'ignored.txt\nbuild/\n', 'kept.txt': '', 'ignored.txt': '', 'build/out.js': '', 'src/new.ts': '' });
    execFileSync('git', ['init', '--quiet', root], { env });
    const listed = await listFileCandidates({ root, env, signal: never });
    expect(listed.entries.toSorted()).toEqual(['.gitignore', 'kept.txt', 'src/new.ts']);
    expect(await listDirectoryEntries({ root, env, signal: never })).toEqual(['.gitignore', 'kept.txt', 'src/']);
  });

  it('stops at the entry limit', async () => {
    const root = treeOf({ 'a.txt': '', 'b.txt': '', 'c.txt': '' });
    execFileSync('git', ['init', '--quiet', root], { env });
    const listed = await listFileCandidates({ root, env, signal: never, limit: 2 });
    expect(listed).toEqual({ entries: expect.any(Array), truncated: true });
    expect(listed.entries).toHaveLength(2);
  });
});

describe('the entries of a directory from its file list', () => {
  it('reduces each path to its first component', () => {
    expect(directoryEntriesOf(['b.ts', 'lib/x.ts', 'lib/y/z.ts', 'a.ts'])).toEqual(['a.ts', 'b.ts', 'lib/']);
  });
});
