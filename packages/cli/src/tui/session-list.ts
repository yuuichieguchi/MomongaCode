import type { RuntimeClient } from '../client/runtime-client.ts';
import { hasRun, newestFirst } from '../run/resolve-session.ts';
import type { RunView, SessionView } from '../client/views.ts';

export type ListedSession = { id: string; createdAt: number; runs: number; firstPrompt: string };

export type SessionReads = Pick<RuntimeClient, 'listSessions' | 'listRuns' | 'streamEvents'>;

export const SESSION_READS_AT_ONCE = 8;

export const ownRunsOf = async (reads: Pick<SessionReads, 'listRuns'>, sessionId: string): Promise<RunView[]> => (await reads.listRuns(sessionId)).filter((run) => run.parentRunId === null).sort((left, right) => left.ordinal - right.ordinal);

const firstPromptOf = async (reads: Pick<SessionReads, 'streamEvents'>, runId: string, signal: AbortSignal): Promise<string> => {
  const reading = new AbortController();
  try {
    for await (const frame of reads.streamEvents(runId, { signal: AbortSignal.any([signal, reading.signal]) })) return frame.data.type === 'user.message' ? frame.data.text : '';
    return '';
  } finally {
    reading.abort();
  }
};

const listed = async (reads: SessionReads, stored: SessionView, signal: AbortSignal): Promise<ListedSession> => {
  const runs = await ownRunsOf(reads, stored.id);
  const [first] = runs;
  return { id: stored.id, createdAt: stored.createdAt, runs: runs.length, firstPrompt: first === undefined ? '' : await firstPromptOf(reads, first.id, signal) };
};

export const listedSessions = async (reads: SessionReads, cwd: string, openId: string | undefined, signal: AbortSignal): Promise<ListedSession[]> => {
  const wanted = newestFirst((await reads.listSessions(cwd)).filter(hasRun)).filter((stored) => stored.id !== openId);
  const found: ListedSession[] = [];
  for (let start = 0; start < wanted.length; start += SESSION_READS_AT_ONCE) found.push(...(await Promise.all(wanted.slice(start, start + SESSION_READS_AT_ONCE).map((stored) => listed(reads, stored, signal)))));
  return found;
};
