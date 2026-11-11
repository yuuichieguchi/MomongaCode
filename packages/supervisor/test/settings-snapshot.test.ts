import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CREDENTIAL_CAPABILITY_ENV, CREDENTIAL_CAPABILITY_HEADER, SHUTDOWN_DRAIN_BOUND_MS, createUdsClient, fixedSocket } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, firstGeneration, registerCleanup, testHostPath } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { SETTINGS_DEBOUNCE_MS } from '../src/constants.ts';
import { fakeSettingsWatch, pump, pumpUntil, settledFlag, startHarness, validSettings, writeSettings } from './fixtures/p3-harness.ts';
import type { Harness, SimpleResponse } from './fixtures/p3-harness.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const DECLARED_LATER = 'MOMONGA_TEST_DECLARED_LATER_KEY';
const DECLARED_VALUE = 'declared-later-value';

const SYNCHRONOUS_READS = ['readFileSync', 'statSync', 'lstatSync', 'existsSync', 'openSync', 'accessSync'] as const;

const isSettingsFile = (target: unknown): boolean => typeof target === 'string' && path.basename(target) === 'settings.json' && path.basename(path.dirname(target)) === '.momonga';

const recordSynchronousSettingsReads = (context: CleanupContext): string[] => {
  const seen: string[] = [];
  for (const name of SYNCHRONOUS_READS) {
    const original = fs[name] as (...args: unknown[]) => unknown;
    const spy = vi.spyOn(fs, name).mockImplementation(((...args: unknown[]) => {
      if (isSettingsFile(args[0])) seen.push(name);
      return original(...args);
    }) as never);
    context.onTestFinished(() => spy.mockRestore());
  }
  return seen;
};

const ready = async (h: Harness): Promise<void> => {
  await h.waitForState('gateway', 'ready', 10_000);
  await h.waitForState('runtime', 'ready', 10_000);
  await pumpUntil(h.timers, () => h.supervisor.role() === 'serving', { realWork: h.realWork, maxMs: 5000, description: 'the generation to serve' });
};

const startEnvOf = (): Record<string, string> => ({ PATH: testHostPath('/usr/bin:/bin'), LANG: 'C', [DECLARED_LATER]: DECLARED_VALUE });

const askForCredential = (context: CleanupContext, h: Harness, name: string): Promise<SimpleResponse> =>
  h.realWork.run(async () => {
    const capability = h.fake.latest('gateway').options.env[CREDENTIAL_CAPABILITY_ENV];
    if (capability === undefined) throw new Error('the gateway was spawned without a credential capability');
    const client = createUdsClient(fixedSocket(firstGeneration(h.paths).sockets.supervisor), { connectTimeoutMs: 0, headersTimeoutMs: 5000 });
    registerCleanup(context, () => client.destroy());
    const response = await client.request({ method: 'GET', path: `/v1/credentials/${name}`, headers: { [CREDENTIAL_CAPABILITY_HEADER]: capability } });
    const text = await response.text();
    await client.close();
    return { status: response.status, headers: response.headers, text };
  });

describe('the supervisor reads its settings from the loaded snapshot and never blocks its loop on the settings file (config DECISION-5)', () => {
  it('a start, a respawn and a stop make no synchronous file-system call on the settings file', async (context) => {
    let seen: string[] = [];
    const h = await startHarness(context, { prepare: () => void (seen = recordSynchronousSettingsReads(context)) });
    await ready(h);
    h.fake.latest('runtime').exit(1);
    await pumpUntil(h.timers, () => h.fake.spawnCount('runtime') === 2, { realWork: h.realWork, maxMs: 60_000, description: 'the runtime to be spawned again' });
    const closing = settledFlag(h.supervisor.close());
    await pumpUntil(h.timers, () => closing.settled(), { realWork: h.realWork, maxMs: 200_000, description: 'the stop to settle' });
    expect(seen).toEqual([]);
  });

  it('a child that is spawned again gets the settings a person last saved, with no settings watch running', async (context) => {
    const h = await startHarness(context, { overrides: { watchSettings: false, env: startEnvOf() } });
    await ready(h);
    expect(h.fake.latest('gateway').options.env[DECLARED_LATER]).toBeUndefined();
    writeSettings(h.home, validSettings({ apiKeyEnv: DECLARED_LATER }));
    h.fake.latest('gateway').exit(1);
    await pumpUntil(h.timers, () => h.fake.spawnCount('gateway') === 2, { realWork: h.realWork, maxMs: 60_000, description: 'the gateway to be spawned again' });
    expect(h.fake.latest('gateway').options.env[DECLARED_LATER]).toBe(DECLARED_VALUE);
    expect(h.log.withMsg('child.spawn').at(-1)).toMatchObject({ child: 'gateway', reason: 'backoff' });
  });

  it('a settings file that cannot be read when a child is spawned again is a failure without a process, and the next attempt reads it again', async (context) => {
    const h = await startHarness(context, { overrides: { watchSettings: false } });
    await ready(h);
    const settingsFile = path.join(h.home, '.momonga', 'settings.json');
    fs.rmSync(settingsFile);
    fs.mkdirSync(settingsFile);
    h.fake.latest('runtime').exit(1);
    await pumpUntil(h.timers, () => h.child('runtime').lastExit?.reason === 'settings-read-failed' || h.child('runtime').state === 'held-config', { realWork: h.realWork, maxMs: 60_000, description: 'the unreadable settings to be reported' });
    expect(h.fake.spawnCount('runtime')).toBe(1);
    fs.rmdirSync(settingsFile);
    writeSettings(h.home, validSettings());
    await pumpUntil(h.timers, () => h.fake.spawnCount('runtime') === 2, { realWork: h.realWork, maxMs: 600_000, description: 'the runtime to be spawned again' });
  });

  it('a credential request reads the settings a person last saved: a change of the file is seen by the next request, with no settings watch running', async (context) => {
    const h = await startHarness(context, { overrides: { watchSettings: false, env: startEnvOf() } });
    await ready(h);
    expect((await askForCredential(context, h, DECLARED_LATER)).status).toBe(403);
    writeSettings(h.home, validSettings({ apiKeyEnv: DECLARED_LATER }));
    const answered = await askForCredential(context, h, DECLARED_LATER);
    expect(answered.status).toBe(200);
    expect(JSON.parse(answered.text)).toEqual({ name: DECLARED_LATER, value: DECLARED_VALUE });
    expect(h.fake.spawnCount('gateway')).toBe(1);
  });

  it('a stop waits, within the bound of its first step, for a settings evaluation in flight', async (context) => {
    const watch = fakeSettingsWatch();
    const h = await startHarness(context, { overrides: { watchSettings: true, settingsWatch: watch.watch } });
    await ready(h);
    await pump(h.timers, h.realWork, SETTINGS_DEBOUNCE_MS * 2);
    const recordName = path.basename(firstGeneration(h.paths).settingsApplied);
    const realRename = fs.promises.rename;
    let held = 0;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (path.basename(String(to)) !== recordName) return realRename(from, to);
      held += 1;
      return new Promise<void>(() => undefined);
    }) as typeof fs.promises.rename);
    context.onTestFinished(() => renameSpy.mockRestore());
    writeSettings(h.home, validSettings({ model: 'gpt-changed' }));
    watch.fire();
    await pumpUntil(h.timers, () => held === 1, { realWork: h.realWork, maxMs: 10_000, description: 'the write of the applied record to be in flight' });
    const stopAt = h.clock.now();
    const closing = settledFlag(h.supervisor.close());
    await pumpUntil(h.timers, () => h.log.withMsg('shutdown.step').some((line) => line['shutdownStep'] === 2), { realWork: h.realWork, maxMs: 200_000, description: 'the stop to reach its second step' });
    expect(h.clock.now() - stopAt).toBe(SHUTDOWN_DRAIN_BOUND_MS);
    expect(h.log.withMsg('shutdown.step').filter((line) => line['detail'] === 'step 1 bound reached')).toHaveLength(1);
    await pumpUntil(h.timers, () => closing.settled(), { realWork: h.realWork, maxMs: 200_000, description: 'the stop to settle' });
  });
});
