import { describe, expect, it } from 'vitest';
import type { GoverningFactView } from '@momonga/protocol';
import { createGoverningActivation, createInstructionProbes } from '../../src/worker/touched-paths.ts';
import type { TouchedCursor, TouchedEntry, TouchedSource } from '../../src/worker/touched-paths.ts';

const PROJECT = '/work/a';

const SIZES = [10, 100, 1000, 10000] as const;

const PAGE_ROWS = 50;

const pathAt = (index: number): string => `${PROJECT}/dir-${index}/file-${index}.ts`;

const sourceOf = (entries: TouchedEntry[]): { source: TouchedSource; rowsRead: () => number; reads: () => number; reset: () => void } => {
  let rows = 0;
  let calls = 0;
  const source: TouchedSource = async (after: TouchedCursor | null, limit: number) => {
    calls += 1;
    const found = entries.filter((entry) => after === null || entry.firstEventId > after.eventId || (entry.firstEventId === after.eventId && entry.path > after.path)).slice(0, limit);
    rows += found.length;
    return found;
  };
  return {
    source,
    rowsRead: () => rows,
    reads: () => calls,
    reset: () => {
      rows = 0;
      calls = 0;
    },
  };
};

const entriesOf = (count: number): TouchedEntry[] => Array.from({ length: count }, (_unused, index) => ({ path: pathAt(index), firstEventId: index + 1 }));

const fact = (id: string, paths: string[]): GoverningFactView => ({
  id,
  kind: 'constraint',
  target: id,
  text: id,
  scope: { level: 'project', project: PROJECT, paths },
  validFrom: 0,
  validUntil: null,
  retiredAt: null,
  supersedes: [],
  enforcement: null,
  source: { kind: 'command', at: 0 },
});

const countingReader = () => {
  const probed: string[] = [];
  return {
    probed,
    reader: {
      contains: async () => true,
      read: async () => undefined,
      exists: async (target: string) => {
        probed.push(target);
        return target === `${PROJECT}/dir-3/AGENTS.md`;
      },
      realpath: async (target: string) => target,
    },
  };
};

describe('a build after one new path does the same main-thread work however many paths were touched', () => {
  it('reads the same rows and probes the same directories at 10, 100, 1000 and 10000 touched paths', async () => {
    const measured: { rows: number; reads: number; probes: number }[] = [];
    for (const size of SIZES) {
      const entries = entriesOf(size);
      const governingSource = sourceOf(entries);
      const probeSource = sourceOf(entries);
      const counting = countingReader();
      const governing = createGoverningActivation({ project: PROJECT, source: governingSource.source, pageRows: PAGE_ROWS });
      const probes = createInstructionProbes({ reader: counting.reader, projectRoot: PROJECT, source: probeSource.source, pageRows: PAGE_ROWS });
      const facts = [fact('f1', ['never/**'])];
      await governing.advance(facts, 1);
      await probes.advance();
      entries.push({ path: `${PROJECT}/fresh/new.ts`, firstEventId: size + 1 });
      governingSource.reset();
      probeSource.reset();
      counting.probed.length = 0;
      await governing.advance(facts, 1);
      await probes.advance();
      measured.push({ rows: governingSource.rowsRead() + probeSource.rowsRead(), reads: governingSource.reads() + probeSource.reads(), probes: counting.probed.length });
    }
    expect(new Set(measured.map((entry) => JSON.stringify(entry))).size).toBe(1);
    expect(measured[0]?.rows).toBe(2);
    expect(measured[0]?.probes).toBeGreaterThan(0);
  });

  it('reads the whole record once, in pages, when a claim starts', async () => {
    const entries = entriesOf(1000);
    const governingSource = sourceOf(entries);
    const governing = createGoverningActivation({ project: PROJECT, source: governingSource.source, pageRows: PAGE_ROWS });
    await governing.advance([fact('f1', ['dir-999/**'])], 1);
    expect(governingSource.rowsRead()).toBe(1000);
    expect(governingSource.reads()).toBe(1000 / PAGE_ROWS + 1);
    expect(governing.witnesses()).toEqual([pathAt(999)]);
  });
});

describe('a directory is probed once per claim', () => {
  it('asks whether AGENTS.md exists once for each directory above the touched paths, however many builds follow', async () => {
    const entries = entriesOf(20);
    const counting = countingReader();
    const probes = createInstructionProbes({ reader: counting.reader, projectRoot: PROJECT, source: sourceOf(entries).source, pageRows: PAGE_ROWS });
    await probes.advance();
    const first = counting.probed.length;
    expect(first).toBeGreaterThan(0);
    await probes.advance();
    entries.push({ path: `${PROJECT}/dir-3/another.ts`, firstEventId: 21 });
    await probes.advance();
    expect(new Set(counting.probed).size).toBe(counting.probed.length);
    expect(counting.probed.slice(first)).toEqual([`${PROJECT}/dir-3/another.ts/AGENTS.md`]);
    expect(probes.witnesses()).toEqual([{ path: `${PROJECT}/dir-3`, kind: 'directory' }]);
  });
});

describe('no path is read when no live fact has paths', () => {
  it('reads nothing for facts without paths, retired facts and facts of another project', async () => {
    const entries = entriesOf(100);
    const counting = sourceOf(entries);
    const governing = createGoverningActivation({ project: PROJECT, source: counting.source, pageRows: PAGE_ROWS });
    const everywhere: GoverningFactView = { ...fact('all', []), scope: { level: 'project', project: PROJECT, paths: [] } };
    const retired: GoverningFactView = { ...fact('retired', ['dir-1/**']), retiredAt: 1 };
    const elsewhere: GoverningFactView = { ...fact('elsewhere', ['dir-1/**']), scope: { level: 'project', project: '/work/b', paths: ['dir-1/**'] } };
    await governing.advance([everywhere, retired, elsewhere], 5);
    expect(counting.reads()).toBe(0);
    expect(governing.witnesses()).toEqual([]);
  });

  it('activates a fact added mid-session against the paths touched earlier, and keeps it active', async () => {
    const entries = entriesOf(100);
    const counting = sourceOf(entries);
    const governing = createGoverningActivation({ project: PROJECT, source: counting.source, pageRows: PAGE_ROWS });
    await governing.advance([], 1);
    expect(counting.reads()).toBe(0);
    const later = fact('later', ['dir-7/**']);
    await governing.advance([later], 1);
    expect(governing.witnesses()).toEqual([pathAt(7)]);
    counting.reset();
    await governing.advance([later], 1);
    expect(counting.reads()).toBe(0);
  });
});
