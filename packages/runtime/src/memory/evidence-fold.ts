import type { RunEvent } from '@momonga/protocol';
import type { RecordedCheck, RecordedHash } from '@momonga/store';

export const EVIDENCE_EVENT_TYPES = ['tool.completed', 'verification.completed'] as const satisfies readonly RunEvent['type'][];

export type EvidenceFoldInput = {
  paths: readonly string[];
  onlyCommand?: string | undefined;
};

export type EvidenceFold = {
  add(event: RunEvent): void;
  finish(): { recorded: (RecordedHash | null)[]; check: RecordedCheck | null };
};

export const createEvidenceFold = ({ paths, onlyCommand }: EvidenceFoldInput): EvidenceFold => {
  const bound = new Set(paths);
  const recorded = new Map<string, RecordedHash>();
  let latest: RecordedCheck | null = null;
  const add = (event: RunEvent): void => {
    if (event.type === 'verification.completed') {
      if (event.exitCode === undefined) return;
      if (onlyCommand !== undefined && event.command !== onlyCommand) return;
      latest = { conditionId: event.conditionId, seq: event.seq, command: event.command, exitCode: event.exitCode };
      return;
    }
    if (event.type !== 'tool.completed') return;
    const files = event.files ?? [];
    for (const file of files) {
      if (!bound.has(file.path)) continue;
      if (file.sha256 === undefined) recorded.delete(file.path);
      else recorded.set(file.path, { sha256: file.sha256, seq: event.seq });
    }
    if (files.some((file) => file.access !== 'read' && bound.has(file.path))) latest = null;
  };
  const finish = (): { recorded: (RecordedHash | null)[]; check: RecordedCheck | null } => ({
    recorded: paths.map((given) => recorded.get(given) ?? null),
    check: latest,
  });
  return { add, finish };
};
