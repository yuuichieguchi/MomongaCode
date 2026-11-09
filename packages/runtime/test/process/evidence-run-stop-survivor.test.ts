import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ensureMomongaDirs, momongaPaths, ruleEnforcementOf } from '@momonga/foundation';
import type { MarkerState, ProcessGroupPort, ProcessInspector } from '@momonga/foundation';
import type { Sandbox } from '@momonga/sandbox';
import { fakePolicyFilesystem, withTempDir } from '@momonga/testkit';
import { launch } from '../../../sandbox/src/process.ts';
import type { LaunchOptions } from '../../../sandbox/src/process.ts';
import { virtualTiming } from '../../../foundation/test/support/probe-fakes.ts';
import { createEvidenceRunner } from '../../src/process/evidence-run.ts';
import type { EvidenceRunnerOptions } from '../../src/process/evidence-run.ts';

const KILL_GRACE_MS = 300;
const GROUP = 999_998;
const STILL_RUNNING = 'At least one process started by it is still running';
const FOUR_OCCASIONS = 'at most once at each of: before the next command that runs a process or changes files, the periodic check, start-up and shutdown';

const scene = (survives: boolean) => {
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
        file: 'git',
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
        stdout.end('abc\n');
        stderr.end();
        child.emit('exit', 0, null);
      });
      return launched;
    },
  };
  return { timing, groupPort, inspector, sandbox };
};

const runEvidence = async (context: Parameters<typeof withTempDir>[0], survives: boolean) => {
  const home = withTempDir(context, { asHome: true });
  const paths = momongaPaths(home);
  await ensureMomongaDirs(paths);
  const project = fs.realpathSync(withTempDir(context));
  const { timing, groupPort, inspector, sandbox } = scene(survives);
  const options = {
    paths,
    home,
    fs: fakePolicyFilesystem(),
    enforcement: ruleEnforcementOf('none'),
    sandbox,
    env: { PATH: '/usr/bin' },
    reap: { inspector, groupPort, timing, killGraceMs: KILL_GRACE_MS },
  } as EvidenceRunnerOptions;
  const pending = Promise.resolve(createEvidenceRunner(options)(project)({ argv: ['git', 'rev-parse', 'HEAD'], cwd: project, env: {}, network: 'deny' }, new AbortController().signal));
  let done = false;
  void pending.then(
    () => (done = true),
    () => (done = true),
  );
  for (let step = 1; !done && step <= 1000; step += 1) await timing.advanceTo(step * KILL_GRACE_MS);
  const result = await pending;
  return { result, markers: fs.readdirSync(paths.markers.tools) };
};

describe('the evidence run spawns under the same marker as every other spawn, so decision 12 reaches a group member that survives the stop', () => {
  it('returns the exit code and output with the still-running note and keeps a marker for the four occasions', async (context) => {
    const { result, markers } = await runEvidence(context, true);
    expect(result).toMatchObject({ exitCode: 0, stdout: 'abc\n' });
    const notes = (result as { notes?: string[] }).notes ?? [];
    expect(notes.join(' ')).toContain(STILL_RUNNING);
    expect(notes.join(' ')).toContain(FOUR_OCCASIONS);
    expect(markers).toHaveLength(1);
  });

  it('returns the exit code and output with no note and leaves no marker when the members stop', async (context) => {
    const { result, markers } = await runEvidence(context, false);
    expect(result).toEqual({ exitCode: 0, stdout: 'abc\n' });
    expect(markers).toEqual([]);
  });
});
