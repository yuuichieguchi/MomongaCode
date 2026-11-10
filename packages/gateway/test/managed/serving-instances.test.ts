import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FIRST_GENERATION, momongaPaths } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, FAKE_SERVER, FAKE_SERVER_KEY_MISSING_EXIT, FAKE_SERVER_REFUSAL, FAKE_SERVER_REMEDY, createFakeFm, createFakeManagedServer, fakeExec, killGroupsForCleanup } from '@momonga/testkit';
import { makeDir, postJson, readJson, registerCleanup, userInput } from '../gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, isAlive, launchGateway, makeHome, until, writeSettings } from '../gateway-process-helpers.ts';
import type { GatewayProcessOptions } from '../gateway-process-helpers.ts';
import { runPreconditions } from '../../src/managed/preconditions.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

type DumpRecord = { argv: string[]; pid: number };

const DECLARED = { toolCalling: 'native', capabilities: { contextWindow: 4096, maxOutputTokens: 512 } };

const readDump = (file: string): DumpRecord[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as DumpRecord)
    : [];

const launched = (file: string, command: string): DumpRecord[] => readDump(file).filter((record) => record.argv[0] === command);

const socketOf = (record: DumpRecord): string => record.argv[record.argv.indexOf('--socket') + 1] ?? '';

const reapLaunched = (file: string, command: string): void => {
  registerCleanup(() => killGroupsForCleanup(launched(file, command).map((record) => record.pid)));
};

const ask = (model: string) => ({ model, input: userInput('hello') });

const generationTargets = (home: string): { sockets: string; markers: string } => {
  const paths = momongaPaths(home, process.platform, {});
  return { sockets: path.join(paths.run, `g${FIRST_GENERATION}`, 'targets'), markers: path.join(paths.markers.root, `g${FIRST_GENERATION}`, 'targets') };
};

const launch = (home: string, extra: Record<string, unknown> = {}) =>
  launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, ...extra } as GatewayProcessOptions);

describe('each managed target has its own serving instance, named by the target (design-managed-servers section 17, item 19; test T1)', () => {
  it('runs two servers for two targets of server "fm", on run/g<N>/targets/<target>-<k>.sock with markers under markers/g<N>/targets/<target>-<k> (rule 18.2.1, design-settings-live 3.1)', async () => {
    const fm = await createFakeFm({ dir: makeDir() });
    const dumpFile = path.join(path.dirname(fm.binaryPath), 'argv.jsonl');
    fm.configure({ envDumpFile: dumpFile });
    reapLaunched(dumpFile, 'serve');
    const home = makeHome();
    writeSettings(home, {
      models: {
        targets: {
          apple: { adapter: 'managed', server: 'fm', binary: fm.binaryPath, ...DECLARED },
          banana: { adapter: 'managed', server: 'fm', binary: fm.binaryPath, ...DECLARED },
        },
        aliases: { default: ['apple'], second: ['banana'] },
      },
    });
    const handle = await launch(home);
    const client = clientFor(handle.socketPath);
    expect((await readJson(await postJson(client, '/v1/responses', ask('default')))).status).toBe(200);
    expect((await readJson(await postJson(client, '/v1/responses', ask('second')))).status).toBe(200);
    const serves = launched(dumpFile, 'serve');
    const places = generationTargets(home);
    expect(serves.map(socketOf).sort()).toEqual([path.join(places.sockets, 'apple-1.sock'), path.join(places.sockets, 'banana-1.sock')]);
    expect(fs.readdirSync(path.join(places.markers, 'apple-1'))).toHaveLength(1);
    expect(fs.readdirSync(path.join(places.markers, 'banana-1'))).toHaveLength(1);
    expect(fs.existsSync(path.join(places.markers, 'fm'))).toBe(false);
    expect(fs.existsSync(momongaPaths(home, process.platform, {}).markers.targets)).toBe(false);
    expect(fs.existsSync(path.join(momongaPaths(home, process.platform, {}).run, 'managed-locks'))).toBe(false);
  });
});

describe('a second kind of server, declared in the user settings, runs through the one registry with no branch on its id (design sections 13.2, 19.12)', () => {
  it('answers a request through the fake server, launched as "run --socket run/g<N>/targets/workbench-1.sock", and stops it at close', async () => {
    const fake = await createFakeManagedServer({ dir: makeDir() });
    const dumpFile = path.join(path.dirname(fake.binaryPath), 'argv.jsonl');
    fake.configure({ envDumpFile: dumpFile });
    reapLaunched(dumpFile, 'run');
    const home = makeHome();
    writeSettings(home, {
      models: {
        servers: { fake: { command: fake.binaryPath, args: ['run', '--socket', '{socket}'], readyPath: '/ready' } },
        targets: { workbench: { adapter: 'managed', server: 'fake', model: 'fake-1', ...DECLARED } },
        aliases: { default: ['workbench'] },
      },
    });
    const handle = await launch(home, { exec: fakeExec });
    const client = clientFor(handle.socketPath);
    expect((await readJson(await postJson(client, '/v1/responses', ask('default')))).status).toBe(200);
    const runs = launched(dumpFile, 'run');
    expect(runs).toHaveLength(1);
    expect(socketOf(runs[0] as DumpRecord)).toBe(path.join(generationTargets(home).sockets, 'workbench-1.sock'));
    await handle.close();
    await until(() => !isAlive((runs[0] as DumpRecord).pid), 'the fake server to exit');
    expect(fs.readdirSync(path.join(generationTargets(home).markers, 'workbench-1'))).toEqual([]);
  });
});

describe('the generic precondition runner follows the description it is given, with no branch on its id (design section 13.2; 19.14 items 1 and 16d)', () => {
  const answering = (exitCode: number) => {
    const calls: { file: string; args: readonly string[] }[] = [];
    const exec = async (file: string, args: readonly string[]) => {
      calls.push({ file, args });
      return { exitCode, stdout: '', stderr: exitCode === 0 ? '' : 'FAKE_KEY is not set' };
    };
    return { calls, exec };
  };

  it('refuses with the description text and its remedy when the precondition command exits with the refused code', async () => {
    const { calls, exec } = answering(FAKE_SERVER_KEY_MISSING_EXIT);
    expect(await runPreconditions(FAKE_SERVER, '/opt/fake/bin/fake-server', exec, AbortSignal.timeout(30_000))).toEqual({
      kind: 'refused',
      message: FAKE_SERVER_REFUSAL,
      detail: 'FAKE_KEY is not set',
      remedy: FAKE_SERVER_REMEDY,
    });
    expect(calls).toEqual([{ file: '/opt/fake/bin/fake-server', args: ['check-env'] }]);
  });

  it('is met when the precondition command exits 0', async () => {
    const { exec } = answering(0);
    expect(await runPreconditions(FAKE_SERVER, '/opt/fake/bin/fake-server', exec, AbortSignal.timeout(30_000))).toEqual({ kind: 'met' });
  });

  it('runs no command for a description with no preconditions, as a declared server has', async () => {
    const { calls, exec } = answering(FAKE_SERVER_KEY_MISSING_EXIT);
    expect(await runPreconditions({ ...FAKE_SERVER, preconditions: [] }, '/opt/fake/bin/fake-server', exec, AbortSignal.timeout(30_000))).toEqual({ kind: 'met' });
    expect(calls).toEqual([]);
  });
});
