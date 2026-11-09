import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DAEMON_PROCESS_TEST_TIMEOUT_MS, createFakeFm, fakeExec, killGroupsForCleanup } from '@momonga/testkit';
import { makeDir, postJson, readJson, registerCleanup, userInput } from './gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome, writeSettings } from './gateway-process-helpers.ts';
import { saveFakeFmRecord } from './fm-record-support.ts';
import { FIRST_GENERATION } from '@momonga/foundation';

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

const runThroughFakeFm = async (settings: unknown, alias: string, target: string) => {
  const fm = await createFakeFm({ dir: makeDir() });
  const dumpFile = path.join(path.dirname(fm.binaryPath), 'env.jsonl');
  fm.configure({ envDumpFile: dumpFile });
  registerCleanup(() => killGroupsForCleanup(servePidsOf(dumpFile)));
  const home = makeHome();
  writeSettings(home, settings);
  await saveFakeFmRecord(home, target, fm.binaryPath);
  const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, fmBinary: fm.binaryPath, exec: fakeExec });
  return readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model: alias, input: userInput('hello fm') }));
};

describe('the model id a run sends to fm serve', { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('is a model fm serve lists, for the fm target the person configured under the alias default', async () => {
    const reply = await runThroughFakeFm({ models: { targets: { fm: { adapter: 'fm', toolCalling: 'native' } }, aliases: { default: ['fm'] } } }, 'default', 'fm');
    expect(reply.body.error ?? null).toBeNull();
    expect(reply.status).toBe(200);
    expect(reply.body.status).toBe('completed');
  });

  it('is a model fm serve lists, whatever the alias and the target are named', async () => {
    const reply = await runThroughFakeFm({ models: { targets: { apple: { adapter: 'fm', toolCalling: 'native' } }, aliases: { work: ['apple'] } } }, 'work', 'apple');
    expect(reply.body.error ?? null).toBeNull();
    expect(reply.status).toBe(200);
    expect(reply.body.status).toBe('completed');
  });
});
