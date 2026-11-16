import { QUALITY_METRICS, buildContextReport } from '@momonga/eval';
import type { ContextReport, Transcript } from '@momonga/eval';

export type Answerer = { target: string; adapter?: string; upstreamModel?: string; answers: 'model' | 'script' | 'unknown' };

export const REAL_TARGET: Answerer = { target: 'anthropic/opus', adapter: 'anthropic', upstreamModel: 'claude-opus', answers: 'model' };

export const OTHER_REAL_TARGET: Answerer = { target: 'anthropic/sonnet', adapter: 'anthropic', upstreamModel: 'claude-sonnet', answers: 'model' };

export const SCRIPTED_TARGET: Answerer = { target: 'fake/scripted', adapter: 'chat-completions', upstreamModel: 'fake-model', answers: 'script' };

export const UNDECLARED_TARGET: Answerer = { target: 'ollama/local-llama', adapter: 'ollama', upstreamModel: 'llama3', answers: 'unknown' };

export const UNKNOWN_ANSWERER: Answerer = { target: 'unknown', answers: 'unknown' };

export const answeredBy = (transcript: Transcript, ...answerers: Answerer[]): Transcript => ({ ...transcript, answeredBy: answerers }) as Transcript;

export type ProvenanceName = 'fake' | 'real';

export const answeredAs = (transcripts: readonly Transcript[], model: ProvenanceName): Transcript[] =>
  transcripts.map((transcript) => answeredBy(transcript, model === 'real' ? REAL_TARGET : SCRIPTED_TARGET));

export const buildReportAs = (input: Omit<Parameters<typeof buildContextReport>[0], 'transcripts'> & { transcripts: readonly Transcript[]; model: ProvenanceName }): ContextReport => {
  const { model, transcripts, ...rest } = input;
  return buildContextReport({ ...rest, transcripts: answeredAs(transcripts, model) });
};

export const withMeasuredQuality = (report: ContextReport): ContextReport => ({
  ...report,
  cases: report.cases.map((entry) => ({ ...entry, quality: Object.fromEntries(QUALITY_METRICS.map((metric) => [metric.name, { numerator: 1, denominator: 2 }])) })),
});
