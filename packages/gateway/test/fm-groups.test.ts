import { nodeFileSystemSync, systemRandom } from '@momonga/foundation';
import { execFileSync, spawn } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createManagedServer } from '@momonga/gateway';
import type { ManagedServer } from '@momonga/gateway';
import { createGroupSpawn } from '../src/managed/fm-processes.ts';
import { REAL_PROCESS_TEST_TIMEOUT_MS, LSOF_PATH, createFakeFm, fakeExec, killGroupsForCleanup, testKernelLock, testProcessInspector, TEST_UNPROTECTED_LAUNCH } from '@momonga/testkit';
import { REAL_FM_STOP_GRACE_MS, registerCleanup } from './gateway-helpers.ts';
import { MINIMAL_PATH, isAlive, makeHome, pause, until } from './gateway-process-helpers.ts';
import { FM_SERVER } from '@momonga/protocol';
import { readMarkerGroup } from '@momonga/foundation';
import { systemTiming } from '@momonga/foundation';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const SLEEPER = 'setInterval(() => {}, 1 << 30);';

const groupRecord = (pgid: number): string => `r00000\ng${String(pgid).padStart(10, '0')}\n`;

const pgidOf = (pid: number): number => Number(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());

type Setup = { dir: string; markers: string; socketPath: string; survivorPidFile: string; dumpFile: string; binary: string };

const setup = async (): Promise<Setup> => {
  const dir = makeHome();
  const markers = path.join(dir, 'markers');
  fs.mkdirSync(markers, { mode: 0o700 });
  const fm = await createFakeFm({ dir });
  const survivorPidFile = path.join(dir, 'survivor.pid');
  const dumpFile = path.join(dir, 'env.jsonl');
  fm.configure({ serveSurvivorPidFile: survivorPidFile, envDumpFile: dumpFile });
  return { dir, markers, socketPath: path.join(dir, 'fm.sock'), survivorPidFile, dumpFile, binary: fm.binaryPath };
};

const servePids = (dumpFile: string): number[] =>
  fs.existsSync(dumpFile)
    ? fs
        .readFileSync(dumpFile, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as { argv: string[]; pid: number })
        .filter((record) => record.argv[0] === 'serve')
        .map((record) => record.pid)
    : [];

const groupAlive = (pgid: number): boolean => isAlive(-pgid);

type ServeOptions = Parameters<typeof createManagedServer>[0];

const NO_RESTART_FM = { ...FM_SERVER, restart: { ...FM_SERVER.restart, backoffMs: 600_000, maxRestarts: 0 } };

const serveOptions = (context: Setup, onWarning: ServeOptions['onWarning']): ServeOptions => ({
  timers: systemTiming,
  inspector: testProcessInspector(), random: systemRandom, fileSystem: nodeFileSystemSync,
  launch: TEST_UNPROTECTED_LAUNCH,
  lock: testKernelLock(),
  description: NO_RESTART_FM,
  target: 'fm',
  lockPath: `${context.socketPath}.lock`,
  readyTimeoutMs: 15_000,
  readStopGraceMs: () => REAL_FM_STOP_GRACE_MS,
  binary: context.binary,
  socketPath: context.socketPath,
  env: { PATH: MINIMAL_PATH, HOME: context.dir, TMPDIR: context.dir },
  markerDirectory: context.markers,
  exec: fakeExec,
  onWarning,
});

const makeServe = (context: Setup, overrides: Partial<ServeOptions> = {}): ManagedServer => {
  const warnings: string[] = [];
  const serve = createManagedServer({
    inspector: testProcessInspector(), random: systemRandom, fileSystem: nodeFileSystemSync,
    launch: TEST_UNPROTECTED_LAUNCH,
    lock: testKernelLock(),
    description: FM_SERVER,
    target: 'fm',
    lockPath: `${context.socketPath}.lock`,
    readyTimeoutMs: 15_000,
    readStopGraceMs: () => REAL_FM_STOP_GRACE_MS,
    binary: context.binary,
    socketPath: context.socketPath,
    env: { PATH: MINIMAL_PATH, HOME: context.dir, TMPDIR: context.dir },
    markerDirectory: context.markers,
    exec: fakeExec,
    timers: systemTiming,
    onWarning: (message) => warnings.push(message),
    ...overrides,
  });
  registerCleanup(async () => {
    await serve.stop();
    if (overrides.onWarning === undefined) expect(warnings).toEqual([]);
  });
  return serve;
};

const reapAll = (context: Setup, extra: () => number[] = () => []): void => {
  registerCleanup(() => killGroupsForCleanup([...servePids(context.dumpFile), ...extra()]));
};

const survivorOf = async (context: Setup): Promise<number> => {
  await until(() => fs.existsSync(context.survivorPidFile) && fs.readFileSync(context.survivorPidFile, 'utf8').endsWith('\n'), 'the survivor pid');
  return Number(fs.readFileSync(context.survivorPidFile, 'utf8').trim());
};

const spawnDetached = (args: string[], stdio: Array<'ignore' | number> = ['ignore', 'ignore', 'ignore']): number => {
  const child = spawn(process.execPath, args, { detached: true, stdio });
  const pid = child.pid;
  if (pid === undefined) throw new Error('could not spawn');
  child.unref();
  registerCleanup(() => killGroupsForCleanup([pid]));
  return pid;
};

describe('fm serve group lifetime', () => {
  it('stop() leaves no process of the fm group alive, then removes the marker', async () => {
    const context = await setup();
    reapAll(context);
    const serve = makeServe(context);
    await serve.start();
    const survivor = await survivorOf(context);
    const [leader] = servePids(context.dumpFile);
    if (leader === undefined) throw new Error('fm serve did not start');
    expect(pgidOf(survivor)).toBe(leader);
    await serve.stop();
    await until(() => !groupAlive(leader), 'the fm group to be gone', 3000);
    expect(isAlive(survivor)).toBe(false);
    expect(isAlive(leader)).toBe(false);
    expect(fs.readdirSync(context.markers)).toEqual([]);
  });

  it('keeps the marker after the leader crashes, and the next start kills the survivor', async () => {
    const context = await setup();
    reapAll(context);
    const first = makeServe(context);
    await first.start();
    const survivor = await survivorOf(context);
    const [leader] = servePids(context.dumpFile);
    if (leader === undefined) throw new Error('fm serve did not start');
    process.kill(leader, 'SIGKILL');
    await until(() => !isAlive(leader), 'the leader to die');
    await pause(200);
    expect(isAlive(survivor)).toBe(true);
    expect(fs.readdirSync(context.markers)).toHaveLength(1);

    fs.rmSync(context.survivorPidFile);
    const second = makeServe(context);
    await second.start();
    await until(() => !isAlive(survivor), 'the survivor to be reaped');
  });

  it('stop() after a leader crash still kills the survivors and removes the marker', async () => {
    const context = await setup();
    reapAll(context);
    const serve = makeServe(context);
    await serve.start();
    const survivor = await survivorOf(context);
    const [leader] = servePids(context.dumpFile);
    if (leader === undefined) throw new Error('fm serve did not start');
    process.kill(leader, 'SIGKILL');
    await until(() => !isAlive(leader), 'the leader to die');
    await pause(200);
    expect(isAlive(survivor)).toBe(true);
    await serve.stop();
    await until(() => !isAlive(survivor), 'the survivor to be killed', 3000);
    expect(fs.readdirSync(context.markers)).toEqual([]);
  });

  it('records the fm leader pid, which is its pgid, as the group line of the marker record', async () => {
    const context = await setup();
    reapAll(context);
    const serve = makeServe(context);
    await serve.start();
    const [leader] = servePids(context.dumpFile);
    if (leader === undefined) throw new Error('fm serve did not start');
    const [marker] = fs.readdirSync(context.markers);
    expect(await readMarkerGroup(path.join(context.markers, marker ?? ''))).toBe(leader);
    expect(pgidOf(leader)).toBe(leader);
  });
});

describe('stale fm marker reaping', () => {
  const plantHolderInForeignGroup = (markers: string, content: string): { marker: string; groupLeader: number; holder: number; holderPidFile: string } => {
    const marker = path.join(markers, 'stale-marker');
    fs.writeFileSync(marker, content, { mode: 0o600 });
    const holderPidFile = path.join(markers, '..', 'holder.pid');
    const source = [
      "const { spawn } = require('@momonga/testkit/child-process');",
      "const fs = require('node:fs');",
      `const fd = fs.openSync(${JSON.stringify(marker)}, 'r');`,
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(SLEEPER)}], { stdio: ['ignore', 'ignore', 'ignore', fd] });`,
      'fs.closeSync(fd);',
      `fs.writeFileSync(${JSON.stringify(holderPidFile)}, child.pid + '\\n');`,
      SLEEPER,
    ].join('\n');
    const groupLeader = spawnDetached(['-e', source]);
    return { marker, groupLeader, holder: 0, holderPidFile };
  };

  const holderPid = async (file: string): Promise<number> => {
    await until(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').endsWith('\n'), 'the holder pid');
    return Number(fs.readFileSync(file, 'utf8').trim());
  };

  const unprovedGroupWarning = (marker: string, group: number): string =>
    `managed server marker ${marker}: group ${group} is still alive but could not be verified as belonging to this call, so it was left alone`;

  it('signals only the holder when the record names an unrelated group, and reports that group as left alone (decision 12, item 8)', async () => {
    const context = await setup();
    reapAll(context);
    const victim = spawnDetached(['-e', SLEEPER]);
    const planted = plantHolderInForeignGroup(context.markers, groupRecord(victim));
    const holder = await holderPid(planted.holderPidFile);
    expect(pgidOf(holder)).toBe(planted.groupLeader);

    const warnings: string[] = [];
    const serve = makeServe(context, { onWarning: (message) => warnings.push(message) });
    await serve.start();
    await until(() => !isAlive(holder), 'the holder to be signalled');
    expect(isAlive(planted.groupLeader)).toBe(true);
    expect(isAlive(victim)).toBe(true);
    expect(fs.existsSync(planted.marker)).toBe(false);
    expect(warnings).toEqual([unprovedGroupWarning(planted.marker, victim)]);
  });

  it('treats unreadable marker content as a record whose retries are all spent: it signals nothing, keeps the marker and tells the person once (decision 12)', async () => {
    const context = await setup();
    reapAll(context);
    const planted = plantHolderInForeignGroup(context.markers, 'not a pid');
    const holder = await holderPid(planted.holderPidFile);

    const warnings: string[] = [];
    const serve = makeServe(context, { onWarning: (message) => warnings.push(message) });
    await serve.start();
    expect(isAlive(holder)).toBe(true);
    expect(fs.existsSync(planted.marker)).toBe(true);
    expect(warnings).toEqual([
      'a managed server process (marker stale-marker) may still be running. MomongaCode has used its 4 retries and will not try again. Stop the process that holds it, or, if it can stay running, run /markers ignore stale-marker in an interactive session.',
    ]);
  });
});

describe('finalize of a spawned fm group', () => {
  it('signals nothing but warns when the recorded group lives on without holding the marker, and removes the marker', async () => {
    const dir = makeHome();
    const markers = path.join(dir, 'markers');
    fs.mkdirSync(markers, { mode: 0o700 });
    const readyFile = path.join(dir, 'ready');
    const warnings: string[] = [];
    const source = [
      "const fs = require('node:fs');",
      "process.on('SIGTERM', () => process.exit(0));",
      'fs.closeSync(3);',
      "fs.writeFileSync(process.argv[1], 'ready\\n');",
      SLEEPER,
    ].join(' ');
    const child = await createGroupSpawn({ inspector: testProcessInspector(), random: systemRandom, fileSystem: nodeFileSystemSync, env: { PATH: MINIMAL_PATH, HOME: dir, TMPDIR: dir }, markerDirectory: markers, onWarning: (message) => warnings.push(message) })(process.execPath, ['-e', source, readyFile], TEST_UNPROTECTED_LAUNCH.protection);
    const [marker] = fs.readdirSync(markers);
    await until(() => fs.readFileSync(path.join(markers, marker ?? ''), 'utf8').includes('\ng'), 'the group line');
    const pid = (await readMarkerGroup(path.join(markers, marker ?? ''))) ?? 0;
    registerCleanup(() => killGroupsForCleanup([pid]));
    await until(() => fs.existsSync(readyFile), 'the child to drop the marker fd');
    expect(pgidOf(pid)).toBe(pid);

    await child.finalize?.(300);
    await pause(200);
    expect(isAlive(pid)).toBe(true);
    expect(fs.readdirSync(markers)).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(path.join(markers, marker ?? ''));
    expect(warnings[0]).toContain(String(pid));
  });
});

const shieldFromSignals = (protectedPid: number, groupLeader?: number): void => {
  const original = process.kill.bind(process);
  const spy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
    if (signal === 0) return original(pid, signal);
    if (pid === protectedPid || pid === -protectedPid) return true;
    if (groupLeader !== undefined && pid === -groupLeader) return original(groupLeader, signal);
    return original(pid, signal);
  }) as typeof process.kill);
  registerCleanup(() => spy.mockRestore());
};

const plantStaleHolder = (markers: string): { marker: string; holder: number } => {
  const marker = path.join(markers, 'stale-held');
  const fd = fs.openSync(marker, 'w', 0o600);
  const child = spawn(process.execPath, ['-e', SLEEPER], { detached: true, stdio: ['ignore', 'ignore', 'ignore', fd] });
  fs.closeSync(fd);
  const holder = child.pid;
  if (holder === undefined) throw new Error('could not spawn the holder');
  child.unref();
  fs.writeFileSync(marker, groupRecord(holder));
  registerCleanup(() => killGroupsForCleanup([holder]));
  return { marker, holder };
};

const waitForHolder = async (marker: string, pid: number): Promise<void> => {
  await until(() => {
    const result = execFileSync(LSOF_PATH, ['-t', marker], { encoding: 'utf8' }).split('\n');
    return result.includes(String(pid));
  }, 'the holder to open the marker');
};

describe('group cleanup outcome', () => {
  it('keeps a stale marker and warns once when its holder survives the reaper', async () => {
    const context = await setup();
    reapAll(context);
    const { marker, holder } = plantStaleHolder(context.markers);
    await waitForHolder(marker, holder);
    shieldFromSignals(holder);
    const onWarning = vi.fn();
    const serve = makeServe(context, { readStopGraceMs: () => 300, onWarning });
    await serve.start();
    expect(isAlive(holder)).toBe(true);
    expect(fs.existsSync(marker)).toBe(true);
    expect(onWarning).toHaveBeenCalledTimes(1);
    const message = String(onWarning.mock.calls[0]?.[0]);
    expect(message).toContain(marker);
    expect(message).toContain(String(holder));
  });

  it('keeps the fm marker and warns once when a survivor outlives stop()', async () => {
    const context = await setup();
    reapAll(context);
    const onWarning = vi.fn();
    const serve = makeServe(context, { readStopGraceMs: () => 300, onWarning });
    await serve.start();
    const survivor = await survivorOf(context);
    const [marker] = fs.readdirSync(context.markers);
    const markerPath = path.join(context.markers, marker ?? '');
    const [leader] = servePids(context.dumpFile);
    if (leader === undefined) throw new Error('fm serve did not start');
    shieldFromSignals(survivor, leader);
    await serve.stop();
    expect(isAlive(survivor)).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(onWarning).toHaveBeenCalledTimes(1);
    const message = String(onWarning.mock.calls[0]?.[0]);
    expect(message).toContain(markerPath);
    expect(message).toContain(String(survivor));
  });

  it('removes a reaped stale marker without warning', async () => {
    const context = await setup();
    reapAll(context);
    const { marker, holder } = plantStaleHolder(context.markers);
    await waitForHolder(marker, holder);
    const onWarning = vi.fn();
    const serve = makeServe(context, { readStopGraceMs: () => 300, onWarning });
    await serve.start();
    expect(isAlive(holder)).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('removes the fm marker on a clean stop() without warning', async () => {
    const context = await setup();
    reapAll(context);
    const onWarning = vi.fn();
    const serve = makeServe(context, { readStopGraceMs: () => 300, onWarning });
    await serve.start();
    const survivor = await survivorOf(context);
    await serve.stop();
    expect(isAlive(survivor)).toBe(false);
    expect(fs.readdirSync(context.markers)).toEqual([]);
    expect(onWarning).not.toHaveBeenCalled();
  });
});

describe('reaper warnings for a recorded group it could not verify', () => {
  it('warns once naming the marker and the recorded pgid, and leaves the group alone', async () => {
    const context = await setup();
    const helperPidFile = path.join(context.dir, 'helper.pid');
    const helperFmDir = path.join(context.dir, 'helper-fm');
    fs.mkdirSync(helperFmDir, { mode: 0o700 });
    const fm = await createFakeFm({ dir: helperFmDir });
    const helperDump = path.join(context.dir, 'helper-env.jsonl');
    fm.configure({ serveDetachedHelperPidFile: helperPidFile, envDumpFile: helperDump });
    const helperContext = { ...context, binary: fm.binaryPath, dumpFile: helperDump };
    reapAll(helperContext);
    let helper: number | undefined;
    registerCleanup(() => killGroupsForCleanup(helper === undefined ? [] : [helper]));

    const firstWarnings = vi.fn();
    const first = makeServe(helperContext, { onWarning: firstWarnings });
    await first.start();
    await until(() => fs.existsSync(helperPidFile) && fs.readFileSync(helperPidFile, 'utf8').endsWith('\n'), 'the helper pid');
    helper = Number(fs.readFileSync(helperPidFile, 'utf8').trim());
    const [leader] = servePids(helperDump);
    if (leader === undefined) throw new Error('fm serve did not start');
    expect(pgidOf(helper)).toBe(leader);
    const [markerName] = fs.readdirSync(context.markers);
    const marker = path.join(context.markers, markerName ?? '');
    process.kill(leader, 'SIGKILL');
    await until(() => !isAlive(leader), 'the leader to die');
    await pause(200);
    expect(fs.existsSync(marker)).toBe(true);

    const onWarning = vi.fn();
    const second = makeServe(helperContext, { onWarning });
    await second.start();
    expect(onWarning).toHaveBeenCalledTimes(1);
    const message = String(onWarning.mock.calls[0]?.[0]);
    expect(message).toContain(marker);
    expect(message).toContain(String(leader));
    expect(isAlive(helper)).toBe(true);
  });
});

describe('reaper warnings for a live stale leader whose helper outlives it', () => {
  it('kills the leader, leaves the helper alone, removes the marker and warns once naming the marker and pgid', async () => {
    const context = await setup();
    const helperFmDir = path.join(context.dir, 'live-fm');
    fs.mkdirSync(helperFmDir, { mode: 0o700 });
    const fm = await createFakeFm({ dir: helperFmDir });
    const helperPidFile = path.join(context.dir, 'live-helper.pid');
    const dump = path.join(context.dir, 'live-env.jsonl');
    fm.configure({ serveDetachedHelperPidFile: helperPidFile, envDumpFile: dump });
    const liveContext = { ...context, binary: fm.binaryPath, dumpFile: dump };
    reapAll(liveContext);

    const abandonedWarnings: string[] = [];
    const abandoned = createManagedServer(serveOptions(liveContext, (message) => abandonedWarnings.push(message)));
    await abandoned.start();
    await until(() => fs.existsSync(helperPidFile) && fs.readFileSync(helperPidFile, 'utf8').endsWith('\n'), 'the helper pid');
    const helper = Number(fs.readFileSync(helperPidFile, 'utf8').trim());
    const [leader] = servePids(dump);
    if (leader === undefined) throw new Error('fm serve did not start');
    expect(pgidOf(helper)).toBe(leader);
    const [markerName] = fs.readdirSync(context.markers);
    const marker = path.join(context.markers, markerName ?? '');
    expect(isAlive(leader)).toBe(true);

    const onWarning = vi.fn();
    const second = makeServe(liveContext, { onWarning, readStopGraceMs: () => 500 });
    await second.start();
    await until(() => !isAlive(leader), 'the stale leader to be killed', 5000);
    expect(isAlive(helper)).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
    expect(onWarning).toHaveBeenCalledTimes(1);
    const message = String(onWarning.mock.calls[0]?.[0]);
    expect(message).toContain(marker);
    expect(message).toContain(String(leader));
  });
});
