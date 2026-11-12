import path from 'node:path';
import type { UserModels } from '@momonga/config';
import {
  DEFAULT_DATASET_SEED,
  caseSettingsFor,
  failedWithCleanup,
  GATE_NAMES,
  buildContextReport,
  compareContextReports,
  compareReliability,
  formatContextComparison,
  formatContextReport,
  formatReliabilityComparison,
  formatReport,
  loadContextDataset,
  loadContextReport,
  loadDataset,
  loadTranscripts,
  parsePolicyOverlay,
  refuseExistingOutput,
  refuseRecordedTranscripts,
  replayDataset,
  runDataset,
  saveContextReport,
  saveTranscript,
} from '@momonga/eval';
import type { ContextDataset, EvalOracle, EvalReport, GateName, GoldenCase, GoldenDataset, PolicyOverlay, RecordedRun, Transcript } from '@momonga/eval';
import { decodeReliabilityReport } from '@momonga/reliability';
import type { ReliabilityReport } from '@momonga/reliability';
import { codeDigestOfRunningProcess, createOwnedDirectory, currentSocketResolver, momongaPaths, resolveLayoutLocks } from '@momonga/foundation';
import type { MomongaPaths, KernelLockMechanism } from '@momonga/foundation';
import { CONTEXT_BOOTSTRAP_SEED } from '../constants.ts';
import { nodeContextEffects } from '../eval/context-effects.ts';
import { createHomes, liveSettingsFor, needsPlanRelay, pinnedModelOf, readCredentials, readPlanRelay, runContextLive, sweepStaleHomes, unownedHomesNotice, unreadableHomesNotice } from '../eval/context-host.ts';
import type { ContextHostEffects, ContextRuntime, HomeEffects, ReflectionBounds } from '../eval/context-host.ts';
import type { CliPorts } from '../ports.ts';
import { shellModelsOf } from '../plain-http.ts';
import { UsageError } from '../usage-error.ts';
import { pathsOf } from '../paths.ts';
import { exitOfMeasurement } from '../measurement-exit.ts';

export class EvaluateUsageError extends UsageError {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluateUsageError';
  }
}

export type EvaluateOptions = { record?: string; replay?: string; interrupt: AbortSignal };

const ORACLE_BASE_PREFIX = 'momonga-eval-';

export type GoldenLiveInput = {
  dataset: GoldenDataset;
  models: UserModels;
  reflection: ReflectionBounds;
  interrupt: AbortSignal;
  oracleOf(golden: GoldenCase, env: Readonly<Record<string, string>>): Promise<{ oracle: EvalOracle; dispose(): Promise<void> }>;
  onTranscript?(run: RecordedRun): Promise<void>;
  onUnreadableHomes?(count: number): void;
  onUnownedHomes?(roots: readonly string[]): void;
  planRelaySocket?(): Promise<string>;
};

const startModelOf = (models: UserModels): string => {
  const { start } = models.resolved;
  if (start === undefined) throw new EvaluateUsageError('eval runs every case on the start model of the settings, and the settings name none: choose one with momonga models use <model>');
  return start;
};

export const runGoldenLive = async (effects: HomeEffects<ContextRuntime>, input: GoldenLiveInput): Promise<EvalReport> => {
  const { interrupt } = input;
  interrupt.throwIfAborted();
  const model = startModelOf(input.models);
  const relay = needsPlanRelay(input.models, [model]) && input.planRelaySocket !== undefined ? await readPlanRelay(await input.planRelaySocket(), interrupt) : undefined;
  const settings = liveSettingsFor(input.models, [model], relay);
  const credentialValues = await readCredentials(effects, settings.credentials, interrupt);
  const swept = await sweepStaleHomes(effects);
  if (swept.unreadable > 0) input.onUnreadableHomes?.(swept.unreadable);
  if (swept.unowned.length > 0) input.onUnownedHomes?.(swept.unowned);
  const homes = createHomes(effects, { credentialValues, reflection: input.reflection, managedTargets: settings.managedTargets, endpointProbes: settings.endpointProbes, interrupt });
  const base = { models: settings.models, ...(settings.sandbox === undefined ? {} : { sandbox: settings.sandbox }) };
  const { oracleOf, onTranscript } = input;
  let report: EvalReport;
  try {
    report = await runDataset(input.dataset, {
      model,
      open: async (golden, runIndex) => {
        const home = await homes.open({ label: `case ${golden.id} run ${runIndex}`, settings: caseSettingsFor(base, {}), ...(golden.files === undefined ? {} : { files: golden.files }) });
        const scope = { api: home.api, workspace: { cwd: home.cwd, env: home.env } };
        if (golden.oracle === undefined) return { ...scope, close: home.close };
        const made = await oracleOf(golden, home.env);
        return {
          ...scope,
          oracle: made.oracle,
          close: async () => {
            await home.close();
            await made.dispose();
          },
        };
      },
      ...(onTranscript === undefined ? {} : { onTranscript }),
      signal: interrupt,
    });
  } catch (error) {
    try {
      await homes.dispose();
    } catch (cleanup) {
      throw failedWithCleanup(error, cleanup, 'the dataset failed and its temporary homes were not fully released');
    }
    throw error;
  }
  await homes.dispose();
  return report;
};

const populate = async (ports: CliPorts, directory: string, golden: GoldenCase): Promise<void> => {
  for (const [name, content] of Object.entries(golden.files ?? {})) {
    const file = path.join(directory, name);
    await ports.files.mkdir(path.dirname(file));
    await ports.files.writeText(file, content);
  }
};

const runLive = async (
  ports: CliPorts,
  paths: MomongaPaths,
  dataset: GoldenDataset,
  record: string | undefined,
  interrupt: AbortSignal,
  hostEffects: (ports: CliPorts, lock: KernelLockMechanism) => ContextHostEffects,
): Promise<EvalReport> => {
  const { REFLECTION_ATTEMPTS_BOUND_MS, REFLECTION_PICKUP_BOUND_MS, REFLECTION_POLL_MS } = await import('@momonga/runtime');
  const lock = resolveLayoutLocks(paths).mechanism;
  if (record !== undefined) await ports.files.mkdir(record);
  return runGoldenLive(hostEffects(ports, lock), {
    dataset,
    models: await shellModelsOf(ports, interrupt),
    reflection: { pendingBoundMs: REFLECTION_PICKUP_BOUND_MS, attemptBoundMs: REFLECTION_ATTEMPTS_BOUND_MS, pollMs: REFLECTION_POLL_MS },
    interrupt,
    oracleOf: async (golden, env) => {
      const base = await createOwnedDirectory({ parent: ports.tmpdir, prefix: ORACLE_BASE_PREFIX, lock });
      await populate(ports, base.path, golden);
      return { oracle: { base: base.path, probe: ports.probe(env), files: ports.files }, dispose: () => base.dispose() };
    },
    ...(record === undefined ? {} : { onTranscript: async (run: RecordedRun) => void (await saveTranscript(ports.files, record, { ...run, policy: null, codeDigest: null })) }),
    planRelaySocket: currentSocketResolver(paths, 'gateway'),
    onUnreadableHomes: (count) => ports.stderr.write(unreadableHomesNotice(count)),
    onUnownedHomes: (roots) => ports.stderr.write(unownedHomesNotice(roots)),
  });
};

export type EvaluateContextOptions = {
  replay?: string;
  record?: string;
  model?: string;
  seed?: number;
  report?: string;
  settings?: string;
  interrupt: AbortSignal;
};

const seedOfTranscripts = (transcripts: readonly Transcript[]): number | undefined => {
  const seeds = [...new Set(transcripts.flatMap((transcript) => (transcript.datasetSeed === undefined ? [] : [transcript.datasetSeed])))];
  if (seeds.length > 1) throw new EvaluateUsageError(`the transcripts were recorded with different dataset seeds (${seeds.join(', ')}), so they do not measure one expansion of the dataset`);
  return seeds[0];
};

const assertLiveOptions = (options: EvaluateContextOptions): { model: string } => {
  if (options.model === undefined) throw new EvaluateUsageError('--model <model> is required for a live run: it names the model every session of the run uses');
  return { model: options.model };
};

const runContextLiveCommand = async (
  ports: CliPorts,
  hostEffects: (ports: CliPorts, lock: KernelLockMechanism) => ContextHostEffects,
  dataset: ContextDataset,
  options: { model: string; seed: number; policy: PolicyOverlay; record: string | undefined; interrupt: AbortSignal },
): Promise<Transcript[]> => {
  const { REFLECTION_ATTEMPTS_BOUND_MS, REFLECTION_PICKUP_BOUND_MS, REFLECTION_POLL_MS, RUNTIME_DEFAULTS } = await import('@momonga/runtime');
  if (options.record !== undefined) await ports.files.mkdir(options.record);
  const { record } = options;
  const models = await shellModelsOf(ports, options.interrupt);
  return runContextLive(hostEffects(ports, resolveLayoutLocks(await pathsOf(ports)).mechanism), {
    dataset,
    seed: options.seed,
    model: pinnedModelOf(models, options.model),
    policy: options.policy,
    codeDigest: await codeDigestOfRunningProcess(),
    models,
    planRelaySocket: currentSocketResolver(momongaPaths(ports.home, ports.platform, ports.env), 'gateway'),
    limits: { maxTotalTokens: RUNTIME_DEFAULTS.limits.maxTotalTokens, defaultTimeoutMs: RUNTIME_DEFAULTS.runTimeoutMs },
    reflection: { pendingBoundMs: REFLECTION_PICKUP_BOUND_MS, attemptBoundMs: REFLECTION_ATTEMPTS_BOUND_MS, pollMs: REFLECTION_POLL_MS },
    onUnreadableHomes: (count) => ports.stderr.write(unreadableHomesNotice(count)),
    onUnownedHomes: (roots) => ports.stderr.write(unownedHomesNotice(roots)),
    interrupt: options.interrupt,
    ...(record === undefined ? {} : { onTranscript: async (transcript: Transcript) => void (await saveTranscript(ports.files, record, transcript)) }),
  });
};

export const evaluateContext = async (
  ports: CliPorts,
  datasetFile: string,
  options: EvaluateContextOptions,
  hostEffects: (ports: CliPorts, lock: KernelLockMechanism) => ContextHostEffects = nodeContextEffects,
): Promise<number> => {
  if (options.record !== undefined && options.replay !== undefined) throw new EvaluateUsageError('--record and --replay cannot be combined');
  const { replay } = options;
  if (replay !== undefined && (options.model !== undefined || options.seed !== undefined)) {
    throw new EvaluateUsageError('--model and --seed belong to a live run; a replay takes the models and the seed from the transcripts');
  }
  if (replay !== undefined && options.settings !== undefined) {
    throw new EvaluateUsageError('--settings belongs to a live run; a replayed transcript was produced under a policy this command cannot know');
  }
  const reportFile = options.report === undefined ? undefined : path.resolve(ports.cwd, options.report);
  if (reportFile !== undefined) await refuseExistingOutput(ports.files, reportFile);
  if (options.record !== undefined) await refuseRecordedTranscripts(ports.files, path.resolve(ports.cwd, options.record));
  const policy = options.settings === undefined ? {} : parsePolicyOverlay(await ports.files.readText(path.resolve(ports.cwd, options.settings)), options.settings);
  const mode = replay === undefined ? ({ kind: 'live', ...assertLiveOptions(options) } as const) : ({ kind: 'replay', directory: replay } as const);
  const dataset = await loadContextDataset(ports.files, path.resolve(ports.cwd, datasetFile));
  let transcripts: Transcript[];
  let datasetSeed: number | undefined;
  if (mode.kind === 'replay') {
    transcripts = await loadTranscripts(ports.files, path.resolve(ports.cwd, mode.directory));
    datasetSeed = seedOfTranscripts(transcripts);
  } else {
    datasetSeed = options.seed ?? DEFAULT_DATASET_SEED;
    transcripts = await runContextLiveCommand(ports, hostEffects, dataset, {
      model: mode.model,
      seed: datasetSeed,
      policy,
      record: options.record === undefined ? undefined : path.resolve(ports.cwd, options.record),
      interrupt: options.interrupt,
    });
  }
  const report = buildContextReport({
    dataset,
    transcripts,
    seed: CONTEXT_BOOTSTRAP_SEED,
    ...(datasetSeed === undefined ? {} : { datasetSeed }),
  });
  ports.stdout.write(`${formatContextReport(report)}\n`);
  if (reportFile !== undefined) await saveContextReport(ports.files, reportFile, report);
  return report.passed ? 0 : 1;
};

const gateOf = (name: string): GateName => {
  const known = GATE_NAMES.find((gate) => gate === name);
  if (known === undefined) throw new EvaluateUsageError(`--gate must be ${GATE_NAMES.join(' or ')}, received ${name}`);
  return known;
};

const loadReliabilityReport = async (ports: CliPorts, file: string): Promise<ReliabilityReport> => decodeReliabilityReport(await ports.files.readText(path.resolve(ports.cwd, file)));

const compareReliabilityFiles = async (ports: CliPorts, baselineFile: string, candidateFile: string): Promise<number> => {
  const [baseline, candidate] = await Promise.all([loadReliabilityReport(ports, baselineFile), loadReliabilityReport(ports, candidateFile)]);
  const comparison = compareReliability(baseline, candidate, { seed: CONTEXT_BOOTSTRAP_SEED });
  ports.stdout.write(`${formatReliabilityComparison(comparison)}\n`);
  return exitOfMeasurement(comparison.gate.passed);
};

export const compareContext = async (ports: CliPorts, baselineFile: string, candidateFile: string, gate: string): Promise<number> => {
  const gateName = gateOf(gate);
  if (gateName === 'reliability') return compareReliabilityFiles(ports, baselineFile, candidateFile);
  const [baseline, candidate] = await Promise.all([
    loadContextReport(ports.files, path.resolve(ports.cwd, baselineFile)),
    loadContextReport(ports.files, path.resolve(ports.cwd, candidateFile)),
  ]);
  const comparison = compareContextReports(baseline, candidate, { seed: CONTEXT_BOOTSTRAP_SEED, gate: gateName });
  ports.stdout.write(`${formatContextComparison(comparison)}\n`);
  return exitOfMeasurement(comparison.gate.passed);
};

export const evaluate = async (
  ports: CliPorts,
  paths: MomongaPaths,
  datasetFile: string,
  options: EvaluateOptions,
  hostEffects: (ports: CliPorts, lock: KernelLockMechanism) => ContextHostEffects = nodeContextEffects,
): Promise<number> => {
  if (options.record !== undefined && options.replay !== undefined) throw new EvaluateUsageError('--record and --replay cannot be combined');
  if (options.record !== undefined) await refuseRecordedTranscripts(ports.files, path.resolve(ports.cwd, options.record));
  const dataset = await loadDataset(ports.files, path.resolve(ports.cwd, datasetFile));
  const report =
    options.replay === undefined
      ? await runLive(ports, paths, dataset, options.record === undefined ? undefined : path.resolve(ports.cwd, options.record), options.interrupt, hostEffects)
      : replayDataset(dataset, await loadTranscripts(ports.files, path.resolve(ports.cwd, options.replay)));
  ports.stdout.write(`${formatReport(report)}\n`);
  return report.passed ? 0 : 1;
};
