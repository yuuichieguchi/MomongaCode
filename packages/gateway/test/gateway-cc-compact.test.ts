import { describe, expect, it } from 'vitest';
import { fenceBoundaryIn, waitFor } from '@momonga/testkit';
import type { CountTokensResult } from '@momonga/protocol';
import { FAKE_GUARDRAIL_ERROR } from '@momonga/testkit';
import type { FakeScriptedReply } from '@momonga/testkit';
import { expectErrorBody, getJson, postJson, readJson, readSse, userInput, validator } from './gateway-helpers.ts';
import type { Harness } from './gateway-helpers.ts';
import { CC_CAPABILITIES, completionBodies, makeAdapter, startFake, userText, MODEL_FRAMING } from './cc-support.ts';
import {
  KEEP_CLAUSE,
  RESTATE_CLAUSE,
  callReply,
  ccAdapterFor,
  ccModelOf,
  emptyReply,
  instructionsFor,
  lengthReply,
  serverErrorReply,
  startCcGateway,
  summaryOfResource,
  textReply,
} from './cc-compact-support.ts';

const SUMMARY = 'The user wants the parser fixed; src/parse.ts was read.';

const conversation = [
  userText('Fix the parser bug'),
  { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{"path":"src/parse.ts"}' },
  { type: 'function_call_output', call_id: 'c1', output: 'export const parse = 1;' },
];

const compact = async (harness: Harness, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  readJson(await postJson(harness.client, '/v1/responses/compact', { model: harness.model, input: conversation, ...body }, headers));

const breakerOf = async (harness: Harness, target: string): Promise<string> =>
  (await getJson(harness.client, '/v1/momonga/health')).body.models[ccModelOf(target)].breaker as string;

describe('POST /v1/responses/compact for a chat-completions target', () => {
  it('summarises through the upstream and returns a signed compaction item', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply(SUMMARY)] });
    const harness = await startCcGateway({ fm: ccAdapterFor(fake) });
    const response = await compact(harness, {});
    expect(response.status).toBe(200);
    expect(validator.validate('CompactResource', response.body).errors).toEqual([]);
    expect(summaryOfResource(response.body)).toBe(SUMMARY);
    expect(response.body.usage).toMatchObject({ input_tokens: 300, output_tokens: 12, total_tokens: 312 });
    expect(completionBodies(fake)).toHaveLength(1);
  });

  it('sends the decoded summary to the upstream on the next /v1/responses', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply('Earlier <work> done.')] });
    const harness = await startCcGateway({ fm: ccAdapterFor(fake) });
    const response = await compact(harness, {});
    expect(response.status).toBe(200);
    const item = response.body.output.find((entry: { type: string }) => entry.type === 'compaction');
    await readSse(
      await postJson(harness.client, '/v1/responses', {
        model: 'fm/system',
        stream: true,
        input: [{ type: 'compaction', encrypted_content: item.encrypted_content }, ...userInput('continue')],
      }),
    );
    const followUp = completionBodies(fake).at(-1);
    expect(followUp.messages[0]).toEqual({
      role: 'user',
      content: `<conversation_summary>\n${MODEL_FRAMING}\nEarlier &lt;work> done.\n</conversation_summary>\n\ncontinue`,
    });
    expect(JSON.stringify(followUp)).not.toContain(item.encrypted_content);
  });

  it('passes momonga.max_summary_tokens to the upstream as max_completion_tokens and into the instructions', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply(SUMMARY)] });
    const harness = await startCcGateway({ fm: ccAdapterFor(fake) });
    expect((await compact(harness, { momonga: { max_summary_tokens: 100 } })).status).toBe(200);
    const body = completionBodies(fake)[0];
    expect(body.max_completion_tokens).toBe(100);
    expect(body.messages[0]).toEqual({ role: 'system', content: instructionsFor(100, RESTATE_CLAUSE, fenceBoundaryIn(body.messages[1].content)) });
  });

  it.for([
    ['absent', {}, RESTATE_CLAUSE],
    ['true', { momonga: { retains_user_request: true } }, KEEP_CLAUSE],
  ] as const)('chooses the restate clause from retains_user_request %s', async ([, extra, clause]) => {
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply(SUMMARY)] });
    const harness = await startCcGateway({ fm: ccAdapterFor(fake) });
    expect((await compact(harness, extra)).status).toBe(200);
    expect(completionBodies(fake)[0].messages[0].content).toContain(clause);
  });

  it('serves a managed constrained target with the same tool-less request', async () => {
    const fake = await startFake({ scenario: 'json-schema-only', script: [textReply(SUMMARY)] });
    const harness = await startCcGateway({ fm: ccAdapterFor(fake, 'constrained') });
    expect((await compact(harness, {})).status).toBe(200);
    const body = completionBodies(fake)[0];
    expect('response_format' in body).toBe(false);
    expect('tools' in body).toBe(false);
  });
});

describe('momonga request validation on /v1/responses/compact', () => {
  it.for([
    ['a non-integer cap', { max_summary_tokens: 'many' }],
    ['a fractional cap', { max_summary_tokens: 64.5 }],
    ['a cap below MIN_SUMMARY_TOKENS', { max_summary_tokens: 63 }],
    ['a non-boolean retains_user_request', { retains_user_request: 'yes' }],
    ['an unknown key', { max_summary_token: 64 }],
  ] as const)('rejects %s as 400 invalid_request before any upstream call', async ([, momonga]) => {
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply(SUMMARY)] });
    const harness = await startCcGateway({ fm: ccAdapterFor(fake) });
    const response = await compact(harness, { momonga });
    expect(response.status).toBe(400);
    expect(response.body.error.type).toBe('invalid_request');
    expect(String(response.body.error.param)).toMatch(/^momonga/);
    expect(completionBodies(fake)).toHaveLength(0);
  });

  it('rejects a non-object momonga', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply(SUMMARY)] });
    const harness = await startCcGateway({ fm: ccAdapterFor(fake) });
    const response = await compact(harness, { momonga: 64 });
    expect(response.status).toBe(400);
    expect(response.body.error.param).toBe('momonga');
  });

  it('accepts the product minimum', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply(SUMMARY)] });
    const harness = await startCcGateway({ fm: ccAdapterFor(fake) });
    expect((await compact(harness, { momonga: { max_summary_tokens: 64 } })).status).toBe(200);
    expect(completionBodies(fake)[0].max_completion_tokens).toBe(64);
  });

  it('rejects a cap above every candidate maximum with param momonga.max_summary_tokens', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply(SUMMARY)] });
    const harness = await startCcGateway({ fm: ccAdapterFor(fake) });
    const response = await compact(harness, { momonga: { max_summary_tokens: 247 } });
    expect(response.status).toBe(400);
    expectErrorBody(response.body, { type: 'invalid_request', code: response.body.error.code, param: 'momonga.max_summary_tokens' });
    expect(completionBodies(fake)).toHaveLength(0);
  });

  it('drops a candidate whose maximum is below the cap and uses the next one', async () => {
    const small = await startFake({ scenario: 'tools-ok', script: [textReply('from small')] });
    const large = await startFake({ scenario: 'tools-ok', script: [textReply('from large')] });
    const harness = await startCcGateway({
      small: ccAdapterFor(small, 'native', { contextWindow: 1024 }),
      large: ccAdapterFor(large, 'native', { contextWindow: 4096 }),
    });
    const response = await compact(harness, { momonga: { max_summary_tokens: 200 } });
    expect(response.status).toBe(200);
    expect(summaryOfResource(response.body)).toBe('from large');
    expect(completionBodies(small)).toHaveLength(0);
    expect(completionBodies(large)[0].max_completion_tokens).toBe(200);
  });
});

describe('the summary request must fit the target', () => {
  it('rejects an input whose built request is too large as compaction_input_too_large before any upstream call', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply(SUMMARY)] });
    const harness = await startCcGateway({ fm: ccAdapterFor(fake) });
    const response = await compact(harness, {
      input: [userText('look'), { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: '<'.repeat(9600) }],
      momonga: { max_summary_tokens: 64 },
    });
    expect(response.status).toBe(400);
    expectErrorBody(response.body, { type: 'invalid_request', code: 'compaction_input_too_large', param: 'input' });
    expect(completionBodies(fake)).toHaveLength(0);
  });

  it('measures the text unchanged: markup of a length that fits is sent as it is', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply(SUMMARY)] });
    const harness = await startCcGateway({ fm: ccAdapterFor(fake) });
    const response = await compact(harness, {
      input: [userText('look'), { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: '<'.repeat(2400) }],
      momonga: { max_summary_tokens: 64 },
    });
    expect(response.status).toBe(200);
    expect(JSON.stringify(completionBodies(fake)[0])).toContain('<'.repeat(2400));
  });

  it('measures with the target counter when the target has one', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply(SUMMARY)] });
    const counted: unknown[] = [];
    const adapter = makeAdapter(fake, {
      capabilities: async () => ({ ...CC_CAPABILITIES, tokenCounting: 'calibrated' }),
      countTokens: async (_target, request): Promise<CountTokensResult> => {
        counted.push(request.input);
        return { input_tokens: 4000, method: 'calibrated', error_bound: 0, error_shape: { ratio: 0, minimum: 0 } };
      },
    });
    const harness = await startCcGateway({ fm: adapter });
    const response = await compact(harness, { momonga: { max_summary_tokens: 64 } });
    expect(response.status).toBe(400);
    expectErrorBody(response.body, { type: 'invalid_request', code: 'compaction_input_too_large', param: 'input' });
    expect(counted).toHaveLength(1);
    expect(String(counted[0])).toContain('<transcript>');
    expect(completionBodies(fake)).toHaveLength(0);
  });
});

describe('summary failures, retries, breaker and fallback', () => {
  it('retries a 500 and then succeeds with one stored result', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [serverErrorReply(), textReply(SUMMARY)] });
    const harness = await startCcGateway({ fm: ccAdapterFor(fake) }, { retry: { maxAttempts: 2, baseMs: 10, maxMs: 10 } });
    const pending = compact(harness, {}, { 'idempotency-key': 'retry-once' });
    await waitFor(() => completionBodies(fake).length === 1 && harness.timers.pending().length > 0, { description: 'retry backoff' });
    harness.timers.advance(harness.timers.pending().at(-1)?.delayMs ?? 0);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(summaryOfResource(response.body)).toBe(SUMMARY);
    const again = await compact(harness, {}, { 'idempotency-key': 'retry-once' });
    expect(again.body).toEqual(response.body);
    expect(completionBodies(fake)).toHaveLength(2);
  });

  it('classifies an upstream guardrail 400 without retrying', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [{ kind: 'error', status: 400, body: FAKE_GUARDRAIL_ERROR }] });
    const harness = await startCcGateway({ fm: ccAdapterFor(fake) }, { retry: { maxAttempts: 3 } });
    const response = await compact(harness, {});
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.body.error.code).toBe('guardrail_violation');
    expect(completionBodies(fake)).toHaveLength(1);
  });

  it.for([
    ['an empty reply', emptyReply],
    ['a reply with a call', callReply],
  ] as const)('answers compaction_invalid_reply after the attempts for %s', async ([, reply]) => {
    const fake = await startFake({ scenario: 'tools-ok', script: [reply()] });
    const harness = await startCcGateway({ fm: ccAdapterFor(fake) }, { retry: { maxAttempts: 1, totalWaitMs: 1 } });
    const response = await compact(harness, {});
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.body.error.code).toBe('compaction_invalid_reply');
    expect(completionBodies(fake)).toHaveLength(1);
  });

  it('falls back to the next candidate after an invalid reply', async () => {
    const first = await startFake({ scenario: 'tools-ok', script: [emptyReply()] });
    const second = await startFake({ scenario: 'tools-ok', script: [textReply('from second')] });
    const harness = await startCcGateway({ first: ccAdapterFor(first), second: ccAdapterFor(second) }, { retry: { maxAttempts: 1, totalWaitMs: 1 } });
    const response = await compact(harness, {});
    expect(response.status).toBe(200);
    expect(summaryOfResource(response.body)).toBe('from second');
  });

  it.for([
    ['finish_reason length', () => lengthReply('cut')],
    ['a reply above ceil(1.3 cap)', () => textReply('w'.repeat(4 * 84 + 4))],
  ] as const)('answers compaction_summary_too_long for %s without retry or fallback', async ([, reply]) => {
    const first = await startFake({ scenario: 'tools-ok', script: [reply(), reply(), reply()] });
    const second = await startFake({ scenario: 'tools-ok', script: [textReply('never')] });
    const harness = await startCcGateway({ first: ccAdapterFor(first), second: ccAdapterFor(second) }, { retry: { maxAttempts: 3 } });
    const response = await compact(harness, { momonga: { max_summary_tokens: 64 } });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.body.error.code).toBe('compaction_summary_too_long');
    expect(completionBodies(first)).toHaveLength(1);
    expect(completionBodies(second)).toHaveLength(0);
  });

  it.for([
    ['compaction_summary_too_long', () => lengthReply('cut')],
    ['compaction_invalid_reply', emptyReply],
  ] as const)('keeps the breaker closed after repeated %s failures', async ([code, reply]) => {
    const fake = await startFake({ scenario: 'tools-ok', script: [reply(), reply(), reply()] });
    const harness = await startCcGateway({ fm: ccAdapterFor(fake) }, { retry: { maxAttempts: 1, totalWaitMs: 1 }, breaker: { failureThreshold: 2, openMs: 30_000 } });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await compact(harness, { momonga: { max_summary_tokens: 64 } });
      expect(response.body.error.code).toBe(code);
    }
    expect(await breakerOf(harness, 'fm')).toBe('closed');
  });
});

describe('idempotency for chat-completions compaction', () => {
  it('makes one upstream call for the same key and body', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply(SUMMARY)] });
    const harness = await startCcGateway({ fm: ccAdapterFor(fake) });
    const first = await compact(harness, { momonga: { max_summary_tokens: 64 } }, { 'idempotency-key': 'same' });
    const second = await compact(harness, { momonga: { max_summary_tokens: 64 } }, { 'idempotency-key': 'same' });
    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(completionBodies(fake)).toHaveLength(1);
  });

  it.for([
    ['another cap', { momonga: { max_summary_tokens: 65 } }],
    ['another restate intent', { momonga: { max_summary_tokens: 64, retains_user_request: true } }],
  ] as const)('rejects the same key with %s as idempotency_key_reused', async ([, other]) => {
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply(SUMMARY), textReply(SUMMARY)] });
    const harness = await startCcGateway({ fm: ccAdapterFor(fake) });
    expect((await compact(harness, { momonga: { max_summary_tokens: 64 } }, { 'idempotency-key': 'k' })).status).toBe(200);
    const reused = await compact(harness, other, { 'idempotency-key': 'k' });
    expect(reused.status).toBe(422);
    expectErrorBody(reused.body, { type: 'invalid_request', code: 'idempotency_key_reused' });
    expect(completionBodies(fake)).toHaveLength(1);
  });
});

describe('stream-level failures of the summary call, classified by code', () => {
  const cutStream = (): FakeScriptedReply => ({ kind: 'stream', chunks: [{ delta: { role: 'assistant', content: 'partial' } }], done: false });
  const filtered = (): FakeScriptedReply => ({
    kind: 'stream',
    chunks: [{ delta: { role: 'assistant', content: 'part' } }, { delta: {}, finishReason: 'content_filter' }],
  });

  it('retries a protocol failure, falls back after maxAttempts and records one failure verdict for the request on the first target', async () => {
    const first = await startFake({ scenario: 'tools-ok', script: [cutStream(), cutStream()] });
    const second = await startFake({ scenario: 'tools-ok', script: [textReply('from second')] });
    const harness = await startCcGateway(
      { first: ccAdapterFor(first), second: ccAdapterFor(second) },
      { retry: { maxAttempts: 2, baseMs: 10, maxMs: 10 }, breaker: { failureThreshold: 1, openMs: 30_000 } },
    );
    const pending = compact(harness, { momonga: { max_summary_tokens: 64 } });
    await waitFor(() => completionBodies(first).length === 1 && harness.timers.pending().length > 0, { description: 'retry backoff' });
    harness.timers.advance(harness.timers.pending().at(-1)?.delayMs ?? 0);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(summaryOfResource(response.body)).toBe('from second');
    expect(completionBodies(first)).toHaveLength(2);
    expect(await breakerOf(harness, 'first')).toBe('open');
  });

  it('answers upstream_protocol_error after the attempts of a single target', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [cutStream()] });
    const harness = await startCcGateway({ fm: ccAdapterFor(fake) }, { retry: { maxAttempts: 1, totalWaitMs: 1 } });
    const response = await compact(harness, { momonga: { max_summary_tokens: 64 } });
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.body.error.code).toBe('upstream_protocol_error');
  });

  it('answers a content_filter outcome without retry or fallback and keeps the breaker closed', async () => {
    const first = await startFake({ scenario: 'tools-ok', script: [filtered(), filtered(), filtered()] });
    const second = await startFake({ scenario: 'tools-ok', script: [textReply('never')] });
    const harness = await startCcGateway(
      { first: ccAdapterFor(first), second: ccAdapterFor(second) },
      { retry: { maxAttempts: 3 }, breaker: { failureThreshold: 1, openMs: 30_000 } },
    );
    const response = await compact(harness, { momonga: { max_summary_tokens: 64 } });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.body.error.code).toBe('content_filter');
    expect(completionBodies(first)).toHaveLength(1);
    expect(completionBodies(second)).toHaveLength(0);
    expect(await breakerOf(harness, 'first')).toBe('closed');
  });
});
