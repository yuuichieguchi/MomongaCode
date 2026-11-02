import { describe, expect, it } from 'vitest';
import { nodeCommandRunner } from '../../src/platform/command-runner.ts';

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
