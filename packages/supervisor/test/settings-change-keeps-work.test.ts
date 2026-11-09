import { describe, expect, it } from 'vitest';
import { SHUTDOWN_MARGIN_MS, runtimeMaxCloseMs } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { SETTINGS_DEBOUNCE_MS } from '../src/constants.ts';
import { fakeSettingsWatch, pump, startHarness, validSettings, writeSettings } from './fixtures/p3-harness.ts';
import type { FakeSettingsWatch, Harness, HarnessOptions } from './fixtures/p3-harness.ts';

const STOP_WOULD_COMPLETE_WITHIN_MS = runtimeMaxCloseMs(30_000) + SHUTDOWN_MARGIN_MS;

type Watched = Harness & { watch: FakeSettingsWatch };

const watched = async (context: CleanupContext, options: HarnessOptions = {}): Promise<Watched> => {
  const watch = fakeSettingsWatch();
  const h = await startHarness(context, { ...options, overrides: { ...options.overrides, watchSettings: true, settingsWatch: watch.watch } });
  await h.waitForState('gateway', 'ready', 10_000);
  await h.waitForState('runtime', 'ready', 10_000);
  await pump(h.timers, h.realWork, SETTINGS_DEBOUNCE_MS * 2);
  return Object.assign(h, { watch });
};

const changeSettingsAndLetItSettle = async (h: Watched, value: unknown): Promise<void> => {
  writeSettings(h.home, value);
  h.watch.fire();
  await pump(h.timers, h.realWork, SETTINGS_DEBOUNCE_MS + STOP_WOULD_COMPLETE_WITHIN_MS);
};

const stopEvents = (order: readonly string[]): string[] => order.filter((entry) => entry.startsWith('SIGTERM:') || entry.startsWith('SIGKILL:') || entry.startsWith('exit:'));

const expectServingProcessesUntouched = (h: Watched): void => {
  expect(stopEvents(h.order)).toEqual([]);
  expect(h.fake.latest('runtime').signals).toEqual([]);
  expect(h.fake.latest('gateway').signals).toEqual([]);
  expect(h.fake.spawnCount('runtime')).toBe(1);
  expect(h.fake.spawnCount('gateway')).toBe(1);
  expect(h.log.withMsg('settings.changed')).toHaveLength(1);
  expect(h.log.withMsg('child.stop')).toEqual([]);
};

const OTLP = { otlp: { endpoint: 'http://127.0.0.1:4318' } };

describe('decision 76: a user settings change never stops the processes serving in-flight work', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('a models change signals no child, spawns none and logs settings.changed', async (context) => {
    const h = await watched(context);
    await changeSettingsAndLetItSettle(h, validSettings({ model: 'gpt-y' }));
    expectServingProcessesUntouched(h);
  });

  it('a sandbox change signals no child, spawns none and logs settings.changed', async (context) => {
    const h = await watched(context, { settings: validSettings({ sandbox: 'seatbelt' }) });
    await changeSettingsAndLetItSettle(h, validSettings({ sandbox: 'none' }));
    expectServingProcessesUntouched(h);
  });

  it('a telemetry change signals no child, spawns none and logs settings.changed', async (context) => {
    const h = await watched(context);
    await changeSettingsAndLetItSettle(h, { ...validSettings(), telemetry: OTLP });
    expectServingProcessesUntouched(h);
  });

  it('a network change signals no child, spawns none and logs settings.changed', async (context) => {
    const h = await watched(context);
    await changeSettingsAndLetItSettle(h, { ...validSettings(), network: { httpsProxy: 'http://proxy.corp:3128' } });
    expectServingProcessesUntouched(h);
  });
});
