import type { Clock } from '@momonga/foundation';
import { INSPECTOR_MEMORY_LIFECYCLE_LIMIT } from '@momonga/protocol';
import type {
  InspectorMemoryControlAction,
  InspectorMemoryLifecycleEvent,
  InspectorMemoryLifecycleKind,
  InspectorMemoryRetrievalTrace,
} from '@momonga/protocol';

const MAX_INSPECTOR_SESSIONS = 64;

export type SessionInspectorOverrides = {
  readonly excludedCallIds: readonly string[];
  readonly excludedMemoryIds: readonly string[];
  readonly pinnedMemoryIds: readonly string[];
};

export type SessionInspectorReadState = {
  readonly excludedCallIds: readonly string[];
  readonly excludedMemoryIds: readonly string[];
  readonly pinnedMemoryIds: readonly string[];
  readonly lastRetrievalTrace: InspectorMemoryRetrievalTrace | null;
  readonly lifecycle: readonly InspectorMemoryLifecycleEvent[];
};

type SessionEntry = {
  excludedCallIds: Set<string>;
  excludedMemoryIds: Set<string>;
  pinnedMemoryIds: Set<string>;
  lastRetrievalTrace: InspectorMemoryRetrievalTrace | null;
  lastTraceKey: string;
  lifecycle: InspectorMemoryLifecycleEvent[];
};

type GlobalLifecycleRecord = {
  readonly project: string | null;
  readonly event: InspectorMemoryLifecycleEvent;
};

export type SessionInspectorState = {
  getOverrides(sessionId: string): SessionInspectorOverrides;
  setCallExcluded(sessionId: string, callId: string, excluded: boolean): boolean;
  applyMemoryControl(sessionId: string, memoryId: string, summary: string, action: InspectorMemoryControlAction): void;
  recordRetrievalTrace(sessionId: string, trace: InspectorMemoryRetrievalTrace, loadedIds: readonly string[]): void;
  recordGlobalLifecycle(project: string | null, kind: InspectorMemoryLifecycleKind, memoryId: string, summary: string, detail?: string): void;
  getState(sessionId: string, project: string | null): SessionInspectorReadState;
};

const pushBounded = <T>(buffer: T[], entry: T, limit: number): void => {
  buffer.push(entry);
  if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
};

export const createSessionInspectorState = (clock: Clock): SessionInspectorState => {
  const sessions = new Map<string, SessionEntry>();
  const globalLifecycle: GlobalLifecycleRecord[] = [];
  let seq = 0;

  const nextId = (): string => {
    seq += 1;
    return `insp-mem-${seq}`;
  };

  const ensureSession = (sessionId: string): SessionEntry => {
    const existing = sessions.get(sessionId);
    if (existing !== undefined) {
      // Promote to MRU.
      sessions.delete(sessionId);
      sessions.set(sessionId, existing);
      return existing;
    }
    const created: SessionEntry = {
      excludedCallIds: new Set<string>(),
      excludedMemoryIds: new Set<string>(),
      pinnedMemoryIds: new Set<string>(),
      lastRetrievalTrace: null,
      lastTraceKey: '',
      lifecycle: [],
    };
    sessions.set(sessionId, created);
    while (sessions.size > MAX_INSPECTOR_SESSIONS) {
      const oldest = sessions.keys().next();
      if (oldest.done) break;
      sessions.delete(oldest.value);
    }
    return created;
  };

  const peekSession = (sessionId: string): SessionEntry | undefined => {
    const existing = sessions.get(sessionId);
    if (existing !== undefined) {
      sessions.delete(sessionId);
      sessions.set(sessionId, existing);
    }
    return existing;
  };

  const pushSessionLifecycle = (
    entry: SessionEntry,
    kind: InspectorMemoryLifecycleKind,
    memoryId: string,
    summary: string,
    detail?: string,
  ): void => {
    pushBounded(
      entry.lifecycle,
      {
        id: nextId(),
        at: clock.now(),
        kind,
        memoryId,
        summary,
        ...(detail === undefined ? {} : { detail }),
      },
      INSPECTOR_MEMORY_LIFECYCLE_LIMIT,
    );
  };

  return {
    getOverrides: (sessionId) => {
      const entry = peekSession(sessionId);
      if (entry === undefined) return { excludedCallIds: [], excludedMemoryIds: [], pinnedMemoryIds: [] };
      return {
        excludedCallIds: [...entry.excludedCallIds],
        excludedMemoryIds: [...entry.excludedMemoryIds],
        pinnedMemoryIds: [...entry.pinnedMemoryIds],
      };
    },

    setCallExcluded: (sessionId, callId, excluded) => {
      const entry = ensureSession(sessionId);
      if (excluded) {
        const had = entry.excludedCallIds.has(callId);
        entry.excludedCallIds.add(callId);
        return !had;
      }
      return entry.excludedCallIds.delete(callId);
    },

    applyMemoryControl: (sessionId, memoryId, summary, action) => {
      const entry = ensureSession(sessionId);
      if (action === 'exclude') {
        entry.excludedMemoryIds.add(memoryId);
        entry.pinnedMemoryIds.delete(memoryId);
        pushSessionLifecycle(entry, 'session_excluded', memoryId, summary, 'Excluded for this session');
      } else if (action === 'include') {
        entry.excludedMemoryIds.delete(memoryId);
        pushSessionLifecycle(entry, 'session_included', memoryId, summary, 'Included for this session');
      } else if (action === 'pin') {
        entry.pinnedMemoryIds.add(memoryId);
        entry.excludedMemoryIds.delete(memoryId);
        pushSessionLifecycle(entry, 'session_pinned', memoryId, summary, 'Prioritized for this session');
      } else {
        entry.pinnedMemoryIds.delete(memoryId);
        pushSessionLifecycle(entry, 'session_unpinned', memoryId, summary, 'Unpinned for this session');
      }
    },

    recordRetrievalTrace: (sessionId, trace, loadedIds) => {
      const entry = ensureSession(sessionId);
      entry.lastRetrievalTrace = trace;
      const traceKey = `${trace.query}|${loadedIds.join(',')}`;
      if (traceKey === entry.lastTraceKey) return;
      entry.lastTraceKey = traceKey;
      if (trace.candidateCount > 0) {
        pushSessionLifecycle(
          entry,
          'recalled',
          loadedIds[0] ?? trace.candidates[0]?.id ?? 'query',
          trace.query === '' ? 'Recalled session memories' : trace.query,
          `${trace.selectedCount} selected from ${trace.candidateCount} candidate(s)`,
        );
      }
      for (const id of loadedIds) {
        const candidate = trace.candidates.find((item) => item.id === id);
        pushSessionLifecycle(entry, 'injected', id, candidate?.summary ?? id, candidate?.reason ?? 'loaded');
      }
    },

    recordGlobalLifecycle: (project, kind, memoryId, summary, detail) => {
      pushBounded(
        globalLifecycle,
        {
          project,
          event: {
            id: nextId(),
            at: clock.now(),
            kind,
            memoryId,
            summary,
            ...(detail === undefined ? {} : { detail }),
          },
        },
        INSPECTOR_MEMORY_LIFECYCLE_LIMIT,
      );
    },

    getState: (sessionId, project) => {
      const entry = peekSession(sessionId);
      const local = entry?.lifecycle ?? [];
      const global = globalLifecycle
        .filter((record) => record.project === null || record.project === project)
        .map((record) => record.event);
      const combined = [...local, ...global]
        .sort((left, right) => left.at - right.at || left.id.localeCompare(right.id))
        .slice(-INSPECTOR_MEMORY_LIFECYCLE_LIMIT);
      return {
        excludedCallIds: entry === undefined ? [] : [...entry.excludedCallIds],
        excludedMemoryIds: entry === undefined ? [] : [...entry.excludedMemoryIds],
        pinnedMemoryIds: entry === undefined ? [] : [...entry.pinnedMemoryIds],
        lastRetrievalTrace: entry?.lastRetrievalTrace ?? null,
        lifecycle: combined,
      };
    },
  };
};
