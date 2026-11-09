import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STOP_MESSAGE_MAX_BYTES, formatStopMessage } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, spawnTracked } from '@momonga/testkit';
import type { CleanupContext, TrackedChild } from '@momonga/testkit';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'lifeline-drain-child.ts');
const REPORT_DEADLINE_MS = 10_000;

type Report = { seenAtSignal: number; lines: string[]; overlong: number };

const until = async (predicate: () => boolean, description: string, detail: () => string): Promise<void> => {
  const deadline = Date.now() + REPORT_DEADLINE_MS;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}: ${detail()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const start = async (context: CleanupContext) => {
  const child: TrackedChild = spawnTracked(context, process.execPath, [CHILD], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], env: { ...process.env } });
  let stdout = '';
  let stderr = '';
  (child.stdout as Readable).on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  (child.stderr as Readable).on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const lines = (): string[] => stdout.split('\n').filter((line) => line !== '');
  await until(() => lines().includes('watching'), 'the child to watch its lifeline', () => stderr);
  const lifeline = child.stdio[3] as Writable;
  const write = (text: string): Promise<void> =>
    new Promise((resolve, reject) => {
      lifeline.write(text, (error) => (error === null || error === undefined ? resolve() : reject(error)));
    });
  const reportAfterSigterm = async (): Promise<Report> => {
    child.kill('SIGTERM');
    await until(() => lines().some((line) => line.startsWith('{')), 'the child report', () => stderr);
    return JSON.parse(lines().find((line) => line.startsWith('{')) as string) as Report;
  };
  const blocking = (): Promise<void> => until(() => lines().includes('blocking'), 'the child to block', () => stderr);
  return { write, reportAfterSigterm, blocking };
};

const MESSAGE = formatStopMessage({ closeGraceMs: 4321, managedServerStopGraceMs: 12 });

describe('the lifeline watcher over a real pipe (the delivered-but-unread order at the signal is covered by the fake-watcher test in daemon-entry-stop-values.test.ts)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('after a drain begun on SIGTERM, every line written before the signal has been delivered, including lines written while the reader was blocked', async (context) => {
    const reader = await start(context);
    const noise = Array.from({ length: 200 }, (_, index) => `noise ${index}`).join('\n');
    await reader.write('block\n');
    await reader.blocking();
    await reader.write(`${noise}\n${MESSAGE}`);
    const report = await reader.reportAfterSigterm();
    expect(report.lines).toHaveLength(201);
    expect(report.lines.at(-1)).toBe(MESSAGE.trimEnd());
  });

  it('a line over the 256-byte cap is reported once as overlong and the next line is still read whole', async (context) => {
    const reader = await start(context);
    expect(STOP_MESSAGE_MAX_BYTES).toBe(256);
    await reader.write(`${'x'.repeat(STOP_MESSAGE_MAX_BYTES + 1)}\n${MESSAGE}`);
    const report = await reader.reportAfterSigterm();
    expect(report.overlong).toBe(1);
    expect(report.lines).toEqual([MESSAGE.trimEnd()]);
  });

  it('a line of exactly 256 bytes is within the cap', async (context) => {
    const reader = await start(context);
    const exact = 'y'.repeat(STOP_MESSAGE_MAX_BYTES);
    await reader.write(`${exact}\n`);
    const report = await reader.reportAfterSigterm();
    expect(report.overlong).toBe(0);
    expect(report.lines).toEqual([exact]);
  });

  it('a megabyte with no newline is dropped as one overlong line without holding the reader, and the following message is read', async (context) => {
    const reader = await start(context);
    await reader.write('z'.repeat(1024 * 1024));
    await reader.write(`\n${MESSAGE}`);
    const report = await reader.reportAfterSigterm();
    expect(report.overlong).toBe(1);
    expect(report.lines).toEqual([MESSAGE.trimEnd()]);
  });
});
