import type { MomongaPaths } from '@momonga/foundation';
import { WORDS, escapeTerminalLine } from '@momonga/protocol';
import type { JobView } from '@momonga/protocol';
import { ensureCurrentDaemon } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import { connectRuntime } from '../run/open-session.ts';
import { latestRunOf } from './targets.ts';

const endOf = (job: JobView): string => {
  if (job.status === 'running') return '';
  if (job.signal !== undefined) return `  signal ${job.signal}`;
  return job.exitCode === undefined ? '' : `  exit ${job.exitCode}`;
};

export const jobLine = (job: JobView): string => `${job.id}  ${job.status}${endOf(job)}  run ${job.runId}  ${escapeTerminalLine(job.command)}`;

export const listJobs = async (ports: CliPorts, paths: MomongaPaths, sessionId: string | undefined, json: boolean): Promise<number> => {
  await ensureCurrentDaemon(ports, paths);
  const client = connectRuntime(ports, paths);
  try {
    const target = sessionId ?? (await latestRunOf(client, ports.cwd))?.session.id;
    const jobs = target === undefined ? [] : await client.jobs(target);
    if (json) ports.stdout.write(`${JSON.stringify(jobs)}\n`);
    else if (target === undefined) ports.stdout.write(`${escapeTerminalLine(`no ${WORDS.session} of the ${WORDS.folder} ${ports.cwd} has a ${WORDS.run}, so there are no background jobs`)}\n`);
    else ports.stdout.write(jobs.length === 0 ? `session ${target} has no background jobs\n` : `${jobs.map(jobLine).join('\n')}\n`);
    return 0;
  } finally {
    await client.close();
  }
};
