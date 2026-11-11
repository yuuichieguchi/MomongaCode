import fs from 'node:fs';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, spawnTracked, withTempDir } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import type { TrackedChild } from '@momonga/testkit';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const PROTECTED = path.join(FIXTURES, 'epipe-daemon.ts');
const UNPROTECTED = path.join(FIXTURES, 'epipe-daemon-unprotected.ts');

type LogLine = Record<string, unknown> & { msg: string };

const prepareHome = (context: CleanupContext): string => {
  const home = withTempDir(context, { asHome: true });
  fs.mkdirSync(path.join(home, '.momonga', 'logs'), { recursive: true, mode: 0o700 });
  return home;
};

const logLines = (home: string): LogLine[] =>
  fs
    .readFileSync(path.join(home, '.momonga', 'logs', 'runtime.log'), 'utf8')
    .split('\n')
    .filter((entry) => entry !== '')
    .map((entry) => JSON.parse(entry) as LogLine);

const exitOf = (child: TrackedChild): Promise<number | null> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
      return;
    }
    child.once('exit', (code) => resolve(code));
  });

const startDaemon = async (context: CleanupContext, script: string, home: string, logTarget: string, extra: readonly string[] = []) => {
  const child = spawnTracked(context, process.execPath, [script, `--home=${home}`, '--lifeline-fd=3', `--log-target=${logTarget}`, ...extra], {
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const stdoutStream = child.stdout as Readable;
  const stderrStream = child.stderr as Readable;
  const onStderr = (chunk: Buffer): void => {
    stderr += chunk.toString('utf8');
  };
  stderrStream.on('data', onStderr);
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      stdout += chunk.toString('utf8');
      if (!stdout.includes('\n')) return;
      cleanup();
      resolve();
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`daemon exited with ${code} before its ready line; stderr: ${stderr}`));
    };
    const cleanup = (): void => {
      stdoutStream.off('data', onData);
      child.off('exit', onExit);
    };
    stdoutStream.on('data', onData);
    child.once('exit', onExit);
  });
  const ready = JSON.parse(stdout.split('\n')[0] as string) as Record<string, unknown>;
  expect(ready).toMatchObject({ event: 'ready', service: 'runtime', version: '9.9.9' });
  return { child, stdoutStream, stderrStream, lifeline: child.stdio[3] as Writable, stderr: () => stderr };
};

const killSupervisorSide = (daemon: Awaited<ReturnType<typeof startDaemon>>): void => {
  daemon.stderrStream.destroy();
  daemon.stdoutStream.destroy();
  daemon.lifeline.end();
};

const expectGracefulLog = (home: string): void => {
  const lines = logLines(home);
  const messages = lines.map((line) => line.msg);
  expect(messages).toContain('entry.lifeline_eof');
  expect(messages).not.toContain('entry.uncaught');
  expect(messages).toEqual(expect.arrayContaining(['fixture.close.one', 'fixture.close.two', 'fixture.close.three']));
  expect(lines.at(-1)).toMatchObject({ msg: 'entry.exit', code: 0, path: 'close', clean: true, trigger: 'lifeline' });
};

describe('daemon entry with a vanished supervisor', () => {
  it('supervisor death with the file target: graceful close', async (context) => {
    const home = prepareHome(context);
    const daemon = await startDaemon(context, PROTECTED, home, 'file');
    killSupervisorSide(daemon);
    expect(await exitOf(daemon.child)).toBe(0);
    expectGracefulLog(home);
  });

  it('supervisor death with the both target', async (context) => {
    const home = prepareHome(context);
    const daemon = await startDaemon(context, PROTECTED, home, 'both');
    killSupervisorSide(daemon);
    expect(await exitOf(daemon.child)).toBe(0);
    expectGracefulLog(home);
  });

  it('supervisor death with the stderr target still closes gracefully', async (context) => {
    const home = prepareHome(context);
    const daemon = await startDaemon(context, PROTECTED, home, 'stderr');
    killSupervisorSide(daemon);
    expect(await exitOf(daemon.child)).toBe(0);
    expect(fs.existsSync(path.join(home, '.momonga', 'logs', 'runtime.log'))).toBe(false);
  });

  it('negative control: the pre-fix nodeEntryIo', async (context) => {
    const home = prepareHome(context);
    const daemon = await startDaemon(context, UNPROTECTED, home, 'stderr');
    killSupervisorSide(daemon);
    expect(await exitOf(daemon.child)).toBe(1);
  });

  it('exit does not truncate backed-up stderr', async (context) => {
    const home = prepareHome(context);
    const child = spawnTracked(context, process.execPath, [PROTECTED, `--home=${home}`, '--log-target=stderr', '--bulk-bytes=300000'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutStream = child.stdout as Readable;
    const stderrStream = child.stderr as Readable;
    let stdout = '';
    const chunks: Buffer[] = [];
    stderrStream.pause();
    await new Promise<void>((resolve, reject) => {
      stdoutStream.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (stdout.includes('\n')) resolve();
      });
      child.once('exit', (code) => reject(new Error(`daemon exited with ${code} before its ready line: ${Buffer.concat(chunks).toString('utf8')}`)));
      stderrStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    });
    child.kill('SIGTERM');
    const ended = new Promise<void>((resolve) => stderrStream.once('end', () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 200));
    stderrStream.resume();
    await ended;
    const code = await exitOf(child);
    const lines = Buffer.concat(chunks)
      .toString('utf8')
      .split('\n')
      .filter((entry) => entry !== '');
    const last = JSON.parse(lines.at(-1) as string) as LogLine;
    expect(last).toMatchObject({ msg: 'entry.exit', code: 0, path: 'close', clean: true, trigger: 'sigterm' });
    expect(code).toBe(0);
    expect(lines.filter((entry) => entry.includes('fixture.bulk')).length).toBeGreaterThanOrEqual(300);
  });
});
