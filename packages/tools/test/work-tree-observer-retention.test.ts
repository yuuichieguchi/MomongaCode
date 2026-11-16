import { spawnSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { createGitWorkTreeObserver, observerStoreOf, pruneGitObserverStores, unprotectedLaunch } from '@momonga/tools';
import { systemClock } from '@momonga/foundation';

const LAUNCH = unprotectedLaunch('the tests of the observer retention start git without the protection of the home');

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const SYSTEM_GIT = '/usr/bin/git';
const HOUR_MS = 3_600_000;

let root = '';
let project = '';
let storeRoot = '';
const savedHome = process.env['HOME'];
const gitEnv = (home: string): NodeJS.ProcessEnv => ({ HOME: home, PATH: '/usr/bin:/bin', LANG: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });

const signal = (): AbortSignal => new AbortController().signal;

const looseObjects = (): number => {
  const store = observerStoreOf(storeRoot, fs.realpathSync(project));
  const result = spawnSync(SYSTEM_GIT, ['count-objects'], { env: { ...gitEnv(path.join(root, 'home')), GIT_DIR: store }, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git count-objects failed: ${result.stderr}`);
  const match = /^(\d+) objects/.exec(result.stdout);
  if (match === null) throw new Error(`git count-objects answered ${result.stdout}`);
  return Number(match[1]);
};

beforeEach(() => {
  if (!fs.existsSync(SYSTEM_GIT)) throw new Error(`system git required at ${SYSTEM_GIT}`);
  root = createTempDir();
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  process.env['HOME'] = home;
  project = path.join(root, 'project');
  storeRoot = path.join(root, 'state', 'observer');
  fs.mkdirSync(project);
  const init = spawnSync(SYSTEM_GIT, ['init', '-q'], { cwd: project, env: gitEnv(home), encoding: 'utf8' });
  if (init.status !== 0) throw new Error(init.stderr);
  fs.writeFileSync(path.join(project, 'a.txt'), 'one\n');
});

afterEach(() => {
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the observer store under retention', () => {
  it('keeps the objects of marks newer than the cutoff', async () => {
    await createGitWorkTreeObserver({ storeRoot, cwd: project, trusted: true }, LAUNCH).mark(signal());
    const before = looseObjects();
    expect(before).toBeGreaterThan(0);

    await pruneGitObserverStores({ storeRoot, cutoffMs: systemClock.now() - HOUR_MS }, LAUNCH, signal());

    expect(looseObjects()).toBe(before);
  });

  it('removes the objects of marks older than the cutoff from every observer store', async () => {
    await createGitWorkTreeObserver({ storeRoot, cwd: project, trusted: true }, LAUNCH).mark(signal());
    expect(looseObjects()).toBeGreaterThan(0);

    await pruneGitObserverStores({ storeRoot, cutoffMs: systemClock.now() + HOUR_MS }, LAUNCH, signal());

    expect(looseObjects()).toBe(0);
  });

  it('does nothing when no observer store was ever made', async () => {
    await expect(pruneGitObserverStores({ storeRoot, cutoffMs: systemClock.now() }, LAUNCH, signal())).resolves.toBeUndefined();
  });
});
