import { INDICATOR_DEFINITIONS_VERSION, REPORT_PAGE_ROWS } from '@momonga/protocol';
import type { ReportPage, RunFactsView } from '@momonga/protocol';
import { describe, expect, it } from 'vitest';
import { verifyReliability } from '../src/commands/reliability.ts';

const T0 = 1_800_000_000_000;

const row = (runId: string, overrides: Partial<RunFactsView> = {}): RunFactsView => ({
  runId,
  rootRunId: runId,
  sessionId: 'sess',
  definitionsVersion: INDICATOR_DEFINITIONS_VERSION,
  model: 'apple/fm',
  mode: 'manual',
  agent: 'build',
  origin: 'cli',
  status: 'COMPLETED',
  createdAt: T0,
  endedAt: T0 + 10,
  elapsedMs: 10,
  humanWaitMs: 0,
  tokensTotal: 0,
  costNano: 0,
  steps: 1,
  limits: {},
  asked: 0,
  elicited: 0,
  authorizationRequired: 0,
  sideEffectingCalls: 0,
  repeatedStarts: 0,
  reconciledAlreadyApplied: 0,
  reconciledNotApplied: 0,
  reconciledUnknown: 0,
  basis: { readOnly: 0, rule: 0, mode: 0, hook: 0, classifier: 0, person: 0 },
  declared: true,
  met: true,
  recoveries: [],
  ...overrides,
});

const verifyClient = (stored: readonly RunFactsView[], recomputed: readonly RunFactsView[], refused: readonly string[] = []) => {
  const asked: string[][] = [];
  const client = {
    reportFacts: async (request: { cursor: string | null; limit: number }): Promise<ReportPage> => {
      const start = request.cursor === null ? 0 : Number(request.cursor);
      const next = start + request.limit;
      return { rows: stored.slice(start, next), unavailable: [], nextCursor: next < stored.length ? String(next) : null };
    },
    reportRecompute: async (runIds: readonly string[]): Promise<{ rows: RunFactsView[]; refused: string[] }> => {
      asked.push([...runIds]);
      return { rows: recomputed.filter((entry) => runIds.includes(entry.runId)), refused: refused.filter((runId) => runIds.includes(runId)) };
    },
  };
  return { client, asked };
};

describe('momonga reliability --verify', () => {
  it('recomputes every stored row, REPORT_PAGE_ROWS runs at a time, and exits 0 when the fold agrees', async () => {
    const stored = Array.from({ length: REPORT_PAGE_ROWS + 1 }, (_unused, index) => row(`run-${String(index).padStart(4, '0')}`));
    const { client, asked } = verifyClient(stored, stored);
    const result = await verifyReliability(client);
    expect(asked.map((runIds) => runIds.length)).toEqual([REPORT_PAGE_ROWS, 1]);
    expect(result.code).toBe(0);
    expect(result.text).toContain(`${REPORT_PAGE_ROWS + 1} runs recomputed; 0 differ`);
  });

  it('exits 1 and names the run and the field when a stored fact differs from the fold', async () => {
    const stored = [row('run-a'), row('run-b', { asked: 3 })];
    const { client } = verifyClient(stored, [row('run-a'), row('run-b')]);
    const result = await verifyReliability(client);
    expect(result.code).toBe(1);
    expect(result.text).toContain('run-b: asked');
    expect(result.text).toContain('2 runs recomputed; 1 differ');
  });
});
