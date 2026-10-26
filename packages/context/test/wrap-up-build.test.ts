import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { CountTokensRequest, InputItem, MessageInputItem } from '@momonga/protocol';
import { ContextOverflowError, PrefixChangedError, buildContext } from '@momonga/context';
import type { ContextSources } from '@momonga/context';
import {
  READ_TOOL,
  ROOT_AGENTS,
  SYSTEM_PROMPT,
  TASK,
  USER_AGENTS,
  call,
  capabilitiesFor,
  harness,
  inputFor,
  output,
  sourcesWith,
  tokensOfItems,
} from './helpers.ts';

const INSTRUCTION: MessageInputItem = {
  type: 'message',
  role: 'user',
  content: 'You have reached the max_steps limit. Summarize what you accomplished, what remains, and any state the user must know. Do not call tools.',
};

const WRAP_UP = { tools: 'none', trailing: [INSTRUCTION] } as const;

const OTHER_TOOL = { ...READ_TOOL, name: 'Read2', description: 'Read another way' };

const FILES = { [USER_AGENTS]: 'user rules', [ROOT_AGENTS]: 'root rules' };

const historySources = (overrides: Partial<ContextSources> = {}): ContextSources =>
  sourcesWith({ tools: [READ_TOOL], history: [call(1, 'call_a'), output(2, 'call_a', 'file contents')], ...overrides });

const lenientFlagOf = (request: CountTokensRequest): unknown =>
  (request as { momonga?: { lenient_items?: { with_tools?: unknown } } }).momonga?.lenient_items?.with_tools;

const pinnedItemsDigest = (items: readonly InputItem[]): string =>
  items.reduce((current, item) => sha256Hex(`${current}:${sha256Hex(canonicalJson(item))}`), sha256Hex(canonicalJson({ scope: 'pinned-items' })));

describe('wrap-up build mode (tools none, counted trailing user instruction)', () => {
  const capabilities = capabilitiesFor(200000);

  it('sends no tools and places the instruction after the retained history as the last input item', async () => {
    const { ports } = harness(capabilities);
    const sources = historySources();
    const built = await buildContext(inputFor(capabilities, { sources, ...WRAP_UP }), ports);

    expect(built.tools).toEqual([]);
    expect(built.input).toEqual([
      { type: 'message', role: 'system', content: SYSTEM_PROMPT },
      TASK,
      sources.history[0]?.item,
      sources.history[1]?.item,
      INSTRUCTION,
    ]);
  });

  it('counts the instruction inside the builder with no tools on the meter request', async () => {
    const { ports, counter } = harness(capabilities);
    const built = await buildContext(inputFor(capabilities, { sources: historySources(), ...WRAP_UP }), ports);

    expect(counter.calls.length).toBeGreaterThan(0);
    for (const request of counter.calls) expect(request.tools ?? []).toEqual([]);
    expect(built.inputTokens).toBe(tokensOfItems(built.input));
    const normal = await buildContext(inputFor(capabilities, { sources: historySources({ tools: [] }) }), harness(capabilities).ports);
    expect(built.inputTokens - normal.inputTokens).toBe(tokensOfItems([INSTRUCTION]));
  });

  it('counts tool history items as their plain-text rendering (with_tools false)', async () => {
    const { ports, counter } = harness(capabilities);
    await buildContext(inputFor(capabilities, { sources: historySources(), ...WRAP_UP }), ports);

    const itemCounts = counter.calls.filter((request) => lenientFlagOf(request) !== undefined);
    expect(itemCounts.length).toBeGreaterThan(0);
    for (const request of itemCounts) expect(lenientFlagOf(request)).toBe(false);
  });

  it('rejects a build whose context plus the instruction exceeds the input budget', async () => {
    const small = capabilitiesFor(2000);
    const longInstruction: MessageInputItem = { type: 'message', role: 'user', content: 'x'.repeat(8000) };

    const normal = await buildContext(inputFor(small, { sources: historySources() }), harness(small).ports);
    expect(normal.inputTokens).toBeLessThan(1460);

    const error = await buildContext(
      inputFor(small, { sources: historySources(), tools: 'none', trailing: [longInstruction] }),
      harness(small).ports,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContextOverflowError);
    expect((error as ContextOverflowError).inputBudget).toBe(1460);
    expect((error as ContextOverflowError).inputTokens).toBeGreaterThanOrEqual(2000);
  });
});

describe('pinned digest over the pinned items only (scope pinned-items)', () => {
  const capabilities = capabilitiesFor(200000);

  it('is the digest chain over the system message and the task with the pinned-items scope', async () => {
    const built = await buildContext(inputFor(capabilities, { sources: historySources() }), harness(capabilities).ports);

    expect(built.pinnedDigest).toBe(pinnedItemsDigest([{ type: 'message', role: 'system', content: SYSTEM_PROMPT }, TASK]));
  });

  it('is identical for a normal build, a build with another tool list and a wrap-up build', async () => {
    const normal = await buildContext(inputFor(capabilities, { sources: historySources() }), harness(capabilities, { files: FILES }).ports);
    const otherTools = await buildContext(
      inputFor(capabilities, { sources: historySources({ tools: [OTHER_TOOL] }) }),
      harness(capabilities, { files: FILES }).ports,
    );
    const wrapUp = await buildContext(inputFor(capabilities, { sources: historySources(), ...WRAP_UP }), harness(capabilities, { files: FILES }).ports);

    expect(otherTools.pinnedDigest).toBe(normal.pinnedDigest);
    expect(wrapUp.pinnedDigest).toBe(normal.pinnedDigest);
  });

  it('passes the comparison in a wrap-up build when only the tool list differs', async () => {
    const first = await buildContext(
      inputFor(capabilities, { sources: historySources({ tools: [OTHER_TOOL] }) }),
      harness(capabilities, { files: FILES }).ports,
    );

    const wrapUp = await buildContext(
      inputFor(capabilities, { sources: historySources(), ...WRAP_UP, expectedPinnedDigest: first.pinnedDigest }),
      harness(capabilities, { files: FILES }).ports,
    );

    expect(wrapUp.pinnedDigest).toBe(first.pinnedDigest);
  });

  it.for<[string, Partial<ContextSources>, Record<string, string>]>([
    ['system prompt', { systemPrompt: `${SYSTEM_PROMPT} v2` }, FILES],
    ['task', { task: { ...TASK, content: 'Another task.' } }, FILES],
    ['user AGENTS.md', {}, { ...FILES, [USER_AGENTS]: 'user rules v2' }],
    ['root AGENTS.md', {}, { ...FILES, [ROOT_AGENTS]: 'root rules v2' }],
  ])('throws PrefixChangedError in the wrap-up build when the %s changes', async ([, sourceOverrides, changedFiles]) => {
    const first = await buildContext(inputFor(capabilities, { sources: historySources() }), harness(capabilities, { files: FILES }).ports);

    const error = await buildContext(
      inputFor(capabilities, { sources: historySources(sourceOverrides), ...WRAP_UP, expectedPinnedDigest: first.pinnedDigest }),
      harness(capabilities, { files: changedFiles }).ports,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PrefixChangedError);
    expect((error as PrefixChangedError).expected).toBe(first.pinnedDigest);
    const changedWithOtherTools = await buildContext(
      inputFor(capabilities, { sources: historySources({ ...sourceOverrides, tools: [OTHER_TOOL] }) }),
      harness(capabilities, { files: changedFiles }).ports,
    );
    expect((error as PrefixChangedError).actual).toBe(changedWithOtherTools.pinnedDigest);
    expect((error as PrefixChangedError).actual).not.toBe(first.pinnedDigest);
  });
});

describe('prefix digest covers the prefix actually sent', () => {
  const capabilities = capabilitiesFor(200000);

  it('differs for a wrap-up build from the normal build of the same run and equals the digest of a build without tools', async () => {
    const normal = await buildContext(inputFor(capabilities, { sources: historySources() }), harness(capabilities, { files: FILES }).ports);
    const wrapUp = await buildContext(
      inputFor(capabilities, { sources: historySources(), ...WRAP_UP, expectedPinnedDigest: normal.pinnedDigest }),
      harness(capabilities, { files: FILES }).ports,
    );
    const withoutTools = await buildContext(inputFor(capabilities, { sources: historySources({ tools: [] }) }), harness(capabilities, { files: FILES }).ports);

    expect(wrapUp.prefixDigest).not.toBe(normal.prefixDigest);
    expect(wrapUp.prefixDigest).toBe(withoutTools.prefixDigest);
  });
});
