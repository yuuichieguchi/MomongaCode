import { sleepDrivenTiming, TEST_CHILD_UNPROTECTED } from '@momonga/testkit';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import * as foundation from '@momonga/foundation';
import type { MarkerState, ProcessGroupPort, ProcessInspector } from '@momonga/foundation';
import type { Sandbox } from '@momonga/sandbox';
import { launch } from '../../sandbox/src/process.ts';
import type { LaunchOptions } from '../../sandbox/src/process.ts';
import { virtualTiming, driveUntil } from '../../foundation/test/support/probe-fakes.ts';
import { grepTool } from '../src/builtins/grep.ts';
import type { RipgrepLocator } from '../src/ripgrep-locator.ts';
import { call, makeHarness, toolSetOf } from './harness.ts';
import type { HarnessOptions } from './harness.ts';
import { resultOf } from './guard-world.ts';

type MarkerGroupApi = { readMarkerGroup(marker: string): Promise<number | undefined> };

const markerGroups = foundation as unknown as MarkerGroupApi;

type Survivor = 'version' | 'search' | 'none';

const KILL_GRACE_MS = 300;
const VERSION_GROUP = 999_995;
const SEARCH_GROUP = 999_994;
const STILL_RUNNING = 'At least one process started by it is still running';
const FOUR_OCCASIONS = 'at most once at each of: before the next command that runs a process or changes files, the periodic check, start-up and shutdown';

const versionlessRipgrep = (): RipgrepLocator => ({ locate: async () => ({ ok: true, path: '/fake/rg', source: 'path', release: async () => undefined }) });

const scene = (survivor: Survivor) => {
  const groupOf = (kind: Survivor): number => (kind === 'version' ? VERSION_GROUP : SEARCH_GROUP);
  const timing = virtualTiming();
  const runnable = new Set([VERSION_GROUP, SEARCH_GROUP]);
  const groupPort: ProcessGroupPort = {
    signal: async (pgid) => {
      if (survivor === 'none' || pgid !== groupOf(survivor)) runnable.delete(pgid);
    },
    alive: async (pgid) => runnable.has(pgid),
  };
  const markers: Array<{ kind: 'version' | 'search'; marker: string | undefined }> = [];
  const survivorMarker = (): string | undefined => markers.find((entry) => entry.kind === survivor)?.marker;
  const inspector = {
    capability: { of: async () => 'unenforced' as const, contradicted: () => undefined },
    startTimeOf: async () => ({ kind: 'gone' }),
    holdersOf: async () => ({ kind: 'value', value: [] }),
    groupsOf: async () => ({ kind: 'value', value: new Map() }),
    markerState: async (marker: string): Promise<MarkerState> => (survivor !== 'none' && marker === survivorMarker() ? 'held' : 'free'),
  } as unknown as ProcessInspector;
  const sandbox: Sandbox = {
    kind: 'none',
    spawn: (command, _policy, signal) => {
      const version = command.argv[1] === '--version';
      markers.push({ kind: version ? 'version' : 'search', marker: command.markerFile });
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), { pid: version ? VERSION_GROUP : SEARCH_GROUP, stdout, stderr, stdin: null });
      const launched = launch({ protection: TEST_CHILD_UNPROTECTED,
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
        stdout.end(version ? 'ripgrep 15.2.0\n' : '');
        stderr.end();
        child.emit('exit', version ? 0 : 1, null);
      });
      return launched;
    },
  };
  return { timing, groupPort, inspector, sandbox, markers };
};

const runGrep = async (survivor: Survivor) => {
  const { timing, groupPort, inspector, sandbox, markers } = scene(survivor);
  let now = 0;
  const harness = makeHarness({ executor: { reap: { inspector, groupPort, timing: sleepDrivenTiming({ now: () => now, sleep: async (ms: number) => void (now += ms) }), killGraceMs: 100 } } } as HarnessOptions);
  const batch = harness.executor.runBatch(await harness.input(await toolSetOf(grepTool), [call('search', 'Grep', { pattern: 'needle' }, 'allow_once')], { sandbox, ripgrep: versionlessRipgrep() }));
  let done = false;
  void batch.finally(() => {
    done = true;
  });
  await driveUntil(timing, () => done, 1000 * KILL_GRACE_MS, 'the stop to end');
  const [outcome] = await batch;
  return { result: resultOf(outcome), markers, left: fs.readdirSync(harness.markerDir) };
};

describe("Grep's ripgrep --version spawn takes its own marker, so decision 12 reaches a member of that group that survives the stop", () => {
  it('reports the survivor of the version spawn with the still-running note and keeps that spawn marker', async () => {
    const { result, markers, left } = await runGrep('version');
    const version = markers.find((entry) => entry.kind === 'version')?.marker;
    const search = markers.find((entry) => entry.kind === 'search')?.marker;
    expect(version).toBeDefined();
    expect(search).toBeDefined();
    expect(version).not.toBe(search);
    expect(result.status).toBe('completed');
    expect(result.output).toContain('No matches found');
    expect(result.output).toContain(STILL_RUNNING);
    expect(result.output).toContain(FOUR_OCCASIONS);
    expect(left).toEqual([path.basename(version ?? '')]);
  });

  it('leaves no marker and no note when the members of both spawns stop', async () => {
    const { result, markers, left } = await runGrep('none');
    expect(markers.map((entry) => entry.marker === undefined)).toEqual([false, false]);
    expect(result).toMatchObject({ status: 'completed', output: 'No matches found' });
    expect(left).toEqual([]);
  });

  it('writes each spawn group into that spawn marker file: the call marker for the first spawn, the <key>-1 marker for the second', async () => {
    const versionRun = await runGrep('version');
    const version = versionRun.markers.find((entry) => entry.kind === 'version')?.marker ?? '';
    expect(await markerGroups.readMarkerGroup(version)).toBe(VERSION_GROUP);
    const searchRun = await runGrep('search');
    const search = searchRun.markers.find((entry) => entry.kind === 'search')?.marker ?? '';
    expect(path.basename(search)).toMatch(/^[0-9a-f]{64}-1$/);
    expect(searchRun.left).toEqual([path.basename(search)]);
    expect(await markerGroups.readMarkerGroup(search)).toBe(SEARCH_GROUP);
  });
});
