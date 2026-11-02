import { HOOK_EVENTS, HOOK_OUTCOMES, HOOK_PRE_TOOL_DECISIONS } from './hooks.ts';
import { MEMORY_SCOPES } from './memory.ts';
import { PERMISSION_DENIAL_SOURCES } from './permission-denial.ts';
import { APPROVAL_STATUSES, IMAGE_MEDIA_TYPES, JOB_STATUSES, PERMISSION_MODES, RUN_STATUSES, STOP_REASONS, TOOL_KINDS } from './run-types.ts';
import type { ImageMediaType, RunEvent, RunEventEnvelope, RunEventPayload, SessionEvent } from './run-types.ts';

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
const sessionMcpServers: JsonSchema = { type: 'object', additionalProperties: { type: 'object' } };
const historyMode = enumOf(['inherit', 'fresh']);

const permissionOption = closed(
  {
    optionId: string,
    name: string,
    kind: enumOf(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
  },
  ['optionId', 'name', 'kind'],
);

const BASE64_PATTERN = '^[A-Za-z0-9+/]+={0,2}$';

const imageAttachment = closed(
  { mediaType: enumOf(IMAGE_MEDIA_TYPES), data: { type: 'string', minLength: 1, pattern: BASE64_PATTERN } },
  ['mediaType', 'data'],
);

const imageSummary = closed({ mediaType: enumOf(IMAGE_MEDIA_TYPES), byteLength: nonNegativeInteger }, ['mediaType', 'byteLength']);

export const base64ByteLength = (data: string): number => {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return (data.length / 4) * 3 - padding;
};

const elicitationRequest = {
  oneOf: [
    closed({ key: string, mode: constant('form'), message: string, requestedSchema: { type: 'object' } }, ['key', 'mode', 'message', 'requestedSchema']),
    closed({ key: string, mode: constant('url'), message: string, url: string }, ['key', 'mode', 'message', 'url']),
  ],
} as const satisfies JsonSchema;

const elicitationAnswer = {
  oneOf: [
    closed({ action: constant('accept'), content: { type: 'object' } }, ['action']),
    closed({ action: constant('decline') }, ['action']),
    closed({ action: constant('cancel') }, ['action']),
  ],
} as const satisfies JsonSchema;

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

const SKILL_SCOPES = ['project', 'user'] as const;
const AGENT_SCOPES = ['project', 'user'] as const;

const toolAwait: JsonSchema = {
  oneOf: [
    closed({ kind: constant('run'), runId: string, sessionId: string, agent: string }, ['kind', 'runId', 'sessionId', 'agent']),
    closed({ kind: constant('job'), jobId: string }, ['kind', 'jobId']),
  ],
};

const jobView = closed(
  {
    id: string,
    sessionId: string,
    runId: string,
    callId: string,
    command: string,
    status: enumOf(JOB_STATUSES),
    exitCode: integer,
    signal: string,
    startedAt: integer,
    endedAt: integer,
  },
  ['id', 'sessionId', 'runId', 'callId', 'command', 'status', 'startedAt'],
);

const skillView = closed(
  { name: string, description: string, scope: enumOf(SKILL_SCOPES), location: string },
  ['name', 'description', 'scope', 'location'],
);

const agentView = closed(
  { name: string, description: string, scope: enumOf(AGENT_SCOPES), location: string },
  ['name', 'description', 'scope', 'location'],
);

const PAYLOAD_SCHEMAS: Record<RunEventPayload['type'] | SessionEvent['type'], { properties: Record<string, JsonSchema>; required: readonly string[] }> = {
  'user.message': { properties: { text: string, images: { type: 'array', items: imageSummary } }, required: ['text'] },
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
  'tool.permission.classified': {
    properties: {
      callId: string,
      alias: string,
      outcome: enumOf(['allow', 'ask']),
      verdict: enumOf(['safe', 'unsafe']),
      confidence: enumOf(['high', 'medium', 'low']),
      rationale: string,
      failure: string,
    },
    required: ['callId', 'outcome'],
  },
  'hook.completed': {
    properties: {
      hookEvent: enumOf(HOOK_EVENTS),
      command: string,
      outcome: enumOf(HOOK_OUTCOMES),
      exitCode: integer,
      callId: string,
      decision: enumOf([...HOOK_PRE_TOOL_DECISIONS, 'block']),
      message: string,
      systemMessage: string,
      updatedInput: { type: 'object' },
      stopReason: string,
      halted: boolean,
      durationMs: nonNegativeInteger,
    },
    required: ['hookEvent', 'command', 'outcome', 'durationMs'],
  },
  'tool.permission.resolved': {
    properties: { approvalId: string, optionId: string, rulePersisted: boolean },
    required: ['approvalId', 'optionId'],
  },
  'tool.permission.cancelled': {
    properties: { approvalId: string, reason: enumOf(['expired', 'withdrawn', 'superseded']) },
    required: ['approvalId', 'reason'],
  },
  'tool.elicitation.requested': {
    properties: { inputId: string, callId: string, server: string, requests: { type: 'array', items: elicitationRequest } },
    required: ['inputId', 'callId', 'server', 'requests'],
  },
  'tool.elicitation.resolved': {
    properties: { inputId: string, responses: { type: 'object', additionalProperties: elicitationAnswer } },
    required: ['inputId', 'responses'],
  },
  'tool.elicitation.cancelled': {
    properties: { inputId: string, reason: enumOf(['expired', 'withdrawn', 'superseded']) },
    required: ['inputId', 'reason'],
  },
  'mcp.authorization.required': { properties: { callId: string, server: string }, required: ['server'] },
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
      denial: closed({ source: enumOf(PERMISSION_DENIAL_SOURCES), reason: string }, ['source', 'reason']),
    },
    required: ['callId', 'status', 'output'],
  },
  'tool.reconciled': {
    properties: { callId: string, outcome: enumOf(['already_applied', 'not_applied', 'unknown']), output: string },
    required: ['callId', 'outcome', 'output'],
  },
  'tool.waiting': {
    properties: { callId: string, awaits: toolAwait, wakeAt: integer },
    required: ['callId', 'awaits'],
  },
  'job.finished': {
    properties: { jobId: string, status: enumOf(JOB_STATUSES.filter((status) => status !== 'running')), exitCode: integer, signal: string },
    required: ['jobId', 'status'],
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
  'context.compaction_rejected': { properties: { attempt: integer }, required: [] },
  'context.inherited': {
    properties: {
      fromRunId: string,
      fromLastSeq: nonNegativeInteger,
      itemCount: nonNegativeInteger,
      nextItemSeq: nonNegativeInteger,
      summaryThroughSeq: nonNegativeInteger,
      closures: {
        type: 'array',
        items: closed({ callId: string, effect: enumOf(['not_executed', 'unknown']), announced: boolean }, ['callId', 'effect', 'announced']),
      },
      partialMessage: boolean,
      markers: {
        type: 'array',
        items: closed({ kind: enumOf(['interrupted', 'unprocessed', 'dropped', 'mode_changed']) }, ['kind']),
      },
      digest: string,
    },
    required: ['fromRunId', 'fromLastSeq', 'itemCount', 'nextItemSeq', 'closures', 'partialMessage', 'markers', 'digest'],
  },
  'context.truncated': {
    properties: { callId: string, handle: string, kind: enumOf(['omitted', 'truncated']) },
    required: ['callId', 'handle', 'kind'],
  },
  'instructions.loaded': { properties: { path: string }, required: ['path'] },
  'skill.activated': { properties: { name: string }, required: ['name'] },
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

const costTotalsProperties: Record<string, JsonSchema> = {
  calls: nonNegativeInteger,
  unpricedCalls: nonNegativeInteger,
  inputTokens: nonNegativeInteger,
  outputTokens: nonNegativeInteger,
  cachedInputTokens: nonNegativeInteger,
  amount: { type: 'number', minimum: 0 },
  currency: constant('USD'),
  priceVersions: { type: 'array', items: string },
};
const costTotalsRequired = Object.keys(costTotalsProperties);

const costReportView = closed(
  {
    runs: { type: 'array', items: closed({ runId: string, sessionId: string, ...costTotalsProperties }, ['runId', 'sessionId', ...costTotalsRequired]) },
    sessions: {
      type: 'array',
      items: closed({ sessionId: string, runIds: { type: 'array', items: string }, ...costTotalsProperties }, ['sessionId', 'runIds', ...costTotalsRequired]),
    },
    total: closed(costTotalsProperties, costTotalsRequired),
  },
  ['runs', 'sessions', 'total'],
);

const memoryScope = enumOf(MEMORY_SCOPES);

const memoryView = closed(
  {
    id: string,
    scope: memoryScope,
    project: nullable(string),
    text: string,
    source: closed(
      { sessionId: string, runId: string, step: nonNegativeInteger, callId: string, seq: nonNegativeInteger },
      ['sessionId', 'runId', 'step', 'callId', 'seq'],
    ),
    createdAt: integer,
    lastUsedAt: integer,
  },
  ['id', 'scope', 'project', 'text', 'source', 'createdAt', 'lastUsedAt'],
);

export type SkillScope = (typeof SKILL_SCOPES)[number];

export type SkillView = { name: string; description: string; scope: SkillScope; location: string };

export type SkillsResponse = { skills: SkillView[]; warnings: string[] };

export type AgentScope = (typeof AGENT_SCOPES)[number];

export type AgentView = { name: string; description: string; scope: AgentScope; location: string };

export type AgentsResponse = { agents: AgentView[]; warnings: string[] };

export type RunTraceSpan = {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: 'INTERNAL' | 'SERVER' | 'CLIENT' | 'PRODUCER' | 'CONSUMER';
  startMs: number;
  endMs: number;
  status: 'UNSET' | 'OK' | 'ERROR';
  attributes: Record<string, unknown>;
};

export type RunTraceSummary = {
  steps: number;
  chatCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  errorCount: number;
  durationMs: number;
  chatResults: { step: number; attempt: number; finishReasons: string[] }[];
};

export type RunTraceView = { runId: string; summary: RunTraceSummary; spans: RunTraceSpan[] };

export const MCP_AUTH_STATES = ['not_applicable', 'static_header', 'not_required', 'authorized', 'required', 'unreachable'] as const;

export const MCP_AUTHORIZATION_STATUSES = ['awaiting_user', 'completed', 'failed'] as const;

export type McpAuthState = (typeof MCP_AUTH_STATES)[number];

export type McpAuthorizationView = {
  server: string;
  status: (typeof MCP_AUTHORIZATION_STATUSES)[number];
  startedAt: number;
  expiresAt: number;
  url?: string;
  failure?: { code: string; message: string };
};

export type McpServerView = {
  name: string;
  scope: 'user' | 'project' | 'session';
  transport: 'stdio' | 'http';
  url?: string;
  auth: McpAuthState;
  detail?: string;
  authorization?: McpAuthorizationView;
};

export type JobView = {
  id: string;
  sessionId: string;
  runId: string;
  callId: string;
  command: string;
  status: (typeof JOB_STATUSES)[number];
  exitCode?: number;
  signal?: string;
  startedAt: number;
  endedAt?: number;
};

export type JobsResponse = { jobs: JobView[] };
export type CostTotalsView = {
  calls: number;
  unpricedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  amount: number;
  currency: 'USD';
  priceVersions: string[];
};

export type CostReportView = {
  runs: (CostTotalsView & { runId: string; sessionId: string })[];
  sessions: (CostTotalsView & { sessionId: string; runIds: string[] })[];
  total: CostTotalsView;
};

export type RunHealth = {
  status: 'ok';
  version: string;
  apiVersion: 1;
  pid: number;
  startedAt: string;
  state: 'running' | 'draining';
  sandbox: 'seatbelt' | 'bubblewrap' | 'none';
};

const runView = closed(
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
    previousRunId: nullable(string),
    history: historyMode,
    parentRunId: nullable(string),
    parentCallId: nullable(string),
    agent: string,
  },
  [
    'id',
    'sessionId',
    'ordinal',
    'status',
    'usage',
    'step',
    'limits',
    'createdAt',
    'deadlineAt',
    'cancelRequested',
    'lastSeq',
    'previousRunId',
    'history',
    'parentRunId',
    'parentCallId',
  ],
);

export const RUN_API_SCHEMAS = {
  CreateSessionRequest: root(
    closed(
      {
        cwd: { type: 'string', minLength: 1 },
        env: { type: 'object', additionalProperties: string },
        permissionMode,
        modelAlias: { type: 'string', minLength: 1 },
        bypassAllowed: boolean,
        mcpServers: sessionMcpServers,
      },
      ['cwd', 'env'],
    ),
  ),
  PatchSessionRequest: root({ ...closed({ permissionMode, mcpServers: sessionMcpServers }, []), minProperties: 1 }),
  CreateRunRequest: root(
    closed(
      {
        input: { type: 'string', minLength: 1, maxLength: 1_000_000 },
        limits: runLimits,
        timeoutMs: boundedInteger(1000, 7 * DAY_MS),
        history: historyMode,
        skill: { type: 'string', minLength: 1 },
        images: { type: 'array', items: imageAttachment },
      },
      ['input'],
    ),
  ),
  ResolveApprovalRequest: root(closed({ optionId: { type: 'string', minLength: 1 } }, ['optionId'])),
  McpAuthorizationView: root(
    closed(
      {
        server: string,
        status: enumOf(MCP_AUTHORIZATION_STATUSES),
        startedAt: integer,
        expiresAt: integer,
        url: string,
        failure: closed({ code: string, message: string }, ['code', 'message']),
      },
      ['server', 'status', 'startedAt', 'expiresAt'],
    ),
  ),
  McpServersResponse: root(
    closed(
      {
        servers: {
          type: 'array',
          items: closed(
            {
              name: string,
              scope: enumOf(['user', 'project', 'session']),
              transport: enumOf(['stdio', 'http']),
              url: string,
              auth: enumOf(MCP_AUTH_STATES),
              detail: string,
              authorization: { type: 'object' },
            },
            ['name', 'scope', 'transport', 'auth'],
          ),
        },
      },
      ['servers'],
    ),
  ),
  ResolveElicitationRequest: root(closed({ responses: { type: 'object', additionalProperties: elicitationAnswer } }, ['responses'])),
  ElicitationView: root(
    closed(
      {
        id: string,
        runId: string,
        callId: string,
        status: enumOf(APPROVAL_STATUSES),
        server: string,
        requests: { type: 'array', items: elicitationRequest },
        expiresAt: integer,
        createdAt: integer,
        toolCall: closed({ callId: string, name: string, title: string }, ['callId', 'name', 'title']),
      },
      ['id', 'runId', 'callId', 'status', 'server', 'requests', 'expiresAt', 'createdAt', 'toolCall'],
    ),
  ),
  Health: root(
    closed(
      {
        status: constant('ok'),
        version: string,
        apiVersion: { type: 'integer', const: 1 },
        pid: integer,
        startedAt: string,
        state: enumOf(['running', 'draining']),
        sandbox: enumOf(['seatbelt', 'bubblewrap', 'none']),
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
        lastEventId: nonNegativeInteger,
      },
      ['id', 'cwd', 'permissionMode', 'modelAlias', 'bypassAllowed', 'createdAt', 'envKeys', 'activeRunId', 'latestRunId', 'additionalDirectories', 'lastEventId'],
    ),
  ),
  TrustView: root(trustView),
  TrustResponse: root(closed({ trust: trustView }, ['trust'])),
  PutTrustRequest: root(closed({ path: { type: 'string', minLength: 1 }, decision: enumOf(['trusted', 'untrusted']) }, ['path', 'decision'])),
  RunView: root(runView),
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
  JobView: root(jobView),
  JobsResponse: root(closed({ jobs: { type: 'array', items: jobView } }, ['jobs'])),
  ChildRunsResponse: root(closed({ runs: { type: 'array', items: runView } }, ['runs'])),
  SkillsResponse: root(closed({ skills: { type: 'array', items: skillView }, warnings: { type: 'array', items: string } }, ['skills', 'warnings'])),
  AgentsResponse: root(closed({ agents: { type: 'array', items: agentView }, warnings: { type: 'array', items: string } }, ['agents', 'warnings'])),
  RunTrace: root(
    closed(
      {
        runId: string,
        summary: closed(
          {
            steps: nonNegativeInteger,
            chatCalls: nonNegativeInteger,
            toolCalls: nonNegativeInteger,
            inputTokens: nonNegativeInteger,
            outputTokens: nonNegativeInteger,
            cachedInputTokens: nonNegativeInteger,
            errorCount: nonNegativeInteger,
            durationMs: nonNegativeInteger,
            chatResults: {
              type: 'array',
              items: closed({ step: nonNegativeInteger, attempt: integer, finishReasons: { type: 'array', items: string } }, ['step', 'attempt', 'finishReasons']),
            },
          },
          ['steps', 'chatCalls', 'toolCalls', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'errorCount', 'durationMs', 'chatResults'],
        ),
        spans: {
          type: 'array',
          items: closed(
            {
              traceId: string,
              spanId: string,
              parentSpanId: nullable(string),
              name: string,
              kind: enumOf(['INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER']),
              startMs: integer,
              endMs: integer,
              status: enumOf(['UNSET', 'OK', 'ERROR']),
              attributes: { type: 'object' },
            },
            ['traceId', 'spanId', 'parentSpanId', 'name', 'kind', 'startMs', 'endMs', 'status', 'attributes'],
          ),
        },
      },
      ['runId', 'summary', 'spans'],
    ),
  ),
  CostReport: root(costReportView),
  MemoryView: root(memoryView),
  MemoriesResponse: root(closed({ memories: { type: 'array', items: memoryView } }, ['memories'])),
  MemoryResponse: root(closed({ memory: memoryView }, ['memory'])),
  ErrorBody: root(
    closed({ error: closed({ type: string, code: string, message: string, param: string }, ['type', 'code', 'message']) }, ['error']),
  ),
  PublicRunEvent: root({ type: 'object', oneOf: EVENT_TYPES.map(publicEventVariant) }),
} as const satisfies Record<string, JsonSchema>;

type ReducedEventType =
  | 'user.message'
  | 'model.requested'
  | 'run.started'
  | 'context.compacted'
  | 'context.compaction_rejected'
  | 'context.inherited'
  | 'instructions.loaded'
  | 'skill.activated';

type PublicPayload =
  | Exclude<RunEventPayload, { type: ReducedEventType }>
  | { type: 'user.message'; text: string; images?: { mediaType: ImageMediaType; byteLength: number }[] }
  | { type: 'model.requested'; step: number; attempt: number; digest: string }
  | { type: 'run.started'; attempt: number }
  | { type: 'context.compacted'; summary: string; replacedThroughSeq: number }
  | { type: 'context.compaction_rejected'; step?: number; attempt?: number }
  | {
      type: 'context.inherited';
      fromRunId: string;
      fromLastSeq: number;
      itemCount: number;
      nextItemSeq: number;
      summaryThroughSeq?: number;
      closures: { callId: string; effect: 'not_executed' | 'unknown'; announced: boolean }[];
      partialMessage: boolean;
      markers: { kind: 'interrupted' | 'unprocessed' | 'dropped' | 'mode_changed' }[];
      digest: string;
    }
  | { type: 'instructions.loaded'; path: string }
  | { type: 'skill.activated'; name: string };

type PublicRunEnvelope = Omit<RunEventEnvelope, 'leaseToken'>;

export type PublicRunEvent =
  | (PublicPayload extends infer Payload ? (Payload extends unknown ? Payload & PublicRunEnvelope : never) : never)
  | SessionEvent;

export const toPublicRunEvent = (event: RunEvent | SessionEvent): PublicRunEvent => {
  if (!('runId' in event)) return event;
  const { id, runId, sessionId, seq, step, createdAt } = event;
  const envelope = { id, runId, sessionId, seq, step, createdAt };
  switch (event.type) {
    case 'user.message':
      return {
        ...envelope,
        type: event.type,
        text: event.text,
        ...(event.images === undefined ? {} : { images: event.images.map((image) => ({ mediaType: image.mediaType, byteLength: base64ByteLength(image.data) })) }),
      };
    case 'model.requested':
      return { ...envelope, type: event.type, step: event.step, attempt: event.attempt, digest: event.digest };
    case 'run.started':
      return { ...envelope, type: event.type, attempt: event.attempt };
    case 'context.compacted':
      return { ...envelope, type: event.type, summary: event.summary, replacedThroughSeq: event.replacedThroughSeq };
    case 'context.compaction_rejected':
      return { ...envelope, type: event.type, ...(event.attempt === undefined ? {} : { attempt: event.attempt }) };
    case 'context.inherited':
      return {
        ...envelope,
        type: event.type,
        fromRunId: event.fromRunId,
        fromLastSeq: event.fromLastSeq,
        itemCount: event.history.length,
        nextItemSeq: event.nextItemSeq,
        ...(event.summary === undefined ? {} : { summaryThroughSeq: event.summary.replacedThroughSeq }),
        closures: event.closures.map(({ callId, effect, announced }) => ({ callId, effect, announced })),
        partialMessage: event.partial !== undefined,
        markers: event.markers.map(({ kind }) => ({ kind })),
        digest: event.digest,
      };
    case 'instructions.loaded':
      return { ...envelope, type: event.type, path: event.path };
    case 'skill.activated':
      return { ...envelope, type: event.type, name: event.name };
    default: {
      const { leaseToken: _leaseToken, ...visible } = event;
      return visible;
    }
  }
};
