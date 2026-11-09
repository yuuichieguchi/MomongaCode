import path from 'node:path';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DAEMON_PROCESS_TEST_TIMEOUT_MS, createFakeFm, fakeExec, killGroupsForCleanup } from '@momonga/testkit';
import { makeDir, postJson, readJson, registerCleanup, userInput } from './gateway-helpers.ts';
import { MINIMAL_PATH, PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome, writeSettings } from './gateway-process-helpers.ts';
import { saveFakeFmRecord } from './fm-record-support.ts';
import { FIRST_GENERATION } from '@momonga/foundation';

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

describe('an fm target renders no sampling field', { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('refuses temperature with a 400 naming the field and the target, instead of dropping it', async () => {
    const fm = await createFakeFm({ dir: makeDir() });
    const dumpFile = path.join(path.dirname(fm.binaryPath), 'env.jsonl');
    fm.configure({ envDumpFile: dumpFile });
    registerCleanup(() => killGroupsForCleanup(servePidsIn(dumpFile)));
    const home = makeHome();
    writeSettings(home, { models: { aliases: { default: ['local-fm'] }, targets: { 'local-fm': { adapter: 'managed', server: 'fm', toolCalling: 'native' } } } });
    await saveFakeFmRecord(home, 'local-fm', fm.binaryPath);
    const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home, { PATH: MINIMAL_PATH }), version: PROCESS_VERSION, fmBinary: fm.binaryPath, exec: fakeExec });
    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model: 'default', input: userInput('hello fm'), temperature: 0.2 }));
    expect(response.status).toBe(400);
    expect(response.body.error.type).toBe('invalid_request');
    expect(response.body.error.param).toBe('temperature');
    expect(response.body.error.message).toContain('temperature');
    expect(response.body.error.message).toContain('local-fm');
  });
});
