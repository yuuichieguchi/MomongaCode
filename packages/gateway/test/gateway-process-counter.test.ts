import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadUserSettings } from '@momonga/config';
import { SECURITY_BINARY, codeDigestOfRunningProcess, FIRST_GENERATION } from '@momonga/foundation';
import { saveEndpointRecord, targetCounterOf } from '@momonga/gateway';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeSecurityPort } from '@momonga/testkit';
import { startFake } from './cc-support.ts';
import { getJson, listedCountersOf } from './gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, ccTarget, clientFor, fakeSecretHost, homePaths, launchGateway, makeHome, portOnSecretHost, writeSettings, modelsOf } from './gateway-process-helpers.ts';
import type { SecretHostProgram } from './gateway-process-helpers.ts';
import { makeReport } from './report-fixture.ts';
import { CURRENT_DIALECTS } from './dialect-currency.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const KEY_VARIABLE = 'MOMONGA_COUNTER_TEST_KEY';
const SECRET_NAME = 'counter-test-secret';
const IDENTITY_FIELDS = ['id', 'object', 'owned_by'];
const KEYCHAIN_HOST: SecretHostProgram = { program: 'security', canonicalBinary: SECURITY_BINARY, extraEnv: {} };

const listedCounters = async (socketPath: string): Promise<Record<string, string>> => {
  const models = await getJson(clientFor(socketPath), '/v1/momonga/models');
  return listedCountersOf(models.body, 'primary/system');
};

const resolvedSettings = async (home: string) => (await loadUserSettings({ home, signal: new AbortController().signal })).settings;

const resolvedPrimary = async (home: string) => {
  const target = (await resolvedSettings(home)).models.models.get('primary/system');
  if (target === undefined) throw new Error('the settings resolved no primary target');
  return target;
};

const resolvedOutputPolicy = async (home: string) => ({ unboundedOutputReserve: (await resolvedSettings(home)).context.unboundedOutputReserve });

describe('the counters a started gateway lists', () => {
  it('derives a target counter from its resolved definition and the code digest of the running gateway', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const home = makeHome();
    writeSettings(home, { models: modelsOf({ primary: ccTarget(fake.socketPath, { toolCalling: 'native' }) }) });
    const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION });

    const counters = await listedCounters(handle.socketPath);

    expect(counters).toEqual({ 'primary/system': targetCounterOf({ target: await resolvedPrimary(home), codeDigest: await codeDigestOfRunningProcess() }) });
  });

  it('keeps the value of a key out of the counter: two values of the same apiKeyEnv give the same counter', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const settings = { models: modelsOf({ primary: ccTarget(fake.socketPath, { toolCalling: 'native', apiKeyEnv: KEY_VARIABLE }) }) };
    const firstHome = makeHome();
    writeSettings(firstHome, settings);
    const secondHome = makeHome();
    writeSettings(secondHome, settings);

    const first = await launchGateway({ generation: FIRST_GENERATION, home: firstHome, env: baseEnv(firstHome, { [KEY_VARIABLE]: 'first-value-of-the-key' }), version: PROCESS_VERSION });
    const firstCounters = await listedCounters(first.socketPath);
    await first.close();
    const second = await launchGateway({ generation: FIRST_GENERATION, home: secondHome, env: baseEnv(secondHome, { [KEY_VARIABLE]: 'second-value-of-the-key' }), version: PROCESS_VERSION });
    const secondCounters = await listedCounters(second.socketPath);

    expect(firstCounters['primary/system']).toMatch(/^[0-9a-f]{64}$/);
    expect(secondCounters).toEqual(firstCounters);
  });

  it('keeps the value of a stored secret out of the counter: two values of the same apiKeySecret give the same counter', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const settings = { models: modelsOf({ primary: ccTarget(fake.socketPath, { toolCalling: 'native', apiKeySecret: SECRET_NAME }) }) };
    const launchWithSecret = async (value: string) => {
      const home = makeHome();
      writeSettings(home, settings);
      const host = fakeSecretHost(makeHome(), KEYCHAIN_HOST);
      const security = portOnSecretHost(createFakeSecurityPort(() => ({ [SECRET_NAME]: value })), KEYCHAIN_HOST, host);
      const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home, host.env), version: PROCESS_VERSION, execWithStdin: security });
      const counters = await listedCounters(handle.socketPath);
      await handle.close();
      return { counters, reads: security.calls };
    };

    const first = await launchWithSecret('first-value-of-the-secret');
    const second = await launchWithSecret('second-value-of-the-secret');

    expect(first.reads).toEqual([]);
    expect(second.reads).toEqual([]);
    expect(first.counters['primary/system']).toMatch(/^[0-9a-f]{64}$/);
    expect(second.counters).toEqual(first.counters);
  });

  it('covers the upstream identity of the probe record of a probed endpoint target, and changes with a newly saved record', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const settings = { models: modelsOf({ primary: ccTarget(fake.socketPath, { toolCalling: 'auto' }) }) };
    const key = { endpoint: `unix:${fake.socketPath}`, model: 'system' };
    const launchWithRecord = async (identity: string) => {
      const home = makeHome();
      writeSettings(home, settings);
      await saveEndpointRecord(path.join(homePaths(home).root, 'state', 'probe'), key, identity, IDENTITY_FIELDS, makeReport(1, 1), CURRENT_DIALECTS);
      const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION });
      const counters = await listedCounters(handle.socketPath);
      await handle.close();
      return { counters, target: await resolvedPrimary(home), outputPolicy: await resolvedOutputPolicy(home) };
    };

    const one = await launchWithRecord('identity-one');
    const two = await launchWithRecord('identity-two');

    const codeDigest = await codeDigestOfRunningProcess();
    expect(one.counters).toEqual({ 'primary/system': targetCounterOf({ target: one.target, codeDigest, upstreamIdentity: 'identity-one', outputPolicy: one.outputPolicy }) });
    expect(two.counters).toEqual({ 'primary/system': targetCounterOf({ target: two.target, codeDigest, upstreamIdentity: 'identity-two', outputPolicy: two.outputPolicy }) });
    expect(two.counters['primary/system']).not.toBe(one.counters['primary/system']);
  });
});
