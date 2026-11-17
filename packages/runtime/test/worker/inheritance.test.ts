import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunEventPayload, StreamEvent } from '@momonga/protocol';
import type { GatewayPort } from '@momonga/runtime';
import { responseResource, usageOf } from '@momonga/testkit';

import { compactInputOf, compactPinOf } from '../../src/worker/compact-pin.ts';
import { START_MS, capabilitiesFor, createdRun, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { MODEL_ID, assistantMessage, callsStep, functionCallItem, gated, textStep, textThenCallsStep } from './scripts.ts';
import {
  CLOSURE_TEXT,
  MARKER_TEXT,
  NEUTRAL_MESSAGE,
  firstConversation,
  inheritedEventOf,
  plantUnreadableEvent,
  settle,
  startedClosureText,
} from './inheritance-support.ts';
import type { Turn } from './inheritance-support.ts';

const USAGE = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };

const echo = (callId: string, value: string) => ({ callId, name: 'Echo', args: { value } });

const startedPayload = (): RunEventPayload => ({ type: 'run.started', attempt: 1, now: 0, pins: {}, mode: 'manual' });

const requestedPayload = (step: number): RunEventPayload => ({ type: 'model.requested', step, attempt: 1, digest: `d${step}`, body: { model: MODEL_ID, input: 'seed' } });

const respondedPayload = (step: number, output: unknown[]): RunEventPayload => ({
  type: 'model.responded',
  step,
  attempt: 1,
  response: { status: 'completed', output, usage: USAGE },
});

const toolCallPayload = (callId: string, file: string): RunEventPayload => ({
  type: 'tool.call',
  callId,
  providerCallId: callId,
  name: 'Write',
  kind: 'edit',
  title: `Write ${file}`,
  rawInput: { file_path: file, content: 'x' },
});

const writeCall = (env: Env, callId: string) => ({ callId, name: 'Write', args: { file_path: path.join(env.project, `${callId}.txt`), content: 'x' } });

const answered = async (env: Env, task: string, answer: string): Promise<string> => {
  env.gateway.script.push(textStep(answer));
  const run = await env.enqueue(task);
  expect((await settle(env, run.id)).status).toBe('COMPLETED');
  return run.id;
};

const nextRun = async (env: Env, task: string, answer = 'Next answer.'): Promise<string> => {
  env.gateway.script.push(textStep(answer));
  const run = await env.enqueue(task);
  await settle(env, run.id);
  return run.id;
};

describe('two runs in one session', () => {
  it('sends run 1 conversation in order and then the run 2 task, with context.inherited before run.started', async () => {
    const env = await makeEnv();
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    await answered(env, 'Say hello', 'Hello there.');
    const second = await nextRun(env, 'And again', 'Again.');

    expect(env.run(second).status).toBe('COMPLETED');
    expect(firstConversation(env, second)).toEqual([
      ['user', 'Say hello'],
      ['assistant', 'Hello there.'],
      ['user', 'And again'],
    ]);
    const types = env.events(second).map((event) => event.type);
    expect(types[0]).toBe('user.message');
    expect(types.indexOf('context.inherited')).toBe(1);
    expect(types.indexOf('context.inherited')).toBeLessThan(types.indexOf('run.started'));
    expect(inheritedEventOf(env, second).seq).toBe(2);
    expect(env.fold(second).taskSeq).toBe(3);
  });

  it('does not re-execute inherited tool calls and records no tool.call before its own response', async () => {
    const env = await makeEnv();
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    env.gateway.script.push(callsStep([echo('call_e_1', 'one')]), textStep('Echoed.'));
    const first = await env.enqueue('Echo one');
    await settle(env, first.id);
    expect(env.toolbox.executions).toHaveLength(1);
    const callId = env.gateway.callId('call_e_1');

    const second = await nextRun(env, 'Nothing to run', 'Nothing.');

    expect(env.toolbox.executions).toHaveLength(1);
    expect(env.ofType(second, 'tool.call')).toEqual([]);
    expect(env.ofType(second, 'tool.started')).toEqual([]);
    expect(Object.keys(env.fold(second).pendingCalls)).toEqual([]);
    expect(firstConversation(env, second)).toEqual([
      ['user', 'Echo one'],
      ['call', 'Echo', callId],
      ['output', callId, 'echo:one'],
      ['assistant', 'Echoed.'],
      ['user', 'Nothing to run'],
    ]);
  });
});

describe('closures for the dangling calls of run 1, per cause', () => {
  const expectClosed = (env: Env, second: string, closures: readonly [string, string][], announced: readonly boolean[]): void => {
    const conversation = firstConversation(env, second);
    expect(conversation.at(-1)).toEqual(['user', 'Next task']);
    const outputs = conversation.slice(-1 - closures.length, -1);
    expect(outputs).toEqual(closures.map(([callId, text]): Turn => ['output', callId, text]));
    for (const [callId] of closures) {
      const callIndex = conversation.findIndex((turn) => turn[0] === 'call' && turn[2] === callId);
      const outputIndex = conversation.findIndex((turn) => turn[0] === 'output' && turn[1] === callId);
      expect(callIndex).toBeGreaterThan(0);
      expect(outputIndex).toBeGreaterThan(callIndex);
    }
    expect(inheritedEventOf(env, second).closures.map((closure) => [closure.callId, closure.announced])).toEqual(closures.map(([callId], index) => [callId, announced[index]]));
  };

  it('closes calls of a run cancelled between model.responded and recordCalls', async () => {
    const env = await makeEnv();
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    env.settings.contextValue = { ...env.settings.contextValue, outputFormatters: [] };
    const first = await env.enqueue('Write both');
    await env.seed(first.id, [startedPayload(), requestedPayload(1), respondedPayload(1, [functionCallItem(writeCall(env, 'call_w_1')), functionCallItem(writeCall(env, 'call_w_2'))])], 'release');
    expect((await env.cancelToEnd(first.id)).status).toBe('CANCELLED');

    const second = await nextRun(env, 'Next task');

    expectClosed(env, second, [['call_w_1', CLOSURE_TEXT.cancelled], ['call_w_2', CLOSURE_TEXT.cancelled]], [false, false]);
  });

  it('closes a call whose approval wait was withdrawn by the cancel', async () => {
    const env = await makeEnv();
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    env.gateway.script.push(callsStep([writeCall(env, 'call_w_1')]));
    const first = await env.enqueue('Write it');
    await env.runOnce(env.worker());
    expect(env.run(first.id).status).toBe('WAITING_HUMAN');
    expect((await env.cancelToEnd(first.id)).status).toBe('CANCELLED');
    const callId = env.gateway.callId('call_w_1');

    const second = await nextRun(env, 'Next task');

    expectClosed(env, second, [[callId, CLOSURE_TEXT.cancelled]], [true]);
  });

  it('closes the repeated call of a run stopped by the loop check', async () => {
    const env = await makeEnv();
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    env.settings.contextValue = { ...env.settings.contextValue, loopGuidance: false };
    env.gateway.script.push(callsStep([echo('call_l_1', 'same')]), callsStep([echo('call_l_1', 'same')]), callsStep([echo('call_l_1', 'same')]));
    const first = await env.enqueue('Loop', { limits: { loopThreshold: 3 } });
    expect((await settle(env, first.id)).stopReason).toBe('loop');
    const dangling = env.gateway.callId('call_l_1', 2);

    const second = await nextRun(env, 'Next task');

    expectClosed(env, second, [[dangling, CLOSURE_TEXT.loop]], [false]);
  });

  it('closes the calls of a run that failed after its model response', async () => {
    const env = await makeEnv();
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    const first = await env.enqueue('Write it');
    const claim = await env.seed(first.id, [requestedPayload(1), respondedPayload(1, [functionCallItem(writeCall(env, 'call_w_1'))])], 'hold');
    expect((await env.store.transition(claim, ['RUNNING'], 'FAILED', { error: { code: 'server_error', message: 'upstream failed' } })).kind).toBe('ok');

    const second = await nextRun(env, 'Next task');

    expectClosed(env, second, [['call_w_1', CLOSURE_TEXT.failed]], [false]);
  });

  it('marks a started call of a failed run as having an unknown effect', async () => {
    const env = await makeEnv();
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    const first = await env.enqueue('Write it');
    const file = path.join(env.project, 'call_w_1.txt');
    const claim = await env.seed(
      first.id,
      [requestedPayload(1), respondedPayload(1, [functionCallItem(writeCall(env, 'call_w_1'))]), toolCallPayload('call_w_1', file), { type: 'tool.started', callId: 'call_w_1', idemKey: 'k-w-1' }],
      'hold',
    );
    expect((await env.store.transition(claim, ['RUNNING'], 'FAILED', { error: { code: 'server_error', message: 'upstream failed' } })).kind).toBe('ok');

    const second = await nextRun(env, 'Next task');

    expectClosed(env, second, [['call_w_1', startedClosureText('ended with an error')]], [true]);
    expect(inheritedEventOf(env, second).closures[0]?.effect).toBe('unknown');
  });

  it('closes a call whose run reached its deadline while its approval waited', async () => {
    const env = await makeEnv();
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    env.gateway.script.push(callsStep([writeCall(env, 'call_w_1')]));
    const first = await env.enqueue('Write it', { deadlineAt: START_MS + 60_000 });
    await env.runOnce(env.worker());
    expect(env.run(first.id).status).toBe('WAITING_HUMAN');
    env.clock.advance(60_000);
    expect((await env.store.expireApprovals(env.clock.now(), (error: unknown) => { throw error; }))).toEqual([first.id]);
    expect(env.run(first.id)).toMatchObject({ status: 'STOPPED', stopReason: 'timeout' });
    const callId = env.gateway.callId('call_w_1');

    const second = await nextRun(env, 'Next task');

    expectClosed(env, second, [[callId, CLOSURE_TEXT.timeout]], [true]);
  });
});

describe('interrupted run 1 in the request of run 2', () => {
  const ITEM_ID = 'msg_partial';

  const untilAborted = (signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });

  it('sends the partial text as an incomplete assistant item, then the interrupted marker, then the task', async () => {
    const env = await makeEnv();
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    const first = await env.enqueue('Talk');
    const opening: StreamEvent[] = [
      { type: 'response.created', sequence_number: 0, response: responseResource({ id: 'resp_partial', model: MODEL_ID, status: 'in_progress' }) },
      { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { type: 'message', id: ITEM_ID, status: 'in_progress', role: 'assistant', content: [] } },
      { type: 'response.output_text.delta', sequence_number: 2, item_id: ITEM_ID, output_index: 0, content_index: 0, delta: 'Partial ' },
      { type: 'response.output_text.delta', sequence_number: 3, item_id: ITEM_ID, output_index: 0, content_index: 0, delta: 'answer' },
    ];
    const gateway: GatewayPort = {
      ...env.gateway,
      stream: (_body, options) =>
        (async function* () {
          yield* opening;
          await env.store.requestCancel(first.id);
          await untilAborted(options.signal);
          throw new Error('The operation was aborted');
        })(),
    };
    await env.settled(env.runOnce(env.worker('worker-1', { gateway, cancelPollMs: 5 })), 'the cancelled claim to settle');
    expect(env.run(first.id).status).toBe('CANCELLED');

    const second = await nextRun(env, 'Go on');

    expect(firstConversation(env, second)).toEqual([
      ['user', 'Talk'],
      ['assistant', 'Partial answer', 'incomplete'],
      ['user', MARKER_TEXT.userInterrupted],
      ['user', 'Go on'],
    ]);
    expect(inheritedEventOf(env, second).partial).toEqual({ seq: 2 });
  });

  it('sends the unanswered task, the marker and the new task as three separate user items', async () => {
    const env = await makeEnv();
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    const blocked = gated(textStep('never delivered'), 0);
    env.gateway.script.push(blocked);
    const first = await env.enqueue('First request');
    const running = env.runOnce(env.worker('worker-1', { cancelPollMs: 5 }));
    await env.settled(blocked.gate.reached.promise, 'the first stream to start');
    await env.cancel(first.id);
    await env.settled(running, 'the cancelled claim');
    expect(env.run(first.id).status).toBe('CANCELLED');

    const second = await nextRun(env, 'Second request');

    expect(firstConversation(env, second)).toEqual([
      ['user', 'First request'],
      ['user', MARKER_TEXT.userInterrupted],
      ['user', 'Second request'],
    ]);
  });
});

describe('run-local limits and loop detection', () => {
  it('gives run 2 its own maxSteps and maxTotalTokens and starts its usage at 0', async () => {
    const env = await makeEnv();
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    env.gateway.script.push(callsStep([echo('call_e_1', 'one')], usageOf(400, 10)), textStep('First done.', { usage: usageOf(400, 10) }));
    const first = await env.enqueue('Echo one', { limits: { maxSteps: 2, maxTotalTokens: 100_000 } });
    expect((await settle(env, first.id)).status).toBe('COMPLETED');
    expect(env.run(first.id).usage.totalTokens).toBe(820);

    env.gateway.script.push(callsStep([echo('call_e_2', 'two')], usageOf(400, 10)), textStep('Second done.', { usage: usageOf(400, 10) }));
    const second = await env.enqueue('Echo two', { limits: { maxSteps: 2, maxTotalTokens: 100_000 } });
    const finished = await settle(env, second.id);

    expect(finished.status).toBe('COMPLETED');
    expect(finished.step).toBe(2);
    expect(finished.usage).toEqual({ inputTokens: 800, outputTokens: 20, totalTokens: 820 });
    expect(env.fold(second.id).usage).toEqual({ inputTokens: 800, outputTokens: 20, totalTokens: 820 });
    expect(firstConversation(env, second.id).slice(0, 2)).toEqual([
      ['user', 'Echo one'],
      ['call', 'Echo', env.gateway.callId('call_e_1')],
    ]);
  });

  it('does not count run 1 calls toward a loop in run 2', async () => {
    const env = await makeEnv();
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    env.gateway.script.push(callsStep([echo('call_s_1', 'same')]), callsStep([echo('call_s_1', 'same')]), textStep('Stopped repeating.'));
    const first = await env.enqueue('Echo', { limits: { loopThreshold: 3 } });
    expect((await settle(env, first.id)).status).toBe('COMPLETED');

    env.gateway.script.push(callsStep([echo('call_s_2', 'same')]), textStep('Once more.'));
    const second = await env.enqueue('Echo again', { limits: { loopThreshold: 3 } });
    const finished = await settle(env, second.id);

    expect(finished.status).toBe('COMPLETED');
    expect(finished.stopReason).toBeUndefined();
    expect(env.toolbox.executions).toHaveLength(3);
    expect(firstConversation(env, second.id).filter((turn) => turn[0] === 'call')).toHaveLength(2);
  });

  it('still stops a genuine loop inside run 2 at its own third repetition', async () => {
    const env = await makeEnv();
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    env.settings.contextValue = { ...env.settings.contextValue, loopGuidance: false };
    env.gateway.script.push(callsStep([echo('call_s_1', 'same')]), callsStep([echo('call_s_1', 'same')]), textStep('Stopped repeating.'));
    const first = await env.enqueue('Echo', { limits: { loopThreshold: 3 } });
    await settle(env, first.id);

    env.gateway.script.push(callsStep([echo('call_s_2', 'same')]), callsStep([echo('call_s_2', 'same')]), callsStep([echo('call_s_2', 'same')]));
    const second = await env.enqueue('Echo again', { limits: { loopThreshold: 3 } });
    const finished = await settle(env, second.id);

    expect(finished).toMatchObject({ status: 'STOPPED', stopReason: 'loop' });
    expect(finished.step).toBe(3);
    expect(env.toolbox.executions).toHaveLength(4);
    expect(firstConversation(env, second.id).filter((turn) => turn[0] === 'call')).toHaveLength(2);
  });
});

describe('a response rejected for a reused call id is not inherited', () => {
  it('lets run 3 inherit run 1 and the run 2 task, without any part of the rejected response', async () => {
    const env = await makeEnv();
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    env.gateway.rewriteCallIds = false;
    env.gateway.script.push(callsStep([echo('call_1', 'first')]), textStep('Done one.'));
    const first = await env.enqueue('Echo first');
    await settle(env, first.id);

    env.gateway.script.push(textThenCallsStep('Again.', [echo('call_1', 'second')]), textStep('only reached without the assertion'));
    const second = await env.enqueue('Echo second');
    expect(await settle(env, second.id)).toMatchObject({ status: 'FAILED', error: { code: 'call_id_reused' } });
    env.gateway.script.splice(0);
    expect(env.toolbox.executions).toHaveLength(1);

    const third = await nextRun(env, 'Third');

    expect(firstConversation(env, third)).toEqual([
      ['user', 'Echo first'],
      ['call', 'Echo', 'call_1'],
      ['output', 'call_1', 'echo:first'],
      ['assistant', 'Done one.'],
      ['user', 'Echo second'],
      ['user', MARKER_TEXT.ended],
      ['user', 'Third'],
    ]);
    expect(inheritedEventOf(env, third).partial).toBeUndefined();
  });
});

describe('first claim CANCELLING', () => {
  it('still appends context.inherited, keeps the inherited conversation and drops only the cancelled task', async () => {
    const env = await makeEnv();
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    await answered(env, 'Say hello', 'Hello there.');
    const second = await env.enqueue('Cancelled early');
    await env.seed(second.id, [], 'crash');
    expect((await env.cancel(second.id)).status).toBe('CANCELLING');
    await env.runOnce(env.worker());
    expect(env.run(second.id).status).toBe('CANCELLED');
    const inherited = inheritedEventOf(env, second.id);
    expect(env.ofType(second.id, 'run.started')).toEqual([]);
    expect(inherited.mode).toBe('manual');
    expect(env.fold(second.id).mode).toBe('manual');

    const third = await nextRun(env, 'Third');

    expect(firstConversation(env, third)).toEqual([
      ['user', 'Say hello'],
      ['assistant', 'Hello there.'],
      ['user', 'Third'],
    ]);
    expect(inheritedEventOf(env, third).fromRunId).toBe(second.id);
  });
});

describe('inheritance failures', () => {
  it('fails run 2 with previous_run_unreadable after exactly one attempt; fresh recovers and the next run inherits from it only', async () => {
    const env = await makeEnv();
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    const first = await answered(env, 'Say hello', 'Hello there.');
    plantUnreadableEvent(env, first, 2);

    env.gateway.script.push(textStep('only reached without inheritance'));
    const second = await env.enqueue('Broken');
    const failed = await settle(env, second.id);
    env.gateway.script.splice(0);

    expect(failed).toMatchObject({ status: 'FAILED', error: { code: 'previous_run_unreadable', message: NEUTRAL_MESSAGE }, attempts: 1 });
    expect(env.events(second.id).some((event) => event.type === 'context.inherited')).toBe(false);
    expect(env.ofType(second.id, 'model.requested')).toEqual([]);
    expect(env.ofType(second.id, 'notice').map((notice) => notice.message).filter((message) => message.includes('will be retried'))).toEqual([]);

    env.gateway.script.push(textStep('Fresh answer.'));
    const third = await env.enqueue('Fresh start', { history: 'fresh' });
    expect((await settle(env, third.id)).status).toBe('COMPLETED');
    expect(env.run(third.id)).toMatchObject({ history: 'fresh', previousRunId: second.id });
    expect(firstConversation(env, third.id)).toEqual([['user', 'Fresh start']]);

    const fourth = await nextRun(env, 'Continue');
    expect(env.run(fourth).status).toBe('COMPLETED');
    expect(firstConversation(env, fourth)).toEqual([
      ['user', 'Fresh start'],
      ['assistant', 'Fresh answer.'],
      ['user', 'Continue'],
    ]);
  });

  it('fails with previous_run_inconsistent when the predecessor is missing', async () => {
    const env = await makeEnv();
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    await answered(env, 'Say hello', 'Hello there.');
    env.gateway.script.push(textStep('only reached without inheritance'));
    const second = await env.enqueue('Orphan');
    env.raw().exec('PRAGMA foreign_keys = OFF');
    env.raw().prepare("UPDATE runs SET previous_run_id = 'run-missing' WHERE id = ?").run(second.id);

    const failed = await settle(env, second.id);

    expect(failed).toMatchObject({ status: 'FAILED', error: { code: 'previous_run_inconsistent', message: NEUTRAL_MESSAGE }, attempts: 1 });
  });

  it('ends CANCELLED, not FAILED, when a cancel is requested while the inheritance fails', async () => {
    const env = await makeEnv();
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    const first = await answered(env, 'Say hello', 'Hello there.');
    plantUnreadableEvent(env, first, 2);
    const second = await env.enqueue('Cancelled while broken');
    await env.seed(second.id, [], 'crash');
    expect((await env.cancel(second.id)).status).toBe('CANCELLING');

    await env.runOnce(env.worker());

    expect(env.run(second.id).status).toBe('CANCELLED');
    const notices = env.ofType(second.id, 'notice').map((notice) => notice.message);
    expect(notices.some((message) => message.startsWith('The run was cancelled after an error'))).toBe(true);
    expect(env.events(second.id).some((event) => event.type === 'context.inherited')).toBe(false);

    env.gateway.script.push(textStep('only reached without inheritance'));
    const third = await env.enqueue('After the cancel');
    expect(await settle(env, third.id)).toMatchObject({ status: 'FAILED', error: { code: 'previous_run_unreadable' } });
  });
});

describe('a run that does not inherit', () => {
  it('starts a fresh run with only its own task even after a conversation', async () => {
    const env = await makeEnv();
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    await answered(env, 'Say hello', 'Hello there.');
    env.gateway.script.push(textStep('Fresh.'));
    const second = await env.enqueue('Fresh', { history: 'fresh' });
    await settle(env, second.id);
    expect(env.events(second.id).some((event) => event.type === 'context.inherited')).toBe(false);
    expect(firstConversation(env, second.id)).toEqual([['user', 'Fresh']]);
    expect(env.run(second.id).history).toBe('fresh');
  });
});

describe('a projected assistant message keeps its shape', () => {
  it('sends run 1 answer item unchanged in run 2', async () => {
    const env = await makeEnv();
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    env.gateway.script.push(textStep('Kept verbatim.', { itemId: 'msg_kept' }));
    const first = await env.enqueue('Say it');
    await settle(env, first.id);
    const answerItem = env.fold(first.id).history.find((entry) => entry.item.type === 'message' && entry.item.role === 'assistant')?.item;
    expect(answerItem).toMatchObject(assistantMessage('msg_kept', 'Kept verbatim.'));

    const second = await nextRun(env, 'Repeat it');

    const input = (env.ofType(second, 'model.requested')[0]?.body as { input: unknown[] } | undefined)?.input ?? [];
    expect(input).toContainEqual(answerItem);
  });
});

const LONG_TURNS: RunEventPayload[] = [
  respondedPayload(1, [assistantMessage('m1', `answer one ${'x'.repeat(40_000)}`)]),
  { type: 'user.message', text: 'question two' },
  respondedPayload(2, [assistantMessage('m2', `answer two ${'y'.repeat(40_000)}`)]),
  { type: 'user.message', text: 'question three' },
  respondedPayload(3, [assistantMessage('m3', `answer three ${'z'.repeat(40_000)}`)]),
  { type: 'user.message', text: 'question four' },
];

const compactedSession = async (): Promise<{ env: Env; compactRun: string }> => {
  const env = await makeEnv({ capabilities: capabilitiesFor(200_000) });
  env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
  const first = await env.enqueue('question one');
  await env.seed(first.id, LONG_TURNS, 'release');
  env.gateway.script.push(textStep('Done.'));
  await env.runOnce(env.worker());
  const compact = createdRun(
    await env.store.createRunAndEnqueue(env.session.id, { input: compactInputOf(undefined), timeoutMs: 3_600_000, limits: {}, pins: compactPinOf(undefined), history: 'inherit' }),
  );
  await env.runOnce(env.worker());
  expect(env.run(compact.id).status).toBe('COMPLETED');
  return { env, compactRun: compact.id };
};

describe('a run that inherits a summary records the inherited compaction', () => {
  it('writes one context.inherited_compacted before its first model request, with the summary, the replaced range and the tokens of the compaction', async () => {
    const { env, compactRun } = await compactedSession();
    const [compacted] = env.ofType(compactRun, 'context.compacted');
    const next = await nextRun(env, 'question six', 'Done again.');
    const later = await nextRun(env, 'question seven', 'Done once more.');

    for (const runId of [next, later]) {
      expect(env.run(runId).status).toBe('COMPLETED');
      const recorded = env.ofType(runId, 'context.inherited_compacted');
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        fromRunId: compactRun,
        item: compacted?.item,
        summary: compacted?.summary,
        replacedThroughSeq: compacted?.replacedThroughSeq,
        tokensBefore: compacted?.tokensBefore,
        tokensAfter: compacted?.tokensAfter,
      });
      const types = env.events(runId).map((event) => event.type);
      expect(types.indexOf('context.inherited_compacted')).toBeLessThan(types.indexOf('model.requested'));
    }
  });

  it('writes none for a run that inherits no summary, nor for the run that compacted', async () => {
    const env = await makeEnv();
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: false, conciseDescriptions: false };
    await answered(env, 'Say hello', 'Hello there.');
    const second = await nextRun(env, 'And again', 'Again.');
    expect(env.ofType(second, 'context.inherited_compacted')).toEqual([]);
    const { env: compactedEnv, compactRun } = await compactedSession();
    expect(compactedEnv.ofType(compactRun, 'context.inherited_compacted')).toEqual([]);
  });
});
