import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@momonga/config';
import { EXIT_ALREADY_RUNNING, EXIT_CONFIG, EXIT_FAILURE, ProcessLockHeldError, ensureMomongaDirs } from '@momonga/foundation';
import { trackGroup, writeInvalidUserSettings, writeUserSettings } from './helpers.ts';
import { RUNTIME_VERSION, captureStream, failureOf, hookLogger, launchRuntime, makeRunHome, runtimeAlreadyRunningError, startRuntimeProcess, startStack } from './run-helpers.ts';
import type { RunHome } from './run-helpers.ts';

const PROCESS_TIMEOUT = { timeout: 60_000 };

const exitClassOf = (error: unknown): number => {
  if (error instanceof ConfigError) return EXIT_CONFIG;
  if (error instanceof runtimeAlreadyRunningError()) return EXIT_ALREADY_RUNNING;
  return EXIT_FAILURE;
};

const spawnDetachedSleeper = (): number => {
  const child = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
  const pid = child.pid;
  if (pid === undefined) throw new Error('sleeper did not spawn');
  child.unref();
  trackGroup(pid);
  return pid;
};

const startFailure = (temp: RunHome, extra: Record<string, unknown> = {}): Promise<unknown> =>
  failureOf(startRuntimeProcess({ home: temp.home, version: RUNTIME_VERSION, logger: hookLogger(() => undefined), stdout: captureStream(), ...extra }));

describe('exit classes of startRuntimeProcess errors (system timers)', () => {
  it('exit 75 applies only when the error is a ProcessLockHeldError with lockPath equal to paths.locks.runtime', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    await launchRuntime(stack.temp);
    const error = await startFailure(stack.temp);
    expect(error).toBeInstanceOf(ProcessLockHeldError);
    expect((error as ProcessLockHeldError).lockPath).toBe(stack.temp.paths.locks.runtime);
    expect(exitClassOf(error)).toBe(75);

    const foreign = new ProcessLockHeldError('held', stack.temp.paths.locks.runtime, 4242);
    expect(exitClassOf(foreign)).toBe(1);
  });

  it('a ProcessLockHeldError from listenUnix (lockPath <runtime.sock>.lock) is classified as exit 1', PROCESS_TIMEOUT, async () => {
    const temp = makeRunHome();
    writeUserSettings(temp.home, { sandbox: 'none' });
    await ensureMomongaDirs(temp.paths);
    const holder = spawnDetachedSleeper();
    fs.writeFileSync(`${temp.paths.sockets.runtime}.lock`, `${holder}\n`, { mode: 0o600 });
    const error = await startFailure(temp);
    expect(error).toBeInstanceOf(ProcessLockHeldError);
    expect((error as ProcessLockHeldError).lockPath).toBe(`${temp.paths.sockets.runtime}.lock`);
    expect(exitClassOf(error)).toBe(1);
  });

  it('ConfigError is classified as 78 and any other error as 1', PROCESS_TIMEOUT, async () => {
    const invalid = makeRunHome();
    fs.mkdirSync(invalid.paths.root, { recursive: true, mode: 0o700 });
    writeInvalidUserSettings(invalid.home);
    const configError = await startFailure(invalid);
    expect(configError).toBeInstanceOf(ConfigError);
    expect(exitClassOf(configError)).toBe(78);

    const occupied = makeRunHome();
    writeUserSettings(occupied.home, { sandbox: 'none' });
    await ensureMomongaDirs(occupied.paths);
    fs.writeFileSync(occupied.paths.sockets.runtime, 'not a socket');
    const other = await startFailure(occupied);
    expect(other).toBeInstanceOf(Error);
    expect(other).not.toBeInstanceOf(ConfigError);
    expect(exitClassOf(other)).toBe(1);
  });
});
