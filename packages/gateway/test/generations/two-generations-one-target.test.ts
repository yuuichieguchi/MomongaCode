import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { managedInstancePaths, momongaPaths } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeFm, fakeExec, killGroupsForCleanup } from '@momonga/testkit';
import { makeDir, postJson, readJson, registerCleanup, userInput } from '../gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, isAlive, launchGateway, makeHome, prepareHome, until, writeSettings, modelsOf } from '../gateway-process-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

type DumpRecord = { argv: string[]; pid: number };

const DECLARED = { toolCalling: 'native', capabilities: { contextWindow: 4096, maxOutputTokens: 512 } };
const ASK = { model: 'apple/system', input: userInput('hello') };

const servesIn = (file: string): DumpRecord[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as DumpRecord)
        .filter((record) => record.argv[0] === 'serve')
    : [];

const socketOf = (record: DumpRecord): string => record.argv[record.argv.indexOf('--socket') + 1] ?? '';

describe('two generations serve one managed target, each with its own instance (design-update 18.2.1 to 18.2.3, 20.57)', () => {
  it('gives each generation its own socket, lock and marker directory, and keeps the CLI instance outside every generation', () => {
    const paths = momongaPaths('/Users/someone', process.platform, {});
    const of = (generation: number) => managedInstancePaths(paths, { owner: 'gateway', generation, purpose: 'serve', provider: 'gateway', incarnation: 1 });
    const cli = managedInstancePaths(paths, { owner: 'cli', purpose: 'probe', provider: 'apple' });

    expect(of(1)).toEqual({
      socketPath: path.join(paths.run, 'g1', 'targets', 'gateway-1.sock'),
      lockPath: path.join(paths.run, 'g1', 'targets', 'gateway-1.lock'),
      markerDirectory: path.join(paths.markers.root, 'g1', 'targets', 'gateway-1'),
    });
    expect(of(2)).toEqual({
      socketPath: path.join(paths.run, 'g2', 'targets', 'gateway-1.sock'),
      lockPath: path.join(paths.run, 'g2', 'targets', 'gateway-1.lock'),
      markerDirectory: path.join(paths.markers.root, 'g2', 'targets', 'gateway-1'),
    });
    expect(cli).toEqual({
      socketPath: path.join(paths.run, '_cli-probe-apple.sock'),
      lockPath: path.join(paths.run, '_cli-probe-apple.lock'),
      markerDirectory: path.join(paths.markers.root, 'cli', 'probe-apple'),
    });
  });

  it('starts a child per generation on run/g<N>/targets/apple-1.sock, answers generation 2 while the child of generation 1 lives, and never signals that child', async () => {
    const fm = await createFakeFm({ dir: makeDir() });
    const dumpFile = path.join(path.dirname(fm.binaryPath), 'argv.jsonl');
    fm.configure({ envDumpFile: dumpFile });
    registerCleanup(() => killGroupsForCleanup(servesIn(dumpFile).map((record) => record.pid)));
    const home = makeHome();
    prepareHome(home, 2);
    writeSettings(home, { models: modelsOf({ apple: { adapter: 'managed', server: 'fm', model: 'system', binary: fm.binaryPath, ...DECLARED } }) });
    const paths = momongaPaths(home, process.platform, {});
    const launch = (generation: number) => launchGateway({ generation, home, env: baseEnv(home), version: PROCESS_VERSION, exec: fakeExec });

    const first = await launch(1);
    expect((await readJson(await postJson(clientFor(first.socketPath), '/v1/responses', ASK))).status).toBe(200);
    const [firstChild] = servesIn(dumpFile);
    const second = await launch(2);
    expect((await readJson(await postJson(clientFor(second.socketPath), '/v1/responses', ASK))).status).toBe(200);

    const serves = servesIn(dumpFile);
    expect(serves.map(socketOf)).toEqual([path.join(paths.run, 'g1', 'targets', 'apple-1.sock'), path.join(paths.run, 'g2', 'targets', 'apple-1.sock')]);
    expect(serves.map((record) => isAlive(record.pid))).toEqual([true, true]);
    expect(fs.readdirSync(path.join(paths.markers.root, 'g1', 'targets', 'apple-1'))).toHaveLength(1);
    expect(fs.readdirSync(path.join(paths.markers.root, 'g2', 'targets', 'apple-1'))).toHaveLength(1);

    await second.close();
    await until(() => !isAlive(serves[1]?.pid ?? 0), 'the child of generation 2 to stop with its gateway');
    expect(isAlive(firstChild?.pid ?? 0)).toBe(true);
    expect((await readJson(await postJson(clientFor(first.socketPath), '/v1/responses', ASK))).status).toBe(200);
  });
});
