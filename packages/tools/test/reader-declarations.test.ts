import { describe, expect, it } from 'vitest';
import { REFERENCE_KINDS } from '@momonga/protocol';
import { createBuiltinTools, createHistoryTools, createToolRegistry } from '@momonga/tools';
import type { AnyTool, HistoryStorePort } from '@momonga/tools';

const historyTools = (): AnyTool[] => createHistoryTools({ port: {} as HistoryStorePort, trusted: true, project: '/work/a' });

const declaredReads = (tool: AnyTool): string | undefined => (tool as AnyTool & { reads?: string }).reads;

const everyBuiltin = (): AnyTool[] => [...createBuiltinTools(), ...historyTools()];

describe('one reader per reference kind', () => {
  it('lists the two reference kinds', () => {
    expect([...REFERENCE_KINDS].sort()).toEqual(['history_range', 'output_handle']);
  });

  it('has exactly one declaring tool per kind in the built-in set', () => {
    for (const kind of REFERENCE_KINDS) {
      expect(everyBuiltin().filter((tool) => declaredReads(tool) === kind)).toHaveLength(1);
    }
  });

  it('has ReadOutput declare output_handle and HistoryRead declare history_range, and no other builtin declare one', () => {
    const declaring = Object.fromEntries(everyBuiltin().flatMap((tool) => (declaredReads(tool) === undefined ? [] : [[tool.name, declaredReads(tool)]])));
    expect(declaring).toEqual({ ReadOutput: 'output_handle', HistoryRead: 'history_range' });
  });

  it('answers readerOf from the declarations of the snapshot', async () => {
    const registry = createToolRegistry();
    for (const tool of everyBuiltin()) registry.register(tool);
    const set = (await registry.snapshot()) as Awaited<ReturnType<typeof registry.snapshot>> & { readerOf(kind: string): string | undefined };
    expect(set.readerOf('output_handle')).toBe('ReadOutput');
    expect(set.readerOf('history_range')).toBe('HistoryRead');
  });

  it('answers undefined for a kind whose reader is not in the set', async () => {
    const registry = createToolRegistry();
    for (const tool of createBuiltinTools()) registry.register(tool);
    const set = (await registry.snapshot()) as Awaited<ReturnType<typeof registry.snapshot>> & { readerOf(kind: string): string | undefined };
    expect(set.readerOf('history_range')).toBeUndefined();
  });
});
