import { RECORDED_IDENTITY } from './fixtures.ts';
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_DATASET_FORMAT,
  decodeTranscript,
  encodeTranscript,
  expandContextDataset,
  formatContextReport,
  parseContextDataset,
  parseContextReport,
  encodeContextReport,
  runContextDataset,
} from '@momonga/eval';
import type { ContextCaseHost, EvalRunApi, Transcript, TranscriptReflection } from '@momonga/eval';
import { contextCase } from './context-fixtures.ts';
import { buildReportAs } from './answered-fixtures.ts';

const datasetOf = (extra: Record<string, unknown>) =>
  parseContextDataset(
    JSON.stringify({ format: CONTEXT_DATASET_FORMAT, name: 'noise', cases: [{ ...contextCase('a-on', 'a', 'on'), ...extra }, { ...contextCase('a-off', 'a', 'off'), ...extra }] }),
    'noise.json',
  );

const NOISE = { noise: { level: 2, topics: ['testing'] } };

const host = (
  tokensOf: (input: string) => number,
  hangOn?: string,
  reflect: (input: string) => TranscriptReflection = () => ({ state: 'none' }),
): { open: () => Promise<ContextCaseHost>; inputs: string[]; cancelled: string[] } => {
  const inputs: string[] = [];
  const cancelled: string[] = [];
  const inputOfRun = new Map<string, string>();
  const releases: (() => void)[] = [];
  let counter = 0;
  const api: EvalRunApi = {
    createSession: async () => ({ id: 's' }),
    createRun: async (_session, input) => {
      counter += 1;
      inputs.push(input.input);
      inputOfRun.set(`r${counter}`, input.input);
      return { id: `r${counter}` };
    },
    events: async function* (runId) {
      if (inputOfRun.get(runId) === hangOn) await new Promise<void>((resolve) => releases.push(resolve));
    },
    reflectionOf: async (runId) => reflect(inputOfRun.get(runId) ?? ''),
    answeredBy: async () => [],
    getRun: async (runId) => ({ id: runId, status: 'COMPLETED', step: 1, usage: { inputTokens: 0, outputTokens: 0, totalTokens: tokensOf(inputOfRun.get(runId) ?? '') } }),
    resolveApproval: async () => undefined,
    cancelRun: async (runId) => {
      cancelled.push(runId);
      for (const release of releases) release();
    },
  };
  return {
    inputs,
    cancelled,
    open: async () => ({
      cwd: '/w',
      api,
      rules: { add: async () => ({ fact: { id: 'f' } }), retire: async () => undefined },
      seedMemory: async () => undefined,
      applyStep: async () => undefined,
      close: async () => undefined,
    }),
  };
};

const ports = (open: () => Promise<ContextCaseHost>, overrides: Partial<Parameters<typeof runContextDataset>[1]> = {}) => ({
  ...RECORDED_IDENTITY,
  openCase: open,
  modelAlias: 'gamma',
  deadline: (_caseId: string, signal: AbortSignal) =>
    new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  bounds: { datasetTokens: 1_000_000, caseDeadlineMs: {} },
  ...overrides,
});

describe('noise turns of a live run', () => {
  it('records the tokens of the noise in the transcript and the report, apart from the tokens of the task', async () => {
    const context = host((input) => (input === 'work on a' ? 10 : 7));
    const dataset = datasetOf(NOISE);
    const { transcripts } = await runContextDataset(expandContextDataset(dataset, 3), ports(context.open));
    expect(transcripts.map((transcript) => [transcript.run.usage.totalTokens, transcript.noiseTokens])).toEqual([
      [10, 14],
      [10, 14],
    ]);
    const report = buildReportAs({ dataset, transcripts, model: 'fake', seed: 1, datasetSeed: 3 });
    expect(report.noiseTokens).toBe(28);
    expect(report.cases.map((entry) => entry.totalTokens)).toEqual([10, 10]);
    expect(report.metrics.tokensPerSuccess).toMatchObject({ tokens: 20, successes: 2 });
    expect(formatContextReport(report)).toContain('noiseTokens 28');
  });

  it('puts the reflection charges of the noise runs into the noise tokens, reports an unsettled one in the noise section, and leaves the case measured', async () => {
    const charge = { id: 1, purpose: 'reflection' as const, runId: 'n', project: '/w', model: 'm', inputTokens: 30, outputTokens: 5, totalTokens: 35, createdAt: 1 };
    const dataset = datasetOf(NOISE);
    const expanded = expandContextDataset(dataset, 3);
    const [firstNoise] = expanded.cases[0]?.noiseTurns ?? [];
    const context = host(
      (input) => (input === 'work on a' ? 10 : 7),
      undefined,
      (input) => (input === firstNoise?.user ? { state: 'done', charges: [charge] } : input === 'work on a' ? { state: 'none' } : { state: 'pending' }),
    );

    const { transcripts } = await runContextDataset(expanded, ports(context.open));

    const first = transcripts[0] as Transcript;
    expect(first.noiseTokens).toBe(7 + 35 + 7);
    expect(first.noiseReflectionsUnsettled).toBe(1);
    const report = buildReportAs({ dataset, transcripts, model: 'real', seed: 1, datasetSeed: 3 });
    expect(report.unsettledNoiseReflections).toBe(transcripts.reduce((sum, entry) => sum + (entry.noiseReflectionsUnsettled ?? 0), 0));
    expect(report.cases.every((entry) => entry.tokens?.unsettledReflections === 0)).toBe(true);
    expect(formatContextReport(report)).toMatch(/noise reflections unsettled \d+/);
    expect(decodeTranscript(encodeTranscript(first), 'x').noiseReflectionsUnsettled).toBe(1);
  });

  it('counts the reflection charge of a noise run against the dataset cap: the cap is reached only with the charge, and the next case stops with the cost-cap reason', async () => {
    const charge = { id: 1, purpose: 'reflection' as const, runId: 'n', project: '/w', model: 'm', inputTokens: 30, outputTokens: 5, totalTokens: 35, createdAt: 1 };
    const dataset = datasetOf(NOISE);
    const expanded = expandContextDataset(dataset, 3);
    const cap = { bounds: { datasetTokens: 40, caseDeadlineMs: {} } };
    const tokensOf = (input: string): number => (input === 'work on a' ? 10 : 7);

    const without = await runContextDataset(expanded, ports(host(tokensOf).open, cap));
    expect(without.transcripts.map((transcript) => transcript.stopped)).toEqual([undefined, undefined]);

    const lastNoise = expanded.cases[0]?.noiseTurns.at(-1)?.user;
    const charged = host(tokensOf, undefined, (input) => (input === lastNoise ? { state: 'done', charges: [charge] } : { state: 'none' }));
    const withCharge = await runContextDataset(expanded, ports(charged.open, cap));
    expect(withCharge.transcripts[0]?.stopped).toEqual(expect.stringContaining('cost cap'));
    expect(withCharge.transcripts[0]?.events).toEqual([]);
    expect(charged.inputs).not.toContain('work on a');
  });

  it('counts the reflection charge of the measured run against the dataset cap too, so the next case stops when the cap is reached with it', async () => {
    const charge = { id: 1, purpose: 'reflection' as const, runId: 'n', project: '/w', model: 'm', inputTokens: 30, outputTokens: 5, totalTokens: 35, createdAt: 1 };
    const expanded = expandContextDataset(datasetOf({}), 3);
    const cap = { bounds: { datasetTokens: 40, caseDeadlineMs: {} } };

    const without = await runContextDataset(expanded, ports(host(() => 10).open, cap));
    expect(without.transcripts.map((transcript) => transcript.stopped)).toEqual([undefined, undefined]);

    const charged = await runContextDataset(expanded, ports(host(() => 10, undefined, () => ({ state: 'done', charges: [charge] })).open, cap));
    expect(charged.transcripts.map((transcript) => transcript.stopped)).toEqual([undefined, expect.stringContaining('cost cap')]);
    expect(charged.transcripts[0]?.run.usage.totalTokens).toBe(10);
  });

  it('keeps the noise tokens through the transcript file and the report file', async () => {
    const dataset = datasetOf(NOISE);
    const { transcripts } = await runContextDataset(expandContextDataset(dataset, 3), ports(host(() => 5).open));
    const decoded = transcripts.map((transcript) => decodeTranscript(encodeTranscript(transcript), 'x'));
    expect(decoded.map((transcript) => transcript.noiseTokens)).toEqual([10, 10]);
    const report = buildReportAs({ dataset, transcripts: decoded, model: 'fake', seed: 1, datasetSeed: 3 });
    expect(parseContextReport(encodeContextReport(report), 'x').noiseTokens).toBe(20);
  });

  it('counts the tokens of the noise against the dataset cap', async () => {
    const context = host(() => 60);
    const { transcripts } = await runContextDataset(expandContextDataset(datasetOf(NOISE), 3), ports(context.open, { bounds: { datasetTokens: 100, caseDeadlineMs: {} } }));
    expect(context.inputs).toHaveLength(2);
    expect(transcripts.map((transcript) => transcript.stopped)).toEqual([expect.stringContaining('cost cap'), expect.stringContaining('cost cap')]);
  });

  it('stops the case when its deadline passes during a noise turn, and reports the run as failed', async () => {
    const dataset = datasetOf(NOISE);
    const expanded = expandContextDataset(dataset, 3);
    const hanging = expanded.cases[0]?.noiseTurns[0]?.user;
    const context = host(() => 1, hanging);
    const { transcripts } = await runContextDataset(expanded, ports(context.open, { deadline: async () => undefined }));
    expect(context.cancelled).toHaveLength(2);
    expect(context.inputs).not.toContain('work on a');
    const report = buildReportAs({ dataset, transcripts, model: 'fake', seed: 1, datasetSeed: 3 });
    expect(report.stopped.map((stop) => stop.caseId)).toEqual(['a-on', 'a-off']);
    expect(report.cases.map((entry) => entry.passedRuns)).toEqual([0, 0]);
  });
});

describe('a stopped run in a replay', () => {
  const stopped = (caseId: string): Transcript => ({
    caseId,
    runIndex: 0,
    run: { id: `stopped-${caseId}`, status: 'FAILED', step: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
    events: [],
    children: [],
    ...RECORDED_IDENTITY,
    stopped: 'the case deadline passed',
  });

  it('never passes, even when its graders would accept a failed run', () => {
    const dataset = parseContextDataset(
      JSON.stringify({
        format: CONTEXT_DATASET_FORMAT,
        name: 'lenient',
        cases: ['on', 'off'].map((side) => ({ ...contextCase(`a-${side}`, 'a', side as 'on' | 'off'), graders: [{ kind: 'status', equals: 'FAILED' }] })),
      }),
      'lenient.json',
    );
    const report = buildReportAs({ dataset, transcripts: [stopped('a-on'), stopped('a-off')], model: 'fake', seed: 1 });
    expect(report.cases.map((entry) => entry.passedRuns)).toEqual([0, 0]);
    expect(report.stopped).toHaveLength(2);
  });
});
