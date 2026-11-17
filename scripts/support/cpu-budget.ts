import { execFile, execFileSync, spawn } from 'node:child_process';
import type { ChildProcess, StdioOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { canStillRun } from '@momonga/foundation';

export const CPU_POLL_MS = 250;
export const CPU_BUDGET_ENV = 'MOMONGA_RUN_CPU_BUDGET_SECONDS';

const execFileAsync = promisify(execFile);

const cpuSecondsOf = (time: string): number => {
  const [days, clock] = time.includes('-') ? (time.split('-') as [string, string]) : ['0', time];
  const parts = clock.split(':').map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part))) throw new Error(`ps printed an unreadable CPU time: ${time}`);
  return parts.reduce((total, part) => total * 60 + part, 0) + Number(days) * 86400;
};

type TreeRow = { readonly pid: number; readonly cpu: number };

const treeOf = async (rootPid: number): Promise<TreeRow[]> => {
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
  return rows.filter((row) => inTree.has(row.pid));
};

export const treeCpuSeconds = async (rootPid: number): Promise<number> => (await treeOf(rootPid)).reduce((total, row) => total + row.cpu, 0);

export type GroupHost = {
  signalGroup: (pgid: number) => void;
  groupStates: () => string;
};

const hostGroups: GroupHost = {
  signalGroup: (pgid) => process.kill(-pgid, 'SIGKILL'),
  groupStates: () => execFileSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
};

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

export type BudgetBreach = { readonly kind: 'cpu'; readonly cpuSeconds: number; readonly budgetCpuSeconds: number } | { readonly kind: 'starter-gone' };

export const breachLine = (breach: BudgetBreach): string =>
  breach.kind === 'cpu'
    ? `run-lock: the command passed its CPU budget of ${breach.budgetCpuSeconds} s (its processes used ${breach.cpuSeconds} CPU s); it was ended`
    : 'run-lock: the process that started this run is gone; the command was ended';

export const usageLine = (cpuSeconds: number, budgetCpuSeconds: number): string =>
  `run-lock: the command's processes used ${cpuSeconds} CPU s of its budget of ${budgetCpuSeconds} s, as last seen alive`;

export type TreeWatch = { readonly stop: () => void; readonly usedCpuSeconds: () => number };

export const watchTree = (rootPid: number, budgetCpuSeconds: number, onBreach: (breach: BudgetBreach) => void): TreeWatch => {
  const starter = process.ppid;
  let stopped = false;
  const seen = new Map<number, number>();
  let used = 0;
  let timer: NodeJS.Timeout | undefined;
  const check = async (): Promise<void> => {
    if (process.ppid !== starter) {
      stopped = true;
      onBreach({ kind: 'starter-gone' });
      return;
    }
    for (const row of await treeOf(rootPid)) seen.set(row.pid, Math.max(row.cpu, seen.get(row.pid) ?? 0));
    if (stopped) return;
    const cpuSeconds = Math.round([...seen.values()].reduce((total, cpu) => total + cpu, 0) * 100) / 100;
    used = cpuSeconds;
    if (cpuSeconds > budgetCpuSeconds) {
      stopped = true;
      onBreach({ kind: 'cpu', cpuSeconds, budgetCpuSeconds });
    }
  };
  const schedule = (): void => {
    timer = setTimeout(() => {
      check().then(
        () => {
          if (!stopped) schedule();
        },
        (error: unknown) => {
          stopped = true;
          throw error;
        },
      );
    }, CPU_POLL_MS);
    timer.unref();
  };
  schedule();
  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
    usedCpuSeconds: () => used,
  };
};

export const killTree = async (rootPid: number): Promise<void> => {
  const pids = (await treeOf(rootPid)).map((row) => row.pid).filter((pid) => pid !== process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
};

export type BoundedEnd = { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly breach: BudgetBreach | undefined; readonly usedCpuSeconds: number };

export type BoundedRun = { readonly child: ChildProcess; readonly end: Promise<BoundedEnd> };

export type BoundedRequest = {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdio: StdioOptions;
  readonly budgetCpuSeconds: number;
};

export const startWithinBudget = (request: BoundedRequest): BoundedRun => {
  const child = spawn(request.command, request.args, { detached: true, stdio: request.stdio, env: request.env });
  const pid = child.pid;
  if (pid === undefined) return { child, end: new Promise<BoundedEnd>((_resolve, reject) => child.once('error', reject)) };
  let breach: BudgetBreach | undefined;
  const watch = watchTree(pid, request.budgetCpuSeconds, (found) => {
    breach = found;
    killGroup(pid);
  });
  const end = new Promise<BoundedEnd>((resolve, reject) => {
    child.once('error', (error) => {
      watch.stop();
      reject(error);
    });
    child.once('close', (code, signal) => {
      watch.stop();
      killGroup(pid);
      resolve({ code, signal, breach, usedCpuSeconds: watch.usedCpuSeconds() });
    });
  });
  return { child, end };
};
