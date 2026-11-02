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

export type RecordViews = { viewOf(record: MemoryRecord): Promise<MemoryView>; viewsOf(records: readonly MemoryRecord[]): Promise<MemoryView[]> };

export const createRecordViews = (options: { store: Pick<RuntimeStore, 'trust'>; evidenceRun: (project: string) => EvidenceRun }): RecordViews => {
  const viewOf = (record: MemoryRecord): Promise<MemoryView> => {
    const bound = record.evidence.find((entry) => entry.kind === 'file');
    const project = record.project ?? (bound?.kind === 'file' ? bound.project : undefined);
    if (project === undefined) return memoryViewOf(record, { project: NO_PROJECT, trusted: false, ports: UNREACHABLE_PORTS });
    const trusted = options.store.trust.decisionFor(project).decision === 'trusted';
    return memoryViewOf(record, { project, trusted, ports: createEvidencePorts({ project, trusted, run: options.evidenceRun(project) }) });
  };
  return { viewOf, viewsOf: (records) => Promise.all(records.map(viewOf)) };
};
