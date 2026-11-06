import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { INDICATOR_DEFINITIONS_VERSION, REPORT_PAGE_ROWS } from '@momonga/protocol';
import type { ReportPage, RunFactsView } from '@momonga/protocol';

const T0 = 1_800_000_000_000;

type FactsClient = { reportFacts(request: { cursor: string | null; limit: number }): Promise<ReportPage> };
type ReliabilityCommand = { reliabilityText(client: FactsClient, options: { groupBy: 'model'; explain: boolean }): Promise<string> };
type ReviewCommand = { reviewSample(calls: readonly { runId: string; callId: string; basis: string }[], options: { size: number; seed: string }): { runId: string; callId: string; basis: string }[] };

const reliabilityCommand = async (): Promise<ReliabilityCommand> => (await import('../src/commands/' + 'reliability.ts')) as ReliabilityCommand;
const reviewCommand = async (): Promise<ReviewCommand> => (await import('../src/commands/' + 'review.ts')) as ReviewCommand;

const row = (runId: string, overrides: Partial<RunFactsView> = {}): RunFactsView => ({
  runId,
  rootRunId: runId,
  sessionId: 'sess',
  definitionsVersion: INDICATOR_DEFINITIONS_VERSION,
  modelAlias: 'fm',
  mode: 'default',
  agent: 'build',
  origin: 'cli',
  status: 'COMPLETED',
  createdAt: T0,
  endedAt: T0 + 10,
  elapsedMs: 10,
  humanWaitMs: 0,
  tokensTotal: 0,
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

const RECOVERED = { ordinal: 1, cause: 'process_lost' as const, failedAt: T0 + 1000, progressAt: T0 + 4000, outcome: 'recovered' as const, startedSeq: 3, progressSeq: 5 };

const ROWS = [
  row('run-met', { recoveries: [RECOVERED] }),
  row('run-unmet', { status: 'FAILED', met: false }),
  row('run-cancelled', { status: 'CANCELLED', met: false }),
];

const pagedClient = (rows: readonly RunFactsView[], pageSize: number) => {
  const requests: { cursor: string | null; limit: number }[] = [];
  const client: FactsClient = {
    reportFacts: async (request) => {
      requests.push(request);
      const start = request.cursor === null ? 0 : Number(request.cursor);
      const next = start + pageSize;
      return { rows: rows.slice(start, next), nextCursor: next < rows.length ? String(next) : null };
    },
  };
  return { client, requests };
};

describe('momonga reliability', () => {
  it('folds every page of /v1/report/facts, asking REPORT_PAGE_ROWS rows at a time and following the cursor to the end', async () => {
    const { reliabilityText } = await reliabilityCommand();
    const { client, requests } = pagedClient(ROWS, 2);
    await reliabilityText(client, { groupBy: 'model', explain: false });
    expect(requests).toEqual([
      { cursor: null, limit: REPORT_PAGE_ROWS },
      { cursor: '2', limit: REPORT_PAGE_ROWS },
    ]);
  });

  it('prints the population block and the counts, no percentage below 35 and no target value', async () => {
    const { reliabilityText } = await reliabilityCommand();
    const text = await reliabilityText(pagedClient(ROWS, 2).client, { groupBy: 'model', explain: false });
    const lines = text.split('\n');
    expect(lines).toContain('Population: 3 terminal root tasks; counted 2; cancelled 1 (excluded); pending facts 0 (excluded); facts coverage 3/3');
    expect(lines).toContain('Task Completion Rate: 1/2 (0 tasks without a declared condition are not in the denominator)');
    expect(lines).toContain('Recovery Success Rate: 1/1; unknown_effect 0; failed 0; stopped 0');
    expect(lines).toContain('Mean Recovery Time: n=1, mean 3000 ms, median 3000 ms; clock_skew 0');
    expect(lines).toContain('Human Intervention Rate: 0/2');
    expect(text).not.toContain('%');
    expect(text).not.toMatch(/target|goal/i);
    expect(text).not.toContain('run-met');
  });

  it('--explain lists the run ids behind each count', async () => {
    const { reliabilityText } = await reliabilityCommand();
    const text = await reliabilityText(pagedClient(ROWS, 2).client, { groupBy: 'model', explain: true });
    for (const runId of ['run-met', 'run-unmet', 'run-cancelled']) expect(text).toContain(runId);
  });
});

describe('momonga permissions review --sample', () => {
  const calls = Array.from({ length: 10 }, (_, index) => ({ runId: `r${index % 3}`, callId: `call-${index}`, basis: 'classifier' }));
  const bySha = (seed: string) => [...calls].sort((a, b) => crypto.createHash('sha256').update(a.callId + seed).digest('hex').localeCompare(crypto.createHash('sha256').update(b.callId + seed).digest('hex')));

  it('orders the frame by sha256(callId || seed) and takes the first N, the same for the same seed', async () => {
    const { reviewSample } = await reviewCommand();
    expect(reviewSample(calls, { size: 4, seed: 's1' })).toEqual(bySha('s1').slice(0, 4));
    expect(reviewSample(calls, { size: 4, seed: 's1' })).toEqual(reviewSample(calls, { size: 4, seed: 's1' }));
    expect(reviewSample(calls, { size: 10, seed: 's2' })).toEqual(bySha('s2'));
  });
});
