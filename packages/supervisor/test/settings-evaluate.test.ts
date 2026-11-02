import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SHUTDOWN_MARGIN_MS, runtimeMaxCloseMs } from '@momonga/foundation';
import { createFakeKernelLock, spawnTracked, waitFor } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { KILL_CONFIRM_MS, SETTINGS_DEBOUNCE_MS } from '../src/constants.ts';
import {
  INVALID_SETTINGS_TEXT,
  fakeSettingsWatch,
  pump,
  pumpUntil,
  settledFlag,
  startHarness,
  validSettings,
  writeSettings,
  writeSettingsText,
} from './fixtures/p3-harness.ts';
import type { FakeSettingsWatch, Harness, HarnessOptions } from './fixtures/p3-harness.ts';

const RUNTIME_TERM_BOUND = runtimeMaxCloseMs(30_000) + SHUTDOWN_MARGIN_MS;

const PLAN_POLL_SUSPECT_MS = 100;

type Watched = Harness & { watch: FakeSettingsWatch };

const watched = async (context: CleanupContext, options: HarnessOptions = {}, waitReady = true): Promise<Watched> => {
  const watch = fakeSettingsWatch();
  const h = await startHarness(context, { ...options, overrides: { ...options.overrides, watchSettings: true, settingsWatch: watch.watch } });
  if (waitReady) {
    await h.waitForState('gateway', 'ready', 10_000);
    await h.waitForState('runtime', 'ready', 10_000);
  }
  await pump(h.timers, h.realWork, SETTINGS_DEBOUNCE_MS * 2);
  return Object.assign(h, { watch });
};

const edit = async (h: Watched, value: unknown): Promise<void> => {
  writeSettings(h.home, value);
  h.watch.fire();
  await pump(h.timers, h.realWork, SETTINGS_DEBOUNCE_MS + 50);
};

const editText = async (h: Watched, text: string): Promise<void> => {
  writeSettingsText(h.home, text);
  h.watch.fire();
  await pump(h.timers, h.realWork, SETTINGS_DEBOUNCE_MS + 50);
};

const planCount = (h: Harness): number => h.log.withMsg('plan.begin').length;

const after = (order: readonly string[], from: number): string[] => order.slice(from).filter((entry) => !entry.startsWith('ready') && entry !== 'reapMarkedProcesses');

describe('supervisor-level settings evaluation', () => {
  it('a settings watch that cannot be established is one settings.warning, not a fatal', async (context) => {
    const throwingWatch = (() => {
      throw Object.assign(new Error('watch EMFILE'), { code: 'EMFILE' });
    }) as unknown as typeof fs.watch;
    const h = await startHarness(context, { overrides: { watchSettings: true, settingsWatch: throwingWatch } });
    await h.waitForState('gateway', 'ready', 10_000);
    await h.waitForState('runtime', 'ready', 10_000);
    await pump(h.timers, h.realWork, 10_000);
    const warnings = h.log.withMsg('settings.warning');
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.['detail'])).toContain('EMFILE');
    expect(h.log.withMsg('supervisor.background_failed')).toEqual([]);
    const fatal = settledFlag(h.supervisor.fatal);
    await pump(h.timers, h.realWork, 100);
    expect(fatal.settled()).toBe(false);
  });

  it('supervisor-level watch uses the injected seam and an edit between snapshot and watch start produces one plan', async (context) => {
    const watch = fakeSettingsWatch();
    let home = '';
    let edited = false;
    const seam = ((directory: string, ...rest: unknown[]) => {
      if (!edited) {
        edited = true;
        writeSettings(home, validSettings({ model: 'edited-before-watch' }));
      }
      return (watch.watch as unknown as (directory: string, ...rest: unknown[]) => unknown)(directory, ...rest);
    }) as unknown as typeof fs.watch;
    const h = await startHarness(context, {
      prepare: (prepared) => {
        home = prepared;
      },
      overrides: { watchSettings: true, settingsWatch: seam },
    });
    await pumpUntil(h.timers, () => planCount(h) === 1 && h.log.withMsg('plan.end').length === 1, { realWork: h.realWork, maxMs: 30_000 });
    await pump(h.timers, h.realWork, 20_000);
    expect(planCount(h)).toBe(1);
    expect(watch.directories).toEqual([path.join(h.home, '.momonga')]);
    expect(h.log.withMsg('settings.changed')).toEqual([expect.objectContaining({ models: true, sandbox: false })]);
  });

  it('sandbox change restarts only the runtime', async (context) => {
    const h = await watched(context, { settings: validSettings({ sandbox: 'seatbelt' }) });
    await edit(h, validSettings({ sandbox: 'none' }));
    await pumpUntil(h.timers, () => h.fake.spawnCount('runtime') === 2, { realWork: h.realWork, maxMs: 30_000 });
    await h.waitForState('runtime', 'ready');
    expect(h.fake.spawnCount('gateway')).toBe(1);
    expect(h.fake.latest('gateway').signals).toEqual([]);
    expect(h.log.withMsg('plan.begin')).toEqual([expect.objectContaining({ roles: 'runtime', planned: 1 })]);
    expect(h.log.withMsg('settings.changed')).toEqual([expect.objectContaining({ models: false, sandbox: true })]);
    await edit(h, validSettings({ sandbox: 'none' }));
    await pump(h.timers, h.realWork, 5000);
    expect(h.fake.spawnCount('runtime')).toBe(2);
  });

  it('models change restarts runtime then gateway then runtime comes up', async (context) => {
    const h = await watched(context);
    const mark = h.order.length;
    await edit(h, validSettings({ model: 'gpt-y' }));
    await pumpUntil(h.timers, () => h.fake.spawnCount('runtime') === 2, { realWork: h.realWork, maxMs: 30_000 });
    expect(after(h.order, mark)).toEqual(['SIGTERM:runtime', 'exit:runtime', 'SIGTERM:gateway', 'exit:gateway', 'spawn:gateway', 'spawn:runtime']);
    expect(h.fake.latest('gateway').index).toBeLessThan(h.fake.latest('runtime').index);
    expect(h.log.withMsg('plan.begin')).toEqual([expect.objectContaining({ roles: 'runtime,gateway', planned: 2 })]);
    const spawns = h.log.withMsg('child.spawn').slice(-2);
    expect(spawns.map((line) => [line['child'], line['reason']])).toEqual([
      ['gateway', 'plan'],
      ['runtime', 'plan'],
    ]);
  });

  it('the runtime start waits for the gateway ready', async (context) => {
    const h = await watched(context);
    h.fake.setBehaviour('gateway', { autoReady: false });
    await edit(h, validSettings({ model: 'gpt-y' }));
    await pumpUntil(h.timers, () => h.fake.spawnCount('gateway') === 2, { realWork: h.realWork, maxMs: 30_000 });
    await pump(h.timers, h.realWork, 2000);
    expect(h.fake.spawnCount('runtime')).toBe(1);
    h.fake.latest('gateway').ready();
    await pumpUntil(h.timers, () => h.fake.spawnCount('runtime') === 2, { realWork: h.realWork, maxMs: 1000 });
  });

  it('irrelevant change restarts nothing', async (context) => {
    const h = await watched(context);
    await edit(h, { ...validSettings(), permissions: { allow: ['Bash(ls)'] } });
    await pump(h.timers, h.realWork, 10_000);
    expect(planCount(h)).toBe(0);
    expect(h.log.withMsg('settings.invalid')).toEqual([]);
    expect(h.fake.spawnCount()).toBe(2);
    expect(h.fake.children.flatMap((child) => child.signals)).toEqual([]);
    expect(h.log.withMsg('settings.changed')).toEqual([]);
    expect(h.log.withMsg('settings.evaluated')).toEqual([expect.objectContaining({ level: 'info', modelsChanged: false, sandboxChanged: false, roles: '' })]);
  });

  it('every valid evaluation logs settings.evaluated: a sandbox change logs changed, evaluated, plan.begin in that order', async (context) => {
    const h = await watched(context, { settings: validSettings({ sandbox: 'seatbelt' }) });
    await edit(h, validSettings({ sandbox: 'none' }));
    await pumpUntil(h.timers, () => planCount(h) === 1, { realWork: h.realWork, maxMs: 30_000 });
    expect(h.log.withMsg('settings.evaluated')).toEqual([expect.objectContaining({ level: 'info', modelsChanged: false, sandboxChanged: true, roles: 'runtime' })]);
    const messages = h.log.messages();
    const changedAt = messages.indexOf('settings.changed');
    const evaluatedAt = messages.indexOf('settings.evaluated');
    const planAt = messages.indexOf('plan.begin');
    expect(changedAt).toBeGreaterThanOrEqual(0);
    expect(evaluatedAt).toBeGreaterThan(changedAt);
    expect(planAt).toBeGreaterThan(evaluatedAt);
  });

  it('every valid evaluation logs settings.evaluated: a models change names both roles', async (context) => {
    const h = await watched(context);
    await edit(h, validSettings({ model: 'gpt-y' }));
    await pumpUntil(h.timers, () => planCount(h) === 1, { realWork: h.realWork, maxMs: 30_000 });
    expect(h.log.withMsg('settings.evaluated')).toEqual([expect.objectContaining({ modelsChanged: true, sandboxChanged: false, roles: 'runtime,gateway' })]);
    const messages = h.log.messages();
    expect(messages.indexOf('settings.evaluated')).toBeLessThan(messages.indexOf('plan.begin'));
    expect(messages.indexOf('settings.evaluated')).toBeGreaterThan(messages.indexOf('settings.changed'));
  });

  it('every valid evaluation logs settings.evaluated: a digest change while the runtime waits for its lock plans nothing', async (context) => {
    const lock = createFakeKernelLock({ inheritable: false });
    const holder = { pid: 0 };
    const h = await watched(context, {
      settings: validSettings({ sandbox: 'seatbelt' }),
      prepare: (_home, paths) => {
        holder.pid = spawnTracked(context, 'sleep', ['30']).pid;
        lock.holdExternally(paths.locks.runtime, holder.pid);
      },
      overrides: { lockMechanism: lock, lockWaitMs: 3_600_000 },
    });
    h.fake.latest('runtime').exit(75);
    await h.waitForState('runtime', 'waiting-lock');
    await edit(h, validSettings({ sandbox: 'none' }));
    await pumpUntil(h.timers, () => h.log.withMsg('settings.evaluated').length === 1, { realWork: h.realWork, maxMs: 10_000 });
    await pump(h.timers, h.realWork, 2000);
    expect(h.log.withMsg('settings.evaluated')).toEqual([expect.objectContaining({ modelsChanged: false, sandboxChanged: true, roles: '' })]);
    expect(h.log.withMsg('settings.changed')).toEqual([expect.objectContaining({ models: false, sandbox: true })]);
    expect(planCount(h)).toBe(0);
  });

  it('every valid evaluation logs settings.evaluated: a reformatting with equal digests', async (context) => {
    const h = await watched(context);
    const reordered = Object.fromEntries(Object.entries(validSettings()).reverse());
    await editText(h, `\n${JSON.stringify(reordered, null, 3)}\n`);
    await pump(h.timers, h.realWork, 1000);
    expect(h.log.withMsg('settings.evaluated')).toEqual([expect.objectContaining({ modelsChanged: false, sandboxChanged: false, roles: '' })]);
    expect(h.log.withMsg('settings.changed')).toEqual([]);
    expect(planCount(h)).toBe(0);
  });

  it('evaluations that read no valid snapshot log no settings.evaluated', async (context) => {
    const h = await watched(context);
    await edit(h, { ...validSettings(), permissions: { allow: ['Bash(ls)'] } });
    await pumpUntil(h.timers, () => h.log.withMsg('settings.evaluated').length === 1, { realWork: h.realWork, maxMs: 10_000 });

    h.watch.fire();
    await pump(h.timers, h.realWork, SETTINGS_DEBOUNCE_MS + 50);
    expect(h.log.withMsg('settings.evaluated')).toHaveLength(1);

    await editText(h, INVALID_SETTINGS_TEXT);
    await pumpUntil(h.timers, () => h.log.withMsg('settings.invalid').length === 1, { realWork: h.realWork, maxMs: 10_000 });
    expect(h.log.withMsg('settings.evaluated')).toHaveLength(1);

    const settingsFile = path.join(h.home, '.momonga', 'settings.json');
    const realRead = fs.readFileSync;
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (typeof file === 'string' && fs.realpathSync(path.dirname(file)) === fs.realpathSync(path.dirname(settingsFile)) && path.basename(file) === 'settings.json') {
        throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
      }
      return realRead(file, options as never);
    }) as typeof fs.readFileSync);
    try {
      await edit(h, { ...validSettings(), permissions: { allow: ['Bash(pwd)'] } });
      await pumpUntil(h.timers, () => h.log.withMsg('settings.read_failed').length === 1, { realWork: h.realWork, maxMs: 10_000 });
      await pump(h.timers, h.realWork, 5000);
      expect(h.log.withMsg('settings.read_failed')).toEqual([expect.objectContaining({ level: 'warn' })]);
      expect(h.log.withMsg('settings.evaluated')).toHaveLength(1);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('same digest after reformatting restarts nothing', async (context) => {
    const h = await watched(context);
    const settings = validSettings();
    const reordered = Object.fromEntries(Object.entries(settings).reverse());
    await editText(h, `\n\n${JSON.stringify(reordered, null, 7)}\n`);
    await pump(h.timers, h.realWork, 10_000);
    expect(planCount(h)).toBe(0);
    expect(h.fake.spawnCount()).toBe(2);
  });

  it('invalid edit keeps running children', async (context) => {
    const h = await watched(context);
    await editText(h, INVALID_SETTINGS_TEXT);
    await pump(h.timers, h.realWork, 10_000);
    expect(h.fake.children.flatMap((child) => child.signals)).toEqual([]);
    expect(h.fake.spawnCount()).toBe(2);
    const invalid = h.log.withMsg('settings.invalid');
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toMatchObject({ level: 'warn', action: 'keep-running-children-hold-spawns' });
    expect(String(invalid[0]?.['detail'])).not.toBe('');
    expect(h.health().children.map((child) => child.state)).toEqual(['ready', 'ready']);
  });

  it('held child retries on any raw file change', async (context) => {
    const h = await watched(context);
    h.fake.latest('gateway').exit(78);
    await h.waitForState('gateway', 'held-config');
    h.fake.setBehaviour('gateway', { autoReady: false });
    await editText(h, INVALID_SETTINGS_TEXT);
    await pump(h.timers, h.realWork, 1000);
    expect(h.fake.spawnCount('gateway')).toBe(1);
    await edit(h, validSettings({ permissions: { allow: ['Bash(ls)'] } }));
    await pumpUntil(h.timers, () => h.fake.spawnCount('gateway') === 2, { realWork: h.realWork, maxMs: 2000 });
    expect(h.log.withMsg('child.spawn').at(-1)).toMatchObject({ child: 'gateway', reason: 'settings-change' });
    h.fake.latest('gateway').exit(78);
    await h.waitForState('gateway', 'held-config');
    expect(h.fake.spawnCount('gateway')).toBe(2);
  });

  it('a held child is respawned even by a still-invalid edit', async (context) => {
    const h = await watched(context);
    h.fake.latest('gateway').exit(78);
    await h.waitForState('gateway', 'held-config');
    await editText(h, INVALID_SETTINGS_TEXT);
    await editText(h, `${INVALID_SETTINGS_TEXT} `);
    await pump(h.timers, h.realWork, 1000);
    expect(h.child('gateway').state).toBe('held-config');
    expect(h.log.withMsg('settings.invalid').length).toBeGreaterThanOrEqual(1);
  });

  it('plan stop of a starting child that exits 1', async (context) => {
    const h = await watched(context, { behaviours: { runtime: { autoReady: false, onTerm: 'exit1' } } }, false);
    await h.waitForState('gateway', 'ready', 10_000);
    expect(h.child('runtime').state).toBe('starting');
    await pumpUntil(h.timers, () => h.fake.spawnCount('runtime') === 1, { realWork: h.realWork, maxMs: 5000 });
    const mark = h.order.length;
    await edit(h, validSettings({ model: 'gpt-y' }));
    await pumpUntil(h.timers, () => h.fake.spawnCount('runtime') === 2, { realWork: h.realWork, maxMs: 30_000 });
    await pump(h.timers, h.realWork, 5000);
    expect(h.fake.spawnCount('runtime')).toBe(2);
    expect(after(h.order, mark).filter((entry) => entry.startsWith('spawn'))).toEqual(['spawn:gateway', 'spawn:runtime']);
    expect(h.child('runtime').consecutiveFailures).toBe(0);
    expect(h.log.withMsg('child.backoff')).toEqual([]);
  });

  it('plan with a held-config gateway still starts the runtime', async (context) => {
    const h = await watched(context);
    h.fake.setBehaviour('gateway', { autoReady: false });
    await edit(h, validSettings({ model: 'gpt-y' }));
    await pumpUntil(h.timers, () => h.fake.spawnCount('gateway') === 2, { realWork: h.realWork, maxMs: 30_000 });
    const exitAt = h.clock.now();
    h.fake.latest('gateway').exit(78);
    await pumpUntil(h.timers, () => h.fake.spawnCount('runtime') === 2, { realWork: h.realWork, maxMs: 2000 });
    expect(h.clock.now() - exitAt).toBeLessThan(1000);
    expect(h.child('gateway').state).toBe('held-config');
  });

  it.for(['backoff', 'waiting-lock', 'external'] as const)('plan waits for any state other than starting (%s)', async (state, context) => {
    const lock = createFakeKernelLock({ inheritable: false });
    let holderPid = 0;
    const holdsLock = state !== 'backoff';
    const h = await watched(context, {
      prepare: (_home, paths) => {
        if (!holdsLock) return;
        const holder = spawnTracked(context, 'sleep', ['30']);
        holderPid = holder.pid;
        lock.holdExternally(paths.locks.gateway, holder.pid);
      },
      overrides: { lockMechanism: lock, lockWaitMs: state === 'external' ? 1000 : 3_600_000 },
    });
    expect(!holdsLock || holderPid > 0).toBe(true);
    h.fake.setBehaviour('gateway', { autoReady: false });
    await edit(h, validSettings({ model: 'gpt-y' }));
    await pumpUntil(h.timers, () => h.fake.spawnCount('gateway') === 2, { realWork: h.realWork, maxMs: 30_000 });
    expect(h.child('gateway').state).toBe('starting');
    const pendingDelays = h.timers.pending().map((timer) => timer.delayMs);
    expect(pendingDelays.filter((delayMs) => delayMs === PLAN_POLL_SUSPECT_MS)).toEqual([]);
    h.fake.latest('gateway').exit(holdsLock ? 75 : 1);
    await pumpUntil(h.timers, () => h.fake.spawnCount('runtime') === 2, { realWork: h.realWork, maxMs: 2000 });
    if (state === 'external') {
      await h.waitForState('gateway', 'external', 10_000);
      expect(h.fake.latest('gateway').signals).toEqual([]);
    }
  });

  it('plan skips waiting-lock', async (context) => {
    const lock = createFakeKernelLock({ inheritable: false });
    const holder = { pid: 0 };
    const h = await watched(context, {
      prepare: (_home, paths) => {
        holder.pid = spawnTracked(context, 'sleep', ['30']).pid;
        lock.holdExternally(paths.locks.runtime, holder.pid);
      },
      overrides: { lockMechanism: lock, lockWaitMs: 3_600_000 },
    });
    h.fake.latest('runtime').exit(75);
    await h.waitForState('runtime', 'waiting-lock');
    await edit(h, validSettings({ model: 'gpt-y' }));
    await pumpUntil(h.timers, () => h.fake.spawnCount('gateway') === 2, { realWork: h.realWork, maxMs: 30_000 });
    await pump(h.timers, h.realWork, 2000);
    expect(h.fake.of('runtime').flatMap((child) => child.signals)).toEqual([]);
    expect(h.child('runtime').state).toBe('waiting-lock');
    expect(h.fake.spawnCount('runtime')).toBe(1);
    expect(() => process.kill(holder.pid, 0)).not.toThrow();
  });

  it('plan skips external', async (context) => {
    const lock = createFakeKernelLock({ inheritable: false });
    const holder = { pid: 0 };
    const h = await watched(context, {
      prepare: (_home, paths) => {
        holder.pid = spawnTracked(context, 'sleep', ['30']).pid;
        lock.holdExternally(paths.locks.runtime, holder.pid);
      },
      overrides: { lockMechanism: lock, lockWaitMs: 1000 },
    });
    h.fake.latest('runtime').exit(75);
    await h.waitForState('runtime', 'external', 10_000);
    await edit(h, validSettings({ model: 'gpt-y' }));
    await pumpUntil(h.timers, () => h.fake.spawnCount('gateway') === 2, { realWork: h.realWork, maxMs: 30_000 });
    expect(h.fake.of('runtime').flatMap((child) => child.signals)).toEqual([]);
    expect(h.child('runtime').state).toBe('external');
    expect(h.fake.latest('gateway').index).toBeGreaterThan(0);
    expect(() => process.kill(holder.pid, 0)).not.toThrow();
  });

  it('plan includes backoff without a stop', async (context) => {
    const h = await watched(context, { overrides: { restart: { minMs: 5000, baseMs: 20_000 } } });
    h.fake.latest('runtime').exit(1);
    await h.waitForState('runtime', 'backoff');
    await edit(h, validSettings({ model: 'gpt-y' }));
    await pumpUntil(h.timers, () => h.fake.spawnCount('runtime') === 2, { realWork: h.realWork, maxMs: 60_000 });
    await pump(h.timers, h.realWork, 30_000);
    expect(h.fake.spawnCount('runtime')).toBe(2);
    expect(h.fake.of('runtime')[0]?.signals).toEqual([]);
    expect(h.fake.spawnCount('gateway')).toBe(2);
  });

  it('plan skips held-config', async (context) => {
    const h = await watched(context);
    h.fake.latest('runtime').exit(78);
    await h.waitForState('runtime', 'held-config');
    await edit(h, validSettings({ model: 'gpt-y' }));
    await pumpUntil(h.timers, () => h.fake.spawnCount('runtime') === 2 && h.fake.spawnCount('gateway') === 2, { realWork: h.realWork, maxMs: 30_000 });
    await pump(h.timers, h.realWork, 5000);
    const runtimeSpawns = h.log.withMsg('child.spawn').filter((line) => line['child'] === 'runtime');
    expect(runtimeSpawns.map((line) => line['reason'])).toEqual(['initial', 'settings-change']);
  });

  it('a leaked plan stop still lets the plan finish', async (context) => {
    const lock = createFakeKernelLock({ inheritable: false });
    const holder = { pid: 0 };
    const h = await watched(context, {
      prepare: (_home, paths) => {
        holder.pid = spawnTracked(context, 'sleep', ['30']).pid;
        lock.holdExternally(paths.locks.runtime, holder.pid);
      },
      overrides: { lockMechanism: lock, lockWaitMs: 3_600_000 },
    });
    h.fake.setBehaviour('runtime', { onTerm: 'ignore', onKill: 'ignore' });
    await edit(h, validSettings({ model: 'gpt-y' }));
    await pumpUntil(h.timers, () => h.fake.spawnCount('runtime') === 2, { realWork: h.realWork, maxMs: RUNTIME_TERM_BOUND + KILL_CONFIRM_MS + 30_000 });
    expect(h.log.withMsg('child.unkillable')).toEqual([expect.objectContaining({ child: 'runtime' })]);
    expect(h.fake.spawnCount('gateway')).toBe(2);
    h.fake.latest('runtime').exit(75);
    await h.waitForState('runtime', 'waiting-lock');
    await pump(h.timers, h.realWork, 10_000);
    expect(h.fake.spawnCount('runtime')).toBe(2);
  });

  it('coordinated restart is bounded', async (context) => {
    const h = await watched(context);
    h.fake.setBehaviour('runtime', { onTerm: 'ignore' });
    await edit(h, validSettings({ model: 'gpt-y' }));
    const restartedRuntime = h.fake.latest('runtime');
    const runtimeEvent = (kind: 'kill' | 'killGroup') =>
      h.fake.events.find((event) => event.role === 'runtime' && event.pid === restartedRuntime.pid && event.kind === kind);
    await pumpUntil(h.timers, () => runtimeEvent('kill') !== undefined, { realWork: h.realWork, maxMs: 5000 });
    await pumpUntil(h.timers, () => runtimeEvent('killGroup') !== undefined, { realWork: h.realWork, maxMs: RUNTIME_TERM_BOUND + 1000 });
    const sigterm = runtimeEvent('kill');
    const groupKill = runtimeEvent('killGroup');
    expect(sigterm?.detail).toBe('SIGTERM');
    expect(restartedRuntime.signals).toEqual(['SIGTERM']);
    const elapsed = (groupKill?.at ?? Number.NaN) - (sigterm?.at ?? Number.NaN);
    expect(elapsed).toBeGreaterThanOrEqual(RUNTIME_TERM_BOUND);
    expect(elapsed).toBeLessThanOrEqual(RUNTIME_TERM_BOUND + 50);
  });

  it('a change during a plan is coalesced', async (context) => {
    const h = await watched(context, {
      overrides: { env: { PATH: '/usr/bin:/bin', LANG: 'C', SECOND_EDIT_NAME: 'second-value', THIRD_EDIT_NAME: 'third-value' } },
    });
    h.fake.setBehaviour('runtime', { onTerm: 'ignore' });
    await edit(h, validSettings({ model: 'gpt-y' }));
    await pumpUntil(h.timers, () => h.fake.latest('runtime').signals.length === 1, { realWork: h.realWork, maxMs: 5000 });
    await edit(h, validSettings({ model: 'gpt-z', apiKeyEnv: 'SECOND_EDIT_NAME' }));
    await edit(h, validSettings({ model: 'gpt-w', apiKeyEnv: 'THIRD_EDIT_NAME' }));
    expect(planCount(h)).toBe(1);
    h.fake.setBehaviour('runtime', { onTerm: 'exit0' });
    h.fake.latest('runtime').exit(0);
    await pumpUntil(h.timers, () => h.log.withMsg('plan.end').length === 1, { realWork: h.realWork, maxMs: 60_000 });
    await pump(h.timers, h.realWork, 20_000);
    expect(planCount(h)).toBe(1);
    expect(h.fake.spawnCount('runtime')).toBe(2);
    expect(h.fake.spawnCount('gateway')).toBe(2);
    const gatewayEnv = h.fake.latest('gateway').options.env;
    expect(gatewayEnv['THIRD_EDIT_NAME']).toBe('third-value');
    expect(gatewayEnv['SECOND_EDIT_NAME']).toBeUndefined();
  });
});

describe('the first spawn and the settings read', () => {
  it('an edit made during the reap is picked up by the first spawn', async (context) => {
    let holding = true;
    const h = await startHarness(context, {
      settings: validSettings({ sandbox: 'seatbelt' }),
      prepare: (_home, paths) => {
        fs.mkdirSync(paths.markers.daemons, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(paths.markers.daemons, 'runtime-old'), '');
      },
      markerPorts: { findHolders: async () => (holding ? [999_999] : []) },
      overrides: {
        orphanGraceMs: 60_000,
        watchSettings: true,
        settingsWatch: fakeSettingsWatch().watch,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', UPSTREAM_SECRET_NAME: 'value-for-test' },
      },
    });
    await waitFor(() => h.markers.calls.findHolders.length > 0);
    writeSettings(h.home, validSettings({ sandbox: 'none', apiKeyEnv: 'UPSTREAM_SECRET_NAME' }));
    holding = false;
    await pumpUntil(h.timers, () => h.fake.spawnCount() === 2, { realWork: h.realWork, maxMs: 5000 });
    await pump(h.timers, h.realWork, 10_000);
    expect(planCount(h)).toBe(0);
    expect(h.fake.spawnCount()).toBe(2);
    expect(h.fake.latest('gateway').options.env['UPSTREAM_SECRET_NAME']).toBe('value-for-test');
    expect(h.fake.latest('runtime').options.env['UPSTREAM_SECRET_NAME']).toBeUndefined();
  });
});
