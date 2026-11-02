import type { RunEventPayload, ToolFile } from '@momonga/protocol';
import * as runtime from '@momonga/runtime';
import type { RuntimeStore } from '@momonga/store';
import { mustClaim } from '../../../store/test/helpers.ts';

export const exported = <T>(name: string): T => {
  const found = (runtime as Record<string, unknown>)[name];
  if (found === undefined) throw new Error(`@momonga/runtime does not export ${name}`);
  return found as T;
};

export const bash = (callId: string, command: string, exitCode: number, output = ''): RunEventPayload[] => [
  { type: 'tool.call', callId, providerCallId: callId, name: 'Bash', kind: 'other', title: command, rawInput: { command } },
  { type: 'tool.completed', callId, status: 'completed', output, exitCode },
] as RunEventPayload[];

export const fileTool = (callId: string, name: string, file: ToolFile, output = ''): RunEventPayload[] => [
  { type: 'tool.call', callId, providerCallId: callId, name, kind: 'other', title: `${name} ${file.path}`, rawInput: { file_path: file.path } },
  { type: 'tool.completed', callId, status: 'completed', output, files: [file] },
] as RunEventPayload[];

export const finishClaimed = (store: RuntimeStore, events: readonly RunEventPayload[], outcome: 'COMPLETED' | 'FAILED' = 'COMPLETED'): void => {
  const claim = mustClaim(store, 'w1');
  const appended = store.append(claim, [...events]);
  if (appended.kind !== 'ok') throw new Error(`append failed: ${appended.kind}`);
  const patch = outcome === 'FAILED' ? { error: { code: 'fixture', message: 'fixture failure' } } : {};
  const finished = store.transition(claim, ['RUNNING'], outcome, patch);
  if (finished.kind !== 'ok') throw new Error(`finish failed: ${finished.kind}`);
};
