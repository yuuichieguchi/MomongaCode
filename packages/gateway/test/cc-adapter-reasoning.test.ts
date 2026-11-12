import { TEST_FENCE } from '@momonga/testkit';
import { contextOf } from './own-reasoning.ts';
import { describe, expect, it } from 'vitest';
import type { AdapterCompactRequest, Capabilities, ReasoningCapability } from '@momonga/protocol';
import { CC_CAPABILITIES, TARGET, collect, lastCompletionBody, makeAdapter, startFake, userText } from './cc-support.ts';
import { textReply } from './cc-compact-support.ts';

const withReasoning = (reasoning: ReasoningCapability | undefined): Capabilities => ({
  ...CC_CAPABILITIES,
  ...(reasoning === undefined ? {} : { reasoning }),
});

const artefactRequest = { model: 'system', input: [userText('summarise')], max_output_tokens: 100, reasoning_effort: 'none' as const };

describe('chat-completions reasoning control', () => {
  it('sends reasoning_effort at the lowest level the target accepts, lifting a requested level that is below it', async () => {
    const fake = await startFake({ scenario: 'none' });
    const adapter = makeAdapter(fake, { capabilities: async () => withReasoning({ control: 'reasoning_effort', lowest: 'low' }) });
    await collect(adapter, artefactRequest);
    expect(lastCompletionBody(fake).reasoning_effort).toBe('low');
  });

  it('sends the requested level when the target accepts it', async () => {
    const fake = await startFake({ scenario: 'none' });
    const adapter = makeAdapter(fake, { capabilities: async () => withReasoning({ control: 'reasoning_effort', lowest: 'none' }) });
    await collect(adapter, artefactRequest);
    expect(lastCompletionBody(fake).reasoning_effort).toBe('none');
  });

  it('leaves room in the output cap for the measured reasoning of a target that cannot control it, without sending a setting', async () => {
    const fake = await startFake({ scenario: 'none' });
    const adapter = makeAdapter(fake, { capabilities: async () => withReasoning({ control: 'none', headroomTokens: 300 }) });
    await collect(adapter, artefactRequest);
    const body = lastCompletionBody(fake);
    expect('reasoning_effort' in body).toBe(false);
    expect(body.max_completion_tokens).toBe(400);
  });

  it('never lifts the output cap above the output limit of the target', async () => {
    const fake = await startFake({ scenario: 'none' });
    const adapter = makeAdapter(fake, { capabilities: async () => withReasoning({ control: 'none', headroomTokens: 5000 }) });
    await collect(adapter, artefactRequest);
    expect(lastCompletionBody(fake).max_completion_tokens).toBe(CC_CAPABILITIES.maxOutputTokens);
  });

  it('keeps the cap as asked when no reasoning was measured', async () => {
    const fake = await startFake({ scenario: 'none' });
    await collect(makeAdapter(fake), artefactRequest);
    const body = lastCompletionBody(fake);
    expect('reasoning_effort' in body).toBe(false);
    expect(body.max_completion_tokens).toBe(100);
  });

  it('changes nothing for a request that did not ask for low reasoning', async () => {
    const fake = await startFake({ scenario: 'none' });
    const adapter = makeAdapter(fake, { capabilities: async () => withReasoning({ control: 'reasoning_effort', lowest: 'low' }) });
    await collect(adapter, { model: 'system', input: [userText('hi')], max_output_tokens: 100 });
    const body = lastCompletionBody(fake);
    expect('reasoning_effort' in body).toBe(false);
    expect(body.max_completion_tokens).toBe(100);
  });
});

const compactRequest: AdapterCompactRequest = { model: 'system', input: [userText('a long conversation')], momonga: { fence: TEST_FENCE, max_summary_tokens: 64 } };

describe('chat-completions compaction summary and reasoning', () => {
  it('asks for the lowest reasoning effort the target accepts and keeps the summary cap as the visible limit', async () => {
    const fake = await startFake({ scenario: 'none', script: [textReply('GOAL: fix it. STATE: none.')] });
    const adapter = makeAdapter(fake, { capabilities: async () => withReasoning({ control: 'reasoning_effort', lowest: 'minimal' }) });
    await adapter.compact?.(compactRequest, await contextOf(adapter, TARGET));
    const body = lastCompletionBody(fake);
    expect(body.reasoning_effort).toBe('minimal');
    expect(body.max_completion_tokens).toBe(64);
  });

  it('leaves room for reasoning in the request cap of a target that cannot control it, and accepts a short visible summary whose reasoning exceeded the cap', async () => {
    const fake = await startFake({
      scenario: 'none',
      script: [textReply('GOAL: fix it. STATE: none.', { prompt_tokens: 300, completion_tokens: 380, total_tokens: 680, completion_tokens_details: { reasoning_tokens: 360 } })],
    });
    const adapter = makeAdapter(fake, { capabilities: async () => withReasoning({ control: 'none', headroomTokens: 400 }) });
    const result = await adapter.compact?.(compactRequest, await contextOf(adapter, TARGET));
    expect(lastCompletionBody(fake).max_completion_tokens).toBe(464);
    expect(result?.summary).toBe('GOAL: fix it. STATE: none.');
    expect(result?.usage.output_tokens_details.reasoning_tokens).toBe(360);
  });

  it('rejects a visible summary longer than the accepted summary size however much room the request cap has', async () => {
    const long = Array.from({ length: 400 }, () => 'word').join(' ');
    const fake = await startFake({ scenario: 'none', script: [textReply(long)] });
    const adapter = makeAdapter(fake, { capabilities: async () => withReasoning({ control: 'none', headroomTokens: 400 }) });
    await expect(adapter.compact?.(compactRequest, await contextOf(adapter, TARGET))).rejects.toMatchObject({ code: 'compaction_summary_too_long' });
  });
});
