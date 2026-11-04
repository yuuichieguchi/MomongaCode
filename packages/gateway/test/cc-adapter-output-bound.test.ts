import { describe, expect, it } from 'vitest';
import type { Capabilities } from '@momonga/protocol';
import { CC_CAPABILITIES, TARGET, collect, lastCompletionBody, makeAdapter, startFake, userText } from './cc-support.ts';

const declaring = (outputBoundField: Capabilities['outputBoundField'], extra: Partial<Capabilities> = {}): Capabilities =>
  ({ ...CC_CAPABILITIES, ...(outputBoundField === undefined ? {} : { outputBoundField }), ...extra }) as Capabilities;

const request = { model: TARGET.model, input: [userText('hello')], max_output_tokens: 300 };

describe('the chat-completions adapter sends the output bound in the field its capabilities name', () => {
  it('sends max_completion_tokens for a target whose field is not measured', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    await collect(makeAdapter(fake), request);
    const body = lastCompletionBody(fake);
    expect(body.max_completion_tokens).toBe(300);
    expect('max_tokens' in body).toBe(false);
  });

  it('sends max_tokens, and not max_completion_tokens, for a target that honours only max_tokens', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    await collect(makeAdapter(fake, { capabilities: async () => declaring('max_tokens') }), request);
    const body = lastCompletionBody(fake);
    expect(body.max_tokens).toBe(300);
    expect('max_completion_tokens' in body).toBe(false);
  });

  it('lifts the bound of a target that honours max_tokens by the measured reasoning headroom in that same field', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const capabilities = declaring('max_tokens', { reasoning: { control: 'none', headroomTokens: 100 } });
    await collect(makeAdapter(fake, { capabilities: async () => capabilities }), { ...request, reasoning_effort: 'none' });
    const body = lastCompletionBody(fake);
    expect(body.max_tokens).toBe(400);
    expect('max_completion_tokens' in body).toBe(false);
  });

  it('sends no bound when the request has none', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    await collect(makeAdapter(fake), { model: TARGET.model, input: [userText('hello')] });
    const body = lastCompletionBody(fake);
    expect('max_tokens' in body).toBe(false);
    expect('max_completion_tokens' in body).toBe(false);
  });
});
