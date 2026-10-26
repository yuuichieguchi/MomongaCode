import { describe, expect, it } from 'vitest';
import { PrefixChangedError, buildContext } from '@momonga/context';
import {
  READ_TOOL,
  SYSTEM_PROMPT,
  TASK,
  assistant,
  call,
  capabilitiesFor,
  harness,
  idsOf,
  inputFor,
  output,
  sourcesWith,
  textOf,
  user,
} from './helpers.ts';

const history = [
  user(1, 'first question'),
  call(2, 'c1'),
  output(3, 'c1', 'file contents'),
  assistant(4, 'answer one'),
  user(5, 'second question'),
];

describe('layer order', () => {
  it('places system prompt first, then task, then history in seq order', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities);
    const result = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ history, tools: [READ_TOOL] }) }),
      ports,
    );
    expect(result.input[0]).toMatchObject({ type: 'message', role: 'system' });
    const first = result.input[0];
    expect(first?.type === 'message' ? textOf(first.content) : undefined).toBe(SYSTEM_PROMPT);
    expect(result.input[1]).toMatchObject(TASK);
    expect(idsOf(result.input.slice(2))).toEqual(['h1', 'h2', 'h3', 'h4', 'h5']);
    expect(result.tools).toEqual([READ_TOOL]);
    expect(result.evictions).toEqual([]);
    expect(result.compaction).toBeUndefined();
    expect(result.prefixDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.inputDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps tools in the given order', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities);
    const tools = [{ ...READ_TOOL, name: 'Zeta' }, READ_TOOL, { ...READ_TOOL, name: 'Alpha' }];
    const result = await buildContext(inputFor(capabilities, { sources: sourcesWith({ tools }) }), ports);
    expect(result.tools.map((tool) => tool.name)).toEqual(['Zeta', 'Read', 'Alpha']);
  });
});

describe('determinism and stability', () => {
  it('produces identical input and prefixDigest for identical inputs', async () => {
    const capabilities = capabilitiesFor(200000);
    const first = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ history }) }),
      harness(capabilities).ports,
    );
    const second = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ history }) }),
      harness(capabilities).ports,
    );
    expect(second.input).toEqual(first.input);
    expect(second.prefixDigest).toBe(first.prefixDigest);
    expect(second.inputDigest).toBe(first.inputDigest);
  });

  it('changes only the tail when an item is appended', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities);
    const before = await buildContext(inputFor(capabilities, { sources: sourcesWith({ history }) }), ports);
    const after = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ history: [...history, call(6, 'c2')] }) }),
      ports,
    );
    expect(after.input.length).toBe(before.input.length + 1);
    expect(after.input.slice(0, before.input.length)).toEqual(before.input);
    expect(after.input.at(-1)).toMatchObject({ type: 'function_call', call_id: 'c2' });
    expect(after.prefixDigest).toBe(before.prefixDigest);
    expect(after.inputDigest).not.toBe(before.inputDigest);
  });

  it('changes prefixDigest when the system prompt changes', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities);
    const before = await buildContext(inputFor(capabilities), ports);
    const after = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ systemPrompt: `${SYSTEM_PROMPT} 2026-10-23T00:00:00Z` }) }),
      ports,
    );
    expect(after.prefixDigest).not.toBe(before.prefixDigest);
  });
});

describe('PrefixChangedError', () => {
  it('accepts an unchanged pinned layer when expectedPinnedDigest matches', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities);
    const sources = sourcesWith({ history, tools: [READ_TOOL] });
    const first = await buildContext(inputFor(capabilities, { sources }), ports);
    const second = await buildContext(
      inputFor(capabilities, {
        sources: sourcesWith({ history: [...history, assistant(6, 'more')], tools: [READ_TOOL] }),
        expectedPinnedDigest: first.pinnedDigest,
      }),
      ports,
    );
    expect(second.prefixDigest).toBe(first.prefixDigest);
  });

  it('throws when the system prompt changes within a run', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities);
    const first = await buildContext(inputFor(capabilities), ports);
    const error = await buildContext(
      inputFor(capabilities, {
        sources: sourcesWith({ systemPrompt: `${SYSTEM_PROMPT}!` }),
        expectedPinnedDigest: first.pinnedDigest,
      }),
      ports,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PrefixChangedError);
    expect((error as PrefixChangedError).expected).toBe(first.pinnedDigest);
    expect((error as PrefixChangedError).actual).not.toBe(first.pinnedDigest);
  });

  it('accepts a changed tool list within a run because the tool set is guarded by the pins', async () => {
    const capabilities = capabilitiesFor(200000);
    const { ports } = harness(capabilities);
    const first = await buildContext(inputFor(capabilities, { sources: sourcesWith({ tools: [READ_TOOL] }) }), ports);
    const second = await buildContext(
      inputFor(capabilities, {
        sources: sourcesWith({ tools: [{ ...READ_TOOL, description: 'Read a file quickly' }] }),
        expectedPinnedDigest: first.pinnedDigest,
      }),
      ports,
    );
    expect(second.pinnedDigest).toBe(first.pinnedDigest);
  });
});
