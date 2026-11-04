import type { PublicRunEvent } from '@momonga/protocol';
import type { GoldenCase, GoldenDataset } from './dataset.ts';
import { grade } from './graders.ts';
import { buildReport } from './report.ts';
import type { CaseResult, EvalReport } from './report.ts';
import type { RecordedRun, Transcript, TranscriptChild, TranscriptReflection, TranscriptRun } from './transcript.ts';

export type EvalWorkspace = { cwd: string; env: Record<string, string> };

export type EvalSessionInput = { cwd: string; env?: Record<string, string>; permissionMode: GoldenCase['permissionMode']; modelAlias?: string };

export type EvalRunApi = {
  createSession(input: EvalSessionInput): Promise<{ id: string }>;
  createRun(sessionId: string, input: { input: string; timeoutMs?: number }): Promise<{ id: string }>;
  events(runId: string): AsyncIterable<PublicRunEvent>;
  getRun(runId: string): Promise<TranscriptRun>;
  reflectionOf(runId: string): Promise<TranscriptReflection>;
  resolveApproval(approvalId: string, optionId: string): Promise<void>;
  cancelRun(runId: string): Promise<void>;
};

export type EvalPorts = {
  api: EvalRunApi;
  workspace(golden: GoldenCase, runIndex: number): Promise<EvalWorkspace>;
  onTranscript?(transcript: RecordedRun): Promise<void>;
};

export class EvalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EvalError';
  }
}

const optionIdFor = (event: Extract<PublicRunEvent, { type: 'tool.permission.requested' }>, golden: Pick<GoldenCase, 'id' | 'onAsk'>): string => {
  const option = event.options.find((candidate) => candidate.kind === golden.onAsk);
  if (option === undefined) throw new EvalError(`case ${golden.id}: approval ${event.approvalId} offers no ${golden.onAsk} option`);
  return option.optionId;
};

export type Driven = { events: PublicRunEvent[]; children: TranscriptChild[] };

export const driveRun = async (api: EvalRunApi, golden: Pick<GoldenCase, 'id' | 'onAsk'>, rootRunId: string): Promise<Driven> => {
  const events: PublicRunEvent[] = [];
  const children: TranscriptChild[] = [];
  const followed = new Set<string>([rootRunId]);
  const following: Promise<void>[] = [];
  const failures: unknown[] = [];

  const abandon = async (error: unknown): Promise<void> => {
    failures.push(error);
    try {
      await api.cancelRun(rootRunId);
    } catch (cancelError) {
      failures.push(new EvalError(`case ${golden.id}: cancelling run ${rootRunId} after a run failed also failed: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`, { cause: cancelError }));
    }
  };

  const follow = async (runId: string, sink: PublicRunEvent[]): Promise<void> => {
    for await (const event of api.events(runId)) {
      sink.push(event);
      if (event.type === 'tool.permission.requested') await api.resolveApproval(event.approvalId, optionIdFor(event, golden));
      if (event.type === 'tool.waiting' && event.awaits.kind === 'run' && !followed.has(event.awaits.runId)) {
        followed.add(event.awaits.runId);
        const child: TranscriptChild = { runId: event.awaits.runId, agent: event.awaits.agent, events: [] };
        children.push(child);
        following.push(follow(child.runId, child.events).catch(abandon));
      }
    }
  };

  await follow(rootRunId, events).catch(abandon);
  for (let index = 0; index < following.length; index += 1) await following[index];
  const [first, ...rest] = failures;
  if (rest.length > 0) {
    throw new EvalError(`case ${golden.id}: ${failures.length} failures: ${failures.map((failure) => (failure instanceof Error ? failure.message : String(failure))).join('; ')}`, {
      cause: new AggregateError(failures),
    });
  }
  if (failures.length === 1) throw first;
  return { events, children };
};

const runOnce = async (ports: EvalPorts, golden: GoldenCase, runIndex: number): Promise<RecordedRun> => {
  const workspace = await ports.workspace(golden, runIndex);
  const session = await ports.api.createSession({ ...workspace, permissionMode: golden.permissionMode });
  const run = await ports.api.createRun(session.id, { input: golden.input, ...(golden.timeoutMs === undefined ? {} : { timeoutMs: golden.timeoutMs }) });
  const { events, children } = await driveRun(ports.api, golden, run.id);
  const transcript: RecordedRun = { caseId: golden.id, runIndex, run: await ports.api.getRun(run.id), events, children, reflection: await ports.api.reflectionOf(run.id) };
  if (ports.onTranscript !== undefined) await ports.onTranscript(transcript);
  return transcript;
};

const resultOf = (golden: GoldenCase, transcripts: readonly RecordedRun[]): CaseResult => ({
  golden,
  runs: transcripts.map((transcript) => ({ runIndex: transcript.runIndex, runId: transcript.run.id, graded: grade(golden.graders, transcript) })),
});

export const runDataset = async (dataset: GoldenDataset, ports: EvalPorts): Promise<EvalReport> => {
  const results: CaseResult[] = [];
  for (const golden of dataset.cases) {
    const transcripts: RecordedRun[] = [];
    for (let runIndex = 0; runIndex < golden.runs; runIndex += 1) transcripts.push(await runOnce(ports, golden, runIndex));
    results.push(resultOf(golden, transcripts));
  }
  return buildReport(dataset, results);
};

export const transcriptsByCase = <C extends GoldenCase>(cases: readonly C[], transcripts: readonly Transcript[]): { golden: C; recorded: Transcript[] }[] => {
  const known = new Set(cases.map((golden) => golden.id));
  for (const transcript of transcripts) {
    if (!known.has(transcript.caseId)) throw new EvalError(`transcript for unknown case ${transcript.caseId}`);
  }
  return cases.map((golden) => {
    const recorded = transcripts.filter((transcript) => transcript.caseId === golden.id).sort((a, b) => a.runIndex - b.runIndex);
    if (recorded.length !== golden.runs) throw new EvalError(`case ${golden.id} expects ${golden.runs} recorded run(s) but ${recorded.length} transcript(s) were given`);
    return { golden, recorded };
  });
};

export const replayDataset = (dataset: GoldenDataset, transcripts: readonly Transcript[]): EvalReport =>
  buildReport(
    dataset,
    transcriptsByCase(dataset.cases, transcripts).map(({ golden, recorded }) => resultOf(golden, recorded)),
  );
