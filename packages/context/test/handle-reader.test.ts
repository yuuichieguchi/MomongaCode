import { describe, expect, it } from 'vitest';
import { HANDLE_READER_TOOL, PinnedOverflowError, buildContext } from '@momonga/context';
import type { FunctionTool } from '@momonga/protocol';
import { call, capabilitiesFor, harness, inputFor, output, sourcesWith } from './helpers.ts';

const toolNamed = (name: string, descriptionChars: number): FunctionTool => ({
  type: 'function',
  name,
  description: 'x'.repeat(descriptionChars),
  parameters: { type: 'object', properties: {} },
});

const READER = toolNamed(HANDLE_READER_TOOL, 800);
const TOOLS = [...['A', 'B', 'C', 'D', 'E', 'F'].map((name) => toolNamed(name, 800)), READER];
const SMALL_WINDOW = 1_536;

const builtWith = async (history: ReturnType<typeof call>[], options: { evicted?: string[]; contextWindow?: number } = {}) => {
  const capabilities = capabilitiesFor(options.contextWindow ?? SMALL_WINDOW, { maxOutputTokens: 1024 });
  const { ports } = harness(capabilities);
  return buildContext(inputFor(capabilities, { sources: sourcesWith({ tools: TOOLS, history }), evicted: new Set(options.evicted ?? []) }), ports);
};

const namesOf = (tools: readonly FunctionTool[]): string[] => tools.map((tool) => tool.name);

describe('the tool that reads omitted and truncated content', () => {
  it('names itself ReadOutput, the tool the markers send the model to', () => {
    expect(HANDLE_READER_TOOL).toBe('ReadOutput');
  });

  it('is dropped with the rest when the window is small and the context holds no tool output', async () => {
    const built = await builtWith([]);
    expect(namesOf(built.tools)).not.toContain(HANDLE_READER_TOOL);
    expect(built.notices.map((notice) => notice.code)).toContain('tools_dropped');
  });

  it('stays offered at a small window while the history holds an output with a handle', async () => {
    const built = await builtWith([call(1, 'c1'), output(2, 'c1', 'ok', 'abc123')]);
    expect(namesOf(built.tools)).toContain(HANDLE_READER_TOOL);
    expect(built.tools.length).toBeLessThan(TOOLS.length);
  });

  it('stays offered at a small window while the history holds a tool output the build may evict', async () => {
    const built = await builtWith([call(1, 'c1'), output(2, 'c1', 'ok')]);
    expect(namesOf(built.tools)).toContain(HANDLE_READER_TOOL);
  });

  it('stays offered at a small window when a call was evicted in an earlier step', async () => {
    const built = await builtWith([call(1, 'c1'), output(2, 'c1', 'ok', 'abc123')], { evicted: ['c1'] });
    expect(namesOf(built.tools)).toContain(HANDLE_READER_TOOL);
  });

  it('keeps the other tools in their declared order around it', async () => {
    const built = await builtWith([call(1, 'c1'), output(2, 'c1', 'ok', 'abc123')]);
    const others = namesOf(built.tools).filter((name) => name !== HANDLE_READER_TOOL);
    expect(others).toEqual(['A', 'B', 'C', 'D', 'E', 'F'].slice(0, others.length));
    expect(namesOf(built.tools).at(-1)).toBe(HANDLE_READER_TOOL);
  });

  it('is part of the floor, so a window that cannot hold it still overflows instead of offering nothing', async () => {
    const capabilities = capabilitiesFor(SMALL_WINDOW, { maxOutputTokens: 1024 });
    const { ports } = harness(capabilities);
    const heavy = toolNamed(HANDLE_READER_TOOL, 40_000);
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
