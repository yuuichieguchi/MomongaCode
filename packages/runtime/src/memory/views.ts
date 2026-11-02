import { memoryStatus } from '@momonga/memory';
import type { EvidencePorts, MemoryStatusContext } from '@momonga/memory';
import type { MemoryRecord, MemoryView } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { createEvidencePorts } from './evidence.ts';
import type { EvidenceRun } from './evidence.ts';

export const memoryViewOf = async (record: MemoryRecord, context: MemoryStatusContext): Promise<MemoryView> => ({
  ...record,
  status: await memoryStatus(record, context),
});

const NO_PROJECT = '';

const UNREACHABLE_PORTS: EvidencePorts = {
  hashFile: () => Promise.reject(new Error('a memory with no project is never checked against a file')),
  isAncestor: () => Promise.reject(new Error('a memory with no project is never checked against a commit')),
};

export type RecordViews = {
  viewOf(record: MemoryRecord, signal: AbortSignal): Promise<MemoryView>;
  viewsOf(records: readonly MemoryRecord[], signal: AbortSignal): Promise<MemoryView[]>;
};

export const createRecordViews = (options: { store: Pick<RuntimeStore, 'trust'>; evidenceRun: (project: string) => EvidenceRun }): RecordViews => {
  const viewsOf = (records: readonly MemoryRecord[], signal: AbortSignal): Promise<MemoryView[]> => {
    const contexts = new Map<string, MemoryStatusContext>();
    const contextOf = (project: string): MemoryStatusContext => {
      const known = contexts.get(project);
      if (known !== undefined) return known;
      const trusted = options.store.trust.decisionFor(project).decision === 'trusted';
      const created = { project, trusted, ports: createEvidencePorts({ project, trusted, run: options.evidenceRun(project), signal }) };
      contexts.set(project, created);
      return created;
    };
    return Promise.all(
      records.map((record) => {
        const bound = record.evidence.find((entry) => entry.kind === 'file');
        const project = record.project ?? (bound?.kind === 'file' ? bound.project : undefined);
        return memoryViewOf(record, project === undefined ? { project: NO_PROJECT, trusted: false, ports: UNREACHABLE_PORTS } : contextOf(project));
      }),
    );
  };
  const viewOf = async (record: MemoryRecord, signal: AbortSignal): Promise<MemoryView> => {
    const [view] = await viewsOf([record], signal);
    if (view === undefined) throw new Error(`memory ${record.id} produced no view`);
    return view;
  };
  return { viewOf, viewsOf };
};
