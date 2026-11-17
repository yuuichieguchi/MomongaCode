import path from 'node:path';
import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { FM_HOST, REAL_PROCESS_TEST_TIMEOUT_MS, createFakeFm, killGroupsForCleanup } from '@momonga/testkit';
import { makeDir, postJson, readJson, registerCleanup, userInput } from './gateway-helpers.ts';
import { MINIMAL_PATH, PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome, writeSettings, modelsOf } from './gateway-process-helpers.ts';
import { placeFakeFm } from './fm-record-support.ts';
import { FIRST_GENERATION } from '@momonga/foundation';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const servePidsIn = (dumpFile: string): number[] =>
  fs.existsSync(dumpFile)
    ? fs
        .readFileSync(dumpFile, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as { argv: string[]; pid: number })
        .filter((record) => record.argv[0] === 'serve')
        .map((record) => record.pid)
    : [];

describe('an fm target renders no sampling field', () => {
  it('refuses temperature with a 400 naming the field and the model, instead of dropping it', async () => {
    const fm = await createFakeFm({ dir: makeDir() });
    const dumpFile = path.join(path.dirname(fm.binaryPath), 'env.jsonl');
    fm.configure({ envDumpFile: dumpFile });
    registerCleanup(() => killGroupsForCleanup(servePidsIn(dumpFile)));
    const home = makeHome();
    writeSettings(home, { models: modelsOf({ 'local-fm': { adapter: 'managed', server: 'fm', model: 'system', toolCalling: 'native' } }) });
    await placeFakeFm(home, fm.binaryPath);
    const handle = await launchGateway({ ...FM_HOST, generation: FIRST_GENERATION, home, env: baseEnv(home, { PATH: MINIMAL_PATH }), version: PROCESS_VERSION });
    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model: 'local-fm/system', input: userInput('hello fm'), temperature: 0.2 }));
    expect(response.status).toBe(400);
    expect(response.body.error.type).toBe('invalid_request');
    expect(response.body.error.param).toBe('temperature');
    expect(response.body.error.message).toContain('temperature');
    expect(response.body.error.message).toContain('model "system"');
  });
});
