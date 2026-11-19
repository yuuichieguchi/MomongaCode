import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MODEL_ID_CHANGED_CODE } from '@momonga/protocol';
import { FM_HOST, REAL_PROCESS_TEST_TIMEOUT_MS, createFakeFm, killGroupsForCleanup } from '@momonga/testkit';
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
  const handle = await launchGateway({ ...FM_HOST, generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION });
  return readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model, input: userInput('hello fm') }));
};

describe('the model id a run sends to fm serve is the id of its entry', () => {
  it('is the entry id, which fm serve accepts when it lists it', async () => {
    const reply = await runThroughFakeFm({ models: modelsOf({ fm: { adapter: 'managed', server: 'fm', model: 'system', toolCalling: 'native' } }) }, 'fm/system');
    expect(reply.body.error ?? null).toBeNull();
    expect(reply.status).toBe(200);
  });

  it('is never another model: an entry whose id fm serve does not list is refused with 412 model_id_changed', async () => {
    const reply = await runThroughFakeFm({ models: modelsOf({ fm: { adapter: 'managed', server: 'fm', model: 'not-listed', toolCalling: 'native' } }) }, 'fm/not-listed');
    expect(reply.status).toBe(412);
    expect(reply.body.error).toMatchObject({ type: 'invalid_request', code: MODEL_ID_CHANGED_CODE, param: 'model' });
    expect(reply.body.error.message).toBe('The server fm of the model fm/not-listed lists "system", not "not-listed". Run momonga models add to add the model it serves now.');
  });
});
