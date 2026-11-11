import { memoryStatus } from '@momonga/memory';
import type { EvidencePorts, MemoryStatusContext } from '@momonga/memory';
import type { MemoryRecord, MemoryView } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { createEvidencePorts } from './evidence.ts';
import type { EvidencePortsOptions, EvidenceRun } from './evidence.ts';

export type ObservingStore = Pick<RuntimeStore, 'memories'>;

export const observedViewOf = async (store: ObservingStore, record: MemoryRecord, context: MemoryStatusContext): Promise<MemoryView> => {
  const status = await memoryStatus(record, context);
  store.memories.observe(record.id, status);
  return { ...record, observedStatus: status, status };
};

export const observedViewsOf = async (store: ObservingStore, records: readonly MemoryRecord[], contextOf: (record: MemoryRecord) => MemoryStatusContext | Promise<MemoryStatusContext>): Promise<MemoryView[]> => {
  const views: MemoryView[] = [];
  for (const record of records) views.push(await observedViewOf(store, record, await contextOf(record)));
  return views;
};

const NO_PROJECT = '';

const UNREACHABLE_PORTS: EvidencePorts = {
  hashFile: () => Promise.reject(new Error('a memory with no project is never checked against a file')),
  isAncestor: () => Promise.reject(new Error('a memory with no project is never checked against a commit')),
};

export type RecordViewsReading = {
  viewOf(record: MemoryRecord): Promise<MemoryView>;
  viewsOf(records: readonly MemoryRecord[]): Promise<MemoryView[]>;
};

export type RecordViews = {
  reading(signal: AbortSignal): RecordViewsReading;
  viewOf(record: MemoryRecord, signal: AbortSignal): Promise<MemoryView>;
  viewsOf(records: readonly MemoryRecord[], signal: AbortSignal): Promise<MemoryView[]>;
};

export type RecordViewsOptions = {
  store: Pick<RuntimeStore, 'trust' | 'memories'>;
  evidenceRun: (project: string) => EvidenceRun;
  evidencePorts?: (options: EvidencePortsOptions) => EvidencePorts;
};

export const createRecordViews = (options: RecordViewsOptions): RecordViews => {
  const portsFor = options.evidencePorts ?? createEvidencePorts;
  const reading = (signal: AbortSignal): RecordViewsReading => {
    const contexts = new Map<string, Promise<MemoryStatusContext>>();
    const createContext = async (project: string): Promise<MemoryStatusContext> => {
      const trusted = (await options.store.trust.decisionAsked(project, signal)).decision === 'trusted';
      return { project, trusted, ports: portsFor({ project, trusted, run: options.evidenceRun(project), signal }) };
    };
    const contextOf = (project: string): Promise<MemoryStatusContext> => {
      const known = contexts.get(project);
      if (known !== undefined) return known;
      const created = createContext(project);
      contexts.set(project, created);
      return created;
    };
    const viewsOf = (records: readonly MemoryRecord[]): Promise<MemoryView[]> =>
      observedViewsOf(options.store, records, (record) => {
        const bound = record.evidence.find((entry) => entry.kind === 'file');
        const project = record.project ?? (bound?.kind === 'file' ? bound.project : undefined);
        return project === undefined ? { project: NO_PROJECT, trusted: false, ports: UNREACHABLE_PORTS } : contextOf(project);
      });
    const viewOf = async (record: MemoryRecord): Promise<MemoryView> => {
      const [view] = await viewsOf([record]);
      if (view === undefined) throw new Error(`memory ${record.id} produced no view`);
      return view;
    };
    return { viewOf, viewsOf };
  };
  return {
    reading,
    viewOf: (record, signal) => reading(signal).viewOf(record),
    viewsOf: (records, signal) => reading(signal).viewsOf(records),
  };
};
