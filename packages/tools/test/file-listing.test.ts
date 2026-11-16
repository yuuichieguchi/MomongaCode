import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from '@momonga/testkit/child-process';
import { createTempDir, testHostPath, TEST_UNPROTECTED_LAUNCH } from '@momonga/testkit';
import { listDirectoryEntries, listFileCandidates } from '@momonga/tools';

const TEST_LAUNCH = TEST_UNPROTECTED_LAUNCH;

const made: string[] = [];

afterEach(() => {
  for (const directory of made.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const treeOf = (files: Readonly<Record<string, string>>): string => {
  const root = createTempDir();
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
    const listed = await listFileCandidates({ root, env: NO_PROGRAMS, trusted: true, signal: never }, TEST_LAUNCH);
    expect(listed.truncated).toBe(false);
    expect(listed.entries.toSorted()).toEqual(['.hidden', 'a.txt', 'src/b.ts', 'src/deep/c.ts']);
  });

  it('stops at the entry limit', async () => {
    const root = treeOf({ 'a.txt': '', 'b.txt': '', 'c.txt': '' });
    const listed = await listFileCandidates({ root, env: NO_PROGRAMS, trusted: true, signal: never, limit: 2 }, TEST_LAUNCH);
    expect(listed.truncated).toBe(true);
    expect(listed.entries).toHaveLength(2);
  });

  it('lists the entries of one directory with a trailing slash on directories', async () => {
    const root = treeOf({ 'a.txt': '', 'src/b.ts': '' });
    expect(await listDirectoryEntries({ root, env: NO_PROGRAMS, trusted: true, signal: never }, TEST_LAUNCH)).toEqual(['a.txt', 'src/']);
  });
});

describe('the candidate list inside a git work tree', () => {
  const env = { PATH: testHostPath(process.env['PATH']) };

  it('leaves out what .gitignore names and keeps untracked files', async () => {
    const root = treeOf({ '.gitignore': 'ignored.txt\nbuild/\n', 'kept.txt': '', 'ignored.txt': '', 'build/out.js': '', 'src/new.ts': '' });
    execFileSync('git', ['init', '--quiet', root], { env });
    const listed = await listFileCandidates({ root, env, trusted: true, signal: never }, TEST_LAUNCH);
    expect(listed.entries.toSorted()).toEqual(['.gitignore', 'kept.txt', 'src/new.ts']);
    expect(await listDirectoryEntries({ root, env, trusted: true, signal: never }, TEST_LAUNCH)).toEqual(['.gitignore', 'kept.txt', 'src/']);
  });

  it('stops at the entry limit', async () => {
    const root = treeOf({ 'a.txt': '', 'b.txt': '', 'c.txt': '' });
    execFileSync('git', ['init', '--quiet', root], { env });
    const listed = await listFileCandidates({ root, env, trusted: true, signal: never, limit: 2 }, TEST_LAUNCH);
    expect(listed).toEqual({ entries: expect.any(Array), truncated: true });
    expect(listed.entries).toHaveLength(2);
  });
});

describe('the git call of the candidate list', () => {
  const recordingGit = (): { env: Record<string, string>; log: string } => {
    const bin = treeOf({});
    const log = path.join(bin, 'calls.log');
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\n/usr/bin/env > ${JSON.stringify(log)}\nprintf 'listed.txt\\0'\n`, { mode: 0o755 });
    return { env: { PATH: bin, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: '/planted', GIT_DIR: '/elsewhere' }, log };
  };

  const settingsOf = (log: string): Map<string, string> => {
    const variables = new Map(
      fs
        .readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line.includes('='))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as const),
    );
    const count = Number(variables.get('GIT_CONFIG_COUNT'));
    const settings = new Map<string, string>();
    for (let index = 0; index < count; index += 1) settings.set(variables.get(`GIT_CONFIG_KEY_${index}`) as string, variables.get(`GIT_CONFIG_VALUE_${index}`) as string);
    for (const name of ['GIT_OPTIONAL_LOCKS', 'GIT_DIR']) {
      const value = variables.get(name);
      if (value !== undefined) settings.set(name, value);
    }
    return settings;
  };

  it.skipIf(process.platform === 'win32')('carries the hardened settings in a trusted folder', async () => {
    const root = treeOf({ 'a.txt': '' });
    const git = recordingGit();
    const listed = await listFileCandidates({ root, env: git.env, trusted: true, signal: never }, TEST_LAUNCH);
    expect(listed.entries).toEqual(['listed.txt']);
    const settings = settingsOf(git.log);
    expect(settings.get('core.fsmonitor')).toBe('false');
    expect(settings.get('core.hooksPath')).toBe('/dev/null');
    expect(settings.get('GIT_OPTIONAL_LOCKS')).toBe('0');
    expect(settings.has('GIT_DIR')).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('does not start git in an untrusted folder and walks the directory', async () => {
    const root = treeOf({ 'a.txt': '', 'src/b.ts': '' });
    const git = recordingGit();
    const listed = await listFileCandidates({ root, env: git.env, trusted: false, signal: never }, TEST_LAUNCH);
    expect(listed.entries.toSorted()).toEqual(['a.txt', 'src/b.ts']);
    expect(await listDirectoryEntries({ root, env: git.env, trusted: false, signal: never }, TEST_LAUNCH)).toEqual(['a.txt', 'src/']);
    expect(fs.existsSync(git.log)).toBe(false);
  });
});
