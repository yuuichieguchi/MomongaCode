import * as childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { recordingLaunchOf } from './reuse-recorder.ts';

describe('the launch recording of the test reuse recorder', () => {
  it('keeps the promisified form of a launcher, so promisify(execFile) still resolves stdout and stderr, and records the start', async () => {
    let started = 0;
    const recorded = recordingLaunchOf(childProcess.execFile as unknown as (...args: unknown[]) => unknown, () => {
      started += 1;
    });
    const result = (await promisify(recorded as unknown as typeof childProcess.execFile)(process.execPath, ['-e', 'process.stdout.write("out")'])) as { stdout: string; stderr: string };
    expect(result).toEqual({ stdout: 'out', stderr: '' });
    expect(started).toBe(1);
  });
});
