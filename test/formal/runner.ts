import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TlcRun, TlcRunOptions } from './manifest.ts';

export const TLC_WORKERS = Math.ceil(os.availableParallelism() / 2);

const liveGroups = new Set<number>();

const killGroup = (pgid: number): void => {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
};

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
    let killedAtBudget = false;
    const timer = setTimeout(() => {
      killedAtBudget = true;
      killGroup(pid);
    }, options.budgetSeconds * 1000);
    try {
      const [exitCode, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, closeSignal) => {
          resolve([code, closeSignal]);
        });
      });
      return { pid, exitCode, signal, killedAtBudget, stdout, stderr };
    } finally {
      clearTimeout(timer);
      killGroup(pid);
      liveGroups.delete(pid);
    }
  } finally {
    fs.rmSync(metadir, { recursive: true, force: true });
  }
};
