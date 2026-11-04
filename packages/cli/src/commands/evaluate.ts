import path from 'node:path';
import { loadUserModels } from '@momonga/config';
import {
  DEFAULT_DATASET_SEED,
  GATE_NAMES,
  buildContextReport,
  compareContextReports,
  formatContextComparison,
  formatContextReport,
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
import type { ContextDataset, ContextModel, EvalReport, GateName, GoldenCase, GoldenDataset, PolicyOverlay, Transcript } from '@momonga/eval';
import type { MomongaPaths } from '@momonga/foundation';
import { goldenRunApi } from '../client/golden-run-api.ts';
import { CONTEXT_BOOTSTRAP_SEED } from '../constants.ts';
import { ensureDaemon } from '../daemon/ensure-daemon.ts';
import { codeDigestOfRunningCli } from '../eval/code-digest.ts';
import { nodeContextEffects } from '../eval/context-effects.ts';
import { runContextLive, unownedHomesNotice, unreadableHomesNotice } from '../eval/context-host.ts';
import type { ContextHostEffects } from '../eval/context-host.ts';
import type { CliPorts } from '../ports.ts';
import { connectRuntime, environmentSnapshot } from '../run/open-session.ts';

export class EvaluateUsageError extends Error {
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
    await ports.files.ensureDirectory(path.dirname(file));
    await ports.files.writeText(file, content);
  }
};

const runLive = async (ports: CliPorts, paths: MomongaPaths, dataset: GoldenDataset, record: string | undefined, interrupt: AbortSignal | undefined): Promise<EvalReport> => {
  await ensureDaemon(ports, paths);
  const { REFLECTION_ATTEMPTS_BOUND_MS, REFLECTION_PICKUP_BOUND_MS, REFLECTION_POLL_MS } = await import('@momonga/runtime');
  const env = await environmentSnapshot(ports);
  const client = connectRuntime(paths);
  const workspaces: string[] = [];
  if (record !== undefined) await ports.files.ensureDirectory(record);
  try {
    return await runDataset(dataset, {
      api: goldenRunApi(client, undefined, {
        pendingBoundMs: REFLECTION_PICKUP_BOUND_MS,
        attemptBoundMs: REFLECTION_ATTEMPTS_BOUND_MS,
        pollMs: REFLECTION_POLL_MS,
        now: () => ports.clock.now(),
        wait: (milliseconds, signal) => ports.clock.sleep(milliseconds, signal),
        ...(interrupt === undefined ? {} : { signal: interrupt }),
      }),
      workspace: async (golden) => {
        const cwd = await ports.files.makeTempDirectory(WORKSPACE_PREFIX);
        workspaces.push(cwd);
        await populate(ports, cwd, golden);
        return { cwd, env };
      },
      ...(record === undefined ? {} : { onTranscript: async (transcript: Transcript) => void (await saveTranscript(ports.files, record, transcript)) }),
    });
  } finally {
    await Promise.all(workspaces.map((directory) => ports.files.removeTree(directory)));
    await client.close();
  }
};

export type EvaluateContextOptions = {
  replay?: string;
  record?: string;
  model?: ContextModel;
  alias?: string;
  seed?: number;
  report?: string;
  settings?: string;
  codeDigest?: string;
  interrupt?: AbortSignal;
};

const seedOfTranscripts = (transcripts: readonly Transcript[]): number | undefined => {
  const seeds = [...new Set(transcripts.flatMap((transcript) => (transcript.datasetSeed === undefined ? [] : [transcript.datasetSeed])))];
  if (seeds.length > 1) throw new EvaluateUsageError(`the transcripts were recorded with different dataset seeds (${seeds.join(', ')}), so they do not measure one expansion of the dataset`);
  return seeds[0];
};

const assertLiveOptions = (options: EvaluateContextOptions): { model: ContextModel; alias: string } => {
  if (options.model === undefined) throw new EvaluateUsageError('--model fake|real is required: a transcript does not record which kind of model produced it');
  if (options.alias === undefined) throw new EvaluateUsageError('--alias <alias> is required for a live run: it names the model alias every session of the run is pinned to');
  return { model: options.model, alias: options.alias };
};

const runContextLiveCommand = async (
  ports: CliPorts,
  hostEffects: (ports: CliPorts) => ContextHostEffects,
  dataset: ContextDataset,
  options: { alias: string; seed: number; policy: PolicyOverlay; record: string | undefined; interrupt: AbortSignal | undefined },
): Promise<Transcript[]> => {
  const { RUNTIME_DEFAULTS } = await import('@momonga/runtime');
  if (options.record !== undefined) await ports.files.ensureDirectory(options.record);
  const { record } = options;
  return runContextLive(hostEffects(ports), {
    dataset,
    seed: options.seed,
    alias: options.alias,
    policy: options.policy,
    models: loadUserModels({ home: ports.home }),
    limits: { maxTotalTokens: RUNTIME_DEFAULTS.limits.maxTotalTokens, defaultTimeoutMs: RUNTIME_DEFAULTS.runTimeoutMs },
    onUnreadableHomes: (count) => ports.stderr.write(unreadableHomesNotice(count)),
    onUnownedHomes: (roots) => ports.stderr.write(unownedHomesNotice(roots)),
    ...(options.interrupt === undefined ? {} : { interrupt: options.interrupt }),
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
  if (replay !== undefined && (options.alias !== undefined || options.seed !== undefined)) {
    throw new EvaluateUsageError('--alias and --seed belong to a live run; a replay takes the aliases and the seed from the transcripts');
  }
  if (replay !== undefined && options.settings !== undefined) {
    throw new EvaluateUsageError('--settings belongs to a live run; a replayed transcript was produced under a policy this command cannot know');
  }
  const policy = options.settings === undefined ? {} : parsePolicyOverlay(await ports.files.readText(path.resolve(ports.cwd, options.settings)), options.settings);
  const mode = replay === undefined ? ({ kind: 'live', ...assertLiveOptions(options) } as const) : ({ kind: 'replay', directory: replay } as const);
  const model = mode.kind === 'live' ? mode.model : options.model;
  if (model === undefined) throw new EvaluateUsageError('--model fake|real is required with --replay: a transcript does not record which kind of model produced it');
  const dataset = await loadContextDataset(ports.files, path.resolve(ports.cwd, datasetFile));
  let transcripts: Transcript[];
  let datasetSeed: number | undefined;
  if (mode.kind === 'replay') {
    transcripts = await loadTranscripts(ports.files, path.resolve(ports.cwd, mode.directory));
    datasetSeed = seedOfTranscripts(transcripts);
  } else {
    datasetSeed = options.seed ?? DEFAULT_DATASET_SEED;
    transcripts = await runContextLiveCommand(ports, hostEffects, dataset, {
      alias: mode.alias,
      seed: datasetSeed,
      policy,
      record: options.record === undefined ? undefined : path.resolve(ports.cwd, options.record),
      interrupt: options.interrupt,
    });
  }
  const report = buildContextReport({
    dataset,
    transcripts,
    model,
    seed: CONTEXT_BOOTSTRAP_SEED,
    policy,
    codeDigest: options.codeDigest ?? (await codeDigestOfRunningCli()),
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

export const compareContext = async (ports: CliPorts, baselineFile: string, candidateFile: string, gate: string): Promise<number> => {
  const gateName = gateOf(gate);
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
