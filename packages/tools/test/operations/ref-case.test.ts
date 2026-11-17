import { spawnSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeGitWorld } from './support.ts';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createTempDir } from '@momonga/testkit';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const supportsReftable = (): boolean => {
  const base = createTempDir();
  try {
    return spawnSync('git', ['init', '-q', '--bare', '--ref-format=reftable', path.join(base, 'probe.git')], { encoding: 'utf8' }).status === 0;
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
};

type Measured = Record<string, string>;

const measure = (format: 'files' | 'reftable', packed: boolean): Measured => {
  const world = makeGitWorld();
  const bare = path.join(world.base, `case-${format}-${packed}.git`);
  world.git(world.base, 'init', '--bare', '--initial-branch=main', `--ref-format=${format}`, bare);
  world.git(world.work, 'remote', 'set-url', 'origin', `file://${bare}`);
  world.write('a.txt', 'one\n');
  const first = world.commitAll('first');
  world.git(world.work, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  if (packed) world.git(bare, 'pack-refs', '--all');
  world.write('a.txt', 'two\n');
  const second = world.commitAll('second');
  const pushToMain = world.gitStatus(world.work, 'push', '-q', 'origin', 'HEAD:refs/heads/Main');
  const names: Array<[string, string]> = [[first, 'FIRST'], [second, 'SECOND']];
  const named = (text: string): string => names.reduce((result, [sha, label]) => result.split(sha).join(label), text);
  const inBare = (...args: string[]): string => {
    const result = spawnSync('git', ['-C', bare, ...args], { env: world.env, encoding: 'utf8' });
    return result.status === 0 ? named(result.stdout.trim()) : `exit ${result.status}`;
  };
  const refs = (): string => inBare('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads').split('\n').join(' | ');
  const afterPush: Measured = {
    pushToMain: String(pushToMain),
    revParseMain: inBare('rev-parse', 'refs/heads/main'),
    revParseUpperMain: inBare('rev-parse', 'refs/heads/Main'),
    logMain: inBare('log', '-1', '--format=%s', 'main'),
    forEachRef: refs(),
  };
  world.write('a.txt', 'three\n');
  names.push([world.commitAll('third'), 'THIRD']);
  const pushThirdToMain = world.gitStatus(world.work, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  return { ...afterPush, pushThirdToMain: String(pushThirdToMain), revParseMainAfterThird: inBare('rev-parse', 'refs/heads/main'), forEachRefAfterThird: refs() };
};

const EXPECTED_ON_CASE_INSENSITIVE: Record<string, Measured> = {
  'files loose': {
    pushToMain: '1',
    revParseMain: 'FIRST',
    revParseUpperMain: 'FIRST',
    logMain: 'first',
    forEachRef: 'refs/heads/main FIRST',
    pushThirdToMain: '0',
    revParseMainAfterThird: 'THIRD',
    forEachRefAfterThird: 'refs/heads/main THIRD',
  },
  'files packed': {
    pushToMain: '0',
    revParseMain: 'SECOND',
    revParseUpperMain: 'SECOND',
    logMain: 'second',
    forEachRef: 'refs/heads/Main SECOND | refs/heads/main FIRST',
    pushThirdToMain: '1',
    revParseMainAfterThird: 'SECOND',
    forEachRefAfterThird: 'refs/heads/Main SECOND | refs/heads/main FIRST',
  },
  reftable: {
    pushToMain: '0',
    revParseMain: 'FIRST',
    revParseUpperMain: 'SECOND',
    logMain: 'first',
    forEachRef: 'refs/heads/Main SECOND | refs/heads/main FIRST',
    pushThirdToMain: '0',
    revParseMainAfterThird: 'THIRD',
    forEachRefAfterThird: 'refs/heads/Main SECOND | refs/heads/main THIRD',
  },
};

const caseSensitiveVolume = (): boolean => {
  const directory = createTempDir();
  try {
    fs.writeFileSync(path.join(directory, 'ref-case-probe'), '');
    return !fs.existsSync(path.join(directory, 'REF-CASE-PROBE'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

const CASE_SENSITIVE = caseSensitiveVolume();

const DISTINCT_REFS: Measured = {
  pushToMain: '0',
  revParseMain: 'FIRST',
  revParseUpperMain: 'SECOND',
  logMain: 'first',
  forEachRef: 'refs/heads/Main SECOND | refs/heads/main FIRST',
  pushThirdToMain: '0',
  revParseMainAfterThird: 'THIRD',
  forEachRefAfterThird: 'refs/heads/Main SECOND | refs/heads/main THIRD',
};

const EXPECTED_ON_CASE_SENSITIVE: Record<string, Measured> = {
  'files loose': DISTINCT_REFS,
  'files packed': DISTINCT_REFS,
  reftable: DISTINCT_REFS,
};

const check = (key: string, measured: Measured): void => {
  expect(measured).toEqual(CASE_SENSITIVE ? EXPECTED_ON_CASE_SENSITIVE[key] : EXPECTED_ON_CASE_INSENSITIVE[key]);
};

describe('pushing to Main when main exists (git ref identity is case-sensitive)', () => {
  it('files backend, loose refs', () => {
    check('files loose', measure('files', false));
  });

  it('files backend, packed refs', () => {
    check('files packed', measure('files', true));
  });

  it.skipIf(!supportsReftable())('reftable backend', () => {
    check('reftable', measure('reftable', false));
  });
});
