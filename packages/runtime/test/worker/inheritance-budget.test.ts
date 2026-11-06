import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compactionSummaryMessage } from '@momonga/protocol';
import type { InputItem, MessageInputItem, RunEventPayload } from '@momonga/protocol';
import { GatewayRequestError } from '@momonga/runtime';
import { fixtureCompactionContent } from '@momonga/testkit';
import { capabilitiesFor, compactKey, makeEnv, textOf } from './harness.ts';
import type { Env } from './harness.ts';
import { MODEL_ALIAS, assistantMessage, callsStep, functionCallItem, textStep } from './scripts.ts';
import { MARKER_TEXT, firstConversation, firstRequestInput, resolvedInheritedOf as inheritedEventOf, settle } from './inheritance-support.ts';

const USAGE = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };
const NO_TOOLS = { toolList: () => [] };

const requestedPayload = (step: number): RunEventPayload => ({ type: 'model.requested', step, attempt: 1, digest: `d${step}`, body: { model: MODEL_ALIAS, input: 'seed' } });

const respondedPayload = (step: number, output: unknown[]): RunEventPayload => ({
  type: 'model.responded',
  step,
  attempt: 1,
  response: { status: 'completed', output, usage: USAGE },
});

const completeSeeded = async (env: Env, task: string, payloads: readonly RunEventPayload[]): Promise<string> => {
  const run = env.enqueue(task);
  const claim = env.seed(run.id, payloads, 'hold');
  expect((await env.store.transition(claim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
  return run.id;
};

const settledWith = async (env: Env, runId: string, overrides = NO_TOOLS) => settle(env, runId, env.worker('worker-1', overrides));

describe('eviction of inherited outputs', () => {
  it('omits the oldest inherited outputs in run 2 and journals context.truncated for them', async () => {
    const env = await makeEnv();
    const callIds = ['call_big_1', 'call_big_2', 'call_big_3', 'call_big_4', 'call_big_5'];
    const outputOf = (callId: string): string => `${callId} `.padEnd(5000, 'o');
    await completeSeeded(env, 'Read five files', [
      requestedPayload(1),
      respondedPayload(1, callIds.map((callId) => functionCallItem({ callId, name: 'Echo', args: { value: callId } }))),
      ...callIds.flatMap((callId): RunEventPayload[] => [
        { type: 'tool.call', callId, providerCallId: callId, name: 'Echo', kind: 'read', title: `Echo ${callId}`, rawInput: { value: callId } },
        { type: 'tool.started', callId, idemKey: `k-${callId}` },
        { type: 'tool.completed', callId, status: 'completed', output: outputOf(callId) },
      ]),
      requestedPayload(2),
      respondedPayload(2, [assistantMessage('msg_read', 'Read them.')]),
    ]);
    env.gateway.capabilitiesValue = capabilitiesFor(8000);
    env.gateway.script.push(textStep('Short answer.'));
    const second = env.enqueue('Summarize');

    expect((await settledWith(env, second.id)).status).toBe('COMPLETED');

    const truncations = env.ofType(second.id, 'context.truncated');
    const evictedIds = truncations.map((event) => event.callId);
    expect(evictedIds.length).toBeGreaterThan(0);
    expect(evictedIds).toEqual(callIds.slice(0, evictedIds.length));
    expect(truncations.every((event) => event.kind === 'omitted')).toBe(true);
    expect(env.fold(second.id).evicted).toEqual([...evictedIds].sort());
    const input = firstRequestInput(env, second.id);
    const outputs = input.filter((item): item is Extract<InputItem, { type: 'function_call_output' }> => item.type === 'function_call_output');
    expect(outputs).toHaveLength(5);
    expect(String(outputs[0]?.output)).toMatch(/^\[tool output omitted: \d+ tokens; stored as \S+\]$/);
    expect(input.at(-1)).toMatchObject({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Summarize' }] });
  });
});

describe('compaction of inherited history', () => {
  it('compacts inherited turns in run 2 under a run-scoped key, and run 3 inherits the summary', async () => {
    const env = await makeEnv();
    const big = (label: string, size = 6000): string => `${label} `.padEnd(size, 'a');
    await completeSeeded(env, 'question one', [
      requestedPayload(1),
      respondedPayload(1, [assistantMessage('msg_1', big('answer one', 6400))]),
      { type: 'user.message', text: 'question two' },
      requestedPayload(2),
      respondedPayload(2, [assistantMessage('msg_2', big('answer two'))]),
      { type: 'user.message', text: 'question three' },
      requestedPayload(3),
      respondedPayload(3, [assistantMessage('msg_3', big('answer three'))]),
    ]);
    env.gateway.capabilitiesValue = capabilitiesFor(8000);
    env.gateway.compactSummaries.push('the first exchange');
    env.gateway.script.push(textStep('Compacted answer.'));
    const second = env.enqueue('question four');

    const settled = await settledWith(env, second.id);
    expect({ status: settled.status, error: settled.error }).toEqual({ status: 'COMPLETED', error: undefined });
    expect(settled).not.toHaveProperty('error');

    expect(env.gateway.compacts).toHaveLength(1);
    const [compact] = env.gateway.compacts;
    expect(compact?.idempotencyKey).toBe(compactKey(second.id, compact?.request));
    expect(compact?.request.momonga).toEqual({ max_summary_tokens: 480, retains_user_request: true });
    expect(compact?.request.instructions).toBeUndefined();
    const compactInput = compact?.request.input as InputItem[];
    expect(compactInput.map((item) => (item.type === 'message' ? [item.role, textOf(item).slice(0, 12)] : [item.type]))).toEqual([
      ['user', 'question one'],
      ['assistant', 'answer one a'],
    ]);
    const [compacted] = env.ofType(second.id, 'context.compacted');
    expect(compacted).toMatchObject({ summary: 'the first exchange', replacedThroughSeq: 2 });

    env.gateway.script.push(textStep('Third.'));
    const third = env.enqueue('question five');
    await settledWith(env, third.id);
    expect(inheritedEventOf(env, third.id).summary).toMatchObject({ summary: 'the first exchange', replacedThroughSeq: 2 });
    expect(inheritedEventOf(env, third.id).history[0]?.seq).toBe(3);
  });
});

describe('pinned_overflow across runs', () => {
  it('replaces a step-0 pinned_overflow task by the dropped marker in the next run', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('Hello there.'));
    const first = env.enqueue('Say hello');
    await settle(env, first.id);
    const second = env.enqueue('x'.repeat(400_000));
    expect(await settle(env, second.id)).toMatchObject({ status: 'FAILED', error: { code: 'pinned_overflow' } });
    expect(env.ofType(second.id, 'model.requested')).toEqual([]);
    env.gateway.script.splice(0);

    env.gateway.script.push(textStep('Third.'));
    const third = env.enqueue('Smaller request');
    await settle(env, third.id);

    expect(firstConversation(env, third.id)).toEqual([
      ['user', 'Say hello'],
      ['assistant', 'Hello there.'],
      ['user', MARKER_TEXT.dropped],
      ['user', 'Smaller request'],
    ]);
    expect(inheritedEventOf(env, third.id).markers).toEqual([{ seq: 3, kind: 'dropped' }]);
  });

  it('keeps the task and items of a run whose AGENTS.md grew after its first response', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('Hello there.'));
    const first = env.enqueue('Say hello');
    await settle(env, first.id);
    const agents = path.join(env.project, 'AGENTS.md');
    env.gateway.capabilitiesValue = capabilitiesFor(10_000);
    env.toolbox.hooks['Echo'] = () => {
      env.instructions.files.set(agents, 'rules '.repeat(10_000));
    };
    env.gateway.script.push(callsStep([{ callId: 'call_e_1', name: 'Echo', args: { value: 'grow' } }]), textStep('never sent'));
    const second = env.enqueue('Grow the rules');
    await env.runOnce(env.worker());
    expect(env.run(second.id).status).toBe('QUEUED');
    env.clock.advance(120_000);
    await env.runOnce(env.worker());
    expect(env.run(second.id)).toMatchObject({ status: 'FAILED', error: { code: 'pinned_overflow' } });
    expect(env.fold(second.id).step).toBe(1);
    const callId = env.gateway.callId('call_e_1');
    env.instructions.files.delete(agents);
    env.gateway.script.splice(0);

    env.gateway.script.push(textStep('Third.'));
    const third = env.enqueue('After the growth');
    await settle(env, third.id);

    expect(firstConversation(env, third.id)).toEqual([
      ['user', 'Say hello'],
      ['assistant', 'Hello there.'],
      ['user', 'Grow the rules'],
      ['call', 'Echo', callId],
      ['output', callId, 'echo:grow'],
      ['user', 'After the growth'],
    ]);
  });
});

describe('an inherited compaction item the gateway rejects', () => {
  const SUMMARY_TEXT = 'We fixed the <parser> bug';
  const PLAIN_SUMMARY: MessageInputItem = compactionSummaryMessage('We fixed the <parser> bug', 'model');

  it('is replaced by the plain summary in run 2, which completes', async () => {
    const env = await makeEnv();
    await completeSeeded(env, 'question one', [
      requestedPayload(1),
      respondedPayload(1, [assistantMessage('msg_1', 'answer one')]),
      { type: 'user.message', text: 'question two' },
      { type: 'context.compacted', item: { type: 'compaction', id: 'cmp_seed', encrypted_content: fixtureCompactionContent(SUMMARY_TEXT) }, summary: SUMMARY_TEXT, replacedThroughSeq: 2 },
      requestedPayload(2),
      respondedPayload(2, [assistantMessage('msg_2', 'answer two')]),
    ]);
    env.gateway.countHook = async (request) => {
      if (Array.isArray(request.input) && request.input.some((item: InputItem) => item.type === 'compaction')) {
        throw new GatewayRequestError({ status: 400, type: 'invalid_request', code: 'invalid_compaction', message: 'the compaction item could not be verified' });
      }
    };
    env.gateway.script.push(textStep('Done.'));
    const second = env.enqueue('question three');

    expect((await settle(env, second.id)).status).toBe('COMPLETED');

    expect(inheritedEventOf(env, second.id).summary?.item.type).toBe('compaction');
    expect(env.ofType(second.id, 'context.compaction_rejected')).toHaveLength(1);
    const input = firstRequestInput(env, second.id);
    expect(input.some((item) => item.type === 'compaction')).toBe(false);
    expect(input).toContainEqual(PLAIN_SUMMARY);
    const conversation = firstConversation(env, second.id);
    expect(conversation.slice(-4, -1)).toEqual([
      ['user', 'question two'],
      ['assistant', 'answer two'],
      ['user', 'question three'],
    ]);
    expect(conversation.at(-1)?.[1]).toMatch(/^<working_state>/);
  });
});
