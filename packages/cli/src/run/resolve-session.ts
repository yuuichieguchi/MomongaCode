import { messageOf } from '@momonga/protocol';
import type { RuntimeClient } from '../client/runtime-client.ts';
import type { SessionView } from '../client/views.ts';

export type Reopen = { kind: 'id'; id: string } | { kind: 'newest' } | { kind: 'pick' };

export type HeadlessReopen = Exclude<Reopen, { kind: 'pick' }>;

export const SESSION_PREFIX_MIN = 8;

export class SessionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionRefused';
  }
}

export type StoredSessions = Pick<RuntimeClient, 'listSessions'>;

export const hasRun = (session: SessionView): boolean => session.latestRunId !== null;

export const newestFirst = <T extends { createdAt: number }>(sessions: readonly T[]): T[] => [...sessions].sort((left, right) => right.createdAt - left.createdAt);

export type RunOfSession = { session: SessionView; runId: string; at: number };

export type RunOfSessionKind = 'active' | 'latest';

const runOf = (session: SessionView, kind: RunOfSessionKind): RunOfSession[] => {
  const runId = kind === 'active' ? session.activeRunId : session.latestRunId;
  const at = kind === 'active' ? session.activeRunAt : session.latestRunAt;
  return runId === null || at === null ? [] : [{ session, runId, at }];
};

const laterRunFirst = (left: RunOfSession, right: RunOfSession): number => right.at - left.at || (left.runId < right.runId ? 1 : -1);

export const runsNewestFirst = (sessions: readonly SessionView[], kind: RunOfSessionKind): RunOfSession[] => sessions.flatMap((session) => runOf(session, kind)).sort(laterRunFirst);

const namedBy = (sessions: readonly SessionView[], wanted: string): SessionView | undefined => {
  const exact = sessions.find((session) => session.id === wanted);
  if (exact !== undefined) return exact;
  if (wanted.length < SESSION_PREFIX_MIN) return undefined;
  const matching = sessions.filter((session) => session.id.startsWith(wanted));
  if (matching.length > 1) throw new SessionRefused(messageOf('sessionAmbiguous', 'cli', { id: wanted, matches: matching.map((session) => session.id) }));
  return matching[0];
};

export const resolveSession = async (client: StoredSessions, cwd: string, wanted: string): Promise<SessionView> => {
  const here = namedBy(await client.listSessions(cwd), wanted);
  if (here !== undefined) return here;
  const elsewhere = namedBy(await client.listSessions(), wanted);
  if (elsewhere !== undefined) throw new SessionRefused(messageOf('sessionInOtherFolder', 'cli', { id: elsewhere.id, folder: elsewhere.cwd }));
  throw new SessionRefused(messageOf(wanted.length < SESSION_PREFIX_MIN ? 'sessionIdTooShort' : 'sessionNotFound', 'cli', { id: wanted, minimum: SESSION_PREFIX_MIN }));
};

export const continuedSession = async (client: StoredSessions, cwd: string): Promise<SessionView> => {
  const [workedInLast] = runsNewestFirst(await client.listSessions(cwd), 'latest');
  if (workedInLast === undefined) throw new SessionRefused(messageOf('noSessionToContinue', 'cli', { folder: cwd }));
  return workedInLast.session;
};

export const reopenedSession = (client: StoredSessions, cwd: string, reopen: HeadlessReopen): Promise<SessionView> => (reopen.kind === 'id' ? resolveSession(client, cwd, reopen.id) : continuedSession(client, cwd));
