import { systemProcessPorts } from '../../src/process-ports.ts';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_STOP_VALUES, FIRST_GENERATION, momongaPaths } from '@momonga/foundation';
import { startGatewayProcess } from '@momonga/gateway';
import { FM_HOST, REAL_PROCESS_TEST_TIMEOUT_MS, createFakeFm, killGroupsForCleanup, registerOwned, testLocks } from '@momonga/testkit';
import { makeDir, postJson, readJson, registerCleanup, userInput } from '../gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, ccTarget, clientFor, homePaths, makeHome, modelsOf } from '../gateway-process-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

type DumpRecord = { argv: string[]; pid: number };

const OWN_NAME = 'not-listed';
const CHANGED_ID_TEXT = `The server apple of the model apple/${OWN_NAME} lists "system", not "${OWN_NAME}". Run /models add to add the model it serves now.`;

const serves = (file: string): DumpRecord[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as DumpRecord)
        .filter((record) => record.argv[0] === 'serve')
    : [];

const socketOf = (record: DumpRecord): string => record.argv[record.argv.indexOf('--socket') + 1] ?? '';

let settingsWrites = 0;

const replaceSettings = (home: string, value: unknown): void => {
  const { root, settings } = homePaths(home);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  settingsWrites += 1;
  const temporary = path.join(root, `.model-name-epochs-${process.pid}-${settingsWrites}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, settings);
};

describe('the name of a managed model over the epochs of the settings (gateway-accounts C36)', () => {
  it('a second server with the same own name changes no text of the first, and the first server is not started again', async () => {
    const fm = await createFakeFm({ dir: makeDir() });
    const dumpFile = path.join(path.dirname(fm.binaryPath), 'argv.jsonl');
    fm.configure({ envDumpFile: dumpFile });
    registerCleanup(() => killGroupsForCleanup(serves(dumpFile).map((record) => record.pid)));
    const home = makeHome();
    const apple = { adapter: 'managed', server: 'fm', model: OWN_NAME, binary: fm.binaryPath, toolCalling: 'native', capabilities: { contextWindow: 4096, maxOutputTokens: 512 } };
    const pear = ccTarget(path.join(makeDir(), 'no-server.sock'), { model: OWN_NAME, toolCalling: 'native' });
    replaceSettings(home, { models: modelsOf({ apple }) });
    const handle = await registerOwned(
      registerCleanup,
      () => startGatewayProcess({...systemProcessPorts, signal: new AbortController().signal,  ...FM_HOST, locks: testLocks(), generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, stdout: { write: () => true } }),
      (started) => started.close({ ...DEFAULT_STOP_VALUES, closeGraceMs: 0, managedServerStopGraceMs: 0 }),
    );
    const ask = async () => readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model: `apple/${OWN_NAME}`, input: userInput('hello') }));

    const alone = await ask();
    replaceSettings(home, { models: modelsOf({ apple, pear }) });
    const besideTheSecond = await ask();

    expect(alone.status).toBe(412);
    expect(alone.body.error.message).toBe(CHANGED_ID_TEXT);
    expect(besideTheSecond.body.error.message).toBe(CHANGED_ID_TEXT);
    expect(serves(dumpFile).map(socketOf)).toEqual([path.join(momongaPaths(home, FM_HOST.platform, {}).run, `g${FIRST_GENERATION}`, 'targets', 'apple-1.sock')]);
  });
});
