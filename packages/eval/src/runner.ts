import type { Mandate, PublicRunEvent } from '@momonga/protocol';
import { gradeChecks } from './oracle-grade.ts';
import type { WorkspaceFiles } from './files.ts';
import type { WorkspaceProbe } from './oracle-grade.ts';
import { gateVerdictOf } from './oracle.ts';
import type { GoldenCase, GoldenDataset } from './dataset.ts';
import { runFiguresOf } from './budget-metrics.ts';
import type { CaseLimits } from './dataset.ts';
import { grade } from './graders.ts';
import { buildReport } from './report.ts';
import type { CaseResult, EvalReport } from './report.ts';
import type { Answerer, RecordedRun, Transcript, TranscriptChild, TranscriptReflection, TranscriptRun } from './transcript.ts';

export type EvalWorkspace = { cwd: string; env: Record<string, string> };

export type EvalSessionInput = { cwd: string; env?: Record<string, string>; permissionMode: GoldenCase['permissionMode']; model?: string };

export type EvalRunApi = {
  createSession(input: EvalSessionInput): Promise<{ id: string }>;
  createRun(sessionId: string, input: { input: string; timeoutMs?: number; limits?: CaseLimits; mandate?: Mandate }): Promise<{ id: string }>;
  events(runId: string): AsyncIterable<PublicRunEvent>;
  getRun(runId: string): Promise<TranscriptRun>;
  answeredBy(runId: string): Promise<Answerer[]>;
  reflectionOf(runId: string): Promise<TranscriptReflection>;
  resolveApproval(approvalId: string, optionId: string): Promise<void>;
  cancelRun(runId: string): Promise<void>;
};

export type EvalOracle = { base: string; probe: WorkspaceProbe; files: WorkspaceFiles };

export type EvalRunScope = { api: EvalRunApi; workspace: EvalWorkspace; oracle?: EvalOracle; close(): Promise<void> };

export type EvalPorts = {
  open(golden: GoldenCase, runIndex: number): Promise<EvalRunScope>;
  model?: string;
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

export const driveRun = async (api: Pick<EvalRunApi, 'events' | 'resolveApproval' | 'cancelRun'>, golden: Pick<GoldenCase, 'id' | 'onAsk' | 'mandate'>, rootRunId: string): Promise<Driven> => {
  const events: PublicRunEvent[] = [];
  const children: TranscriptChild[] = [];
  const followed = new Set<string>([rootRunId]);
  const following: Promise<void>[] = [];
  const failures: unknown[] = [];
  const staysHeld = golden.mandate?.hold?.onQuiescent === 'report';
  const leftHeld = Promise.withResolvers<void>();
  let ended = false;

  const abandon = async (error: unknown): Promise<void> => {
    if (ended) return;
    failures.push(error);
    try {
      await api.cancelRun(rootRunId);
    } catch (cancelError) {
      failures.push(new EvalError(`case ${golden.id}: cancelling run ${rootRunId} after a run failed also failed: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`, { cause: cancelError }));
    }
  };

  const answerUnknownEffect = async (event: Extract<PublicRunEvent, { type: 'tool.unknown.requested' }>): Promise<void> => {
    const option = event.options.find((candidate) => candidate.kind === golden.onAsk);
    if (option === undefined) await api.cancelRun(rootRunId);
    else await api.resolveApproval(event.approvalId, option.optionId);
  };

  const follow = async (runId: string, sink: PublicRunEvent[]): Promise<void> => {
    for await (const event of api.events(runId)) {
      sink.push(event);
      if (event.type === 'tool.permission.requested') await api.resolveApproval(event.approvalId, optionIdFor(event, golden));
      if (event.type === 'tool.unknown.requested') await answerUnknownEffect(event);
      if (event.type === 'run.quiescent') {
        if (staysHeld) {
          leftHeld.resolve();
          return;
        }
        for (const held of event.held) await api.resolveApproval(held.approvalId, golden.onAsk);
      }
      if (event.type === 'tool.waiting' && event.awaits.kind === 'run' && !followed.has(event.awaits.runId)) {
        followed.add(event.awaits.runId);
        const child: TranscriptChild = { runId: event.awaits.runId, agent: event.awaits.agent, events: [] };
        children.push(child);
        following.push(follow(child.runId, child.events).catch(abandon));
      }
    }
  };

  const followedToTheEnd = async (): Promise<void> => {
    await follow(rootRunId, events).catch(abandon);
    for (let index = 0; index < following.length; index += 1) await following[index];
  };
  const everyRunEnded = followedToTheEnd();
  await Promise.race([leftHeld.promise, everyRunEnded]);
  ended = true;
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
  const scope = await ports.open(golden, runIndex);
  try {
    const session = await scope.api.createSession({
      ...scope.workspace,
      permissionMode: golden.permissionMode,
      ...(ports.model === undefined ? {} : { model: ports.model }),
    });
    if (golden.oracle !== undefined && scope.oracle === undefined) throw new EvalError(`case ${golden.id} declares an oracle but the run has no way to run it`);
    const run = await scope.api.createRun(session.id, {
      input: golden.input,
      ...(golden.timeoutMs === undefined ? {} : { timeoutMs: golden.timeoutMs }),
      ...(golden.limits === undefined ? {} : { limits: golden.limits }),
      ...(golden.completion === undefined && golden.mandate === undefined ? {} : { mandate: { ...golden.mandate, ...(golden.completion === undefined ? {} : { completion: golden.completion }) } }),
    });
    const { events, children } = await driveRun(scope.api, golden, run.id);
    const oracle =
      golden.oracle === undefined || scope.oracle === undefined
        ? undefined
        : await gradeChecks({ checks: golden.oracle, graderFiles: {}, workspace: scope.workspace.cwd, base: scope.oracle.base, probe: scope.oracle.probe, files: scope.oracle.files });
    const transcript: RecordedRun = {
      caseId: golden.id,
      runIndex,
      run: await scope.api.getRun(run.id),
      events,
      children,
      reflection: await scope.api.reflectionOf(run.id),
      ...(oracle === undefined ? {} : { oracle }),
    };
    if (ports.onTranscript !== undefined) await ports.onTranscript(transcript);
    return transcript;
  } finally {
    await scope.close();
  }
};

const resultOf = (golden: GoldenCase, transcripts: readonly RecordedRun[]): CaseResult => ({
  golden,
  runs: transcripts.map((transcript) => ({
    runIndex: transcript.runIndex,
    runId: transcript.run.id,
    graded: grade(golden.graders, transcript),
    figures: runFiguresOf(golden, transcript),
    ...(transcript.oracle === undefined ? {} : { completion: { gate: gateVerdictOf(transcript.run, transcript.events), oracle: transcript.oracle.met } }),
  })),
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
