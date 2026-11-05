import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadUserSettings } from '@momonga/config';
import { codeDigestOfRunningProcess } from '@momonga/foundation';
import { saveProbeRecord, targetCounterOf } from '@momonga/gateway';
import { DAEMON_PROCESS_TEST_TIMEOUT_MS, FAKE_OS_BUILD, createFakeFm, fakeExec, killGroupsForCleanup } from '@momonga/testkit';
import { getJson, makeDir, postJson, readJson, registerCleanup, userInput } from './gateway-helpers.ts';
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
} from './gateway-process-helpers.ts';
import { CURRENT_DIALECTS } from './dialect-currency.ts';

const MINIMAL_NAMES = new Set(['PATH', 'HOME', 'LANG', 'TMPDIR']);
const PRODUCTION_SPAWNED = new Set(['serve', 'count-tokens']);
const DARWIN_INJECTED_NAMES = new Set(['__CF_USER_TEXT_ENCODING']);
const body = { model: 'default', input: userInput('hello fm') };

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
  return { fm, dumpFile, home };
};

const declareNativeFm = (home: string): void => {
  writeSettings(home, { models: { aliases: { default: ['fm'] }, targets: { fm: { adapter: 'fm', toolCalling: 'native' } } } });
};

const servePids = (dumpFile: string): number[] =>
  readDump(dumpFile)
    .filter((record) => record.argv[0] === 'serve')
    .map((record) => record.pid);

const reapServeGroups = (dumpFile: string): void => {
  registerCleanup(() => killGroupsForCleanup(servePids(dumpFile)));
};

describe('managed fm under startGatewayProcess', { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('gives every fm invocation exactly the minimal env', async () => {
    const { fm, dumpFile, home } = await fakeFmSetup();
    reapServeGroups(dumpFile);
    declareNativeFm(home);
    const env = baseEnv(home, {
      PATH: `${MINIMAL_PATH}:/opt/homebrew/bin:/usr/local/bin`,
      LANG: 'ja_JP.UTF-8',
      LC_ALL: 'ja_JP.UTF-8',
      LC_CTYPE: 'UTF-8',
      MOMONGA_CANARY: 'must-not-leak',
      NODE_OPTIONS: '--max-old-space-size=64',
    });
    const handle = await launchGateway({ home, env, version: PROCESS_VERSION, fmBinary: fm.binaryPath, exec: fakeExec });
    const client = clientFor(handle.socketPath);
    expect((await readJson(await postJson(client, '/v1/responses', body))).status).toBe(200);
    expect((await readJson(await postJson(client, '/v1/momonga/count_tokens', { model: 'default', input: 'one two three' }))).status).toBe(200);

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

  it('runs fm serve as the leader of its own process group and marks it under run/markers/targets/fm', async () => {
    const { fm, dumpFile, home } = await fakeFmSetup();
    reapServeGroups(dumpFile);
    declareNativeFm(home);
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION, fmBinary: fm.binaryPath, exec: fakeExec });
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

  it('reaps a stale fm group left behind by a killed gateway before claiming fm.sock', async () => {
    const { fm, dumpFile, home } = await fakeFmSetup();
    reapServeGroups(dumpFile);
    declareNativeFm(home);
    const paths = homePaths(home);
    fs.mkdirSync(paths.fmMarkers, { recursive: true, mode: 0o700 });
    for (const dir of [paths.root, path.dirname(paths.socket), path.dirname(paths.fmMarkers), paths.fmMarkers]) fs.chmodSync(dir, 0o700);
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

    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION, fmBinary: fm.binaryPath, exec: fakeExec });
    const response = await readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', body));
    expect(response.status).toBe(200);
    await until(() => !isAlive(orphanPid), 'the orphan fm to be killed');
    expect(fs.existsSync(marker)).toBe(false);
    expect(servePids(dumpFile).filter((pid) => pid !== orphanPid)).toHaveLength(1);
  });

  it('reports precondition_failed health for a missing fm binary and still starts', async () => {
    const home = makeHome();
    const missing = path.join(makeDir(), 'no-such-fm');
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION, fmBinary: missing, exec: fakeExec });
    const health = await getJson(clientFor(handle.socketPath), '/v1/momonga/health');
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(false);
    expect(health.body.state).toBe('running');
    expect(health.body.targets.fm).toMatchObject({
      ok: false,
      reason: 'precondition_failed',
      detail: `fm binary not found at ${missing}`,
    });
  });

  it('keys the fm probe record by target name, binary sha256 and the sw_vers build', async () => {
    const { fm, dumpFile, home } = await fakeFmSetup();
    reapServeGroups(dumpFile);
    const binarySha256 = createHash('sha256').update(fs.readFileSync(fm.binaryPath)).digest('hex');
    await saveProbeRecord(path.join(homePaths(home).root, 'state', 'probe'), { target: 'fm', binarySha256, osBuild: FAKE_OS_BUILD }, makeReport(1, 1), CURRENT_DIALECTS);
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION, fmBinary: fm.binaryPath, exec: fakeExec });
    const models = await getJson(clientFor(handle.socketPath), '/v1/momonga/models');
    const entry = models.body.data.find((model: { id: string }) => model.id === 'default');
    expect(entry.targets).toEqual(['fm']);
    expect(entry.capabilities.source).toBe('probed');
  });

  it('lists the fm target counter over its resolved definition, the binary sha256, the sw_vers build and the code digest', async () => {
    const { fm, dumpFile, home } = await fakeFmSetup();
    reapServeGroups(dumpFile);
    const binarySha256 = createHash('sha256').update(fs.readFileSync(fm.binaryPath)).digest('hex');
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION, fmBinary: fm.binaryPath, exec: fakeExec });
    const models = await getJson(clientFor(handle.socketPath), '/v1/momonga/models');
    const entry = models.body.data.find((model: { id: string }) => model.id === 'default');
    const target = (await loadUserSettings({ home })).settings.models.targets['fm'];
    if (target === undefined) throw new Error('the default settings resolved no fm target');
    expect(entry.targetCounters).toEqual({
      fm: targetCounterOf({ target, codeDigest: await codeDigestOfRunningProcess(), fm: { binarySha256, osBuild: FAKE_OS_BUILD } }),
    });
  });

  it('treats a probe record for another OS build as unprobed', async () => {
    const { fm, dumpFile, home } = await fakeFmSetup();
    reapServeGroups(dumpFile);
    const binarySha256 = createHash('sha256').update(fs.readFileSync(fm.binaryPath)).digest('hex');
    await saveProbeRecord(path.join(homePaths(home).root, 'state', 'probe'), { target: 'fm', binarySha256, osBuild: `${FAKE_OS_BUILD}x` }, makeReport(1, 1), CURRENT_DIALECTS);
    const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION, fmBinary: fm.binaryPath, exec: fakeExec });
    const models = await getJson(clientFor(handle.socketPath), '/v1/momonga/models');
    const entry = models.body.data.find((model: { id: string }) => model.id === 'default');
    expect(entry.capabilities.source).toBe('unprobed');
    expect(entry.capabilities.toolCalling.state).toBe('needs_probe');
    expect(entry.targetCapabilities.fm.toolCalling.remedy).toBe('run `momonga gateway probe fm`');
    expect(entry.targetCapabilities.fm.toolCalling.evidence).toContain(binarySha256);
    expect(entry.targetCapabilities.fm.toolCalling.evidence).toContain(FAKE_OS_BUILD);
  });
});
