import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { INDICATOR_DEFINITIONS_VERSION, REPORT_PAGE_ROWS } from '@momonga/protocol';
import type { ReportPage, RunCallView, RunFactsView } from '@momonga/protocol';

const T0 = 1_800_000_000_000;

type FactsClient = { reportFacts(request: { cursor: string | null; limit: number }): Promise<ReportPage> };
type ReliabilityCommand = { reliabilityText(client: FactsClient, options: { groupBy: 'model'; explain: boolean }): Promise<string> };
type ReviewCall = RunCallView;
type ReviewCommand = { reviewSample(calls: readonly ReviewCall[], options: { size: number; seed: string }): { allowedWithoutPerson: ReviewCall[]; asks: ReviewCall[] } };

const reliabilityCommand = async (): Promise<ReliabilityCommand> => (await import('../src/commands/' + 'reliability.ts')) as ReliabilityCommand;
const reviewCommand = async (): Promise<ReviewCommand> => (await import('../src/commands/' + 'review.ts')) as ReviewCommand;

const row = (runId: string, overrides: Partial<RunFactsView> = {}): RunFactsView => ({
  runId,
  rootRunId: runId,
  sessionId: 'sess',
  definitionsVersion: INDICATOR_DEFINITIONS_VERSION,
  model: 'apple/fm',
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
      return { rows: rows.slice(start, next), unavailable: [], nextCursor: next < rows.length ? String(next) : null };
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
    expect(lines).toContain('Population: 3 terminal root tasks; counted 2; cancelled 1 (excluded); pending facts 0 (excluded); facts unavailable 0 (excluded); unknown values 0 (excluded); facts coverage 3/3');
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

describe('decision 55: unavailable runs in the text', () => {
  it('merges the unavailable roots of every page into the fourth bucket and counts them as resolved in the coverage', async () => {
    const { reliabilityText } = await reliabilityCommand();
    const pages: ReportPage[] = [
      { rows: [row('run-a')], unavailable: [{ runId: 'poison-1', rootRunId: 'poison-1' }], nextCursor: '1' },
      { rows: [row('run-b')], unavailable: [{ runId: 'poison-2', rootRunId: 'run-b' }], nextCursor: null },
    ];
    const client: FactsClient = { reportFacts: async (request) => pages[request.cursor === null ? 0 : 1] as ReportPage };
    const text = await reliabilityText(client, { groupBy: 'model', explain: false });
    expect(text).toContain('Population: 3 terminal root tasks; counted 1; cancelled 0 (excluded); pending facts 0 (excluded); facts unavailable 2 (excluded); unknown values 0 (excluded); facts coverage 3/3');
  });
});

describe('momonga permissions review --sample (decisions 54 and 57)', () => {
  const sha = (call: ReviewCall, seed: string): string => crypto.createHash('sha256').update(call.callId + seed).digest('hex');
  const byHash = (calls: readonly ReviewCall[], seed: string): ReviewCall[] => [...calls].sort((a, b) => sha(a, seed).localeCompare(sha(b, seed)));
  const call = (index: number, overrides: Partial<ReviewCall>): ReviewCall => ({ runId: `r${index % 3}`, callId: `call-${index}`, basis: 'classifier', sideEffect: 'write', asked: false, ...overrides });
  const allowed = Array.from({ length: 10 }, (_, index) => call(index, {}));
  const asks = Array.from({ length: 6 }, (_, index) => call(100 + index, { basis: 'person', asked: true }));
  const excluded = [call(200, { sideEffect: 'read_only' }), call(201, { basis: 'person' }), call(202, { basis: null })];

  it('draws from each rate denominator on its own, ordered by sha256(callId || seed), the same for the same seed', async () => {
    const { reviewSample } = await reviewCommand();
    const frame = [...excluded, ...asks, ...allowed];
    const sample = reviewSample(frame, { size: 4, seed: 's1' });
    expect(sample.allowedWithoutPerson).toEqual(byHash(allowed, 's1').slice(0, 4));
    expect(sample.asks).toEqual(byHash(asks, 's1').slice(0, 4));
    expect(reviewSample(frame, { size: 4, seed: 's1' })).toEqual(sample);
  });

  it('takes every observation of a denominator that holds fewer than the size', async () => {
    const { reviewSample } = await reviewCommand();
    const sample = reviewSample([...allowed, ...asks], { size: 8, seed: 's2' });
    expect(sample.allowedWithoutPerson).toEqual(byHash(allowed, 's2').slice(0, 8));
    expect(sample.asks).toEqual(byHash(asks, 's2'));
  });

  it('leaves out of the first denominator a read-only call, a call decided by a person and a call with no basis, and treats an unknown side effect as not read-only', async () => {
    const { reviewSample } = await reviewCommand();
    const unknownSideEffect = call(300, { sideEffect: null });
    const sample = reviewSample([...excluded, unknownSideEffect], { size: 73, seed: 's3' });
    expect(sample.allowedWithoutPerson).toEqual([unknownSideEffect]);
    expect(sample.asks).toEqual([]);
  });
});
