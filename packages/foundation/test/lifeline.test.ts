import fs from 'node:fs';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { EntryUsageError, isProcessAlive, systemTiming, watchLifeline } from '@momonga/foundation';
import { LSOF_PATH, REAL_PROCESS_TEST_TIMEOUT_MS, registerCleanup, spawnTracked, withTempDir, pollUntil, afterMicrotasks } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import type { TrackedChild } from '@momonga/testkit';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const CHILD = path.join(FIXTURES, 'lifeline-child.ts');
const MIDDLE = path.join(FIXTURES, 'lifeline-middle.ts');
const EOF_DEADLINE_MS = 2000;

type Output = { text(): string; stderr(): string; lines(): string[] };

const collect = (child: TrackedChild): Output => {
  let stdout = '';
  let stderr = '';
  (child.stdout as Readable | null)?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  (child.stderr as Readable | null)?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  return { text: () => stdout, stderr: () => stderr, lines: () => stdout.split('\n').filter((line) => line !== '') };
};

const until = (predicate: () => boolean, deadlineMs: number, description: string, detail: () => string = () => ''): Promise<void> =>
  pollUntil(predicate, { description, boundMs: deadlineMs }).catch((error: unknown) => {
    throw new Error(`${error instanceof Error ? error.message : String(error)}${detail() === '' ? '' : `: ${detail()}`}`);
  });

const exitOf = (child: TrackedChild, deadlineMs: number): Promise<number | null> =>
  new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = systemTiming.setTimeout(() => reject(new Error(`child ${child.pid} did not exit within ${deadlineMs} ms`)), deadlineMs);
    child.once('exit', (code) => {
      systemTiming.clearTimeout(timer);
      resolve(code);
    });
  });

const startChild = (context: CleanupContext, env: Record<string, string> = {}): { child: TrackedChild; output: Output; lifeline: Writable } => {
  const child = spawnTracked(context, process.execPath, [CHILD], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const output = collect(child);
  const lifeline = child.stdio[3] as Writable;
  return { child, output, lifeline };
};

const watching = async (child: TrackedChild, output: Output, marker = 'watching'): Promise<void> => {
  await until(() => output.lines().includes(marker) || child.exitCode !== null, 5000, `the child to print ${marker}`, () => output.stderr());
  if (!output.lines().includes(marker)) throw new Error(`the lifeline child exited with ${child.exitCode} before printing ${marker}: ${output.stderr()}`);
};

describe('watchLifeline with real processes', () => {
  it('EOF when the parent end closes', async (context) => {
    const { child, output, lifeline } = startChild(context);
    await watching(child, output);
    lifeline.end();
    expect(await exitOf(child, EOF_DEADLINE_MS)).toBe(0);
    expect(output.lines()).toContain('eof');
  });

  it('EOF when the parent is killed', async (context) => {
    const resultFile = path.join(withTempDir(context), 'result');
    const middle = spawnTracked(context, process.execPath, [MIDDLE, CHILD], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LIFELINE_RESULT_FILE: resultFile },
    });
    const output = collect(middle);
    await until(() => output.lines().some((line) => line.startsWith('child ')), 5000, 'the middle process to report its child', () => output.stderr());
    const childPid = Number.parseInt((output.lines().find((line) => line.startsWith('child ')) as string).slice(6), 10);
    registerCleanup(context, () => {
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {}
    });
    await until(() => fs.existsSync(`${resultFile}.watching`) || !isProcessAlive(childPid), 5000, 'the child to watch its lifeline', () => output.stderr());
    expect(fs.existsSync(`${resultFile}.watching`), `the lifeline child died before watching: ${output.stderr()}`).toBe(true);
    process.kill(middle.pid, 'SIGKILL');
    await until(() => !isProcessAlive(childPid), EOF_DEADLINE_MS, 'the child to exit after its parent was killed');
    expect(fs.readFileSync(resultFile, 'utf8')).toBe('eof');
  });

  it('EOF is delivered even if a grandchild really holds the daemon end', async (context) => {
    const { child, output, lifeline } = startChild(context, { LIFELINE_GRANDCHILD: '1' });
    await until(() => output.lines().some((line) => line.startsWith('grandchild ')), 5000, 'the grandchild pid', () => output.stderr());
    const grandchild = Number.parseInt((output.lines().find((line) => line.startsWith('grandchild ')) as string).slice(11), 10);
    registerCleanup(context, () => {
      try {
        process.kill(grandchild, 'SIGKILL');
      } catch {}
    });
    const lsof = spawnTracked(context, LSOF_PATH, ['-a', '-p', String(grandchild), '-d', '3'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const lsofOutput = collect(lsof);
    await exitOf(lsof, 10_000);
    expect(lsofOutput.text()).toMatch(/unix/i);
    await watching(child, output);
    lifeline.end();
    expect(await exitOf(child, EOF_DEADLINE_MS)).toBe(0);
    expect(output.lines()).toContain('eof');
    expect(isProcessAlive(grandchild)).toBe(true);
  });

  it('a process the supervisor spawns for other purposes holds no lifeline write end', async (context) => {
    const { child, output, lifeline } = startChild(context);
    await watching(child, output);
    const bystander = spawnTracked(context, '/bin/sleep', ['30']);
    lifeline.end();
    expect(await exitOf(child, EOF_DEADLINE_MS)).toBe(0);
    expect(output.lines()).toContain('eof');
    expect(isProcessAlive(bystander.pid)).toBe(true);
  });

  it('no EOF while the parent end stays open', async (context) => {
    const { child, output, lifeline } = startChild(context);
    await watching(child, output);
    lifeline.write('still here\n');
    await until(() => output.lines().includes('line still here') || child.exitCode !== null, 5000, 'the child to read a line from the open lifeline', () => output.stderr());
    expect(child.exitCode).toBeNull();
    expect(output.lines()).not.toContain('eof');
  });

  it('onEnd is called once', async (context) => {
    const { child, output, lifeline } = startChild(context, { LIFELINE_COUNT: '1' });
    await watching(child, output);
    lifeline.end();
    expect(await exitOf(child, EOF_DEADLINE_MS + 1000)).toBe(0);
    expect(output.lines().filter((line) => line.startsWith('calls '))).toEqual(['calls 1']);
  });

  it('dispose stops the watch', async (context) => {
    const { child, output, lifeline } = startChild(context, { LIFELINE_DISPOSE: '1' });
    await watching(child, output, 'disposed');
    lifeline.end();
    expect(await exitOf(child, EOF_DEADLINE_MS + 1000)).toBe(0);
    expect(output.lines()).not.toContain('eof');
    expect(output.lines()).toContain('calls 0');
  });
});

describe('watchLifeline on an unusable fd', () => {
  it('a closed fd is a usage error naming the fd', (context) => {
    const file = path.join(withTempDir(context), 'closed');
    fs.writeFileSync(file, '');
    const onEnd = vi.fn();
    const fd = fs.openSync(file, 'r');
    fs.closeSync(fd);
    let failure: unknown;
    try {
      watchLifeline(fd, { onEnd, onLine: () => undefined, onOverlongLine: () => undefined });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(EntryUsageError);
    expect((failure as Error).message).toContain(`lifeline fd ${fd} is not usable`);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('a regular file fd is a usage error', async (context) => {
    const file = path.join(withTempDir(context), 'regular');
    fs.writeFileSync(file, 'data');
    const fd = fs.openSync(file, 'r');
    registerCleanup(context, () => {
      try {
        fs.closeSync(fd);
      } catch {}
    });
    const onEnd = vi.fn();
    expect(() => watchLifeline(fd, { onEnd, onLine: () => undefined, onOverlongLine: () => undefined })).toThrow(EntryUsageError);
    expect(() => watchLifeline(fd, { onEnd, onLine: () => undefined, onOverlongLine: () => undefined })).toThrow(String(fd));
    await afterMicrotasks();
    expect(onEnd).not.toHaveBeenCalled();
  });
});
