import type { RuntimeClient } from '../client/runtime-client.ts';
import type { RunView } from '../client/views.ts';
import { runsNewestFirst } from '../run/resolve-session.ts';
import type { RunOfSession, RunOfSessionKind } from '../run/resolve-session.ts';

export class NoRunFound extends Error {
  constructor(cwd: string, wanted: string) {
    super(`no ${wanted} found for sessions in ${cwd}; pass a run id`);
    this.name = 'NoRunFound';
  }
}

const newestRunOf = async (client: Pick<RuntimeClient, 'listSessions'>, cwd: string, kind: RunOfSessionKind): Promise<RunOfSession | undefined> => runsNewestFirst(await client.listSessions(cwd), kind)[0];

export const activeRunIdOf = async (client: Pick<RuntimeClient, 'listSessions'>, cwd: string): Promise<string> => {
  const active = await newestRunOf(client, cwd, 'active');
  if (active === undefined) throw new NoRunFound(cwd, 'running run');
  return active.runId;
};

export const latestRunOf = (client: Pick<RuntimeClient, 'listSessions'>, cwd: string): Promise<RunOfSession | undefined> => newestRunOf(client, cwd, 'latest');

export const latestRunIdOf = async (client: Pick<RuntimeClient, 'listSessions'>, cwd: string): Promise<string> => {
  const latest = await latestRunOf(client, cwd);
  if (latest === undefined) throw new NoRunFound(cwd, 'run');
  return latest.runId;
};

export type RunNode = { run: RunView; depth: number };

export const runTreeOf = async (client: Pick<RuntimeClient, 'getRun' | 'childRuns'>, runId: string, depth = 0): Promise<RunNode[]> => {
  const run = await client.getRun(runId);
  const descendants = await Promise.all((await client.childRuns(runId)).map((child) => runTreeOf(client, child.id, depth + 1)));
  return [{ run, depth }, ...descendants.flat()];
};
