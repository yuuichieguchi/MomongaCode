import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalPath, generationLayout, nodeFileSystem } from '@momonga/foundation';
import type { AtomicWriteFileSystem } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import type { SupervisorCloseResult, SupervisorOptions } from '../src/start-supervisor.ts';
import { TEST_VERSION, pumpUntil, quiesce, settledFlag, startHarness } from './fixtures/p3-harness.ts';
import type { Harness, HarnessOptions } from './fixtures/p3-harness.ts';

type PublishPort = { currentFileSystem: AtomicWriteFileSystem };
type Rename = { from: string; to: string };

const TEMPORARY_OF_CURRENT = /^current\.\d+\.[0-9a-f]+\.tmp$/;

const expectedText = (home: string): string => {
  const sockets = generationLayout(canonicalPath(home), 1).sockets;
  return `${JSON.stringify({ generation: 1, version: TEST_VERSION, sockets: { gateway: sockets.gateway, runtime: sockets.runtime, supervisor: sockets.supervisor } })}\n`;
};

const leftoverTemporaries = (h: Harness): string[] => fs.readdirSync(h.paths.run).filter((entry) => TEMPORARY_OF_CURRENT.test(entry));

const recordingFileSystem = (renames: Rename[], failRename?: Error): AtomicWriteFileSystem => ({
  open: (file, flags, mode) => nodeFileSystem.open(file, flags, mode),
  rename: async (from, to) => {
    renames.push({ from, to });
    if (failRename !== undefined) throw failRename;
    await nodeFileSystem.rename(from, to);
  },
  link: (from, to) => nodeFileSystem.link(from, to),
  rm: (file) => nodeFileSystem.rm(file),
});

const withPublishPort = (port: AtomicWriteFileSystem): NonNullable<HarnessOptions['overrides']> => ({ currentFileSystem: port } satisfies PublishPort) as unknown as Partial<SupervisorOptions>;

const finish = async (h: Harness, closing: Promise<SupervisorCloseResult>, maxMs: number): Promise<SupervisorCloseResult> => {
  const flag = settledFlag(closing);
  await pumpUntil(h.timers, () => flag.settled(), { realWork: h.realWork, maxMs, description: 'close settles' });
  const value = flag.value();
  if (value === undefined) throw new Error('close rejected');
  return value;
};

const stopBound = (h: Harness): number => {
  const bound = h.health().stopBoundMs;
  if (bound === undefined) throw new Error('health carries no stop bound after close');
  return bound;
};

const published = async (h: Harness): Promise<void> => {
  await pumpUntil(h.timers, () => fs.existsSync(h.paths.current), { realWork: h.realWork, maxMs: 5000, description: 'run/current published' });
  await quiesce(h.realWork);
};

describe('the supervisor publishes run/current', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('does not publish while only one child is ready, and publishes once both are', async (context) => {
    const h = await startHarness(context, { behaviours: { runtime: { autoReady: false } } });
    await h.waitForState('gateway', 'ready', 10_000);
    await quiesce(h.realWork);
    expect(h.child('runtime').state).toBe('starting');
    expect(fs.existsSync(h.paths.current)).toBe(false);
    h.fake.latest('runtime').ready();
    await h.waitForState('runtime', 'ready', 10_000);
    await published(h);
    expect(fs.readFileSync(h.paths.current, 'utf8')).toBe(expectedText(h.home));
  });

  it('writes exactly generation 1, the supervisor version and the three sockets of generationLayout(home, 1), mode 0600, with no temporary left', async (context) => {
    const h = await startHarness(context);
    await published(h);
    expect(fs.readFileSync(h.paths.current, 'utf8')).toBe(expectedText(h.home));
    expect(fs.statSync(h.paths.current).mode & 0o777).toBe(0o600);
    expect(leftoverTemporaries(h)).toEqual([]);
  });

  it('publishes by one rename from a temporary file in run/ through the filesystem port', async (context) => {
    const renames: Rename[] = [];
    const h = await startHarness(context, { overrides: withPublishPort(recordingFileSystem(renames)) });
    await published(h);
    expect(renames).toHaveLength(1);
    expect(renames[0]?.to).toBe(h.paths.current);
    expect(fs.realpathSync(path.dirname(renames[0]?.from ?? ''))).toBe(fs.realpathSync(h.paths.run));
    expect(path.basename(renames[0]?.from ?? '')).toMatch(TEMPORARY_OF_CURRENT);
    expect(leftoverTemporaries(h)).toEqual([]);
  });

  it('a child restart after readiness leaves run/current untouched', async (context) => {
    const renames: Rename[] = [];
    const h = await startHarness(context, { overrides: withPublishPort(recordingFileSystem(renames)) });
    await published(h);
    const before = fs.statSync(h.paths.current);
    const text = fs.readFileSync(h.paths.current, 'utf8');
    h.fake.latest('runtime').exit(1);
    await pumpUntil(h.timers, () => h.fake.spawnCount('runtime') === 2 && h.child('runtime').state === 'ready', {
      realWork: h.realWork,
      maxMs: 120_000,
      description: 'runtime restarted and ready',
    });
    await quiesce(h.realWork);
    const after = fs.statSync(h.paths.current);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(fs.readFileSync(h.paths.current, 'utf8')).toBe(text);
    expect(renames).toHaveLength(1);
  });

  it('a supervisor that begins draining before both children are ready never publishes, even when the last child reports ready during the drain', async (context) => {
    const h = await startHarness(context, { behaviours: { runtime: { autoReady: false, onTerm: 'ignore' } } });
    await h.waitForState('gateway', 'ready', 10_000);
    await pumpUntil(h.timers, () => h.fake.spawnCount('runtime') === 1, { realWork: h.realWork, maxMs: 5000, description: 'runtime spawned' });
    const closing = h.supervisor.close();
    await pumpUntil(h.timers, () => h.health().phase === 'draining', { realWork: h.realWork, maxMs: 5000, description: 'draining' });
    h.fake.latest('runtime').ready();
    await quiesce(h.realWork);
    expect(fs.existsSync(h.paths.current)).toBe(false);
    h.fake.latest('runtime').exit(0);
    await finish(h, closing, stopBound(h));
    expect(fs.existsSync(h.paths.current)).toBe(false);
    expect(leftoverTemporaries(h)).toEqual([]);
  });

  it('a stop leaves run/current in place, unchanged', async (context) => {
    const h = await startHarness(context);
    await published(h);
    const before = fs.statSync(h.paths.current);
    const closing = h.supervisor.close();
    const result = await finish(h, closing, stopBound(h));
    expect(result.clean).toBe(true);
    expect(fs.existsSync(h.paths.current)).toBe(true);
    expect(fs.statSync(h.paths.current).ino).toBe(before.ino);
    expect(fs.readFileSync(h.paths.current, 'utf8')).toBe(expectedText(h.home));
  });

  it('a publish failure is reported on the background channel, the supervisor keeps serving, and its stop ends within its own bound', async (context) => {
    const renames: Rename[] = [];
    const failure = Object.assign(new Error('injected rename failure'), { code: 'EIO' });
    const h = await startHarness(context, { overrides: withPublishPort(recordingFileSystem(renames, failure)) });
    await h.waitForState('gateway', 'ready', 10_000);
    await h.waitForState('runtime', 'ready', 10_000);
    const fatal = settledFlag(h.supervisor.fatal);
    await pumpUntil(h.timers, () => h.log.withMsg('supervisor.background_failed').length >= 1, { realWork: h.realWork, maxMs: 5000, description: 'publish failure reported' });
    await quiesce(h.realWork);
    const failed = h.log.withMsg('supervisor.background_failed');
    expect(failed.map((line) => line['source'])).toEqual(['publish-current']);
    expect(failed[0]?.['err']).toMatchObject({ message: 'injected rename failure' });
    expect(fatal.value()?.message).toBe('injected rename failure');
    expect(renames).toHaveLength(1);
    expect(fs.existsSync(h.paths.current)).toBe(false);
    expect(leftoverTemporaries(h)).toEqual([]);
    expect(h.health().phase).toBe('running');
    expect(h.health().children.map((child) => child.state)).toEqual(['ready', 'ready']);
    const result = await finish(h, h.supervisor.close(), stopBound(h));
    expect(result.clean).toBe(true);
  });
});
