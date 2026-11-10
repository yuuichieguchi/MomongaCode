import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeFm, fakeExec, killGroupsForCleanup } from '@momonga/testkit';
import { makeDir, postJson, readJson, registerCleanup, userInput } from './gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome, writeSettings, modelsOf } from './gateway-process-helpers.ts';
import { placeFakeFm } from './fm-record-support.ts';
import { FIRST_GENERATION } from '@momonga/foundation';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const servePidsOf = (dumpFile: string): number[] =>
  fs.existsSync(dumpFile)
    ? fs
        .readFileSync(dumpFile, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as { argv: string[]; pid: number })
        .filter((record) => record.argv[0] === 'serve')
        .map((record) => record.pid)
    : [];

const runThroughFakeFm = async (settings: unknown, model: string) => {
  const fm = await createFakeFm({ dir: makeDir() });
  const dumpFile = path.join(path.dirname(fm.binaryPath), 'env.jsonl');
  fm.configure({ envDumpFile: dumpFile });
  registerCleanup(() => killGroupsForCleanup(servePidsOf(dumpFile)));
  const home = makeHome();
  writeSettings(home, settings);
  await placeFakeFm(home, fm.binaryPath);
  const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, exec: fakeExec });
  return readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model, input: userInput('hello fm') }));
};

describe('the model id a run sends to fm serve', () => {
  it('is a model fm serve lists, for the fm model named by its full reference', async () => {
    const reply = await runThroughFakeFm({ models: modelsOf({ fm: { adapter: 'managed', server: 'fm', model: 'system', toolCalling: 'native' } }) }, 'fm/system');
    expect(reply.body.error ?? null).toBeNull();
    expect(reply.status).toBe(200);
    expect(reply.body.status).toBe('completed');
  });

  it('is a model fm serve lists, whatever the server is named, by its own name alone', async () => {
    const reply = await runThroughFakeFm({ models: modelsOf({ apple: { adapter: 'managed', server: 'fm', model: 'system', toolCalling: 'native' } }) }, 'system');
    expect(reply.body.error ?? null).toBeNull();
    expect(reply.status).toBe(200);
    expect(reply.body.status).toBe('completed');
  });
});
