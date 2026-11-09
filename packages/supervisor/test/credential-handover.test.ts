import { describe, expect, it } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, firstGeneration } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { SETTINGS_DEBOUNCE_MS } from '../src/constants.ts';
import { CREDENTIAL_CAPABILITY_ENV, CREDENTIAL_CAPABILITY_HEADER, createUdsClient, fixedSocket, minimalChildEnv } from '@momonga/foundation';
import { registerCleanup } from '@momonga/testkit';
import { chatTarget, fakeSettingsWatch, pump, pumpUntil, startHarness, validSettings, writeSettings } from './fixtures/p3-harness.ts';
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

const requestCredential = (context: CleanupContext, h: Watched, name: string, capability: string | undefined): Promise<SimpleResponse> =>
  h.realWork.run(async () => {
    const client = createUdsClient(fixedSocket(firstGeneration(h.paths).sockets.supervisor), { headersTimeoutMs: 5000 });
    registerCleanup(context, () => client.destroy());
    const response = await client.request({ method: 'GET', path: `${CREDENTIAL_ROUTE}${name}`, ...(capability === undefined ? {} : { headers: { [CREDENTIAL_CAPABILITY_HEADER]: capability } }) });
    const text = await response.text();
    await client.close();
    return { status: response.status, headers: response.headers, text };
  });

const gatewayCapability = (h: Watched): string => {
  const capability = h.fake.latest('gateway').options.env[CREDENTIAL_CAPABILITY_ENV];
  if (capability === undefined || capability.length < 32) throw new Error('the gateway was spawned without a credential capability');
  return capability;
};

const askForCredential = (context: CleanupContext, h: Watched, name: string): Promise<SimpleResponse> => requestCredential(context, h, name, gatewayCapability(h));

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

  it('a caller without the gateway capability gets no value, and the answer does not tell whether the name is declared', async (context) => {
    const h = await watched(context);
    await declareTargetsWithKeys(h, DECLARED_LATER);
    const declared = await requestCredential(context, h, DECLARED_LATER, undefined);
    const undeclared = await requestCredential(context, h, NEVER_DECLARED, undefined);
    const forged = await requestCredential(context, h, DECLARED_LATER, 'f'.repeat(gatewayCapability(h).length));
    for (const response of [declared, undeclared, forged]) {
      expect(response.status).toBe(403);
      expect(response.text).not.toContain(ADDED_KEY_VALUE);
      expect(response.text).not.toContain(UNDECLARED_VALUE);
    }
    expect(declared.text).toBe(undeclared.text);
    expect(forged.text).toBe(declared.text);
  });

  it('the capability is in the gateway environment only, and a process the gateway spawns does not inherit it', async (context) => {
    const h = await watched(context);
    const capability = gatewayCapability(h);
    expect(h.fake.latest('runtime').options.env[CREDENTIAL_CAPABILITY_ENV]).toBeUndefined();
    expect(Object.values(minimalChildEnv(h.fake.latest('gateway').options.env))).not.toContain(capability);
  });
});

describe('S6: the per-spawn capability ends with the child (design-settings-live 15.6)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('the capability of a gateway that exited answers nothing', async (context) => {
    const h = await watched(context);
    await declareTargetsWithKeys(h, DECLARED_LATER);
    const capability = gatewayCapability(h);
    expect((await requestCredential(context, h, DECLARED_LATER, capability)).status).toBe(200);
    await h.realWork.run(async () => {
      h.fake.latest('gateway').exit(1);
    });
    await pump(h.timers, h.realWork, 0);
    const response = await requestCredential(context, h, DECLARED_LATER, capability);
    expect(response.status).toBe(403);
    expect(response.text).not.toContain(ADDED_KEY_VALUE);
  });
});

describe('S6: the per-spawn capability ends when a stop has confirmed the child gone (design-settings-live 15.6)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('a gateway draining after SIGTERM keeps its capability; once its exit is confirmed the capability answers nothing', async (context) => {
    const h = await watched(context);
    await declareTargetsWithKeys(h, DECLARED_LATER);
    h.fake.setBehaviour('gateway', { autoReady: false, onTerm: 'ignore' });
    await h.realWork.run(async () => {
      h.fake.latest('gateway').exit(1);
    });
    await pumpUntil(h.timers, () => h.fake.spawnCount('gateway') === 2, { realWork: h.realWork, maxMs: 120_000, description: 'the gateway to be spawned again' });
    const capability = gatewayCapability(h);
    await h.realWork.run(async () => {
      h.fake.latest('gateway').ready({ service: 'not-the-gateway' });
    });
    await pumpUntil(h.timers, () => h.fake.latest('gateway').signals.includes('SIGTERM'), { realWork: h.realWork, maxMs: 120_000, description: 'the supervisor to stop the mismatched gateway' });
    expect((await requestCredential(context, h, DECLARED_LATER, capability)).status, 'a draining gateway is still alive').toBe(200);
    await h.realWork.run(async () => {
      h.fake.latest('gateway').exit(0);
    });
    await pump(h.timers, h.realWork, 0);
    const response = await requestCredential(context, h, DECLARED_LATER, capability);
    expect(response.status).toBe(403);
    expect(response.text).not.toContain(ADDED_KEY_VALUE);
  });
});
