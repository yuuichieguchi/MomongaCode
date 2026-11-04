import path from 'node:path';
import { FILE_ACCESSES, LOOP_GROUPS_KEPT, MEMORY_ORIGINS, MEMORY_STATUSES, PERMISSION_MODES, RUN_STATUSES, STOP_REASONS } from '@momonga/protocol';
import type { RunEvent, RunEventPayload, RunState, SessionEvent, SessionEventPayload } from '@momonga/protocol';
import { hasConsistentSeqs } from './seqs.ts';
import { corrupt, expectOneOf, expectRecord, expectStringRecord, isRecord, readerFor } from './rows.ts';
import type { Row } from './rows.ts';
import type { Run, RunError, Session, SessionMcpServers } from './types.ts';

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

const expectServerRecords = (identity: string, value: unknown): SessionMcpServers => {
  const record = expectRecord('sessions', identity, 'mcp_servers_json', value);
  for (const [name, server] of Object.entries(record)) {
    if (!isRecord(server)) throw corrupt('sessions', identity, `column mcp_servers_json entry ${JSON.stringify(name)} must be an object`);
  }
  return record as SessionMcpServers;
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
    mcpServers: expectServerRecords(identity, reader.json('mcp_servers_json')),
    createdAt: reader.number('created_at'),
  };
};

const HISTORY_MODES = ['inherit', 'fresh'] as const;

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
    previousRunId: reader.nullableString('previous_run_id'),
    history: expectOneOf('runs', identity, 'history_mode', HISTORY_MODES, reader.string('history_mode')),
    parentRunId: reader.nullableString('parent_run_id'),
    parentCallId: reader.nullableString('parent_call_id'),
    origin: expectOneOf('runs', identity, 'origin', MEMORY_ORIGINS, reader.string('origin')),
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
  'tool.permission.classified': true,
  'hook.completed': true,
  'tool.permission.resolved': true,
  'tool.permission.cancelled': true,
  'tool.elicitation.requested': true,
  'tool.elicitation.resolved': true,
  'tool.elicitation.cancelled': true,
  'mcp.authorization.required': true,
  'tool.started': true,
  'tool.updated': true,
  'tool.completed': true,
  'tool.reconciled': true,
  'tool.waiting': true,
  'job.finished': true,
  'plan.updated': true,
  'usage.updated': true,
  'usage.charged': true,
  'context.compacted': true,
  'context.governing_loaded': true,
  'context.memories_loaded': true,
  'context.contribution': true,
  'context.compaction_rejected': true,
  'context.inherited': true,
  'context.truncated': true,
  'instructions.loaded': true,
  'skill.activated': true,
  'tool.loaded': true,
  'loop.warned': true,
  'approval.rule.persisted': true,
  notice: true,
};

const SESSION_EVENT_TYPES: Record<SessionEventPayload['type'], true> = { 'mode.changed': true, 'model.changed': true };

const isToolFile = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value['path'] === 'string' &&
  typeof value['sha256'] === 'string' &&
  /^[0-9a-f]{64}$/.test(value['sha256']) &&
  FILE_ACCESSES.some((access) => access === value['access']);

const assertToolFacts = (identity: string, payload: Record<string, unknown>): void => {
  if (payload['files'] !== undefined && !(Array.isArray(payload['files']) && payload['files'].every(isToolFile))) {
    throw corrupt('events', identity, 'payload_json files must hold path, sha256 and access entries');
  }
  if (payload['exitCode'] !== undefined && !Number.isInteger(payload['exitCode'])) {
    throw corrupt('events', identity, 'payload_json exitCode must be an integer');
  }
};

const decodeRunEvent = (row: Row, identity: string, type: string, payload: Record<string, unknown>): RunEvent => {
  const reader = readerFor('events', identity, row);
  if (!Object.hasOwn(EVENT_TYPES, type)) throw corrupt('events', identity, `column type has unknown event type "${type}"`);
  if (type === 'tool.completed') assertToolFacts(identity, payload);
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
  if (type === 'model.changed') {
    const { modelAlias, previousModelAlias } = payload;
    if (typeof modelAlias !== 'string' || typeof previousModelAlias !== 'string') {
      throw corrupt('events', identity, 'payload_json modelAlias and previousModelAlias must be strings');
    }
    return { type: 'model.changed', modelAlias, previousModelAlias, ...envelope };
  }
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
const PENDING_STATUSES = ['requested', 'awaiting_approval', 'awaiting_input', 'started', 'completed', 'reconciled'] as const;

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

const isSummaryItem = (item: unknown): boolean =>
  isRecord(item) &&
  ((item['type'] === 'compaction' && typeof item['encrypted_content'] === 'string') ||
    (item['type'] === 'message' && item['role'] === 'user' && typeof item['content'] === 'string'));

const isSummary = (value: unknown): boolean =>
  isRecord(value) &&
  isSummaryItem(value['item']) &&
  typeof value['summary'] === 'string' &&
  Number.isInteger(value['replacedThroughSeq']);

const isAwait = (value: unknown): boolean =>
  isRecord(value) &&
  ((value['kind'] === 'run' && typeof value['runId'] === 'string' && typeof value['sessionId'] === 'string' && typeof value['agent'] === 'string') ||
    (value['kind'] === 'job' && typeof value['jobId'] === 'string'));

const isPendingCall = (value: unknown): boolean =>
  isRecord(value) &&
  (value['awaiting'] === undefined || isAwait(value['awaiting'])) &&
  typeof value['name'] === 'string' &&
  typeof value['providerCallId'] === 'string' &&
  PENDING_STATUSES.some((status) => status === value['status']) &&
  (value['subjectDigest'] === undefined || typeof value['subjectDigest'] === 'string') &&
  (value['suggestedRule'] === undefined || typeof value['suggestedRule'] === 'string') &&
  (value['classification'] === undefined ||
    (isRecord(value['classification']) &&
      typeof value['classification']['subjectDigest'] === 'string' &&
      (value['classification']['outcome'] === 'allow' || value['classification']['outcome'] === 'ask'))) &&
  (value['options'] === undefined ||
    (Array.isArray(value['options']) &&
      value['options'].every((option) => isRecord(option) && typeof option['optionId'] === 'string' && isPermissionKind(option['kind'])))) &&
  (value['input'] === undefined ||
    (isRecord(value['input']) && typeof value['input']['inputId'] === 'string' && typeof value['input']['server'] === 'string' && Array.isArray(value['input']['requests']))) &&
  (value['inputResolution'] === undefined ||
    (isRecord(value['inputResolution']) && typeof value['inputResolution']['inputId'] === 'string' && isRecord(value['inputResolution']['responses']))) &&
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

const isStreaming = (value: unknown): boolean =>
  isRecord(value) &&
  Number.isInteger(value['step']) &&
  Number.isInteger(value['attempt']) &&
  typeof value['seen'] === 'boolean' &&
  Array.isArray(value['items']) &&
  value['items'].every((item: unknown) => isRecord(item) && typeof item['itemId'] === 'string' && typeof item['text'] === 'string');

const isInherited = (value: unknown): boolean =>
  isRecord(value) && typeof value['fromRunId'] === 'string' && Number.isInteger(value['fromLastSeq']) && typeof value['digest'] === 'string';

const isLoadedInstruction = (value: unknown): boolean =>
  isRecord(value) && typeof value['path'] === 'string' && typeof value['textSha256'] === 'string' && Number.isInteger(value['seq']);

const isGoverningLoaded = (value: unknown): boolean =>
  isRecord(value) &&
  Array.isArray(value['active']) &&
  value['active'].every((entry) => isRecord(entry) && typeof entry['id'] === 'string' && typeof entry['textSha256'] === 'string') &&
  Array.isArray(value['conflicts']) &&
  value['conflicts'].every((entry) => isRecord(entry) && typeof entry['target'] === 'string' && Array.isArray(entry['ids']) && entry['ids'].every((id) => typeof id === 'string'));

const isMemoryLoaded = (value: unknown): boolean => isRecord(value) && typeof value['id'] === 'string' && MEMORY_STATUSES.some((status) => status === value['status']);

const isActivatedSkill = (value: unknown): boolean =>
  isRecord(value) && typeof value['name'] === 'string' && typeof value['content'] === 'string' && Number.isInteger(value['seq']);

const isLoopWarned = (value: unknown): boolean => isRecord(value) && typeof value['signature'] === 'string';

const SHA256_HEX = /^[0-9a-f]{64}$/;

const isSha256 = (value: unknown): boolean => typeof value === 'string' && SHA256_HEX.test(value);

const isLoopGroup = (value: unknown): boolean =>
  isRecord(value) && isSha256(value['signature']) && (value['outputSignature'] === undefined || isSha256(value['outputSignature']));

const isLoopOpen = (value: unknown): boolean =>
  isRecord(value) &&
  Array.isArray(value['calls']) &&
  value['calls'].every((call: unknown) => Array.isArray(call) && call.length === 2 && typeof call[0] === 'string') &&
  Array.isArray(value['callIds']) &&
  value['calls'].length === value['callIds'].length &&
  value['callIds'].every((callId: unknown) => typeof callId === 'string') &&
  isRecord(value['outputs']) &&
  Object.values(value['outputs']).every(isSha256);

const isArrayOf = (value: unknown, guard: (entry: unknown) => boolean): boolean => Array.isArray(value) && value.every(guard);

const isPlanEntry = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value['content'] === 'string' &&
  (value['priority'] === 'high' || value['priority'] === 'medium' || value['priority'] === 'low') &&
  (value['status'] === 'pending' || value['status'] === 'in_progress' || value['status'] === 'completed');

const isReconciled = (value: unknown): boolean => value === undefined || value === 'already_applied' || value === 'unknown';

const isWorkingFacts = (value: unknown): boolean =>
  isRecord(value) &&
  (value['taskText'] === undefined || typeof value['taskText'] === 'string') &&
  isArrayOf(
    value['written'],
    (entry) =>
      isRecord(entry) &&
      typeof entry['path'] === 'string' &&
      (entry['sha256'] === undefined || isSha256(entry['sha256'])) &&
      isReconciled(entry['reconciled']) &&
      Number.isInteger(entry['seq']),
  ) &&
  isArrayOf(
    value['commands'],
    (entry) =>
      isRecord(entry) &&
      typeof entry['command'] === 'string' &&
      typeof entry['failed'] === 'boolean' &&
      (entry['exitCode'] === undefined || Number.isInteger(entry['exitCode'])) &&
      isReconciled(entry['reconciled']) &&
      Number.isInteger(entry['seq']),
  ) &&
  isArrayOf(
    value['touched'],
    (entry) => isRecord(entry) && (entry['kind'] === 'file' || entry['kind'] === 'directory') && (entry['path'] === undefined || typeof entry['path'] === 'string'),
  ) &&
  isArrayOf(value['messages'], (entry) => isRecord(entry) && typeof entry['text'] === 'string' && Number.isInteger(entry['seq'])) &&
  (value['plan'] === undefined ||
    (isRecord(value['plan']) && Number.isInteger(value['plan']['seq']) && isArrayOf(value['plan']['entries'], isPlanEntry))) &&
  isArrayOf(value['itemEvents'], (entry) => isRecord(entry) && Number.isInteger(entry['itemSeq']) && Number.isInteger(entry['eventSeq'])) &&
  (value['replacedThroughEventSeq'] === undefined || Number.isInteger(value['replacedThroughEventSeq']));

export const SNAPSHOT_STATE_VERSION = 13;

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
    isWorkingFacts(state['workingFacts']) &&
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
    state['loadedInstructions'].every(isLoadedInstruction) &&
    (state['governingLoaded'] === undefined || isGoverningLoaded(state['governingLoaded'])) &&
    (state['memoriesLoaded'] === undefined || isArrayOf(state['memoriesLoaded'], isMemoryLoaded)) &&
    Array.isArray(state['activatedSkills']) &&
    state['activatedSkills'].every(isActivatedSkill) &&
    isArrayOf(state['loadedTools'], (name) => typeof name === 'string') &&
    (state['loopWarned'] === undefined || isLoopWarned(state['loopWarned'])) &&
    (state['streaming'] === undefined || isStreaming(state['streaming'])) &&
    (state['mode'] === undefined || PERMISSION_MODES.some((mode) => mode === state['mode'])) &&
    Number.isInteger(state['taskSeq']) &&
    Array.isArray(state['loopGroups']) &&
    state['loopGroups'].length <= LOOP_GROUPS_KEPT &&
    state['loopGroups'].every(isLoopGroup) &&
    (state['loopOpen'] === undefined || isLoopOpen(state['loopOpen'])) &&
    (state['inherited'] === undefined || isInherited(state['inherited']));
  if (!valid) throw corrupt('snapshots', identity, 'column state_json does not hold a RunState');
  return state as RunState;
};
