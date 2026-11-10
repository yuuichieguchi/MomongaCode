import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import * as foundation from '@momonga/foundation';
import type { MarkerState, ProcessGroupPort, ProcessInspector } from '@momonga/foundation';
import type { HookExecution, HooksSettings } from '@momonga/protocol';
import type { Sandbox } from '@momonga/sandbox';
import { createToolHooks, nodeShellHost } from '@momonga/tools';
import type { HookRunContext } from '@momonga/tools';
import { launch } from '../../sandbox/src/process.ts';
import type { LaunchOptions } from '../../sandbox/src/process.ts';
import { virtualTiming } from '../../foundation/test/support/probe-fakes.ts';

type MarkerGroupApi = { readMarkerGroup(marker: string): Promise<number | undefined> };

const markerGroups = foundation as unknown as MarkerGroupApi;

const KILL_GRACE_MS = 300;
const GROUP = 999_997;

let dir = '';

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-hook-survivor-')));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const contextFor = (survives: boolean) => {
  const timing = virtualTiming();
  let alive = true;
  const groupPort: ProcessGroupPort = {
    signal: async () => {
      if (!survives) alive = false;
    },
    alive: async () => alive,
  };
  const markerState: MarkerState = survives ? 'held' : 'free';
  const inspector = {
    capability: { of: async () => 'unenforced' as const, contradicted: () => undefined },
    startTimeOf: async () => ({ kind: 'gone' }),
    holdersOf: async () => ({ kind: 'value', value: [] }),
    groupsOf: async () => ({ kind: 'value', value: new Map() }),
    markerState: async () => markerState,
  } as unknown as ProcessInspector;
  const sandbox: Sandbox = {
    kind: 'none',
    spawn: (_command, _policy, signal) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), { pid: GROUP, stdout, stderr, stdin: null });
      const launched = launch({
        file: '/bin/bash',
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
        child.emit('exit', 0, null);
      });
      return launched;
    },
  };
  const markerDir = path.join(dir, 'markers');
  fs.mkdirSync(markerDir, { recursive: true });
  const executions: HookExecution[] = [];
  const hooks: HooksSettings = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'exit 0' }] }] };
  const context = {
    hooks,
    sandbox,
    sandboxPolicy: { writableRoots: [dir], writeDenied: [], writeDeniedLiterals: [], readDenied: [], network: 'deny', fileRules: EMPTY_FILE_RULES, protectedSet: EMPTY_PROTECTED_SET },
    env: { PATH: '/usr/bin:/bin' },
    shellHost: nodeShellHost(),
    cwd: dir,
    projectDir: dir,
    markerDir,
    runId: 'run-1',
    session: { id: 's1', permissionMode: 'manual' },
    clock: { now: () => 0 },
    signal: new AbortController().signal,
    deadlineAt: 60_000,
    started: () => undefined,
    report: (execution: HookExecution) => void executions.push(execution),
    inspector,
    groupPort,
  } as unknown as HookRunContext;
  return { context, executions, markerDir, timing };
};

const runHook = async (survives: boolean) => {
  const { context, executions, markerDir, timing } = contextFor(survives);
  const pending = Promise.resolve(createToolHooks(context).preToolUse({ callId: 'c1', toolName: 'Bash', input: { command: 'ls' } }));
  let done = false;
  void pending.then(
    () => (done = true),
    () => (done = true),
  );
  for (let step = 1; !done && step <= 1000; step += 1) await timing.advanceTo(step * KILL_GRACE_MS);
  let failure: unknown;
  try {
    await pending;
  } catch (error) {
    failure = error;
  }
  return { failure, executions, markerDir, markers: fs.readdirSync(markerDir).filter((name) => name.startsWith('hook-')) };
};

describe('a hook whose process group keeps a member that survives the stop', () => {
  it('reports the hook result, not an error, and keeps the hook marker for the four occasions', async () => {
    const { failure, executions, markers } = await runHook(true);
    expect(failure).toBeUndefined();
    expect(executions.map((execution) => execution.outcome)).toEqual(['success']);
    expect(markers).toHaveLength(1);
  });

  it('reports the hook result and leaves no marker when the members stop', async () => {
    const { failure, executions, markers } = await runHook(false);
    expect(failure).toBeUndefined();
    expect(executions.map((execution) => execution.outcome)).toEqual(['success']);
    expect(markers).toEqual([]);
  });

  it('writes the spawn group into its hook marker file', async () => {
    const { markerDir, markers } = await runHook(true);
    expect(markers).toHaveLength(1);
    expect(await markerGroups.readMarkerGroup(path.join(markerDir, markers[0] ?? ''))).toBe(GROUP);
  });
});
