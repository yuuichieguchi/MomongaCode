import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ProcessGroupPort } from '@momonga/foundation';
import type { Sandbox } from '@momonga/sandbox';
import { launch } from '../../sandbox/src/process.ts';
import type { LaunchOptions } from '../../sandbox/src/process.ts';
import { virtualTiming } from '../../foundation/test/support/probe-fakes.ts';
import { grepTool } from '../src/builtins/grep.ts';
import type { RipgrepLocator } from '../src/ripgrep-locator.ts';
import { call, toolSetOf } from './harness.ts';
import { LEAVER_PGID, resultOf, world } from './guard-world.ts';

const KILL_GRACE_MS = 300;
const STILL_RUNNING = 'At least one process started by it is still running';
const FOUR_OCCASIONS = 'at most once at each of: before the next command that runs a process or changes files, the periodic check, start-up and shutdown';

const fakeRipgrep: RipgrepLocator = { locate: async () => ({ ok: true, path: '/fake/rg', source: 'path', version: '15.2.0', release: async () => undefined }) };

const ripgrepSandbox = (timing: ReturnType<typeof virtualTiming>, survives: boolean): Sandbox => {
  let alive = true;
  const groupPort: ProcessGroupPort = {
    signal: async () => {
      if (!survives) alive = false;
    },
    alive: async () => alive,
  };
  return {
    kind: 'none',
    spawn: (_command, _policy, signal) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), { pid: LEAVER_PGID, stdout, stderr, stdin: null });
      const launched = launch({
        file: '/fake/rg',
        args: [],
        cwd: '/',
        env: {},
        signal,
        killGraceMs: KILL_GRACE_MS,
        afterExit: () => undefined,
        spawnProcess: (() => child) as unknown as NonNullable<LaunchOptions['spawnProcess']>,
        groupPort,
        timing,
      } as LaunchOptions);
      setImmediate(() => {
        stdout.end();
        stderr.end();
        child.emit('exit', 1, null);
      });
      return launched;
    },
  };
};

const runGrep = async (survives: boolean) => {
  const timing = virtualTiming();
  const h = survives ? world('held', {}, new Set([LEAVER_PGID])) : world('free', {}, new Set());
  const batch = h.harness.executor.runBatch(
    h.harness.input(await toolSetOf(grepTool), [call('search', 'Grep', { pattern: 'needle' }, 'allow_once')], { sandbox: ripgrepSandbox(timing, survives), ripgrep: fakeRipgrep }),
  );
  let done = false;
  void batch.finally(() => {
    done = true;
  });
  for (let step = 1; !done && step <= 1000; step += 1) await timing.advanceTo(step * KILL_GRACE_MS);
  const [outcome] = await batch;
  return { result: resultOf(outcome), markers: fs.readdirSync(h.harness.markerDir) };
};

describe('Grep spawns ripgrep under the same marker as every other spawn, so decision 12 reaches a ripgrep group member that survives the stop', () => {
  it('returns the search result with the still-running note and keeps a marker for the four occasions', async () => {
    const { result, markers } = await runGrep(true);
    expect(result.status).toBe('completed');
    expect(result.output).toContain('No matches found');
    expect(result.output).toContain(STILL_RUNNING);
    expect(result.output).toContain(FOUR_OCCASIONS);
    expect(result.output).not.toContain('Internal error');
    expect(markers).toHaveLength(1);
  });

  it('returns the search result with no note and leaves no marker when the members stop', async () => {
    const { result, markers } = await runGrep(false);
    expect(result).toMatchObject({ status: 'completed', output: 'No matches found' });
    expect(markers).toEqual([]);
  });
});
