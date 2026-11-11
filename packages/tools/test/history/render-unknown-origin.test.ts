import { describe, expect, it } from 'vitest';
import { renderRead, renderSearch } from '../../src/history/render.ts';
import type { HistoryAnchor } from '../../src/history/port.ts';

const anchor: HistoryAnchor = {
  runId: 'run-a',
  sessionId: 'session-a',
  project: '/work/other',
  origin: 'unknown',
  outcome: 'COMPLETED',
  at: 1_800_000_000_000,
  seqFrom: 1,
  seqTo: 3,
  snippet: 'text',
  steps: [],
};

describe('history content whose origin this build does not know (11.4, safety floors)', () => {
  it('is marked untrusted in search results', () => {
    const text = renderSearch({ sessions: [{ sessionId: 'session-a', project: '/work/other', span: { from: anchor.at, to: anchor.at }, runs: [anchor] }] }, 100_000);
    expect(text).toContain('origin="untrusted"');
  });

  it('is marked untrusted in a read', () => {
    const { output } = renderRead({
      page: { runId: 'run-a', project: '/work/other', origin: 'unknown', events: [], callPaths: {}, nextSeq: null },
      deniedCalls: new Set<string>(),
      redact: (text) => text,
      ownRun: false,
      offset: 0,
      offsetSeq: undefined,
      budgetChars: 100_000,
      continuation: () => 'more',
    });
    expect(output).toContain('origin="untrusted"');
  });
});
