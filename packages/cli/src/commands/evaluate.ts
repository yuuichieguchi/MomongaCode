import path from 'node:path';
import { formatReport, loadDataset, loadTranscripts, replayDataset, runDataset, saveTranscript } from '@momonga/eval';
import type { EvalReport, GoldenCase, GoldenDataset, Transcript } from '@momonga/eval';
import type { MomongaPaths } from '@momonga/foundation';
import { goldenRunApi } from '../client/golden-run-api.ts';
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
