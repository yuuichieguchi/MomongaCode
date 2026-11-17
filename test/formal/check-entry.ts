import { systemWaitTiming, waitForGroupGone } from '@momonga/foundation';
import type { ProcessGroupPort, Timing } from '@momonga/foundation';
import type { ManifestEntry, Tier, TlcRun, TlcRunOptions } from './manifest-reader.ts';
import { measurementOfRun } from './record.ts';
import type { Measurement } from './record.ts';
import { RAN_REASONS, RECORD_FORMAT, keyOf, keyPartsOf, refusalOf, sealedRecord } from './reuse.ts';
import type { JavaIdentity, RanReason, ResultStore, StoredFacts } from './reuse.ts';
import { TLC_WORKERS, runTlc } from './runner.ts';
import { factsOf, problemsOf, verdictProblems } from './verdict.ts';

export type CheckRequest = {
  entry: ManifestEntry;
  script: string;
  repoRoot: string;
  mode: 'on' | 'off';
  env: Readonly<Record<string, string | undefined>>;
  store: ResultStore;
  java: (limitMs: number) => Promise<JavaIdentity | undefined>;
  limitMs: number;
  now: () => Date;
  groupPort?: ProcessGroupPort;
  timing?: Timing;
  record: boolean;
  loadAverage: () => number;
  run?: (options: TlcRunOptions) => Promise<TlcRun>;
};

export type CheckOutcome =
  | { outcome: 'reused'; producedAt: string }
  | { outcome: 'ran'; reason: RanReason; problems: readonly string[]; stored: 'stored' | 'not eligible' | { notStored: string }; measurement?: Measurement; loadAtStart?: number };

const FIXED_FINGERPRINT_ARGS = ['-fp', '0'] as const;

type FinishedRun = { readonly run: TlcRun; readonly problems: readonly string[]; readonly wallSeconds: number; readonly loadAtStart: number };

const runAndJudge = async (request: CheckRequest, args: readonly string[]): Promise<FinishedRun> => {
  const { entry } = request;
  const timing = request.timing ?? systemWaitTiming;
  const loadAtStart = request.loadAverage();
  const started = timing.monotonicMs();
  const deadline = started + request.limitMs;
  const run = await (request.run ?? runTlc)({ script: request.script, config: entry.config, args, budgetCpuSeconds: entry.budgetCpuSeconds });
  const wallSeconds = (timing.monotonicMs() - started) / 1000;
  const groupGone = await waitForGroupGone(run.pid, deadline, request.groupPort, timing);
  return { run, wallSeconds, loadAtStart, problems: [...verdictProblems(entry, run), ...(groupGone ? [] : [`${entry.config}: process group ${run.pid} still has members after the run`])] };
};

const measuredOf = (request: CheckRequest, finished: FinishedRun): Pick<Extract<CheckOutcome, { outcome: 'ran' }>, 'measurement' | 'loadAtStart'> =>
  request.record && finished.problems.length === 0 ? { measurement: measurementOfRun(finished.run, finished.wallSeconds), loadAtStart: finished.loadAtStart } : {};

const runFresh = async (request: CheckRequest, reason: RanReason): Promise<CheckOutcome> => {
  const finished = await runAndJudge(request, request.entry.args);
  return { outcome: 'ran', reason, problems: finished.problems, stored: 'not eligible', ...measuredOf(request, finished) };
};

const storedFactsOf = (run: TlcRun): StoredFacts | undefined => {
  const facts = factsOf(run);
  const { exitCode, signal } = facts;
  if (run.killedAtCpuBudget || signal !== null || (exitCode !== 0 && exitCode !== 12 && exitCode !== 13)) return undefined;
  return { ...facts, exitCode, signal };
};

type KeyedRead = { readonly unkeyed: RanReason } | { readonly key: string };

const keyOfRun = async (request: Pick<CheckRequest, 'entry' | 'repoRoot' | 'mode' | 'env' | 'java' | 'limitMs'>, args: readonly string[]): Promise<KeyedRead> => {
  if (request.mode === 'off') return { unkeyed: 'reuse off' };
  const refusal = refusalOf(request.env);
  if (refusal !== undefined) return { unkeyed: refusal };
  const java = await request.java(request.limitMs);
  if (java === undefined) return { unkeyed: 'java not readable' };
  const parts = await keyPartsOf({ repoRoot: request.repoRoot, entry: request.entry, args, workers: TLC_WORKERS, java });
  return 'unreadable' in parts ? { unkeyed: 'input not readable' } : { key: keyOf(parts) };
};

export const reusableOf = async (request: Pick<CheckRequest, 'entry' | 'repoRoot' | 'mode' | 'env' | 'store' | 'java' | 'limitMs'>): Promise<boolean> => {
  if (request.mode === 'off') return false;
  const keyed = await keyOfRun(request, [...request.entry.args, ...FIXED_FINGERPRINT_ARGS]);
  if ('unkeyed' in keyed) return false;
  const found = await request.store.read(request.entry.config, keyed.key);
  return found.kind === 'hit' && problemsOf(request.entry, found.record.facts).length === 0;
};

export const checkEntry = async (request: CheckRequest): Promise<CheckOutcome> => {
  const { entry, store } = request;
  const args = [...entry.args, ...FIXED_FINGERPRINT_ARGS];
  const keyed = await keyOfRun(request, args);
  if ('unkeyed' in keyed) return runFresh(request, keyed.unkeyed);
  const found = await store.read(entry.config, keyed.key);
  if (found.kind === 'hit' && problemsOf(entry, found.record.facts).length === 0) return { outcome: 'reused', producedAt: found.record.producedAt };
  const reason: RanReason = found.kind === 'hit' ? 'record does not satisfy the manifest entry' : found.reason;
  const finished = await runAndJudge(request, args);
  const { run, problems } = finished;
  const facts = storedFactsOf(run);
  if (problems.length > 0 || facts === undefined) return { outcome: 'ran', reason, problems, stored: 'not eligible', ...measuredOf(request, finished) };
  const keyedAfter = await keyOfRun(request, args);
  if ('unkeyed' in keyedAfter || keyedAfter.key !== keyed.key) return { outcome: 'ran', reason: 'inputs changed during the run', problems, stored: 'not eligible' };
  const written = await store.write(sealedRecord({ format: RECORD_FORMAT, key: keyed.key, config: entry.config, facts, producedAt: request.now().toISOString() }));
  return { outcome: 'ran', reason, problems, stored: written.stored ? 'stored' : { notStored: written.reason }, ...measuredOf(request, finished) };
};

type TierReport = {
  add(config: string, outcome: CheckOutcome): void;
  lines(): string[];
  print(write?: (text: string) => unknown): void;
};

const groupedLines = (label: string, groups: ReadonlyMap<string, readonly string[]>, order: readonly string[]): string[] =>
  order.filter((reason) => groups.has(reason)).map((reason) => `${label} (${reason}): ${(groups.get(reason) as readonly string[]).length}: ${(groups.get(reason) as readonly string[]).join(', ')}`);

const appendTo = (groups: Map<string, string[]>, reason: string, config: string): void => {
  groups.set(reason, [...(groups.get(reason) ?? []), config]);
};

export const createTierReport = (tier: Tier): TierReport => {
  const reusedAt: string[] = [];
  const ran = new Map<string, string[]>();
  const notStored = new Map<string, string[]>();
  const lines = (): string[] => {
    const ranCount = [...ran.values()].reduce((total, configs) => total + configs.length, 0);
    const total = reusedAt.length + ranCount;
    if (total === 0) return [];
    const produced = [...reusedAt].sort();
    return [
      `TLC ${tier}: ${total} configurations, ${reusedAt.length} reused, ${ranCount} ran`,
      ...(produced.length > 0 ? [`reused: ${produced.length} (records produced ${produced[0]} to ${produced.at(-1)})`] : []),
      ...groupedLines('ran', ran, RAN_REASONS),
      ...groupedLines('not stored', notStored, [...notStored.keys()]),
    ];
  };
  return {
    add: (config, outcome) => {
      if (outcome.outcome === 'reused') {
        reusedAt.push(outcome.producedAt);
        return;
      }
      appendTo(ran, outcome.reason, config);
      if (typeof outcome.stored === 'object') appendTo(notStored, outcome.stored.notStored, config);
    },
    lines,
    print: (write = (text: string) => process.stderr.write(text)) => {
      for (const line of lines()) write(`${line}\n`);
    },
  };
};
