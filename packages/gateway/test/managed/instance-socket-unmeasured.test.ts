import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIRST_GENERATION, momongaPaths, setSocketBind } from '@momonga/foundation';
import { TARGET_NOT_READY } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeFm, fakeExec } from '@momonga/testkit';
import { makeDir, postJson, readJson, userInput } from '../gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome, writeSettings, modelsOf } from '../gateway-process-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const DECLARED = { toolCalling: 'native', capabilities: { contextWindow: 4096, maxOutputTokens: 512 } };
const TARGET = 'fm';
const FIRST_INCARNATION_SUFFIX = '-1';

const instanceSockets = (home: string): string => path.join(momongaPaths(home, process.platform, {}).run, `g${FIRST_GENERATION}`, 'targets');

const instanceMarkers = (home: string, target: string): string => path.join(momongaPaths(home, process.platform, {}).markers.root, `g${FIRST_GENERATION}`, 'targets', target);

const realBind = (socketPath: string): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.close(() => {
        fs.rmSync(socketPath, { force: true });
        resolve();
      });
    });
  });

describe.skipIf(process.platform === 'win32')('an instance socket path that could not be measured refuses that target with the evidence of the bind measurement', () => {
  afterEach(() => setSocketBind(undefined));

  it('answers 412 target_not_ready with the could-not-be-tested text and creates no socket or marker for the target', async () => {
    const fm = await createFakeFm({ dir: makeDir() });
    const home = makeHome();
    const directory = instanceSockets(home);
    const socket = path.join(directory, `${TARGET}${FIRST_INCARNATION_SUFFIX}.sock`);
    writeSettings(home, { models: modelsOf({ [TARGET]: { adapter: 'managed', server: 'fm', model: 'system', binary: fm.binaryPath, ...DECLARED } }) });
    setSocketBind((candidate) =>
      path.dirname(candidate) === directory ? Promise.reject(Object.assign(new Error(`bind EACCES ${candidate}`), { code: 'EACCES' })) : realBind(candidate),
    );

    const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, exec: fakeExec });
    const client = clientFor(handle.socketPath);

    const refused = await readJson(await postJson(client, '/v1/responses', { model: `${TARGET}/system`, input: userInput('hello') }));
    expect(refused.status).toBe(412);
    expect(refused.body.error.code).toBe(TARGET_NOT_READY);
    expect(refused.body.error.message).toBe(`the model "system": a socket path of ${Buffer.byteLength(socket)} bytes could not be tested in ${directory}: EACCES`);
    expect(fs.existsSync(socket)).toBe(false);
    expect(fs.existsSync(instanceMarkers(home, `${TARGET}${FIRST_INCARNATION_SUFFIX}`))).toBe(false);
  });
});
