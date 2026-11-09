import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIRST_GENERATION, momongaPaths } from '@momonga/foundation';
import { DAEMON_PROCESS_TEST_TIMEOUT_MS, FAKE_SERVER, FAKE_SERVER_REFUSAL, FAKE_SERVER_REMEDY, createFakeFm, createFakeManagedServer, killGroupsForCleanup } from '@momonga/testkit';
import { makeDir, postJson, readJson, registerCleanup, userInput } from '../gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, isAlive, launchGateway, makeHome, until, writeSettings } from '../gateway-process-helpers.ts';
import type { GatewayProcessOptions } from '../gateway-process-helpers.ts';
import { fmServer } from './managed-support.ts';

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

const launch = (home: string, extra: Record<string, unknown> = {}) =>
  launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, ...extra } as GatewayProcessOptions);

describe('each managed target has its own serving instance, named by the target (design-managed-servers section 17, item 19; test T1)', { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('runs two servers for two targets of server "fm", on <target>.sock with markers under markers/targets/<target>', async () => {
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
    expect(serves.map((record) => path.basename(socketOf(record))).sort()).toEqual(['apple.sock', 'banana.sock']);
    const targets = momongaPaths(home, process.platform, {}).markers.targets;
    expect(fs.readdirSync(path.join(targets, 'apple'))).toHaveLength(1);
    expect(fs.readdirSync(path.join(targets, 'banana'))).toHaveLength(1);
    expect(fs.existsSync(path.join(targets, 'fm'))).toBe(false);
  });
});

describe('a second kind of server runs through the registration port with no branch on its id (design section 13.2)', { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS }, () => {
  const setup = async (keySet: boolean) => {
    const fake = await createFakeManagedServer({ dir: makeDir() });
    const dumpFile = path.join(path.dirname(fake.binaryPath), 'argv.jsonl');
    fake.configure({ keySet, envDumpFile: dumpFile });
    reapLaunched(dumpFile, 'run');
    const home = makeHome();
    writeSettings(home, { models: { targets: { workbench: { adapter: 'managed', server: 'fake', binary: fake.binaryPath, ...DECLARED } }, aliases: { default: ['workbench'] } } });
    const handle = await launch(home, { managedServers: [fmServer(), FAKE_SERVER] });
    return { home, dumpFile, handle, client: clientFor(handle.socketPath) };
  };

  it('answers a request through the fake server, launched as "run --socket <workbench.sock>", and stops it at close', async () => {
    const { home, dumpFile, handle, client } = await setup(true);
    expect((await readJson(await postJson(client, '/v1/responses', ask('default')))).status).toBe(200);
    const runs = launched(dumpFile, 'run');
    expect(runs).toHaveLength(1);
    expect(path.basename(socketOf(runs[0] as DumpRecord))).toBe('workbench.sock');
    await handle.close();
    await until(() => !isAlive((runs[0] as DumpRecord).pid), 'the fake server to exit');
    expect(fs.readdirSync(path.join(momongaPaths(home, process.platform, {}).markers.targets, 'workbench'))).toEqual([]);
  });

  it('refuses with 412, the description text and its remedy when the precondition of the second kind is not met', async () => {
    const { dumpFile, client } = await setup(false);
    const answered = await readJson(await postJson(client, '/v1/responses', ask('default')));
    expect(answered.status).toBe(412);
    const text = JSON.stringify(answered.body);
    expect(text).toContain(`the target \\"workbench\\" is not ready: ${FAKE_SERVER_REFUSAL}`);
    expect(text).toContain(FAKE_SERVER_REMEDY);
    expect(launched(dumpFile, 'run')).toEqual([]);
  });
});
