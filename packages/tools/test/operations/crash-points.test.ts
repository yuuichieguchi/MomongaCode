import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { createOperationTools, hostGitReader } from '@momonga/tools';
import type { ArgvRunner, CallOutcome, ResultOutcome } from '@momonga/tools';
import { call, makeHarness, toolSetOf } from '../harness.ts';
import { keyFor, makeLayout, ruleFor } from '../helpers.ts';
import type { Layout } from '../helpers.ts';
import { NO_FORGE, countingRunner, makeGitWorld } from './support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

type Injection = (argv: readonly string[], run: () => ReturnType<ArgvRunner>) => ReturnType<ArgvRunner>;

const setup = async () => {
  const world = makeGitWorld();
  world.write('a.txt', 'one\n');
  const base = world.commitAll('base');
  world.write('a.txt', 'two\n');
  world.git(world.work, 'add', 'a.txt');
  const harness = makeHarness();
  const counting = countingRunner();
  const injection: { current: Injection | undefined } = { current: undefined };
  const runArgv: ArgvRunner = (argv, options) => {
    const run = (): ReturnType<ArgvRunner> => counting.run(argv, options);
    return injection.current === undefined ? run() : injection.current(argv, run);
  };
  const toolSet = await toolSetOf(...createOperationTools({ runArgv, readGit: hostGitReader, forge: NO_FORGE, settings: {} }));
  const layout: Layout = { ...makeLayout(), root: world.base, home: world.home, project: world.work, outside: path.join(world.base, 'outside') };
  const rules = [ruleFor(layout)('allow', 'GitCommit')];
  const reconciled: Array<ResultOutcome['reconciled']> = [];
  const attempt = async (): Promise<CallOutcome | undefined> => {
    const [outcome] = await harness.executor.runBatch(
      harness.input(toolSet, [call('c1', 'GitCommit', { message: 'Add two' })], {
        env: world.env,
        roots: [world.work],
        home: world.home,
        session: { cwd: world.work, workingDirectory: world.work, readLedger: new Map() },
        rules,
      }),
    );
    if (outcome?.kind === 'result') reconciled.push(outcome.reconciled);
    return outcome;
  };
  const key = keyFor('run-1', 1, 'c1');
  const commits = (): number => Number(world.git(world.work, 'rev-list', '--count', 'HEAD'));
  const stop = (): void => {
    harness.idempotency.lease.held = false;
  };
  const takeOver = (): void => {
    harness.idempotency.lease.held = true;
    injection.current = undefined;
    counting.calls.length = 0;
  };
  const commitsRun = (): number => counting.calls.filter((argv) => argv.includes('commit')).length;
  return { world, base, harness, counting, injection, attempt, key, commits, stop, takeOver, commitsRun, reconciled };
};

const expectOneCommit = (context: Awaited<ReturnType<typeof setup>>): void => {
  expect(context.commits()).toBe(2);
  expect(context.world.git(context.world.work, 'rev-parse', 'HEAD^')).toBe(context.base);
  expect(context.world.git(context.world.work, 'log', '-1', '--format=%s')).toBe('Add two');
  expect(context.harness.idempotency.stateOf(context.key)).toBe('COMPLETED');
};

describe('a worker that stops at each step of GitCommit, and the worker that takes the call over (design 2.3)', () => {
  it('c0, before the ledger record exists: nothing is durable, the call runs from its start and commits once', async () => {
    const context = await setup();
    context.injection.current = (argv, run) => {
      if (argv.includes('write-tree')) context.stop();
      return run();
    };
    expect((await context.attempt())?.kind).toBe('deferred');
    expect(context.harness.idempotency.stateOf(context.key)).toBeUndefined();
    expect(context.commits()).toBe(1);

    context.takeOver();
    expect(await context.attempt()).toMatchObject({ kind: 'result', result: { status: 'completed', effect: { operation: 'GitCommit', outcome: 'applied' } } });
    expect(context.commitsRun()).toBe(1);
    expectOneCommit(context);
  });

  it('c1, after begin and before authorise: the record holds the observation and no authorisation, reconcile answers not applied without a probe, and the commit runs once', async () => {
    const context = await setup();
    const { port } = context.harness.idempotency;
    const begin = port.begin.bind(port);
    port.begin = (key, options) => {
      const begun = begin(key, options);
      context.stop();
      return begun;
    };
    expect((await context.attempt())?.kind).toBe('deferred');
    const record = context.harness.idempotency.records.get(context.key);
    expect(record).toMatchObject({ kind: 'open', rec: { state: 'PENDING', meta: { tool: 'GitCommit', prepared: { before: { head: context.base } } } } });
    expect(record?.kind === 'open' ? record.rec.authorisedAt : 0).toBeUndefined();
    expect(context.commits()).toBe(1);

    port.begin = begin;
    context.takeOver();
    let probesBeforeCommit = 0;
    context.injection.current = (argv, run) => {
      if (argv.includes('commit')) probesBeforeCommit = context.counting.calls.length;
      return run();
    };
    expect(await context.attempt()).toMatchObject({ kind: 'result', result: { status: 'completed' } });
    expect(probesBeforeCommit).toBe(0);
    expect(context.commitsRun()).toBe(1);
    expectOneCommit(context);
  });

  it('c2, inside the effect, the commit did not land: the state is unchanged, so the guarded commit is done again, once', async () => {
    const context = await setup();
    context.injection.current = async (argv, run) => {
      if (!argv.includes('commit')) return run();
      context.stop();
      return { exitCode: 1, stdout: '', stderr: 'killed' };
    };
    expect((await context.attempt())?.kind).toBe('deferred');
    const record = context.harness.idempotency.records.get(context.key);
    expect(record?.kind === 'open' ? typeof record.rec.authorisedAt : 'none').toBe('number');
    expect(context.commits()).toBe(1);

    context.takeOver();
    expect(await context.attempt()).toMatchObject({ kind: 'result', result: { status: 'completed', effect: { outcome: 'applied' } }, reconciled: 'not_applied' });
    expect(context.commitsRun()).toBe(1);
    expectOneCommit(context);
  });

  it('c3, the commit landed and its result was lost: the probes find it applied, the result is rebuilt from the repository, and no second commit runs', async () => {
    const context = await setup();
    context.injection.current = async (argv, run) => {
      const result = await run();
      if (argv.includes('commit')) context.stop();
      return result;
    };
    expect((await context.attempt())?.kind).toBe('deferred');
    expect(context.commits()).toBe(2);
    const head = context.world.git(context.world.work, 'rev-parse', 'HEAD');

    context.takeOver();
    const outcome = await context.attempt();
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed', effect: { operation: 'GitCommit', outcome: 'already_applied' } }, reconciled: 'already_applied' });
    expect((outcome as ResultOutcome).result.output).toContain(head);
    expect(context.commitsRun()).toBe(0);
    expectOneCommit(context);
  });

  it('c4, after the ledger completed and before the result was journaled: the stored result is returned and git is not run at all', async () => {
    const context = await setup();
    const first = await context.attempt();
    expect(first).toMatchObject({ kind: 'result', result: { status: 'completed' } });

    context.takeOver();
    const again = await context.attempt();
    expect(again).toEqual(first);
    expect(context.counting.calls).toEqual([]);
    expectOneCommit(context);
  });
});
