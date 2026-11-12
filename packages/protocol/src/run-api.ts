import type { Stored } from './stored-value.ts';
import { anything, boolean, boundedInteger, closed, constant, enumOf, integer, nonNegativeInteger, nullable, root, storedEnumOf, string } from './schema-helpers.ts';
import type { JsonSchema } from './schema-helpers.ts';
import { UNKNOWN_VALUE } from './stored-value.ts';
import { CONDITION_SOURCES, CONDITION_STATES, CONDITION_WHENS, NOT_RUN_REASONS, QUIESCENT_BEHAVIOURS, REPORT_ANOMALY_CAUSES, RESIDUAL_RISK_CODES, VERIFICATION_OUTCOMES } from './completion.ts';
import { GOVERNING_ENFORCEMENT_BEHAVIORS, GOVERNING_KINDS } from './governance.ts';
import { GUIDELINE_TEXT_PATTERN } from './guideline-text.ts';
import { PLAN_LABEL_PATTERN } from './plan-account.ts';
import { HOOK_EVENTS, HOOK_OUTCOMES, HOOK_PRE_TOOL_DECISIONS } from './hooks.ts';
import { CONTEXT_CHARGE_PURPOSES, CONTRIBUTION_KINDS, SUMMARY_SECTION_COVERAGES, SUMMARY_SOURCES } from './context-record.ts';
import { CACHE_MISS_CAUSES, PREFIX_EVENTS } from './prefix-events.ts';
import type { PrefixEvent } from './prefix-events.ts';
import { BILLING_CHANGE_REASONS } from './fallback-cause.ts';
import type { FallbackCause, SpanFallbackCause } from './fallback-cause.ts';
import { TARGET_BILLINGS } from './capabilities.ts';
import { MEMORY_KINDS, MEMORY_ORIGINS, MEMORY_SCOPES, MEMORY_STATES, MEMORY_STATUSES, REFLECTION_DROP_CAUSES, REFLECTION_JOB_STATES, VALIDITY_CLOSERS } from './memory.ts';
import type { ContextChargePurpose, SummaryFidelity, SummarySource } from './context-record.ts';
import { AUTO_FIT_FAILED_BOUNDS, AUTO_FIT_MEASUREMENTS } from './auto-mode-gate.ts';
import { APPROVAL_BASES, PERMISSION_DENIAL_SOURCES } from './permission-denial.ts';
import { BUDGET_CAUSES, BUDGET_DIMENSIONS, HELD_OUTCOMES, MAX_COST_USD } from './budget.ts';
import { RECOVERY_CAUSES, RECOVERY_OUTCOMES, REPORT_PAGE_ROWS } from './reliability.ts';
import { FILE_ACCESSES } from './working-facts.ts';
import { APPROVAL_STATUSES, OPERATION_EFFECT_OUTCOMES, IMAGE_MEDIA_TYPES, INBOX_DELIVERIES, INBOX_MAX_PENDING, INBOX_STATES, JOB_STATUSES, isInheritedReference, MODEL_REJECTION_REASONS, PERMISSION_MODES, RUN_STATUSES, SIDE_EFFECTS, STOP_REASONS, TOOL_KINDS, USAGE_CHARGE_PURPOSES, USER_SHELL_COMMAND_CHARS, PROMPT_TEXT_MAX_CHARS } from './run-types.ts';
import type { ImageMediaType, InboxDelivery, InboxRowView, MessageAttachment, UserShellRecord, RunEvent, RunEventEnvelope, RunEventPayload, SessionEvent, SessionEventPayload } from './run-types.ts';
import type { ReflectionJobView } from './memory.ts';
import { UNPRICED_CODES } from './token-anatomy.ts';
import type { BilledDetail, NewBilledDetail, TokenAnatomy, UnpricedCode } from './token-anatomy.ts';

const DAY_MS = 86_400_000;
const operationEffect: JsonSchema = closed({ operation: string, target: string, outcome: enumOf(OPERATION_EFFECT_OUTCOMES) }, ['operation', 'target', 'outcome']);
const appliedDiffFields = {
  hunks: { type: 'array', items: closed({ oldStart: integer, newStart: integer, lines: { type: 'array', items: string } }, ['oldStart', 'newStart', 'lines']) },
  added: integer,
  removed: integer,
  diffOmitted: string,
} as const satisfies Record<string, JsonSchema>;
const approvalShown: JsonSchema = closed({ title: string, input: anything, effect: string, claim: string, diff: closed(appliedDiffFields, []) }, ['title', 'input']);
const toolFiles: JsonSchema = { type: 'array', items: closed({ path: string, sha256: string, access: enumOf(FILE_ACCESSES) }, ['path', 'access']) };

const permissionMode = enumOf(PERMISSION_MODES);
const storedPermissionMode = storedEnumOf(PERMISSION_MODES);
const autoClassifierView = closed(
  {
    model: string,
    key: closed({ classifier: string, codeDigest: string, datasetDigest: string }, ['classifier', 'codeDigest', 'datasetDigest']),
    measurement: enumOf(AUTO_FIT_MEASUREMENTS),
    facts: closed(
      { recordedAt: string, falseAllows: nonNegativeInteger, total: nonNegativeInteger, upperBound: { type: 'number', minimum: 0, maximum: 1 }, failedBound: enumOf(AUTO_FIT_FAILED_BOUNDS) },
      ['recordedAt', 'falseAllows', 'total', 'upperBound'],
    ),
    refusal: closed({ file: string, reason: string }, ['file', 'reason']),
  },
  ['model', 'key', 'measurement'],
);
const sessionMcpServers: JsonSchema = { type: 'object', additionalProperties: { type: 'object' } };
const historyMode = enumOf(['inherit', 'fresh']);
const storedHistoryMode = storedEnumOf(['inherit', 'fresh']);

const permissionOption = closed(
  {
    optionId: string,
    name: string,
    kind: enumOf(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
  },
  ['optionId', 'name', 'kind'],
);

const BASE64_PATTERN = '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$';

const BASE64_RULE = 'padded base64 (a length that is a multiple of 4)';

export const PATTERN_RULES: ReadonlyMap<string, string> = new Map([[BASE64_PATTERN, BASE64_RULE]]);

const imageAttachment = closed(
  { mediaType: enumOf(IMAGE_MEDIA_TYPES), data: { type: 'string', minLength: 1, pattern: BASE64_PATTERN } },
  ['mediaType', 'data'],
);

const imageSummary = closed({ mediaType: enumOf(IMAGE_MEDIA_TYPES), byteLength: nonNegativeInteger }, ['mediaType', 'byteLength']);

const PROMPT_TEXT: JsonSchema = { type: 'string', minLength: 1, maxLength: PROMPT_TEXT_MAX_CHARS };

const userShellRecord = closed({ command: string, exitCode: nullable(integer), output: string, include: boolean }, ['command', 'exitCode', 'output', 'include']);

const attachmentSummary: JsonSchema = {
  anyOf: [
    closed({ type: constant('attached_file'), path: string, lines: nonNegativeInteger }, ['type', 'path', 'lines']),
    closed({ type: constant('attachment_note'), path: string, shown: string }, ['type', 'path', 'shown']),
  ],
};

export type AttachmentSummary = { type: 'attached_file'; path: string; lines: number } | { type: 'attachment_note'; path: string; shown: string };

export const attachmentSummaryOf = (part: MessageAttachment): AttachmentSummary =>
  part.type === 'attached_file'
    ? { type: 'attached_file', path: part.path, lines: part.content === '' ? 0 : part.content.split('\n').length }
    : { type: 'attachment_note', path: part.path, shown: part.shown };

const inboxRowView = closed(
  {
    id: string,
    sessionId: string,
    delivery: storedEnumOf(INBOX_DELIVERIES),
    text: PROMPT_TEXT,
    images: { type: 'array', items: imageSummary },
    seq: { type: 'integer', minimum: 1 },
    state: storedEnumOf(INBOX_STATES),
    createdAt: integer,
    settledAt: nullable(integer),
  },
  ['id', 'sessionId', 'delivery', 'text', 'seq', 'state', 'createdAt', 'settledAt'],
);

const inboxPending: JsonSchema = { type: 'array', items: inboxRowView, maxItems: INBOX_MAX_PENDING };

const inboxChangeRow = closed({ id: string, delivery: storedEnumOf(INBOX_DELIVERIES), state: storedEnumOf(INBOX_STATES), seq: { type: 'integer', minimum: 1 } }, ['id', 'delivery', 'state', 'seq']);

export const base64ByteLength = (data: string): number => {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor(((data.length - padding) * 3) / 4);
};

export const PROMPT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

const JSON_ESCAPE_WIDTH = 6;

const PROMPT_ENVELOPE_BYTES = 64 * 1024;

const base64LengthOf = (bytes: number): number => Math.ceil(bytes / 3) * 4;

export const PROMPT_BODY_MAX_BYTES = PROMPT_TEXT_MAX_CHARS * JSON_ESCAPE_WIDTH + base64LengthOf(PROMPT_IMAGE_MAX_BYTES) + PROMPT_ENVELOPE_BYTES;

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

const heldLink = closed({ approvalId: string }, ['approvalId']);

const heldCallView = closed({ callId: string, approvalId: string, tool: string, reason: string, sinceSeq: nonNegativeInteger }, ['callId', 'approvalId', 'tool', 'reason', 'sinceSeq']);

const usage = closed({ inputTokens: nonNegativeInteger, outputTokens: nonNegativeInteger, totalTokens: nonNegativeInteger, costNano: nonNegativeInteger, unpricedCalls: nonNegativeInteger }, [
  'inputTokens',
  'outputTokens',
  'totalTokens',
]);

const conditionDeclaration = closed(
  {
    id: { type: 'string', minLength: 1 },
    command: { type: 'string', minLength: 1 },
    timeoutMs: { type: 'integer', minimum: 1 },
    when: enumOf(CONDITION_WHENS),
  },
  ['command'],
);

export const COMPLETION_DECLARATION_SCHEMA: JsonSchema = closed(
  {
    conditions: { type: 'array', items: conditionDeclaration },
    requirements: { type: 'array', items: { type: 'string', minLength: 1 } },
    inherit: boolean,
  },
  [],
);

const ruleTexts = { type: 'array', items: { type: 'string', minLength: 1 } } as const;

export const MANDATE_SCOPE_SCHEMA: JsonSchema = closed({ allow: ruleTexts, ask: ruleTexts, deny: ruleTexts }, []);

export const MANDATE_BUDGET_SCHEMA: JsonSchema = closed(
  {
    steps: boundedInteger(1, 1000),
    tokens: boundedInteger(1, 100_000_000),
    costUsd: { type: 'number', minimum: 0, maximum: MAX_COST_USD },
    timeMs: boundedInteger(1000, 7 * DAY_MS),
    retries: boundedInteger(1, 100),
  },
  [],
);

const mandate = closed(
  {
    completion: COMPLETION_DECLARATION_SCHEMA,
    profile: { type: 'string', minLength: 1 },
    scope: MANDATE_SCOPE_SCHEMA,
    budget: MANDATE_BUDGET_SCHEMA,
    hold: closed({ onQuiescent: enumOf(QUIESCENT_BEHAVIOURS) }, []),
  },
  [],
);

const pinnedCondition = closed(
  { id: string, command: string, when: enumOf(CONDITION_WHENS), source: enumOf(CONDITION_SOURCES), timeoutMs: nonNegativeInteger },
  ['id', 'command', 'when', 'source'],
);

const runReport = closed(
  {
    runId: string,
    status: enumOf(RUN_STATUSES),
    stopReason: enumOf(STOP_REASONS),
    durationMs: nonNegativeInteger,
    declaration: nullable(
      closed({ conditions: { type: 'array', items: pinnedCondition }, requirements: { type: 'array', items: string } }, ['conditions', 'requirements']),
    ),
    changes: closed(
      {
        files: { type: 'array', items: closed({ path: string, sha256: string, lastSeq: nonNegativeInteger }, ['path', 'lastSeq']) },
        mutatingCalls: nonNegativeInteger,
      },
      ['files', 'mutatingCalls'],
    ),
    conditions: {
      type: 'array',
      items: closed(
        {
          id: string,
          command: string,
          state: enumOf(CONDITION_STATES),
          rounds: nonNegativeInteger,
          last: closed(
            { seq: nonNegativeInteger, exitCode: integer, durationMs: nonNegativeInteger, mutationSeq: nonNegativeInteger, handle: string },
            ['seq', 'durationMs', 'mutationSeq'],
          ),
        },
        ['id', 'command', 'state', 'rounds'],
      ),
    },
    notRun: { type: 'array', items: closed({ what: string, reason: enumOf(NOT_RUN_REASONS) }, ['what', 'reason']) },
    residualRisk: { type: 'array', items: closed({ code: enumOf(RESIDUAL_RISK_CODES), count: nonNegativeInteger }, ['code', 'count']) },
    modelChecks: { type: 'array', items: closed({ command: string, exitCode: integer, seq: nonNegativeInteger }, ['command', 'exitCode', 'seq']) },
    budget: closed(
      {
        limits: closed({ maxSteps: nonNegativeInteger, maxTotalTokens: nonNegativeInteger, maxCostNano: nonNegativeInteger, deadlineAt: nonNegativeInteger }, ['deadlineAt']),
        spent: closed({ steps: nonNegativeInteger, totalTokens: nonNegativeInteger, costNano: nonNegativeInteger, unpricedCalls: nonNegativeInteger }, ['steps', 'totalTokens', 'costNano', 'unpricedCalls']),
        reserved: closed({ tokens: nonNegativeInteger, costNano: nonNegativeInteger }, ['tokens', 'costNano']),
      },
      ['limits', 'spent', 'reserved'],
    ),
    stoppedBy: closed({ dimension: enumOf(BUDGET_DIMENSIONS), cause: enumOf(BUDGET_CAUSES), spent: nonNegativeInteger, limit: nonNegativeInteger }, ['dimension', 'cause', 'spent', 'limit']),
    delegation: closed(
      {
        held: {
          type: 'array',
          items: closed(
            { callId: string, tool: string, reason: string, heldSeq: nonNegativeInteger, outcome: enumOf(HELD_OUTCOMES), status: enumOf(['completed', 'failed']), resolvedSeq: nonNegativeInteger },
            ['callId', 'tool', 'reason', 'heldSeq'],
          ),
        },
        denied: { type: 'array', items: closed({ callId: string, tool: string, source: enumOf(['mandate', 'held']), reason: string }, ['callId', 'tool', 'source', 'reason']) },
        quiescent: { type: 'boolean' },
      },
      ['held', 'denied', 'quiescent'],
    ),
    operations: {
      type: 'array',
      items: closed({ callId: string, operation: string, target: string, effect: enumOf(OPERATION_EFFECT_OUTCOMES) }, ['callId', 'operation', 'target', 'effect']),
    },
    failedCalls: { type: 'array', items: closed({ callId: string, tool: string, seq: nonNegativeInteger }, ['callId', 'tool', 'seq']) },
    anomalies: {
      type: 'array',
      items: closed({ seq: nonNegativeInteger, type: string, callId: string, cause: enumOf(REPORT_ANOMALY_CAUSES) }, ['seq', 'type', 'callId', 'cause']),
    },
  },
  ['runId', 'status', 'durationMs', 'declaration', 'changes', 'conditions', 'notRun', 'residualRisk', 'modelChecks'],
);

const runLimits = closed(
  {
    maxSteps: boundedInteger(1, 1000),
    maxTotalTokens: boundedInteger(1, 100_000_000),
    approvalTtlMs: boundedInteger(1000, 7 * DAY_MS),
    loopThreshold: boundedInteger(2, 20),
    maxCostUsd: { type: 'number', minimum: 0, maximum: MAX_COST_USD },
    maxFailedAttempts: boundedInteger(1, 100),
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
    status: storedEnumOf(JOB_STATUSES),
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

const summaryFidelity = closed(
  {
    fabricated: { type: 'array', items: string },
    identifiers: nonNegativeInteger,
    retained: nonNegativeInteger,
    sections: enumOf(SUMMARY_SECTION_COVERAGES),
  },
  ['fabricated', 'identifiers', 'retained', 'sections'],
);

const tokenAnatomy = closed(
  {
    estimated: { type: 'boolean', const: true },
    total: nonNegativeInteger,
    layers: closed(
      {
        system: nonNegativeInteger,
        tools: nonNegativeInteger,
        instructions: nonNegativeInteger,
        skills: nonNegativeInteger,
        governing: nonNegativeInteger,
        memories: nonNegativeInteger,
        summary: nonNegativeInteger,
        workingState: nonNegativeInteger,
        history: closed(
          { user: nonNegativeInteger, assistant: nonNegativeInteger, toolCalls: nonNegativeInteger, toolOutputs: nonNegativeInteger },
          ['user', 'assistant', 'toolCalls', 'toolOutputs'],
        ),
        notices: nonNegativeInteger,
        framing: nonNegativeInteger,
      },
      ['system', 'tools', 'instructions', 'skills', 'governing', 'memories', 'summary', 'workingState', 'history', 'notices'],
    ),
    tools: { type: 'object', additionalProperties: nonNegativeInteger },
  },
  ['estimated', 'total', 'layers', 'tools'],
);

const costUnits: JsonSchema = { type: 'string', pattern: '^[0-9]+$' };

const modelCostProperties = { amount: { type: 'number', minimum: 0 }, currency: constant('USD'), priceVersion: string };

const modelCost = closed({ ...modelCostProperties, units: costUnits }, ['amount', 'units', 'currency', 'priceVersion']);

export const MODEL_COST_SCHEMA: JsonSchema = modelCost;

const recordedModelCost = closed({ ...modelCostProperties, units: nullable(costUnits) }, ['amount', 'units', 'currency', 'priceVersion']);

const unpricedOutcome = closed({ code: enumOf(UNPRICED_CODES), reason: string }, ['code', 'reason']);

const unpricedCounts = closed(Object.fromEntries(UNPRICED_CODES.map((code) => [code, { type: 'integer', minimum: 1 }])), []);

const atMostOneOf = (keys: readonly string[]): JsonSchema => ({ not: { properties: Object.fromEntries(keys.map((key) => [key, anything])), required: keys } });

const withOnePriceOutcome = (schema: JsonSchema): JsonSchema => ({ ...schema, ...atMostOneOf(['cost', 'unpriced']) });

const callTiming = closed({ firstEventMs: nonNegativeInteger, durationMs: nonNegativeInteger }, ['durationMs']);

const billedDetailOf = (cost: JsonSchema): JsonSchema =>
  withOnePriceOutcome(
    closed({ responseId: string, cachedInputTokens: nonNegativeInteger, cacheWriteInputTokens: nonNegativeInteger, cost, unpriced: unpricedOutcome, timing: callTiming }, []),
  );

const billedDetail = billedDetailOf(recordedModelCost);

const newBilledDetail = billedDetailOf(modelCost);

const recoveryEpisodeView = closed(
  {
    ordinal: nonNegativeInteger,
    cause: storedEnumOf(RECOVERY_CAUSES),
    failedAt: integer,
    progressAt: nullable(integer),
    outcome: storedEnumOf(RECOVERY_OUTCOMES),
    startedSeq: nonNegativeInteger,
    progressSeq: nullable(nonNegativeInteger),
  },
  ['ordinal', 'cause', 'failedAt', 'progressAt', 'outcome', 'startedSeq', 'progressSeq'],
);

const runFactsBasis = closed(
  { readOnly: nonNegativeInteger, rule: nonNegativeInteger, mode: nonNegativeInteger, hook: nonNegativeInteger, classifier: nonNegativeInteger, person: nonNegativeInteger },
  ['readOnly', 'rule', 'mode', 'hook', 'classifier', 'person'],
);

const runFactsViewProperties: Record<string, JsonSchema> = {
  runId: string,
  rootRunId: string,
  sessionId: string,
  definitionsVersion: nonNegativeInteger,
  model: string,
  mode: storedPermissionMode,
  agent: string,
  origin: string,
  status: storedEnumOf(RUN_STATUSES),
  stopReason: storedEnumOf(STOP_REASONS),
  createdAt: integer,
  endedAt: integer,
  elapsedMs: integer,
  humanWaitMs: nonNegativeInteger,
  tokensTotal: nonNegativeInteger,
  costNano: nonNegativeInteger,
  steps: nonNegativeInteger,
  limits: closed({ maxSteps: nonNegativeInteger, maxTotalTokens: nonNegativeInteger, maxCostNano: nonNegativeInteger }, []),
  delegation: closed(
    {
      held: nonNegativeInteger,
      resolvedByPerson: nonNegativeInteger,
      denied: nonNegativeInteger,
      waited: boolean,
      holdLatencyMs: nonNegativeInteger,
      workDuringHolds: closed({ modelSteps: nonNegativeInteger, toolCalls: nonNegativeInteger }, ['modelSteps', 'toolCalls']),
    },
    ['held', 'resolvedByPerson', 'denied', 'waited', 'holdLatencyMs', 'workDuringHolds'],
  ),
  deadlineAt: integer,
  asked: nonNegativeInteger,
  elicited: nonNegativeInteger,
  authorizationRequired: nonNegativeInteger,
  sideEffectingCalls: nonNegativeInteger,
  repeatedStarts: nonNegativeInteger,
  reconciledAlreadyApplied: nonNegativeInteger,
  reconciledNotApplied: nonNegativeInteger,
  reconciledUnknown: nonNegativeInteger,
  basis: runFactsBasis,
  answers: closed(
    { allowOnce: nonNegativeInteger, allowAlways: nonNegativeInteger, rejectOnce: nonNegativeInteger, rejectAlways: nonNegativeInteger },
    ['allowOnce', 'allowAlways', 'rejectOnce', 'rejectAlways'],
  ),
  denials: closed(Object.fromEntries(PERMISSION_DENIAL_SOURCES.map((source) => [source, nonNegativeInteger])), [...PERMISSION_DENIAL_SOURCES]),
  declared: boolean,
  met: boolean,
  mutated: boolean,
  owed: boolean,
  verification: closed(
    { rounds: nonNegativeInteger, firstRoundPassed: nullable(boolean), failedRounds: nonNegativeInteger, checkMs: nonNegativeInteger, fixRoundTokens: nonNegativeInteger },
    ['rounds', 'firstRoundPassed', 'failedRounds', 'checkMs', 'fixRoundTokens'],
  ),
  recoveries: { type: 'array', items: recoveryEpisodeView },
};

const runFactsView = closed(
  runFactsViewProperties,
  Object.keys(runFactsViewProperties).filter((key) => key !== 'stopReason' && key !== 'deadlineAt' && key !== 'delegation'),
);

type PublicPayloadKeys<Type> = Extract<PublicPayload | SessionEventPayload, { type: Type }> extends infer Payload ? (Payload extends unknown ? Exclude<keyof Payload, 'type'> : never) : never;

type EnvelopeKey = keyof PublicRunEnvelope;

type PayloadSchema<Type> = {
  properties: { [Key in Exclude<PublicPayloadKeys<Type>, EnvelopeKey>]: JsonSchema } & { [Key in Extract<PublicPayloadKeys<Type>, EnvelopeKey>]?: JsonSchema };
  required: readonly PublicPayloadKeys<Type>[];
  exclusive?: readonly PublicPayloadKeys<Type>[];
};

const PAYLOAD_SCHEMAS: { [Type in RunEventPayload['type'] | SessionEvent['type']]: PayloadSchema<Type> } = {
  'user.message': {
    properties: { text: string, images: { type: 'array', items: imageSummary }, source: enumOf(INBOX_DELIVERIES), attachments: { type: 'array', items: attachmentSummary }, shell: { type: 'array', items: userShellRecord } },
    required: ['text'],
  },
  'run.started': { properties: { attempt: integer }, required: ['attempt'] },
  'attempt.failed': { properties: { attempt: integer, code: string, retryAt: integer, limit: integer }, required: ['attempt', 'code', 'retryAt', 'limit'] },
  'attempt.lost': { properties: { lastLiveAt: integer }, required: ['lastLiveAt'] },
  'run.status': {
    properties: { from: enumOf(RUN_STATUSES), to: enumOf(RUN_STATUSES), reason: string },
    required: ['from', 'to'],
  },
  'model.requested': {
    properties: {
      step: nonNegativeInteger,
      attempt: integer,
      digest: string,
      anatomy: tokenAnatomy,
      prefix: closed(
        { preservedItems: nonNegativeInteger, toolsChanged: boolean, causes: { type: 'array', items: enumOf(PREFIX_EVENTS) } },
        ['preservedItems', 'toolsChanged', 'causes'],
      ),
    },
    required: ['step', 'attempt', 'digest'],
  },
  'model.responded': {
    properties: {
      step: nonNegativeInteger,
      attempt: integer,
      response: closed(
        {
          id: string,
          status: enumOf(['completed', 'incomplete']),
          incompleteReason: string,
          output: { type: 'array' },
          usage: closed(
            {
              input_tokens: nonNegativeInteger,
              output_tokens: nonNegativeInteger,
              total_tokens: nonNegativeInteger,
              input_tokens_details: closed({ cached_tokens: nonNegativeInteger }, ['cached_tokens']),
              output_tokens_details: closed({ reasoning_tokens: nonNegativeInteger }, ['reasoning_tokens']),
            },
            ['input_tokens', 'output_tokens', 'total_tokens'],
          ),
          momonga: withOnePriceOutcome(closed({ cacheWriteInputTokens: nonNegativeInteger, cacheReadNotReported: { type: 'boolean', const: true }, cost: recordedModelCost, unpriced: unpricedOutcome, retryOf: nonNegativeInteger }, [])),
          timing: callTiming,
        },
        ['status', 'output', 'usage'],
      ),
      target: string,
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
    properties: { step: nonNegativeInteger, attempt: integer, itemIds: { type: 'array', items: string } },
    required: ['step', 'attempt', 'itemIds'],
  },
  'tool.call': {
    properties: {
      callId: string,
      providerCallId: string,
      name: string,
      kind: enumOf(TOOL_KINDS),
      sideEffect: enumOf(SIDE_EFFECTS),
      title: string,
      rawInput: anything,
      locations: { type: 'array', items: location },
    },
    required: ['callId', 'providerCallId', 'name', 'kind', 'title', 'rawInput'],
  },
  'tool.permission.requested': {
    properties: { approvalId: string, callId: string, options: { type: 'array', items: permissionOption }, subjectDigest: string, reason: string, suggestedRule: string, shown: approvalShown },
    required: ['approvalId', 'callId', 'options', 'subjectDigest', 'reason', 'shown'],
  },
  'tool.permission.classified': {
    properties: {
      callId: string,
      subjectDigest: string,
      model: string,
      outcome: enumOf(['allow', 'ask']),
      verdict: enumOf(['safe', 'unsafe']),
      confidence: enumOf(['high', 'medium', 'low']),
      rationale: string,
      failure: string,
    },
    required: ['callId', 'subjectDigest', 'outcome'],
  },
  'tool.permission.classifying': { properties: { callId: string, subjectDigest: string }, required: ['callId', 'subjectDigest'] },
  'hook.started': { properties: { event: enumOf(HOOK_EVENTS), command: string, callId: string }, required: ['event', 'command'] },
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
  'tool.unknown.requested': {
    properties: { approvalId: string, callIds: { type: 'array', items: string }, options: { type: 'array', items: permissionOption }, subjectDigest: string },
    required: ['approvalId', 'callIds', 'options', 'subjectDigest'],
  },
  'tool.unknown.resolved': {
    properties: { approvalId: string, optionId: string },
    required: ['approvalId', 'optionId'],
  },
  'tool.unknown.cancelled': {
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
  'tool.started': { properties: { callId: string, idemKey: string, basis: enumOf(APPROVAL_BASES) }, required: ['callId', 'idemKey'] },
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
      files: toolFiles,
      mutated: { type: 'boolean', const: true },
      command: string,
      windowShared: { type: 'boolean', const: true },
      memories: { type: 'array', items: string },
      exitCode: integer,
      formatted: closed({ formatter: string, version: integer }, ['formatter', 'version']),
      ...appliedDiffFields,
      effect: operationEffect,
      held: heldLink,
    },
    required: ['callId', 'status', 'output'],
  },
  'verification.started': {
    properties: { round: nonNegativeInteger, conditionId: string, command: string, mutationSeq: nonNegativeInteger, attempt: integer },
    required: ['round', 'conditionId', 'command', 'mutationSeq', 'attempt'],
  },
  'verification.completed': {
    properties: {
      round: nonNegativeInteger,
      conditionId: string,
      command: string,
      outcome: enumOf(VERIFICATION_OUTCOMES),
      exitCode: integer,
      durationMs: nonNegativeInteger,
      output: string,
      truncated: boolean,
      handle: string,
      mutationSeq: nonNegativeInteger,
    },
    required: ['round', 'conditionId', 'command', 'outcome', 'durationMs', 'output', 'mutationSeq'],
  },
  'tool.loaded': { properties: { names: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } } }, required: ['names'] },
  'tool.offered': { properties: { names: { type: 'array', items: { type: 'string', minLength: 1 } } }, required: ['names'] },
  'loop.warned': { properties: { signature: string }, required: ['signature'] },
  'budget.exhausted': {
    properties: { dimension: enumOf(BUDGET_DIMENSIONS), cause: enumOf(BUDGET_CAUSES), spent: nonNegativeInteger, limit: nonNegativeInteger, admitsAt: nonNegativeInteger },
    required: ['dimension', 'cause', 'spent', 'limit'],
  },
  'tool.held': {
    properties: { callId: string, approvalId: string, reason: string, footprint: closed({ reads: { type: 'array', items: string }, writes: { type: 'array', items: string } }, ['reads', 'writes']) },
    required: ['callId', 'approvalId', 'reason', 'footprint'],
  },
  'tool.held.resolved': {
    properties: { callId: string, approvalId: string, outcome: enumOf(HELD_OUTCOMES), status: enumOf(['completed', 'failed']), output: string },
    required: ['callId', 'approvalId', 'outcome', 'status', 'output'],
  },
  'run.quiescent': { properties: { held: { type: 'array', items: heldCallView }, onQuiescent: enumOf(QUIESCENT_BEHAVIOURS) }, required: ['held'] },
  'model.rejected': {
    properties: { step: nonNegativeInteger, attempt: nonNegativeInteger, reason: enumOf(MODEL_REJECTION_REASONS), counter: string, meterCounter: string, target: string },
    required: ['step', 'attempt', 'reason'],
  },
  'meter.observed': {
    properties: {
      target: string,
      counter: string,
      fallback: boolean,
      inputDigest: string,
      itemCount: nonNegativeInteger,
      counted: nonNegativeInteger,
      reported: nonNegativeInteger,
      kept: nonNegativeInteger,
      known: nonNegativeInteger,
      uncounted: nonNegativeInteger,
      miss: nonNegativeInteger,
      contextWindow: nonNegativeInteger,
      tokenErrorRatio: { type: 'number', minimum: 0 },
      tokenCounting: enumOf(['exact', 'calibrated', 'estimated']),
    },
    required: ['target', 'counter', 'fallback', 'inputDigest', 'itemCount', 'counted', 'reported', 'kept', 'known', 'uncounted', 'miss', 'contextWindow', 'tokenCounting'],
  },
  'tool.reconciled': {
    properties: { callId: string, outcome: enumOf(['already_applied', 'not_applied', 'unknown']), output: string, interrupted: enumOf(['timeout', 'cancelled']), files: toolFiles, command: string, effect: operationEffect, held: heldLink, ...appliedDiffFields },
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
  'mode.changed': { properties: { mode: storedPermissionMode }, required: ['mode'] },
  'model.changed': { properties: { model: { type: 'string', minLength: 1 }, previousModel: { type: 'string', minLength: 1 } }, required: ['model', 'previousModel'] },
  'inbox.changed': { properties: { pending: { type: 'array', items: inboxChangeRow, maxItems: INBOX_MAX_PENDING } }, required: ['pending'] },
  user_shell: { properties: { command: string, exitCode: nullable(integer), output: string, include: boolean }, required: ['command', 'exitCode', 'output', 'include'] },
  'usage.updated': {
    properties: { inputTokens: nonNegativeInteger, outputTokens: nonNegativeInteger, totalTokens: nonNegativeInteger },
    required: ['inputTokens', 'outputTokens', 'totalTokens'],
  },
  'usage.charged': {
    properties: {
      purpose: enumOf(USAGE_CHARGE_PURPOSES),
      inputTokens: nonNegativeInteger,
      outputTokens: nonNegativeInteger,
      totalTokens: nonNegativeInteger,
      responseId: string,
      cachedInputTokens: nonNegativeInteger,
      cacheWriteInputTokens: nonNegativeInteger,
      cost: recordedModelCost,
      unpriced: unpricedOutcome,
      timing: callTiming,
      target: string,
    },
    required: ['purpose', 'inputTokens', 'outputTokens', 'totalTokens'],
    exclusive: ['cost', 'unpriced'],
  },
  'context.compacted': {
    properties: {
      summary: string,
      replacedThroughSeq: nonNegativeInteger,
      source: enumOf(SUMMARY_SOURCES),
      fidelity: summaryFidelity,
      guidelineVersion: nonNegativeInteger,
      tokensBefore: nonNegativeInteger,
      tokensAfter: nonNegativeInteger,
      tokensAfterEstimated: { type: 'boolean', const: true },
    },
    required: ['summary', 'replacedThroughSeq'],
  },
  'context.inherited_compacted': {
    properties: {
      fromRunId: string,
      summary: string,
      replacedThroughSeq: nonNegativeInteger,
      tokensBefore: nonNegativeInteger,
      tokensAfter: nonNegativeInteger,
      tokensAfterEstimated: { type: 'boolean', const: true },
    },
    required: ['fromRunId', 'summary', 'replacedThroughSeq'],
  },
  'context.governing_loaded': {
    properties: {
      active: { type: 'array', items: closed({ id: string, textSha256: string }, ['id', 'textSha256']) },
      conflicts: { type: 'array', items: closed({ target: string, ids: { type: 'array', items: string } }, ['target', 'ids']) },
    },
    required: ['active', 'conflicts'],
  },
  'context.memories_loaded': {
    properties: { memories: { type: 'array', items: closed({ id: string, status: enumOf(MEMORY_STATUSES) }, ['id', 'status']) } },
    required: ['memories'],
  },
  'context.contribution': {
    properties: {
      items: { type: 'array', items: closed({ kind: enumOf(CONTRIBUTION_KINDS), id: string, contributed: boolean }, ['kind', 'id', 'contributed']) },
    },
    required: ['items'],
  },
  'context.compacting': { properties: { step: nonNegativeInteger, attempt: integer }, required: ['attempt'] },
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
    properties: { callId: string, handle: string, kind: enumOf(['omitted', 'truncated', 'reference']), keptChars: nonNegativeInteger, tokens: nonNegativeInteger },
    required: ['callId', 'handle', 'kind'],
  },
  'instructions.loaded': { properties: { path: string }, required: ['path'] },
  'skill.activated': { properties: { name: string }, required: ['name'] },
  'approval.rule.persisted': {
    properties: { approvalId: string, effect: enumOf(['allow', 'deny']), rule: string },
    required: ['approvalId', 'effect', 'rule'],
  },
  'user.compact': { properties: { instructions: string }, required: [] },
  notice: {
    properties: {
      level: enumOf(['info', 'warning', 'error']),
      message: string,
      code: string,
      toolKey: string,
      key: string,
      reduction: closed({ turn: nonNegativeInteger, from: nonNegativeInteger, to: nonNegativeInteger }, ['turn', 'from', 'to']),
    },
    required: ['level', 'message'],
  },
};

const publicEventVariant = (type: keyof typeof PAYLOAD_SCHEMAS): JsonSchema => {
  const schema: PayloadSchema<typeof type> = PAYLOAD_SCHEMAS[type];
  const { properties, required } = schema;
  const exclusive = schema.exclusive === undefined ? {} : atMostOneOf(schema.exclusive);
  if (type === 'mode.changed' || type === 'model.changed' || type === 'inbox.changed' || type === 'user_shell') {
    return closed(
      { id: integer, sessionId: string, createdAt: integer, type: constant(type), ...properties },
      ['id', 'sessionId', 'createdAt', 'type', ...required],
    );
  }
  return {
    ...closed(
      { id: integer, runId: string, sessionId: string, seq: integer, step: nonNegativeInteger, createdAt: integer, type: constant(type), ...properties },
      ['id', 'runId', 'sessionId', 'seq', 'createdAt', 'type', ...required],
    ),
    ...exclusive,
  };
};

export const EVENT_TYPES = Object.keys(PAYLOAD_SCHEMAS) as (keyof typeof PAYLOAD_SCHEMAS)[];

const publicOpaqueVariant = (): JsonSchema =>
  closed(
    {
      opaque: { const: true },
      id: integer,
      runId: string,
      sessionId: string,
      seq: integer,
      step: nonNegativeInteger,
      createdAt: integer,
      type: { type: 'string', not: { enum: EVENT_TYPES } },
      payload: { type: 'object' },
    },
    ['opaque', 'id', 'sessionId', 'createdAt', 'type', 'payload'],
  );

const trustView = closed(
  { path: string, decision: { anyOf: [storedEnumOf(['trusted', 'untrusted']), { type: 'null' }] }, inheritedFrom: string },
  ['path', 'decision'],
);

const trustItemChange: JsonSchema = { anyOf: [closed({ kind: constant('new') }, ['kind']), closed({ kind: constant('changed'), diff: closed(appliedDiffFields, []) }, ['kind', 'diff']), closed({ kind: constant('not-recorded') }, ['kind'])] };
const trustItemsView = closed(
  {
    items: {
      type: 'array',
      items: {
        anyOf: [
          closed({ kind: constant('hook'), event: string, group: anything, digest: string, source: string, change: trustItemChange }, ['kind', 'event', 'group', 'digest', 'source', 'change']),
          closed({ kind: constant('mandate'), document: anything, digest: string, source: string, change: trustItemChange }, ['kind', 'document', 'digest', 'source', 'change']),
          closed({ kind: constant('mcp'), name: string, config: anything, digest: string, source: string, change: trustItemChange }, ['kind', 'name', 'config', 'digest', 'source', 'change']),
          closed({ kind: constant('agent'), name: string, text: string, digest: string, source: string, change: trustItemChange }, ['kind', 'name', 'text', 'digest', 'source', 'change']),
        ],
      },
    },
    refused: { type: 'array', items: string },
  },
  ['items', 'refused'],
);

const costTotalsProperties: Record<string, JsonSchema> = {
  calls: nonNegativeInteger,
  localCalls: nonNegativeInteger,
  unpricedCalls: nonNegativeInteger,
  unknownBillingCalls: nonNegativeInteger,
  cacheReadNotReportedCalls: nonNegativeInteger,
  cacheReadUnpricedCalls: nonNegativeInteger,
  planCalls: nonNegativeInteger,
  planInputTokens: nonNegativeInteger,
  planOutputTokens: nonNegativeInteger,
  inputTokens: nonNegativeInteger,
  outputTokens: nonNegativeInteger,
  cachedInputTokens: nullable(nonNegativeInteger),
  amount: nullable({ type: 'number', minimum: 0 }),
  currency: constant('USD'),
  priceVersions: { type: 'array', items: string },
  unpriced: unpricedCounts,
  priceNotRecordedCalls: nonNegativeInteger,
  legacyPrecisionCalls: nonNegativeInteger,
};
const roleCostRequired = Object.keys(costTotalsProperties);
const costTotalsRequired = [...roleCostRequired, 'roles'];

const runTracePrefix = closed(
  { preservedItems: nonNegativeInteger, toolsChanged: boolean, causes: { type: 'array', items: enumOf(PREFIX_EVENTS) } },
  ['preservedItems', 'toolsChanged', 'causes'],
);

const fallbackCauseBase = { target: string, name: string, code: nullable(string), message: string };

const fallbackCauseSchema: JsonSchema = {
  oneOf: [
    closed({ ...fallbackCauseBase, fromBilling: enumOf(TARGET_BILLINGS), toBilling: enumOf(TARGET_BILLINGS), reason: enumOf(BILLING_CHANGE_REASONS) }, ['target', 'code', 'message', 'fromBilling', 'toBilling', 'reason']),
    closed(fallbackCauseBase, ['target', 'code', 'message']),
  ],
};

const costFallbackProperties: Record<string, JsonSchema> = {
  fallbackCalls: nonNegativeInteger,
  fallbacks: {
    type: 'array',
    items: closed(
      { answeredBy: string, calls: nonNegativeInteger, failed: { type: 'array', items: fallbackCauseSchema } },
      ['answeredBy', 'calls', 'failed'],
    ),
  },
};

const roleCostSchemaProperties: Record<string, JsonSchema> = { ...costTotalsProperties, ...costFallbackProperties };

const costTotalsSchemaProperties: Record<string, JsonSchema> = {
  ...roleCostSchemaProperties,
  roles: { type: 'object', additionalProperties: closed(roleCostSchemaProperties, roleCostRequired) },
};

const contextChargeView = closed(
  {
    id: integer,
    purpose: storedEnumOf(CONTEXT_CHARGE_PURPOSES),
    runId: nullable(string),
    project: string,
    model: string,
    inputTokens: nonNegativeInteger,
    outputTokens: nonNegativeInteger,
    totalTokens: nonNegativeInteger,
    createdAt: integer,
    detail: billedDetail,
  },
  ['id', 'purpose', 'runId', 'project', 'model', 'inputTokens', 'outputTokens', 'totalTokens', 'createdAt'],
);

const guidelineView = closed(
  {
    version: { type: 'integer', minimum: 1 },
    text: string,
    parent: nullable({ type: 'integer', minimum: 1 }),
    createdAt: integer,
    adoptedAt: integer,
    report: { type: 'object' },
  },
  ['version', 'text', 'parent', 'createdAt', 'adoptedAt', 'report'],
);

const costReportView = closed(
  {
    runs: { type: 'array', items: closed({ runId: string, sessionId: string, ...costTotalsSchemaProperties }, ['runId', 'sessionId', ...costTotalsRequired]) },
    sessions: {
      type: 'array',
      items: closed({ sessionId: string, runIds: { type: 'array', items: string }, ...costTotalsSchemaProperties }, ['sessionId', 'runIds', ...costTotalsRequired]),
    },
    total: closed(costTotalsSchemaProperties, costTotalsRequired),
    contextCharges: closed({ charges: { type: 'array', items: contextChargeView }, totalTokens: nonNegativeInteger }, ['charges', 'totalTokens']),
  },
  ['runs', 'sessions', 'total', 'contextCharges'],
);

const numberMap: JsonSchema = { type: 'object', additionalProperties: { type: 'number' } };

const timingSummary = nullable(
  closed({ median: { type: 'number' }, p95: { type: 'number' }, n: nonNegativeInteger }, ['median', 'p95', 'n']),
);

const causeCounts = closed(
  Object.fromEntries(CACHE_MISS_CAUSES.map((cause) => [cause, nonNegativeInteger])),
  [],
);

const costBreakdownView = closed(
  {
    calls: nonNegativeInteger,
    layers: closed(
      { estimated: { type: 'boolean', const: true }, shares: numberMap, tokens: numberMap, callsWithoutAnatomy: nonNegativeInteger },
      ['estimated', 'shares', 'tokens', 'callsWithoutAnatomy'],
    ),
    billed: closed(
      {
        inputTokens: nonNegativeInteger,
        reportedInputTokens: nullable(nonNegativeInteger),
        uncachedInputTokens: nullable(nonNegativeInteger),
        cacheReadTokens: nullable(nonNegativeInteger),
        cacheWriteTokens: nullable(nonNegativeInteger),
        outputTokens: nonNegativeInteger,
        reasoningTokens: nonNegativeInteger,
      },
      ['inputTokens', 'reportedInputTokens', 'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens'],
    ),
    cacheHitRatio: nullable({ type: 'number' }),
    cacheBreaks: causeCounts,
    cacheMissCauses: causeCounts,
    timeToFirstToken: timingSummary,
    duration: timingSummary,
    roles: {
      type: 'object',
      additionalProperties: closed(
        { calls: nonNegativeInteger, timeToFirstToken: timingSummary, duration: timingSummary, totalDurationMs: nullable(nonNegativeInteger), timingNotRecorded: nonNegativeInteger },
        ['calls', 'timeToFirstToken', 'duration', 'totalDurationMs', 'timingNotRecorded'],
      ),
    },
    cost: closed(
      { amount: nullable({ type: 'number' }), currency: constant('USD'), unpricedCalls: nonNegativeInteger, unpriced: unpricedCounts, priceNotRecordedCalls: nonNegativeInteger, legacyPrecisionCalls: nonNegativeInteger, priceVersions: { type: 'array', items: string } },
      ['amount', 'currency', 'unpricedCalls', 'unpriced', 'priceNotRecordedCalls', 'legacyPrecisionCalls', 'priceVersions'],
    ),
    plan: closed({ calls: nonNegativeInteger, inputTokens: nonNegativeInteger, outputTokens: nonNegativeInteger }, ['calls', 'inputTokens', 'outputTokens']),
    unpriced: {
      type: 'array',
      items: closed({ runId: string, provider: string, model: string, step: nonNegativeInteger, code: enumOf(UNPRICED_CODES), reason: string }, ['runId', 'provider', 'model', 'code', 'reason']),
    },
    inconsistentUsage: {
      type: 'array',
      items: closed({ runId: string, provider: string, model: string, step: nonNegativeInteger, reason: string }, ['runId', 'provider', 'model', 'reason']),
    },
    cacheReadNotReported: nonNegativeInteger,
    callsWithoutResponseId: nonNegativeInteger,
    unjoined: { type: 'array', items: closed({ runId: string, step: nonNegativeInteger, reason: string }, ['runId', 'reason']) },
  },
  ['calls', 'layers', 'billed', 'cacheHitRatio', 'cacheBreaks', 'cacheMissCauses', 'timeToFirstToken', 'duration', 'roles', 'cost', 'plan', 'unpriced', 'inconsistentUsage', 'cacheReadNotReported', 'callsWithoutResponseId', 'unjoined'],
);

const memoryScope = enumOf(MEMORY_SCOPES);

const unknownKind = closed({ kind: constant(UNKNOWN_VALUE) }, ['kind']);

const memorySource: JsonSchema = {
  oneOf: [
    closed(
      { kind: constant('tool'), sessionId: string, runId: string, step: nonNegativeInteger, callId: string, seq: nonNegativeInteger },
      ['kind', 'sessionId', 'runId', 'step', 'callId', 'seq'],
    ),
    closed({ kind: constant('reflection'), sessionId: string, runId: string, ordinal: nonNegativeInteger }, ['kind', 'sessionId', 'runId', 'ordinal']),
    closed({ kind: constant('command'), at: integer }, ['kind', 'at']),
    unknownKind,
  ],
};

const memoryEvidence: JsonSchema = {
  oneOf: [
    closed({ kind: constant('file'), project: string, path: string, sha256: string }, ['kind', 'project', 'path', 'sha256']),
    closed({ kind: constant('commit'), sha: string }, ['kind', 'sha']),
    closed(
      {
        kind: constant('check'),
        runId: string,
        conditionId: string,
        seq: nonNegativeInteger,
        command: string,
        exitCode: integer,
      },
      ['kind', 'runId', 'conditionId', 'seq', 'command', 'exitCode'],
    ),
    closed(
      {
        kind: constant('check'),
        runId: string,
        modelCallId: string,
        seq: nonNegativeInteger,
        command: string,
        exitCode: integer,
      },
      ['kind', 'runId', 'modelCallId', 'seq', 'command', 'exitCode'],
    ),
    unknownKind,
  ],
};

const governingEnforcement = closed({ behavior: enumOf(GOVERNING_ENFORCEMENT_BEHAVIORS), rule: { type: 'string', minLength: 1 } }, ['behavior', 'rule']);

const governingScopes = [
  closed({ level: constant('user') }, ['level']),
  closed({ level: constant('project'), project: { type: 'string', minLength: 1 }, paths: { type: 'array', items: { type: 'string', minLength: 1 } } }, ['level', 'project', 'paths']),
];

const governingScope: JsonSchema = { oneOf: governingScopes };

const storedGoverningScope: JsonSchema = { oneOf: [...governingScopes, closed({ level: constant(UNKNOWN_VALUE) }, ['level'])] };

const storedGoverningEnforcement = closed({ behavior: storedEnumOf(GOVERNING_ENFORCEMENT_BEHAVIORS), rule: { type: 'string', minLength: 1 } }, ['behavior', 'rule']);

const governingFactView = closed(
  {
    id: string,
    kind: storedEnumOf(GOVERNING_KINDS),
    target: string,
    text: string,
    scope: storedGoverningScope,
    validFrom: integer,
    validUntil: nullable(integer),
    retiredAt: nullable(integer),
    supersedes: { type: 'array', items: string },
    enforcement: nullable(storedGoverningEnforcement),
    source: {
      oneOf: [
        closed({ kind: constant('command'), at: integer }, ['kind', 'at']),
        closed({ kind: constant('proposal'), sessionId: string, runId: string, seq: nonNegativeInteger, callId: string }, ['kind', 'sessionId', 'runId', 'seq', 'callId']),
        unknownKind,
      ],
    },
  },
  ['id', 'kind', 'target', 'text', 'scope', 'validFrom', 'validUntil', 'retiredAt', 'supersedes', 'enforcement', 'source'],
);

const ruleSize = closed(
  { target: string, contextWindow: nonNegativeInteger, tokens: nonNegativeInteger, percent: { type: 'number', minimum: 0 } },
  ['target', 'contextWindow', 'tokens', 'percent'],
);

const memoryValidity = closed(
  {
    intervals: {
      type: 'array',
      items: closed(
        { status: storedEnumOf(MEMORY_STATUSES), from: integer, to: nullable(integer), closedBy: nullable(enumOf(VALIDITY_CLOSERS)) },
        ['status', 'from', 'to', 'closedBy'],
      ),
    },
    changes: {
      type: 'array',
      items: closed(
        { from: storedEnumOf(MEMORY_STATUSES), to: storedEnumOf(MEMORY_STATUSES), changedBetween: { type: 'array', items: integer, minItems: 2, maxItems: 2 } },
        ['from', 'to', 'changedBetween'],
      ),
    },
  },
  ['intervals', 'changes'],
);

const memoryView = closed(
  {
    id: string,
    scope: storedEnumOf(MEMORY_SCOPES),
    origin: storedEnumOf(MEMORY_ORIGINS),
    project: nullable(string),
    text: string,
    source: memorySource,
    createdAt: integer,
    keptAt: integer,
    kind: storedEnumOf(MEMORY_KINDS),
    state: storedEnumOf(MEMORY_STATES),
    duplicateOf: nullable(string),
    supersedes: { type: 'array', items: string },
    supersededBy: { type: 'array', items: string },
    retiredAt: nullable(integer),
    evidence: { type: 'array', items: memoryEvidence },
    status: enumOf(MEMORY_STATUSES),
    contributedAt: nullable(integer),
    observedStatus: nullable(storedEnumOf(MEMORY_STATUSES)),
    validity: memoryValidity,
  },
  [
    'id',
    'scope',
    'origin',
    'project',
    'text',
    'source',
    'createdAt',
    'keptAt',
    'kind',
    'state',
    'duplicateOf',
    'supersedes',
    'supersededBy',
    'retiredAt',
    'evidence',
    'status',
    'contributedAt',
  ],
);

const reflectionJobView = closed(
  {
    runId: string,
    state: storedEnumOf(REFLECTION_JOB_STATES),
    attempts: nonNegativeInteger,
    reason: nullable(string),
    dropped: {
      type: 'array',
      items: closed(
        { ordinal: nonNegativeInteger, text: nullable(string), cause: enumOf(REFLECTION_DROP_CAUSES), reason: string },
        ['ordinal', 'text', 'cause', 'reason'],
      ),
    },
    updatedAt: integer,
  },
  ['runId', 'state', 'attempts', 'reason', 'dropped', 'updatedAt'],
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
  sideCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number | null;
  cacheReadNotReportedCalls: number;
  errorCount: number;
  durationMs: number;
  chatResults: { step: number; attempt: number; finishReasons: string[] }[];
};

export type RunTracePrefix = { preservedItems: number; toolsChanged: boolean; causes: PrefixEvent[] };

export type RunTraceCall = { step: number; attempt: number; anatomy?: TokenAnatomy; prefix?: RunTracePrefix };

export type RunTraceEvent = { step: number; type: 'tool.loaded'; names: string[] } | { step: number; type: 'loop.warned'; signature: string };

export type RunTraceView = { runId: string; summary: RunTraceSummary; spans: RunTraceSpan[]; calls?: RunTraceCall[]; events?: RunTraceEvent[] };

export const MCP_AUTH_STATES = ['not_applicable', 'static_header', 'not_required', 'authorized', 'required', 'refused', 'unreachable'] as const;

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
  approval?: { digest: string; changed: boolean };
  stderrTail?: string;
  exit?: { code: number | null; signal: string | null };
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
export type CostFallbackView = { answeredBy: string; calls: number; failed: SpanFallbackCause[] };

export type RoleCostView = {
  fallbackCalls?: number;
  fallbacks?: CostFallbackView[];
  calls: number;
  localCalls: number;
  unpricedCalls: number;
  unknownBillingCalls: number;
  cacheReadNotReportedCalls: number;
  cacheReadUnpricedCalls: number;
  planCalls: number;
  planInputTokens: number;
  planOutputTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number | null;
  amount: number | null;
  currency: 'USD';
  priceVersions: string[];
  unpriced: Partial<Record<UnpricedCode, number>>;
  priceNotRecordedCalls: number;
  legacyPrecisionCalls: number;
};

export type CostTotalsView = RoleCostView & { roles: Record<string, RoleCostView> };

export type GatewayCostReportView = {
  runs: (CostTotalsView & { runId: string; sessionId: string })[];
  sessions: (CostTotalsView & { sessionId: string; runIds: string[] })[];
  total: CostTotalsView;
};

export type ContextChargeView = {
  id: number;
  purpose: Stored<ContextChargePurpose>;
  runId: string | null;
  project: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  createdAt: number;
  detail?: BilledDetail;
};

export type AnsweredByView = { target: string; adapter?: string; upstreamModel?: string; answers: 'model' | 'script' | 'unknown' };
export const MODEL_KINDS = ['fake', 'real', 'unknown'] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

export const modelKindOf = (answeredBy: readonly AnsweredByView[], unrecordedAnswers: number): ModelKind => {
  if (answeredBy.some((answerer) => answerer.answers === 'script')) return 'fake';
  if (unrecordedAnswers > 0 || answeredBy.length === 0 || answeredBy.some((answerer) => answerer.answers === 'unknown')) return 'unknown';
  return 'real';
};

export type RunAnsweredByView = { answeredBy: AnsweredByView[] };
export type RunReflectionView = { job: ReflectionJobView | null; charges: ContextChargeView[]; queuedAhead: number };

export type ContextChargesView = { charges: ContextChargeView[]; totalTokens: number };

export type RecordContextChargeRequest = {
  purpose: 'guideline';
  project: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  detail?: NewBilledDetail;
};

export type ContextChargeResponse = { charge: ContextChargeView };

export type GuidelineView = {
  version: number;
  text: string;
  parent: number | null;
  createdAt: number;
  adoptedAt: number;
  report: Record<string, unknown>;
};

export type GuidelinesResponse = { current: GuidelineView | null; guidelines: GuidelineView[] };

export type GuidelineResponse = { guideline: GuidelineView };

export type AdoptGuidelineRequest = { text: string; parent: number | null; report: Record<string, unknown> };

export type CostReportView = GatewayCostReportView & { contextCharges: ContextChargesView };

export type RunHealth = {
  status: 'ok';
  version: string;
  apiVersion: 1;
  pid: number;
  startedAt: string;
  state: 'running' | 'retiring' | 'draining';
  role: 'starting' | 'serving' | 'retiring';
  steps: number;
  jobs: number;
  sandbox: 'seatbelt' | 'bubblewrap' | 'none';
};

export const DAEMON_CURRENT_EVENT = 'daemon.current';

export type DaemonCurrentFrame = { generation: number; version: string };

export const STREAM_FAILED_EVENT = 'stream.failed';

export type StreamFailedFrame = { code: string; message: string };

const planLabel: JsonSchema = { type: 'string', pattern: PLAN_LABEL_PATTERN };

const planAccountRef = closed({ profile: planLabel, account: planLabel }, ['profile']);

const runView = closed(
  {
    id: string,
    sessionId: string,
    ordinal: integer,
    status: storedEnumOf(RUN_STATUSES),
    stopReason: storedEnumOf(STOP_REASONS),
    error: closed({ code: string, message: string, plan: planAccountRef }, ['code', 'message']),
    usage,
    step: nonNegativeInteger,
    limits: runLimits,
    createdAt: integer,
    deadlineAt: integer,
    cancelRequested: boolean,
    lastSeq: nonNegativeInteger,
    previousRunId: nullable(string),
    history: storedHistoryMode,
    parentRunId: nullable(string),
    parentCallId: nullable(string),
    origin: storedEnumOf(MEMORY_ORIGINS),
    agent: string,
    report: runReport,
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
    'origin',
  ],
);

export const INBOX_WITHDRAW_OUTCOMES = ['withdrawn', 'already_delivered'] as const;

export type InboxWithdrawOutcome = (typeof INBOX_WITHDRAW_OUTCOMES)[number];

export type InboxResponse = { pending: InboxRowView[] };

export type UserShellRequest = { command: string; include: boolean };

export type CompactSessionRequest = { instructions?: string };

export type UserShellPendingResponse = { pending: UserShellRecord[] };

export type UserShellFrame = { type: 'unprotected'; reason: string } | { type: 'output'; text: string } | { type: 'refused'; reason: string } | { type: 'exit'; record: UserShellRecord };

export type InboxAddResponse = { row: InboxRowView; pending: InboxRowView[] };

export type InboxWithdrawResponse = { outcome: InboxWithdrawOutcome; row: InboxRowView; pending: InboxRowView[] };

export const SESSION_SANDBOX_NETWORKS = ['deny', 'ask', 'allow'] as const;

export const RUN_API_SCHEMAS = {
  CreateSessionRequest: root(
    closed(
      {
        cwd: { type: 'string', minLength: 1 },
        env: { type: 'object', additionalProperties: string },
        permissionMode,
        model: { type: 'string', minLength: 1 },
        bypassAllowed: boolean,
        sandboxNetwork: enumOf(SESSION_SANDBOX_NETWORKS),
        mcpServers: sessionMcpServers,
        terminalUi: boolean,
      },
      ['cwd', 'env'],
    ),
  ),
  PatchSessionRequest: root({ ...closed({ permissionMode, model: { type: 'string', minLength: 1 }, mcpServers: sessionMcpServers }, []), minProperties: 1 }),
  CreateRunRequest: root(
    closed(
      {
        input: PROMPT_TEXT,
        limits: runLimits,
        timeoutMs: boundedInteger(1000, 7 * DAY_MS),
        history: historyMode,
        skill: { type: 'string', minLength: 1 },
        images: { type: 'array', items: imageAttachment },
        attachMentions: boolean,
        mandate,
      },
      ['input'],
    ),
  ),
  CompactSessionRequest: root(closed({ instructions: PROMPT_TEXT }, [])),
  UserShellRequest: root(closed({ command: { type: 'string', minLength: 1, maxLength: USER_SHELL_COMMAND_CHARS }, include: boolean }, ['command', 'include'])),
  UserShellPendingResponse: root(closed({ pending: { type: 'array', items: userShellRecord } }, ['pending'])),
  UserShellFrame: root({
    anyOf: [
      closed({ type: constant('unprotected'), reason: string }, ['type', 'reason']),
      closed({ type: constant('output'), text: string }, ['type', 'text']),
      closed({ type: constant('refused'), reason: string }, ['type', 'reason']),
      closed({ type: constant('exit'), record: userShellRecord }, ['type', 'record']),
    ],
  }),
  ResolveApprovalRequest: root(closed({ optionId: { type: 'string', minLength: 1 } }, ['optionId'])),
  AddInboxRequest: root(closed({ delivery: enumOf(INBOX_DELIVERIES), text: PROMPT_TEXT, images: { type: 'array', items: imageAttachment } }, ['delivery', 'text'])),
  InboxRowView: root(inboxRowView),
  InboxResponse: root(closed({ pending: inboxPending }, ['pending'])),
  InboxAddResponse: root(closed({ row: inboxRowView, pending: inboxPending }, ['row', 'pending'])),
  InboxWithdrawResponse: root(closed({ outcome: enumOf(INBOX_WITHDRAW_OUTCOMES), row: inboxRowView, pending: inboxPending }, ['outcome', 'row', 'pending'])),
  RunSuccessorResponse: root(closed({ successor: nullable(runView) }, ['successor'])),
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
              approval: closed({ digest: string, changed: { type: 'boolean' } }, ['digest', 'changed']),
              stderrTail: string,
              exit: closed({ code: nullable(integer), signal: nullable(string) }, ['code', 'signal']),
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
        status: storedEnumOf(APPROVAL_STATUSES),
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
        state: enumOf(['running', 'retiring', 'draining']),
        role: enumOf(['starting', 'serving', 'retiring']),
        steps: integer,
        jobs: integer,
        sandbox: enumOf(['seatbelt', 'bubblewrap', 'none']),
      },
      ['status', 'version', 'apiVersion', 'pid', 'startedAt', 'state', 'role', 'steps', 'jobs', 'sandbox'],
    ),
  ),
  SessionView: root(
    closed(
      {
        id: string,
        cwd: string,
        permissionMode: storedPermissionMode,
        model: string,
        bypassAllowed: boolean,
        createdAt: integer,
        envKeys: { type: 'array', items: string },
        activeRunId: nullable(string),
        activeRunAt: nullable(integer),
        latestRunId: nullable(string),
        latestRunAt: nullable(integer),
        additionalDirectories: { type: 'array', items: string },
        lastEventId: nonNegativeInteger,
        autoClassifier: autoClassifierView,
      },
      ['id', 'cwd', 'permissionMode', 'model', 'bypassAllowed', 'createdAt', 'envKeys', 'activeRunId', 'activeRunAt', 'latestRunId', 'latestRunAt', 'additionalDirectories', 'lastEventId'],
    ),
  ),
  TrustView: root(trustView),
  TrustResponse: root(closed({ trust: trustView }, ['trust'])),
  TrustItemsResponse: root(trustItemsView),
  PutTrustRequest: root(closed({ path: { type: 'string', minLength: 1 }, decision: enumOf(['trusted', 'untrusted']) }, ['path', 'decision'])),
  McpFolderRequest: root(closed({ cwd: { type: 'string', minLength: 1 }, env: { type: 'object', additionalProperties: string } }, ['cwd', 'env'])),
  RunView: root(runView),
  ApprovalView: root(
    closed(
      {
        id: string,
        kind: enumOf(['permission', 'unknown_effect']),
        runId: string,
        callId: string,
        status: storedEnumOf(APPROVAL_STATUSES),
        options: { type: 'array', items: permissionOption },
        createdAt: integer,
        suggestedRule: string,
        reason: string,
        shown: approvalShown,
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
      ['id', 'kind', 'runId', 'callId', 'status', 'options', 'createdAt', 'reason', 'toolCall'],
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
            sideCalls: nonNegativeInteger,
            toolCalls: nonNegativeInteger,
            inputTokens: nonNegativeInteger,
            outputTokens: nonNegativeInteger,
            cachedInputTokens: nullable(nonNegativeInteger),
            cacheReadNotReportedCalls: nonNegativeInteger,
            errorCount: nonNegativeInteger,
            durationMs: nonNegativeInteger,
            chatResults: {
              type: 'array',
              items: closed({ step: nonNegativeInteger, attempt: integer, finishReasons: { type: 'array', items: string } }, ['step', 'attempt', 'finishReasons']),
            },
          },
          ['steps', 'chatCalls', 'sideCalls', 'toolCalls', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheReadNotReportedCalls', 'errorCount', 'durationMs', 'chatResults'],
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
        calls: {
          type: 'array',
          items: closed({ step: nonNegativeInteger, attempt: integer, anatomy: tokenAnatomy, prefix: runTracePrefix }, ['step', 'attempt']),
        },
        events: {
          type: 'array',
          items: {
            oneOf: [
              closed({ step: nonNegativeInteger, type: { const: 'tool.loaded' }, names: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } } }, ['step', 'type', 'names']),
              closed({ step: nonNegativeInteger, type: { const: 'loop.warned' }, signature: string }, ['step', 'type', 'signature']),
            ],
          },
        },
      },
      ['runId', 'summary', 'spans'],
    ),
  ),
  CostReport: root(costReportView),
  CostBreakdown: root(costBreakdownView),
  MemoryView: root(memoryView),
  MemoriesResponse: root(closed({ memories: { type: 'array', items: memoryView }, next: nullable(string) }, ['memories'])),
  MemoryResponse: root(closed({ memory: memoryView }, ['memory'])),
  ReflectionResponse: root(closed({ job: nullable(reflectionJobView) }, ['job'])),
  RunAnsweredBy: root(
    closed(
      {
        answeredBy: {
          type: 'array',
          items: closed({ target: string, adapter: { type: 'string' }, upstreamModel: { type: 'string' }, answers: { enum: ['model', 'script', 'unknown'] } }, ['target', 'answers']),
        },
      },
      ['answeredBy'],
    ),
  ),
  RunReflection: root(closed({ job: nullable(reflectionJobView), charges: { type: 'array', items: contextChargeView }, queuedAhead: nonNegativeInteger }, ['job', 'charges', 'queuedAhead'])),
  PromoteMemoryRequest: root(closed({ skill: string }, ['skill'])),
  PromoteMemoryResponse: root(closed({ path: string }, ['path'])),
  AddMemoryRequest: root(
    closed(
      {
        text: { type: 'string', minLength: 1 },
        scope: memoryScope,
        project: { type: 'string', minLength: 1 },
        kind: enumOf(MEMORY_KINDS),
        paths: { type: 'array', items: { type: 'string', minLength: 1 } },
      },
      ['text', 'scope'],
    ),
  ),
  GuidelineView: root(guidelineView),
  GuidelinesResponse: root(closed({ current: nullable(guidelineView), guidelines: { type: 'array', items: guidelineView } }, ['current', 'guidelines'])),
  GuidelineResponse: root(closed({ guideline: guidelineView }, ['guideline'])),
  AdoptGuidelineRequest: root(
    closed({ text: { type: 'string', minLength: 1, pattern: GUIDELINE_TEXT_PATTERN }, parent: nullable({ type: 'integer', minimum: 1 }), report: { type: 'object' } }, ['text', 'parent', 'report']),
  ),
  RecordContextChargeRequest: root(
    closed(
      {
        purpose: constant('guideline'),
        project: { type: 'string', minLength: 1 },
        model: { type: 'string', minLength: 1 },
        inputTokens: nonNegativeInteger,
        outputTokens: nonNegativeInteger,
        totalTokens: nonNegativeInteger,
        detail: newBilledDetail,
      },
      ['purpose', 'project', 'model', 'inputTokens', 'outputTokens', 'totalTokens'],
    ),
  ),
  ContextChargeResponse: root(closed({ charge: contextChargeView }, ['charge'])),
  GoverningFactView: root(governingFactView),
  AddRuleRequest: root(
    closed(
      {
        kind: enumOf(GOVERNING_KINDS),
        target: { type: 'string', minLength: 1 },
        text: { type: 'string', minLength: 1 },
        scope: governingScope,
        validUntil: nullable(integer),
        supersedes: { type: 'array', items: string },
        enforcement: nullable(governingEnforcement),
      },
      ['kind', 'target', 'text', 'scope'],
    ),
  ),
  RuleAddResponse: root(closed({ fact: governingFactView, size: { type: 'array', items: ruleSize }, warnings: { type: 'array', items: string } }, ['fact', 'size', 'warnings'])),
  RuleResponse: root(closed({ fact: governingFactView }, ['fact'])),
  RulesResponse: root(closed({ facts: { type: 'array', items: governingFactView } }, ['facts'])),
  PolicyVerifyRequest: root(closed({ project: string, mode: permissionMode, secrets: { type: 'array', items: string }, mandate: string }, ['project', 'secrets'])),
  PolicyVerifyResponse: root(
    closed({ fingerprint: string, stored: boolean, exitCode: integer, text: string, findings: { type: 'object', required: ['exitCode'] } }, ['fingerprint', 'stored', 'exitCode', 'text', 'findings']),
  ),
  PolicyGovernanceResponse: root(
    closed(
      {
        rules: { type: 'array', items: closed({ id: string, behavior: enumOf(GOVERNING_ENFORCEMENT_BEHAVIORS), rule: string }, ['id', 'behavior', 'rule']) },
        textOnly: { type: 'array', items: governingFactView },
      },
      ['rules', 'textOnly'],
    ),
  ),
  ErrorBody: root(
    closed({ error: closed({ type: string, code: string, message: string, param: string }, ['type', 'code', 'message']) }, ['error']),
  ),
  PublicRunEvent: root({ type: 'object', oneOf: [...EVENT_TYPES.map(publicEventVariant), publicOpaqueVariant()] }),
  ReportPage: root(
    closed(
      {
        rows: { type: 'array', items: runFactsView, maxItems: REPORT_PAGE_ROWS },
        unavailable: { type: 'array', items: closed({ runId: string, rootRunId: string }, ['runId', 'rootRunId']), maxItems: REPORT_PAGE_ROWS },
        nextCursor: nullable(string),
      },
      ['rows', 'unavailable', 'nextCursor'],
    ),
  ),
  ReportRecomputePage: root(
    closed(
      {
        rows: { type: 'array', items: runFactsView, maxItems: REPORT_PAGE_ROWS },
        refused: { type: 'array', items: string, maxItems: REPORT_PAGE_ROWS },
      },
      ['rows', 'refused'],
    ),
  ),
} as const satisfies Record<string, JsonSchema>;

type ReducedEventType =
  | 'user.message'
  | 'model.requested'
  | 'run.started'
  | 'context.compacted'
  | 'context.compaction_rejected'
  | 'context.inherited_compacted'
  | 'context.inherited'
  | 'instructions.loaded'
  | 'skill.activated';

type PublicPayload =
  | Exclude<RunEventPayload, { type: ReducedEventType }>
  | { type: 'user.message'; text: string; images?: { mediaType: ImageMediaType; byteLength: number }[]; source?: InboxDelivery; attachments?: AttachmentSummary[]; shell?: UserShellRecord[] }
  | { type: 'model.requested'; step: number; attempt: number; digest: string; anatomy?: TokenAnatomy; prefix?: Extract<RunEventPayload, { type: 'model.requested' }>['prefix'] }
  | { type: 'run.started'; attempt: number }
  | { type: 'context.compacted'; summary: string; replacedThroughSeq: number; source?: SummarySource; fidelity?: SummaryFidelity; guidelineVersion?: number; tokensBefore?: number; tokensAfter?: number; tokensAfterEstimated?: true }
  | { type: 'context.compaction_rejected'; step?: number; attempt?: number }
  | { type: 'context.inherited_compacted'; fromRunId: string; summary: string; replacedThroughSeq: number; tokensBefore?: number; tokensAfter?: number; tokensAfterEstimated?: true }
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

const inheritedCountsOf = (event: Extract<RunEvent, { type: 'context.inherited' }>): { itemCount: number; summaryThroughSeq?: number } => {
  if (isInheritedReference(event)) return { itemCount: event.itemCount };
  const { history, summary } = event;
  return { itemCount: history.length, ...(summary === undefined ? {} : { summaryThroughSeq: summary.replacedThroughSeq }) };
};

export type OpaqueEvent = {
  opaque: true;
  type: string;
  id: number;
  runId: string | null;
  sessionId: string;
  seq: number | null;
  step: number | null;
  createdAt: number;
  payload: Record<string, unknown>;
};

export type PublicOpaqueEvent = {
  opaque: true;
  type: string;
  id: number;
  runId?: string;
  sessionId: string;
  seq?: number;
  step?: number;
  createdAt: number;
  payload: Record<string, unknown>;
};

export type PublicStreamEvent = PublicRunEvent | PublicOpaqueEvent;

export const isOpaqueEvent = (event: PublicStreamEvent): event is PublicOpaqueEvent => 'opaque' in event;

const toPublicOpaqueEvent = (event: OpaqueEvent): PublicOpaqueEvent => {
  const { opaque, type, id, runId, sessionId, seq, step, createdAt, payload } = event;
  return { opaque, type, id, ...(runId === null ? {} : { runId }), sessionId, ...(seq === null ? {} : { seq }), ...(step === null ? {} : { step }), createdAt, payload };
};

export type PublicEventOf<E extends RunEvent | SessionEvent | OpaqueEvent> = E extends OpaqueEvent ? PublicOpaqueEvent : PublicRunEvent;

export const toPublicRunEvent = <E extends RunEvent | SessionEvent | OpaqueEvent>(event: E): PublicEventOf<E> => {
  const stored: RunEvent | SessionEvent | OpaqueEvent = event;
  const visible = 'opaque' in stored ? toPublicOpaqueEvent(stored) : toPublicKnownEvent(stored);
  return visible as PublicEventOf<E>;
};

const toPublicKnownEvent = (event: RunEvent | SessionEvent): PublicRunEvent => {
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
        ...(event.source === undefined ? {} : { source: event.source }),
        ...(event.attachments === undefined ? {} : { attachments: event.attachments.map(attachmentSummaryOf) }),
        ...(event.shell === undefined ? {} : { shell: event.shell }),
      };
    case 'model.requested':
      return {
        ...envelope,
        type: event.type,
        step: event.step,
        attempt: event.attempt,
        digest: event.digest,
        ...(event.anatomy === undefined ? {} : { anatomy: event.anatomy }),
        ...(event.prefix === undefined ? {} : { prefix: event.prefix }),
      };
    case 'run.started':
      return { ...envelope, type: event.type, attempt: event.attempt };
    case 'context.compacted':
      return {
        ...envelope,
        type: event.type,
        summary: event.summary,
        replacedThroughSeq: event.replacedThroughSeq,
        ...(event.source === undefined ? {} : { source: event.source }),
        ...(event.fidelity === undefined ? {} : { fidelity: event.fidelity }),
        ...(event.guidelineVersion === undefined ? {} : { guidelineVersion: event.guidelineVersion }),
        ...(event.tokensBefore === undefined ? {} : { tokensBefore: event.tokensBefore }),
        ...(event.tokensAfter === undefined ? {} : { tokensAfter: event.tokensAfter }),
        ...(event.tokensAfterEstimated === undefined ? {} : { tokensAfterEstimated: event.tokensAfterEstimated }),
      };
    case 'context.compaction_rejected':
      return { ...envelope, type: event.type, ...(event.attempt === undefined ? {} : { attempt: event.attempt }) };
    case 'context.inherited_compacted':
      return {
        ...envelope,
        type: event.type,
        fromRunId: event.fromRunId,
        summary: event.summary,
        replacedThroughSeq: event.replacedThroughSeq,
        ...(event.tokensBefore === undefined ? {} : { tokensBefore: event.tokensBefore }),
        ...(event.tokensAfter === undefined ? {} : { tokensAfter: event.tokensAfter }),
        ...(event.tokensAfterEstimated === undefined ? {} : { tokensAfterEstimated: event.tokensAfterEstimated }),
      };
    case 'context.inherited':
      return {
        ...envelope,
        type: event.type,
        fromRunId: event.fromRunId,
        fromLastSeq: event.fromLastSeq,
        ...inheritedCountsOf(event),
        nextItemSeq: event.nextItemSeq,
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

export const runApiSchemaName = (schema: JsonSchema): string => {
  const entry = Object.entries(RUN_API_SCHEMAS).find(([, candidate]) => candidate === schema);
  if (entry === undefined) throw new Error('the schema is not one of RUN_API_SCHEMAS');
  return entry[0];
};

export const PERSON_CAPABILITY_HEADER = 'momonga-person-capability';
