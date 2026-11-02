import path from 'node:path';
import { loadUserSettings } from '@momonga/config';
import type { MomongaPaths } from '@momonga/foundation';
import { ensureDaemon, stopDaemon } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';

export const DEFAULT_FM_BINARY = '/usr/bin/fm';

export const FM_PROBE_SOCKET_NAME = 'fm-probe.sock';

export class NotAnFmTarget extends Error {
  constructor(target: string, known: Readonly<Record<string, { adapter: string }>>) {
    const described = Object.entries(known).map(([name, entry]) => `${name} (${entry.adapter})`);
    super(`model target ${target} is not an fm target; configured targets: ${described.length === 0 ? 'none' : described.join(', ')}`);
    this.name = 'NotAnFmTarget';
  }
}

export type ProbeOptions = { fmBinary: string; samples?: number; interrupt: AbortSignal };

export const probeFm = async (ports: CliPorts, paths: MomongaPaths, target: string, options: ProbeOptions): Promise<number> => {
  const { settings } = await loadUserSettings({ home: ports.home });
  const targets = settings.models.targets;
  const configured = targets[target];
  if (configured?.adapter !== 'fm') throw new NotAnFmTarget(target, targets);
  const { probeManagedFm } = await import('@momonga/gateway');
  const { report, toolCalling } = await probeManagedFm({
    paths,
    target,
    binary: options.fmBinary,
    socketPath: path.join(paths.run, FM_PROBE_SOCKET_NAME),
    env: ports.env,
    signal: options.interrupt,
    onWarning: (message) => ports.stderr.write(`momonga: ${message}\n`),
    ...(options.samples === undefined ? {} : { samples: options.samples }),
  });
  ports.stdout.write(
    [
      `probed ${target}: model ${report.modelId}, context window ${report.contextWindow.value} (${report.contextWindow.method})`,
      `  tool calling: ${toolCalling} (native ${report.nativeTools.validRate}, constrained ${report.constrained.validRate})`,
      `  stop sequences: ${report.stopSequences}, usage reported: ${report.usageReported}, max concurrency: ${report.maxConcurrency}`,
      `  recorded in ${paths.probe}`,
    ].join('\n') + '\n',
  );
  const { stopped } = await stopDaemon(ports, paths);
  if (stopped) {
    await ensureDaemon(ports, paths);
    ports.stdout.write('restarted the daemon so that the gateway reads the record\n');
  }
  return 0;
};
