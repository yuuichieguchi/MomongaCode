import { PERMISSION_MODES, RUN_STATUSES, STOP_REASONS } from '@momonga/protocol';
import type { RunEvent, RunEventPayload, RunState } from '@momonga/protocol';
import { corrupt, expectOneOf, expectRecord, expectStringRecord, isRecord, readerFor } from './rows.ts';
import type { Row } from './rows.ts';
import type { Run, RunError, Session } from './types.ts';

const identityOf = (row: Row): string => String(row['id']);

export const decodeSession = (row: Row): Session => {
  const identity = identityOf(row);
  const reader = readerFor('sessions', identity, row);
  return {
    id: reader.string('id'),
    cwd: reader.string('cwd'),
    env: expectStringRecord('sessions', identity, 'env_json', reader.json('env_json')),
    permissionMode: expectOneOf('sessions', identity, 'permission_mode', PERMISSION_MODES, reader.string('permission_mode')),
    modelAlias: reader.string('model_alias'),
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
  'tool.call': true,
  'tool.permission.requested': true,
  'tool.permission.resolved': true,
  'tool.started': true,
  'tool.updated': true,
  'tool.completed': true,
  'tool.reconciled': true,
  'plan.updated': true,
  'mode.changed': true,
  'usage.updated': true,
  'context.compacted': true,
  'context.truncated': true,
  'instructions.loaded': true,
  notice: true,
};

export const decodeEvent = (row: Row): RunEvent => {
  const identity = identityOf(row);
  const reader = readerFor('events', identity, row);
  const type = reader.string('type');
  if (!Object.hasOwn(EVENT_TYPES, type)) throw corrupt('events', identity, `column type has unknown event type "${type}"`);
  const payload = expectRecord('events', identity, 'payload_json', reader.json('payload_json'));
  if (payload['type'] !== type) throw corrupt('events', identity, `payload_json type does not match column type "${type}"`);
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

export const decodeRunState = (identity: string, value: unknown): RunState => {
  const state = expectRecord('snapshots', identity, 'state_json', value);
  const usage = state['usage'];
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
    Array.isArray(state['items']) &&
    Array.isArray(state['notes']) &&
    isRecord(state['pendingCalls']) &&
    isRecord(state['toolCallCounts']);
  if (!valid) throw corrupt('snapshots', identity, 'column state_json does not hold a RunState');
  return state as RunState;
};
