import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FIRST_GENERATION, momongaPaths } from '@momonga/foundation';
import { TARGET_NOT_READY } from '@momonga/protocol';
import { FM_HOST_PLATFORM, REAL_PROCESS_TEST_TIMEOUT_MS, createFakeFm, fakeExec, firstRefusedSocketPathBytes } from '@momonga/testkit';
import { makeDir, postJson, readJson, userInput } from '../gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome, writeSettings, modelsOf } from '../gateway-process-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const DECLARED = { toolCalling: 'native', capabilities: { contextWindow: 4096, maxOutputTokens: 512 } };
const FITTING_TARGET = 'fm';
const FIRST_INCARNATION_SUFFIX = '-1';

const instanceSockets = (home: string): string => path.join(momongaPaths(home, FM_HOST_PLATFORM, {}).run, `g${FIRST_GENERATION}`, 'targets');

const instanceMarkers = (home: string, target: string): string => path.join(momongaPaths(home, FM_HOST_PLATFORM, {}).markers.root, `g${FIRST_GENERATION}`, 'targets', target);

const targetNameWhoseSocketIs = (home: string, byteLength: number): string => {
  const prefix = Buffer.byteLength(path.join(instanceSockets(home), `x${FIRST_INCARNATION_SUFFIX}.sock`)) - 1;
  return `t${'n'.repeat(byteLength - prefix - 1)}`;
};

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const unfitText = (target: string, byteLength: number, directory: string): RegExp =>
  new RegExp(
    `^${escaped(`the model "${target}": its server socket path is ${byteLength} bytes, and the system refused to bind a socket path of that length in ${directory} (`)}(ENAMETOOLONG|EINVAL)${escaped('); choose a shorter server name')}$`,
  );

describe.skipIf(process.platform === 'win32')('an instance socket path that does not fit the platform refuses that target only, with the not-ready error of the bind measurement (design-update 20.58)', () => {
  it('starts the gateway, answers the long-path target 412 target_not_ready with the bind-measurement text, creates no socket or marker for it, and still serves the other target', async () => {
    const fm = await createFakeFm({ dir: makeDir() });
    const home = makeHome();
    const refusedBytes = await firstRefusedSocketPathBytes(home);
    const longTarget = targetNameWhoseSocketIs(home, refusedBytes);
    const longSocket = path.join(instanceSockets(home), `${longTarget}${FIRST_INCARNATION_SUFFIX}.sock`);
    expect(Buffer.byteLength(longSocket)).toBe(refusedBytes);
    writeSettings(home, {
      models: modelsOf({
          [longTarget]: { adapter: 'managed', server: 'fm', model: 'system', binary: fm.binaryPath, ...DECLARED },
          [FITTING_TARGET]: { adapter: 'managed', server: 'fm', model: 'system', binary: fm.binaryPath, ...DECLARED },
        }),
    });

    const handle = await launchGateway({ platform: FM_HOST_PLATFORM, generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, exec: fakeExec });
    const client = clientFor(handle.socketPath);

    const refused = await readJson(await postJson(client, '/v1/responses', { model: `${longTarget}/system`, input: userInput('hello') }));
    expect(refused.status).toBe(412);
    expect(refused.body.error.code).toBe(TARGET_NOT_READY);
    expect(refused.body.error.message).toMatch(unfitText(`${longTarget}/system`, refusedBytes, instanceSockets(home)));
    expect(fs.existsSync(longSocket)).toBe(false);
    expect(fs.existsSync(instanceMarkers(home, `${longTarget}${FIRST_INCARNATION_SUFFIX}`))).toBe(false);

    const served = await readJson(await postJson(client, '/v1/responses', { model: `${FITTING_TARGET}/system`, input: userInput('hello') }));
    expect(served.status).toBe(200);
  });
});
