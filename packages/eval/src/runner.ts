import type { PublicRunEvent } from '@momonga/protocol';
import type { GoldenCase, GoldenDataset } from './dataset.ts';
import { grade } from './graders.ts';
import { buildReport } from './report.ts';
import type { CaseResult, EvalReport } from './report.ts';
import type { Transcript, TranscriptRun } from './transcript.ts';

export type EvalWorkspace = { cwd: string; env: Record<string, string> };

export type EvalRunApi = {
  createSession(input: EvalWorkspace & { permissionMode: GoldenCase['permissionMode'] }): Promise<{ id: string }>;
  createRun(sessionId: string, input: { input: string; timeoutMs?: number }): Promise<{ id: string }>;
  events(runId: string): AsyncIterable<PublicRunEvent>;
  getRun(runId: string): Promise<TranscriptRun>;
  resolveApproval(approvalId: string, optionId: string): Promise<void>;
};

export type EvalPorts = {
  api: EvalRunApi;
  workspace(golden: GoldenCase, runIndex: number): Promise<EvalWorkspace>;
  onTranscript?(transcript: Transcript): Promise<void>;
};

export class EvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalError';
  }
}

const optionIdFor = (event: Extract<PublicRunEvent, { type: 'tool.permission.requested' }>, golden: GoldenCase): string => {
  const option = event.options.find((candidate) => candidate.kind === golden.onAsk);
  if (option === undefined) throw new EvalError(`case ${golden.id}: approval ${event.approvalId} offers no ${golden.onAsk} option`);
  return option.optionId;
};

const driveRun = async (ports: EvalPorts, golden: GoldenCase, runId: string): Promise<PublicRunEvent[]> => {
  const events: PublicRunEvent[] = [];
  for await (const event of ports.api.events(runId)) {
    events.push(event);
    if (event.type === 'tool.permission.requested') await ports.api.resolveApproval(event.approvalId, optionIdFor(event, golden));
  }
  return events;
};

const runOnce = async (ports: EvalPorts, golden: GoldenCase, runIndex: number): Promise<Transcript> => {
  const workspace = await ports.workspace(golden, runIndex);
  const session = await ports.api.createSession({ ...workspace, permissionMode: golden.permissionMode });
  const run = await ports.api.createRun(session.id, { input: golden.input, ...(golden.timeoutMs === undefined ? {} : { timeoutMs: golden.timeoutMs }) });
  const events = await driveRun(ports, golden, run.id);
  const transcript: Transcript = { caseId: golden.id, runIndex, run: await ports.api.getRun(run.id), events };
  if (ports.onTranscript !== undefined) await ports.onTranscript(transcript);
  return transcript;
};

const resultOf = (golden: GoldenCase, transcripts: readonly Transcript[]): CaseResult => ({
  golden,
  runs: transcripts.map((transcript) => ({ runIndex: transcript.runIndex, runId: transcript.run.id, graded: grade(golden.graders, transcript) })),
});

export const runDataset = async (dataset: GoldenDataset, ports: EvalPorts): Promise<EvalReport> => {
  const results: CaseResult[] = [];
  for (const golden of dataset.cases) {
    const transcripts: Transcript[] = [];
    for (let runIndex = 0; runIndex < golden.runs; runIndex += 1) transcripts.push(await runOnce(ports, golden, runIndex));
    results.push(resultOf(golden, transcripts));
  }
  return buildReport(dataset, results);
};

export const replayDataset = (dataset: GoldenDataset, transcripts: readonly Transcript[]): EvalReport => {
  const known = new Set(dataset.cases.map((golden) => golden.id));
  for (const transcript of transcripts) {
    if (!known.has(transcript.caseId)) throw new EvalError(`transcript for unknown case ${transcript.caseId}`);
  }
  const results = dataset.cases.map((golden) => {
    const recorded = transcripts.filter((transcript) => transcript.caseId === golden.id).sort((a, b) => a.runIndex - b.runIndex);
    if (recorded.length !== golden.runs) throw new EvalError(`case ${golden.id} expects ${golden.runs} recorded run(s) but ${recorded.length} transcript(s) were given`);
    return resultOf(golden, recorded);
  });
  return buildReport(dataset, results);
};
