import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@momonga/foundation';
import type { InputItem, RunEventPayload } from '@momonga/protocol';
import { capabilitiesFor, compactKey, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { assistantMessage, textStep } from './scripts.ts';
import {
  OMITTED,
  bigStep,
  gatewayError,
  inputOf,
  outputTextFor,
  padOf,
  withinTurnWorker,
} from './within-turn-support.ts';

const W4000 = capabilitiesFor(4000);

const callIdsOf = (env: Env, runId: string): string[] =>
  env.ofType(runId, 'tool.call').map((event) => event.callId);

const noticesOf = (env: Env, runId: string): string[] => env.ofType(runId, 'notice').map((event) => event.message);

const isTaskItem = (item: InputItem, text: string): boolean =>
  item.type === 'message' && item.role === 'user' && canonicalJson(item.content) === canonicalJson([{ type: 'input_text', text }]);

const BUDGET_NOTICE =
  /^The context needs \d+ tokens but at most 2920 fit \(window 4000, output reserve 1000, estimation margin \d+\)\. The fixed prefix takes \d+ \(system prompt \d+, tool definitions \d+, instructions 0, task \d+\)\. Earlier in this run: (\d+) tool outputs were replaced by handles and (\d+) compaction\(s\) were recorded\. Final attempt: (\d+) compaction\(s\) ran(.*?); no further compaction was possible because .+; protection was (?:reduced to \d+ turn\(s\) and \d+ step\(s\)|not reduced \(\d+ turn\(s\) and \d+ step\(s\) kept\)); .+\.$/;

describe('in-turn eviction', () => {
  it('journals context.truncated(omitted) for older outputs of the current turn only, before the request that omits them', async () => {
    const env = await makeEnv({ capabilities: W4000 });
    const letters = [...'abcdefgh'];
    env.gateway.script.push(...letters.map((letter, index) => bigStep(`k${index}`, { letter, size: 1800, pad: '' })), textStep('done'));
    const run = env.enqueue('Fill the context');

    await env.runOnce(env.worker('worker-1', withinTurnWorker()));

    expect(env.run(run.id).status).toBe('COMPLETED');
    const callIds = callIdsOf(env, run.id);
    const truncations = env.ofType(run.id, 'context.truncated');
    expect(truncations.map((event) => [event.callId, event.kind])).toEqual(callIds.slice(0, 4).map((callId) => [callId, 'omitted']));
    const requests = env.ofType(run.id, 'model.requested');
    for (const truncation of truncations) {
      const firstOmitting = requests.find((request) => OMITTED.test(outputTextFor(inputOf(request.body as { input?: unknown }), truncation.callId) ?? ''));
      expect(firstOmitting).toBeDefined();
      expect(truncation.seq).toBeLessThan(firstOmitting?.seq ?? 0);
    }
    for (const [index, stream] of env.gateway.streams.entries()) {
      const recent = callIds.slice(Math.max(0, index - 4), index);
      for (const [offset, callId] of recent.entries()) {
        const letter = letters[Math.max(0, index - 4) + offset] as string;
        expect(outputTextFor(inputOf(stream.body), callId)).toBe(letter.repeat(1800));
      }
    }
    expect(env.gateway.compacts).toEqual([]);
  });
});

describe('in-turn compaction', () => {
  const sixPaddedSteps = () => [0, 1, 2, 3, 4, 5].map((index) => bigStep(`k${index}`, { letter: 'a', size: 0, pad: padOf(index, 1400) }));

  it('compacts the rendered steps before the protected ones with the summary cap and retains_user_request, and rebuilds summary, task, retained', async () => {
    const env = await makeEnv({ capabilities: W4000 });
    env.gateway.script.push(...sixPaddedSteps(), textStep('done'));
    env.gateway.compactSummaries.push('S1');
    const run = env.enqueue('Fill the context');

    await env.runOnce(env.worker('worker-1', withinTurnWorker()));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.compacts).toHaveLength(1);
    const [compact] = env.gateway.compacts;
    const request = compact?.request;
    if (request === undefined) throw new Error('expected a compact request');
    const beforeCompaction = inputOf(env.gateway.streams[5]?.body ?? {});
    expect(request.input).toEqual(beforeCompaction.slice(1, 6));
    expect(isTaskItem(beforeCompaction[1] as InputItem, 'Fill the context')).toBe(true);
    expect(request.model).toBe('fm');
    expect('instructions' in request).toBe(false);
    expect(request.momonga).toEqual({ max_summary_tokens: 240, retains_user_request: true });
    expect(compact?.idempotencyKey).toBe(compactKey(run.id, request));

    const [compacted] = env.ofType(run.id, 'context.compacted');
    expect(compacted).toMatchObject({ summary: 'S1', replacedThroughSeq: 5 });
    const after = env.ofType(run.id, 'model.requested').find((event) => event.seq > (compacted?.seq ?? Infinity));
    const afterInput = inputOf(after?.body as { input?: unknown });
    expect(afterInput[0]).toMatchObject({ type: 'message', role: 'system' });
    expect(afterInput[1]).toMatchObject({ type: 'compaction' });
    expect(isTaskItem(afterInput[2] as InputItem, 'Fill the context')).toBe(true);
    expect(afterInput.filter((item) => isTaskItem(item, 'Fill the context'))).toHaveLength(1);
    expect(env.ofType(run.id, 'tool.call')).toHaveLength(6);
  });

  it('states a recorded compaction in the budget stop notice and makes no model call when the wrap-up also overflows', async () => {
    const env = await makeEnv({ capabilities: W4000 });
    env.gateway.script.push(...sixPaddedSteps(), bigStep('huge', { letter: 'a', size: 0, pad: 'p'.repeat(12000) }), textStep('never sent'));
    const run = env.enqueue('Fill the context');

    await env.runOnce(env.worker('worker-1', withinTurnWorker()));

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'budget' });
    expect(env.gateway.streams).toHaveLength(7);
    const notice = noticesOf(env, run.id).find((message) => message.startsWith('The context needs'));
    const match = BUDGET_NOTICE.exec(notice ?? '');
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe(String(env.fold(run.id).evicted.length));
    expect(match?.[2]).toBe('1');
    expect(match?.[3]).toBe('0');
    expect(notice).not.toContain('a final summary was requested');
  });
});

describe('budget stop after in-turn evictions', () => {
  it('journals the final attempt\'s evictions before the notice and counts exactly the journaled ones', async () => {
    const env = await makeEnv({ capabilities: W4000 });
    env.gateway.script.push(
      ...[...'abcdef'].map((letter, index) => bigStep(`k${index}`, { letter, size: 1800, pad: '' })),
      bigStep('huge', { letter: 'a', size: 0, pad: 'p'.repeat(12000) }),
      textStep('never sent'),
    );
    const run = env.enqueue('Fill the context');

    await env.runOnce(env.worker('worker-1', withinTurnWorker()));

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'budget' });
    const state = env.fold(run.id);
    expect(state.evicted).toHaveLength(6);
    const notice = env.ofType(run.id, 'notice').find((event) => event.message.startsWith('The context needs'));
    expect(BUDGET_NOTICE.exec(notice?.message ?? '')?.[1]).toBe('6');
    for (const truncation of env.ofType(run.id, 'context.truncated')) expect(truncation.seq).toBeLessThan(notice?.seq ?? 0);
  });
});

describe('budget stop with nothing compacted', () => {
  it('never says "after compaction" when no compaction was recorded or ran', async () => {
    const env = await makeEnv({ capabilities: W4000 });
    env.gateway.script.push(bigStep('huge', { letter: 'a', size: 0, pad: 'p'.repeat(12000) }), textStep('never sent'));
    const run = env.enqueue('Fill the context');

    await env.runOnce(env.worker('worker-1', withinTurnWorker()));

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'budget' });
    expect(env.gateway.streams).toHaveLength(1);
    const notices = noticesOf(env, run.id);
    for (const message of notices) expect(message).not.toContain('after compaction');
    expect(notices.find((message) => message.startsWith('The context needs'))).toContain('protection was not reduced (3 turn(s) and 4 step(s) kept)');
    const match = BUDGET_NOTICE.exec(notices.find((message) => message.startsWith('The context needs')) ?? '');
    expect(match).not.toBeNull();
    expect(match?.slice(1, 4)).toEqual(['0', '0', '0']);
  });
});

describe('budget stop counts of the final attempt', () => {
  const sixPaddedSteps = () => [0, 1, 2, 3, 4, 5].map((index) => bigStep(`k${index}`, { letter: 'a', size: 0, pad: padOf(index, 1400) }));
  const noticeOf = (env: Env, runId: string): string => noticesOf(env, runId).find((message) => message.startsWith('The context needs')) ?? '';
  const hasCompactionItem = (input: unknown): boolean => Array.isArray(input) && input.some((item: InputItem) => item.type === 'compaction');

  it('says the compaction did not free enough room after a successful compaction at the last level', async () => {
    const env = await makeEnv({ capabilities: W4000 });
    env.gateway.script.push(
      ...[4700, 4700, 100, 9200].map((size, index) => bigStep(`s${index}`, { letter: 'a', size: 0, pad: 'pqrs'[index]?.repeat(size) ?? '' })),
      textStep('never sent'),
    );
    env.gateway.compactSummaries.push('T'.repeat(2400));
    const run = env.enqueue('Fill the context');

    await env.runOnce(env.worker('worker-1', withinTurnWorker()));

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'budget' });
    expect(env.gateway.compacts).toHaveLength(1);
    const match = BUDGET_NOTICE.exec(noticeOf(env, run.id));
    expect(match).not.toBeNull();
    expect(match?.slice(2, 4)).toEqual(['0', '1']);
    expect(noticeOf(env, run.id)).toContain('because the compaction at this level did not free enough room');
    expect(noticeOf(env, run.id)).toContain('protection was reduced to 1 turn(s) and 1 step(s)');
  });

  it('counts a compaction of an earlier build as recorded and the forced compaction of the final attempt as ran', async () => {
    const env = await makeEnv({ capabilities: W4000 });
    env.gateway.script.push(...sixPaddedSteps(), bigStep('x', { letter: 'a', size: 0, pad: 'p'.repeat(5000) }), textStep('never sent'));
    env.gateway.compactSummaries.push('S1', 'T'.repeat(12000));
    const run = env.enqueue('Fill the context');

    await env.runOnce(env.worker('worker-1', withinTurnWorker()));

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'budget' });
    expect(env.gateway.compacts).toHaveLength(2);
    expect(env.ofType(run.id, 'context.compacted')).toHaveLength(2);
    const match = BUDGET_NOTICE.exec(noticeOf(env, run.id));
    expect(match?.slice(2, 4)).toEqual(['1', '1']);
  });

  it('does not count the rejected attempt of an invalid_compaction recovery as a compaction that ran', async () => {
    const env = await makeEnv({ capabilities: W4000 });
    env.gateway.script.push(...sixPaddedSteps(), bigStep('x', { letter: 'a', size: 0, pad: 'p'.repeat(5000) }), textStep('never sent'));
    env.gateway.compactSummaries.push('S1', 'T'.repeat(12000));
    env.gateway.compactHook = async (request) => {
      if (hasCompactionItem(request.input)) throw gatewayError(400, 'invalid_request', 'invalid_compaction');
    };
    const run = env.enqueue('Fill the context');

    await env.runOnce(env.worker('worker-1', withinTurnWorker()));

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'budget' });
    expect(env.gateway.compacts).toHaveLength(3);
    expect(env.ofType(run.id, 'context.compaction_rejected')).toHaveLength(1);
    const match = BUDGET_NOTICE.exec(noticeOf(env, run.id));
    expect(match?.slice(2, 4)).toEqual(['1', '1']);
  });
});

describe('forced compaction failure decided by code', () => {
  const forcedScript = () => [
    ...[0, 1, 2, 3, 4].map((index) => bigStep(`k${index}`, { letter: 'abcde'[index] as string, size: 504, pad: padOf(index, 1616) })),
    textStep('done'),
  ];

  const runForced = async (error: unknown) => {
    const env = await makeEnv({ capabilities: W4000 });
    env.gateway.script.push(...forcedScript());
    const attemptedAt: number[] = [];
    env.gateway.compactHook = async () => {
      attemptedAt.push(env.events(run.id).length);
      throw error;
    };
    const run = env.enqueue('Fill the context');
    await env.runOnce(env.worker('worker-1', withinTurnWorker()));
    return { env, run, attemptedAt };
  };

  it.for([
    ['compaction_input_too_large as the gateway sends it', 400, 'invalid_request', 'compaction_input_too_large'],
    ['invalid_summary_cap as the gateway sends it', 400, 'invalid_request', 'invalid_summary_cap'],
    ['compaction_summary_too_long as the gateway sends it', 502, 'model_error', 'compaction_summary_too_long'],
    ['compaction_invalid_reply as the gateway sends it', 502, 'model_error', 'compaction_invalid_reply'],
    ['content_filter as the gateway sends it', 502, 'model_error', 'content_filter'],
    ['guardrail_violation as the gateway sends it', 502, 'model_error', 'guardrail_violation'],
    ['compaction_input_too_large by its code alone', 502, 'model_error', 'compaction_input_too_large'],
    ['invalid_summary_cap by its code alone', 502, 'model_error', 'invalid_summary_cap'],
    ['refusal by its code alone', 502, 'model_error', 'refusal'],
    ['a 413 rejection', 413, 'invalid_request', 'payload_too_large'],
    ['a 422 rejection', 422, 'invalid_request', 'invalid_request'],
  ] as const)('escalates on %s: the level shrinks after the attempt and the run continues', async ([, status, type, code]) => {
    const { env, run, attemptedAt } = await runForced(gatewayError(status, type, code));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(attemptedAt).toHaveLength(1);
    const truncations = env.ofType(run.id, 'context.truncated');
    expect(truncations.map((event) => event.callId)).toEqual(callIdsOf(env, run.id).slice(0, 4));
    for (const truncation of truncations) expect(truncation.seq).toBeGreaterThan(attemptedAt[0] as number);
    expect(env.ofType(run.id, 'context.compacted')).toEqual([]);
  });

  it.for([
    ['a 401', gatewayError(401, 'invalid_request', 'authentication_failed'), 'FAILED'],
    ['a 403', gatewayError(403, 'invalid_request', 'permission_denied'), 'FAILED'],
    ['a 404', gatewayError(404, 'not_found', 'not_found'), 'FAILED'],
    ['a 408', gatewayError(408, 'invalid_request', 'request_timeout'), 'QUEUED'],
    ['a 409', gatewayError(409, 'invalid_request', 'idempotency_conflict'), 'QUEUED'],
    ['a 429', gatewayError(429, 'too_many_requests', 'too_many_requests'), 'QUEUED'],
    ['a 502 server_error', gatewayError(502, 'server_error', 'server_error'), 'QUEUED'],
    ['gateway_closed', gatewayError(503, 'server_error', 'gateway_closed'), 'QUEUED'],
    ['deadline_exceeded', gatewayError(0, 'transport', 'deadline_exceeded'), 'STOPPED'],
    ['gateway_unavailable', gatewayError(0, 'transport', 'gateway_unavailable'), 'QUEUED'],
    ['gateway_timeout', gatewayError(0, 'transport', 'gateway_timeout'), 'QUEUED'],
    ['stream_interrupted', gatewayError(0, 'transport', 'stream_interrupted'), 'QUEUED'],
    ['client_destroyed', gatewayError(0, 'transport', 'client_destroyed'), 'QUEUED'],
    ['invalid_response', gatewayError(0, 'transport', 'invalid_response'), 'QUEUED'],
    ['a raw abort reason', 'cancel', 'QUEUED'],
  ] as const)('does not escalate on %s and leaves the protected zone alone', async ([, error, status]) => {
    const { env, run, attemptedAt } = await runForced(error);

    expect(attemptedAt).toHaveLength(1);
    expect(env.run(run.id).status).toBe(status);
    expect(env.ofType(run.id, 'context.truncated')).toEqual([]);
    expect(env.gateway.streams).toHaveLength(5);
  });

  it('stops with the gateway code in the notice when the forced compaction fails at the last level', async () => {
    const env = await makeEnv({ capabilities: W4000 });
    env.gateway.script.push(
      bigStep('k0', { letter: 'a', size: 0, pad: padOf(0, 2200) }),
      bigStep('k1', { letter: 'a', size: 0, pad: padOf(1, 9000) }),
      textStep('never sent'),
    );
    env.gateway.compactHook = async () => {
      throw gatewayError(502, 'model_error', 'compaction_summary_too_long');
    };
    const run = env.enqueue('Fill the context');

    await env.runOnce(env.worker('worker-1', withinTurnWorker()));

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'budget' });
    expect(env.gateway.compacts).toHaveLength(1);
    expect(env.gateway.streams).toHaveLength(2);
    const notice = noticesOf(env, run.id).find((message) => message.startsWith('The context needs'));
    const match = BUDGET_NOTICE.exec(notice ?? '');
    expect(match?.[3]).toBe('1');
    expect(match?.[4]).toContain('compaction_summary_too_long');
  });
});

describe('proactive compaction failure', () => {
  it('warns with the gateway code and suppresses proactive retries for three steps', async () => {
    const env = await makeEnv({ capabilities: W4000 });
    env.gateway.script.push(...Array.from({ length: 16 }, (_unused, index) => bigStep(`k${index}`, { letter: 'a', size: 0, pad: padOf(index, 520) })), textStep('done'));
    const requestedAt: number[] = [];
    let failures = 0;
    env.gateway.compactHook = async () => {
      requestedAt.push(env.ofType(run.id, 'model.requested').length);
      if (failures === 0) {
        failures += 1;
        throw gatewayError(400, 'invalid_request', 'compaction_summary_too_long');
      }
    };
    const run = env.enqueue('Fill the context');

    await env.runOnce(env.worker('worker-1', withinTurnWorker()));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(requestedAt[0]).toBe(10);
    expect(requestedAt[1]).toBe(14);
    const warning = env.ofType(run.id, 'notice').find((event) => event.message.startsWith('Compaction failed (compaction_summary_too_long)'));
    expect(warning).toMatchObject({ level: 'warning' });
    expect(warning?.message).toMatch(/; continuing without it$/);
    expect(env.ofType(run.id, 'context.compacted')).toHaveLength(1);
  });
});

describe('forced compaction inside the suppression window of a failed proactive compaction', () => {
  it.for([0, 1])('compacts at the overflow %i steps after the failed proactive attempt instead of shrinking protection', async (quietSteps) => {
    const env = await makeEnv({ capabilities: W4000 });
    env.gateway.script.push(
      ...[0, 1, 2, 3, 4, 5].map((index) => bigStep(`k${index}`, { letter: 'a', size: 0, pad: padOf(index, 1400) })),
      ...Array.from({ length: quietSteps }, (_unused, index) => bigStep(`q${index}`, { letter: 'a', size: 0, pad: padOf(index, 40) })),
      bigStep('overflow', { letter: 'a', size: 0, pad: padOf(9, 3600) }),
      textStep('done'),
    );
    const requestedAt: number[] = [];
    env.gateway.compactHook = async () => {
      requestedAt.push(env.ofType(run.id, 'model.requested').length);
      if (requestedAt.length === 1) throw gatewayError(502, 'model_error', 'compaction_summary_too_long');
    };
    const run = env.enqueue('Fill the context');

    await env.runOnce(env.worker('worker-1', withinTurnWorker()));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.compacts).toHaveLength(2);
    expect(requestedAt[1]).toBe((requestedAt[0] as number) + 1 + quietSteps);
    expect(env.ofType(run.id, 'context.compacted')).toHaveLength(1);
    expect(noticesOf(env, run.id).filter((message) => /^recent (turns|steps)/.test(message))).toEqual([]);
  });
});

describe('minimum room at claim', () => {
  it('fails pinned_overflow with the minimum-room message when the prefix leaves fewer than 192 tokens', async () => {
    const env = await makeEnv({ capabilities: W4000 });
    env.instructions.files.set(`${env.project}/AGENTS.md`, 'r'.repeat(10600));
    const run = env.enqueue('Fill the context');

    await env.runOnce(env.worker('worker-1', withinTurnWorker()));

    const failed = env.run(run.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.error?.code).toBe('pinned_overflow');
    expect(failed.error?.message).toMatch(
      /^The pinned context fits \(\d+ of 2920 tokens\) but leaves only \d+ tokens for the conversation; at least 192 are needed for one tool call, one tool result and a summary\. Reduce the fixed prefix \(deny rules for unused tools, plan mode, shorter instructions\) or use a larger window\.$/,
    );
    expect(env.gateway.streams).toEqual([]);
  });
});

describe('inherited history and loop detection across compaction', () => {
  const completeSeeded = (env: Env, task: string, payloads: readonly RunEventPayload[]): void => {
    const run = env.enqueue(task);
    const claim = env.seed(run.id, payloads, 'hold');
    expect(env.store.transition(claim, ['RUNNING'], 'COMPLETED').kind).toBe('ok');
  };

  it('compacts across the task seq of an inheriting run and keeps the task once', async () => {
    const env = await makeEnv({ capabilities: W4000 });
    completeSeeded(env, 'question one', [
      { type: 'model.requested', step: 1, attempt: 1, digest: 'd1', body: { model: 'fm', input: 'seed' } },
      {
        type: 'model.responded',
        step: 1,
        attempt: 1,
        response: { status: 'completed', output: [assistantMessage('msg_1', 'answer one')], usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 } },
      },
    ]);
    env.gateway.script.push(...Array.from({ length: 7 }, (_unused, index) => bigStep(`k${index}`, { letter: 'a', size: 0, pad: padOf(index, 1400) })), textStep('done'));
    const second = env.enqueue('Continue the work');

    await env.runOnce(env.worker('worker-1', withinTurnWorker()));

    expect(env.run(second.id).status).toBe('COMPLETED');
    expect(env.gateway.compacts).toHaveLength(1);
    const compactInput = env.gateway.compacts[0]?.request.input as InputItem[];
    expect(compactInput[0]).toMatchObject({ type: 'message', role: 'user' });
    expect(compactInput[1]).toMatchObject({ type: 'message', role: 'assistant' });
    expect(isTaskItem(compactInput[2] as InputItem, 'Continue the work')).toBe(true);
    expect(compactInput.slice(3).map((item) => item.type)).toEqual(['function_call', 'function_call_output', 'function_call', 'function_call_output', 'function_call', 'function_call_output']);
    const [compacted] = env.ofType(second.id, 'context.compacted');
    expect(compacted?.replacedThroughSeq).toBeGreaterThan(env.fold(second.id).taskSeq);
    const after = env.ofType(second.id, 'model.requested').find((event) => event.seq > (compacted?.seq ?? Infinity));
    const afterInput = inputOf(after?.body as { input?: unknown });
    expect(afterInput.filter((item) => isTaskItem(item, 'Continue the work'))).toHaveLength(1);
    expect(isTaskItem(afterInput[2] as InputItem, 'Continue the work')).toBe(true);
    expect(env.ofType(second.id, 'tool.call')).toHaveLength(7);
  });

  it('detects a loop whose earlier groups were compacted away at the last level', async () => {
    const env = await makeEnv({ capabilities: W4000 });
    const same = { letter: 'x', size: 1, pad: 'p'.repeat(5720) };
    env.gateway.script.push(bigStep('k0', same), bigStep('k1', same), bigStep('k2', same), textStep('never sent'));
    const run = env.enqueue('Fill the context');

    await env.runOnce(env.worker('worker-1', withinTurnWorker()));

    expect(env.gateway.compacts).toHaveLength(1);
    expect(env.ofType(run.id, 'context.compacted')).toHaveLength(1);
    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'loop' });
    expect(env.ofType(run.id, 'tool.started')).toHaveLength(2);
  });
});
