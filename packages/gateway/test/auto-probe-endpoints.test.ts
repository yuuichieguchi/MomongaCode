import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TARGET_NOT_READY, TARGET_PROBING } from '@momonga/protocol';
import { ProbeInProgressError, acquireProbeLock, endpointKeyOf, endpointLockKeyOf, probeEndpointTarget } from '@momonga/gateway';
import type { EndpointKey } from '@momonga/gateway';
import { REAL_PROCESS_TEST_TIMEOUT_MS, fakeExec } from '@momonga/testkit';
import { postJson, readJson, userInput } from './gateway-helpers.ts';
import { readFileTool, startFake } from './cc-support.ts';
import { PROCESS_VERSION, baseEnv, ccTarget, clientFor, launchGateway, makeHome, writeSettings } from './gateway-process-helpers.ts';
import { OLLAMA_MODEL, startFakeOllama } from './ollama-support.ts';
import { FIRST_GENERATION } from '@momonga/foundation';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const launchWith = async (target: Record<string, unknown>) => {
  const home = makeHome();
  writeSettings(home, { models: { aliases: { fast: ['local'] }, targets: { local: target } } });
  const measured: EndpointKey[] = [];
  const pending = <T,>(key: EndpointKey): Promise<T> => {
    measured.push(key);
    return new Promise<T>(() => undefined);
  };
  const handle = await launchGateway({
    generation: FIRST_GENERATION,
    home,
    env: baseEnv(home),
    version: PROCESS_VERSION,
    exec: fakeExec,
    measureEndpoint: ({ key }) => pending(key),
    measureOllama: ({ key }) => pending(key),
  });
  const client = clientFor(handle.socketPath);
  const ask = async () => readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('call read_file for a.txt'), tools: [readFileTool] }));
  return { home, measured, ask };
};

describe('P10 RecordUnderLock: every probe-able auto target takes the automatic probe and its lock', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('answers a chat-completions auto target with no record 503 target_probing and measures its endpoint key once', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const gateway = await launchWith(ccTarget(fake.socketPath, { toolCalling: 'auto' }));

    const [first, second] = [await gateway.ask(), await gateway.ask()];

    for (const response of [first, second]) {
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe(TARGET_PROBING);
    }
    expect(gateway.measured).toEqual([{ endpoint: `unix:${fake.socketPath}`, model: 'system' }]);
  });

  it('answers 412 target_not_ready with the endpoint remedy when the server answers but does not list the model, and measures nothing', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const gateway = await launchWith(ccTarget(fake.socketPath, { toolCalling: 'auto', model: 'not-served-here' }));

    const response = await gateway.ask();

    expect(response.status).toBe(412);
    expect(response.body.error.code).toBe(TARGET_NOT_READY);
    expect(response.body.error.message).toContain('not-served-here');
    expect(gateway.measured).toEqual([]);
  });

  it('answers an ollama target with no record 503 target_probing and measures its endpoint key', async () => {
    const fake = await startFakeOllama({ chat: [] });
    const gateway = await launchWith({ adapter: 'ollama', model: OLLAMA_MODEL, baseUrl: fake.origin, capabilities: { contextWindow: 12288, maxOutputTokens: 2048 } });

    const response = await gateway.ask();

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe(TARGET_PROBING);
    expect(gateway.measured).toEqual([{ endpoint: endpointKeyOf({ kind: 'tcp', baseUrl: fake.origin }), model: OLLAMA_MODEL }]);
  });

  it('refuses the CLI probe of a chat-completions target while another holder has the lock of its record, so no record is written outside the lock', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const probeRecordDir = path.join(makeHome(), 'probe');
    const key = { endpoint: `unix:${fake.socketPath}`, model: 'system' };
    const held = await acquireProbeLock(probeRecordDir, endpointLockKeyOf(key), 'system');

    const failure = await probeEndpointTarget({ probeRecordDir, upstream: { kind: 'unix', socketPath: fake.socketPath }, key, model: 'system', apiKey: undefined, samples: 1 }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProbeInProgressError);
    expect(fake.requests.filter((request) => request.path === '/v1/chat/completions')).toEqual([]);
    held.release();
  });
});
