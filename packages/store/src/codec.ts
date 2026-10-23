import path from 'node:path';
import { PERMISSION_MODES, RUN_STATUSES, STOP_REASONS } from '@momonga/protocol';
import type { RunEvent, RunEventPayload, RunState, SessionEvent, SessionEventPayload } from '@momonga/protocol';
import { corrupt, expectOneOf, expectRecord, expectStringRecord, isRecord, readerFor } from './rows.ts';
import type { Row } from './rows.ts';
import type { Run, RunError, Session } from './types.ts';

const identityOf = (row: Row): string => String(row['id']);

const expectAbsolutePaths = (table: string, identity: string, column: string, value: unknown): readonly string[] => {
  if (!Array.isArray(value)) throw corrupt(table, identity, `column ${column} must hold a JSON array`);
  for (const entry of value) {
    if (typeof entry !== 'string' || !path.isAbsolute(entry)) {
      throw corrupt(table, identity, `column ${column} must hold absolute path strings`);
    }
  }
  return value as string[];
};

export const decodeSession = (row: Row): Session => {
  const identity = identityOf(row);
  const reader = readerFor('sessions', identity, row);
  return {
    id: reader.string('id'),
    cwd: reader.string('cwd'),
    env: expectStringRecord('sessions', identity, 'env_json', reader.json('env_json')),
    permissionMode: expectOneOf('sessions', identity, 'permission_mode', PERMISSION_MODES, reader.string('permission_mode')),
    modelAlias: reader.string('model_alias'),
    bypassAllowed: reader.flag('bypass_allowed'),
    additionalDirectories: expectAbsolutePaths('sessions', identity, 'additional_directories_json', reader.json('additional_directories_json')),
    createdAt: reader.number('created_at'),
  };
};

const decodeUsage = (identity: string, value: unknown): Run['usage'] => {
  const record = expectRecord('runs', identity, 'usage_json', value);
  const { inputTokens, outputTokens, totalTokens } = record;
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number' || typeof totalTokens !== 'number') {
    throw corrupt('runs', identity, 'column usage_json must hold numeric inputTokens, outputTokens and totalTokens');
  }
  return { inputTokens, outputTokens, totalTokens };
};

const decodeRunError = (identity: string, value: unknown): RunError => {
  const record = expectRecord('runs', identity, 'error_json', value);
  if (typeof record['code'] !== 'string' || typeof record['message'] !== 'string') {
    throw corrupt('runs', identity, 'column error_json must hold string code and message');
  }
  return { code: record['code'], message: record['message'] };
};

export const decodeRun = (row: Row): Run => {
  const identity = identityOf(row);
  const reader = readerFor('runs', identity, row);
  const stopReason = reader.nullableString('stop_reason');
  const errorJson = reader.nullableJson('error_json');
  const run: Run = {
    id: reader.string('id'),
    sessionId: reader.string('session_id'),
    ordinal: reader.number('ordinal'),
    status: expectOneOf('runs', identity, 'status', RUN_STATUSES, reader.string('status')),
    version: reader.number('version'),
    leaseOwner: reader.nullableString('lease_owner'),
    leaseToken: reader.number('lease_token'),
    leaseExpiresAt: reader.nullableNumber('lease_expires_at'),
    availableAt: reader.number('available_at'),
    createdAt: reader.number('created_at'),
    attempts: reader.number('attempts'),
    failedAttempts: reader.number('failed_attempts'),
    cancelRequested: reader.flag('cancel_requested'),
    deadLetter: reader.flag('dead_letter'),
    deadlineAt: reader.number('deadline_at'),
    limits: expectRecord('runs', identity, 'limits_json', reader.json('limits_json')),
    pins: expectRecord('runs', identity, 'pins', reader.json('pins')),
    step: reader.number('step'),
    lastSeq: reader.number('last_seq'),
    usage: decodeUsage(identity, reader.json('usage_json')),
  };
  if (stopReason !== null) run.stopReason = expectOneOf('runs', identity, 'stop_reason', STOP_REASONS, stopReason);
  if (errorJson !== null) run.error = decodeRunError(identity, errorJson);
  return run;
};

const EVENT_TYPES: Record<RunEventPayload['type'], true> = {
  'user.message': true,
  'run.started': true,
  'run.status': true,
  'model.requested': true,
  'model.responded': true,
  'agent.message.delta': true,
  'agent.thought.delta': true,
  'model.stream.restarted': true,
  'tool.call': true,
  'tool.permission.requested': true,
  'tool.permission.resolved': true,
  'tool.permission.cancelled': true,
  'tool.started': true,
  'tool.updated': true,
  'tool.completed': true,
  'tool.reconciled': true,
  'plan.updated': true,
  'usage.updated': true,
  'context.compacted': true,
  'context.truncated': true,
  'instructions.loaded': true,
  'approval.rule.persisted': true,
  notice: true,
};

const SESSION_EVENT_TYPES: Record<SessionEventPayload['type'], true> = { 'mode.changed': true };

const decodeRunEvent = (row: Row, identity: string, type: string, payload: Record<string, unknown>): RunEvent => {
  const reader = readerFor('events', identity, row);
  if (!Object.hasOwn(EVENT_TYPES, type)) throw corrupt('events', identity, `column type has unknown event type "${type}"`);
  const envelope = {
    id: reader.number('id'),
    runId: reader.string('run_id'),
    sessionId: reader.string('session_id'),
    seq: reader.number('seq'),
    step: reader.number('step'),
    leaseToken: reader.number('lease_token'),
    createdAt: reader.number('created_at'),
  };
  return { ...payload, ...envelope } as RunEvent;
};

const decodeSessionEvent = (row: Row, identity: string, type: string, payload: Record<string, unknown>): SessionEvent => {
  const reader = readerFor('events', identity, row);
  if (!Object.hasOwn(SESSION_EVENT_TYPES, type)) {
    throw corrupt('events', identity, `column run_id is NULL but type "${type}" is not a session event type`);
  }
  const envelope = { id: reader.number('id'), sessionId: reader.string('session_id'), createdAt: reader.number('created_at') };
  const mode = payload['mode'];
  if (typeof mode !== 'string') throw corrupt('events', identity, 'payload_json mode must be a string');
  return { type: 'mode.changed', mode: expectOneOf('events', identity, 'payload_json', PERMISSION_MODES, mode), ...envelope };
};

export const decodeEvent = (row: Row): RunEvent | SessionEvent => {
  const identity = identityOf(row);
  const reader = readerFor('events', identity, row);
  const type = reader.string('type');
  const payload = expectRecord('events', identity, 'payload_json', reader.json('payload_json'));
  if (payload['type'] !== type) throw corrupt('events', identity, `payload_json type does not match column type "${type}"`);
  return reader.nullableString('run_id') === null ? decodeSessionEvent(row, identity, type, payload) : decodeRunEvent(row, identity, type, payload);
};

export const decodeRunEvents = (rows: readonly Row[]): RunEvent[] =>
  rows.map((row) => {
    const event = decodeEvent(row);
    if (!('runId' in event)) throw corrupt('events', identityOf(row), 'a run event query returned a session event');
    return event;
  });

const PERMISSION_KINDS = ['allow_once', 'allow_always', 'reject_once', 'reject_always'] as const;
const PENDING_STATUSES = ['requested', 'awaiting_approval', 'started', 'completed', 'reconciled'] as const;

const isPermissionKind = (value: unknown): boolean => PERMISSION_KINDS.some((kind) => kind === value);

const isHistoryItem = (item: unknown): boolean => {
  if (!isRecord(item) || typeof item['type'] !== 'string') return false;
  if (item['type'] === 'function_call' || item['type'] === 'function_call_output') return typeof item['call_id'] === 'string';
  return true;
};

const isHistoryEntry = (value: unknown): boolean =>
  isRecord(value) &&
  Number.isInteger(value['seq']) &&
  isHistoryItem(value['item']) &&
  (value['callId'] === undefined || typeof value['callId'] === 'string') &&
  (value['handle'] === undefined || typeof value['handle'] === 'string');

const isSummary = (value: unknown): boolean =>
  isRecord(value) &&
  isRecord(value['item']) &&
  value['item']['type'] === 'compaction' &&
  typeof value['item']['encrypted_content'] === 'string' &&
  typeof value['summary'] === 'string' &&
  Number.isInteger(value['replacedThroughSeq']);

const isPendingCall = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value['name'] === 'string' &&
  typeof value['providerCallId'] === 'string' &&
  PENDING_STATUSES.some((status) => status === value['status']) &&
  (value['subjectDigest'] === undefined || typeof value['subjectDigest'] === 'string') &&
  (value['suggestedRule'] === undefined || typeof value['suggestedRule'] === 'string') &&
  (value['options'] === undefined ||
    (Array.isArray(value['options']) &&
      value['options'].every((option) => isRecord(option) && typeof option['optionId'] === 'string' && isPermissionKind(option['kind'])))) &&
  (value['resolution'] === undefined ||
    (isRecord(value['resolution']) &&
      typeof value['resolution']['optionId'] === 'string' &&
      isPermissionKind(value['resolution']['kind']) &&
      typeof value['resolution']['subjectDigest'] === 'string' &&
      (value['resolution']['suggestedRule'] === undefined || typeof value['resolution']['suggestedRule'] === 'string') &&
      (value['resolution']['rulePersisted'] === undefined || value['resolution']['rulePersisted'] === true)));

const isStep = (value: unknown): boolean => isRecord(value) && typeof value['toolChoice'] === 'string' && typeof value['summary'] === 'boolean';

const isLastResponse = (value: unknown): boolean =>
  isRecord(value) &&
  Number.isInteger(value['step']) &&
  typeof value['incomplete'] === 'boolean' &&
  typeof value['refusal'] === 'boolean' &&
  Array.isArray(value['callIds']) &&
  value['callIds'].every((callId: unknown) => typeof callId === 'string') &&
  (value['incompleteReason'] === undefined || typeof value['incompleteReason'] === 'string');

const isLoadedInstruction = (value: unknown): boolean =>
  isRecord(value) && typeof value['path'] === 'string' && typeof value['textSha256'] === 'string';

const hasConsistentSeqs = (history: readonly unknown[], nextItemSeq: unknown, summary: unknown): boolean => {
  const seqs = history.map((entry) => (entry as { seq: number }).seq);
  if (!seqs.every((seq, index) => index === 0 || seq > (seqs[index - 1] as number))) return false;
  if (!Number.isInteger(nextItemSeq) || (nextItemSeq as number) < 1) return false;
  if (seqs.length > 0 && (nextItemSeq as number) <= (seqs[seqs.length - 1] as number)) return false;
  if (summary !== undefined && seqs.length > 0 && (summary as { replacedThroughSeq: number }).replacedThroughSeq >= (seqs[0] as number)) return false;
  return true;
};

export const SNAPSHOT_STATE_VERSION = 4;

export const encodeRunState = (state: RunState): Record<string, unknown> => ({ ...state, stateVersion: SNAPSHOT_STATE_VERSION });

export const decodeRunState = (identity: string, value: unknown): RunState | undefined => {
  const record = expectRecord('snapshots', identity, 'state_json', value);
  if (record['stateVersion'] !== SNAPSHOT_STATE_VERSION) return undefined;
  const { stateVersion: _version, ...state } = record;
  const usage = state['usage'];
  const history = state['history'];
  const evicted = state['evicted'];
  const inFlight = state['inFlightModelRequest'];
  const valid =
    typeof state['runId'] === 'string' &&
    typeof state['sessionId'] === 'string' &&
    typeof state['status'] === 'string' &&
    RUN_STATUSES.some((status) => status === state['status']) &&
    typeof state['step'] === 'number' &&
    typeof state['attempt'] === 'number' &&
    typeof state['lastSeq'] === 'number' &&
    isRecord(usage) &&
    typeof usage['inputTokens'] === 'number' &&
    typeof usage['outputTokens'] === 'number' &&
    typeof usage['totalTokens'] === 'number' &&
    Array.isArray(history) &&
    history.every(isHistoryEntry) &&
    (state['summary'] === undefined || isSummary(state['summary'])) &&
    hasConsistentSeqs(history, state['nextItemSeq'], state['summary']) &&
    (inFlight === undefined || (isRecord(inFlight) && Number.isInteger(inFlight['requestedSeq']))) &&
    (state['pins'] === undefined || isRecord(state['pins'])) &&
    Array.isArray(evicted) &&
    evicted.every((callId) => typeof callId === 'string') &&
    Array.isArray(state['notes']) &&
    isRecord(state['pendingCalls']) &&
    Object.values(state['pendingCalls']).every(isPendingCall) &&
    isRecord(state['toolCallCounts']) &&
    isRecord(state['steps']) &&
    (state['lastResponse'] === undefined || isLastResponse(state['lastResponse'])) &&
    Object.values(state['steps']).every(isStep) &&
    Array.isArray(state['loadedInstructions']) &&
    state['loadedInstructions'].every(isLoadedInstruction);
  if (!valid) throw corrupt('snapshots', identity, 'column state_json does not hold a RunState');
  return state as RunState;
};
