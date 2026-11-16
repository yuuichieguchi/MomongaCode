import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDir } from '@momonga/testkit';
import { REUSE_RECORD_FORMAT, createRepoDigests, inputsOf, isReplayable, recordFor, replayedLine, testReuseModeOf } from './support/test-reuse.ts';
import type { ReuseGlobals } from './support/test-reuse.ts';

const GLOBALS: ReuseGlobals = { node: 'v24.0.0', platform: 'darwin', arch: 'arm64', harness: { 'package-lock.json': 'lock' }, env: {} };

const digestsOf = (files: Record<string, string>) => ({
  digestOf: (file: string): string => (file in files ? `file:${files[file]}` : 'absent'),
  treeDigest: (): string => JSON.stringify(files),
});

describe('the reuse mode of a test run', () => {
  it('replays only under MOMONGA_TEST_REUSE=1, never when it is 0 or unset, and refuses another value', () => {
    expect(testReuseModeOf({ MOMONGA_TEST_REUSE: '1' })).toBe('on');
    expect(testReuseModeOf({ MOMONGA_TEST_REUSE: '0' })).toBe('off');
    expect(testReuseModeOf({})).toBe('off');
    expect(() => testReuseModeOf({ MOMONGA_TEST_REUSE: 'yes' })).toThrow(/MOMONGA_TEST_REUSE/);
  });

  it('npm test never replays and npm run test:reuse does', () => {
    const scripts = (JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    expect(scripts['test']).toMatch(/(^| )MOMONGA_TEST_REUSE=0 /);
    expect(scripts['test:reuse']).toMatch(/(^| )MOMONGA_TEST_REUSE=1 /);
  });
});

describe('the record of a green test file', () => {
  const files = { 'test/a.test.ts': '1', 'src/a.ts': '2', 'src/b.ts': '3' };

  it('is replayed while every input it observed is unchanged', () => {
    const record = recordFor({ project: 'unit', file: 'test/a.test.ts', inputs: ['test/a.test.ts', 'src/a.ts'], whole: false }, digestsOf(files), GLOBALS);
    expect(record.format).toBe(REUSE_RECORD_FORMAT);
    expect(isReplayable(record, digestsOf(files), GLOBALS)).toBe(true);
    expect(isReplayable(record, digestsOf({ ...files, 'src/b.ts': 'changed' }), GLOBALS)).toBe(true);
  });

  it('is not replayed when one input changed, or when an input that was absent appeared', () => {
    const record = recordFor({ project: 'unit', file: 'test/a.test.ts', inputs: ['test/a.test.ts', 'src/a.ts', 'src/missing.json'], whole: false }, digestsOf(files), GLOBALS);
    expect(isReplayable(record, digestsOf({ ...files, 'src/a.ts': 'changed' }), GLOBALS)).toBe(false);
    expect(isReplayable(record, digestsOf({ ...files, 'src/missing.json': 'new' }), GLOBALS)).toBe(false);
  });

  it('of a file that started a child process is replayed only while no tracked file of the repository changed', () => {
    const record = recordFor({ project: 'e2e', file: 'test/a.test.ts', inputs: ['test/a.test.ts'], whole: true }, digestsOf(files), GLOBALS);
    expect(isReplayable(record, digestsOf(files), GLOBALS)).toBe(true);
    expect(isReplayable(record, digestsOf({ ...files, 'src/b.ts': 'changed' }), GLOBALS)).toBe(false);
  });

  it('is not replayed under another Node version, lockfile, harness file or MOMONGA_ variable', () => {
    const record = recordFor({ project: 'unit', file: 'test/a.test.ts', inputs: ['test/a.test.ts'], whole: false }, digestsOf(files), GLOBALS);
    expect(isReplayable(record, digestsOf(files), { ...GLOBALS, node: 'v25.0.0' })).toBe(false);
    expect(isReplayable(record, digestsOf(files), { ...GLOBALS, harness: { 'package-lock.json': 'other' } })).toBe(false);
    expect(isReplayable(record, digestsOf(files), { ...GLOBALS, env: { MOMONGA_TLC_TIER: 'deep' } })).toBe(false);
  });

  it('is not replayed for a file of another project or another path', () => {
    const record = recordFor({ project: 'unit', file: 'test/a.test.ts', inputs: ['test/a.test.ts'], whole: false }, digestsOf(files), GLOBALS);
    expect(isReplayable({ ...record, project: 'e2e' }, digestsOf(files), GLOBALS)).toBe(false);
    expect(isReplayable({ ...record, file: 'test/b.test.ts' }, digestsOf(files), GLOBALS)).toBe(false);
  });
});

describe('the inputs a test file observed', () => {
  it('are the repository files it imported or read, as repository paths, without node_modules, the reuse store and paths outside the repository', () => {
    const root = path.join(path.sep, 'repo');
    expect(
      inputsOf(root, [
        path.join(root, 'test', 'a.test.ts'),
        path.join(root, 'packages', 'x', 'src', 'a.ts'),
        path.join(root, 'node_modules', 'vitest', 'index.js'),
        path.join(root, '.cache', 'test-reuse', 'unit', 'r.json'),
        path.join(path.sep, 'tmp', 'scratch'),
        path.join(root, 'test', 'a.test.ts'),
        root,
      ]),
    ).toEqual(['', 'packages/x/src/a.ts', 'test/a.test.ts']);
  });
});

describe('the digests of the repository', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('tell a file by its content, a directory by its listing and an absent path apart', () => {
    const root = createTempDir();
    made.push(root);
    fs.writeFileSync(path.join(root, 'a.txt'), 'one');
    fs.mkdirSync(path.join(root, 'dir'));
    fs.writeFileSync(path.join(root, 'dir', 'b.txt'), 'two');
    const before = createRepoDigests(root, ['a.txt', 'dir/b.txt']);
    const file = before.digestOf('a.txt');
    const listing = before.digestOf('dir');
    expect(before.digestOf('missing')).toBe('absent');
    fs.writeFileSync(path.join(root, 'a.txt'), 'changed');
    fs.writeFileSync(path.join(root, 'dir', 'c.txt'), 'three');
    const after = createRepoDigests(root, ['a.txt', 'dir/b.txt']);
    expect(after.digestOf('a.txt')).not.toBe(file);
    expect(after.digestOf('dir')).not.toBe(listing);
    expect(after.treeDigest()).not.toBe(before.treeDigest());
  });
});

describe('the line of replayed files', () => {
  it('counts the files the run replayed', () => {
    expect(replayedLine(12)).toBe('Replayed 12 test files, unchanged since their last green run on this machine');
  });
});
