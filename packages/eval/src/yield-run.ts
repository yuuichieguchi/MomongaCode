import type { ContextMemory, WorkspaceStep } from './context-dataset.ts';
import { failedWithCleanup } from './context-live.ts';
import { resolvePolicyOverlay } from './context-policy.ts';
import type { PolicyOverlay } from './context-policy.ts';
import { driveRun } from './runner.ts';
import { answeredByOfRuns } from './run-tree.ts';
import type { EvalRunApi } from './runner.ts';
import type { Answerer, Transcript, TranscriptReflection } from './transcript.ts';
import type { YieldDataset, YieldFamily, YieldLearn, YieldReuse } from './yield-dataset.ts';

export const YIELD_ARMS = ['without', 'with'] as const;
export type YieldArm = (typeof YIELD_ARMS)[number];

export type YieldCandidate = ContextMemory;

export type YieldLearnHost = {
  cwd: string;
  api: EvalRunApi;
  candidatesOf(runId: string): Promise<YieldCandidate[]>;
  applyStep(step: WorkspaceStep): Promise<void>;
  close(): Promise<void>;
};

export type YieldReuseHost = {
  cwd: string;
  api: EvalRunApi;
  seedMemory(memory: YieldCandidate): Promise<{ id: string }>;
  close(): Promise<void>;
};

export type YieldPorts = {
  model: string;
  policy: PolicyOverlay;
  codeDigest: string;
  openLearn(family: YieldFamily): Promise<YieldLearnHost>;
  openReuse(family: YieldFamily, arm: YieldArm, learn: YieldLearnHost): Promise<YieldReuseHost>;
};

export type YieldFamilyRun = {
  familyId: string;
  learn: Transcript;
  candidates: YieldCandidate[];
  accepted: YieldCandidate[];
  without: Transcript;
  with?: { transcript: Transcript; seeded: string[] };
};

export const acceptedByAnchors = (candidates: readonly YieldCandidate[], anchors: readonly string[]): { accepted: YieldCandidate[]; rejected: YieldCandidate[] } => {
  const holdsAnchor = (candidate: YieldCandidate): boolean => anchors.some((anchor) => candidate.text.includes(anchor));
  return { accepted: candidates.filter(holdsAnchor), rejected: candidates.filter((candidate) => !holdsAnchor(candidate)) };
};

export const yieldCaseIdOf = (familyId: string, session: 'learn' | YieldArm): string => `${familyId}.${session}`;

type Closable = { close(): Promise<void> };

const within = async <Host extends Closable, Result>(label: string, host: Host, work: (host: Host) => Promise<Result>): Promise<Result> => {
  let outcome: { result: Result } | { error: unknown };
  try {
    outcome = { result: await work(host) };
  } catch (error) {
    outcome = { error };
  }
  try {
    await host.close();
  } catch (cleanup) {
    if ('result' in outcome) throw cleanup;
    throw failedWithCleanup(outcome.error, cleanup, `${label} failed and its temporary home was not released`);
  }
  if ('error' in outcome) throw outcome.error;
  return outcome.result;
};

type Played = { transcript: Transcript; runId: string };

const playSession = async (
  ports: YieldPorts,
  host: { cwd: string; api: EvalRunApi },
  caseId: string,
  task: YieldLearn | YieldReuse,
  reflectionOf: (runId: string) => Promise<TranscriptReflection | undefined>,
): Promise<Played> => {
  const session = await host.api.createSession({ cwd: host.cwd, permissionMode: task.permissionMode, model: ports.model });
  const run = await host.api.createRun(session.id, { input: task.input, ...(task.timeoutMs === undefined ? {} : { timeoutMs: task.timeoutMs }) });
  const driven = await driveRun(host.api, { id: caseId, onAsk: task.onAsk }, run.id);
  const info = await host.api.getRun(run.id);
  const reflection = await reflectionOf(run.id);
  const answeredBy = await answeredByOfRuns((runId) => host.api.answeredBy(runId), [run.id, ...driven.children.map((child) => child.runId)]);
  return {
    runId: run.id,
    transcript: {
      caseId,
      runIndex: 0,
      run: info,
      ...driven,
      answeredBy,
      ...(reflection === undefined ? {} : { reflection }),
      policy: resolvePolicyOverlay(ports.policy),
      codeDigest: ports.codeDigest,
    },
  };
};

const playReuse = (ports: YieldPorts, family: YieldFamily, arm: YieldArm, learn: YieldLearnHost, memories: readonly YieldCandidate[]): Promise<{ transcript: Transcript; seeded: string[] }> =>
  ports.openReuse(family, arm, learn).then((opened) =>
    within(`the ${arm} arm of family ${family.id}`, opened, async (host) => {
      const seeded: string[] = [];
      for (const memory of memories) seeded.push((await host.seedMemory(memory)).id);
      const { transcript } = await playSession(ports, host, yieldCaseIdOf(family.id, arm), family.reuse, async () => undefined);
      return { transcript, seeded };
    }),
  );

const playFamily = async (ports: YieldPorts, family: YieldFamily): Promise<YieldFamilyRun> =>
  within(`the learn session of family ${family.id}`, await ports.openLearn(family), async (learn) => {
    const played = await playSession(ports, learn, yieldCaseIdOf(family.id, 'learn'), family.learn, (runId) => learn.api.reflectionOf(runId));
    const candidates = await learn.candidatesOf(played.runId);
    const { accepted } = acceptedByAnchors(candidates, family.accept.anchors);
    for (const step of family.learn.workspace ?? []) await learn.applyStep(step);
    const without = await playReuse(ports, family, 'without', learn, []);
    const withArm = accepted.length === 0 ? undefined : await playReuse(ports, family, 'with', learn, accepted);
    return { familyId: family.id, learn: played.transcript, candidates, accepted, without: without.transcript, ...(withArm === undefined ? {} : { with: withArm }) };
  });

export const runYieldDataset = async (dataset: YieldDataset, ports: YieldPorts): Promise<YieldFamilyRun[]> => {
  const runs: YieldFamilyRun[] = [];
  for (const family of dataset.families) runs.push(await playFamily(ports, family));
  return runs;
};
