import { describe, expect, it } from 'vitest';
import { CC_CAPABILITIES, collect, lastCompletionBody, makeAdapter, readFileTool, startFake, userText } from './cc-support.ts';

const withTools = { model: 'system', input: [userText('hi')], tools: [readFileTool] };

describe('chat-completions parallel_tool_calls', () => {
  it('sends parallel_tool_calls false when the target declares that parallel calls are not supported', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const adapter = makeAdapter(fake, { capabilities: async () => ({ ...CC_CAPABILITIES, parallelToolCalls: false }) });
    await collect(adapter, withTools);
    expect(lastCompletionBody(fake).parallel_tool_calls).toBe(false);
  });

  it('does not send parallel_tool_calls when the target supports parallel calls and the request does not forbid them', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    await collect(makeAdapter(fake), withTools);
    expect('parallel_tool_calls' in lastCompletionBody(fake)).toBe(false);
  });

  it('sends parallel_tool_calls false when the request forbids parallel calls on a target that supports them', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    await collect(makeAdapter(fake), { ...withTools, parallel_tool_calls: false });
    expect(lastCompletionBody(fake).parallel_tool_calls).toBe(false);
  });

  it('does not send parallel_tool_calls when the request has no tools', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const adapter = makeAdapter(fake, { capabilities: async () => ({ ...CC_CAPABILITIES, parallelToolCalls: false }) });
    await collect(adapter, { model: 'system', input: [userText('hi')] });
    expect('parallel_tool_calls' in lastCompletionBody(fake)).toBe(false);
  });

  it('does not send parallel_tool_calls in constrained mode, where tools travel inside response_format', async () => {
    const fake = await startFake({ scenario: 'json-schema-only' });
    const adapter = makeAdapter(fake, {
      toolCalling: () => 'constrained',
      capabilities: async () => ({ ...CC_CAPABILITIES, parallelToolCalls: false }),
    });
    await collect(adapter, withTools);
    expect('parallel_tool_calls' in lastCompletionBody(fake)).toBe(false);
  });
});
