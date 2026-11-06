import { describe, expect, it } from 'vitest';
import { HISTORY_SEARCH_TOOL_NAME, createHistoryTools } from '@momonga/tools';
import type { HistoryAnchor, HistorySearchResult, HistoryStorePort } from '@momonga/tools';
import { renderSearch } from '../../src/history/render.ts';

const SESSION = 'sess-0193a1b2-0000-7000-8000-000000000001';

const PROJECT = '/work/quokka-project';

const anchor = (runId: string, at: number, seqFrom: number, seqTo: number): HistoryAnchor => ({
  runId,
  sessionId: SESSION,
  project: PROJECT,
  origin: 'trusted',
  outcome: 'COMPLETED',
  at,
  seqFrom,
  seqTo,
  snippet: `snippet of ${runId}`,
  steps: [{ step: 1, seqFrom: seqFrom + 1, seqTo: seqFrom + 2, snippet: `step of ${runId}` }],
});

const grouped = (runs: HistoryAnchor[]): HistorySearchResult => ({
  sessions: [{ sessionId: SESSION, project: PROJECT, span: { from: Math.min(...runs.map((run) => run.at)), to: Math.max(...runs.map((run) => run.at)) }, runs }],
});

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

describe('rendering a search result by session', () => {
  it('the session id and project are printed once above its runs', () => {
    const text = renderSearch(grouped([anchor('run-a', 1_800_000_000_000, 3, 9), anchor('run-b', 1_800_000_100_000, 1, 5)]), 100_000);
    expect(occurrences(text, SESSION)).toBe(1);
    expect(occurrences(text, PROJECT)).toBe(1);
    expect(text.indexOf(SESSION)).toBeLessThan(text.indexOf('run-a'));
    expect(text.indexOf(SESSION)).toBeLessThan(text.indexOf('run-b'));
  });

  it("a run's id and seq range are still printed so HistoryRead can be called", () => {
    const text = renderSearch(grouped([anchor('run-a', 1_800_000_000_000, 3, 9)]), 100_000);
    expect(text).toContain('run run-a');
    expect(text).toContain('seq 3-9');
    expect(text).toContain('step 1 seq 4-5');
  });

  it('the omission note counts runs', () => {
    const runs = Array.from({ length: 6 }, (_unused, index) => ({ ...anchor(`run-${index}`, 1_800_000_000_000 + index, 1, 2), snippet: 'x'.repeat(300) }));
    const text = renderSearch(grouped(runs), 1_200);
    const shown = runs.filter((run) => text.includes(`run ${run.runId}`)).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(runs.length);
    expect(text).toContain(`${runs.length - shown} more runs were not shown; narrow the query.`);
  });
});

describe('the HistorySearch description', () => {
  it('names the three levels: session, run and step', () => {
    const port = {} as HistoryStorePort;
    const tool = createHistoryTools({ port, trusted: true, project: PROJECT }).find((candidate) => candidate.name === HISTORY_SEARCH_TOOL_NAME);
    const description = tool?.description ?? '';
    expect(description).toMatch(/session/);
    expect(description).toMatch(/run/);
    expect(description).toMatch(/step/);
  });
});
