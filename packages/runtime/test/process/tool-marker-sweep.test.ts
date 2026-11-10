import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { momongaPaths } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock, createFakeTimers, withTempDir } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { TOOL_MARKER_SWEEP_MS } from '../../src/process/constants.ts';
import { START_MS, writeUserSettings } from './helpers.ts';
import { SERVING_TICK_MS, entriesNamed, launchRuntime, modelSettings, passServingTime } from './run-helpers.ts';
import type { RunHome } from './run-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const sandboxSweeps = vi.hoisted(() => ({ calls: 0, failure: undefined as Error | undefined }));

vi.mock('@momonga/sandbox', async (importOriginal) => {
  const original = await importOriginal<typeof import('@momonga/sandbox')>();
  return {
    ...original,
    createBubblewrapSandbox: (options: Parameters<typeof original.createBubblewrapSandbox>[0]) => {
      const sandbox = original.createBubblewrapSandbox(options);
      return {
        ...sandbox,
        sweep: () => {
          sandboxSweeps.calls += 1;
          if (sandboxSweeps.failure !== undefined) throw sandboxSweeps.failure;
          sandbox.sweep?.();
        },
      };
    },
  };
});

beforeEach(() => {
  sandboxSweeps.calls = 0;
  sandboxSweeps.failure = undefined;
});

const NON_SWEEP_LEASE_MS = 7000;

const trackedRunHome = (context: CleanupContext): RunHome => {
  const home = withTempDir(context, { asHome: true });
  const root = withTempDir(context);
  writeUserSettings(home, { sandbox: 'none', ...modelSettings(path.join(root, 'up.sock')) });
  return { root, home, paths: momongaPaths(home, process.platform, {}), project: root };
};

describe('tool marker sweep wiring (§8)', () => {
  it('the tool marker sweep constant is the default lease length', () => {
    expect(TOOL_MARKER_SWEEP_MS).toBe(30_000);
  });

  it('timers teardown: the serving tick that carries the sweep is armed while running, no timer of the sweep interval exists, and none is pending after close (fake timers)', async (context) => {
    const temp = trackedRunHome(context);
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const launched = await launchRuntime(temp, { clock, fakeTimers: timers, leaseMs: NON_SWEEP_LEASE_MS });

    expect(timers.pending().filter((timer) => timer.delayMs === TOOL_MARKER_SWEEP_MS)).toHaveLength(0);
    expect(timers.pending().some((timer) => timer.delayMs === SERVING_TICK_MS)).toBe(true);
    expect(await launched.handle.close()).toEqual({ clean: true, abandoned: [], stragglers: [] });
    expect(timers.pending()).toEqual([]);
  });

  describe('the kept placeholders of the bubblewrap sandbox', () => {
    const bubblewrapHome = (context: CleanupContext): RunHome => {
      const temp = trackedRunHome(context);
      writeUserSettings(temp.home, { sandbox: 'bubblewrap', ...modelSettings(path.join(temp.root, 'up.sock')) });
      return temp;
    };

    const launchBubblewrap = (temp: RunHome) => {
      const clock = createFakeClock(START_MS);
      const timers = createFakeTimers(clock);
      const bwrap = path.join(temp.root, 'bwrap');
      fs.writeFileSync(bwrap, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      return { timers, launched: launchRuntime(temp, { clock, fakeTimers: timers, leaseMs: NON_SWEEP_LEASE_MS, platform: 'linux', sandboxExecPath: bwrap }) };
    };

    it('are retried by the tool marker sweep at each interval, not only at the next command', async (context) => {
      const { timers, launched } = launchBubblewrap(bubblewrapHome(context));
      await launched;
      expect(sandboxSweeps.calls).toBe(0);
      await passServingTime(timers, TOOL_MARKER_SWEEP_MS, () => sandboxSweeps.calls === 1, 'the first sandbox sweep');
      await passServingTime(timers, TOOL_MARKER_SWEEP_MS, () => sandboxSweeps.calls === 2, 'the second sandbox sweep');
    });

    it('report a sweep that fails without stopping the runtime', async (context) => {
      const failure = new Error('the kept placeholder could not be removed');
      sandboxSweeps.failure = failure;
      const { timers, launched } = launchBubblewrap(bubblewrapHome(context));
      const runtime = await launched;
      await passServingTime(timers, TOOL_MARKER_SWEEP_MS, () => entriesNamed(runtime.logger, 'runtime error').some((entry) => entry.fields?.err === failure), 'the sweep failure to be reported');
      expect(entriesNamed(runtime.logger, 'runtime.fatal')).toEqual([]);
    });
  });
});
