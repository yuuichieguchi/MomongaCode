import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { DEADLINE_MS, capabilitiesFor, createdRun, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { assistantMessage, textStep } from './scripts.ts';

const USAGE = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };
const WINDOW = 40_000;
const HANDLE = 'f'.repeat(64);

const responded = (step: number, output: unknown[]): RunEventPayload => ({ type: 'model.responded', step, attempt: 1, response: { status: 'completed', output, usage: USAGE } });

const readCall = (output: string): RunEventPayload[] => [
  responded(1, [{ type: 'function_call', id: 'fc_c1', call_id: 'c1', name: 'Read', arguments: '{"file_path":"/proj/big.txt"}' }]),
  { type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Read', kind: 'other', title: 'Read', rawInput: { file_path: '/proj/big.txt' } },
  { type: 'tool.completed', callId: 'c1', status: 'completed', output, handle: HANDLE },
];

const oneReadThenQuestion: RunEventPayload[] = [
  ...readCall('r'.repeat(12_000)),
  responded(2, [assistantMessage('m2', 'short')]),
  { type: 'user.message', text: 'question two' },
  responded(3, [assistantMessage('m3', `answer two ${'y'.repeat(6_000)}`)]),
  { type: 'user.message', text: 'question three' },
  responded(4, [assistantMessage('m4', `answer three ${'z'.repeat(6_000)}`)]),
  { type: 'user.message', text: 'question four' },
];

const fourTurns = (chars: number): RunEventPayload[] => [
  ...readCall('r'.repeat(chars)),
  responded(2, [assistantMessage('m2', `long ${'x'.repeat(chars)}`)]),
  { type: 'user.message', text: 'question two' },
  responded(3, [assistantMessage('m3', `answer two ${'y'.repeat(chars)}`)]),
  { type: 'user.message', text: 'question three' },
  responded(4, [assistantMessage('m4', `answer three ${'z'.repeat(chars)}`)]),
  { type: 'user.message', text: 'question four' },
];

const envWith = async (compactAt: number, autoCompact = true): Promise<Env> => {
  const env = await makeEnv({ capabilities: capabilitiesFor(WINDOW) });
  env.settings.contextValue = { ...env.settings.contextValue, adaptiveBudget: false, autoCompact, compactAt };
  return env;
};

const runSeeded = async (env: Env, events: readonly RunEventPayload[]) => {
  const run = await env.enqueue('question one', { history: 'fresh' });
  await env.seed(run.id, events, 'release');
  env.gateway.script.push(textStep('Done.'));
  const overflows: boolean[] = [];
  await env.runOnce(env.worker(`worker-${run.id}`, { onContextOverflow: (error) => overflows.push(error.compaction !== undefined) }));
  return { run, overflows };
};

const evictedC1 = (env: Env, runId: string) => env.ofType(runId, 'context.truncated').filter((event) => event.kind === 'omitted' && event.callId === 'c1');

describe('context.compactAt is read per claim', () => {
  it('keeps the old output at 70 percent', async () => {
    const env = await envWith(70);
    const { run } = await runSeeded(env, oneReadThenQuestion);
    expect(evictedC1(env, run.id)).toEqual([]);
  });

  it('evicts the same old output at 10 percent', async () => {
    const env = await envWith(10);
    const { run } = await runSeeded(env, oneReadThenQuestion);
    expect(evictedC1(env, run.id)).toHaveLength(1);
  });

  it('builds the second run with the value set after the first run', async () => {
    const env = await envWith(90);
    const first = await runSeeded(env, oneReadThenQuestion);
    env.settings.contextValue = { ...env.settings.contextValue, compactAt: 10 };
    const second = await runSeeded(env, oneReadThenQuestion);

    expect(evictedC1(env, first.run.id)).toEqual([]);
    expect(evictedC1(env, second.run.id)).toHaveLength(1);
  });

  it('builds a child run with the value of the settings at its own claim', async () => {
    const env = await envWith(90);
    const parent = await createdRun(await env.store.createRunAndEnqueue(env.session.id, { input: 'Parent', timeoutMs: DEADLINE_MS - env.clock.now(), limits: {}, pins: {}, history: 'fresh' }));
    const claim = await env.seed(parent.id, [{ type: 'run.started', attempt: 1, now: env.clock.now(), pins: { model: 'fm' }, mode: 'manual' }], 'hold');
    const created = await env.store.createChildRun({ parentRunId: parent.id, parentCallId: 'call_child', input: 'Child', pins: {}, model: 'fm' });
    if (created.kind !== 'created') throw new Error(`child run was not created: ${created.kind}`);
    expect((await env.store.releaseLease(claim, { availableAt: env.clock.now() + 3_600_000 })).kind).toBe('ok');
    await env.seed(created.run.id, oneReadThenQuestion, 'release');
    env.settings.contextValue = { ...env.settings.contextValue, compactAt: 10 };
    env.gateway.script.push(textStep('Child done.'));

    await env.runOnce(env.worker('worker-child'));

    expect(env.run(created.run.id).status).toBe('COMPLETED');
    expect(env.gateway.streams.map((stream) => Array.isArray(stream.body.input) && stream.body.input.some((item) => item.type === 'function_call_output' && item.call_id === 'c1'))).toEqual([true]);
    expect(evictedC1(env, created.run.id)).toHaveLength(1);
  });
});

describe('context.compactAt at 100 percent', () => {
  it('compacts proactively at the default for a conversation that still fits', async () => {
    const env = await envWith(70);
    const { run, overflows } = await runSeeded(env, fourTurns(36_000));
    expect(overflows).toEqual([]);
    expect(env.ofType(run.id, 'context.compacted')).toHaveLength(1);
  });

  it('performs no proactive compaction while the conversation fits', async () => {
    const env = await envWith(100);
    const { run, overflows } = await runSeeded(env, fourTurns(36_000));
    expect(overflows).toEqual([]);
    expect(env.gateway.compacts).toEqual([]);
    expect(env.ofType(run.id, 'context.compacted')).toEqual([]);
    expect(env.run(run.id).status).toBe('COMPLETED');
  });

  it('compacts through the overflow path once the conversation no longer fits', async () => {
    const env = await envWith(100);
    const { run, overflows } = await runSeeded(env, fourTurns(60_000));
    expect(overflows).toEqual([true]);
    expect(env.ofType(run.id, 'context.compacted')).toHaveLength(1);
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'notice').map((event) => event.code)).toEqual(['no_check_declared']);
  });
});
