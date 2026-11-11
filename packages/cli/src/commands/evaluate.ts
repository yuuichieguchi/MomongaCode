import path from 'node:path';
import {
  DEFAULT_DATASET_SEED,
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
  replayDataset,
  runDataset,
  saveContextReport,
  saveTranscript,
} from '@momonga/eval';
import type { ContextDataset, EvalReport, GateName, GoldenCase, GoldenDataset, PolicyOverlay, RecordedRun, Transcript } from '@momonga/eval';
import { decodeReliabilityReport } from '@momonga/reliability';
import type { ReliabilityReport } from '@momonga/reliability';
import { codeDigestOfRunningProcess, createOwnedDirectory, currentSocketResolver, momongaPaths } from '@momonga/foundation';
import type { MomongaPaths, OwnedDirectory } from '@momonga/foundation';
import { goldenRunApi } from '../client/golden-run-api.ts';
import { CONTEXT_BOOTSTRAP_SEED } from '../constants.ts';
import { ensureCurrentDaemon } from '../daemon/ensure-daemon.ts';
import { nodeContextEffects } from '../eval/context-effects.ts';
import { nodeWorkspaceProbe } from '../eval/workspace-probe.ts';
import { pinnedModelOf, runContextLive, unownedHomesNotice, unreadableHomesNotice } from '../eval/context-host.ts';
import type { ContextHostEffects } from '../eval/context-host.ts';
import type { CliPorts } from '../ports.ts';
import { connectRuntime, environmentSnapshot } from '../run/open-session.ts';
import { shellModelsOf } from '../plain-http.ts';
import { UsageError } from '../usage-error.ts';

export class EvaluateUsageError extends UsageError {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluateUsageError';
  }
}

export type EvaluateOptions = { record?: string; replay?: string; interrupt?: AbortSignal };

const WORKSPACE_PREFIX = 'momonga-eval-';

const populate = async (ports: CliPorts, directory: string, golden: GoldenCase): Promise<void> => {
  for (const [name, content] of Object.entries(golden.files ?? {})) {
    const file = path.join(directory, name);
    await ports.files.mkdir(path.dirname(file));
    await ports.files.writeText(file, content);
  }
};

const runLive = async (ports: CliPorts, paths: MomongaPaths, dataset: GoldenDataset, record: string | undefined, interrupt: AbortSignal | undefined): Promise<EvalReport> => {
  await ensureCurrentDaemon(ports, paths);
  const { REFLECTION_ATTEMPTS_BOUND_MS, REFLECTION_PICKUP_BOUND_MS, REFLECTION_POLL_MS } = await import('@momonga/runtime');
  const env = await environmentSnapshot(ports);
  const client = connectRuntime(ports, paths);
  const api = goldenRunApi(client, undefined, {
    pendingBoundMs: REFLECTION_PICKUP_BOUND_MS,
    attemptBoundMs: REFLECTION_ATTEMPTS_BOUND_MS,
    pollMs: REFLECTION_POLL_MS,
    now: () => ports.clock.now(),
    wait: (milliseconds, signal) => ports.clock.sleep(milliseconds, signal),
    ...(interrupt === undefined ? {} : { signal: interrupt }),
  });
  const workspaces: OwnedDirectory[] = [];
  if (record !== undefined) await ports.files.mkdir(record);
  try {
    return await runDataset(dataset, {
      open: async (golden) => {
        const workspace = await createOwnedDirectory({ parent: ports.tmpdir, prefix: WORKSPACE_PREFIX });
        workspaces.push(workspace);
        const cwd = workspace.path;
        await populate(ports, cwd, golden);
        if (golden.oracle === undefined) return { api, workspace: { cwd, env }, close: async () => undefined };
        const base = await createOwnedDirectory({ parent: ports.tmpdir, prefix: WORKSPACE_PREFIX });
        workspaces.push(base);
        await populate(ports, base.path, golden);
        return { api, workspace: { cwd, env }, oracle: { base: base.path, probe: nodeWorkspaceProbe(env), files: ports.files }, close: async () => undefined };
      },
      ...(record === undefined ? {} : { onTranscript: async (run: RecordedRun) => void (await saveTranscript(ports.files, record, { ...run, policy: null, codeDigest: null })) }),
      ...(interrupt === undefined ? {} : { signal: interrupt }),
    });
  } finally {
    await Promise.all(workspaces.map((workspace) => workspace.dispose()));
    await client.close();
  }
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
  hostEffects: (ports: CliPorts) => ContextHostEffects,
  dataset: ContextDataset,
  options: { model: string; seed: number; policy: PolicyOverlay; record: string | undefined; interrupt: AbortSignal },
): Promise<Transcript[]> => {
  const { REFLECTION_ATTEMPTS_BOUND_MS, REFLECTION_PICKUP_BOUND_MS, REFLECTION_POLL_MS, RUNTIME_DEFAULTS } = await import('@momonga/runtime');
  if (options.record !== undefined) await ports.files.mkdir(options.record);
  const { record } = options;
  const models = shellModelsOf(ports);
  return runContextLive(hostEffects(ports), {
    dataset,
    seed: options.seed,
    model: pinnedModelOf(models, options.model),
    policy: options.policy,
    codeDigest: await codeDigestOfRunningProcess(),
    models,
    planRelaySocket: currentSocketResolver(momongaPaths(ports.home), 'gateway'),
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
  hostEffects: (ports: CliPorts) => ContextHostEffects = nodeContextEffects,
): Promise<number> => {
  if (options.record !== undefined && options.replay !== undefined) throw new EvaluateUsageError('--record and --replay cannot be combined');
  const { replay } = options;
  if (replay !== undefined && (options.model !== undefined || options.seed !== undefined)) {
    throw new EvaluateUsageError('--model and --seed belong to a live run; a replay takes the models and the seed from the transcripts');
  }
  if (replay !== undefined && options.settings !== undefined) {
    throw new EvaluateUsageError('--settings belongs to a live run; a replayed transcript was produced under a policy this command cannot know');
  }
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
  if (options.report !== undefined) await saveContextReport(ports.files, path.resolve(ports.cwd, options.report), report);
  ports.stdout.write(`${formatContextReport(report)}\n`);
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
  return comparison.gate.passed ? 0 : 1;
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
  return comparison.gate.passed ? 0 : 1;
};

export const evaluate = async (ports: CliPorts, paths: MomongaPaths, datasetFile: string, options: EvaluateOptions): Promise<number> => {
  if (options.record !== undefined && options.replay !== undefined) throw new EvaluateUsageError('--record and --replay cannot be combined');
  const dataset = await loadDataset(ports.files, path.resolve(ports.cwd, datasetFile));
  const report =
    options.replay === undefined
      ? await runLive(ports, paths, dataset, options.record === undefined ? undefined : path.resolve(ports.cwd, options.record), options.interrupt)
      : replayDataset(dataset, await loadTranscripts(ports.files, path.resolve(ports.cwd, options.replay)));
  ports.stdout.write(`${formatReport(report)}\n`);
  return report.passed ? 0 : 1;
};
