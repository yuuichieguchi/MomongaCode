import { TEST_FENCE } from '@momonga/testkit';
import { EVERY_REASONING_IS_OWN, contextOf } from './own-reasoning.ts';
import { describe, expect, it } from 'vitest';
import { wireOf } from '@momonga/gateway';
import type { AdapterCompactRequest, ToolCallingMode } from '@momonga/protocol';
import { TARGET, lastCompletionBody, startFake, userText } from './cc-support.ts';
import { ccAdapterFor, textReply } from './cc-compact-support.ts';

const request: AdapterCompactRequest = {
  model: 'system',
  instructions: 'You are a coding agent.',
  input: [
    userText('Fix <the> bug'),
    { type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{"path":"a.ts"}' },
    { type: 'function_call_output', call_id: 'c1', output: 'x < y' },
  ],
};

describe('renderCompactWire', () => {
  it.for([
    ['native', 64],
    ['constrained', 100],
    ['none', 246],
  ] as const)('equals the wire compact sends for a %s target with cap %i', async ([mode, cap]: readonly [ToolCallingMode, number]) => {
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply('note')] });
    const adapter = ccAdapterFor(fake, mode);
    expect(adapter.renderCompactWire).toBeTypeOf('function');
    await adapter.compact?.(
      { ...request, momonga: { fence: TEST_FENCE, max_summary_tokens: cap } },
      await contextOf(adapter, TARGET),
    );
    expect(JSON.stringify(adapter.renderCompactWire?.({ ...request, momonga: { fence: TEST_FENCE, max_summary_tokens: cap } }, TARGET, cap, EVERY_REASONING_IS_OWN, await adapter.capabilities(TARGET)))).toBe(JSON.stringify(wireOf(lastCompletionBody(fake))));
  });
});
