import { describe, expect, it } from 'vitest';
import { buildContext } from '@momonga/context';
import type { ContextSources } from '@momonga/context';
import type { CompactionInputItem, FunctionTool } from '@momonga/protocol';
import { call, capabilitiesFor, harness, inputFor, output, sourcesWith, textOf } from './helpers.ts';

const toolNamed = (name: string, descriptionChars: number): FunctionTool => ({
  type: 'function',
  name,
  description: 'x'.repeat(descriptionChars),
  parameters: { type: 'object', properties: {} },
});

const SMALL_WINDOW = 1_536;
const SUMMARY = { item: { type: 'compaction', encrypted_content: 'enc' } as CompactionInputItem, replacedThroughSeq: 2 };
const OTHERS = ['A', 'B', 'C', 'D', 'E', 'F'].map((name) => toolNamed(name, 800));

type Readers = Readonly<Record<string, string>>;

const pointerFor = (readers: Readers): string =>
  readers['history_range'] === undefined ? 'replaced: seq 1-9 (recorded; no tool in this run reads it)' : `replaced: ${readers['history_range']} seqFrom: 1, seqTo: 9`;

const build = async (options: { tools: FunctionTool[]; readers: Readers; summary?: boolean; history?: ReturnType<typeof call>[]; contextWindow?: number }) => {
  const capabilities = capabilitiesFor(options.contextWindow ?? SMALL_WINDOW, { maxOutputTokens: 1024 });
  const seen: Readers[] = [];
  const sources = sourcesWith({
    tools: options.tools,
    history: options.history ?? [],
    readers: options.readers,
    ...(options.summary === false ? {} : { summary: SUMMARY }),
    workingState: (readers: Readers) => {
      seen.push(readers);
      return pointerFor(readers);
    },
  } as unknown as Partial<ContextSources>);
  const built = await buildContext(inputFor(capabilities, { sources }), harness(capabilities).ports);
  return { built, seen, names: built.tools.map((tool) => tool.name) };
};

const DECLARED = { output_handle: 'ReadOutput', history_range: 'HistoryRead' };

describe('the reader of a rendered pointer is in the floor', () => {
  it('keeps HistoryRead at a window that drops optional tools once a range was replaced', async () => {
    const { built, names } = await build({ tools: [...OTHERS, toolNamed('ReadOutput', 800), toolNamed('HistoryRead', 800)], readers: DECLARED });
    expect(names).toContain('HistoryRead');
    expect(built.notices.map((notice) => notice.code)).toContain('tools_dropped');
  });

  it('keeps the tool the declaration names, not a constant', async () => {
    const { names } = await build({ tools: [...OTHERS, toolNamed('Recall', 800)], readers: { history_range: 'Recall' } });
    expect(names).toContain('Recall');
  });

  it('does not require HistoryRead before any range was replaced', async () => {
    const { names } = await build({ tools: [...OTHERS, toolNamed('HistoryRead', 800)], readers: DECLARED, summary: false });
    expect(names).not.toContain('HistoryRead');
  });

  it('requires ReadOutput only while handles are present and no range was replaced', async () => {
    const { names } = await build({
      tools: [...OTHERS, toolNamed('ReadOutput', 800), toolNamed('HistoryRead', 800)],
      readers: DECLARED,
      summary: false,
      history: [call(1, 'c1'), output(2, 'c1', 'ok', 'abc123')],
    });
    expect(names).toContain('ReadOutput');
    expect(names).not.toContain('HistoryRead');
  });

  it('requires nothing for a kind with no reader offered', async () => {
    const { names } = await build({ tools: [...OTHERS], readers: { output_handle: 'ReadOutput' } });
    expect(names).not.toContain('HistoryRead');
    expect(names.length).toBeGreaterThan(0);
  });

  it('renders the working state with the readers of the built tool list', async () => {
    const kept = await build({ tools: [...OTHERS, toolNamed('HistoryRead', 800)], readers: DECLARED });
    expect(kept.seen.at(-1)?.['history_range']).toBe('HistoryRead');
    expect(kept.built.input.flatMap((item) => (item.type === 'message' ? [textOf(item.content as never)] : [])).join('\n')).toContain('replaced: HistoryRead seqFrom: 1, seqTo: 9');
    const absent = await build({ tools: [...OTHERS], readers: DECLARED });
    expect(absent.seen.at(-1)?.['history_range']).toBeUndefined();
  });
});
