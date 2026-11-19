import { describe, expect, it } from 'vitest';
import { STREAM_IDLE_HEADER } from '@momonga/protocol';
import { planAdmissionReply, planErrorEventReply, planErrorStreamReply, planFailedWithoutErrorReply, planReasoningReply, openResponsesTextReply, openResponsesToolCallReply, withoutOutputIndex } from '@momonga/testkit';
import type { FakeUpstreamReply } from '@momonga/testkit';
import { parseOpenResponsesEvent } from '../src/adapters/open-responses/events.ts';
import { UNSTATED_FAILURE_MESSAGE } from '../src/adapters/shared/failures.ts';
import { nestedErrorDetail } from '../src/adapters/shared/http-error.ts';
import { postJson, readSse, userInput } from './gateway-helpers.ts';
import { RESOLVED_ACCOUNT, fakeAuth, startPlan } from './plan-auth-support.ts';

const USAGE_SENTENCE = 'This account has reached the usage its plan allows for now. Wait for the usage to reset, or manage the usage in the ChatGPT settings.';

const streamFrames = async (reply: FakeUpstreamReply) => {
  const plan = await startPlan(fakeAuth(), () => true, [reply]);
  return readSse(await postJson(plan.client, '/v1/responses', { model: 'scripted/plan-model', input: userInput('hi'), stream: true }, { [STREAM_IDLE_HEADER]: '60000' }));
};

const terminalError = async (reply: FakeUpstreamReply) => {
  const frames = await streamFrames(reply);
  const last = frames.at(-1)?.data;
  if (last?.type === 'response.failed') return last.response.error;
  if (last?.type === 'error') return last.error;
  throw new Error(`the stream ended with ${JSON.stringify(last)}`);
};

describe('a stream error without a message or without an error object is classified by its code', () => {
  it('reads response.failed whose error has a code and no message, and classifies it by the profile rule', () => {
    const event = parseOpenResponsesEvent(JSON.stringify({ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }));
    expect(event).toEqual({ type: 'terminal', terminal: { status: 'failed', code: 'subscription_sharing_usage_limit_exceeded', message: undefined, errorType: 'server_error' } });
  });

  it.each([{ error: null }, {}])('reads response.failed whose response carries %j as a failure with no stated code or reason', (members) => {
    const event = parseOpenResponsesEvent(JSON.stringify({ type: 'response.failed', response: members }));
    expect(event).toEqual({ type: 'terminal', terminal: { status: 'failed', code: undefined, message: undefined, errorType: 'server_error' } });
  });

  it('reads an error event in the nested shape and in the shape of the public reference, with or without a message', () => {
    expect(parseOpenResponsesEvent(JSON.stringify({ type: 'error', error: { code: 'subscription_sharing_usage_limit_exceeded' } }))).toEqual({ type: 'error', code: 'subscription_sharing_usage_limit_exceeded', message: undefined, errorType: 'server_error' });
    expect(parseOpenResponsesEvent(JSON.stringify({ type: 'error', code: 'server_is_overloaded', message: 'busy', param: null, sequence_number: 3 }))).toEqual({ type: 'error', code: 'server_is_overloaded', message: 'busy', errorType: 'server_error' });
    expect(parseOpenResponsesEvent(JSON.stringify({ type: 'error', code: null, param: null }))).toEqual({ type: 'error', code: undefined, message: undefined, errorType: 'server_error' });
  });

  it('still refuses a message or a code of the wrong type', () => {
    expect(() => parseOpenResponsesEvent(JSON.stringify({ type: 'response.failed', response: { error: { code: 7 } } }))).toThrow(/malformed event/);
    expect(() => parseOpenResponsesEvent(JSON.stringify({ type: 'error', error: { code: 'x', message: { text: 'y' } } }))).toThrow(/malformed event/);
  });

  it('answers the default usage-limit reply of the fake, which has no message, with the rule sentence', async () => {
    expect(await terminalError(planErrorStreamReply('subscription_sharing_usage_limit_exceeded'))).toEqual({ code: 'plan_usage_limit', message: USAGE_SENTENCE, type: 'too_many_requests', plan: RESOLVED_ACCOUNT });
  });

  it.each(['nested', 'top_level'] as const)('answers an error event in the %s shape with no message by its rule', async (shape) => {
    const error = await terminalError(planErrorEventReply('subscription_sharing_usage_limit_exceeded', { shape }));
    expect(error).toMatchObject({ code: 'plan_usage_limit', message: USAGE_SENTENCE });
  });

  it.each([null, 'absent'] as const)('answers a response.failed whose error is %s with the product sentence for a failure with no stated reason', async (error) => {
    expect(await terminalError(planFailedWithoutErrorReply(error))).toMatchObject({ message: UNSTATED_FAILURE_MESSAGE });
  });

  it('answers an unmatched error event with no message with the product sentence', async () => {
    expect(await terminalError(planErrorEventReply('some_new_code', { shape: 'top_level' }))).toMatchObject({ code: 'some_new_code', message: UNSTATED_FAILURE_MESSAGE });
  });
});

describe('an event without output_index is correlated by its item id', () => {
  it('decodes an item event and a delta event that give only the item id', () => {
    expect(parseOpenResponsesEvent(JSON.stringify({ type: 'response.output_item.added', item: { type: 'message', id: 'msg_1', content: [] } }))).toMatchObject({ type: 'item_added', at: { itemId: 'msg_1' } });
    expect(parseOpenResponsesEvent(JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg_1', delta: 'x' }))).toMatchObject({ type: 'text_delta', at: { itemId: 'msg_1' }, delta: 'x' });
  });

  it('refuses an event that names its item neither way, and a present output_index that is not a non-negative integer', () => {
    expect(() => parseOpenResponsesEvent(JSON.stringify({ type: 'response.output_text.delta', delta: 'x' }))).toThrow(/neither output_index nor an item id/);
    expect(() => parseOpenResponsesEvent(JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: -1, delta: 'x' }))).toThrow(/output_index must be a non-negative integer/);
  });

  it('streams a text reply whose events carry no output_index', async () => {
    const frames = await streamFrames(withoutOutputIndex(openResponsesTextReply(['Hel', 'lo'])));
    const last = frames.at(-1)?.data;
    expect(last?.type).toBe('response.completed');
    expect(frames.filter((frame) => frame.data.type === 'response.output_text.delta').map((frame) => frame.data.delta).join('')).toBe('Hello');
  });

  it('streams a tool call and reasoning whose events carry no output_index', async () => {
    const call = await streamFrames(withoutOutputIndex(openResponsesToolCallReply('call_1', 'read_file', ['{"path":', '"a"}'])));
    expect(call.at(-1)?.data.response.output).toEqual([expect.objectContaining({ type: 'function_call', name: 'read_file', arguments: '{"path":"a"}' })]);
    const reasoning = await streamFrames(withoutOutputIndex(planReasoningReply({ summary: ['Plan '], content: ['Think ', 'twice.'], text: ['Done.'] })));
    expect(reasoning.at(-1)?.data.response.output.map((item: { type: string }) => item.type)).toEqual(['reasoning', 'message']);
  });
});

describe('every public reasoning delta name feeds the live reasoning text', () => {
  it.each([
    ['response.reasoning_text.delta', 'content_index', 'reasoning_delta'],
    ['response.reasoning.delta', 'content_index', 'reasoning_delta'],
    ['response.reasoning_summary_text.delta', 'summary_index', 'reasoning_summary_delta'],
  ])('decodes %s', (type, indexKey, decoded) => {
    expect(parseOpenResponsesEvent(JSON.stringify({ type, item_id: 'rs_1', output_index: 0, [indexKey]: 0, delta: 'x' }))).toMatchObject({ type: decoded, delta: 'x' });
  });

  it('ignores reasoning_summary_part events, which carry no text', () => {
    expect(parseOpenResponsesEvent(JSON.stringify({ type: 'response.reasoning_summary_part.added', item_id: 'rs_1', output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } }))).toEqual({ type: 'ignored' });
  });

  it('streams the reasoning text and summary of the plan fake live, before the item is done, and does not repeat them at its end', async () => {
    const frames = await streamFrames(planReasoningReply({ summary: ['Plan ', 'first.'], content: ['Think ', 'twice.'], text: ['Done.'] }));
    const types = frames.map((frame) => frame.data.type);
    const reasoningDeltas = frames.filter((frame) => frame.data.type === 'response.reasoning.delta').map((frame) => frame.data.delta);
    const summaryDeltas = frames.filter((frame) => frame.data.type === 'response.reasoning_summary_text.delta').map((frame) => frame.data.delta);
    expect(reasoningDeltas).toEqual(['Think ', 'twice.']);
    expect(summaryDeltas).toEqual(['Plan ', 'first.']);
    expect(types.indexOf('response.reasoning.delta')).toBeLessThan(types.indexOf('response.output_item.done'));
    const reasoning = frames.at(-1)?.data.response.output[0];
    expect(reasoning).toMatchObject({ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'Think twice.' }], summary: [{ type: 'summary_text', text: 'Plan first.' }] });
  });
});

describe('an admission failure in the {"detail": "..."} shape', () => {
  it('reads a top-level detail string as the upstream message, and still prefers an error object', () => {
    expect(nestedErrorDetail({ detail: 'Direct routing is not enabled' })).toEqual({ message: 'Direct routing is not enabled' });
    expect(nestedErrorDetail({ detail: { loc: ['body'] } })).toEqual({});
    expect(nestedErrorDetail({ error: { message: 'm', code: 'c' }, detail: 'd' })).toEqual({ message: 'm', code: 'c' });
  });

  it('records the detail text on a plan admission failure that no rule names', async () => {
    const plan = await startPlan(fakeAuth(), () => true, [{ ...planAdmissionReply(403, 'denied by policy'), status: 451 } as FakeUpstreamReply]);
    const answer = await plan.post();
    expect(answer.body.error.message).toContain('denied by policy');
    expect(answer.body.error.message).not.toContain('{');
  });
});
