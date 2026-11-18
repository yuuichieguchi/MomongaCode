import fs from 'node:fs';
import os from 'node:os';
import { killGroup, startWithinBudget } from '../../scripts/support/cpu-budget.ts';
import { createTempDir } from '../../packages/testkit/src/test-support.ts';
import type { ModuleLimits, TlcRun, TlcRunOptions } from './manifest.ts';
import { tlcWorkersOf } from './tlc-rows.ts';

export const TLC_WORKERS = tlcWorkersOf(os.availableParallelism());

export const notProvedText = (config: string, limits: ModuleLimits): string =>
  [`${config}: what the ${limits.module} model does not prove:`, ...limits.notProved.map((claim) => `  - ${claim}`)].join('\n') + '\n';

export { CPU_POLL_MS, groupKiller, killGroup, treeCpuSeconds } from '../../scripts/support/cpu-budget.ts';
export type { GroupHost } from '../../scripts/support/cpu-budget.ts';

const liveGroups = new Set<number>();
const liveDirectories = new Set<string>();

export const trackGroup = (pgid: number): (() => void) => {
  liveGroups.add(pgid);
  return () => {
    liveGroups.delete(pgid);
  };
};

const trackDirectory = (dir: string): (() => void) => {
  liveDirectories.add(dir);
  return () => {
    liveDirectories.delete(dir);
  };
};

const cleanUpLive = (): void => {
  for (const pgid of liveGroups) killGroup(pgid);
  for (const dir of liveDirectories) fs.rmSync(dir, { recursive: true, force: true });
};

process.on('exit', cleanUpLive);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    cleanUpLive();
    process.kill(process.pid, signal);
  });
}

export const runTlc = async (options: TlcRunOptions): Promise<TlcRun> => {
  const metadir = createTempDir();
  const untrackDirectory = trackDirectory(metadir);
  try {
    const { child, end } = startWithinBudget({
      command: options.script,
      args: [options.config, ...options.args, '-workers', String(TLC_WORKERS)],
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env, TLC_METADIR: metadir },
      budgetCpuSeconds: options.budgetCpuSeconds,
    });
    const pid = child.pid;
    if (pid === undefined) throw new Error(`${options.script} did not start`);
    const untrackGroup = trackGroup(pid);
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    try {
      const ended = await end;
      return { pid, exitCode: ended.code, signal: ended.signal, killedAtCpuBudget: ended.breach?.kind === 'cpu', usedCpuSeconds: ended.usedCpuSeconds, metadir, stdout, stderr };
    } finally {
      killGroup(pid);
      untrackGroup();
    }
  } finally {
    fs.rmSync(metadir, { recursive: true, force: true });
    untrackDirectory();
  }
};
