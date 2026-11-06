import path from 'node:path';
import { isRecord } from '@momonga/foundation';
import type { ApprovalBasis, RunEvent } from '@momonga/protocol';
import { createCallRunTracker } from './call-ran.ts';

export type VerifiedSuccessInput = {
  status: string;
  events: readonly RunEvent[];
  commands: readonly string[];
  manifests: readonly string[];
};

type CallEvent = Extract<RunEvent, { type: 'tool.call' }>;

type CallFacts = { kind: string; command: string | undefined; paths: string[] };

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

const factsOfCall = (call: CallEvent): CallFacts => ({ kind: call.kind, command: commandOf(call), paths: pathsNamedBy(call) });

const writtenPaths = (call: CallFacts, event: Extract<RunEvent, { type: 'tool.completed' }>): string[] | undefined => {
  if (event.files === undefined) return WRITING_KINDS.includes(call.kind) ? call.paths : undefined;
  const written = event.files.filter((file) => file.access === 'write').map((file) => file.path);
  return written.length === 0 ? undefined : written;
};

export type PassingCheck = { command: string; callId: string; seq: number };

export type VerifiedSuccessAnalysis = { verified: boolean; passingChecks: PassingCheck[] };

export const VERIFIED_SUCCESS_EVENT_TYPES = ['tool.call', 'tool.started', 'tool.completed', 'tool.reconciled'] as const satisfies readonly RunEvent['type'][];

export type VerifiedSuccessFold = {
  add(event: RunEvent): void;
  finish(status: string): VerifiedSuccessAnalysis;
};

export const createVerifiedSuccessFold = (input: Pick<VerifiedSuccessInput, 'commands' | 'manifests'>): VerifiedSuccessFold => {
  const calls = new Map<string, CallFacts>();
  const bases = new Map<string, ApprovalBasis | undefined>();
  const ran = createCallRunTracker();
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
  const mayHaveWritten = (callId: string, call: CallFacts): boolean =>
    call.command !== undefined && !input.commands.includes(call.command) && bases.get(callId) !== 'read_only';
  const recordCheck = (command: string, callId: string, seq: number, passed: boolean): void => {
    latestCheckPassed = passed;
    latestChecks.delete(command);
    latestChecks.set(command, { callId, seq, passed });
  };
  const add = (event: RunEvent): void => {
    ran.observe(event);
    if (event.type === 'tool.call') {
      calls.set(event.callId, factsOfCall(event));
      return;
    }
    if (event.type === 'tool.started') {
      bases.set(event.callId, event.basis);
      return;
    }
    if (event.type !== 'tool.completed' && event.type !== 'tool.reconciled') return;
    const call = calls.get(event.callId);
    if (call === undefined) return;
    if (event.type === 'tool.reconciled') {
      if (event.outcome === 'not_applied') return;
      if (WRITING_KINDS.includes(call.kind)) wrote(call.paths);
      else if (mayHaveWritten(event.callId, call)) wroteUnknownPaths();
      return;
    }
    if (!ran.ran(event)) return;
    if (mayHaveWritten(event.callId, call)) {
      wroteUnknownPaths();
      return;
    }
    const isCheck = call.command !== undefined && input.commands.includes(call.command);
    if (event.status !== 'completed') {
      if (call.command !== undefined && isCheck) recordCheck(call.command, event.callId, event.seq, false);
      return;
    }
    const written = writtenPaths(call, event);
    if (written !== undefined) {
      wrote(written);
      return;
    }
    if (call.command !== undefined && isCheck && event.exitCode !== undefined) recordCheck(call.command, event.callId, event.seq, event.exitCode === 0);
  };
  const finish = (status: string): VerifiedSuccessAnalysis => {
    const verified = status === 'COMPLETED' && !manifestWritten && latestCheckPassed === true;
    const passingChecks = [...latestChecks]
      .filter(([, check]) => check.passed)
      .map(([command, { callId, seq }]) => ({ command, callId, seq }))
      .sort((left, right) => left.seq - right.seq);
    return { verified, passingChecks };
  };
  return { add, finish };
};

export const analyseVerifiedSuccess = (input: VerifiedSuccessInput): VerifiedSuccessAnalysis => {
  const fold = createVerifiedSuccessFold(input);
  for (const event of input.events) fold.add(event);
  return fold.finish(input.status);
};

export const isVerifiedSuccess = (input: VerifiedSuccessInput): boolean => analyseVerifiedSuccess(input).verified;
