import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_DATASET_FORMAT,
  CONTEXT_REPORT_FORMAT,
  EvalError,
  GUIDELINE_OUTCOME_FORMAT,
  TRANSCRIPT_FORMAT,
  TranscriptError,
  autoGateRecordOf,
  buildContextReport,
  decodeTranscript,
  encodeContextReport,
  encodeOutcomeFile,
  encodeTranscript,
  formatContextReport,
  formatImproveOutcome,
  improveGuideline,
  outcomeFileOf,
  parseContextDataset,
  parseContextReport,
  parseOutcomeFile,
  proportionOf,
} from '@momonga/eval';
import type { ContextReport, EvalReport, GuidelineCompletion, ImproveInput, Transcript } from '@momonga/eval';
import { REAL_TARGET, answeredBy } from './answered-fixtures.ts';
import { bash, contextCase, fidelity, read, recorded, summarized } from './context-fixtures.ts';

const SOURCES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

const SCENARIOS = ['a', 'b', 'c', 'd'] as const;
const LOCAL = 'ollama/qwen3:8b';
const CLOUD = 'anthropic/claude-opus-4-7';

const dataset = parseContextDataset(
  JSON.stringify({ format: CONTEXT_DATASET_FORMAT, name: 'fields', cases: SCENARIOS.flatMap((scenario) => [contextCase(`${scenario}-on`, scenario, 'on'), contextCase(`${scenario}-off`, scenario, 'off')]) }),
  'fields.json',
);

const used = (model: string | undefined): { model?: string } => (model === undefined ? {} : { model });

const transcriptsOf = (failingOn: readonly string[], modelOf: (caseId: string) => string | undefined): Transcript[] =>
  SCENARIOS.flatMap((scenario) => [
    recorded(`${scenario}-on`, 0, [...bash('b0', 'npm test', 'failed'), summarized(3, fidelity([], 2, 2))], { status: failingOn.includes(scenario) ? 'FAILED' : 'COMPLETED', ...used(modelOf(`${scenario}-on`)) }),
    recorded(`${scenario}-off`, 0, read('r0', '/p/a.ts', 'contents'), used(modelOf(`${scenario}-off`))),
  ]).map((transcript) => answeredBy({ ...transcript, run: { ...transcript.run, origin: 'trusted' } }, REAL_TARGET));

const reportOf = (failingOn: readonly string[], modelOf: (caseId: string) => string | undefined): ContextReport =>
  buildContextReport({ dataset, transcripts: transcriptsOf(failingOn, modelOf), seed: 1 } as Parameters<typeof buildContextReport>[0]);

const analysis = (): string =>
  JSON.stringify({
    divergence_step_description: 'the summary lost the failing test',
    root_cause_categories: ['Missing Critical Fact'],
    missing_or_distorted_facts: ['test name'],
    summary_inaccuracies: [],
    lost_state_variables: ['failing test'],
    remediation_recommendations: ['keep failing test names'],
    reliability_score: 0.8,
  });

const improved = async () => {
  const input = { seed: 42, bootstrapSeed: 1, analysisModel: CLOUD, tokenCap: 300, current: undefined } as unknown as ImproveInput;
  let candidates = 0;
  return improveGuideline(input, {
    benchmark: async (guideline) => {
      const failingOn = guideline === undefined ? ['a', 'b'] : ['a', 'b', 'c'];
      const transcripts = transcriptsOf(failingOn, () => LOCAL);
      return { report: buildContextReport({ dataset, transcripts, seed: 1 } as Parameters<typeof buildContextReport>[0]), transcripts, tokens: 100 };
    },
    complete: async (request): Promise<GuidelineCompletion> => {
      if (request.purpose === 'analysis') return { text: analysis(), usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } };
      candidates += 1;
      return { text: JSON.stringify({ guideline: `candidate ${candidates}` }), usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } };
    },
    charge: () => undefined,
  });
};

const sourceTexts = (): { file: string; text: string }[] =>
  readdirSync(SOURCES)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ file: name, text: readFileSync(path.join(SOURCES, name), 'utf8') }));

describe('eval records name a model by its full reference (design-model-names 3.12, N4)', () => {
  it('--model replaces --alias in every text the eval package prints', () => {
    const retired = JSON.stringify({ format: 'momonga-eval-context-report/6' });
    let message = '';
    try {
      parseContextReport(retired, 'base.json');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('run `momonga eval context <dataset> --model <model> --settings <base policy file> --report <base report>`, then `momonga eval context <dataset> --model <model> --report <candidate report>`');
    expect(sourceTexts().filter((source) => /--alias|<alias>/.test(source.text)).map((source) => source.file)).toEqual([]);
  });

  it('the fields models, model and analysisModel hold full references: the transcript run, the context report and the guideline outcome', async () => {
    const transcript = recorded('a-on', 0, [], { model: LOCAL });
    expect(transcript.run).toMatchObject({ model: LOCAL });
    const decoded = decodeTranscript(encodeTranscript(transcript), 'a.jsonl');
    expect(decoded.run.model).toBe(LOCAL);
    expect(Object.keys(decoded.run)).not.toContain('modelAlias');
    const blank = { ...transcript, run: { ...transcript.run, model: '' } };
    expect(() => decodeTranscript(encodeTranscript(blank), 'blank.jsonl')).toThrow('run.model must be a non-empty string');

    const report = reportOf([], (caseId) => (caseId === 'a-on' ? LOCAL : caseId === 'b-on' ? CLOUD : undefined));
    expect(report.models).toEqual([CLOUD, LOCAL]);
    expect(Object.keys(report)).not.toContain('modelAliases');
    expect(parseContextReport(encodeContextReport(report), 'report.json').models).toEqual([CLOUD, LOCAL]);
    expect(formatContextReport(report).split('\n')[1]).toBe(
      `model: real (derived from the pinned provenance of the models that answered: opus (model); the models the runs used: ${CLOUD}, ${LOCAL})`,
    );
    expect(formatContextReport(reportOf([], () => undefined)).split('\n')[1]).toBe(
      'model: real (derived from the pinned provenance of the models that answered: opus (model); the models the runs used: none recorded)',
    );

    const outcome = await improved();
    expect(outcome.analysisModel).toBe(CLOUD);
    expect(Object.keys(outcome)).not.toContain('alias');
    expect(formatImproveOutcome(outcome).split('\n')[0]).toBe(
      `model: real (derived from the pinned provenance of the models that answered the benchmark; the analysis and candidate calls used the model ${CLOUD})`,
    );
    const file = parseOutcomeFile(encodeOutcomeFile(outcomeFileOf(outcome, { name: 'fields', digest: 'e'.repeat(64) })));
    expect(file.analysisModel).toBe(CLOUD);
    expect(Object.keys(file)).not.toContain('alias');
  });

  it('the formats are context report /7, transcript /9 and guideline outcome /3', async () => {
    expect(CONTEXT_REPORT_FORMAT).toBe('momonga-eval-context-report/7');
    expect(TRANSCRIPT_FORMAT).toBe('momonga-transcript/10');
    expect(GUIDELINE_OUTCOME_FORMAT).toBe('momonga-guideline-outcome/3');
    expect(reportOf([], () => LOCAL).format).toBe('momonga-eval-context-report/7');
    expect(JSON.parse(encodeTranscript(recorded('a-on', 0, [], { model: LOCAL })).split('\n')[0] ?? '')).toMatchObject({ format: 'momonga-transcript/10', run: { model: LOCAL } });
    expect(outcomeFileOf(await improved(), { name: 'fields', digest: 'e'.repeat(64) }).format).toBe('momonga-guideline-outcome/3');
  });

  it('the previous format of each is retired with its reason and is never read as the present one', async () => {
    const previous = { ...recorded('a-on', 0, []).run, modelAlias: 'default' };
    const header = { format: 'momonga-transcript/7', caseId: 'a-on', runIndex: 0, run: previous, children: [], policy: {}, codeDigest: 'c'.repeat(64), answeredBy: [REAL_TARGET] };
    const text = `${JSON.stringify(header)}\n${JSON.stringify({ end: true, events: 0, childEvents: 0 })}\n`;
    expect(() => decodeTranscript(text, 'old.jsonl')).toThrow(TranscriptError);
    expect(() => decodeTranscript(text, 'old.jsonl')).toThrow(
      'old.jsonl:1: momonga-transcript/7 transcripts do not record the model each session used (it was recorded as an alias name), so they cannot be graded as momonga-transcript/10; record the case again',
    );

    const { models, ...rest } = reportOf([], () => LOCAL);
    const sixth = JSON.stringify({ ...rest, format: 'momonga-eval-context-report/6', modelAliases: ['default'] });
    expect(models).toEqual([LOCAL]);
    expect(() => parseContextReport(sixth, 'base.json')).toThrow(EvalError);
    expect(() => parseContextReport(sixth, 'base.json')).toThrow(
      'base.json: momonga-eval-context-report/6 reports do not record the models the runs used (they were recorded as alias names), so momonga-eval-context-report/6 is retired and cannot be compared as momonga-eval-context-report/7; every report older than momonga-eval-context-report/7 has its policy recorded relative to the old defaults, so build a momonga-eval-context-report/7 pair from one bundle',
    );

    const { analysisModel, digest: _digest, ...body } = outcomeFileOf(await improved(), { name: 'fields', digest: 'e'.repeat(64) });
    const second = JSON.stringify({ ...body, format: 'momonga-guideline-outcome/2', alias: analysisModel, digest: 'f'.repeat(64) });
    expect(() => parseOutcomeFile(second)).toThrow(EvalError);
    expect(() => parseOutcomeFile(second)).toThrow(
      'the outcome file is format momonga-guideline-outcome/2, which does not record the model of the analysis and candidate calls (it was recorded by alias name), so it is retired and cannot be adopted as momonga-guideline-outcome/3; run `momonga context improve` again',
    );
  });

  it('the auto-gate record carries agentModel and no agentAlias', () => {
    const verdicts = (count: number) => Array.from({ length: count }, (_unused, runIndex) => ({ runIndex, runId: `run-${runIndex}`, passed: true, failures: [] }));
    const report: EvalReport = {
      dataset: 'auto-mode',
      cases: [{ id: 'run-tests', passRate: proportionOf(48, 48), minPassRate: 1, meetsMinimum: true, verdicts: verdicts(48) }],
      overall: proportionOf(48, 48),
      decisions: { falseAllow: proportionOf(0, 75), falseBlock: proportionOf(0, 36), unobserved: 0 },
      passed: true,
    };
    const record = autoGateRecordOf(report, {
      key: { classifier: 'classifier-identity', codeDigest: 'code', datasetDigest: 'dataset' },
      agentModel: LOCAL,
      recordedAt: '2026-11-10T00:00:00.000Z',
      version: '0.0.0-test',
    });
    expect(record?.agentModel).toBe(LOCAL);
    expect(Object.keys(record ?? {})).not.toContain('agentAlias');
    expect(sourceTexts().filter((source) => source.text.includes('agentAlias')).map((source) => source.file)).toEqual([]);
  });
});
