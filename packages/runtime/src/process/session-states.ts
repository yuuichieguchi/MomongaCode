import type { Clock, JsonLogger } from '@momonga/foundation';
import type { RuntimeStore, Session } from '@momonga/store';
import type { ToolSessionState } from '@momonga/tools';
import { SESSION_STATE_IDLE_MS } from './constants.ts';

export type SessionStates = {
  get(session: Pick<Session, 'id' | 'cwd'>): ToolSessionState;
  has(sessionId: string): boolean;
  evictIdle(nowMs: number): string[];
  evictAll(): string[];
  size(): number;
};

export type SessionStatesOptions = {
  clock: Clock;
  store: Pick<RuntimeStore, 'sessionActivity'>;
  logger: JsonLogger;
  releaseScratch(sessionId: string): void;
};

type Entry = { state: ToolSessionState; lastUsedAt: number };

export const createSessionStates = ({ clock, store, logger, releaseScratch }: SessionStatesOptions): SessionStates => {
  const entries = new Map<string, Entry>();
  const evict = (ids: readonly string[]): string[] => {
    for (const id of ids) {
      entries.delete(id);
      releaseScratch(id);
    }
    if (ids.length > 0) logger.debug('session_state.evicted', { count: ids.length, ids });
    return [...ids];
  };
  const withoutActiveRun = (id: string): boolean => store.sessionActivity(id)?.hasActiveRun !== true;
  return {
    get: (session) => {
      const existing = entries.get(session.id);
      if (existing !== undefined) {
        existing.lastUsedAt = clock.now();
        return existing.state;
      }
      const entry: Entry = { state: { cwd: session.cwd, workingDirectory: session.cwd, readLedger: new Map() }, lastUsedAt: clock.now() };
      entries.set(session.id, entry);
      return entry.state;
    },
    has: (sessionId) => entries.has(sessionId),
    evictIdle: (nowMs) => evict([...entries].filter(([id, entry]) => entry.lastUsedAt <= nowMs - SESSION_STATE_IDLE_MS && withoutActiveRun(id)).map(([id]) => id)),
    evictAll: () => evict([...entries.keys()]),
    size: () => entries.size,
  };
};
