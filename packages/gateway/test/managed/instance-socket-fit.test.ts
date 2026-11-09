import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIRST_GENERATION, SocketPathUnsupportedError, momongaPaths, socketPathLimit } from '@momonga/foundation';
import { DAEMON_PROCESS_TEST_TIMEOUT_MS, createFakeFm, fakeExec } from '@momonga/testkit';
import { makeDir } from '../gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, launchGateway, makeHome, writeSettings } from '../gateway-process-helpers.ts';
import type { GatewayProcessOptions } from '../gateway-process-helpers.ts';

const DECLARED = { toolCalling: 'native', capabilities: { contextWindow: 4096, maxOutputTokens: 512 } };

const instanceSockets = (home: string): string => path.join(momongaPaths(home, process.platform, {}).run, `g${FIRST_GENERATION}`, 'targets');

const targetNameWhoseSocketIs = (home: string, byteLength: number): string => {
  const prefix = Buffer.byteLength(path.join(instanceSockets(home), 'x.sock')) - 1;
  return `t${'n'.repeat(byteLength - prefix - 1)}`;
};

describe.skipIf(process.platform === 'win32')('an instance socket path that does not fit the platform is refused at load with the socket-fit rule of I2 (design-managed-servers section 18, item 4)', { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('refuses the configuration with SocketPathUnsupportedError naming the instance socket, launches no server and creates no marker directory for it', async () => {
    const fm = await createFakeFm({ dir: makeDir() });
    const home = makeHome();
    const limit = socketPathLimit(process.platform);
    const target = targetNameWhoseSocketIs(home, limit + 1);
    const socket = path.join(instanceSockets(home), `${target}.sock`);
    expect(Buffer.byteLength(socket)).toBe(limit + 1);
    writeSettings(home, { models: { targets: { [target]: { adapter: 'managed', server: 'fm', binary: fm.binaryPath, ...DECLARED } }, aliases: { default: [target] } } });

    const error = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, exec: fakeExec } as GatewayProcessOptions).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SocketPathUnsupportedError);
    expect((error as Error).message).toMatch(/^Unix socket path .* must be shorter than \d+ bytes/);
    expect((error as Error).message).toContain(socket);
    expect(fs.existsSync(socket)).toBe(false);
    expect(fs.existsSync(path.join(momongaPaths(home, process.platform, {}).markers.root, `g${FIRST_GENERATION}`, 'targets', target))).toBe(false);
  });
});
