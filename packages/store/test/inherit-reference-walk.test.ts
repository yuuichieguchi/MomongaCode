import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { JOURNAL_SCAN_RANGE_ROWS } from '@momonga/store';
import { mustRun, rawDb } from './helpers.ts';
import { answeredRun, chainBuilder, FLOOR_TOKENS, referenceHarness, withReader } from './support/reference.ts';
import type { ReferenceHarness } from './support/reference.ts';

vi.setConfig({ testTimeout: 300_000 });

const childOf = async (h: ReferenceHarness, b: ReturnType<typeof chainBuilder>) => {
  const child = b.createRun('the child task');
  expect(await b.inherit(b.claimNext(child.id), 'manual')).toEqual({ kind: 'inherited' });
  return child;
};

const read = (h: ReferenceHarness, runId: string, windowTokens: number, trace?: { stepped: number; hops: string[]; units: number; decodedSinceUnit: number; maxDecodedBetweenUnits: number }) =>
  withReader(
    h.dbPath,
    (reader) => reader.readInheritedWindow({ runId, windowTokens, floorTokens: FLOOR_TOKENS }),
    trace === undefined
      ? {}
      : {
          onRowsStepped: (rows: number) => {
            trace.stepped += rows;
          },
          onHop: (hopRunId: string) => {
            trace.hops.push(hopRunId);
          },
          onDecode: (rows: number) => {
            trace.decodedSinceUnit += rows;
          },
          unit: () => {
            trace.units += 1;
            trace.maxDecodedBetweenUnits = Math.max(trace.maxDecodedBetweenUnits, trace.decodedSinceUnit);
            trace.decodedSinceUnit = 0;
          },
        },
  );

const newTrace = () => ({ stepped: 0, hops: [] as string[], units: 0, decodedSinceUnit: 0, maxDecodedBetweenUnits: 0 });

const serviceAppendCopyOfLastResponse = (h: ReferenceHarness, runId: string): void => {
  const db = rawDb(h.dbPath);
  const columns = (db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).map((column) => column.name).filter((name) => name !== 'id');
  const lastSeq = mustRun(h.store, runId).lastSeq;
  const selected = columns.map((name) => (name === 'seq' ? ':seq' : name === 'payload_json' ? "json_set(payload_json, '$.response.output[0].content[0].text', 'appended later')" : name)).join(', ');
  db.prepare(`INSERT INTO events (${columns.join(', ')}) SELECT ${selected} FROM events WHERE run_id = :runId AND type = 'model.responded' ORDER BY seq DESC LIMIT 1`).run({ runId, seq: lastSeq + 1 });
  db.prepare('UPDATE runs SET last_seq = last_seq + 1 WHERE id = ?').run(runId);
};

describe('R3: the window is a pure function of the reference and the records at or below fromLastSeq', () => {
  it('two reads are equal, and an append to the source after the commit changes nothing', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    const source = await answeredRun(h, b, 'Say hello', (claim) => {
      b.text(claim);
      b.tool(claim, { evict: true });
      b.text(claim);
    }, { fresh: true });
    const child = await childOf(h, b);
    const first = read(h, child.id, 1_000_000);
    expect(read(h, child.id, 1_000_000)).toEqual(first);
    expect(first.entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5]);

    serviceAppendCopyOfLastResponse(h, source.id);
    expect(mustRun(h.store, source.id).lastSeq).toBe(source.lastSeq + 1);

    const after = read(h, child.id, 1_000_000);
    expect(after.entries).toEqual(first.entries);
    expect(after.summary).toEqual(first.summary);
    expect(after.evicted).toEqual(first.evicted);
    expect(JSON.stringify(after)).not.toContain('appended later');
  });
});

describe('R4: the records read never change', () => {
  const storeSources = (): string[] => {
    const dir = path.resolve(import.meta.dirname, '..', 'src');
    return fs.readdirSync(dir).filter((name) => name.endsWith('.ts')).map((name) => path.join(dir, name));
  };

  it('no statement of the store deletes from events, runs or sessions', () => {
    const offending = storeSources().flatMap((file) => fs.readFileSync(file, 'utf8').split('\n').filter((line) => /DELETE\s+FROM\s+(events|runs|sessions)\b/i.test(line)).map((line) => `${path.basename(file)}: ${line.trim()}`));
    expect(offending).toEqual([]);
  });

  it('the only UPDATEs of events are the migration backfill and the repair of empty derived columns (H7, 11.5), which never write payload_json', () => {
    const updates = storeSources().flatMap((file) => fs.readFileSync(file, 'utf8').split('\n').filter((line) => /UPDATE\s+events\b/i.test(line)).map((line) => ({ file: path.basename(file), line: line.trim().replace(/^(?:\w+:\s*db\.prepare\()?['"`]?/, '') })));
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.filter((update) => update.file !== 'schema.ts' && update.file !== 'derived-repair.ts')).toEqual([]);
    expect(updates.filter((update) => /payload_json\s*=/.test(update.line.replace(/^UPDATE\s+events\s+SET\s+/i, '')))).toEqual([]);
    expect(updates.map((update) => update.line.match(/^UPDATE\s+events\s+SET\s+(\w+)/i)?.[1]).filter((column) => column !== undefined && !['call_id', 'approval_id', 'tool_name', 'notice_code', 'model_call_json', 'pinned_digest'].includes(column))).toEqual([]);
  });

  it('the events table refuses UPDATE and DELETE by trigger', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    const source = await answeredRun(h, b, 'Say hello', (claim) => b.text(claim), { fresh: true });
    const db = rawDb(h.dbPath);
    expect(() => db.prepare("UPDATE events SET payload_json = '{}' WHERE run_id = ?").run(source.id)).toThrow();
    expect(() => db.prepare('DELETE FROM events WHERE run_id = ?').run(source.id)).toThrow();
  });
});

describe('R7: the walk hops and rows are bounded', () => {
  it('reads a large source newest first and stops at the window: at most one range of K rows and one hop', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    const source = await answeredRun(h, b, 'big source', (claim) => {
      for (let step = 0; step < 1600; step += 1) b.text(claim, 8);
    }, { fresh: true });
    expect(source.lastSeq).toBeGreaterThan(3 * JOURNAL_SCAN_RANGE_ROWS);
    const child = await childOf(h, b);
    const trace = newTrace();

    const window = read(h, child.id, 5, trace);

    expect(window.omittedOlder).toBe(true);
    expect(window.entries.length).toBeGreaterThan(0);
    expect(window.entries.length).toBeLessThanOrEqual(6);
    expect(window.entries.at(-1)?.seq).toBe(1601);
    expect(trace.hops).toEqual([source.id]);
    expect(trace.stepped).toBeGreaterThan(0);
    expect(trace.stepped).toBeLessThanOrEqual(JOURNAL_SCAN_RANGE_ROWS + mustRun(h.store, child.id).lastSeq);
    expect(trace.maxDecodedBetweenUnits).toBeLessThanOrEqual(1);
  });

  it('with no compaction and a small window, hops are at most W and rows stepped at most the rows of the runs hopped', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    const runs = [await answeredRun(h, b, 'run 0', (claim) => b.text(claim), { fresh: true })];
    for (let index = 1; index < 30; index += 1) runs.push(await answeredRun(h, b, `run ${index}`, (claim) => b.text(claim)));
    const child = await childOf(h, b);
    const windowTokens = 3;
    const trace = newTrace();

    const window = read(h, child.id, windowTokens, trace);

    expect(window.omittedOlder).toBe(true);
    expect(trace.hops.length).toBeGreaterThan(0);
    expect(trace.hops.length).toBeLessThanOrEqual(windowTokens);
    expect(new Set(trace.hops).size).toBe(trace.hops.length);
    expect(trace.hops[0]).toBe(runs.at(-1)?.id);
    const lastSeqs = new Map(runs.map((run) => [run.id, mustRun(h.store, run.id).lastSeq]));
    const own = mustRun(h.store, child.id).lastSeq;
    const bound = trace.hops.reduce((sum, runId) => sum + Math.ceil((lastSeqs.get(runId) ?? 0) / JOURNAL_SCAN_RANGE_ROWS) * JOURNAL_SCAN_RANGE_ROWS, 0);
    expect(trace.stepped).toBeLessThanOrEqual(bound + own);
    expect(trace.stepped).toBeLessThanOrEqual(trace.hops.reduce((sum, runId) => sum + (lastSeqs.get(runId) ?? 0), 0) + own);
  });

  it('with an unbounded window the walk visits every run of the chain once, newest first', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    const runs = [await answeredRun(h, b, 'run 0', (claim) => b.text(claim), { fresh: true })];
    for (let index = 1; index < 12; index += 1) runs.push(await answeredRun(h, b, `run ${index}`, (claim) => b.text(claim)));
    const child = await childOf(h, b);
    const trace = newTrace();

    const window = read(h, child.id, 1_000_000, trace);

    expect(window.omittedOlder).toBe(false);
    expect(window.entries).toHaveLength(2 * 12);
    expect(trace.hops).toEqual(runs.map((run) => run.id).reverse());
  });

  it('stops at the compaction floor: runs wholly below replacedThroughSeq are not hopped', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    const runs = [await answeredRun(h, b, 'run 0', (claim) => b.text(claim), { fresh: true })];
    for (let index = 1; index < 6; index += 1) runs.push(await answeredRun(h, b, `run ${index}`, (claim) => b.text(claim)));
    runs.push(await answeredRun(h, b, 'run 6', (claim) => {
      b.text(claim);
      b.compact(claim, 10);
      b.text(claim);
    }));
    const child = await childOf(h, b);
    const trace = newTrace();

    const window = read(h, child.id, 1_000_000, trace);

    expect(window.summary?.replacedThroughSeq).toBe(10);
    expect(window.entries.map((entry) => entry.seq)).toEqual([11, 12, 13, 14, 15]);
    expect(trace.hops).toEqual([runs[6]?.id, runs[5]?.id]);
  });
});
