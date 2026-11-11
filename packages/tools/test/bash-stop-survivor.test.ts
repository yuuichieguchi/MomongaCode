import { TEST_CHILD_UNPROTECTED } from '@momonga/testkit';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ProcessGroupPort } from '@momonga/foundation';
import type { Sandbox } from '@momonga/sandbox';
import { launch } from '../../sandbox/src/process.ts';
import type { LaunchOptions } from '../../sandbox/src/process.ts';
import { virtualTiming, driveUntil } from '../../foundation/test/support/probe-fakes.ts';
import { bashTool } from '../src/builtins/bash.ts';
import { call, toolSetOf } from './harness.ts';
import { LEAVER_PGID, markerOf, resultOf, world } from './guard-world.ts';

const KILL_GRACE_MS = 300;
const COMMAND_OUTPUT = 'survivor-output';
const FOUR_OCCASIONS = 'at most once at each of: before the next command that runs a process or changes files, the periodic check, start-up and shutdown';

const survivingSandbox = (timing: ReturnType<typeof virtualTiming>): Sandbox => {
  const survivorPort: ProcessGroupPort = { signal: async () => undefined, alive: async () => true };
  return {
    kind: 'none',
    spawn: (_command, _policy, signal) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), { pid: LEAVER_PGID, stdout, stderr, stdin: null });
      const launched = launch({ protection: TEST_CHILD_UNPROTECTED,
        file: '/bin/bash',
        args: [],
        cwd: '/',
        env: {},
        signal,
        killGraceMs: KILL_GRACE_MS,
        afterExit: () => undefined,
        spawnProcess: (() => child) as unknown as NonNullable<LaunchOptions['spawnProcess']>,
        groupPort: survivorPort,
        timing,
      } as LaunchOptions);
      setImmediate(() => {
        stdout.end(`${COMMAND_OUTPUT}\n`);
        stderr.end();
        child.emit('exit', 0, null);
      });
      return launched;
    },
  };
};

describe('a command whose process group keeps a member that survives the stop', () => {
  it('returns the command result with a note that a process it started is still running and will be tried again at the four occasions, and keeps the marker', async () => {
    const timing = virtualTiming();
    const h = world('held', {}, new Set([LEAVER_PGID]));
    const batch = h.harness.executor.runBatch(
      await h.harness.input(await toolSetOf(bashTool), [call('survivor', 'Bash', { command: 'echo survivor-output' }, 'allow_once')], { sandbox: survivingSandbox(timing) }),
    );
    let done = false;
    void batch.finally(() => {
      done = true;
    });
    await driveUntil(timing, () => done, 1000 * KILL_GRACE_MS, 'the stop to end');
    const [outcome] = await batch;
    const result = resultOf(outcome);
    expect(result.status).toBe('completed');
    expect(result.output).toContain(COMMAND_OUTPUT);
    expect(result.output).toContain('Note: the command finished (exit code 0) and its output is above.');
    expect(result.output).toContain('is still running');
    expect(result.output).toContain(FOUR_OCCASIONS);
    expect(result.output).not.toContain('could not check');
    expect(result.output).not.toContain('/markers ignore');
    expect(fs.existsSync(markerOf(h, 'survivor'))).toBe(true);
  });
});
