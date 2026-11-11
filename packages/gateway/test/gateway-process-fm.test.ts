import { execFileSync, spawn } from '@momonga/testkit/child-process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadUserSettings } from '@momonga/config';
import { codeDigestOfRunningProcess, FIRST_GENERATION } from '@momonga/foundation';
import { saveProbeRecord, targetCounterOf } from '@momonga/gateway';
import { FM_SERVER, TARGET_PROBING_MESSAGE } from '@momonga/protocol';
import { FM_CURRENCY, fmRecordKey, saveFakeFmRecord } from './fm-record-support.ts';
import { REAL_PROCESS_TEST_TIMEOUT_MS, FAKE_OS_BUILD, createFakeFm, fakeExec, killGroupsForCleanup } from '@momonga/testkit';
import { getJson, makeDir, postJson, readJson, registerCleanup, userInput, listedCountersOf, listedEntryOf } from './gateway-helpers.ts';
import { makeReport } from './report-fixture.ts';
import {
  MINIMAL_PATH,
  PROCESS_VERSION,
  baseEnv,
  clientFor,
  homePaths,
  isAlive,
  launchGateway,
  makeHome,
  until,
  writeSettings,
  modelsOf
} from './gateway-process-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const MINIMAL_NAMES = new Set(['PATH', 'HOME', 'LANG', 'TMPDIR']);
const PRODUCTION_SPAWNED = new Set(['serve', 'count-tokens']);
const DARWIN_INJECTED_NAMES = new Set(['__CF_USER_TEXT_ENCODING']);
const body = { model: 'fm/system', input: userInput('hello fm') };

type DumpRecord = { argv: string[]; pid: number; env: Record<string, string> };

const readDump = (file: string): DumpRecord[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as DumpRecord)
    : [];

const pgidOf = (pid: number): number => Number(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());

const fakeFmSetup = async () => {
  const fm = await createFakeFm({ dir: makeDir() });
  const dumpFile = path.join(path.dirname(fm.binaryPath), 'env.jsonl');
  fm.configure({ envDumpFile: dumpFile });
  const home = makeHome();
  await saveFakeFmRecord(home, fm.binaryPath);
  return { fm, dumpFile, home };
};

const declareNativeFm = (home: string, binary: string): void => {
  writeSettings(home, { models: modelsOf({ fm: { adapter: 'managed', server: 'fm', model: 'system', binary, toolCalling: 'native' } }) });
};

const declareAutoFm = (home: string, binary: string): void => {
  writeSettings(home, { models: modelsOf({ fm: { adapter: 'managed', server: 'fm', model: 'system', binary } }) });
};

const servePids = (dumpFile: string): number[] =>
  readDump(dumpFile)
    .filter((record) => record.argv[0] === 'serve')
    .map((record) => record.pid);

const reapServeGroups = (dumpFile: string): void => {
  registerCleanup(() => killGroupsForCleanup(servePids(dumpFile)));
};

describe('managed fm under startGatewayProcess', () => {
  it('gives every fm invocation exactly the minimal env', async () => {
    const { fm, dumpFile, home } = await fakeFmSetup();
    reapServeGroups(dumpFile);
    declareNativeFm(home, fm.binaryPath);
    const env = baseEnv(home, {
      PATH: `${MINIMAL_PATH}:/opt/homebrew/bin:/usr/local/bin`,
      LANG: 'ja_JP.UTF-8',
      LC_ALL: 'ja_JP.UTF-8',
      LC_CTYPE: 'UTF-8',
      MOMONGA_CANARY: 'must-not-leak',
      NODE_OPTIONS: '--max-old-space-size=64',
    });
    const handle = await launchGateway({ generation: FIRST_GENERATION, home, env, version: PROCESS_VERSION, exec: fakeExec });
    const client = clientFor(handle.socketPath);
    expect((await readJson(await postJson(client, '/v1/responses', body))).status).toBe(200);
    expect((await readJson(await postJson(client, '/v1/momonga/count_tokens', { model: 'fm/system', input: 'one two three' }))).status).toBe(200);

    const records = readDump(dumpFile).filter((record) => PRODUCTION_SPAWNED.has(record.argv[0] ?? ''));
    expect(new Set(records.map((record) => record.argv[0]))).toEqual(PRODUCTION_SPAWNED);
    for (const record of records) {
      const names = Object.keys(record.env).filter((name) => !DARWIN_INJECTED_NAMES.has(name));
      expect(names.filter((name) => !MINIMAL_NAMES.has(name) && !name.startsWith('LC_'))).toEqual([]);
      expect(record.env).toMatchObject({
        PATH: MINIMAL_PATH,
        HOME: home,
        TMPDIR: home,
        LANG: 'ja_JP.UTF-8',
        LC_ALL: 'ja_JP.UTF-8',
        LC_CTYPE: 'UTF-8',
      });
    }
  });

  it('runs fm serve as the leader of its own process group and marks it under the gateway generation markers, markers/g1/targets/fm-1 (18.2.1)', async () => {
    const { fm, dumpFile, home } = await fakeFmSetup();
    reapServeGroups(dumpFile);
    declareNativeFm(home, fm.binaryPath);
    const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, exec: fakeExec });
    expect((await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', body))).status).toBe(200);
    const [pid] = servePids(dumpFile);
    if (pid === undefined) throw new Error('fm serve was not started');
    expect(pgidOf(pid)).toBe(pid);
    expect(pgidOf(pid)).not.toBe(pgidOf(process.pid));
    const markers = homePaths(home).fmMarkers;
    expect(fs.readdirSync(markers)).toHaveLength(1);

    await handle.close();
    await until(() => !isAlive(pid), 'fm serve to exit');
    expect(fs.readdirSync(markers)).toEqual([]);
  });

  it('reaps a stale fm group left behind by a killed gateway before claiming run/g1/targets/fm-1.sock (18.2.1, 18.2.3)', async () => {
    const { fm, dumpFile, home } = await fakeFmSetup();
    reapServeGroups(dumpFile);
    declareNativeFm(home, fm.binaryPath);
    const paths = homePaths(home);
    fs.mkdirSync(paths.fmMarkers, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(paths.fmSocket), { recursive: true, mode: 0o700 });
    for (const dir of [paths.root, path.dirname(paths.fmSocket), path.dirname(paths.fmMarkers), paths.fmMarkers]) fs.chmodSync(dir, 0o700);
    const marker = path.join(paths.fmMarkers, randomUUID());
    const markerFd = fs.openSync(marker, 'w', 0o600);
    const orphan = spawn(fm.binaryPath, ['serve', '--socket', paths.fmSocket], {
      env: baseEnv(home),
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', markerFd],
    });
    fs.closeSync(markerFd);
    const orphanPid = orphan.pid;
    if (orphanPid === undefined) throw new Error('could not spawn the orphan fm');
    registerCleanup(() => killGroupsForCleanup([orphanPid]));
    await until(() => fs.existsSync(paths.fmSocket), 'the orphan fm socket');

    const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, exec: fakeExec });
    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', body));
    expect(response.status).toBe(200);
    await until(() => !isAlive(orphanPid), 'the orphan fm to be killed');
    expect(fs.existsSync(marker)).toBe(false);
    expect(servePids(dumpFile).filter((pid) => pid !== orphanPid)).toHaveLength(1);
  });

  it('reports precondition_failed health for a missing fm binary and still starts', async () => {
    const home = makeHome();
    const missing = path.join(makeDir(), 'no-such-fm');
    declareAutoFm(home, missing);
    const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, exec: fakeExec });
    const health = await getJson(clientFor(handle.socketPath), '/v1/momonga/health');
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(false);
    expect(health.body.state).toBe('running');
    expect(health.body.models['fm/system']).toMatchObject({
      ok: false,
      reason: 'precondition_failed',
      detail: `the model "fm/system": the executable was not found at ${missing}`,
    });
  });

  it('keys the fm probe record by its probe key: the binary sha256, the sw_vers build and the declared model, not the target name', async () => {
    const { fm, dumpFile, home } = await fakeFmSetup();
    reapServeGroups(dumpFile);
    declareAutoFm(home, fm.binaryPath);
    const binarySha256 = createHash('sha256').update(fs.readFileSync(fm.binaryPath)).digest('hex');
    await saveProbeRecord(path.join(homePaths(home).root, 'state', 'probe'), fmRecordKey(binarySha256, FAKE_OS_BUILD), makeReport(1, 1), FM_CURRENCY);
    const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, exec: fakeExec });
    const models = await getJson(clientFor(handle.socketPath), '/v1/momonga/models');
    const entry = listedEntryOf(models.body, 'fm/system');
    expect(entry.chain.map((member) => member.model)).toEqual(['fm/system']);
    expect(entry.capabilities['source']).toBe('probed');
  });

  it('lists the fm target counter over its resolved definition, its probe key and the code digest', async () => {
    const { fm, dumpFile, home } = await fakeFmSetup();
    reapServeGroups(dumpFile);
    declareAutoFm(home, fm.binaryPath);
    const binarySha256 = createHash('sha256').update(fs.readFileSync(fm.binaryPath)).digest('hex');
    const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, exec: fakeExec });
    const models = await getJson(clientFor(handle.socketPath), '/v1/momonga/models');
    const counters = listedCountersOf(models.body, 'fm/system');
    const { settings } = await loadUserSettings({ home });
    const target = settings.models.models.get('fm/system');
    if (target === undefined) throw new Error('the default settings resolved no fm target');
    expect(counters).toEqual({
      'fm/system': targetCounterOf({
        target,
        server: FM_SERVER,
        codeDigest: await codeDigestOfRunningProcess(),
        probeKey: fmRecordKey(binarySha256, FAKE_OS_BUILD).canonical,
        outputPolicy: { unboundedOutputReserve: settings.context.unboundedOutputReserve },
      }),
    });
  });

  it('treats a probe record for another OS build as no record: the alias is listed as probing, with no capability', async () => {
    const { fm, dumpFile, home } = await fakeFmSetup();
    reapServeGroups(dumpFile);
    declareAutoFm(home, fm.binaryPath);
    const binarySha256 = createHash('sha256').update(fs.readFileSync(fm.binaryPath)).digest('hex');
    const probeDir = path.join(homePaths(home).root, 'state', 'probe');
    fs.rmSync(path.join(probeDir, `${fmRecordKey(binarySha256, FAKE_OS_BUILD).digest}.json`));
    await saveProbeRecord(probeDir, fmRecordKey(binarySha256, `${FAKE_OS_BUILD}x`), makeReport(1, 1), FM_CURRENCY);
    fm.configure({ envDumpFile: dumpFile, serve: { stallNativeSamples: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], stallMs: 600_000 } });
    const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, exec: fakeExec });
    const models = await getJson(clientFor(handle.socketPath), '/v1/momonga/models');
    const entry = listedEntryOf(models.body, 'fm/system');
    expect(entry.capabilities).toEqual({ toolCalling: { state: 'probing', message: TARGET_PROBING_MESSAGE, retryAfterSeconds: 120 }, source: 'unprobed' });
    await until(() => servePids(dumpFile).length === 1, 'the probe of the current key to start its fm serve');
  });
});
