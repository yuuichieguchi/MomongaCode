import type { PublicRunEvent } from '@momonga/protocol';
import { describeRunEnd } from '../../run/headless.ts';
import type { ChildEnd } from '../../run/follow.ts';
import { appendEntry, foldLiveEvent } from '../transcript.ts';
import type { Entry } from '../transcript.ts';
import { fit } from './footer.tsx';
import { createTranscriptStore } from './store.ts';
import { segmentsOf } from './wrap.ts';
import type { TranscriptStore } from './store.ts';

export type AgentLoading = { readonly applied: number; readonly backlog: number };

export type AgentView = { readonly runId: string; readonly agent: string; readonly model: string; readonly store: TranscriptStore; readonly end: ChildEnd | undefined; readonly loading: AgentLoading | undefined };

type Kept = { runId: string; agent: string; model: string; store: TranscriptStore; end: ChildEnd | undefined; loading: AgentLoading | undefined; firstSeq: number | undefined; stops: Map<StoreWatcher, () => void> };

export type StoreWatcher = (store: TranscriptStore) => () => void;

export type AgentViews = {
  started(agent: string, runId: string, backlog: number, model: string): void;
  event(event: PublicRunEvent): void;
  ended(runId: string, end: ChildEnd): void;
  open(runId: string | undefined): void;
  shown(): AgentView | undefined;
  kept(): number;
  watch(watcher: StoreWatcher): () => void;
  subscribe(listener: () => void): () => void;
  version(): number;
};

export type AgentHeaderFacts = { readonly agent: string; readonly state: string; readonly model: string };

const ELLIPSIS = '…';

export const agentHeader = ({ agent, state, model }: AgentHeaderFacts, columns: number): string => {
  const rest = `${state} · model: ${model}`;
  const names = segmentsOf(agent).map(({ index }) => `${agent.slice(0, index)}${ELLIPSIS}`).filter((name) => name !== ELLIPSIS).reverse();
  return fit([{ side: 'left', forms: [`Subagent ${agent} · ${rest}`, `${agent} · ${rest}`, ...names.map((name) => `${name} · ${rest}`), rest] }], columns);
};

export const endStateOf = (end: ChildEnd): string => (end.kind === 'finished' ? end.run.status : 'FAILED');

const endEntryOf = (end: ChildEnd): Entry => {
  if (end.kind === 'failed') return { kind: 'error', text: end.error instanceof Error ? end.error.message : String(end.error) };
  const text = describeRunEnd(end.run, 'tui');
  return end.run.status === 'COMPLETED' || end.run.status === 'CANCELLED' ? { kind: 'notice', level: 'info', text } : { kind: 'error', text };
};

export const createAgentViews = (): AgentViews => {
  const views = new Map<string, Kept>();
  const listeners = new Set<() => void>();
  const watchers = new Set<StoreWatcher>();
  let shownRunId: string | undefined;
  let version = 0;
  const tell = (): void => {
    version += 1;
    for (const listener of [...listeners]) listener();
  };
  const viewOf = (runId: string): Kept => {
    const view = views.get(runId);
    if (view === undefined) throw new Error(`no view is kept for the subagent run ${runId}`);
    return view;
  };
  const caughtUp = (view: Kept): void => {
    if (view.loading === undefined) return;
    view.loading = undefined;
    view.store.release();
  };
  const drop = (view: Kept): void => {
    for (const stop of view.stops.values()) stop();
    view.stops.clear();
    views.delete(view.runId);
  };
  return {
    started: (agent, runId, backlog, model) => {
      const previous = views.get(runId);
      if (previous !== undefined) drop(previous);
      const store = createTranscriptStore();
      const view: Kept = { runId, agent, model, store, end: undefined, loading: backlog > 0 ? { applied: 0, backlog } : undefined, firstSeq: undefined, stops: new Map() };
      if (view.loading !== undefined) store.hold();
      views.set(runId, view);
      for (const watcher of watchers) view.stops.set(watcher, watcher(store));
      tell();
    },
    event: (event) => {
      if (!('runId' in event)) throw new Error(`a subagent stream carried the session event ${event.type}`);
      const view = viewOf(event.runId);
      const seq = 'seq' in event ? event.seq : undefined;
      view.firstSeq ??= seq;
      foldLiveEvent(view.store, event, view.firstSeq);
      if (view.loading === undefined) return;
      view.loading = { ...view.loading, applied: view.loading.applied + 1 };
      if (seq !== undefined && seq >= view.loading.backlog) caughtUp(view);
      tell();
    },
    ended: (runId, end) => {
      const view = viewOf(runId);
      caughtUp(view);
      view.end = end;
      if (shownRunId === runId) appendEntry(view.store, endEntryOf(end));
      else drop(view);
      tell();
    },
    open: (runId) => {
      if (runId !== undefined) viewOf(runId);
      if (shownRunId !== undefined && shownRunId !== runId) {
        const left = viewOf(shownRunId);
        if (left.end !== undefined) drop(left);
      }
      shownRunId = runId;
      tell();
    },
    shown: () => (shownRunId === undefined ? undefined : viewOf(shownRunId)),
    kept: () => views.size,
    watch: (watcher) => {
      watchers.add(watcher);
      for (const view of views.values()) view.stops.set(watcher, watcher(view.store));
      return () => {
        watchers.delete(watcher);
        for (const view of views.values()) {
          const stop = view.stops.get(watcher);
          if (stop === undefined) throw new Error(`the subagent view ${view.runId} was not watched`);
          view.stops.delete(watcher);
          stop();
        }
      };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => version,
  };
};
