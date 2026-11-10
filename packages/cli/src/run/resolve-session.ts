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

export const reopenCommand = (id: string): string => `momonga --resume ${id}`;

export const hasRun = (session: SessionView): boolean => session.latestRunId !== null;

export const newestFirst = <T extends { createdAt: number }>(sessions: readonly T[]): T[] => [...sessions].sort((left, right) => right.createdAt - left.createdAt);

const namedBy = (sessions: readonly SessionView[], wanted: string): SessionView => {
  const exact = sessions.find((session) => session.id === wanted);
  if (exact !== undefined) return exact;
  if (wanted.length < SESSION_PREFIX_MIN) throw new SessionRefused(`No conversation has the id ${wanted}. A shortened id needs at least ${SESSION_PREFIX_MIN} characters.`);
  const matching = sessions.filter((session) => session.id.startsWith(wanted));
  const [only] = matching;
  if (only === undefined) throw new SessionRefused(`No conversation has the id ${wanted}.`);
  if (matching.length > 1) throw new SessionRefused(`${wanted} matches more than one conversation: ${matching.map((session) => session.id).join(', ')}`);
  return only;
};

export const resolveSession = async (client: StoredSessions, cwd: string, wanted: string): Promise<SessionView> => {
  const found = namedBy(await client.listSessions(), wanted);
  const here = await client.listSessions(cwd);
  if (!here.some((session) => session.id === found.id)) throw new SessionRefused(`That conversation belongs to ${found.cwd}. Run: cd ${found.cwd} && ${reopenCommand(found.id)}`);
  return found;
};

export const continuedSession = async (client: StoredSessions, cwd: string): Promise<SessionView> => {
  const [newest] = newestFirst((await client.listSessions(cwd)).filter(hasRun));
  if (newest === undefined) throw new SessionRefused(`No conversation to continue in ${cwd}.`);
  return newest;
};

export const reopenedSession = (client: StoredSessions, cwd: string, reopen: HeadlessReopen): Promise<SessionView> => (reopen.kind === 'id' ? resolveSession(client, cwd, reopen.id) : continuedSession(client, cwd));
