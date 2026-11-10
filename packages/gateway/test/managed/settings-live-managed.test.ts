import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FIRST_GENERATION, managedInstancePaths, momongaPaths } from '@momonga/foundation';
import type { ManagedInstance } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeFm, killGroupsForCleanup, waitFor } from '@momonga/testkit';
import type { FakeFm } from '@momonga/testkit';
import { makeDir, postJson, registerCleanup, userInput } from '../gateway-helpers.ts';
import { startGatewayProcess } from '@momonga/gateway';
import { PROCESS_VERSION, baseEnv, clientFor, homePaths, isAlive, makeHome } from '../gateway-process-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

type DumpRecord = { argv: string[]; pid: number };

const declared = (maxOutputTokens: number) => ({ toolCalling: 'native', capabilities: { contextWindow: 4096, maxOutputTokens } });

const readDump = (file: string): DumpRecord[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as DumpRecord)
    : [];

const serves = (file: string): DumpRecord[] => readDump(file).filter((record) => record.argv[0] === 'serve');

const socketOf = (record: DumpRecord): string => record.argv[record.argv.indexOf('--socket') + 1] ?? '';

let settingsWrites = 0;

const replaceSettings = (home: string, value: unknown): void => {
  const { root, settings } = homePaths(home);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  settingsWrites += 1;
  const temporary = path.join(root, `.settings-live-${process.pid}-${settingsWrites}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value)}${' '.repeat(settingsWrites)}`, { mode: 0o600 });
  fs.renameSync(temporary, settings);
};

const ask = (model: string) => ({ model, input: userInput('hello') });

const targetsDirectory = (home: string): string => path.join(momongaPaths(home, process.platform, {}).run, `g${FIRST_GENERATION}`, 'targets');

type Setup = { fm: FakeFm; dumpFile: string; home: string };

const setup = async (): Promise<Setup> => {
  const fm = await createFakeFm({ dir: makeDir() });
  const dumpFile = path.join(path.dirname(fm.binaryPath), 'argv.jsonl');
  fm.configure({ envDumpFile: dumpFile, serve: { latencyMs: 5000 } });
  registerCleanup(() => killGroupsForCleanup(serves(dumpFile).map((record) => record.pid)));
  return { fm, dumpFile, home: makeHome() };
};

const launch = async (home: string) => {
  const handle = await startGatewayProcess({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, stdout: { write: () => true } });
  registerCleanup(async () => {
    await handle.close({ closeGraceMs: 0, managedServerStopGraceMs: 0 });
  });
  return handle;
};

describe('S1 managed incarnations: the stem of a serving instance names its incarnation (design-settings-live 3.1)', () => {
  it('managedInstancePaths gives <target>-<k> for the k-th incarnation of a serving instance', () => {
    const paths = momongaPaths('/home/u', 'darwin', {});
    const instance = (incarnation: number): ManagedInstance => ({ owner: 'gateway', generation: 1, purpose: 'serve', target: 'apple', incarnation }) as unknown as ManagedInstance;
    expect(path.basename(managedInstancePaths(paths, instance(1)).socketPath)).toBe('apple-1.sock');
    expect(path.basename(managedInstancePaths(paths, instance(2)).lockPath)).toBe('apple-2.lock');
    expect(path.basename(managedInstancePaths(paths, instance(2)).markerDirectory)).toBe('apple-2');
  });

  it('the probe stem does not change', () => {
    const paths = momongaPaths('/home/u', 'darwin', {});
    const probe = { owner: 'gateway', generation: 1, purpose: 'probe', target: 'apple' } as ManagedInstance;
    expect(path.basename(managedInstancePaths(paths, probe).socketPath)).toBe('_probe-apple.sock');
  });
});

describe('S1 managed targets under a settings change (design-settings-live 3.1)', () => {
  it('a changed managed definition starts a second incarnation while the first call is in flight, and the new request does not wait on the old lock', async () => {
    const { fm, dumpFile, home } = await setup();
    replaceSettings(home, { models: { targets: { apple: { adapter: 'managed', server: 'fm', binary: fm.binaryPath, ...declared(512) } }, aliases: { default: ['apple'] } } });
    const handle = await launch(home);
    const inFlight = postJson(clientFor(handle.socketPath), '/v1/responses', ask('default')).then((response) => response.status, () => -1);
    await waitFor(() => serves(dumpFile).length === 1, { description: 'the first incarnation to start' });
    replaceSettings(home, { models: { targets: { apple: { adapter: 'managed', server: 'fm', binary: fm.binaryPath, ...declared(256) } }, aliases: { default: ['apple'] } } });
    const answered = postJson(clientFor(handle.socketPath), '/v1/responses', ask('default')).then((response) => response.status, () => -1);
    await waitFor(() => serves(dumpFile).length === 2, { maxTurns: 50_000, description: 'a second incarnation to start for the changed definition' });
    expect(serves(dumpFile).map(socketOf)).toEqual([path.join(targetsDirectory(home), 'apple-1.sock'), path.join(targetsDirectory(home), 'apple-2.sock')]);
    expect(await answered).toBe(200);
    expect(await inFlight).toBe(200);
  });

  it('a removed target serves its in-flight call to the end, and its server stops after that last lease ends', async () => {
    const { fm, dumpFile, home } = await setup();
    const banana = { adapter: 'managed', server: 'fm', binary: fm.binaryPath, ...declared(256) };
    replaceSettings(home, { models: { targets: { apple: { adapter: 'managed', server: 'fm', binary: fm.binaryPath, ...declared(512) }, banana }, aliases: { default: ['apple'], second: ['banana'] } } });
    const handle = await launch(home);
    const inFlight = postJson(clientFor(handle.socketPath), '/v1/responses', ask('default')).then(async (response) => ({ status: response.status, text: await response.text() }));
    await waitFor(() => serves(dumpFile).length === 1, { description: 'the apple server to start' });
    const apple = serves(dumpFile)[0] as DumpRecord;
    replaceSettings(home, { models: { targets: { banana }, aliases: { second: ['banana'] } } });
    const next = await postJson(clientFor(handle.socketPath), '/v1/responses', ask('second'));
    expect(next.status).toBe(200);
    await next.text();
    expect((await inFlight).status).toBe(200);
    await waitFor(() => !isAlive(apple.pid), { maxTurns: 50_000, description: 'the removed target server to stop after its last lease ended' });
  });

  it('an edit a to b to a with a call in flight on a keeps one managed server for the counter of a (design-settings-live 15.4)', async () => {
    const { fm, dumpFile, home } = await setup();
    const releaseFile = path.join(makeDir(), 'release-first-reply');
    const release = (): void => fs.writeFileSync(releaseFile, '');
    fm.configure({ envDumpFile: dumpFile, serve: { holdFirstUntilFile: releaseFile } });
    const settingsWith = (maxOutputTokens: number) => ({ models: { targets: { apple: { adapter: 'managed', server: 'fm', binary: fm.binaryPath, admissionTimeoutMs: 1, ...declared(maxOutputTokens) } }, aliases: { default: ['apple'] } } });
    try {
      replaceSettings(home, settingsWith(512));
      const handle = await launch(home);
      const statusOf = (pending: Promise<{ status: number }>) => pending.then((response) => response.status, () => -1);
      let firstSettled = false;
      const first = statusOf(postJson(clientFor(handle.socketPath), '/v1/responses', ask('default'))).finally(() => {
        firstSettled = true;
      });
      await waitFor(() => serves(dumpFile).length === 1, { description: 'the first incarnation to start' });
      fm.configure({ envDumpFile: dumpFile, serve: {} });
      replaceSettings(home, settingsWith(256));
      let secondStatus = 0;
      void statusOf(postJson(clientFor(handle.socketPath), '/v1/responses', ask('default'))).then((status) => {
        secondStatus = status;
      });
      await waitFor(() => secondStatus !== 0, { description: 'the request of the epoch of b to end while the call pinned to apple-1 is still running' });
      expect(secondStatus).toBe(200);
      replaceSettings(home, settingsWith(512));
      const third = statusOf(postJson(clientFor(handle.socketPath), '/v1/responses', ask('default')));
      expect(await third, 'the return to a shares the gate of a, which its first call holds').toBe(429);
      expect(firstSettled, 'the first call still holds the gate of a when the third request is refused').toBe(false);
      expect(serves(dumpFile).map(socketOf)).toEqual([path.join(targetsDirectory(home), 'apple-1.sock'), path.join(targetsDirectory(home), 'apple-2.sock')]);
      release();
      expect(await first).toBe(200);
    } finally {
      release();
    }
  });
});
