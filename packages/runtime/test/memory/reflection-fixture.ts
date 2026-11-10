import type { ApprovalBasis, RunEventPayload, ToolFile } from '@momonga/protocol';
import * as runtime from '@momonga/runtime';
import type { RuntimeStore } from '@momonga/store';
import { mustClaim } from '../../../store/test/helpers.ts';

const RUN_PINS = {
  model: 'fm',
  systemPromptDigest: 'system-prompt-digest',
  toolSetDigest: 'tool-set-digest',
  capabilities: { contextWindow: 100_000, maxOutputTokens: 4096, parallelToolCalls: false, streaming: true, tokenCounting: 'exact', toolCalling: 'native' },
} as const;

export const exported = <T>(name: string): T => {
  const found = (runtime as Record<string, unknown>)[name];
  if (found === undefined) throw new Error(`@momonga/runtime does not export ${name}`);
  return found as T;
};

export const bash = (callId: string, command: string, exitCode: number, output = '', basis: ApprovalBasis = 'read_only'): RunEventPayload[] => [
  { type: 'tool.call', callId, providerCallId: callId, name: 'Bash', kind: 'other', title: command, rawInput: { command } },
  { type: 'tool.started', callId, idemKey: `key-${callId}`, basis },
  { type: 'tool.completed', callId, status: 'completed', output, exitCode },
] as RunEventPayload[];

export const fileTool = (callId: string, name: string, file: ToolFile, output = ''): RunEventPayload[] => [
  { type: 'tool.call', callId, providerCallId: callId, name, kind: 'other', title: `${name} ${file.path}`, rawInput: { file_path: file.path } },
  { type: 'tool.started', callId, idemKey: `key-${callId}`, basis: 'person' },
  { type: 'tool.completed', callId, status: 'completed', output, files: [file] },
] as RunEventPayload[];

export const finishClaimed = async (store: RuntimeStore, events: readonly RunEventPayload[], outcome: 'COMPLETED' | 'FAILED' = 'COMPLETED'): Promise<void> => {
  const claim = mustClaim(store, 'w1');
  const appended = store.append(claim, [{ type: 'run.started', attempt: claim.attempt, now: 0, pins: { ...RUN_PINS } }, ...events]);
  if (appended.kind !== 'ok') throw new Error(`append failed: ${appended.kind}`);
  const patch = outcome === 'FAILED' ? { error: { code: 'fixture', message: 'fixture failure' } } : {};
  const finished = await store.transition(claim, ['RUNNING'], outcome, patch);
  if (finished.kind !== 'ok') throw new Error(`finish failed: ${finished.kind}`);
};
