import { describe, expect, it } from 'vitest';
import { TOOL_USAGE_WINDOW_RUNS, deferredSetOf } from '@momonga/memory';
import type { RunEventPayload } from '@momonga/protocol';
import { toolUsageWindowOf } from '../../src/worker/tool-usage-window.ts';
import { makeEnv } from './harness.ts';

type Env = Awaited<ReturnType<typeof makeEnv>>;

const requested = (step: number, names: readonly string[]): RunEventPayload => ({
  type: 'model.requested',
  step,
  attempt: 1,
  digest: `d${step}`,
  body: { model: 'fm', input: 'seed', tools: names.map((name) => ({ type: 'function', name })) },
});

const called = (callId: string, name: string): RunEventPayload => ({
  type: 'tool.call',
  callId,
  providerCallId: callId,
  name,
  kind: 'read',
  title: `${name} ${callId}`,
  rawInput: {},
});

const pastRun = (env: Env, payloads: readonly RunEventPayload[], status: 'COMPLETED' | 'FAILED' | 'hold' = 'COMPLETED'): string => {
  env.clock.advance(1);
  const run = env.enqueue('Past work', { history: 'fresh' });
  const claim = env.seed(run.id, [{ type: 'run.started', attempt: 1, now: env.clock.now(), pins: {}, mode: 'default' }, ...payloads], 'hold');
  if (status !== 'hold') expect(env.store.transition(claim, ['RUNNING'], status).kind).toBe('ok');
  return run.id;
};

const usual = (index: number): RunEventPayload[] => [requested(1, ['Read', 'Glob', 'Grep']), called(`call_${index}`, 'Read'), requested(2, ['Read', 'Glob', 'Grep'])];

describe('toolUsageWindowOf', () => {
  it('lists the offered and called tool names of the newest terminal root runs of the project, newest first', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    pastRun(env, [requested(1, ['Read', 'Bash'])]);
    const middle = pastRun(env, [requested(1, ['Read']), called('call_a', 'Read'), requested(2, ['Read', 'Glob']), called('call_b', 'Glob')], 'FAILED');
    const newest = pastRun(env, [requested(1, ['Grep', 'Read'])]);

    const window = toolUsageWindowOf(env.store, env.session.cwd);

    expect(window).toEqual([
      { offered: ['Grep', 'Read'], called: [] },
      { offered: ['Glob', 'Read'], called: ['Glob', 'Read'] },
      { offered: ['Bash', 'Read'], called: [] },
    ]);
    expect(env.store.lastTerminalRootRuns(env.session.cwd, 2).map((run) => run.id)).toEqual([newest, middle]);
  });

  it('holds at most the window size of runs', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    for (let index = 0; index < TOOL_USAGE_WINDOW_RUNS + 2; index += 1) pastRun(env, usual(index));

    expect(toolUsageWindowOf(env.store, env.session.cwd)).toHaveLength(TOOL_USAGE_WINDOW_RUNS);
  });

  it('leaves out a run that has not ended', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    pastRun(env, [requested(1, ['Read'])]);
    pastRun(env, [requested(1, ['Bash'])], 'hold');

    expect(toolUsageWindowOf(env.store, env.session.cwd)).toEqual([{ offered: ['Read'], called: [] }]);
  });

  it('is empty for a project with no runs', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    pastRun(env, [requested(1, ['Read'])]);

    expect(toolUsageWindowOf(env.store, '/some/other/project')).toEqual([]);
  });

  it('feeds deferredSetOf: twenty runs that offered Glob and Grep and called only Read defer Glob and Grep', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    for (let index = 0; index < TOOL_USAGE_WINDOW_RUNS; index += 1) pastRun(env, usual(index));

    expect(deferredSetOf({ runs: toolUsageWindowOf(env.store, env.session.cwd) })).toEqual(['Glob', 'Grep']);
  });

  it('feeds deferredSetOf: nineteen such runs defer nothing', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    for (let index = 0; index < TOOL_USAGE_WINDOW_RUNS - 1; index += 1) pastRun(env, usual(index));

    expect(deferredSetOf({ runs: toolUsageWindowOf(env.store, env.session.cwd) })).toEqual([]);
  });
});
