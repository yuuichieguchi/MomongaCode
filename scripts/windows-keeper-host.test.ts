import { spawn } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GroupContainmentError, attachKept, confirmByAttach, createJobGroupPort, createKeptGroupControl, createNodeKeeperHost, launchKept, nodeCommandRunner, stopKeptGroup, systemRandom, systemTiming } from '@momonga/foundation';
import type { KeeperHost, KeeperRun, KeptCommand, KeptGroup, KeptLaunch } from '@momonga/foundation';
import { createWindowsInspector } from '../packages/foundation/src/platform/windows-inspector.ts';
import { launch as launchCommand } from '../packages/sandbox/src/process.ts';
import type { LaunchOptions } from '../packages/sandbox/src/process.ts';
import { repoRoot } from './bundle.ts';
import { UNBOUNDED_BUILD_WAIT_MS } from './support/build-wait.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';
import { WINDOWS_KEEPER_SOURCE, compileWindowsProgram } from './windows-keeper.ts';

const ZIG_TARGET = 'x86_64-windows-gnu';
const WAIT_MS = 30_000;
const GRACE_MS = 10_000;
const POLL_MS = 50;
const BORN_IN_JOB_LAUNCHES = 1000;
const BORN_IN_JOB_TIMEOUT_MS = 1_800_000;
const JOB_PREFIX = 'Local\\momonga-';
const LONG_SLEEP = 'setInterval(() => undefined, 1000);';

type Started = KeeperRun & { pid: number; output(): string };

const bounded = (): AbortSignal => AbortSignal.timeout(WAIT_MS);

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const eventually = async (holds: () => boolean | Promise<boolean>, what: string): Promise<void> => {
  const deadline = Date.now() + WAIT_MS;
  while (!(await holds())) {
    if (Date.now() >= deadline) throw new Error(`not within ${WAIT_MS} ms: ${what}`);
    await pause(POLL_MS);
  }
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
};

describe.runIf(process.platform === 'win32')('the keeper on a Windows host', () => {
  let root = '';
  let keeper = '';
  let probe = '';
  let uiLimitedRun = '';
  const groups: KeptGroup[] = [];

  const hostWith = (names: string[] = []): KeeperHost =>
    createNodeKeeperHost({ executable: () => keeper, random: { hex: (bytes) => names.shift() ?? systemRandom.hex(bytes) }, env: process.env });

  const startThrough =
    (wrapper: string | undefined) =>
    (executable: string, args: readonly string[]): Started => {
      const child = spawn(wrapper ?? executable, wrapper === undefined ? [...args] : [executable, ...args], { detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
      return {
        pid: child.pid as number,
        output: () => output,
        exited: new Promise<number | undefined>((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', (code) => resolve(code ?? undefined));
        }),
      };
    };

  const launch = async (command: KeptCommand, options: { host?: KeeperHost; marker?: string; wrapper?: string } = {}): Promise<KeptLaunch<Started>> => {
    const launched = await launchKept(options.host ?? hostWith(), { command, onOwnerLoss: 'terminate', marker: options.marker, start: startThrough(options.wrapper), signal: bounded() });
    if (launched.kind === 'started') groups.push(launched.group);
    return launched;
  };

  const started = async (command: KeptCommand, options: { host?: KeeperHost; marker?: string } = {}): Promise<Extract<KeptLaunch<Started>, { kind: 'started' }>> => {
    const launched = await launch(command, options);
    if (launched.kind !== 'started') throw new Error(`the keeper refused: ${launched.reason} (${launched.systemError})`);
    return launched;
  };

  const node = (script: string): KeptCommand => ({ file: process.execPath, args: ['-e', script] });

  const stop = (group: KeptGroup, host: KeeperHost = hostWith()): Promise<string> => stopKeptGroup(group, { graceMs: GRACE_MS, timing: systemTiming, signal: bounded(), confirm: confirmByAttach(host) });

  const treeScript = (pidFile: string): string => {
    const grandchild = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); ${LONG_SLEEP}`;
    const intermediate = `process.getBuiltinModule('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { detached: true, stdio: 'ignore' }).unref(); process.exit(0);`;
    return `process.getBuiltinModule('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(intermediate)}], { stdio: 'ignore' }); ${LONG_SLEEP}`;
  };

  const grandchildOf = async (pidFile: string): Promise<number> => {
    await eventually(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8') !== '', `the grandchild wrote ${pidFile}`);
    return Number(fs.readFileSync(pidFile, 'utf8'));
  };

  beforeAll(() => {
    root = fs.realpathSync(createTempRoot());
    keeper = path.join(root, 'bin', 'momonga-keeper.exe');
    probe = path.join(root, 'bin', 'job-probe.exe');
    uiLimitedRun = path.join(root, 'bin', 'ui-limited-run.exe');
    compileWindowsProgram(WINDOWS_KEEPER_SOURCE, keeper, ZIG_TARGET);
    compileWindowsProgram(`${repoRoot}native/windows-keeper/test/job-probe.c`, probe, ZIG_TARGET);
    compileWindowsProgram(`${repoRoot}native/windows-keeper/test/ui-limited-run.c`, uiLimitedRun, ZIG_TARGET);
  }, UNBOUNDED_BUILD_WAIT_MS);

  afterAll(async () => {
    for (const group of groups) group.release();
    await removeTempRoot(root);
  });

  const productLaunch = (command: KeptCommand, signal: AbortSignal, extra: Partial<LaunchOptions> = {}) =>
    launchCommand({
      file: command.file,
      args: command.args,
      cwd: root,
      env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      signal,
      killGraceMs: GRACE_MS,
      afterExit: () => undefined,
      groupPort: createJobGroupPort(createKeptGroupControl(hostWith())),
      ...extra,
    });

  it('T-JO-1: a command starts an intermediate that starts a grandchild and exits at once; stopping the command leaves no grandchild', async () => {
    const pidFile = path.join(root, 'jo1.pid');
    const stopCommand = new AbortController();
    const launched = productLaunch(node(treeScript(pidFile)), stopCommand.signal);
    const grandchild = await grandchildOf(pidFile);
    expect(isAlive(grandchild)).toBe(true);
    stopCommand.abort();
    const exit = await launched.exited;
    expect(exit.killedBy).toBe('abort');
    expect(exit.groupNotStopped).toBeUndefined();
    await eventually(() => !isAlive(grandchild), 'the grandchild is gone');
  });

  it('T-JO-1: a grandchild that outlives a command which exited by itself is stopped before the launch reports the exit', async () => {
    const pidFile = path.join(root, 'jo1b.pid');
    const grandchildScript = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); ${LONG_SLEEP}`;
    const intermediate = `process.getBuiltinModule('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { detached: true, stdio: 'ignore' }).unref(); process.exit(0);`;
    const command = `process.getBuiltinModule('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(intermediate)}], { stdio: 'ignore' }); const fs = require('node:fs'); const wait = setInterval(() => { if (fs.existsSync(${JSON.stringify(pidFile)}) && fs.readFileSync(${JSON.stringify(pidFile)}, 'utf8') !== '') { clearInterval(wait); process.exit(7); } }, 20);`;
    const launched = productLaunch(node(command), new AbortController().signal);
    const exit = await launched.exited;
    expect(exit.code).toBe(7);
    expect(exit.groupNotStopped).toBeUndefined();
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
    await eventually(() => !isAlive(grandchild), 'the grandchild is gone');
  });

  it('T-JO-2: killing the keeper ends the whole tree', async () => {
    const pidFile = path.join(root, 'jo2.pid');
    const { process: keeperProcess, commandPid, group } = await started(node(treeScript(pidFile)));
    const grandchild = await grandchildOf(pidFile);
    process.kill(keeperProcess.pid);
    await eventually(() => !isAlive(grandchild) && !isAlive(commandPid), 'the command and its grandchild are gone');
    expect(await group.ended(bounded())).toBe('closed');
  });

  it(
    `T-JO-3: the command is a member of the job at its first instruction, for ${BORN_IN_JOB_LAUNCHES} launches`,
    async () => {
      const outside: number[] = [];
      for (let index = 0; index < BORN_IN_JOB_LAUNCHES; index += 1) {
        const name = systemRandom.hex(16);
        const { group } = await started({ file: probe, args: [`${JOB_PREFIX}${name}`] }, { host: hostWith([name]) });
        const exit = await group.commandExit(bounded());
        if (exit.kind !== 'exit' || exit.code !== 0) outside.push(index);
        group.release();
      }
      expect(outside).toEqual([]);
    },
    BORN_IN_JOB_TIMEOUT_MS,
  );

  it('T-JO-5: the job name opens while a member lives and not afterwards, and a taken name is refused as name-taken', async () => {
    const name = systemRandom.hex(16);
    const job = `${JOB_PREFIX}${name}`;
    const { group } = await started(node(LONG_SLEEP), { host: hostWith([name]) });
    expect(group.job).toBe(job);
    const attached = await attachKept(hostWith(), job, bounded());
    expect(attached.kind).toBe('attached');
    if (attached.kind === 'attached') {
      const listed = await attached.group.members(bounded());
      expect(listed.kind === 'members' && listed.pids.length > 0).toBe(true);
      attached.group.release();
    }
    expect(await launch(node(LONG_SLEEP), { host: hostWith([name]) })).toMatchObject({ kind: 'refused', reason: 'name-taken' });
    expect(await stop(group)).toBe('terminated');
    await eventually(async () => (await attachKept(hostWith(), job, bounded())).kind === 'absent', 'the job name no longer opens');
  });

  it('T-JO-6: a process created through Win32_Process.Create is outside the job and is found as a holder of the marker', async () => {
    const marker = path.join(root, 'jo6.marker');
    const pidFile = path.join(root, 'jo6.pid');
    const holderScript = path.join(root, 'jo6-holder.ps1');
    const creatorScript = path.join(root, 'jo6-creator.ps1');
    fs.writeFileSync(marker, '');
    fs.writeFileSync(holderScript, `$held = [System.IO.File]::Open('${marker}', 'Open', 'Read', 'ReadWrite,Delete')\nSet-Content -LiteralPath '${pidFile}' -Value $PID -NoNewline\nStart-Sleep -Seconds 600\n`);
    fs.writeFileSync(
      creatorScript,
      `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${holderScript}"' } | Out-Null\nStart-Sleep -Seconds 600\n`,
    );
    const { group } = await started({ file: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', creatorScript] }, { marker });
    const outsider = await grandchildOf(pidFile);
    try {
      const listed = await group.members(bounded());
      expect(listed.kind === 'members' && !listed.pids.includes(outsider)).toBe(true);
      const inspector = createWindowsInspector({ run: nodeCommandRunner, env: process.env, groups: createKeptGroupControl(hostWith()), alive: isAlive });
      const holders = await inspector.holdersOf(marker, { signal: bounded() });
      expect(holders.kind === 'value' && holders.value.includes(outsider)).toBe(true);
      expect(await stop(group)).toBe('terminated');
      expect(isAlive(outsider)).toBe(true);
    } finally {
      process.kill(outsider);
    }
  });

  it('T-JO-7: inside an outer job that refuses nesting the product reports containment-unavailable and the command does not run', async () => {
    const ran = path.join(root, 'jo7.ran');
    const launched = productLaunch(node(`require('node:fs').writeFileSync(${JSON.stringify(ran)}, 'ran');`), new AbortController().signal, {
      spawnProcess: ((file: string, args: readonly string[], options: object) => spawn(uiLimitedRun, [file, ...args], options)) as unknown as NonNullable<LaunchOptions['spawnProcess']>,
    });
    const failure = await launched.exited.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GroupContainmentError);
    expect(failure).toMatchObject({ reason: 'containment-unavailable' });
    expect(fs.existsSync(ran)).toBe(false);
  });
});
