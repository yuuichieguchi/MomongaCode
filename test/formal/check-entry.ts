import { realGroupTiming, waitForGroupGone } from '@momonga/foundation';
import type { ProcessGroupPort, Timing } from '@momonga/foundation';
import type { ManifestEntry, Tier, TlcRun } from './manifest-reader.ts';
import { RAN_REASONS, RECORD_FORMAT, keyOf, keyPartsOf, refusalOf, sealedRecord } from './reuse.ts';
import type { JavaIdentity, RanReason, ResultStore, StoredFacts } from './reuse.ts';
import { TLC_WORKERS, runTlc } from './runner.ts';
import { factsOf, problemsOf, verdictProblems } from './verdict.ts';

export type CheckRequest = {
  entry: ManifestEntry;
  script: string;
  repoRoot: string;
  tier: Tier;
  mode: 'on' | 'off';
  env: Readonly<Record<string, string | undefined>>;
  store: ResultStore;
  java: (limitMs: number) => Promise<JavaIdentity | undefined>;
  limitMs: number;
  now: () => Date;
  groupPort?: ProcessGroupPort;
  timing?: Timing;
};

export type CheckOutcome =
  | { outcome: 'reused'; producedAt: string }
  | { outcome: 'ran'; reason: RanReason; problems: readonly string[]; stored: 'stored' | 'not eligible' | { notStored: string } };

const FIXED_FINGERPRINT_ARGS = ['-fp', '0'] as const;

type FinishedRun = { readonly run: TlcRun; readonly problems: readonly string[] };

const runAndJudge = async (request: CheckRequest, args: readonly string[]): Promise<FinishedRun> => {
  const { entry } = request;
  const timing = request.timing ?? realGroupTiming;
  const deadline = timing.monotonicMs() + request.limitMs;
  const run = await runTlc({ script: request.script, config: entry.config, args, budgetCpuSeconds: entry.budgetCpuSeconds });
  const groupGone = await waitForGroupGone(run.pid, deadline, request.groupPort, timing);
  return { run, problems: [...verdictProblems(entry, run), ...(groupGone ? [] : [`${entry.config}: process group ${run.pid} still has members after the run`])] };
};

const runFresh = async (request: CheckRequest, reason: RanReason): Promise<CheckOutcome> => {
  const { problems } = await runAndJudge(request, request.entry.args);
  return { outcome: 'ran', reason, problems, stored: 'not eligible' };
};

const storedFactsOf = (run: TlcRun): StoredFacts | undefined => {
  const facts = factsOf(run);
  const { exitCode, signal } = facts;
  if (run.killedAtCpuBudget || signal !== null || (exitCode !== 0 && exitCode !== 12 && exitCode !== 13)) return undefined;
  return { ...facts, exitCode, signal };
};

type KeyedRead = { readonly unkeyed: RanReason } | { readonly key: string };

const keyOfRun = async (request: CheckRequest, args: readonly string[]): Promise<KeyedRead> => {
  if (request.tier === 'deep') return { unkeyed: 'deep tier' };
  if (request.mode === 'off') return { unkeyed: 'reuse off' };
  const refusal = refusalOf(request.env);
  if (refusal !== undefined) return { unkeyed: refusal };
  const java = await request.java(request.limitMs);
  if (java === undefined) return { unkeyed: 'java not readable' };
  const parts = await keyPartsOf({ repoRoot: request.repoRoot, entry: request.entry, args, workers: TLC_WORKERS, java });
  return 'unreadable' in parts ? { unkeyed: 'input not readable' } : { key: keyOf(parts) };
};

export const checkEntry = async (request: CheckRequest): Promise<CheckOutcome> => {
  const { entry, store } = request;
  const args = [...entry.args, ...FIXED_FINGERPRINT_ARGS];
  const keyed = await keyOfRun(request, args);
  if ('unkeyed' in keyed) return runFresh(request, keyed.unkeyed);
  const found = await store.read(entry.config, keyed.key);
  if (found.kind === 'hit' && problemsOf(entry, found.record.facts).length === 0) return { outcome: 'reused', producedAt: found.record.producedAt };
  const reason: RanReason = found.kind === 'hit' ? 'record does not satisfy the manifest entry' : found.reason;
  const { run, problems } = await runAndJudge(request, args);
  const facts = storedFactsOf(run);
  if (problems.length > 0 || facts === undefined) return { outcome: 'ran', reason, problems, stored: 'not eligible' };
  const keyedAfter = await keyOfRun(request, args);
  if ('unkeyed' in keyedAfter || keyedAfter.key !== keyed.key) return { outcome: 'ran', reason: 'inputs changed during the run', problems, stored: 'not eligible' };
  const written = await store.write(sealedRecord({ format: RECORD_FORMAT, key: keyed.key, config: entry.config, facts, producedAt: request.now().toISOString() }));
  return { outcome: 'ran', reason, problems, stored: written.stored ? 'stored' : { notStored: written.reason } };
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
