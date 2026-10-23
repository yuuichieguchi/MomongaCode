import type { Clock, JsonLogger } from '@momonga/foundation';
import type { RuntimeStore, Session } from '@momonga/store';
import type { ToolSessionState } from '@momonga/tools';
import { SESSION_STATE_IDLE_MS } from './constants.ts';

export type SessionStates = {
  get(session: Pick<Session, 'id' | 'cwd'>): ToolSessionState;
  has(sessionId: string): boolean;
  evictIdle(nowMs: number): string[];
  size(): number;
};

export type SessionStatesOptions = {
  clock: Clock;
  store: Pick<RuntimeStore, 'sessionActivity'>;
  logger: JsonLogger;
};

type Entry = { state: ToolSessionState; lastUsedAt: number };

export const createSessionStates = ({ clock, store, logger }: SessionStatesOptions): SessionStates => {
  const entries = new Map<string, Entry>();
  return {
    get: (session) => {
      const existing = entries.get(session.id);
      if (existing !== undefined) {
        existing.lastUsedAt = clock.now();
        return existing.state;
      }
      const entry: Entry = { state: { cwd: session.cwd, readLedger: new Map() }, lastUsedAt: clock.now() };
      entries.set(session.id, entry);
      return entry.state;
    },
    has: (sessionId) => entries.has(sessionId),
    evictIdle: (nowMs) => {
      const evicted: string[] = [];
      for (const [id, entry] of entries) {
        if (entry.lastUsedAt > nowMs - SESSION_STATE_IDLE_MS) continue;
        if (store.sessionActivity(id)?.hasActiveRun === true) continue;
        entries.delete(id);
        evicted.push(id);
      }
      if (evicted.length > 0) logger.debug('session_state.evicted', { count: evicted.length, ids: evicted });
      return evicted;
    },
    size: () => entries.size,
  };
};
