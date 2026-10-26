import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { fixtureCompactionContent, fixtureCompactionItem } from '@momonga/testkit';
import { capabilitiesFor, compactKey, makeEnv, textOf } from './harness.ts';
import { assistantMessage, callsStep, functionCallItem, textStep } from './scripts.ts';

const responded = (step: number, output: unknown[]): RunEventPayload => ({
  type: 'model.responded',
  step,
  attempt: 1,
  response: { status: 'completed', output, usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 } },
});

const user = (text: string): RunEventPayload => ({ type: 'user.message', text });

const BIG_OUTPUT = Array.from({ length: 400 }, (_unused, index) => `line-${String(index + 1).padStart(4, '0')}`).join('\n');

describe('worker context: evictions', () => {
  it('appends context.truncated once for an oversized output not yet reflected in state', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(4000) });
    const run = env.enqueue('Read the log');
    env.seed(
      run.id,
      [
        responded(1, [functionCallItem({ callId: 'call_big', name: 'Echo', args: { value: 'log' } })]),
        { type: 'tool.call', callId: 'call_big', providerCallId: 'call_big', name: 'Echo', kind: 'read', title: 'Echo log', rawInput: { value: 'log' } },
        { type: 'tool.completed', callId: 'call_big', status: 'completed', output: BIG_OUTPUT },
      ],
      'release',
    );
    env.gateway.script.push(callsStep([{ callId: 'call_small', name: 'Echo', args: { value: 'x' } }]), textStep('Read it.'));

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    const truncations = env.ofType(run.id, 'context.truncated');
    expect(truncations).toEqual([expect.objectContaining({ callId: 'call_big', kind: 'truncated' })]);
    const handle = truncations[0]?.handle ?? '';
    expect(handle).toMatch(/^[0-9a-f]{64}$/);
    expect((await env.store.blobs.read(handle, { lineStart: 1, lineEnd: 400 })).text).toBe(BIG_OUTPUT);
    expect(env.fold(run.id).history.find((entry) => entry.callId === 'call_big')?.handle).toBe(handle);

    const firstModelEvent = env.ofType(run.id, 'model.requested')[0];
    expect(truncations[0]?.seq).toBeLessThan(firstModelEvent?.seq ?? 0);
    const input = env.gateway.streams[0]?.body.input;
    if (!Array.isArray(input)) throw new Error('expected an input array');
    const rendered = input.find((item) => item.type === 'function_call_output' && item.call_id === 'call_big');
    expect(rendered?.type === 'function_call_output' ? String(rendered.output) : '').toContain(handle);
    expect(rendered?.type === 'function_call_output' ? String(rendered.output).length : Infinity).toBeLessThan(BIG_OUTPUT.length);
  });
});

describe('worker context: compaction', () => {
  it('compacts the rendered prefix through the boundary under the whole-body key, then appends context.compacted and rebuilds', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(40_000) });
    const run = env.enqueue('Task one');
    const big = assistantMessage('msg_big', 'x'.repeat(100_000));
    env.seed(
      run.id,
      [
        responded(1, [big]),
        user('question two'),
        responded(2, [assistantMessage('msg_r2', 'answer two')]),
        user('question three'),
        responded(3, [assistantMessage('msg_r3', 'answer three')]),
        user('question four'),
      ],
      'release',
    );
    const history = env.fold(run.id).history;
    expect(history.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    env.gateway.compactSummaries.push('S1');
    env.gateway.script.push(textStep('Answer four.'));

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.compacts).toHaveLength(1);
    const [compact] = env.gateway.compacts;
    expect(compact?.idempotencyKey).toBe(compactKey(run.id, compact?.request));
    expect(compact?.request.input).toEqual(history.filter((entry) => entry.seq <= 2).map((entry) => entry.item));
    expect(compact?.request).not.toHaveProperty('instructions');
    expect(compact?.request.momonga).toEqual({ max_summary_tokens: 2400, retains_user_request: true });

    const [compacted] = env.ofType(run.id, 'context.compacted');
    expect(compacted).toMatchObject({ summary: 'S1', replacedThroughSeq: 2, item: { type: 'compaction', encrypted_content: fixtureCompactionContent('S1') } });
    const firstRequest = env.ofType(run.id, 'model.requested')[0];
    expect(compacted?.seq).toBeLessThan(firstRequest?.seq ?? 0);

    const input = env.gateway.streams[0]?.body.input;
    if (!Array.isArray(input)) throw new Error('expected an input array');
    expect(input.some((item) => item.type === 'compaction' && item.encrypted_content === fixtureCompactionContent('S1'))).toBe(true);
    expect(input.some((item) => textOf(item).includes('x'.repeat(1000)))).toBe(false);
    expect(env.fold(run.id).summary).toMatchObject({ summary: 'S1', replacedThroughSeq: 2 });
  });

  it('includes the prior summary item ahead of the compacted history', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(40_000) });
    const run = env.enqueue('Task one');
    const prior = fixtureCompactionItem('cmp_0', 'S0');
    env.seed(
      run.id,
      [
        responded(1, [assistantMessage('msg_a', 'answer one')]),
        user('question two'),
        { type: 'context.compacted', item: prior, summary: 'S0', replacedThroughSeq: 2 },
        responded(2, [assistantMessage('msg_big', 'y'.repeat(100_000))]),
        user('question three'),
        responded(3, [assistantMessage('msg_r3', 'answer three')]),
        user('question four'),
        responded(4, [assistantMessage('msg_r4', 'answer four')]),
        user('question five'),
      ],
      'release',
    );
    const state = env.fold(run.id);
    expect(state.history.map((entry) => entry.seq)).toEqual([3, 4, 5, 6, 7, 8, 9]);
    env.gateway.compactSummaries.push('S1');
    env.gateway.script.push(textStep('Answer five.'));

    await env.runOnce(env.worker());

    const [compact] = env.gateway.compacts;
    expect(compact?.idempotencyKey).toBe(compactKey(run.id, compact?.request));
    const task = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Task one' }] };
    expect(compact?.request.input).toEqual([prior, task, ...state.history.filter((entry) => entry.seq <= 4).map((entry) => entry.item)]);
    expect(env.ofType(run.id, 'context.compacted').at(-1)).toMatchObject({ summary: 'S1', replacedThroughSeq: 4 });
    expect(env.run(run.id).status).toBe('COMPLETED');
  });

  it('fails the run with pinned_overflow when the pinned context cannot fit', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(600) });
    const run = env.enqueue('x'.repeat(4000));

    await env.runOnce(env.worker());

    const failed = env.run(run.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.error?.code).toBe('pinned_overflow');
    expect(failed.error?.message).toMatch(
      /^The pinned context needs \d+ tokens but at most \d+ fit \(window 600, output reserve 256, estimation margin \d+\)\. Breakdown: system prompt \d+, tool definitions \d+ \(\d+%\), instructions \d+, task \d+\. Reduce it with deny rules for tools you do not need, `plan` mode, a shorter task or AGENTS\.md, or a model with a larger context window\.$/,
    );
    expect(env.gateway.streams).toEqual([]);
    expect(env.ofType(run.id, 'run.status').at(-1)).toMatchObject({ from: 'RUNNING', to: 'FAILED', reason: 'pinned_overflow' });
  });
});
