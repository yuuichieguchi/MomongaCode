import type { RuntimeClient } from '../client/runtime-client.ts';
import type { RunView, SessionView } from '../client/views.ts';

export class NoRunFound extends Error {
  constructor(cwd: string, wanted: string) {
    super(`no ${wanted} found for sessions in ${cwd}; pass a run id`);
    this.name = 'NoRunFound';
  }
}

const newestFirst = (sessions: readonly SessionView[]): SessionView[] => [...sessions].sort((left, right) => right.createdAt - left.createdAt);

export const activeRunIdOf = async (client: RuntimeClient, cwd: string): Promise<string> => {
  const session = newestFirst(await client.listSessions(cwd)).find((candidate) => candidate.activeRunId !== null);
  if (session?.activeRunId === undefined || session.activeRunId === null) throw new NoRunFound(cwd, 'running run');
  return session.activeRunId;
};

export const latestRunIdOf = async (client: RuntimeClient, cwd: string): Promise<string> => {
  const session = newestFirst(await client.listSessions(cwd)).find((candidate) => candidate.latestRunId !== null);
  if (session?.latestRunId === undefined || session.latestRunId === null) throw new NoRunFound(cwd, 'run');
  return session.latestRunId;
};

export const newestSessionIdOf = async (client: RuntimeClient, cwd: string): Promise<string> => {
  const session = newestFirst(await client.listSessions(cwd))[0];
  if (session === undefined) throw new NoRunFound(cwd, 'session');
  return session.id;
};

export type RunNode = { run: RunView; depth: number };

export const runTreeOf = async (client: Pick<RuntimeClient, 'getRun' | 'childRuns'>, runId: string, depth = 0): Promise<RunNode[]> => {
  const run = await client.getRun(runId);
  const descendants = await Promise.all((await client.childRuns(runId)).map((child) => runTreeOf(client, child.id, depth + 1)));
  return [{ run, depth }, ...descendants.flat()];
};
