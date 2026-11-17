import { describe, expect, it } from 'vitest';
import type { CountTokensResult, InputItem, MessageInputItem, RunEvent, RunEventPayload } from '@momonga/protocol';
import { GatewayRequestError } from '@momonga/runtime';
import { fixtureCompactionContent } from '@momonga/testkit';
import { budgetFor } from '@momonga/context';
import { SUMMARY_PROMPT_TOKENS, compactionSummaryMessage, summaryInputLimitFor, summaryTokenCapFor, tokensForText } from '@momonga/protocol';
import { bodyDigest, capabilitiesFor, compactKey, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import type { ScriptStep } from './fake-gateway.ts';
import { assistantMessage, textStep } from './scripts.ts';

const FIXTURE_FENCE = 'a'.repeat(32);

const SUMMARY_TEXT = 'We fixed the <parser> bug';
const PLAIN_SUMMARY: MessageInputItem = compactionSummaryMessage(SUMMARY_TEXT, 'model', FIXTURE_FENCE);
const plainSummaryOf = (env: Env): MessageInputItem => compactionSummaryMessage(SUMMARY_TEXT, 'model', env.session.fenceNonce);
const COMPACTION_ITEM = { type: 'compaction' as const, id: 'cmp_seed', encrypted_content: fixtureCompactionContent(SUMMARY_TEXT) };
const USAGE = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };

const invalidCompaction = (): GatewayRequestError =>
  new GatewayRequestError({ status: 400, type: 'invalid_request', code: 'invalid_compaction', message: 'the compaction item could not be verified' });

const hasCompaction = (input: unknown): boolean => Array.isArray(input) && input.some((item: InputItem) => item.type === 'compaction');

const firstInputOf = (compact: { request: { input?: unknown } } | undefined): unknown => (Array.isArray(compact?.request.input) ? compact.request.input[0] : undefined);

const responded = (step: number, text: string): RunEventPayload => ({
  type: 'model.responded',
  step,
  attempt: 1,
  response: { status: 'completed', output: [assistantMessage(`msg_${step}`, text)], usage: USAGE },
});

const compacted = (summary: string, replacedThroughSeq: number): RunEventPayload => ({
  type: 'context.compacted',
  item: { type: 'compaction', id: 'cmp_seed', encrypted_content: fixtureCompactionContent(summary) },
  summary,
  replacedThroughSeq,
});

const conversation = (sizes: { second?: number; third?: number; fifth?: number } = {}): RunEventPayload[] => [
  responded(1, 'answer one'),
  { type: 'user.message', text: 'question two' },
  responded(2, `answer two ${'x'.repeat(sizes.second ?? 0)}`),
  { type: 'user.message', text: 'question three' },
  responded(3, `answer three ${'t'.repeat(sizes.third ?? 0)}`),
  { type: 'user.message', text: 'question four' },
  responded(4, 'answer four'),
  { type: 'user.message', text: 'question five' },
  responded(5, `answer five ${'f'.repeat(sizes.fifth ?? 0)}`),
  { type: 'user.message', text: 'question six' },
];

const rejections = (env: Env, runId: string) => env.ofType(runId, 'context.compaction_rejected');

const firstSeq = (env: Env, runId: string, type: RunEvent['type']): number => {
  const found = env.events(runId).find((event) => event.type === type);
  if (found === undefined) throw new Error(`no ${type} event`);
  return found.seq;
};

const requestInputs = (env: Env, runId: string): unknown[][] =>
  env.ofType(runId, 'model.requested').map((event) => (event.body as { input: unknown[] }).input);

describe('compaction item rejected at the context build (site 1, count_tokens)', () => {
  const prepare = async (summary = SUMMARY_TEXT, extra: RunEventPayload[] = []) => {
    const env = await makeEnv();
    const run = await env.enqueue('question one');
    await env.seed(run.id, [responded(1, 'answer one'), { type: 'user.message', text: 'question two' }, compacted(summary, 2), ...extra], 'release');
    const stepBefore = env.fold(run.id).step;
    env.gateway.countHook = async (request) => {
      if (hasCompaction(request.input)) throw invalidCompaction();
    };
    return { env, run, stepBefore };
  };

  it('replaces the item by the plain summary, rebuilds and completes without consuming a step', async () => {
    const { env, run, stepBefore } = await prepare();
    env.gateway.script.push(textStep('Done.'));

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(env.gateway.countCalls.some((call) => hasCompaction(call.request.input))).toBe(true);
    const [rejected, ...more] = rejections(env, run.id);
    expect(more).toEqual([]);
    expect(rejected).toMatchObject({ item: plainSummaryOf(env) });
    expect(rejected).not.toHaveProperty('attempt');
    expect(firstSeq(env, run.id, 'context.compaction_rejected')).toBeLessThan(firstSeq(env, run.id, 'model.requested'));
    const [input] = requestInputs(env, run.id);
    expect(input).toContainEqual(plainSummaryOf(env));
    expect(input?.some((item) => (item as { type: string }).type === 'compaction')).toBe(false);
    expect(env.ofType(run.id, 'model.requested').map((event) => event.step)).toEqual([stepBefore + 1]);
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.fold(run.id).summary).toEqual({ item: plainSummaryOf(env), summary: SUMMARY_TEXT, replacedThroughSeq: 2 });
  });

  it('uses the recorded plain summary after a restart that follows the event, and no site fires again', async () => {
    const { env, run } = await prepare(SUMMARY_TEXT, [{ type: 'context.compaction_rejected', item: PLAIN_SUMMARY }]);
    env.gateway.script.push(textStep('Done.'));

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(rejections(env, run.id)).toHaveLength(1);
    expect(env.gateway.countCalls.some((call) => hasCompaction(call.request.input))).toBe(false);
    expect(requestInputs(env, run.id)[0]).toContainEqual(PLAIN_SUMMARY);
    expect(env.run(run.id).status).toBe('COMPLETED');
  });

  it('fails the run with compaction_unverifiable when the recorded summary text is empty', async () => {
    const { env, run } = await prepare('');
    env.gateway.script.push(textStep('never sent'));

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(env.run(run.id)).toMatchObject({ status: 'FAILED', error: { code: 'compaction_unverifiable' } });
    expect(rejections(env, run.id)).toEqual([]);
    expect(env.gateway.streams).toEqual([]);
  });

  it('treats a rejection of the plain summary as an ordinary failure', async () => {
    const { env, run } = await prepare(SUMMARY_TEXT, [{ type: 'context.compaction_rejected', item: PLAIN_SUMMARY }]);
    env.gateway.countHook = async () => {
      throw invalidCompaction();
    };
    env.gateway.script.push(textStep('never sent'));

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(env.run(run.id)).toMatchObject({ status: 'FAILED', error: { code: 'invalid_compaction' } });
    expect(rejections(env, run.id)).toHaveLength(1);
    expect(env.gateway.streams).toEqual([]);
  });

  it('rethrows an unrelated 400 unchanged', async () => {
    const { env, run } = await prepare();
    env.gateway.countHook = async () => {
      throw new GatewayRequestError({ status: 400, type: 'invalid_request', code: 'invalid_request', message: 'the request is malformed' });
    };
    env.gateway.script.push(textStep('never sent'));

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(env.run(run.id)).toMatchObject({ status: 'FAILED', error: { code: 'invalid_request', message: 'the request is malformed' } });
    expect(env.events(run.id).some((event) => (event.type as string) === 'context.compaction_rejected')).toBe(false);
  });
});

describe('compaction item rejected by compact (site 2)', () => {
  const seedCompactedConversation = async (contextWindow: number, sizes: { second: number; fifth?: number }) => {
    const env = await makeEnv({ capabilities: capabilitiesFor(contextWindow) });
    const run = await env.enqueue('question one');
    const payloads = conversation(sizes);
    await env.seed(run.id, [payloads[0]!, payloads[1]!, compacted(SUMMARY_TEXT, 2), ...payloads.slice(2)], 'release');
    let rejectedOnce = false;
    let countsBeforeFirstCompact: CountTokensResult[] | undefined;
    env.gateway.compactHook = async (request) => {
      countsBeforeFirstCompact ??= [...env.gateway.countResults];
      if (hasCompaction(request.input)) {
        rejectedOnce = true;
        throw invalidCompaction();
      }
    };
    return { env, run, rejected: () => rejectedOnce, countsBeforeFirstCompact: () => countsBeforeFirstCompact ?? [] };
  };

  it('on the threshold path compacts again from the plain summary and keys each compaction by its own request', async () => {
    const { env, run, rejected } = await seedCompactedConversation(40_000, { second: 110_000 });
    env.gateway.script.push(textStep('Done.'));

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(rejected()).toBe(true);
    const [rejection, ...more] = rejections(env, run.id);
    expect(more).toEqual([]);
    expect(rejection).toMatchObject({ item: plainSummaryOf(env) });
    expect(rejection).not.toHaveProperty('attempt');
    expect(env.gateway.compacts).toHaveLength(2);
    const [first, second] = env.gateway.compacts;
    expect(firstInputOf(first)).toMatchObject({ type: 'compaction' });
    expect(firstInputOf(second)).toEqual(plainSummaryOf(env));
    expect(first?.idempotencyKey).toBe(compactKey(run.id, first?.request));
    expect(second?.idempotencyKey).toBe(compactKey(run.id, second?.request));
    expect(firstSeq(env, run.id, 'context.compaction_rejected')).toBeLessThan(env.ofType(run.id, 'context.compacted').at(-1)!.seq);
    expect(env.ofType(run.id, 'context.compacted').at(-1)?.item.type).toBe('compaction');
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(requestInputs(env, run.id)).toHaveLength(1);
  });

  it('after an overflow retries the forced compaction at the same level from the plain summary and completes', async () => {
    const capabilities = capabilitiesFor(40_000);
    const { env, run, rejected, countsBeforeFirstCompact } = await seedCompactedConversation(40_000, { second: 110_000, fifth: 36_000 });
    env.gateway.script.push(textStep('Done.'));

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(rejected()).toBe(true);
    expect(countsBeforeFirstCompact().some((count) => count.input_tokens > budgetFor(capabilities, count.error_bound).I)).toBe(true);
    expect(rejections(env, run.id)).toHaveLength(1);
    expect(env.ofType(run.id, 'notice').map((event) => event.message).filter((message) => /^recent (turns|steps)/.test(message))).toEqual([]);
    expect(env.gateway.compacts).toHaveLength(2);
    expect(env.gateway.compacts[1]?.request.input).toHaveLength((env.gateway.compacts[0]?.request.input as unknown[]).length);
    expect(env.gateway.compacts.map((compact) => compact.idempotencyKey)).toEqual(env.gateway.compacts.map((compact) => compactKey(run.id, compact.request)));
    expect(firstInputOf(env.gateway.compacts[1])).toEqual(plainSummaryOf(env));
    expect(env.run(run.id).stopReason).toBeUndefined();
    expect(env.run(run.id).status).toBe('COMPLETED');
  });
});

describe('compaction item rejected by the model stream after recovery (site 3)', () => {
  const recordedBody = {
    model: 'fm',
    input: [COMPACTION_ITEM, { type: 'message', role: 'user', content: 'question two' }],
    store: false,
    stream: true,
  };

  const prepare = async (limits: Record<string, unknown> = {}) => {
    const env = await makeEnv();
    const run = await env.enqueue('question one', { limits });
    await env.seed(
      run.id,
      [
        responded(1, 'answer one'),
        { type: 'user.message', text: 'question two' },
        compacted(SUMMARY_TEXT, 2),
        { type: 'model.requested', step: 2, attempt: 1, digest: bodyDigest(recordedBody), body: recordedBody },
      ],
      'crash',
    );
    const rejectedStream: ScriptStep = { events: [], error: invalidCompaction() };
    env.gateway.script.push(rejectedStream);
    return { env, run };
  };

  it('records the rejection with step and attempt, clears the in-flight request and completes with a new request', async () => {
    const { env, run } = await prepare();
    env.gateway.script.push(textStep('Done.'));

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(env.gateway.streams[0]?.body).toEqual(recordedBody);
    const [rejection, ...more] = rejections(env, run.id);
    expect(more).toEqual([]);
    expect(rejection).toMatchObject({ step: 2, attempt: 1, item: plainSummaryOf(env) });
    const requests = env.ofType(run.id, 'model.requested');
    expect(requests.map((event) => event.step)).toEqual([2, 3]);
    expect(requests[1]!.seq).toBeGreaterThan(rejection!.seq);
    const input = (requests[1]!.body as { input: unknown[] }).input;
    expect(input).toContainEqual(plainSummaryOf(env));
    expect(input.some((item) => (item as { type: string }).type === 'compaction')).toBe(false);
    const state = env.fold(run.id);
    expect(state.steps[2]).toBeUndefined();
    expect(state.inFlightModelRequest).toBeUndefined();
    expect(env.run(run.id).status).toBe('COMPLETED');
  });

  it('counts the abandoned step toward maxSteps', async () => {
    const { env, run } = await prepare({ maxSteps: 2 });
    env.gateway.script.push(textStep('Summary of progress.'));

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(rejections(env, run.id)).toHaveLength(1);
    const requests = env.ofType(run.id, 'model.requested');
    expect(requests.map((event) => event.step)).toEqual([2, 3]);
    expect((requests[1]!.body as { tool_choice: string }).tool_choice).toBe('none');
    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'max_steps' });
  });
});

describe('a compaction sent to a role model with a smaller window than the session model', () => {
  const session = capabilitiesFor(200_000);
  const role = capabilitiesFor(32_000, { maxOutputTokens: 1024 });
  const largestSummary = Math.min(summaryTokenCapFor(role), role.maxOutputTokens);

  const refusal = (code: string, message: string): GatewayRequestError => new GatewayRequestError({ status: 400, type: 'invalid_request', code, message });

  const conversationOverTheRoleWindow = async () => {
    const env = await makeEnv({ capabilities: session });
    env.gateway.roles = { compaction: 'cheap' };
    env.gateway.capabilitiesByModel['cheap'] = role;
    const run = await env.enqueue('question one');
    await env.seed(run.id, conversation({ second: 60_000, third: 660_000 }), 'release');
    env.gateway.compactHook = async (request) => {
      const cap = request.momonga?.max_summary_tokens ?? largestSummary;
      if (cap > largestSummary) throw refusal('invalid_summary_cap', 'the summary cap exceeds the largest summary the model accepts');
      const transcript = (request.input as InputItem[]).reduce((sum, item) => sum + tokensForText(JSON.stringify(item)), 0);
      if (transcript + SUMMARY_PROMPT_TOKENS > summaryInputLimitFor(role, cap, 0)) throw refusal('compaction_input_too_large', 'the conversation to summarise does not fit the context window of any target');
    };
    env.gateway.script.push(textStep('Done.'));
    return { env, run };
  };

  it('plans the summary cap and the region for the role model, so the gateway refuses nothing and the model writes the summary', async () => {
    const { env, run } = await conversationOverTheRoleWindow();

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(env.ofType(run.id, 'notice').filter((notice) => notice.code === 'compaction_failed').map((notice) => notice.message)).toEqual([]);
    expect(env.gateway.compacts).toHaveLength(1);
    expect(env.gateway.compacts[0]?.request.model).toBe('cheap');
    expect(env.gateway.compacts[0]?.request.momonga?.max_summary_tokens).toBeLessThanOrEqual(largestSummary);
    expect(env.ofType(run.id, 'context.compacted').map((event) => event.source)).toEqual(['model']);
    expect(env.run(run.id).status).toBe('COMPLETED');
  });

  it('asks the gateway for the capabilities of the role model once in the claim', async () => {
    const { env } = await conversationOverTheRoleWindow();

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(env.gateway.capabilitiesCalls.filter((call) => call.model === 'cheap')).toHaveLength(1);
  });
});
