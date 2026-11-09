import { describe, expect, it } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, firstGeneration } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { SETTINGS_DEBOUNCE_MS } from '../src/constants.ts';
import { chatTarget, fakeSettingsWatch, httpOver, pump, startHarness, validSettings, writeSettings } from './fixtures/p3-harness.ts';
import type { FakeSettingsWatch, Harness, SimpleResponse } from './fixtures/p3-harness.ts';

const CREDENTIAL_ROUTE = '/v1/credentials/';
const DECLARED_LATER = 'MOMONGA_TEST_ADDED_TARGET_KEY';
const NEVER_DECLARED = 'MOMONGA_TEST_UNDECLARED_KEY';
const EXPORTED_AFTER_START = 'MOMONGA_TEST_EXPORTED_LATER_KEY';
const ADDED_KEY_VALUE = 'added-target-key-value';
const UNDECLARED_VALUE = 'undeclared-value';

type Watched = Harness & { watch: FakeSettingsWatch; startEnv: Record<string, string> };

const watched = async (context: CleanupContext): Promise<Watched> => {
  const watch = fakeSettingsWatch();
  const startEnv: Record<string, string> = { PATH: '/usr/bin:/bin', LANG: 'C', [DECLARED_LATER]: ADDED_KEY_VALUE, [NEVER_DECLARED]: UNDECLARED_VALUE };
  let home = '';
  const h = await startHarness(context, {
    prepare: (prepared) => {
      home = prepared;
      startEnv['HOME'] = home;
    },
    overrides: { watchSettings: true, settingsWatch: watch.watch, env: startEnv },
  });
  await h.waitForState('gateway', 'ready', 10_000);
  await h.waitForState('runtime', 'ready', 10_000);
  await pump(h.timers, h.realWork, SETTINGS_DEBOUNCE_MS * 2);
  return Object.assign(h, { watch, startEnv });
};

const declareTargetsWithKeys = async (h: Watched, ...names: string[]): Promise<void> => {
  const base = validSettings() as { models: { targets: Record<string, unknown>; aliases: Record<string, unknown> } };
  const added = Object.fromEntries(names.map((name, index) => [`added${index}`, chatTarget({ model: `gpt-added-${index}`, apiKeyEnv: name })]));
  writeSettings(h.home, { ...base, models: { ...base.models, targets: { ...base.models.targets, ...added } } });
  h.watch.fire();
  await pump(h.timers, h.realWork, SETTINGS_DEBOUNCE_MS + 50);
};

const askForCredential = (context: CleanupContext, h: Watched, name: string): Promise<SimpleResponse> =>
  h.realWork.run(() => httpOver(context, firstGeneration(h.paths).sockets.supervisor, 'GET', `${CREDENTIAL_ROUTE}${name}`));

describe('S6: the supervisor hands a declared environment credential to the gateway (design-settings-live section 12)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('a target added with apiKeyEnv naming a variable of the start environment gets its value with no restart', async (context) => {
    const h = await watched(context);
    await declareTargetsWithKeys(h, DECLARED_LATER);
    const response = await askForCredential(context, h, DECLARED_LATER);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toEqual({ name: DECLARED_LATER, value: ADDED_KEY_VALUE });
    expect(h.fake.spawnCount('gateway')).toBe(1);
    expect(h.fake.latest('gateway').signals).toEqual([]);
  });

  it('a name the settings do not declare is never handed over, even when the start environment has it', async (context) => {
    const h = await watched(context);
    await declareTargetsWithKeys(h, DECLARED_LATER);
    const response = await askForCredential(context, h, NEVER_DECLARED);
    expect(response.status).toBe(403);
    expect(response.text).not.toContain(UNDECLARED_VALUE);
  });

  it('a variable exported after the daemon started is not seen, even once it is declared', async (context) => {
    const h = await watched(context);
    h.startEnv[EXPORTED_AFTER_START] = 'exported-after-start';
    await declareTargetsWithKeys(h, DECLARED_LATER, EXPORTED_AFTER_START);
    expect((await askForCredential(context, h, DECLARED_LATER)).status).toBe(200);
    const response = await askForCredential(context, h, EXPORTED_AFTER_START);
    expect(response.status).toBe(404);
    expect(response.text).not.toContain('exported-after-start');
  });
});
