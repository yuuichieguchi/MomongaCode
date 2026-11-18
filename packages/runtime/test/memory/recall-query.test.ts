import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { MEMORY_QUERY_MAX_CHARS } from '@momonga/tools';
import { enqueue, harness, mustClaim, newSession } from '../../../store/test/helpers.ts';
import { recallQueryOf, termsOfQuery } from '../../src/memory/recall-query.ts';
import { MEMORY_PAGE_ROWS, RECALL_TOUCHED_ROWS } from '../../src/process/constants.ts';

const CWD = '/work/a';
const TASK = 'fix the build';

const moduleAt = (index: number): string => `${CWD}/src/module-${String(index).padStart(4, '0')}.ts`;

const readCall = (index: number): RunEventPayload => ({
  type: 'tool.call',
  callId: `c${index}`,
  providerCallId: `c${index}`,
  name: 'Read',
  kind: 'read',
  title: `Read ${index}`,
  rawInput: {},
  locations: [{ path: moduleAt(index) }],
});

const pathTermsOf = (query: string): string[] => termsOfQuery(query).filter((term) => !TASK.split(' ').includes(term));

describe('the recall query', () => {
  it('reads one page of the touched record', () => {
    expect(RECALL_TOUCHED_ROWS).toBe(MEMORY_PAGE_ROWS);
  });

  it('holds the newest whole paths when the bound is full and states how many were used', async () => {
    const { store } = harness();
    const session = newSession(store, CWD);
    await enqueue(store, session.id);
    const claim = mustClaim(store, 'w1');
    expect(store.append(claim, Array.from({ length: 1000 }, (_unused, index) => readCall(index))).kind).toBe('ok');
    const newest = (await store.sessionTouched.newest(session.id, RECALL_TOUCHED_ROWS)).map((entry) => entry.path);
    const recall = recallQueryOf(TASK, newest, CWD, RECALL_TOUCHED_ROWS);
    const terms = pathTermsOf(recall.query);
    const width = 'src/module-0000.ts'.length + 1;
    const fits = Math.floor((MEMORY_QUERY_MAX_CHARS + 1) / width);
    expect(terms).toEqual(Array.from({ length: fits }, (_unused, index) => `src/module-${String(999 - index).padStart(4, '0')}.ts`));
    expect(recall.touchedCap).toBe(fits);
  });

  it('never cuts a path', () => {
    const long = `${CWD}/${'d'.repeat(MEMORY_QUERY_MAX_CHARS - 'a.ts'.length - 'file.ts'.length)}/file.ts`;
    const recall = recallQueryOf(TASK, [`${CWD}/a.ts`, long, `${CWD}/b.ts`], CWD, RECALL_TOUCHED_ROWS);
    expect(pathTermsOf(recall.query)).toEqual(['a.ts']);
    expect(recall.touchedCap).toBe(1);
  });

  it('states the bound when the page came back full even though every read path fits', () => {
    const recall = recallQueryOf(TASK, [`${CWD}/a.ts`, `${CWD}/b.ts`], CWD, 2);
    expect(pathTermsOf(recall.query)).toEqual(['a.ts', 'b.ts']);
    expect(recall.touchedCap).toBe(2);
  });

  it('states no bound when every touched path was read and fits', () => {
    const recall = recallQueryOf(TASK, [`${CWD}/a.ts`, '/elsewhere/x.ts', `${CWD}/b.ts`], CWD, RECALL_TOUCHED_ROWS);
    expect(pathTermsOf(recall.query)).toEqual(['a.ts', 'b.ts']);
    expect(recall.touchedCap).toBeUndefined();
  });

  it('states a bound of zero when the newest path alone does not fit', () => {
    const recall = recallQueryOf(TASK, [`${CWD}/${'e'.repeat(MEMORY_QUERY_MAX_CHARS)}.ts`], CWD, RECALL_TOUCHED_ROWS);
    expect(pathTermsOf(recall.query)).toEqual([]);
    expect(recall.touchedCap).toBe(0);
  });
});
