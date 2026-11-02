import { describe, expect, it, vi } from 'vitest';
import type { WatchSettingsOptions } from '../src/settings-watch.ts';
import { fakeSettingsWatch, pumpUntil, startHarness } from './fixtures/p3-harness.ts';

const captured = vi.hoisted(() => ({ options: [] as WatchSettingsOptions[] }));

vi.mock('../src/settings-watch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/settings-watch.ts')>();
  return {
    ...actual,
    watchSettings: (options: WatchSettingsOptions) => {
      captured.options.push(options);
      return actual.watchSettings(options);
    },
  };
});

const PENDING = Symbol('pending');

const raceAgainstResolvedSentinel = <T>(promise: Promise<T>): Promise<T | typeof PENDING> => Promise.race([promise, Promise.resolve(PENDING)]);

describe('supervisor wiring of watchSettings callbacks', () => {
  it('logs onWarning as settings.warning without fatal, and routes onError to the fatal settings-watch background failure', async (context) => {
    captured.options.length = 0;
    const watch = fakeSettingsWatch();
    const h = await startHarness(context, { overrides: { watchSettings: true, settingsWatch: watch.watch } });
    await pumpUntil(h.timers, () => captured.options.length === 1, { realWork: h.realWork, maxMs: 10_000 });
    expect(captured.options).toHaveLength(1);
    const options = captured.options[0] as WatchSettingsOptions;

    options.onWarning(new Error('fallback'));
    const warnings = h.log.withMsg('settings.warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.['detail']).toBe('fallback');
    expect(await raceAgainstResolvedSentinel(h.supervisor.fatal)).toBe(PENDING);
    expect(h.log.withMsg('supervisor.background_failed')).toEqual([]);

    const boom = new Error('boom');
    options.onError(boom);
    expect(await raceAgainstResolvedSentinel(h.supervisor.fatal)).toBe(boom);
    const failed = h.log.withMsg('supervisor.background_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.['source']).toBe('settings-watch');
    expect(h.log.withMsg('settings.warning')).toHaveLength(1);
  });
});
