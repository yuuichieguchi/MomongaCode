import type { MomongaPaths } from '@momonga/foundation';
import { escapeTerminalLine } from '@momonga/protocol';
import type { JobView } from '@momonga/protocol';
import { ensureCurrentDaemon } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import { connectRuntime } from '../run/open-session.ts';
import { newestSessionIdOf } from './targets.ts';

const endOf = (job: JobView): string => {
  if (job.status === 'running') return '';
  if (job.signal !== undefined) return `  signal ${job.signal}`;
  return job.exitCode === undefined ? '' : `  exit ${job.exitCode}`;
};

export const jobLine = (job: JobView): string => `${job.id}  ${job.status}${endOf(job)}  run ${job.runId}  ${escapeTerminalLine(job.command)}`;

export const listJobs = async (ports: CliPorts, paths: MomongaPaths, sessionId: string | undefined, json: boolean): Promise<number> => {
  await ensureCurrentDaemon(ports, paths);
  const client = connectRuntime(paths);
  try {
    const target = sessionId ?? (await newestSessionIdOf(client, ports.cwd));
    const jobs = await client.jobs(target);
    if (json) ports.stdout.write(`${JSON.stringify(jobs)}\n`);
    else ports.stdout.write(jobs.length === 0 ? `session ${target} has no background jobs\n` : `${jobs.map(jobLine).join('\n')}\n`);
    return 0;
  } finally {
    await client.close();
  }
};
