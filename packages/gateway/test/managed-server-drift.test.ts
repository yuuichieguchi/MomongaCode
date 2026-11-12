import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { cfgNames } from '../../../test/formal/cfg-names.ts';
import { FakeChild, SERVER_KINDS, createManagedServer, createManualTimers, makeShortDir } from './managed/managed-support.ts';
import type { ExecPort, ManagedServerHandle } from './managed/managed-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const specDir = path.resolve(import.meta.dirname, '..', '..', '..', 'specs', 'tla');
const holding = cfgNames(specDir, 'ManagedServer');

const READY_MS = 400;
const kind = SERVER_KINDS[0] as (typeof SERVER_KINDS)[number];

const dirs: string[] = [];
const children: FakeChild[] = [];
const servers: ManagedServerHandle[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const child of children.splice(0)) await child.crash(0, null);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const serverWith = (exec: ExecPort): { server: ManagedServerHandle; spawned: FakeChild[]; execCalls: () => number } => {
  const dir = makeShortDir(dirs);
  const socket = path.join(dir, `${kind.target}.sock`);
  const spawned: FakeChild[] = [];
  let calls = 0;
  const server = createManagedServer({
    description: kind.description(),
    target: kind.target,
    binary: '/opt/managed/bin/server',
    socketPath: socket,
    lockPath: path.join(dir, `${kind.target}.lock`),
    readyTimeoutMs: READY_MS,
    exec: (file, args, options) => {
      calls += 1;
      return exec(file, args, options);
    },
    spawn: () => {
      const child = new FakeChild(socket, kind.readyPath, {});
      spawned.push(child);
      children.push(child);
      return child;
    },
    timers: createManualTimers().timers,
    readStopGraceMs: () => 30,
    onWarning: () => undefined,
  });
  servers.push(server);
  return { server, spawned, execCalls: () => calls };
};

const asking = (): AbortSignal => new AbortController().signal;

const verdictRuns = (length: number): Array<Array<'refuse' | 'meet'>> => {
  let runs: Array<Array<'refuse' | 'meet'>> = [[]];
  for (let index = 0; index < length; index += 1) runs = runs.flatMap((run) => [[...run, 'refuse' as const], [...run, 'meet' as const]]);
  return runs;
};

describe('the managed server does what specs/tla/ManagedServer.tla states, on the cases of the model', () => {
  it('the holding configuration checks the invariants these cases run: OneLiveChild, OneFlight, NoCachedRefusal', () => {
    expect(holding.invariants).toEqual(expect.arrayContaining(['OneLiveChild', 'OneFlight', 'NoCachedRefusal']));
  });

  it('NoCachedRefusal: on every sequence of refused and met preconditions, a start after a refusal asks the preconditions again and starts as soon as they are met (each start after the stop of the last one)', async () => {
    const failures: string[] = [];
    for (const run of verdictRuns(3)) {
      let current: 'refuse' | 'meet' = 'refuse';
      const { server, spawned, execCalls } = serverWith((file, args, options) => (current === 'refuse' ? kind.refusingExec(file, args, options) : kind.metExec(file, args, options)));
      let refusedBefore = false;
      for (const verdict of run) {
        current = verdict;
        const before = execCalls();
        const outcome = await server.start(asking()).then(
          () => 'started',
          (error: unknown) => (error instanceof Error ? error.name : String(error)),
        );
        if (refusedBefore && execCalls() === before) failures.push(`${run.join(' ')}: a start after a refusal reused the refusal`);
        if (verdict === 'meet' && outcome !== 'started') failures.push(`${run.join(' ')}: met preconditions answered ${outcome}`);
        if (verdict === 'refuse' && spawned.length === 0 && outcome !== 'PreconditionFailedError') failures.push(`${run.join(' ')}: refused preconditions answered ${outcome}`);
        refusedBefore = outcome === 'PreconditionFailedError';
        if (outcome === 'started') await server.stop();
      }
      await server.stop();
    }
    expect(failures).toEqual([]);
  });

  it('OneLiveChild: concurrent starts and ensures of one server leave one live child', async () => {
    const { server, spawned } = serverWith(kind.metExec);
    await Promise.all([server.start(asking()), server.ensureRunning(asking()), server.start(asking()), server.ensureRunning(asking())]);
    expect(spawned.filter((child) => child.alive)).toHaveLength(1);
  });
});
