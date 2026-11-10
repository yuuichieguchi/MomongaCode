import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createExecWithStdin } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, productTestEnv, waitFor } from '@momonga/testkit';
import { rejection } from './support/secret-store-fakes.ts';
import { makeTemporaryDirectory as makeDir } from './support/temporary-directory.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const STAYS_ALIVE = 'setInterval(() => {}, 1000)';
const WRITES_PID_AND_STAYS_ALIVE = `require('node:fs').writeFileSync(process.argv[1], process.pid + '\\n'); ${STAYS_ALIVE}`;
const IGNORES_SIGTERM = `process.on('SIGTERM', () => {}); ${WRITES_PID_AND_STAYS_ALIVE}`;
const WRITES_MARKER = "require('node:fs').writeFileSync(process.argv[1], 'started')";

const run = (): ReturnType<typeof createExecWithStdin> => createExecWithStdin(productTestEnv());

const writtenPid = (file: string): number | undefined => {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return text.endsWith('\n') ? Number(text) : undefined;
};

const pidWrittenTo = async (file: string): Promise<number> => {
  await waitFor(() => writtenPid(file) !== undefined, { description: `the child wrote its pid to ${file}` });
  return writtenPid(file) as number;
};

const isGone = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
};

const killIfAlive = (pid: number | undefined): void => {
  if (pid === undefined || isGone(pid)) return;
  process.kill(pid, 'SIGKILL');
};

describe('createExecWithStdin under the signal of the operation', () => {
  it("aborting rejects with the signal's reason itself", async () => {
    const controller = new AbortController();
    const attempt = run()(process.execPath, ['-e', STAYS_ALIVE], '', controller.signal);
    const reason = new Error('the operation limit passed');
    controller.abort(reason);
    expect(await rejection(attempt)).toBe(reason);
  });

  it('an already aborted signal starts no child', async () => {
    const marker = path.join(makeDir(), 'started');
    const controller = new AbortController();
    const reason = new Error('already gone');
    controller.abort(reason);
    expect(await rejection(run()(process.execPath, ['-e', WRITES_MARKER, marker], '', controller.signal))).toBe(reason);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('a child that ignores SIGTERM does not hold the promise', async (context) => {
    const pidFile = path.join(makeDir(), 'pid');
    context.onTestFinished(() => killIfAlive(writtenPid(pidFile)));
    const controller = new AbortController();
    const attempt = run()(process.execPath, ['-e', IGNORES_SIGTERM, pidFile], '', controller.signal);
    attempt.catch(() => undefined);
    const pid = await pidWrittenTo(pidFile);
    const reason = new Error('the operation limit passed');
    controller.abort(reason);
    expect(await rejection(attempt)).toBe(reason);
    expect(isGone(pid)).toBe(false);
  });

  it('aborting kills the child', async (context) => {
    const pidFile = path.join(makeDir(), 'pid');
    context.onTestFinished(() => killIfAlive(writtenPid(pidFile)));
    const controller = new AbortController();
    const attempt = run()(process.execPath, ['-e', WRITES_PID_AND_STAYS_ALIVE, pidFile], '', controller.signal);
    attempt.catch(() => undefined);
    const pid = await pidWrittenTo(pidFile);
    controller.abort(new Error('the operation limit passed'));
    await rejection(attempt);
    await waitFor(() => isGone(pid), { description: `the child ${pid} is gone` });
    expect(isGone(pid)).toBe(true);
  });

  it('answers with the exit code, stdout and stderr of a child that ends by itself', async () => {
    const result = await run()(process.execPath, ['-e', "process.stdin.on('data', (chunk) => process.stdout.write(chunk)); process.stdin.on('end', () => { process.stderr.write('done'); process.exitCode = 3; })"], 'given', new AbortController().signal);
    expect(result).toEqual({ exitCode: 3, stdout: 'given', stderr: 'done' });
  });
});
