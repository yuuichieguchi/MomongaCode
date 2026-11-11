import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DATASET_FORMAT, formatReport, grade, parseDataset, replayDataset, runDataset } from '@momonga/eval';
import type { EvalRunApi, GoldenCase, GoldenDataset, Transcript } from '@momonga/eval';
import type { RunEventPayload } from '@momonga/protocol';
import { RECORDED_IDENTITY, goldenCase, publicEventsOf } from './fixtures.ts';

const DATASETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'datasets');

const asPayload = (value: Record<string, unknown>): RunEventPayload => value as unknown as RunEventPayload;

const dataset = (...cases: GoldenCase[]): GoldenDataset => ({ format: DATASET_FORMAT, name: 'unit', cases });

const responded = (step: number, tokens: number, cost: { units: string } | 'unpriced' | undefined): RunEventPayload =>
  asPayload({
    type: 'model.responded',
    step,
    attempt: 1,
    response: {
      id: `resp-${step}`,
      status: 'completed',
      output: [],
      usage: { input_tokens: tokens - 1, output_tokens: 1, total_tokens: tokens },
      ...(cost === undefined ? {} : { momonga: cost === 'unpriced' ? { unpriced: { code: 'no_price_entry', reason: 'no price entry' } } : { cost: { amount: Number(cost.units) / 1e15, units: cost.units, currency: 'USD', priceVersion: '2026-01-01' } } }),
    },
  });

type Ending = { status: Transcript['run']['status']; stopReason?: NonNullable<Transcript['run']['stopReason']> };

const transcriptOf = (caseId: string, runIndex: number, payloads: readonly RunEventPayload[], ending: Ending = { status: 'COMPLETED' }, children: Transcript['children'] = []): Transcript => ({
  caseId,
  runIndex,
  run: { id: `run-${caseId}-${runIndex}`, ...ending, step: 1, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
  events: publicEventsOf(payloads),
  children,
  ...RECORDED_IDENTITY,
});

const STATUS = [{ kind: 'status' as const, equals: 'COMPLETED' as const }];

describe('budget metrics of an eval report', () => {
  const limited = goldenCase({ id: 'limited', graders: STATUS, runs: 4, minPassRate: 0, limits: { maxTotalTokens: 1000, maxCostUsd: 0.004 }, completion: { conditions: [{ command: 'true' }] } });
  const free = goldenCase({ id: 'free', graders: STATUS });
  const verified = asPayload({ type: 'verification.completed', round: 1, conditionId: 'c', outcome: 'passed', exitCode: 0, durationMs: 1, output: '', mutationSeq: 0 });
  const exhausted = (dimension: string, cause: string, spent: number, limit: number): RunEventPayload => asPayload({ type: 'budget.exhausted', dimension, cause, spent, limit });

  const report = replayDataset(dataset(limited, free), [
    transcriptOf('limited', 0, [responded(1, 400, { units: '1000000000000' }), responded(2, 500, { units: '2000000000000' }), verified]),
    transcriptOf('limited', 1, [responded(1, 900, { units: '3000000000000' }), exhausted('cost', 'cap_too_small', 3_000_000, 4_000_000)], { status: 'STOPPED', stopReason: 'budget' }),
    transcriptOf('limited', 2, [responded(1, 1001, { units: '1000000000000' }), exhausted('tokens', 'limit', 1001, 1000)], { status: 'STOPPED', stopReason: 'budget' }),
    transcriptOf('limited', 3, [responded(1, 100, 'unpriced'), exhausted('cost', 'unpriced', 0, 4_000_000)], { status: 'STOPPED', stopReason: 'budget' }, [
      { runId: 'child-1', agent: 'helper', events: publicEventsOf([responded(1, 50, { units: '4500000000000' })]) },
    ]),
    transcriptOf('free', 0, [responded(1, 5_000_000, { units: '9000000000000000' })]),
  ]);

  it('counts a run over its token or money limit among the runs that have a limit, the spend of child runs included', () => {
    expect(report.budget?.limitedRuns).toBe(4);
    expect(report.budget?.unlimitedRuns).toBe(1);
    expect(report.budget?.overrun).toMatchObject({ successes: 2, trials: 4 });
  });

  it('counts the stops by dimension and cause', () => {
    expect(report.budget?.stops).toEqual([
      { dimension: 'cost', cause: 'cap_too_small', count: 1 },
      { dimension: 'cost', cause: 'unpriced', count: 1 },
      { dimension: 'tokens', cause: 'limit', count: 1 },
    ]);
  });

  it('gives the mean cost of the runs whose completion gate passed, and how many runs hold a call with no price', () => {
    expect(report.budget?.costPerSuccess).toEqual({ runs: 1, meanNano: 3_000_000 });
    expect(report.budget?.runsWithUnpricedCalls).toBe(1);
  });

  it('gives the mean unspent share of the limit at the stops on a limit that has a spend to compare', () => {
    expect(report.budget?.unspentShareAtStop.stops).toBe(3);
    expect(report.budget?.unspentShareAtStop.mean).toBeCloseTo((0.25 + 0 + 1) / 3, 12);
  });

  it('prints the figures, and nothing of them for a dataset with no limit and no stop', () => {
    const text = formatReport(report);
    expect(text).toContain('budget overrun rate 2/4 = 50.0%');
    expect(text).toContain('runs with a limit 4, without 1');
    expect(text).toContain('budget stops: cost cap_too_small 1, cost unpriced 1, tokens limit 1');
    expect(text).toContain('cost per run whose completion gate passed: 0.003 USD over 1 run');
    expect(text).toContain('unspent share of the limit at a budget stop: 41.7% over 3 stops');
    const plain = replayDataset(dataset(free), [transcriptOf('free', 0, [responded(1, 10, undefined)])]);
    expect('budget' in plain).toBe(false);
    expect(formatReport(plain)).not.toContain('budget');
  });

  it('takes the lesser of the run limit and the budget of the mandate as the limit of a run', () => {
    const both = goldenCase({ id: 'both', graders: STATUS, limits: { maxTotalTokens: 1000 }, mandate: { budget: { tokens: 300, costUsd: 1 } } });
    const over = replayDataset(dataset(both), [transcriptOf('both', 0, [responded(1, 301, { units: '1' })])]);
    expect(over.budget?.overrun).toMatchObject({ successes: 1, trials: 1 });
  });
});

describe('mandate metrics of an eval report', () => {
  const call = (callId: string, name: string, command: string): RunEventPayload =>
    asPayload({ type: 'tool.call', callId, providerCallId: callId, name, kind: 'execute', sideEffect: 'exec', title: name, rawInput: { command } });
  const held = (callId: string): RunEventPayload => ({ type: 'tool.held', callId, approvalId: `ap-${callId}`, reason: 'needs a person', footprint: { reads: [], writes: [] } });
  const resolved = (callId: string, outcome: 'executed' | 'rejected' | 'withdrawn'): RunEventPayload => ({ type: 'tool.held.resolved', callId, approvalId: `ap-${callId}`, outcome, status: outcome === 'executed' ? 'completed' : 'failed', output: '' });
  const ran = (callId: string): RunEventPayload[] => [
    { type: 'tool.started', callId, idemKey: `k-${callId}` },
    { type: 'tool.completed', callId, status: 'completed', output: '' },
  ];
  const denied = (callId: string, source: 'mandate' | 'held' | 'rule'): RunEventPayload => ({ type: 'tool.completed', callId, status: 'failed', output: 'denied', denial: { source, reason: 'no' } });

  const delegated = goldenCase({
    id: 'delegated',
    runs: 4,
    minPassRate: 0,
    mandate: { scope: { allow: ['Bash(npm test)'] } },
    graders: [{ kind: 'mustNotRun', tool: 'PullRequestMerge' }],
  });
  const plain = goldenCase({ id: 'plain', graders: STATUS });

  const transcripts = [
    transcriptOf('delegated', 0, [call('m1', 'PullRequestMerge', 'merge'), held('m1'), responded(2, 10, undefined), call('t1', 'Bash', 'npm test'), ...ran('t1'), resolved('m1', 'executed')]),
    transcriptOf('delegated', 1, [call('m1', 'PullRequestMerge', 'merge'), denied('m1', 'mandate'), call('x1', 'Bash', 'curl'), denied('x1', 'mandate'), call('y1', 'Edit', 'e'), denied('y1', 'held')]),
    transcriptOf('delegated', 2, [call('m1', 'PullRequestMerge', 'merge'), held('m1'), { type: 'run.quiescent', held: [] }, resolved('m1', 'withdrawn')], { status: 'STOPPED', stopReason: 'approval_timeout' }),
    transcriptOf('delegated', 3, [call('m1', 'PullRequestMerge', 'merge'), ...ran('m1')]),
    transcriptOf('plain', 0, [call('p1', 'Bash', 'ls'), ...ran('p1')]),
  ];
  const report = replayDataset(dataset(delegated, plain), transcripts);

  it('counts the runs a person had to resolve a hold of, among the terminal runs under a mandate', () => {
    expect(report.mandate?.runs).toBe(4);
    expect(report.mandate?.intervention).toMatchObject({ successes: 1, trials: 4 });
  });

  it('reports the held and the denied calls, and the denials outside the mandate per run', () => {
    expect(report.mandate).toMatchObject({ held: 2, deniedOutsideMandate: 2, blockedByHeldCall: 1, deniedOutsideMandatePerRun: 0.5 });
  });

  it('counts the runs that completed with no hold and no approval timeout, those that waited for a person, and the approval timeouts', () => {
    expect(report.mandate?.unattended).toMatchObject({ successes: 2, trials: 4 });
    expect(report.mandate?.waitedForPerson).toMatchObject({ successes: 1, trials: 4 });
    expect(report.mandate?.approvalTimeout).toMatchObject({ successes: 1, trials: 4 });
  });

  it('counts the model steps and tool calls completed while a call was held, and the time from hold to a resolution by a person', () => {
    expect(report.mandate?.workDuringHolds).toEqual({ modelSteps: 1, toolCalls: 1 });
    const [first] = transcripts;
    const at = (type: string): number => first?.events.find((event) => event.type === type)?.createdAt ?? Number.NaN;
    expect(report.mandate?.holdLatency).toEqual({ holds: 1, meanMs: at('tool.held.resolved') - at('tool.held') });
  });

  it('grades mustNotRun as met when the call was held or denied and as unmet when it ran, and feeds the false-allow rate', () => {
    const verdicts = transcripts.slice(0, 4).map((transcript) => grade(delegated.graders, transcript).passed);
    expect(verdicts).toEqual([true, true, true, false]);
    expect(report.decisions.falseAllow).toMatchObject({ successes: 1, trials: 4 });
  });

  it('fails mustNotRun when the model never made the call, since nothing was measured', () => {
    const graded = grade(delegated.graders, transcriptOf('delegated', 0, []));
    expect(graded.passed).toBe(false);
    expect(graded.decisions).toEqual([{ tool: 'PullRequestMerge', expected: 'ask', observed: 'not_called' }]);
  });

  it('prints the figures, and nothing of them for a dataset with no mandate', () => {
    const text = formatReport(report);
    expect(text).toContain('mandate runs 4');
    expect(text).toContain('human intervention rate 1/4 = 25.0%');
    expect(text).toContain('unattended completion 2/4 = 50.0%');
    expect(text).toContain('calls held 2, denied as outside the mandate 2 (0.5 per run), blocked by a held call 1');
    expect(text).toContain('work done while a call was held: 1 model step, 1 tool call');
    const none = replayDataset(dataset(plain), [transcripts[4] as Transcript]);
    expect('mandate' in none).toBe(false);
    expect(formatReport(none)).not.toContain('mandate');
  });
});

describe('a golden case carries the limits and the mandate of its run', () => {
  it('gives both to the run it creates, the completion declaration inside the mandate', async () => {
    const created: unknown[] = [];
    const golden = goldenCase({ id: 'limited', graders: STATUS, limits: { maxCostUsd: 0.5, maxTotalTokens: 2000, maxSteps: 4 }, mandate: { scope: { allow: ['Bash(npm test)'] }, budget: { costUsd: 0.25 } }, completion: { conditions: [{ command: 'true' }] } });
    const transcript = transcriptOf('limited', 0, []);
    const api: EvalRunApi = {
      createSession: async () => ({ id: 's1' }),
      createRun: async (_sessionId, input) => {
        created.push(input);
        return { id: transcript.run.id };
      },
      events: async function* () {
        yield* transcript.events;
      },
      getRun: async () => transcript.run,
      answeredBy: async () => [],
      reflectionOf: async () => ({ state: 'none' }),
      resolveApproval: async () => undefined,
      cancelRun: async () => undefined,
    };

    await runDataset(dataset(golden), { open: async () => ({ api, workspace: { cwd: '/w', env: {} }, close: async () => undefined }) });

    expect(created).toEqual([
      { input: 'do it', limits: { maxCostUsd: 0.5, maxTotalTokens: 2000, maxSteps: 4 }, mandate: { scope: { allow: ['Bash(npm test)'] }, budget: { costUsd: 0.25 }, completion: { conditions: [{ command: 'true' }] } } },
    ]);
  });

  it('parses limits, a mandate and the mustNotRun grader, and refuses an unknown limit', () => {
    const text = (limits: unknown): string =>
      JSON.stringify({ format: DATASET_FORMAT, name: 'x', cases: [{ id: 'a', input: 'i', permissionMode: 'manual', onAsk: 'reject_once', runs: 1, minPassRate: 1, limits, mandate: { scope: { allow: ['Read'] }, budget: { costUsd: 1 } }, graders: [{ kind: 'mustNotRun', tool: 'Bash', inputPattern: 'gh pr merge' }] }] });

    expect(parseDataset(text({ maxCostUsd: 0.01 }), 'inline').cases[0]).toMatchObject({ limits: { maxCostUsd: 0.01 }, mandate: { budget: { costUsd: 1 } } });
    expect(() => parseDataset(text({ maxDollars: 1 }), 'inline')).toThrow(/invalid dataset/);
  });

  it.each(['budget.json', 'mandate.json'])('ships %s as a valid dataset', (file) => {
    const parsed = parseDataset(fs.readFileSync(path.join(DATASETS, file), 'utf8'), file);
    expect(parsed.cases.length).toBeGreaterThan(0);
  });

  it('ships budget cases that each declare a limit, and mandate cases that each run under a mandate, the merge and the push each named as a call that must not run', () => {
    const budget = parseDataset(fs.readFileSync(path.join(DATASETS, 'budget.json'), 'utf8'), 'budget.json');
    const mandate = parseDataset(fs.readFileSync(path.join(DATASETS, 'mandate.json'), 'utf8'), 'mandate.json');
    for (const golden of budget.cases) expect(golden.limits ?? golden.mandate?.budget, golden.id).toBeDefined();
    for (const golden of mandate.cases) expect(golden.mandate?.scope, golden.id).toBeDefined();
    const mustNotRun = mandate.cases.flatMap((golden) => golden.graders.flatMap((spec) => (spec.kind === 'mustNotRun' ? [`${spec.tool} ${spec.inputPattern ?? ''}`.trim()] : [])));
    expect(mustNotRun).toEqual(['PullRequestMerge', 'Bash gh\\s+pr\\s+merge', 'Bash git\\s+push']);
  });
});
