import { describe, expect, it } from 'vitest';
import { PinnedOverflowError, buildContext } from '@momonga/context';
import type { FunctionTool } from '@momonga/protocol';
import { call, capabilitiesFor, harness, inputFor, output, sourcesWith } from './helpers.ts';

const toolNamed = (name: string, descriptionChars: number): FunctionTool => ({
  type: 'function',
  name,
  description: 'x'.repeat(descriptionChars),
  parameters: { type: 'object', properties: {} },
});

const READER_NAME = 'ReadOutput';
const READER = toolNamed(READER_NAME, 800);
const TOOLS = [...['A', 'B', 'C', 'D', 'E', 'F'].map((name) => toolNamed(name, 800)), READER];
const SMALL_WINDOW = 1_536;

const builtWith = async (history: ReturnType<typeof call>[], options: { evicted?: string[]; contextWindow?: number } = {}) => {
  const capabilities = capabilitiesFor(options.contextWindow ?? SMALL_WINDOW, { maxOutputTokens: 1024 });
  const { ports } = harness(capabilities);
  return buildContext(inputFor(capabilities, { sources: sourcesWith({ tools: TOOLS, history }), evicted: new Set(options.evicted ?? []) }), ports);
};

const namesOf = (tools: readonly FunctionTool[]): string[] => tools.map((tool) => tool.name);

describe('the tool that reads omitted and truncated content', () => {
  it('is the tool the output_handle declaration names, and the markers send the model to it', async () => {
    const evicted = await builtWith([call(1, 'c1'), output(2, 'c1', 'ok', 'abc123')], { evicted: ['c1'] });
    expect(JSON.stringify(evicted.input)).toContain('read it with ReadOutput]');
    const renamed = toolNamed('Recall', 800);
    const capabilities = capabilitiesFor(SMALL_WINDOW, { maxOutputTokens: 1024 });
    const built = await buildContext(
      inputFor(capabilities, {
        sources: sourcesWith({ tools: [renamed], history: [call(1, 'c1'), output(2, 'c1', 'ok', 'abc123')], readers: { output_handle: 'Recall' } }),
        evicted: new Set(['c1']),
      }),
      harness(capabilities).ports,
    );
    expect(JSON.stringify(built.input)).toContain('read it with Recall]');
    expect(JSON.stringify(built.input)).not.toContain('ReadOutput');
  });

  it('is named by no marker when no tool offers to read the handles', async () => {
    const capabilities = capabilitiesFor(SMALL_WINDOW, { maxOutputTokens: 1024 });
    const built = await buildContext(
      inputFor(capabilities, { sources: sourcesWith({ tools: [], history: [call(1, 'c1'), output(2, 'c1', 'ok', 'abc123')], readers: {} }), evicted: new Set(['c1']) }),
      harness(capabilities).ports,
    );
    expect(JSON.stringify(built.input)).not.toContain('read it with');
    expect(JSON.stringify(built.input)).toContain('stored as');
  });

  it('is dropped with the rest when the window is small and the context holds no tool output', async () => {
    const built = await builtWith([]);
    expect(namesOf(built.tools)).not.toContain(READER_NAME);
    expect(built.notices.map((notice) => notice.code)).toContain('tools_dropped');
  });

  it('stays offered at a small window while the history holds an output with a handle', async () => {
    const built = await builtWith([call(1, 'c1'), output(2, 'c1', 'ok', 'abc123')]);
    expect(namesOf(built.tools)).toContain(READER_NAME);
    expect(built.tools.length).toBeLessThan(TOOLS.length);
  });

  it('stays offered at a small window while the history holds a tool output the build may evict', async () => {
    const built = await builtWith([call(1, 'c1'), output(2, 'c1', 'ok')]);
    expect(namesOf(built.tools)).toContain(READER_NAME);
  });

  it('stays offered at a small window when a call was evicted in an earlier step', async () => {
    const built = await builtWith([call(1, 'c1'), output(2, 'c1', 'ok', 'abc123')], { evicted: ['c1'] });
    expect(namesOf(built.tools)).toContain(READER_NAME);
  });

  it('keeps the other tools in their declared order around it', async () => {
    const built = await builtWith([call(1, 'c1'), output(2, 'c1', 'ok', 'abc123')]);
    const others = namesOf(built.tools).filter((name) => name !== READER_NAME);
    expect(others).toEqual(['A', 'B', 'C', 'D', 'E', 'F'].slice(0, others.length));
    expect(namesOf(built.tools).at(-1)).toBe(READER_NAME);
  });

  it('is part of the floor, so a window that cannot hold it still overflows instead of offering nothing', async () => {
    const capabilities = capabilitiesFor(SMALL_WINDOW, { maxOutputTokens: 1024 });
    const { ports } = harness(capabilities);
    const heavy = toolNamed(READER_NAME, 40_000);
    const attempt = buildContext(
      inputFor(capabilities, { sources: sourcesWith({ tools: [heavy], history: [call(1, 'c1'), output(2, 'c1', 'ok', 'abc123')] }) }),
      ports,
    );
    await expect(attempt).rejects.toBeInstanceOf(PinnedOverflowError);
  });

  it('is offered at a large window with every other tool, as before', async () => {
    const built = await builtWith([call(1, 'c1'), output(2, 'c1', 'ok', 'abc123')], { contextWindow: 128_000 });
    expect(built.tools).toEqual(TOOLS);
  });
});
