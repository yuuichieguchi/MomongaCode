import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DAEMON_PROCESS_TEST_TIMEOUT_MS, createFakeFm, fakeExec, killGroupsForCleanup } from '@momonga/testkit';
import { makeDir, postJson, readJson, registerCleanup, userInput } from '../gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, isAlive, launchGateway, makeHome, writeSettings } from '../gateway-process-helpers.ts';
import type { GatewayProcessOptions } from '../gateway-process-helpers.ts';

type DumpRecord = { argv: string[]; pid: number };

const body = { model: 'default', input: userInput('hello fm') };

const readDump = (file: string): DumpRecord[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as DumpRecord)
    : [];

const serveRecords = (dumpFile: string): DumpRecord[] => readDump(dumpFile).filter((record) => record.argv[0] === 'serve');

const socketOf = (record: DumpRecord): string | undefined => record.argv[record.argv.indexOf('--socket') + 1];

const generationOptions = (options: GatewayProcessOptions, generation: number): GatewayProcessOptions => ({ ...options, generation } as GatewayProcessOptions);

describe('H5: fm serve runs once per generation on a generation-scoped socket', { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('gives the gateways of generations 1 and 2 their own fm serve, socket and marker directory at the same time', async () => {
    const fm = await createFakeFm({ dir: makeDir() });
    const dumpFile = path.join(path.dirname(fm.binaryPath), 'env.jsonl');
    fm.configure({ envDumpFile: dumpFile });
    registerCleanup(() => killGroupsForCleanup(serveRecords(dumpFile).map((record) => record.pid)));
    const home = makeHome();
    writeSettings(home, { models: { aliases: { default: ['fm'] }, targets: { fm: { adapter: 'fm', toolCalling: 'native' } } } });
    const options: GatewayProcessOptions = { home, env: baseEnv(home), version: PROCESS_VERSION, fmBinary: fm.binaryPath, exec: fakeExec };

    const first = await launchGateway(generationOptions(options, 1));
    expect((await readJson(await postJson(clientFor(first.socketPath), '/v1/responses', body))).status).toBe(200);
    const second = await launchGateway(generationOptions(options, 2));
    expect((await readJson(await postJson(clientFor(second.socketPath), '/v1/responses', body))).status).toBe(200);

    const run = path.join(home, '.momonga', 'run');
    expect(first.socketPath).toBe(path.join(run, 'g1', 'gateway.sock'));
    expect(second.socketPath).toBe(path.join(run, 'g2', 'gateway.sock'));
    const serves = serveRecords(dumpFile);
    expect(serves.map(socketOf).sort()).toEqual([path.join(run, 'g1', 'fm.sock'), path.join(run, 'g2', 'fm.sock')]);
    expect(serves.every((record) => isAlive(record.pid))).toBe(true);
    const markerDirectories = fs
      .readdirSync(run, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name === 'fm' && path.basename(entry.parentPath) === 'targets')
      .map((entry) => path.join(entry.parentPath, entry.name))
      .filter((directory) => fs.readdirSync(directory).length > 0);
    expect(markerDirectories).toHaveLength(2);
    expect(markerDirectories.map((directory) => fs.readdirSync(directory).length)).toEqual([1, 1]);
  });
});
