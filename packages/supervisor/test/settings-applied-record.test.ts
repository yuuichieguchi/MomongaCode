import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIRST_GENERATION, generationLayout } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { SETTINGS_DEBOUNCE_MS } from '../src/constants.ts';
import { INVALID_SETTINGS_TEXT, fakeSettingsWatch, pump, startHarness, validSettings, writeSettings, writeSettingsText } from './fixtures/p3-harness.ts';
import type { FakeSettingsWatch, Harness } from './fixtures/p3-harness.ts';

const RECORD_ENV = 'MOMONGA_SETTINGS_APPLIED';

const recordPath = (home: string): string => path.join(generationLayout(home, FIRST_GENERATION).dir, 'settings-applied.json');

const readRecord = (home: string): unknown => {
  const file = recordPath(home);
  if (!fs.existsSync(file)) throw new Error(`the supervisor wrote no applied record at ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
};

type Watched = Harness & { watch: FakeSettingsWatch };

const watched = async (context: CleanupContext): Promise<Watched> => {
  const watch = fakeSettingsWatch();
  const h = await startHarness(context, { settings: validSettings({ model: 'gpt-a' }), overrides: { watchSettings: true, settingsWatch: watch.watch } });
  await h.waitForState('gateway', 'ready', 10_000);
  await h.waitForState('runtime', 'ready', 10_000);
  await pump(h.timers, h.realWork, SETTINGS_DEBOUNCE_MS * 2);
  return Object.assign(h, { watch });
};

const settle = async (h: Watched): Promise<void> => {
  h.watch.fire();
  await pump(h.timers, h.realWork, SETTINGS_DEBOUNCE_MS + 50);
};

describe('S7: the supervisor writes the applied record (design-settings-live 15.1)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('writes the settings at its start, before any child is spawned, and hands every child the record path', async (context) => {
    const h = await watched(context);
    expect(readRecord(h.home)).toEqual(validSettings({ model: 'gpt-a' }));
    for (const role of ['gateway', 'runtime'] as const) expect(h.fake.latest(role).options.env?.[RECORD_ENV]).toBe(recordPath(h.home));
  });

  it('rewrites the record on a valid change', async (context) => {
    const h = await watched(context);
    writeSettings(h.home, validSettings({ model: 'gpt-bb' }));
    await settle(h);
    expect(readRecord(h.home)).toEqual(validSettings({ model: 'gpt-bb' }));
  });

  it('keeps the record on an invalid change', async (context) => {
    const h = await watched(context);
    writeSettings(h.home, validSettings({ model: 'gpt-bb' }));
    await settle(h);
    writeSettingsText(h.home, INVALID_SETTINGS_TEXT);
    await settle(h);
    expect(readRecord(h.home)).toEqual(validSettings({ model: 'gpt-bb' }));
  });

  it('the record seq starts at 1 and rises only when the recorded content changes', async (context) => {
    const h = await watched(context);
    const seqOf = (): unknown => (readRecord(h.home) as { seq?: unknown }).seq;
    expect(seqOf()).toBe(1);
    writeSettings(h.home, validSettings({ model: 'gpt-a' }));
    await settle(h);
    expect(seqOf()).toBe(1);
    writeSettings(h.home, validSettings({ model: 'gpt-bb' }));
    await settle(h);
    expect(seqOf()).toBe(2);
    writeSettingsText(h.home, INVALID_SETTINGS_TEXT);
    await settle(h);
    expect(seqOf()).toBe(2);
    expect((readRecord(h.home) as { settings?: unknown }).settings).toEqual(validSettings({ model: 'gpt-bb' }));
  });
});
