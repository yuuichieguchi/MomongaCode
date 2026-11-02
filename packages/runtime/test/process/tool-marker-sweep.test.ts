import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson, ensureMomongaDirs, momongaPaths, sha256Hex } from '@momonga/foundation';
import { createFakeClock, createFakeTimers, withTempDir } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { createToolRegistry, defineTool } from '@momonga/tools';
import { TOOL_MARKER_SWEEP_MS } from '../../src/process/constants.ts';
import { START_MS, createRun, createSession, fenceFor, makeRuntimeFixture, onCleanup, signalNever, writeUserSettings } from './helpers.ts';
import type { TempHome } from './helpers.ts';
import { launchRuntime, modelSettings } from './run-helpers.ts';
import type { RunHome } from './run-helpers.ts';

const PROCESS_TIMEOUT = { timeout: 60_000 };
const NON_SWEEP_LEASE_MS = 7000;

const trackedTempHome = async (context: CleanupContext): Promise<TempHome> => {
  const home = withTempDir(context, { asHome: true });
  const root = withTempDir(context);
  const paths = momongaPaths(home, process.platform, {});
  await ensureMomongaDirs(paths);
  const project = path.join(root, 'p');
  fs.mkdirSync(project);
  return { root, home, paths, project, dbPath: path.join(root, 's.db') };
};

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

  it('timers teardown: the sweep timer is armed while running and no sweep timer is pending after close (fake timers)', PROCESS_TIMEOUT, async (context) => {
    const temp = trackedRunHome(context);
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const launched = await launchRuntime(temp, { clock, fakeTimers: timers, leaseMs: NON_SWEEP_LEASE_MS });

    expect(timers.pending().filter((timer) => timer.delayMs === TOOL_MARKER_SWEEP_MS)).toHaveLength(1);
    expect(await launched.handle.close()).toEqual({ clean: true, abandoned: [], stragglers: [] });
    expect(timers.pending()).toEqual([]);
  });

  it('tool runtime exposes inFlightKeys: the key is present while a fake tool runs through port.executor.runBatch', PROCESS_TIMEOUT, async (context) => {
    const f = await makeRuntimeFixture({ temp: await trackedTempHome(context) });
    const session = createSession(f.store, f.temp.project);
    const runId = createRun(f.store, session.id);
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = createToolRegistry();
    registry.register(
      defineTool<Record<string, unknown>>({
        name: 'Hold',
        description: 'holds until released',
        kind: 'read',
        sideEffect: 'read_only',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        title: () => 'hold',
        timeoutMs: 60_000,
        subject: () => ({ kind: 'none', tool: 'Hold' }),
        execute: async () => {
          started();
          await released;
          return { status: 'completed', output: 'released' };
        },
      }),
    );
    const toolSet = await registry.snapshot();
    const port = f.toolRuntime.port;
    const env = port.envFor(session);
    const policy = await port.policyFor(session, { env, rules: [] });
    const callId = 'call-hold';
    const key = sha256Hex(canonicalJson([runId, 1, callId]));

    const batch = port.executor.runBatch({
      calls: [{ callId, name: 'Hold', arguments: '{}' }],
      toolSet,
      fence: fenceFor(f.store, runId),
      runId,
      step: 1,
      mode: 'bypassPermissions',
      rules: [],
      home: f.temp.home,
      roots: policy.roots,
      tmpDir: policy.tmpDir,
      env: policy.env,
      session: port.sessionState(session),
      sandbox: port.sandbox,
      sandboxPolicy: policy.sandboxPolicy,
      deadlineAt: f.clock.now() + 120_000,
      signal: signalNever(),
    });
    const settled = batch.then(
      () => undefined,
      () => undefined,
    );
    onCleanup(async () => {
      release();
      await settled;
    });
    await running;

    expect([...f.toolRuntime.inFlightKeys()]).toEqual([key]);
    release();
    await batch;
    expect(f.toolRuntime.inFlightKeys().size).toBe(0);
  });
});
