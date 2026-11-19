import { SERVER_KINDS } from '@momonga/protocol';
import type { DetectedModel, ProviderAdapter } from '@momonga/protocol';
import { PreconditionFailedError } from '../adapters/shared/failures.ts';
import { NO_REPORTED_WINDOW } from '../reported-window.ts';
import { describeModel, detectLocalServers } from '../detect-local-servers.ts';
import type { DetectFetch } from '../detect-local-servers.ts';
import type { ExecFn } from '../managed/preconditions.ts';
import { aboutModel } from '../managed/name.ts';
import { reportedWindowOf } from './sources.ts';

export type ReportedWindowRead = { address: string; model: string; fetch: DetectFetch; signal: AbortSignal };

const RUNS_NO_PROGRAM: ExecFn = async (file) => {
  throw new Error(`the read of a reported window runs no program, and was asked to run ${file}`);
};

const listsModel = (kind: string, listed: DetectedModel, model: string): boolean => {
  if (listed.id === model) return true;
  const defaultTag = SERVER_KINDS.find((candidate) => candidate.kind === kind)?.defaultTag;
  return defaultTag !== undefined && !model.includes(':') && listed.id === `${model}:${defaultTag}`;
};

export const reportedWindowAt = async (read: ReportedWindowRead): Promise<number | undefined> => {
  const found = await detectLocalServers({ candidates: [], typed: [read.address], signal: read.signal, fetch: read.fetch, servers: [], exec: RUNS_NO_PROGRAM, exists: async () => false });
  for (const server of found) {
    if (!('models' in server)) continue;
    const listed = server.models.find((candidate) => listsModel(server.kind, candidate, read.model));
    if (listed === undefined) continue;
    return reportedWindowOf(await describeModel({ server, model: listed, signal: read.signal, fetch: read.fetch }));
  }
  return undefined;
};

export class DeclaredWindowAboveReportedError extends PreconditionFailedError {
  constructor(display: string, declared: number, reported: number, address: string) {
    super(
      aboutModel(display, `the declared capabilities.contextWindow ${declared} is above the ${reported} tokens the server at ${address} reports for it`),
      undefined,
      `declare capabilities.contextWindow ${reported}, or load the model with a context length of at least ${declared}`,
    );
    this.name = 'DeclaredWindowAboveReportedError';
  }
}

export class ReportedWindowMissingError extends PreconditionFailedError {
  constructor(display: string) {
    super(aboutModel(display, NO_REPORTED_WINDOW), undefined, 'declare capabilities.contextWindow');
    this.name = 'ReportedWindowMissingError';
  }
}

export const refusingAdapter = (adapter: ProviderAdapter, refusalAt: () => PreconditionFailedError): ProviderAdapter => ({
  ...adapter,
  capabilities: async () => {
    throw refusalAt();
  },
  create: async function* () {
    yield* [];
    throw refusalAt();
  },
});
