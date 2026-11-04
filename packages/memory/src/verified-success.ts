import path from 'node:path';
import { isRecord } from '@momonga/foundation';
import type { ApprovalBasis, RunEvent } from '@momonga/protocol';

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

export type PassingCheck = { command: string; callId: string; seq: number };

export type VerifiedSuccessAnalysis = { verified: boolean; passingChecks: PassingCheck[] };

export const analyseVerifiedSuccess = (input: VerifiedSuccessInput): VerifiedSuccessAnalysis => {
  const calls = new Map<string, CallEvent>();
  const bases = new Map<string, ApprovalBasis | undefined>();
  const manifests = new Set(input.manifests);
  let manifestWritten = false;
  let latestCheckPassed: boolean | undefined;
  const latestChecks = new Map<string, { callId: string; seq: number; passed: boolean }>();
  const wrote = (paths: readonly string[]): void => {
    latestCheckPassed = undefined;
    latestChecks.clear();
    if (paths.some((written) => manifests.has(path.basename(written)))) manifestWritten = true;
  };
  const wroteUnknownPaths = (): void => {
    latestCheckPassed = undefined;
    latestChecks.clear();
    manifestWritten = true;
  };
  const mayHaveWritten = (call: CallEvent): boolean => {
    const command = commandOf(call);
    return command !== undefined && !input.commands.includes(command) && bases.get(call.callId) !== 'read_only';
  };
  for (const event of input.events) {
    if (event.type === 'tool.call') {
      calls.set(event.callId, event);
      continue;
    }
    if (event.type === 'tool.started') {
      bases.set(event.callId, event.basis);
      continue;
    }
    const call = calls.get(event.type === 'tool.completed' || event.type === 'tool.reconciled' ? event.callId : '');
    if (call === undefined) continue;
    if (event.type === 'tool.reconciled') {
      if (event.outcome === 'not_applied') continue;
      if (WRITING_KINDS.includes(call.kind)) wrote(pathsNamedBy(call));
      else if (mayHaveWritten(call)) wroteUnknownPaths();
      continue;
    }
    if (event.type !== 'tool.completed' || event.denial !== undefined) continue;
    if (mayHaveWritten(call)) {
      wroteUnknownPaths();
      continue;
    }
    if (event.status !== 'completed') continue;
    const written = writtenPaths(call, event);
    if (written !== undefined) {
      wrote(written);
      continue;
    }
    const command = commandOf(call);
    if (command !== undefined && event.exitCode !== undefined && input.commands.includes(command)) {
      latestCheckPassed = event.exitCode === 0;
      latestChecks.delete(command);
      latestChecks.set(command, { callId: event.callId, seq: event.seq, passed: latestCheckPassed });
    }
  }
  const verified = input.status === 'COMPLETED' && !manifestWritten && latestCheckPassed === true;
  const passingChecks = [...latestChecks]
    .filter(([, check]) => check.passed)
    .map(([command, { callId, seq }]) => ({ command, callId, seq }))
    .sort((left, right) => left.seq - right.seq);
  return { verified, passingChecks };
};

export const isVerifiedSuccess = (input: VerifiedSuccessInput): boolean => analyseVerifiedSuccess(input).verified;
