import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { TlcRun, TlcRunOptions } from './manifest.ts';

export const TLC_WORKERS = Math.ceil(os.availableParallelism() / 2);

const execFileAsync = promisify(execFile);

export const CPU_POLL_MS = 250;

const cpuSecondsOf = (time: string): number => {
  const [days, clock] = time.includes('-') ? (time.split('-') as [string, string]) : ['0', time];
  const parts = clock.split(':').map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part))) throw new Error(`ps printed an unreadable CPU time: ${time}`);
  return parts.reduce((total, part) => total * 60 + part, 0) + Number(days) * 86400;
};

export const treeCpuSeconds = async (rootPid: number): Promise<number> => {
  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid=,time='], { maxBuffer: 64 * 1024 * 1024 });
  const rows = stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [pid, ppid, time] = line.trim().split(/\s+/);
      return { pid: Number(pid), ppid: Number(ppid), cpu: cpuSecondsOf(time as string) };
    });
  const inTree = new Set<number>([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (!inTree.has(row.pid) && inTree.has(row.ppid)) {
        inTree.add(row.pid);
        grew = true;
      }
    }
  }
  return rows.filter((row) => inTree.has(row.pid)).reduce((total, row) => total + row.cpu, 0);
};

const liveGroups = new Set<number>();

export type GroupHost = {
  signalGroup: (pgid: number) => void;
  groupStates: () => string;
};

const hostGroups: GroupHost = {
  signalGroup: (pgid) => process.kill(-pgid, 'SIGKILL'),
  groupStates: () => execFileSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
};

const RUN_STATES_PAST_RUNNING = new Set(['Z', 'X']);
const EXITING_FLAG = 'E';

const canStillRun = (stat: string): boolean => !RUN_STATES_PAST_RUNNING.has(stat.charAt(0)) && !stat.slice(1).includes(EXITING_FLAG);

const membersThatCanStillRun = (host: GroupHost, pgid: number): number[] =>
  host
    .groupStates()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([, group, stat]) => Number(group) === pgid && stat !== undefined && canStillRun(stat))
    .map(([pid]) => Number(pid));

export const groupKiller =
  (host: GroupHost) =>
  (pgid: number): void => {
    try {
      host.signalGroup(pgid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      if (membersThatCanStillRun(host, pgid).length > 0) throw error;
    }
  };

export const killGroup = groupKiller(hostGroups);

process.on('exit', () => {
  for (const pgid of liveGroups) killGroup(pgid);
});

const metadirPrefix = (): string => {
  const token = process.env['MOMONGA_TEST_RUN'];
  if (token === undefined) throw new Error('MOMONGA_TEST_RUN is not set; run through a vitest project with the leak-guard global setup');
  return `mmt-${token}-tlc-`;
};

export const runTlc = async (options: TlcRunOptions): Promise<TlcRun> => {
  const metadir = fs.mkdtempSync(path.join(os.tmpdir(), metadirPrefix()));
  try {
    const child = spawn(options.script, [options.config, ...options.args, '-workers', String(TLC_WORKERS)], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env, TLC_METADIR: metadir },
    });
    const pid = child.pid;
    if (pid === undefined) throw new Error(`${options.script} did not start`);
    liveGroups.add(pid);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    let killedAtCpuBudget = false;
    let finished = false;
    let wake: () => void = () => undefined;
    const closed = new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, closeSignal) => {
        finished = true;
        wake();
        resolve([code, closeSignal]);
      });
    });
    const pause = (): Promise<void> =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, CPU_POLL_MS);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    const watchCpu = async (): Promise<void> => {
      while (!finished) {
        await pause();
        if (finished) return;
        const cpu = await treeCpuSeconds(pid);
        if (finished) return;
        if (cpu > options.budgetCpuSeconds) {
          killedAtCpuBudget = true;
          killGroup(pid);
          return;
        }
      }
    };
    try {
      const [[exitCode, signal]] = await Promise.all([closed, watchCpu()]);
      return { pid, exitCode, signal, killedAtCpuBudget, stdout, stderr };
    } finally {
      finished = true;
      wake();
      killGroup(pid);
      liveGroups.delete(pid);
    }
  } finally {
    fs.rmSync(metadir, { recursive: true, force: true });
  }
};
