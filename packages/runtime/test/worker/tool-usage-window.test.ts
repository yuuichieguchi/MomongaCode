import { describe, expect, it } from 'vitest';
import { TOOL_USAGE_WINDOW_RUNS, deferredSetOf } from '@momonga/memory';
import type { RunEventPayload } from '@momonga/protocol';
import { toolUsageWindowOf } from '../../src/worker/tool-usage-window.ts';
import { makeEnv } from './harness.ts';

type Env = Awaited<ReturnType<typeof makeEnv>>;

const offered = (names: readonly string[]): RunEventPayload => ({ type: 'tool.offered', names: [...names] });

const called = (callId: string, name: string): RunEventPayload => ({
  type: 'tool.call',
  callId,
  providerCallId: callId,
  name,
  kind: 'read',
  title: `${name} ${callId}`,
  rawInput: {},
});

const pastRun = async (env: Env, payloads: readonly RunEventPayload[], status: 'COMPLETED' | 'FAILED' | 'hold' = 'COMPLETED'): Promise<string> => {
  env.clock.advance(1);
  const run = env.enqueue('Past work', { history: 'fresh' });
  const claim = env.seed(run.id, [{ type: 'run.started', attempt: 1, now: env.clock.now(), pins: {}, mode: 'default' }, ...payloads], 'hold');
  if (status !== 'hold') expect((await env.store.transition(claim, ['RUNNING'], status)).kind).toBe('ok');
  return run.id;
};

const usual = (index: number): RunEventPayload[] => [offered(['Glob', 'Grep', 'Read']), called(`call_${index}`, 'Read')];

describe('toolUsageWindowOf', () => {
  it('lists the offered and called tool names of the newest terminal root runs of the project, newest first', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    await pastRun(env, [offered(['Read', 'Bash'])]);
    const middle = await pastRun(env, [offered(['Read']), called('call_a', 'Read'), offered(['Glob', 'Read']), called('call_b', 'Glob')], 'FAILED');
    const newest = await pastRun(env, [offered(['Grep', 'Read'])]);

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
    for (let index = 0; index < TOOL_USAGE_WINDOW_RUNS + 2; index += 1) await pastRun(env, usual(index));

    expect(toolUsageWindowOf(env.store, env.session.cwd)).toHaveLength(TOOL_USAGE_WINDOW_RUNS);
  });

  it('leaves out a run that has not ended', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    await pastRun(env, [offered(['Read'])]);
    await pastRun(env, [offered(['Bash'])], 'hold');

    expect(toolUsageWindowOf(env.store, env.session.cwd)).toEqual([{ offered: ['Read'], called: [] }]);
  });

  it('is empty for a project with no runs', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    await pastRun(env, [offered(['Read'])]);

    expect(toolUsageWindowOf(env.store, '/some/other/project')).toEqual([]);
  });

  it('feeds deferredSetOf: twenty runs that offered Glob and Grep and called only Read defer Glob and Grep', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    for (let index = 0; index < TOOL_USAGE_WINDOW_RUNS; index += 1) await pastRun(env, usual(index));

    expect(deferredSetOf({ runs: toolUsageWindowOf(env.store, env.session.cwd) })).toEqual(['Glob', 'Grep']);
  });

  it('counts a tool called only by a child or grandchild run as called by its root run (open item 8)', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    for (let index = 0; index < TOOL_USAGE_WINDOW_RUNS - 1; index += 1) await pastRun(env, usual(index));
    env.clock.advance(1);
    const root = env.enqueue('Delegate', { history: 'fresh' });
    const rootClaim = env.seed(root.id, [{ type: 'run.started', attempt: 1, now: env.clock.now(), pins: {}, mode: 'default' }, offered(['Read', 'Glob', 'Grep'])], 'hold');
    const child = env.store.createChildRun({ parentRunId: root.id, parentCallId: 'call_child', input: 'Search', pins: {}, modelAlias: 'fm' });
    if (child.kind !== 'created') throw new Error(`child run was not created: ${child.kind}`);
    const childClaim = env.seed(child.run.id, [{ type: 'run.started', attempt: 1, now: env.clock.now(), pins: {}, mode: 'default' }, offered(['Grep']), called('call_child_grep', 'Grep')], 'hold');
    const grandchild = env.store.createChildRun({ parentRunId: child.run.id, parentCallId: 'call_grandchild', input: 'List', pins: {}, modelAlias: 'fm' });
    if (grandchild.kind !== 'created') throw new Error(`grandchild run was not created: ${grandchild.kind}`);
    const grandchildClaim = env.seed(grandchild.run.id, [{ type: 'run.started', attempt: 1, now: env.clock.now(), pins: {}, mode: 'default' }, offered(['Glob']), called('call_grandchild_glob', 'Glob')], 'hold');
    expect((await env.store.transition(grandchildClaim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
    expect((await env.store.transition(childClaim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
    expect((await env.store.transition(rootClaim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');

    const window = toolUsageWindowOf(env.store, env.session.cwd);

    expect(window).toHaveLength(TOOL_USAGE_WINDOW_RUNS);
    expect(window[0]).toEqual({ offered: ['Glob', 'Grep', 'Read'], called: ['Glob', 'Grep'] });
    expect(deferredSetOf({ runs: window })).toEqual([]);
  });

  it('feeds deferredSetOf: nineteen such runs defer nothing', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    for (let index = 0; index < TOOL_USAGE_WINDOW_RUNS - 1; index += 1) await pastRun(env, usual(index));

    expect(deferredSetOf({ runs: toolUsageWindowOf(env.store, env.session.cwd) })).toEqual([]);
  });
});
