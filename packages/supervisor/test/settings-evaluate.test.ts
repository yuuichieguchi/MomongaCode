import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, waitFor, firstGeneration } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { SETTINGS_DEBOUNCE_MS } from '../src/constants.ts';
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
import { testHostPath } from '@momonga/testkit';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

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

const changedCount = (h: Harness): number => h.log.withMsg('settings.changed').length;

const appliedModel = (h: Harness): unknown => {
  const record = JSON.parse(fs.readFileSync(firstGeneration(h.paths).settingsApplied, 'utf8')) as { settings?: { models?: { targets?: Record<string, { model?: unknown }> } } };
  return Object.values(record.settings?.models?.targets ?? {})[0]?.model;
};

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

  it('supervisor-level watch uses the injected seam and an edit between snapshot and watch start is applied in place, with no restart', async (context) => {
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
    await pumpUntil(h.timers, () => appliedModel(h) === 'edited-before-watch', { realWork: h.realWork, maxMs: 30_000 });
    await pump(h.timers, h.realWork, 20_000);
    expect(appliedModel(h)).toBe('edited-before-watch');
    expect(watch.directories).toEqual([path.join(h.home, '.momonga')]);
    expect(h.fake.spawnCount()).toBe(2);
    expect(h.fake.children.flatMap((child) => child.signals)).toEqual([]);
  });

  it('evaluations that read no valid snapshot log no settings.changed', async (context) => {
    const h = await watched(context);
    const before = changedCount(h);
    await edit(h, { ...validSettings(), permissions: { allow: ['Bash(ls)'] } });
    await pumpUntil(h.timers, () => changedCount(h) === before + 1, { realWork: h.realWork, maxMs: 10_000 });

    h.watch.fire();
    await pump(h.timers, h.realWork, SETTINGS_DEBOUNCE_MS + 50);
    expect(changedCount(h)).toBe(before + 1);

    await editText(h, INVALID_SETTINGS_TEXT);
    await pumpUntil(h.timers, () => h.log.withMsg('settings.invalid').length === 1, { realWork: h.realWork, maxMs: 10_000 });
    expect(changedCount(h)).toBe(before + 1);

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
      expect(changedCount(h)).toBe(before + 1);
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
    expect(h.fake.spawnCount()).toBe(2);
    expect(h.fake.children.flatMap((child) => child.signals)).toEqual([]);
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

});

describe('the first spawn and the settings read', () => {
  it('an edit made during the reap is picked up by the first spawn', async (context) => {
    const reap = Promise.withResolvers<{ reaped: number; kept: number }>();
    const h = await startHarness(context, {
      settings: validSettings({ sandbox: 'seatbelt' }),
      markerPorts: { reapMarkerDirectory: () => reap.promise },
      overrides: {
        watchSettings: true,
        settingsWatch: fakeSettingsWatch().watch,
        env: { PATH: testHostPath('/usr/bin:/bin'), LANG: 'C', UPSTREAM_SECRET_NAME: 'value-for-test' },
      },
    });
    await waitFor(() => h.markers.calls.reapMarkerDirectory.length > 0);
    writeSettings(h.home, validSettings({ sandbox: 'none', apiKeyEnv: 'UPSTREAM_SECRET_NAME' }));
    reap.resolve({ reaped: 0, kept: 0 });
    await pumpUntil(h.timers, () => h.fake.spawnCount() === 2, { realWork: h.realWork, maxMs: 5000 });
    await pump(h.timers, h.realWork, 10_000);
    expect(h.fake.spawnCount()).toBe(2);
    expect(h.fake.children.flatMap((child) => child.signals)).toEqual([]);
    expect(h.fake.latest('gateway').options.env['UPSTREAM_SECRET_NAME']).toBe('value-for-test');
    expect(h.fake.latest('runtime').options.env['UPSTREAM_SECRET_NAME']).toBeUndefined();
  });
});
