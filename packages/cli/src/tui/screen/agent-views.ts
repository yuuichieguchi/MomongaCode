import type { PublicRunEvent } from '@momonga/protocol';
import { describeRunEnd } from '../../run/headless.ts';
import type { ChildEnd } from '../../run/follow.ts';
import { appendEntry, foldLiveEvent } from '../transcript.ts';
import type { Entry } from '../transcript.ts';
import { createTranscriptStore } from './store.ts';
import type { TranscriptStore } from './store.ts';

export type AgentView = { readonly runId: string; readonly agent: string; readonly store: TranscriptStore };

type Kept = AgentView & { firstSeq: number | undefined; ended: boolean };

export type AgentViews = {
  started(agent: string, runId: string): void;
  event(event: PublicRunEvent): void;
  ended(runId: string, end: ChildEnd): void;
  open(runId: string | undefined): void;
  shown(): AgentView | undefined;
  kept(): number;
  reset(): void;
  subscribe(listener: () => void): () => void;
  version(): number;
};

export const agentHeader = (agent: string): string => `Subagent ${agent}`;

const endEntryOf = (end: ChildEnd): Entry => {
  if (end.kind === 'failed') return { kind: 'error', text: end.error instanceof Error ? end.error.message : String(end.error) };
  const text = describeRunEnd(end.run, 'tui');
  return end.run.status === 'COMPLETED' || end.run.status === 'CANCELLED' ? { kind: 'notice', level: 'info', text } : { kind: 'error', text };
};

export const createAgentViews = (): AgentViews => {
  const views = new Map<string, Kept>();
  const listeners = new Set<() => void>();
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
  return {
    started: (agent, runId) => {
      const store = createTranscriptStore();
      appendEntry(store, { kind: 'info', text: agentHeader(agent) });
      views.set(runId, { runId, agent, store, firstSeq: undefined, ended: false });
      tell();
    },
    event: (event) => {
      if (!('runId' in event)) throw new Error(`a subagent stream carried the session event ${event.type}`);
      const view = viewOf(event.runId);
      view.firstSeq ??= 'seq' in event ? event.seq : undefined;
      foldLiveEvent(view.store, event, view.firstSeq);
    },
    ended: (runId, end) => {
      const view = viewOf(runId);
      view.ended = true;
      if (shownRunId === runId) appendEntry(view.store, endEntryOf(end));
      else views.delete(runId);
      tell();
    },
    open: (runId) => {
      if (runId !== undefined) viewOf(runId);
      if (shownRunId !== undefined && shownRunId !== runId && viewOf(shownRunId).ended) views.delete(shownRunId);
      shownRunId = runId;
      tell();
    },
    shown: () => (shownRunId === undefined ? undefined : viewOf(shownRunId)),
    kept: () => views.size,
    reset: () => {
      views.clear();
      shownRunId = undefined;
      tell();
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
