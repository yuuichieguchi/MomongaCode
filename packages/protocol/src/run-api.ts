import { APPROVAL_STATUSES, PERMISSION_MODES, RUN_STATUSES, STOP_REASONS, TOOL_KINDS } from './run-types.ts';
import type { RunEvent, RunEventEnvelope, RunEventPayload, SessionEvent } from './run-types.ts';

const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const DAY_MS = 86_400_000;

export type JsonSchema = Readonly<Record<string, unknown>>;

const closed = (properties: Record<string, JsonSchema>, required: readonly string[]): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const root = (schema: JsonSchema): JsonSchema => ({ $schema: DRAFT_2020_12, ...schema });

const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: 'null' }] });

const string: JsonSchema = { type: 'string' };
const integer: JsonSchema = { type: 'integer' };
const nonNegativeInteger: JsonSchema = { type: 'integer', minimum: 0 };
const boolean: JsonSchema = { type: 'boolean' };
const anything: JsonSchema = {};
const enumOf = (values: readonly string[]): JsonSchema => ({ type: 'string', enum: values });
const constant = (value: string): JsonSchema => ({ type: 'string', const: value });
const boundedInteger = (minimum: number, maximum: number): JsonSchema => ({ type: 'integer', minimum, maximum });

const permissionMode = enumOf(PERMISSION_MODES);

const permissionOption = closed(
  {
    optionId: string,
    name: string,
    kind: enumOf(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
  },
  ['optionId', 'name', 'kind'],
);

const usage = closed({ inputTokens: nonNegativeInteger, outputTokens: nonNegativeInteger, totalTokens: nonNegativeInteger }, [
  'inputTokens',
  'outputTokens',
  'totalTokens',
]);

const runLimits = closed(
  {
    maxSteps: boundedInteger(1, 1000),
    maxTotalTokens: boundedInteger(1, 100_000_000),
    approvalTtlMs: boundedInteger(1000, 7 * DAY_MS),
    loopThreshold: boundedInteger(2, 20),
  },
  [],
);

const location = closed({ path: string, line: nonNegativeInteger }, ['path']);

const PAYLOAD_SCHEMAS: Record<RunEventPayload['type'] | SessionEvent['type'], { properties: Record<string, JsonSchema>; required: readonly string[] }> = {
  'user.message': { properties: { text: string }, required: ['text'] },
  'run.started': { properties: { attempt: integer }, required: ['attempt'] },
  'run.status': {
    properties: { from: enumOf(RUN_STATUSES), to: enumOf(RUN_STATUSES), reason: string },
    required: ['from', 'to'],
  },
  'model.requested': {
    properties: { step: nonNegativeInteger, attempt: integer, digest: string },
    required: ['step', 'attempt', 'digest'],
  },
  'model.responded': {
    properties: {
      step: nonNegativeInteger,
      attempt: integer,
      response: closed(
        {
          status: enumOf(['completed', 'incomplete']),
          incompleteReason: string,
          output: { type: 'array' },
          usage: closed({ input_tokens: nonNegativeInteger, output_tokens: nonNegativeInteger, total_tokens: nonNegativeInteger }, [
            'input_tokens',
            'output_tokens',
            'total_tokens',
          ]),
        },
        ['status', 'output', 'usage'],
      ),
    },
    required: ['step', 'attempt', 'response'],
  },
  'agent.message.delta': {
    properties: { step: nonNegativeInteger, attempt: integer, itemId: string, text: string },
    required: ['step', 'attempt', 'itemId', 'text'],
  },
  'agent.thought.delta': {
    properties: { step: nonNegativeInteger, attempt: integer, itemId: string, text: string },
    required: ['step', 'attempt', 'itemId', 'text'],
  },
  'model.stream.restarted': {
    properties: { step: nonNegativeInteger, attempt: integer },
    required: ['step', 'attempt'],
  },
  'tool.call': {
    properties: {
      callId: string,
      providerCallId: string,
      name: string,
      kind: enumOf(TOOL_KINDS),
      title: string,
      rawInput: anything,
      locations: { type: 'array', items: location },
    },
    required: ['callId', 'providerCallId', 'name', 'kind', 'title', 'rawInput'],
  },
  'tool.permission.requested': {
    properties: { approvalId: string, callId: string, options: { type: 'array', items: permissionOption }, subjectDigest: string, suggestedRule: string },
    required: ['approvalId', 'callId', 'options', 'subjectDigest'],
  },
  'tool.permission.resolved': {
    properties: { approvalId: string, optionId: string, rulePersisted: boolean },
    required: ['approvalId', 'optionId'],
  },
  'tool.permission.cancelled': {
    properties: { approvalId: string, reason: enumOf(['expired', 'withdrawn', 'superseded']) },
    required: ['approvalId', 'reason'],
  },
  'tool.started': { properties: { callId: string, idemKey: string }, required: ['callId', 'idemKey'] },
  'tool.updated': { properties: { callId: string, content: { type: 'array' } }, required: ['callId', 'content'] },
  'tool.completed': {
    properties: {
      callId: string,
      status: enumOf(['completed', 'failed']),
      output: string,
      content: { type: 'array' },
      truncated: boolean,
      handle: string,
    },
    required: ['callId', 'status', 'output'],
  },
  'tool.reconciled': {
    properties: { callId: string, outcome: enumOf(['already_applied', 'not_applied', 'unknown']), output: string },
    required: ['callId', 'outcome', 'output'],
  },
  'plan.updated': {
    properties: {
      entries: {
        type: 'array',
        items: closed(
          {
            content: string,
            priority: enumOf(['high', 'medium', 'low']),
            status: enumOf(['pending', 'in_progress', 'completed']),
          },
          ['content', 'priority', 'status'],
        ),
      },
    },
    required: ['entries'],
  },
  'mode.changed': { properties: { mode: permissionMode }, required: ['mode'] },
  'usage.updated': {
    properties: { inputTokens: nonNegativeInteger, outputTokens: nonNegativeInteger, totalTokens: nonNegativeInteger },
    required: ['inputTokens', 'outputTokens', 'totalTokens'],
  },
  'context.compacted': {
    properties: { summary: string, replacedThroughSeq: nonNegativeInteger },
    required: ['summary', 'replacedThroughSeq'],
  },
  'context.truncated': {
    properties: { callId: string, handle: string, kind: enumOf(['omitted', 'truncated']) },
    required: ['callId', 'handle', 'kind'],
  },
  'instructions.loaded': { properties: { path: string }, required: ['path'] },
  'approval.rule.persisted': {
    properties: { approvalId: string, effect: enumOf(['allow', 'deny']), rule: string },
    required: ['approvalId', 'effect', 'rule'],
  },
  notice: {
    properties: { level: enumOf(['info', 'warning', 'error']), message: string },
    required: ['level', 'message'],
  },
};

const publicEventVariant = (type: keyof typeof PAYLOAD_SCHEMAS): JsonSchema => {
  const { properties, required } = PAYLOAD_SCHEMAS[type];
  if (type === 'mode.changed') {
    return closed(
      { id: integer, sessionId: string, createdAt: integer, type: constant(type), ...properties },
      ['id', 'sessionId', 'createdAt', 'type', ...required],
    );
  }
  return closed(
    { id: integer, runId: string, sessionId: string, seq: integer, step: nonNegativeInteger, createdAt: integer, type: constant(type), ...properties },
    ['id', 'runId', 'sessionId', 'seq', 'createdAt', 'type', ...required],
  );
};

const EVENT_TYPES = Object.keys(PAYLOAD_SCHEMAS) as (keyof typeof PAYLOAD_SCHEMAS)[];

const trustView = closed(
  { path: string, decision: { anyOf: [enumOf(['trusted', 'untrusted']), { type: 'null' }] }, inheritedFrom: string },
  ['path', 'decision'],
);

export type RunHealth = {
  status: 'ok';
  version: string;
  apiVersion: 1;
  pid: number;
  startedAt: string;
  state: 'running' | 'draining';
  sandbox: 'seatbelt' | 'none';
};

export const RUN_API_SCHEMAS = {
  CreateSessionRequest: root(
    closed(
      {
        cwd: { type: 'string', minLength: 1 },
        env: { type: 'object', additionalProperties: string },
        permissionMode,
        modelAlias: { type: 'string', minLength: 1 },
        bypassAllowed: boolean,
      },
      ['cwd', 'env'],
    ),
  ),
  PatchSessionRequest: root(closed({ permissionMode }, ['permissionMode'])),
  CreateRunRequest: root(
    closed(
      {
        input: { type: 'string', minLength: 1, maxLength: 1_000_000 },
        limits: runLimits,
        timeoutMs: boundedInteger(1000, 7 * DAY_MS),
      },
      ['input'],
    ),
  ),
  ResolveApprovalRequest: root(closed({ optionId: { type: 'string', minLength: 1 } }, ['optionId'])),
  Health: root(
    closed(
      {
        status: constant('ok'),
        version: string,
        apiVersion: { type: 'integer', const: 1 },
        pid: integer,
        startedAt: string,
        state: enumOf(['running', 'draining']),
        sandbox: enumOf(['seatbelt', 'none']),
      },
      ['status', 'version', 'apiVersion', 'pid', 'startedAt', 'state', 'sandbox'],
    ),
  ),
  SessionView: root(
    closed(
      {
        id: string,
        cwd: string,
        permissionMode,
        modelAlias: string,
        bypassAllowed: boolean,
        createdAt: integer,
        envKeys: { type: 'array', items: string },
        activeRunId: nullable(string),
        latestRunId: nullable(string),
        additionalDirectories: { type: 'array', items: string },
      },
      ['id', 'cwd', 'permissionMode', 'modelAlias', 'bypassAllowed', 'createdAt', 'envKeys', 'activeRunId', 'latestRunId', 'additionalDirectories'],
    ),
  ),
  TrustView: root(trustView),
  TrustResponse: root(closed({ trust: trustView }, ['trust'])),
  PutTrustRequest: root(closed({ path: { type: 'string', minLength: 1 }, decision: enumOf(['trusted', 'untrusted']) }, ['path', 'decision'])),
  RunView: root(
    closed(
      {
        id: string,
        sessionId: string,
        ordinal: integer,
        status: enumOf(RUN_STATUSES),
        stopReason: enumOf(STOP_REASONS),
        error: closed({ code: string, message: string }, ['code', 'message']),
        usage,
        step: nonNegativeInteger,
        limits: runLimits,
        createdAt: integer,
        deadlineAt: integer,
        cancelRequested: boolean,
        lastSeq: nonNegativeInteger,
      },
      ['id', 'sessionId', 'ordinal', 'status', 'usage', 'step', 'limits', 'createdAt', 'deadlineAt', 'cancelRequested', 'lastSeq'],
    ),
  ),
  ApprovalView: root(
    closed(
      {
        id: string,
        runId: string,
        callId: string,
        status: enumOf(APPROVAL_STATUSES),
        options: { type: 'array', items: permissionOption },
        expiresAt: integer,
        createdAt: integer,
        suggestedRule: string,
        toolCall: closed(
          {
            callId: string,
            name: string,
            title: string,
            kind: enumOf(TOOL_KINDS),
            rawInput: anything,
            locations: { type: 'array', items: location },
          },
          ['callId', 'name', 'title', 'kind', 'rawInput'],
        ),
      },
      ['id', 'runId', 'callId', 'status', 'options', 'expiresAt', 'createdAt', 'toolCall'],
    ),
  ),
  ErrorBody: root(
    closed({ error: closed({ type: string, code: string, message: string, param: string }, ['type', 'code', 'message']) }, ['error']),
  ),
  PublicRunEvent: root({ type: 'object', oneOf: EVENT_TYPES.map(publicEventVariant) }),
} as const satisfies Record<string, JsonSchema>;

type ReducedEventType = 'model.requested' | 'run.started' | 'context.compacted' | 'instructions.loaded';

type PublicPayload =
  | Exclude<RunEventPayload, { type: ReducedEventType }>
  | { type: 'model.requested'; step: number; attempt: number; digest: string }
  | { type: 'run.started'; attempt: number }
  | { type: 'context.compacted'; summary: string; replacedThroughSeq: number }
  | { type: 'instructions.loaded'; path: string };

type PublicRunEnvelope = Omit<RunEventEnvelope, 'leaseToken'>;

export type PublicRunEvent =
  | (PublicPayload extends infer Payload ? (Payload extends unknown ? Payload & PublicRunEnvelope : never) : never)
  | SessionEvent;

const reducedFields = (event: RunEvent): Record<string, unknown> | undefined => {
  switch (event.type) {
    case 'model.requested':
      return { step: event.step, attempt: event.attempt, digest: event.digest };
    case 'run.started':
      return { attempt: event.attempt };
    case 'context.compacted':
      return { summary: event.summary, replacedThroughSeq: event.replacedThroughSeq };
    case 'instructions.loaded':
      return { path: event.path };
    default:
      return undefined;
  }
};

export const toPublicRunEvent = (event: RunEvent | SessionEvent): PublicRunEvent => {
  if (!('runId' in event)) return event;
  const { leaseToken: _leaseToken, ...visible } = event;
  const reduced = reducedFields(event);
  if (reduced === undefined) return visible;
  const { id, runId, sessionId, seq, step, createdAt, type } = event;
  return { id, runId, sessionId, seq, step, createdAt, type, ...reduced } as PublicRunEvent;
};
