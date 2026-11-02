import path from 'node:path';
import {
  buildContextReport,
  compareContextReports,
  formatContextComparison,
  formatContextReport,
  formatReport,
  loadContextDataset,
  loadContextReport,
  loadDataset,
  loadTranscripts,
  replayDataset,
  runDataset,
  saveContextReport,
  saveTranscript,
} from '@momonga/eval';
import type { ContextModel, EvalReport, GoldenCase, GoldenDataset, Transcript } from '@momonga/eval';
import type { MomongaPaths } from '@momonga/foundation';
import { goldenRunApi } from '../client/golden-run-api.ts';
import { CONTEXT_BOOTSTRAP_SEED } from '../constants.ts';
import { ensureDaemon } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import { connectRuntime, environmentSnapshot } from '../run/open-session.ts';

export class EvaluateUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluateUsageError';
  }
}

export type EvaluateOptions = { record?: string; replay?: string };

const WORKSPACE_PREFIX = 'momonga-eval-';

const populate = async (ports: CliPorts, directory: string, golden: GoldenCase): Promise<void> => {
  for (const [name, content] of Object.entries(golden.files ?? {})) {
    const file = path.join(directory, name);
    await ports.files.ensureDirectory(path.dirname(file));
    await ports.files.writeText(file, content);
  }
};

const runLive = async (ports: CliPorts, paths: MomongaPaths, dataset: GoldenDataset, record: string | undefined): Promise<EvalReport> => {
  await ensureDaemon(ports, paths, { replacement: 'when-idle' });
  const env = await environmentSnapshot(ports);
  const client = connectRuntime(paths);
  const workspaces: string[] = [];
  if (record !== undefined) await ports.files.ensureDirectory(record);
  try {
    return await runDataset(dataset, {
      api: goldenRunApi(client),
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

export type EvaluateContextOptions = { replay?: string; model?: ContextModel; report?: string };

export const evaluateContext = async (ports: CliPorts, datasetFile: string, options: EvaluateContextOptions): Promise<number> => {
  if (options.replay === undefined) {
    throw new EvaluateUsageError(
      'eval context replays recorded runs with --replay <directory>: the runtime cannot yet switch compaction off, load governing rules or play noise turns, so a live run could not honour the dataset',
    );
  }
  if (options.model === undefined) {
    throw new EvaluateUsageError('--model fake|real is required with --replay: a transcript does not record which kind of model produced it');
  }
  const dataset = await loadContextDataset(ports.files, path.resolve(ports.cwd, datasetFile));
  const transcripts = await loadTranscripts(ports.files, path.resolve(ports.cwd, options.replay));
  const report = buildContextReport({ dataset, transcripts, model: options.model });
  if (options.report !== undefined) await saveContextReport(ports.files, path.resolve(ports.cwd, options.report), report);
  ports.stdout.write(`${formatContextReport(report)}\n`);
  return report.passed ? 0 : 1;
};

export const compareContext = async (ports: CliPorts, baselineFile: string, candidateFile: string): Promise<number> => {
  const [baseline, candidate] = await Promise.all([
    loadContextReport(ports.files, path.resolve(ports.cwd, baselineFile)),
    loadContextReport(ports.files, path.resolve(ports.cwd, candidateFile)),
  ]);
  const comparison = compareContextReports(baseline, candidate, { seed: CONTEXT_BOOTSTRAP_SEED });
  ports.stdout.write(`${formatContextComparison(comparison)}\n`);
  return comparison.gate.passed ? 0 : 1;
};

export const evaluate = async (ports: CliPorts, paths: MomongaPaths, datasetFile: string, options: EvaluateOptions): Promise<number> => {
  if (options.record !== undefined && options.replay !== undefined) throw new EvaluateUsageError('--record and --replay cannot be combined');
  const dataset = await loadDataset(ports.files, path.resolve(ports.cwd, datasetFile));
  const report =
    options.replay === undefined
      ? await runLive(ports, paths, dataset, options.record === undefined ? undefined : path.resolve(ports.cwd, options.record))
      : replayDataset(dataset, await loadTranscripts(ports.files, path.resolve(ports.cwd, options.replay)));
  ports.stdout.write(`${formatReport(report)}\n`);
  return report.passed ? 0 : 1;
};
