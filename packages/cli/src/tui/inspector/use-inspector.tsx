import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createRedactor } from '@momonga/foundation';
import { createInspectorAccumulator, emptyInspectorSnapshot } from '@momonga/protocol';
import type { InspectorSnapshot, InspectorTab, PublicStreamEvent } from '@momonga/protocol';
import type { KeyEvent } from '../terminal/events.ts';
import type { KeyContext, KeyTable } from '../keys/table.ts';
import type { ScreenTimers } from '../screen/timers.ts';
import type { OverlayPorts } from '../picker.tsx';
import type { TuiBackend } from '../backend.ts';
import {
  INITIAL_INSPECTOR_UI_STATE,
  filteredSortedContextItems,
  parseInspectorTab,
  reduceInspectorUi,
  resolveSelectedIndex,
} from './state.ts';
import { InspectorView, inspectorRowIdsFor } from './view.tsx';

const INSPECTOR_CONTEXT: readonly KeyContext[] = ['inspector', 'global'];
const LIVE_REFRESH_DEBOUNCE_MS = 250;

export type UseInspectorOptions = {
  readonly backend: TuiBackend;
  readonly keys: KeyTable;
  readonly timers: Pick<ScreenTimers, 'setTimeout' | 'clearTimeout'>;
  readonly now: () => number;
  readonly columns: number;
  readonly rows: number;
  readonly fullscreen: boolean;
  readonly overlays: Pick<OverlayPorts, 'choose' | 'promptText'>;
  readonly compact: (instructions: string | undefined) => Promise<void>;
  readonly isRunning: () => boolean;
  readonly note: (text: string) => void;
};

export type InspectorController = {
  readonly shown: boolean;
  readonly view: ReturnType<typeof InspectorView>;
  open(tabArg?: string): void;
  close(): void;
  refresh(): void;
  resetSession(session?: { id: string; cwd: string; model: string }): void;
  ingestEvent(event: PublicStreamEvent): void;
  setLiveConnected(connected: boolean): void;
  key(event: KeyEvent, pressed: KeyTable): boolean;
};

const errorTextOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const useInspector = (options: UseInspectorOptions): InspectorController => {
  const { backend, keys, timers, now, columns, rows, fullscreen, overlays, compact, isRunning, note } = options;

  const [ui, dispatch] = useReducer(reduceInspectorUi, INITIAL_INSPECTOR_UI_STATE);
  const uiRef = useRef(ui);
  uiRef.current = ui;

  const redactor = useMemo(() => createRedactor({ credentials: [] }), []);
  const accumulator = useMemo(
    () =>
      createInspectorAccumulator({
        now,
        redact: (input) => redactor.text(input),
      }),
    [now, redactor],
  );

  const [snapshot, setSnapshot] = useState<InspectorSnapshot>(() =>
    emptyInspectorSnapshot({ now: now() }),
  );
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const mountedRef = useRef(true);
  const refreshTimerRef = useRef<ReturnType<ScreenTimers['setTimeout']> | undefined>(undefined);
  const refreshSeqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (refreshTimerRef.current !== undefined) {
        timers.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = undefined;
      }
    };
  }, [timers]);

  useEffect(() => accumulator.subscribe(() => {
    if (!mountedRef.current) return;
    setSnapshot(accumulator.snapshot());
  }), [accumulator]);

  const fetchSnapshot = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    dispatch({ type: 'loading', value: true });
    try {
      const next = await backend.inspector();
      if (!mountedRef.current || seq !== refreshSeqRef.current) return;
      accumulator.mergeServerSnapshot(next);
      setSnapshot(accumulator.snapshot());
      dispatch({ type: 'loaded', at: now(), error: null });
    } catch (error) {
      if (!mountedRef.current || seq !== refreshSeqRef.current) return;
      dispatch({ type: 'loaded', at: now(), error: errorTextOf(error) });
    }
  }, [accumulator, backend, now]);

  const scheduleRefresh = useCallback(() => {
    if (!uiRef.current.open) return;
    if (refreshTimerRef.current !== undefined) return;
    refreshTimerRef.current = timers.setTimeout(() => {
      refreshTimerRef.current = undefined;
      if (uiRef.current.open) void fetchSnapshot();
    }, LIVE_REFRESH_DEBOUNCE_MS);
  }, [fetchSnapshot, timers]);

  const open = useCallback(
    (tabArg?: string) => {
      const tab = parseInspectorTab(tabArg);
      dispatch({ type: 'open', ...(tab === undefined ? {} : { tab }) });
      void fetchSnapshot();
    },
    [fetchSnapshot],
  );

  const close = useCallback(() => {
    if (refreshTimerRef.current !== undefined) {
      timers.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = undefined;
    }
    dispatch({ type: 'close' });
  }, [timers]);

  const resetSession = useCallback(
    (session?: { id: string; cwd: string; model: string }) => {
      accumulator.resetForSession(session ?? {});
      setSnapshot(accumulator.snapshot());
      if (uiRef.current.open) void fetchSnapshot();
    },
    [accumulator, fetchSnapshot],
  );

  const ingestEvent = useCallback(
    (event: PublicStreamEvent) => {
      accumulator.ingestEvent(event);
      if (uiRef.current.open) scheduleRefresh();
    },
    [accumulator, scheduleRefresh],
  );

  const setLiveConnected = useCallback(
    (connected: boolean) => {
      accumulator.setLiveConnected(connected);
    },
    [accumulator],
  );

  const applySnapshot = useCallback(
    (next: InspectorSnapshot, message?: string) => {
      accumulator.mergeServerSnapshot(next);
      setSnapshot(accumulator.snapshot());
      if (message !== undefined) dispatch({ type: 'status', message });
    },
    [accumulator],
  );

  const selectedContextItem = () => {
    const items = filteredSortedContextItems(snapshotRef.current, uiRef.current);
    const ids = items.map((i) => i.id);
    const idx = resolveSelectedIndex(uiRef.current, ids);
    return items[idx];
  };

  const selectedMemoryId = (): string | undefined => {
    const snap = snapshotRef.current;
    const cur = uiRef.current;
    const ids = inspectorRowIdsFor(snap, cur);
    if (ids.length === 0) return undefined;
    const idx = resolveSelectedIndex(cur, ids);
    return ids[idx];
  };

  const runActionAsync = useCallback((work: () => Promise<void>) => {
    work().catch((error: unknown) => {
      if (mountedRef.current) dispatch({ type: 'status', message: `Action failed: ${errorTextOf(error)}` });
    });
  }, []);

  const handleToggleContextExclude = useCallback(() => {
    const cur = uiRef.current;
    if (cur.tab !== 'context' || cur.contextSubView !== 'explorer') return;
    const item = selectedContextItem();
    if (item === undefined || !item.excludable || item.callId === undefined) {
      dispatch({ type: 'status', message: 'Select a tool result item in Context Explorer to exclude.' });
      return;
    }
    const callId = item.callId;
    const nextExcluded = !(item.evicted === true);
    runActionAsync(async () => {
      const next = await backend.inspectorExcludeContextItem({ callId, excluded: nextExcluded });
      applySnapshot(next, `${nextExcluded ? 'Excluded' : 'Restored'} ${callId} for this session`);
    });
  }, [applySnapshot, backend, runActionAsync]);

  const handleCompaction = useCallback(() => {
    if (isRunning()) {
      dispatch({ type: 'status', message: 'Cannot start compaction while a run is active.' });
      return;
    }
    runActionAsync(async () => {
      const choice = await overlays.choose({
        title: 'Run manual compaction',
        lines: ['Run compaction on earlier session messages into a summary while preserving active rules and memories.'],
        rows: [
          { label: 'Run compaction now', description: 'Run compaction on the active session' },
          { label: 'Cancel', description: 'Go back to Agent Inspector' },
        ],
      });
      if (choice?.index !== 0) return;
      close();
      note('Starting manual compaction from Agent Inspector.');
      await compact(undefined);
    });
  }, [close, compact, isRunning, note, overlays, runActionAsync]);

  const handleMemoryControl = useCallback(
    (mode: 'exclude' | 'pin') => {
      const memoryId = selectedMemoryId();
      if (memoryId === undefined || uiRef.current.memorySubView === 'lifecycle') {
        dispatch({ type: 'status', message: 'Select a memory row first.' });
        return;
      }
      const snap = snapshotRef.current;
      const isExcluded = snap.memory.sessionControls.excludedIds.includes(memoryId);
      const isPinned = snap.memory.sessionControls.pinnedIds.includes(memoryId);
      const action =
        mode === 'exclude' ? (isExcluded ? 'include' : 'exclude') : isPinned ? 'unpin' : 'pin';
      runActionAsync(async () => {
        const next = await backend.inspectorControlMemory({ memoryId, action });
        applySnapshot(next, `Session memory ${action}: ${memoryId}`);
      });
    },
    [applySnapshot, backend, runActionAsync],
  );

  const handleMemorySearch = useCallback(() => {
    runActionAsync(async () => {
      const query = await overlays.promptText({
        title: 'Search long-term memory',
        lines: ['Run a live retrieval trace against visible memories.'],
        validate: () => undefined,
      });
      if (query === undefined) return;
      const trace = await backend.inspectorSearchMemories(query.trim());
      const current = snapshotRef.current;
      applySnapshot(
        {
          ...current,
          memory: { ...current.memory, retrievalTrace: trace },
        },
        `Retrieval trace: ${trace.selectedCount} selected / ${trace.candidateCount} candidates`,
      );
      dispatch({ type: 'set_sub_view', subView: 'trace' });
    });
  }, [applySnapshot, backend, overlays, runActionAsync]);

  const handleMemoryEdit = useCallback(() => {
    const memoryId = selectedMemoryId();
    if (memoryId === undefined || uiRef.current.memorySubView === 'lifecycle') {
      dispatch({ type: 'status', message: 'Select a memory row to edit.' });
      return;
    }
    const existing =
      snapshotRef.current.memory.allMemories.find((m) => m.id === memoryId) ??
      snapshotRef.current.memory.active.find((m) => m.id === memoryId);
    if (existing === undefined) {
      dispatch({ type: 'status', message: 'Memory details unavailable.' });
      return;
    }
    runActionAsync(async () => {
      const editedText = await overlays.promptText({
        title: `Edit persistent memory (${memoryId})`,
        lines: ['This saves a new persistent revision and retires the prior entry.'],
        initial: existing.text,
        validate: (text) => (text.trim() === '' ? 'Memory text cannot be empty.' : undefined),
      });
      if (editedText === undefined) return;
      await backend.editMemory(memoryId, editedText.trim());
      await fetchSnapshot();
      dispatch({ type: 'status', message: `Updated persistent memory ${memoryId}` });
    });
  }, [backend, fetchSnapshot, overlays, runActionAsync]);

  const handleMemoryRetire = useCallback(() => {
    const memoryId = selectedMemoryId();
    if (memoryId === undefined || uiRef.current.memorySubView === 'lifecycle') {
      dispatch({ type: 'status', message: 'Select a memory row to retire.' });
      return;
    }
    runActionAsync(async () => {
      const choice = await overlays.choose({
        title: `Retire persistent memory (${memoryId})?`,
        lines: ['This permanently retires the stored memory entry across sessions.'],
        rows: [
          { label: 'Retire memory', description: 'Persistently retire this memory' },
          { label: 'Cancel', description: 'Keep memory unchanged' },
        ],
      });
      if (choice?.index !== 0) return;
      await backend.deleteMemory(memoryId);
      await fetchSnapshot();
      dispatch({ type: 'status', message: `Retired persistent memory ${memoryId}` });
    });
  }, [backend, fetchSnapshot, overlays, runActionAsync]);

  const openCurrentDetail = useCallback(() => {
    const snap = snapshotRef.current;
    const cur = uiRef.current;
    const ids = inspectorRowIdsFor(snap, cur);
    if (ids.length === 0) return;
    const idx = resolveSelectedIndex(cur, ids);
    const id = ids[idx];
    if (id === undefined) return;
    if (cur.tab === 'context') {
      if (cur.contextSubView === 'compactions') {
        dispatch({ type: 'open_detail', target: { kind: 'compaction', id } });
      } else if (cur.contextSubView === 'explorer') {
        dispatch({ type: 'open_detail', target: { kind: 'context_item', id } });
      }
    } else if (cur.tab === 'memory') {
      if (cur.memorySubView === 'active' || cur.memorySubView === 'all' || cur.memorySubView === 'trace') {
        dispatch({ type: 'open_detail', target: { kind: 'memory', id } });
      }
    } else if (cur.tab === 'usage' && cur.usageSubView === 'requests') {
      dispatch({ type: 'open_detail', target: { kind: 'request', id } });
    } else if (cur.tab === 'execution' && cur.executionSubView === 'tools') {
      dispatch({ type: 'open_detail', target: { kind: 'tool', id } });
    }
  }, []);

  const key = useCallback(
    (event: KeyEvent, pressed: KeyTable): boolean => {
      if (!uiRef.current.open) return false;
      const action = pressed.actionOf(INSPECTOR_CONTEXT, event, 'plain');
      if (action === undefined) return true;

      if (action === 'inspector.close') {
        if (uiRef.current.detail !== null) dispatch({ type: 'close_detail' });
        else close();
        return true;
      }
      if (action === 'inspector.back') {
        if (uiRef.current.detail !== null) dispatch({ type: 'close_detail' });
        return true;
      }
      if (action === 'inspector.tabNext') {
        dispatch({ type: 'next_tab' });
        return true;
      }
      if (action === 'inspector.tabPrev') {
        dispatch({ type: 'prev_tab' });
        return true;
      }
      const tabByAction: Partial<Record<typeof action, InspectorTab>> = {
        'inspector.tab1': 'overview',
        'inspector.tab2': 'context',
        'inspector.tab3': 'memory',
        'inspector.tab4': 'usage',
        'inspector.tab5': 'execution',
      };
      const targetTab = tabByAction[action];
      if (targetTab !== undefined) {
        dispatch({ type: 'set_tab', tab: targetTab });
        return true;
      }
      if (action === 'inspector.subView') {
        dispatch({ type: 'cycle_sub_view' });
        return true;
      }
      if (action === 'inspector.sort') {
        dispatch({ type: 'cycle_sort' });
        return true;
      }
      if (action === 'inspector.filter') {
        dispatch({ type: 'cycle_filter' });
        return true;
      }
      if (action === 'inspector.up' || action === 'inspector.down') {
        const ids = inspectorRowIdsFor(snapshotRef.current, uiRef.current);
        dispatch({ type: 'move_selection', delta: action === 'inspector.up' ? -1 : 1, itemIds: ids });
        return true;
      }
      if (action === 'inspector.openDetail') {
        openCurrentDetail();
        return true;
      }
      if (action === 'inspector.refresh') {
        void fetchSnapshot();
        return true;
      }
      if (action === 'inspector.compact') {
        handleCompaction();
        return true;
      }
      if (action === 'inspector.exclude') {
        if (uiRef.current.tab === 'context') handleToggleContextExclude();
        else if (uiRef.current.tab === 'memory') handleMemoryControl('exclude');
        return true;
      }
      if (action === 'inspector.pin') {
        if (uiRef.current.tab === 'memory') handleMemoryControl('pin');
        return true;
      }
      if (action === 'inspector.search') {
        if (uiRef.current.tab === 'memory') handleMemorySearch();
        return true;
      }
      if (action === 'inspector.edit') {
        if (uiRef.current.tab === 'memory') handleMemoryEdit();
        return true;
      }
      if (action === 'inspector.delete') {
        if (uiRef.current.tab === 'memory') handleMemoryRetire();
        return true;
      }
      return false;
    },
    [
      close,
      fetchSnapshot,
      handleCompaction,
      handleMemoryControl,
      handleMemoryEdit,
      handleMemoryRetire,
      handleMemorySearch,
      handleToggleContextExclude,
      openCurrentDetail,
    ],
  );

  const view = <InspectorView snapshot={snapshot} ui={ui} keys={keys} columns={columns} rows={rows} fullscreen={fullscreen} />;

  return {
    shown: ui.open,
    view,
    open,
    close,
    refresh: () => void fetchSnapshot(),
    resetSession,
    ingestEvent,
    setLiveConnected,
    key,
  };
};
