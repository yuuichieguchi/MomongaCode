import { isRecord } from '@momonga/foundation';
import type { RunEvent } from '@momonga/protocol';
import type { RecordedCheck, RecordedHash } from '@momonga/store';

export const EVIDENCE_EVENT_TYPES = ['tool.call', 'tool.completed'] as const satisfies readonly RunEvent['type'][];

export type EvidenceFoldInput = {
  paths: readonly string[];
  verificationCommands: readonly string[];
  onlyCommand?: string | undefined;
};

export type EvidenceFold = {
  add(event: RunEvent): void;
  finish(): { recorded: (RecordedHash | null)[]; check: RecordedCheck | null };
};

export const createEvidenceFold = ({ paths, verificationCommands, onlyCommand }: EvidenceFoldInput): EvidenceFold => {
  const bound = new Set(paths);
  const recorded = new Map<string, RecordedHash>();
  const commandOf = new Map<string, string>();
  let latest: RecordedCheck | null = null;
  const add = (event: RunEvent): void => {
    if (event.type === 'tool.call') {
      if (event.name === 'Bash' && isRecord(event.rawInput) && typeof event.rawInput['command'] === 'string') commandOf.set(event.callId, event.rawInput['command']);
      return;
    }
    if (event.type !== 'tool.completed') return;
    const files = event.files ?? [];
    for (const file of files) {
      if (bound.has(file.path)) recorded.set(file.path, { sha256: file.sha256, seq: event.seq });
    }
    if (files.some((file) => file.access === 'write' && bound.has(file.path))) {
      latest = null;
      return;
    }
    const command = commandOf.get(event.callId);
    if (event.exitCode === undefined || command === undefined || !verificationCommands.includes(command)) return;
    if (onlyCommand !== undefined && command !== onlyCommand) return;
    latest = { callId: event.callId, seq: event.seq, command, exitCode: event.exitCode };
  };
  const finish = (): { recorded: (RecordedHash | null)[]; check: RecordedCheck | null } => ({
    recorded: paths.map((given) => recorded.get(given) ?? null),
    check: latest,
  });
  return { add, finish };
};
