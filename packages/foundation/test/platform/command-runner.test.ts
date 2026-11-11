import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { waitFor } from '@momonga/testkit';
import { makeTemporaryDirectory } from '../support/temporary-directory.ts';
import { ProgramSignalledError, nodeBoundedCommandRunner, nodeCommandRunner } from '../../src/platform/command-runner.ts';

describe('nodeCommandRunner', () => {
  it('rejects with the reason of the abort at once and leaves the command that ignores SIGTERM to end by itself', async (context) => {
    const pidFile = path.join(makeTemporaryDirectory(), 'pid');
    const controller = new AbortController();
    const running = nodeCommandRunner(process.execPath, ['-e', "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)", pidFile], { env: {}, signal: controller.signal });
    running.catch(() => undefined);
    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8') !== '', { description: 'the command wrote its pid' });
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    context.onTestFinished(() => {
      process.kill(pid, 'SIGKILL');
    });
    const reason = new Error('the asker left');
    controller.abort(reason);

    await expect(running).rejects.toBe(reason);
    expect(() => process.kill(pid, 0)).not.toThrow();
  });

  it('gives the command its input on stdin', async () => {
    expect(await nodeCommandRunner('/bin/cat', [], { env: {}, input: 'given' })).toEqual({ exitCode: 0, stdout: 'given', stderr: '' });
  });

  it('starts the command as the leader of its own process group, the one launch port', async () => {
    const result = await nodeCommandRunner('/bin/sh', ['-c', 'echo $$; ps -o pgid= -p $$'], { env: { PATH: '/bin:/usr/bin' } });
    const [pid, pgid] = result.stdout.trim().split(/\s+/);
    expect(pgid).toBe(pid);
  });

  it('rejects with a ProgramSignalledError when the command is ended by a signal', async () => {
    await expect(nodeCommandRunner('/bin/sh', ['-c', 'kill -9 $$'], { env: {} })).rejects.toBeInstanceOf(ProgramSignalledError);
  });

  it('answers the exit code of a command that fails', async () => {
    expect(await nodeCommandRunner('/bin/sh', ['-c', 'exit 3'], { env: {} })).toEqual({ exitCode: 3, stdout: '', stderr: '' });
  });
});

describe('nodeBoundedCommandRunner', () => {
  it('answers that the command timed out, with what it printed, instead of rejecting when the bound ends first', async () => {
    const result = await nodeBoundedCommandRunner('/bin/sh', ['-c', 'echo started; echo waiting >&2; exec sleep 600'], { env: {}, timeoutMs: 400 });

    expect(result).toEqual({ timedOut: true, timeoutMs: 400, stdout: 'started\n', stderr: 'waiting\n' });
  });

  it('answers the exit code of a command that ends inside its bound', async () => {
    expect(await nodeBoundedCommandRunner('/bin/sh', ['-c', 'echo out; exit 3'], { env: {}, timeoutMs: 60_000 })).toEqual({ exitCode: 3, stdout: 'out\n', stderr: '' });
  });

  it('rejects with the abort when the caller aborts inside the bound', async () => {
    const controller = new AbortController();
    const running = nodeBoundedCommandRunner('/bin/sleep', ['600'], { env: {}, timeoutMs: 60_000, signal: controller.signal });

    controller.abort();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects with the host error when the program is not there', async () => {
    await expect(nodeBoundedCommandRunner('/nonexistent/program', [], { env: {}, timeoutMs: 60_000 })).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
