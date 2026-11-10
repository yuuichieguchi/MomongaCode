import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, isRecord, lexicallyWithin } from '@momonga/foundation';
import type { AddRuleRequest } from '@momonga/protocol';
import type { CompactionSetting, ContextDataset, ContextMemory, ContextRule, ExpandedCase, ExpandedContextDataset, WorkspaceStep } from './context-dataset.ts';
import { resolvePolicyOverlay } from './context-policy.ts';
import type { PolicyOverlay } from './context-policy.ts';
import { isInsideWorkspace } from './dataset.ts';
import { EvalError, driveRun } from './runner.ts';
import type { Driven, EvalRunApi } from './runner.ts';
import type { Answerer, Transcript, TranscriptRun } from './transcript.ts';

export type LiveBounds = { datasetTokens: number; caseDeadlineMs: Record<string, number> };

export type LiveLimits = { maxTotalTokens: number; defaultTimeoutMs: number };

export type ContextCaseHost = {
  cwd: string;
  api: EvalRunApi;
  rules: {
    add(request: AddRuleRequest): Promise<{ fact: { id: string } }>;
    retire(id: string): Promise<void>;
  };
  seedMemory(memory: ContextMemory): Promise<void>;
  applyStep(step: WorkspaceStep): Promise<void>;
  close(): Promise<void>;
};

export type ContextRunPorts = {
  policy: PolicyOverlay;
  codeDigest: string;
  openCase(entry: ExpandedCase): Promise<ContextCaseHost>;
  model: string;
  deadline(caseId: string, signal: AbortSignal): Promise<void>;
  bounds: LiveBounds;
  onTranscript?(transcript: Transcript): Promise<void>;
};

export type ContextRunResult = { transcripts: Transcript[] };

export const OUT_OF_SCOPE_PATH = '.momonga-eval-out-of-scope/**';

export const COST_CAP_REASON = 'the dataset reached its cost cap before this run started';

export const DEADLINE_REASON = 'the case deadline passed';

export const liveBoundsFor = (dataset: ContextDataset, limits: LiveLimits): LiveBounds => {
  const turnsOf = (entry: ContextDataset['cases'][number]): number => entry.runs * (1 + entry.noise.level);
  return {
    datasetTokens: dataset.cases.reduce((sum, entry) => sum + turnsOf(entry) * limits.maxTotalTokens, 0),
    caseDeadlineMs: Object.fromEntries(dataset.cases.map((entry) => [entry.id, turnsOf(entry) * (entry.timeoutMs ?? limits.defaultTimeoutMs)])),
  };
};

const POLICY_SECTIONS = ['context', 'tools', 'memory'] as const;

const sectionOf = (base: Readonly<Record<string, unknown>>, name: string): Record<string, unknown> | undefined => {
  const section = base[name];
  if (section !== undefined && !isRecord(section)) throw new EvalError(`the base settings hold a ${name} section that is not an object`);
  return section;
};

const mergedSection = (base: Readonly<Record<string, unknown>>, overlay: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries([
    ...Object.entries(base),
    ...Object.entries(overlay).map(([key, value]): [string, unknown] => {
      const below = base[key];
      return [key, isRecord(value) && isRecord(below) ? mergedSection(below, value) : value];
    }),
  ]);

export const caseSettingsFor = (
  base: Readonly<Record<string, unknown>>,
  setting: { compaction?: CompactionSetting; policy?: PolicyOverlay; classifier?: string },
): Record<string, unknown> => {
  const merged: Record<string, unknown> = { ...base };
  for (const name of POLICY_SECTIONS) {
    const overlay = setting.policy?.[name];
    if (overlay !== undefined) merged[name] = mergedSection(sectionOf(base, name) ?? {}, overlay);
  }
  const compacted = setting.compaction === undefined ? merged : { ...merged, context: { ...sectionOf(merged, 'context'), autoCompact: setting.compaction === 'on' } };
  return setting.classifier === undefined ? compacted : { ...compacted, autoMode: { classifier: setting.classifier } };
};

const outsideMessage = (root: string, name: string): string => `workspace step names ${JSON.stringify(name)}, which resolves outside ${root}`;

const deepestExisting = async (target: string): Promise<string> => {
  let candidate = target;
  for (;;) {
    try {
      await fs.lstat(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      candidate = path.dirname(candidate);
    }
  }
};

const resolvedInside = async (root: string, name: string): Promise<string> => {
  if (!isInsideWorkspace(name)) throw new EvalError(`workspace step names ${JSON.stringify(name)}; steps must use relative paths inside the workspace`);
  const real = await fs.realpath(root);
  const target = path.join(real, name);
  const anchor = await deepestExisting(path.dirname(target));
  if (!lexicallyWithin(await fs.realpath(anchor), real)) throw new EvalError(outsideMessage(root, name));
  return target;
};

export const applyWorkspaceStep = async (root: string, step: WorkspaceStep): Promise<void> => {
  for (const [name, content] of Object.entries(step.write ?? {})) {
    const target = await resolvedInside(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const real = await fs.realpath(root);
    if (!lexicallyWithin(await fs.realpath(path.dirname(target)), real)) throw new EvalError(outsideMessage(root, name));
    await fs.writeFile(target, content);
  }
  for (const name of step.remove ?? []) {
    const target = await resolvedInside(root, name);
    await fs.rm(target);
  }
};

const installRules = async (entry: ExpandedCase, host: ContextCaseHost): Promise<Record<string, string>> => {
  const added = new Map<string, string>();
  const pending: ContextRule[] = [...entry.rules];
  while (pending.length > 0) {
    const index = pending.findIndex((rule) => rule.supersedes.every((id) => added.has(id)));
    const rule = pending[index];
    if (rule === undefined) throw new EvalError(`case ${entry.id}: the rules supersede each other in a cycle`);
    pending.splice(index, 1);
    const { fact } = await host.rules.add({
      kind: rule.kind,
      target: rule.target,
      text: rule.text,
      scope: { level: 'project', project: host.cwd, paths: rule.inScope ? [] : [OUT_OF_SCOPE_PATH] },
      supersedes: rule.supersedes.map((id) => {
        const productId = added.get(id);
        if (productId === undefined) throw new EvalError(`case ${entry.id}: rule ${rule.id} supersedes ${id}, which was not added`);
        return productId;
      }),
      enforcement: null,
    });
    added.set(rule.id, fact.id);
    if (!rule.live) await host.rules.retire(fact.id);
  }
  return Object.fromEntries([...added].map(([datasetId, productId]) => [productId, datasetId]));
};

type Measured = Omit<Transcript, 'policy' | 'codeDigest'>;

const stoppedBeforeStart = (entry: ExpandedCase, runIndex: number, reason: string, details: Pick<Transcript, 'ruleIds' | 'datasetSeed'>, model: string): Measured => ({
  caseId: entry.id,
  runIndex,
  run: { id: `stopped-${entry.id}-${runIndex}`, status: 'FAILED', step: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, model },
  events: [],
  children: [],
  answeredBy: [],
  stopped: reason,
  ...details,
});

type CaseState = { spent: number };

const answeredByOfRuns = async (api: ContextCaseHost['api'], runIds: readonly string[]): Promise<Answerer[]> => {
  const unique = new Map<string, Answerer>();
  for (const runId of runIds) {
    for (const answerer of await api.answeredBy(runId)) unique.set(canonicalJson(answerer), answerer);
  }
  return [...unique.values()];
};

const runCase = async (
  expanded: ExpandedContextDataset,
  entry: ExpandedCase,
  host: ContextCaseHost,
  ports: ContextRunPorts,
  state: CaseState,
  emit: (transcript: Measured) => Promise<void>,
): Promise<void> => {
  const ruleIds = await installRules(entry, host);
  for (const memory of entry.memories ?? []) await host.seedMemory(memory);
  const watch = new AbortController();
  const expiry = { passed: false };
  const expired = ports.deadline(entry.id, watch.signal).then(() => {
    expiry.passed = true;
  });
  const tagged = (): Pick<Transcript, 'ruleIds' | 'datasetSeed'> => ({ ...(Object.keys(ruleIds).length === 0 ? {} : { ruleIds }), datasetSeed: expanded.seed });
  const placeholder = (runIndex: number, reason: string): Measured => stoppedBeforeStart(entry, runIndex, reason, tagged(), ports.model);
  const driveWithin = async (runId: string): Promise<{ driven: Driven; expired: boolean }> => {
    const driving = driveRun(host.api, entry, runId);
    const first = await Promise.race([driving.then(() => 'done' as const), expired.then(() => 'expired' as const)]);
    if (first === 'done') return { driven: await driving, expired: false };
    await host.api.cancelRun(runId);
    return { driven: await driving, expired: true };
  };
  const measure = async (runId: string): Promise<TranscriptRun> => {
    const info = await host.api.getRun(runId);
    state.spent += info.usage.totalTokens;
    return info;
  };

  let started = false;
  let stop: string | undefined;
  const refusal = (): string | undefined => {
    if (state.spent >= ports.bounds.datasetTokens) return COST_CAP_REASON;
    return started && expiry.passed ? DEADLINE_REASON : undefined;
  };

  const playRun = async (runIndex: number): Promise<void> => {
    stop ??= refusal();
    if (stop !== undefined) return emit(placeholder(runIndex, stop));
    for (const step of (entry.workspace ?? []).filter((candidate) => candidate.beforeRun === runIndex)) await host.applyStep(step);
    const session = await host.api.createSession({ cwd: host.cwd, permissionMode: entry.permissionMode, model: ports.model });
    let noiseTokens = 0;
    let noiseReflectionsUnsettled = 0;
    for (const turn of entry.noiseTurns) {
      stop = refusal();
      if (stop !== undefined) break;
      const noise = await host.api.createRun(session.id, { input: turn.user });
      started = true;
      const outcome = await driveWithin(noise.id);
      noiseTokens += (await measure(noise.id)).usage.totalTokens;
      const reflected = await host.api.reflectionOf(noise.id);
      const reflectionTokens = (reflected.charges ?? []).reduce((sum, charge) => sum + charge.totalTokens, 0);
      noiseTokens += reflectionTokens;
      state.spent += reflectionTokens;
      if (reflected.state === 'pending' || reflected.state === 'running') noiseReflectionsUnsettled += 1;
      if (outcome.expired) stop = DEADLINE_REASON;
      if (stop !== undefined) break;
    }
    stop ??= refusal();
    if (stop !== undefined) return emit(placeholder(runIndex, stop));
    const run = await host.api.createRun(session.id, { input: entry.input, ...(entry.timeoutMs === undefined ? {} : { timeoutMs: entry.timeoutMs }) });
    started = true;
    const outcome = await driveWithin(run.id);
    const info = await measure(run.id);
    const reflection = await host.api.reflectionOf(run.id);
    state.spent += (reflection.charges ?? []).reduce((sum, charge) => sum + charge.totalTokens, 0);
    const noise = entry.noiseTurns.length === 0 ? {} : { noiseTokens, noiseReflectionsUnsettled };
    const answeredBy = await answeredByOfRuns(host.api, [run.id, ...outcome.driven.children.map((child) => child.runId)]);
    if (!outcome.expired) return emit({ caseId: entry.id, runIndex, run: info, ...outcome.driven, answeredBy, reflection, ...tagged(), ...noise });
    stop = DEADLINE_REASON;
    const { stopReason: _cancelled, ...rest } = info;
    return emit({ caseId: entry.id, runIndex, run: { ...rest, status: 'FAILED' }, ...outcome.driven, answeredBy, reflection, stopped: stop, ...tagged(), ...noise });
  };

  try {
    for (let runIndex = 0; runIndex < entry.runs; runIndex += 1) await playRun(runIndex);
  } finally {
    watch.abort();
    await expired.catch((error: unknown) => {
      if (error !== watch.signal.reason) throw error;
    });
  }
};

export const failedWithCleanup = (error: unknown, cleanup: unknown, message: string): AggregateError => new AggregateError([error, cleanup], message);

export const runContextDataset = async (expanded: ExpandedContextDataset, ports: ContextRunPorts): Promise<ContextRunResult> => {
  const transcripts: Transcript[] = [];
  const state: CaseState = { spent: 0 };
  const emit = async (measured: Measured): Promise<void> => {
    const transcript: Transcript = { ...measured, policy: resolvePolicyOverlay(ports.policy), codeDigest: ports.codeDigest };
    transcripts.push(transcript);
    if (ports.onTranscript !== undefined) await ports.onTranscript(transcript);
  };
  for (const entry of expanded.cases) {
    if (state.spent >= ports.bounds.datasetTokens) {
      for (let runIndex = 0; runIndex < entry.runs; runIndex += 1) {
        await emit(stoppedBeforeStart(entry, runIndex, COST_CAP_REASON, { datasetSeed: expanded.seed }, ports.model));
      }
      continue;
    }
    const host = await ports.openCase(entry);
    let failure: { error: unknown } | undefined;
    try {
      await runCase(expanded, entry, host, ports, state, emit);
    } catch (error) {
      failure = { error };
    }
    try {
      await host.close();
    } catch (cleanup) {
      if (failure === undefined) throw cleanup;
      throw failedWithCleanup(failure.error, cleanup, `case ${entry.id} failed and its temporary home was not released`);
    }
    if (failure !== undefined) throw failure.error;
  }
  return { transcripts };
};
