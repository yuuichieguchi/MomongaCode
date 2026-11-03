import path from 'node:path';
import { isRecord } from '@momonga/foundation';
import type { RunEvent } from '@momonga/protocol';

export type VerifiedSuccessInput = {
  status: string;
  events: readonly RunEvent[];
  commands: readonly string[];
  manifests: readonly string[];
};

type CallEvent = Extract<RunEvent, { type: 'tool.call' }>;

const WRITING_KINDS: readonly string[] = ['edit', 'delete', 'move'];

const commandOf = (call: CallEvent): string | undefined => {
  if (call.name !== 'Bash' || !isRecord(call.rawInput)) return undefined;
  const { command } = call.rawInput;
  return typeof command === 'string' ? command : undefined;
};

const pathsNamedBy = (call: CallEvent): string[] => {
  const located = (call.locations ?? []).map((location) => location.path);
  const given = isRecord(call.rawInput) ? call.rawInput['file_path'] : undefined;
  return typeof given === 'string' ? [...located, given] : located;
};

const writtenPaths = (call: CallEvent, event: Extract<RunEvent, { type: 'tool.completed' }>): string[] | undefined => {
  if (event.files === undefined) return WRITING_KINDS.includes(call.kind) ? pathsNamedBy(call) : undefined;
  const written = event.files.filter((file) => file.access === 'write').map((file) => file.path);
  return written.length === 0 ? undefined : written;
};

export const isVerifiedSuccess =(input: VerifiedSuccessInput): boolean => {
  const calls = new Map<string, CallEvent>();
  const manifests = new Set(input.manifests);
  let manifestWritten = false;
  let latestCheckPassed: boolean | undefined;
  const wrote = (paths: readonly string[]): void => {
    latestCheckPassed = undefined;
    if (paths.some((written) => manifests.has(path.basename(written)))) manifestWritten = true;
  };
  for (const event of input.events) {
    if (event.type === 'tool.call') {
      calls.set(event.callId, event);
      continue;
    }
    const call = calls.get(event.type === 'tool.completed' || event.type === 'tool.reconciled' ? event.callId : '');
    if (call === undefined) continue;
    if (event.type === 'tool.reconciled') {
      if (event.outcome !== 'not_applied' && WRITING_KINDS.includes(call.kind)) wrote(pathsNamedBy(call));
      continue;
    }
    if (event.type !== 'tool.completed' || event.status !== 'completed' || event.denial !== undefined) continue;
    const written = writtenPaths(call, event);
    if (written !== undefined) {
      wrote(written);
      continue;
    }
    const command = commandOf(call);
    if (command !== undefined && event.exitCode !== undefined && input.commands.includes(command)) latestCheckPassed = event.exitCode === 0;
  }
  return input.status === 'COMPLETED' && !manifestWritten && latestCheckPassed === true;
};
