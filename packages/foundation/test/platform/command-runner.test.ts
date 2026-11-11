import { describe, expect, it } from 'vitest';
import { nodeBoundedCommandRunner, nodeCommandRunner } from '../../src/platform/command-runner.ts';

describe('nodeCommandRunner', () => {
  it('kills the command and rejects when the caller aborts', async () => {
    const controller = new AbortController();
    const running = nodeCommandRunner('/bin/sleep', ['600'], { env: {}, signal: controller.signal });

    controller.abort();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
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
