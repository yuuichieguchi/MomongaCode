import path from 'node:path';
import { APPROVAL_BASES, SIDE_EFFECTS, VERIFICATION_OUTCOMES, FILE_ACCESSES, LOOP_GROUPS_KEPT, MEMORY_ORIGINS, MEMORY_STATUSES, PERMISSION_MODES, RUN_STATUSES, STOP_REASONS, STORED_MODEL_KEYS, EVENT_PAYLOAD_RENAMES, withCurrentNames, decodeStoredModel, planAccountRefOf, INBOX_DELIVERIES, INBOX_STATES } from '@momonga/protocol';
import type { OpaqueEvent, RunEvent, RunEventPayload, RunState, SessionEvent, SessionEventPayload, InboxChangeRow, UserShellRecord } from '@momonga/protocol';
import { InheritanceError } from './inherit.ts';
import { DATABASE_NOT_NEWER } from './decode-context.ts';
import type { DecodeContext } from './decode-context.ts';
import { hasConsistentSeqs } from './seqs.ts';
import { CANCEL_ORIGINS } from './transitions.ts';
import { UNKNOWN_VALUE, corrupt, expectOneOf, storedOneOf, expectRecord, expectStringRecord, isRecord, readerFor } from './rows.ts';
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

export const decodeSession = (row: Row, context: DecodeContext): Session => {
  const identity = identityOf(row);
  const reader = readerFor('sessions', identity, row);
  return {
    id: reader.string('id'),
    cwd: reader.string('cwd'),
    env: expectStringRecord('sessions', identity, 'env_json', reader.json('env_json')),
    permissionMode: storedOneOf(context, 'sessions', identity, 'permission_mode', PERMISSION_MODES, reader.string('permission_mode')),
    model: reader.string('model'),
    bypassAllowed: reader.flag('bypass_allowed'),
    additionalDirectories: expectAbsolutePaths('sessions', identity, 'additional_directories_json', reader.json('additional_directories_json')),
    mcpServers: expectServerRecords(identity, reader.json('mcp_servers_json')),
    createdAt: reader.number('created_at'),
  };
};

export const HISTORY_MODES = ['inherit', 'fresh'] as const;

const decodeUsage = (identity: string, value: unknown): Run['usage'] => {
  const record = expectRecord('runs', identity, 'usage_json', value);
  const { inputTokens, outputTokens, totalTokens } = record;
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number' || typeof totalTokens !== 'number') {
    throw corrupt('runs', identity, 'column usage_json must hold numeric inputTokens, outputTokens and totalTokens');
  }
  const { costNano, unpricedCalls } = record;
  if ((costNano !== undefined && typeof costNano !== 'number') || (unpricedCalls !== undefined && typeof unpricedCalls !== 'number')) {
    throw corrupt('runs', identity, 'column usage_json must hold numeric costNano and unpricedCalls when it holds them');
  }
  return { inputTokens, outputTokens, totalTokens, ...(costNano === undefined ? {} : { costNano }), ...(unpricedCalls === undefined ? {} : { unpricedCalls }) };
};

const decodeCancelOrigin = (context: DecodeContext, identity: string, value: string | null): Run['cancelOrigin'] =>
  value === null ? null : storedOneOf(context, 'runs', identity, 'cancel_origin', CANCEL_ORIGINS, value);

const decodeRunError = (identity: string, value: unknown): RunError => {
  const record = expectRecord('runs', identity, 'error_json', value);
  if (typeof record['code'] !== 'string' || typeof record['message'] !== 'string') {
    throw corrupt('runs', identity, 'column error_json must hold string code and message');
  }
  const error: RunError = { code: record['code'], message: record['message'] };
  if (!Object.hasOwn(record, 'plan')) return error;
  const plan = planAccountRefOf(record['plan']);
  if (plan === undefined) throw corrupt('runs', identity, 'column error_json must hold a plan whose profile and account, when it names one, are plan labels');
  return { ...error, plan };
};

export const decodeRun = (row: Row, context: DecodeContext): Run => {
  const identity = identityOf(row);
  const reader = readerFor('runs', identity, row);
  const stopReason = reader.nullableString('stop_reason');
  const errorJson = reader.nullableJson('error_json');
  const run: Run = {
    id: reader.string('id'),
    sessionId: reader.string('session_id'),
    ordinal: reader.number('ordinal'),
    status: storedOneOf(context, 'runs', identity, 'status', RUN_STATUSES, reader.string('status')),
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
    history: storedOneOf(context, 'runs', identity, 'history_mode', HISTORY_MODES, reader.string('history_mode')),
    parentRunId: reader.nullableString('parent_run_id'),
    parentCallId: reader.nullableString('parent_call_id'),
    origin: storedOneOf(context, 'runs', identity, 'origin', MEMORY_ORIGINS, reader.string('origin')),
    cancelOrigin: decodeCancelOrigin(context, identity, reader.nullableString('cancel_origin')),
  };
  if (stopReason !== null) run.stopReason = storedOneOf(context, 'runs', identity, 'stop_reason', STOP_REASONS, stopReason);
  if (errorJson !== null) run.error = decodeRunError(identity, errorJson);
  return run;
};

const EVENT_TYPES: Record<RunEventPayload['type'], true> = {
  'user.message': true,
  'run.started': true,
  'attempt.failed': true,
  'attempt.lost': true,
  'run.status': true,
  'model.requested': true,
  'model.responded': true,
  'agent.message.delta': true,
  'agent.thought.delta': true,
  'model.stream.restarted': true,
  'tool.call': true,
  'tool.permission.requested': true,
  'tool.permission.classified': true,
  'tool.permission.classifying': true,
  'hook.started': true,
  'hook.completed': true,
  'tool.permission.resolved': true,
  'tool.permission.cancelled': true,
  'tool.unknown.requested': true,
  'tool.unknown.resolved': true,
  'tool.unknown.cancelled': true,
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
  'context.compacting': true,
  'context.compaction_rejected': true,
  'context.inherited': true,
  'context.truncated': true,
  'instructions.loaded': true,
  'skill.activated': true,
  'verification.started': true,
  'verification.completed': true,
  'tool.loaded': true,
  'tool.offered': true,
  'loop.warned': true,
  'budget.exhausted': true,
  'tool.held': true,
  'tool.held.resolved': true,
  'run.quiescent': true,
  'meter.observed': true,
  'model.rejected': true,
  'approval.rule.persisted': true,
  notice: true,
};

const SESSION_EVENT_TYPES: Record<SessionEventPayload['type'], true> = { 'mode.changed': true, 'model.changed': true, 'inbox.changed': true, user_shell: true };

const isToolFile = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value['path'] === 'string' &&
  (value['sha256'] === undefined || (typeof value['sha256'] === 'string' && /^[0-9a-f]{64}$/.test(value['sha256']))) &&
  FILE_ACCESSES.some((access) => access === value['access']);

const assertToolFacts = (identity: string, payload: Record<string, unknown>): void => {
  if (payload['files'] !== undefined && !(Array.isArray(payload['files']) && payload['files'].every(isToolFile))) {
    throw corrupt('events', identity, 'payload_json files must hold path, an optional sha256 and access entries');
  }
  if (payload['command'] !== undefined && typeof payload['command'] !== 'string') {
    throw corrupt('events', identity, 'payload_json command must be a string');
  }
  if (payload['windowShared'] !== undefined && payload['windowShared'] !== true) {
    throw corrupt('events', identity, 'payload_json windowShared must be true');
  }
  if (payload['memories'] !== undefined && !(Array.isArray(payload['memories']) && payload['memories'].every((id) => typeof id === 'string'))) {
    throw corrupt('events', identity, 'payload_json memories must hold memory ids');
  }
  if (payload['exitCode'] !== undefined && !Number.isInteger(payload['exitCode'])) {
    throw corrupt('events', identity, 'payload_json exitCode must be an integer');
  }
};

const REFERENCE_NUMBERS = ['fromLastSeq', 'nextItemSeq', 'fromNextItemSeq', 'itemCount'] as const;

const REFERENCE_LISTS = ['omitSeqs', 'synthesised', 'via'] as const;

const assertInheritedForm = (identity: string, payload: Record<string, unknown>): void => {
  const refuse = (detail: string): never => {
    throw new InheritanceError('previous_run_inconsistent', `event ${identity}: context.inherited ${detail}`);
  };
  if (payload['form'] === undefined) {
    if (!Array.isArray(payload['history'])) refuse('has neither form "reference" nor a history');
    return;
  }
  if (payload['form'] !== 'reference') refuse(`has the unknown form ${JSON.stringify(payload['form'])}`);
  if (payload['history'] !== undefined) refuse('is a reference and carries a history');
  if (typeof payload['fromRunId'] !== 'string' || typeof payload['digest'] !== 'string') refuse('is a reference without fromRunId and digest');
  for (const key of REFERENCE_NUMBERS) if (!Number.isInteger(payload[key])) refuse(`is a reference without the number ${key}`);
  for (const key of REFERENCE_LISTS) if (!Array.isArray(payload[key])) refuse(`is a reference without the list ${key}`);
};

const decodeRunEvent = (row: Row, identity: string, type: string, payload: Record<string, unknown>): RunEvent => {
  const reader = readerFor('events', identity, row);
  if (type === 'tool.completed' || type === 'tool.reconciled') assertToolFacts(identity, payload);
  if (type === 'context.inherited') assertInheritedForm(identity, payload);
  const envelope = {
    id: reader.number('id'),
    runId: reader.string('run_id'),
    sessionId: reader.string('session_id'),
    seq: reader.number('seq'),
    step: reader.number('step'),
    leaseToken: reader.number('lease_token'),
    createdAt: reader.number('created_at'),
  };
  const renames = Object.hasOwn(EVENT_PAYLOAD_RENAMES, type) ? EVENT_PAYLOAD_RENAMES[type as RunEventPayload['type']] : undefined;
  return { ...(renames === undefined ? payload : withCurrentNames(payload, renames)), ...envelope } as RunEvent;
};

const inboxChangeRowOf = (context: DecodeContext, identity: string, value: unknown): InboxChangeRow => {
  if (!isRecord(value)) throw corrupt('events', identity, 'payload_json pending must hold inbox rows');
  const { id, delivery, state, seq } = value;
  if (typeof id !== 'string' || typeof delivery !== 'string' || typeof state !== 'string' || typeof seq !== 'number' || !Number.isInteger(seq)) {
    throw corrupt('events', identity, 'payload_json pending must hold inbox rows with id, delivery, state and seq');
  }
  return {
    id,
    delivery: storedOneOf(context, 'events', identity, 'payload_json', INBOX_DELIVERIES, delivery),
    state: storedOneOf(context, 'events', identity, 'payload_json', INBOX_STATES, state),
    seq,
  };
};

export const userShellRecordOf = (identity: string, payload: Record<string, unknown>): UserShellRecord => {
  const { command, exitCode, output, include } = payload;
  if (typeof command !== 'string' || typeof output !== 'string' || typeof include !== 'boolean' || !(exitCode === null || Number.isInteger(exitCode))) {
    throw corrupt('events', identity, 'payload_json of user_shell must hold command, exitCode, output and include');
  }
  return { command, exitCode: exitCode as number | null, output, include };
};

const decodeSessionEvent = (row: Row, identity: string, type: string, payload: Record<string, unknown>, context: DecodeContext): SessionEvent => {
  const reader = readerFor('events', identity, row);
  const envelope = { id: reader.number('id'), sessionId: reader.string('session_id'), createdAt: reader.number('created_at') };
  if (type === 'model.changed') {
    const model = decodeStoredModel(payload, STORED_MODEL_KEYS.modelChanged);
    const previousModel = decodeStoredModel(payload, STORED_MODEL_KEYS.previousModel);
    if (model === undefined || previousModel === undefined) {
      throw corrupt('events', identity, 'payload_json model and previousModel must be strings');
    }
    return { type: 'model.changed', model, previousModel, ...envelope };
  }
  if (type === 'inbox.changed') {
    const { pending } = payload;
    if (!Array.isArray(pending)) throw corrupt('events', identity, 'payload_json pending must hold inbox rows');
    return { type: 'inbox.changed', pending: pending.map((row) => inboxChangeRowOf(context, identity, row)), ...envelope };
  }
  if (type === 'user_shell') return { type: 'user_shell', ...userShellRecordOf(identity, payload), ...envelope };
  const mode = payload['mode'];
  if (typeof mode !== 'string') throw corrupt('events', identity, 'payload_json mode must be a string');
  return { type: 'mode.changed', mode: storedOneOf(context, 'events', identity, 'payload_json', PERMISSION_MODES, mode), ...envelope };
};

export { DATABASE_NOT_NEWER, decodeContextOf } from './decode-context.ts';
export type { DecodeContext } from './decode-context.ts';

const opaqueEventOf = (row: Row, identity: string, type: string, payload: Record<string, unknown>): OpaqueEvent => {
  const reader = readerFor('events', identity, row);
  return {
    opaque: true,
    type,
    id: reader.number('id'),
    runId: reader.nullableString('run_id'),
    sessionId: reader.string('session_id'),
    seq: reader.nullableNumber('seq'),
    step: reader.nullableNumber('step'),
    createdAt: reader.number('created_at'),
    payload,
  };
};

export const decodeStoredEvent = (row: Row, context: DecodeContext): RunEvent | SessionEvent | OpaqueEvent => {
  const identity = identityOf(row);
  const reader = readerFor('events', identity, row);
  const type = reader.string('type');
  const payload = expectRecord('events', identity, 'payload_json', reader.json('payload_json'));
  if (payload['type'] !== type) throw corrupt('events', identity, `payload_json type does not match column type "${type}"`);
  const sessionScoped = reader.nullableString('run_id') === null;
  if (!Object.hasOwn(sessionScoped ? SESSION_EVENT_TYPES : EVENT_TYPES, type)) {
    if (context.databaseIsNewer()) return opaqueEventOf(row, identity, type, payload);
    throw corrupt('events', identity, sessionScoped ? `column run_id is NULL but type "${type}" is not a session event type` : `column type has unknown event type "${type}"`);
  }
  return sessionScoped ? decodeSessionEvent(row, identity, type, payload, context) : decodeRunEvent(row, identity, type, payload);
};

export const isOpaqueEvent = (event: RunEvent | SessionEvent | OpaqueEvent): event is OpaqueEvent => 'opaque' in event;

export const decodeKnownEvent = (row: Row, context: DecodeContext): RunEvent | SessionEvent | undefined => {
  const event = decodeStoredEvent(row, context);
  return isOpaqueEvent(event) ? undefined : event;
};

export const decodeEvent = (row: Row): RunEvent | SessionEvent => {
  const event = decodeStoredEvent(row, DATABASE_NOT_NEWER);
  if (isOpaqueEvent(event)) throw corrupt('events', identityOf(row), `decoded the unknown event type "${event.type}" without a database`);
  return event;
};

export const decodeRunEvents = (rows: readonly Row[], context: DecodeContext = DATABASE_NOT_NEWER): RunEvent[] =>
  rows.flatMap((row) => {
    const event = decodeKnownEvent(row, context);
    if (event === undefined) return [];
    if (!('runId' in event)) throw corrupt('events', identityOf(row), 'a run event query returned a session event');
    return [event];
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
  (value['sideEffect'] === undefined || SIDE_EFFECTS.some((effect) => effect === value['sideEffect'])) &&
  (value['basis'] === undefined || APPROVAL_BASES.some((basis) => basis === value['basis'])) &&
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

const isCompactionPointer = (value: unknown): boolean => isRecord(value) && typeof value['runId'] === 'string' && Number.isInteger(value['eventSeq']);

const isInherited = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value['fromRunId'] === 'string' &&
  Number.isInteger(value['fromLastSeq']) &&
  typeof value['digest'] === 'string' &&
  (value['form'] === undefined || value['form'] === 'reference') &&
  (value['fromNextItemSeq'] === undefined || Number.isInteger(value['fromNextItemSeq'])) &&
  (value['itemCount'] === undefined || Number.isInteger(value['itemCount'])) &&
  (value['compaction'] === undefined || isCompactionPointer(value['compaction']));

const TRUNCATION_KINDS: readonly unknown[] = ['omitted', 'truncated', 'reference'];

const isInheritedTruncation = (value: unknown): boolean =>
  isRecord(value) && typeof value['callId'] === 'string' && typeof value['handle'] === 'string' && TRUNCATION_KINDS.includes(value['kind']);

const isLoadedInstruction = (value: unknown): boolean =>
  isRecord(value) && typeof value['path'] === 'string' && typeof value['textSha256'] === 'string' && Number.isInteger(value['seq']) && typeof value['content'] === 'string';

const isVerificationState = (value: unknown): boolean =>
  isRecord(value) &&
  Number.isInteger(value['round']) &&
  isRecord(value['results']) &&
  Object.values(value['results']).every(
    (result) =>
      isRecord(result) &&
      Number.isInteger(result['seq']) &&
      Number.isInteger(result['mutationSeq']) &&
      (result['round'] === undefined || Number.isInteger(result['round'])) &&
      VERIFICATION_OUTCOMES.some((outcome) => outcome === result['outcome']),
  ) &&
  (value['pending'] === undefined ||
    (isRecord(value['pending']) && Object.values(value['pending']).every((check) => isRecord(check) && Number.isInteger(check['round']) && Number.isInteger(check['attempt'])))) &&
  (value['lastFailure'] === undefined || (isRecord(value['lastFailure']) && Number.isInteger(value['lastFailure']['round']) && Number.isInteger(value['lastFailure']['mutationSeq']))) &&
  (value['failureBefore'] === undefined || Number.isInteger(value['failureBefore']));

const isCountMap = (value: unknown): boolean => isRecord(value) && Object.values(value).every((count) => Number.isInteger(count));

const isCallResults = (value: unknown): boolean => isRecord(value) && Object.values(value).every((status) => status === 'completed' || status === 'failed');

const isUnknownEffects = (value: unknown): boolean =>
  isRecord(value) &&
  Object.values(value).every(
    (entry) => isRecord(entry) && typeof entry['acknowledged'] === 'boolean' && (entry['approvalId'] === undefined || typeof entry['approvalId'] === 'string'),
  );

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
      (entry['removed'] === undefined || entry['removed'] === true) &&
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
      (entry['unobserved'] === undefined || entry['unobserved'] === true) &&
      (entry['windowShared'] === undefined || entry['windowShared'] === true) &&
      isReconciled(entry['reconciled']) &&
      Number.isInteger(entry['seq']),
  ) &&
  isArrayOf(value['messages'], (entry) => isRecord(entry) && typeof entry['text'] === 'string' && Number.isInteger(entry['seq'])) &&
  (value['plan'] === undefined ||
    (isRecord(value['plan']) && Number.isInteger(value['plan']['seq']) && isArrayOf(value['plan']['entries'], isPlanEntry))) &&
  isArrayOf(value['itemEvents'], (entry) => isRecord(entry) && Number.isInteger(entry['itemSeq']) && Number.isInteger(entry['eventSeq'])) &&
  (value['replacedThroughEventSeq'] === undefined || Number.isInteger(value['replacedThroughEventSeq']));

export const SNAPSHOT_STATE_VERSION = 21;

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
    isCountMap(state['hookCompletions']) &&
    typeof state['stopHookRanSinceResponse'] === 'boolean' &&
    Number.isInteger(state['stopHookContinuations']) &&
    Number.isInteger(state['compactions']) &&
    Number.isInteger(state['lastCompactionSeq']) &&
    isCallResults(state['callResults']) &&
    isUnknownEffects(state['unknownEffects']) &&
    Number.isInteger(state['lastMutationSeq']) &&
    isVerificationState(state['verification']) &&
    isCountMap(state['formsSinceCompaction']) &&
    (state['governingLoaded'] === undefined || isGoverningLoaded(state['governingLoaded'])) &&
    (state['memoriesLoaded'] === undefined || isArrayOf(state['memoriesLoaded'], isMemoryLoaded)) &&
    Array.isArray(state['activatedSkills']) &&
    state['activatedSkills'].every(isActivatedSkill) &&
    isArrayOf(state['loadedTools'], (name) => typeof name === 'string') &&
    (state['offeredTools'] === undefined || isArrayOf(state['offeredTools'], (name) => typeof name === 'string')) &&
    (state['loopWarned'] === undefined || isLoopWarned(state['loopWarned'])) &&
    (state['rejectedCalls'] === undefined || isArrayOf(state['rejectedCalls'], (digest) => typeof digest === 'string')) &&
    (state['streaming'] === undefined || isStreaming(state['streaming'])) &&
    (state['mode'] === undefined || PERMISSION_MODES.some((mode) => mode === state['mode'])) &&
    Number.isInteger(state['taskSeq']) &&
    Array.isArray(state['loopGroups']) &&
    state['loopGroups'].length <= LOOP_GROUPS_KEPT &&
    state['loopGroups'].every(isLoopGroup) &&
    (state['loopOpen'] === undefined || isLoopOpen(state['loopOpen'])) &&
    (state['inherited'] === undefined || isInherited(state['inherited'])) &&
    (state['ownCompactionEventSeq'] === undefined || Number.isInteger(state['ownCompactionEventSeq'])) &&
    (state['inheritedSummaryItem'] === undefined || isSummaryItem(state['inheritedSummaryItem'])) &&
    (state['inheritedTruncations'] === undefined || isArrayOf(state['inheritedTruncations'], isInheritedTruncation));
  if (!valid) throw corrupt('snapshots', identity, 'column state_json does not hold a RunState');
  return state as RunState;
};
