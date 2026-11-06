import { describe, expect, it } from 'vitest';
import { MEMORY_SEARCH_RESULT_LIMIT, MEMORY_SEARCH_TOOL_NAME } from '@momonga/tools';
import { SIGNAL, newCounter, portFor, seededStore } from './recall-fixture.ts';

const searchWith = async (count: number) => {
  const seeded = seededStore(count, (index) => `the generated parser note ${index}`);
  const counter = newCounter();
  const set = await portFor(seeded.store, counter).load(seeded.session, SIGNAL);
  const loadCalls = counter.calls;
  const tool = set.tools.find((candidate) => candidate.name === MEMORY_SEARCH_TOOL_NAME);
  if (tool === undefined) throw new Error('MemorySearch is not offered');
  const before = seeded.store.memories.revision();
  const result = (await tool.execute({ query: 'parser' } as never, { signal: SIGNAL } as never, undefined)) as { status: string; output: string; memories?: string[] };
  return { seeded, counter, searchCalls: counter.calls - loadCalls, result, before };
};

describe('MemorySearch is bounded by its result limit', () => {
  it('MemorySearch checks at most the result limit plus one', async () => {
    const { searchCalls } = await searchWith(300);
    expect(searchCalls).toBeGreaterThan(0);
    expect(searchCalls).toBeLessThanOrEqual(MEMORY_SEARCH_RESULT_LIMIT + 1);
  });

  it('names the notes it returned in a structured memories field', async () => {
    const { result } = await searchWith(30);
    expect(result.status).toBe('completed');
    expect(result.memories).toHaveLength(MEMORY_SEARCH_RESULT_LIMIT);
    for (const id of result.memories ?? []) expect(result.output).toContain(id);
  });

  it('MemorySearch results do not stamp anything', async () => {
    const { seeded, result, before } = await searchWith(30);
    expect(result.memories?.length).toBeGreaterThan(0);
    expect(seeded.store.memories.revision()).toBe(before);
    expect(seeded.template.keptAt).toEqual(expect.any(Number));
    for (const id of result.memories ?? []) expect(seeded.store.memories.get(id)?.keptAt).toBe(seeded.template.keptAt);
  });
});
