import fs from 'node:fs';
import type { Readable } from 'node:stream';
import { spawnProduct } from './product-spawn.ts';
import type { CleanupContext, TrackedChild } from './test-support.ts';

export const DAEMON_BIN_READY_DEADLINE_MS = 30_000;
export const DAEMON_BIN_EXIT_DEADLINE_MS = 30_000;

export type DaemonBin = {
  child: TrackedChild;
  stdoutLines(): string[];
  stderrLines(): string[];
  waitForReady(): Promise<string>;
  waitForExit(): Promise<number | null>;
};

const linesOf = (text: string): string[] => text.split('\n').filter((line) => line !== '');

export const startDaemonBin = (context: CleanupContext | undefined, bin: string, args: readonly string[], env: Readonly<Record<string, string>>): DaemonBin => {
  const child = spawnProduct(context, process.execPath, [bin, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...env } });
  let stdout = '';
  let stderr = '';
  const readyWaiters: Array<(line: string) => void> = [];
  (child.stdout as Readable).on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    const newline = stdout.indexOf('\n');
    if (newline === -1 || readyWaiters.length === 0) return;
    const line = stdout.slice(0, newline);
    for (const waiter of readyWaiters.splice(0)) waiter(line);
  });
  (child.stderr as Readable).on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const exited = new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
    else child.once('exit', (code) => resolve(code));
  });

  const waitForReady = async (): Promise<string> => {
    const ready = new Promise<string>((resolve) => {
      const newline = stdout.indexOf('\n');
      if (newline !== -1) resolve(stdout.slice(0, newline));
      else readyWaiters.push(resolve);
    });
    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(
        () => reject(new Error(`${bin} printed no ready line within ${DAEMON_BIN_READY_DEADLINE_MS} ms; stderr:\n${stderr}`)),
        DAEMON_BIN_READY_DEADLINE_MS,
      );
    });
    const exitRace = exited.then((code) => {
      throw new Error(`${bin} exited with ${code ?? child.signalCode} before ready; stderr:\n${stderr}`);
    });
    try {
      return await Promise.race([ready, exitRace, deadline]);
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    }
  };

  const waitForExit = (): Promise<number | null> =>
    Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${bin} did not exit within ${DAEMON_BIN_EXIT_DEADLINE_MS} ms`)), DAEMON_BIN_EXIT_DEADLINE_MS);
        void exited.then(() => clearTimeout(timer));
      }),
    ]);

  return { child, stdoutLines: () => linesOf(stdout), stderrLines: () => linesOf(stderr), waitForReady, waitForExit };
};

export const readJsonLinesFile = (file: string): Array<Record<string, unknown>> =>
  linesOf(fs.readFileSync(file, 'utf8')).map((line) => JSON.parse(line) as Record<string, unknown>);
