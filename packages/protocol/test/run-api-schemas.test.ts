import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { RUN_API_SCHEMAS, toPublicRunEvent } from '@momonga/protocol';
import type { RunEvent } from '@momonga/protocol';

const SCHEMA_NAMES = [
  'CreateSessionRequest',
  'PatchSessionRequest',
  'CreateRunRequest',
  'ResolveApprovalRequest',
  'Health',
  'SessionView',
  'RunView',
  'ApprovalView',
  'ErrorBody',
  'PublicRunEvent',
  'TrustView',
  'TrustResponse',
  'PutTrustRequest',
  'SkillsResponse',
  'MemoryView',
  'MemoriesResponse',
  'MemoryResponse',
  'McpServersResponse',
  'CostReport',
] as const;

type SchemaName = (typeof SCHEMA_NAMES)[number];

const loadSchemas = (): Record<string, Record<string, unknown>> => {
  const exported: unknown = RUN_API_SCHEMAS;
  if (typeof exported !== 'object' || exported === null) throw new Error('@momonga/protocol does not export RUN_API_SCHEMAS');
  return exported as Record<string, Record<string, unknown>>;
};

const schemas = loadSchemas();

const buildAjv = () => {
  const ajv = new Ajv2020.default({ strict: true, allErrors: true });
  addFormats.default(ajv);
  for (const schema of Object.values(schemas)) if (typeof schema['$id'] === 'string') ajv.addSchema(schema);
  return ajv;
};

const ajv = buildAjv();

const validator = (name: SchemaName): ValidateFunction => {
  const schema = schemas[name];
  if (schema === undefined) throw new Error(`RUN_API_SCHEMAS has no ${name}`);
  return typeof schema['$id'] === 'string' ? (ajv.getSchema(schema['$id']) as ValidateFunction) : ajv.compile(schema);
};

const accepts = (name: SchemaName, value: unknown): boolean => validator(name)(value) === true;

const DAY_MS = 86_400_000;
const OPTIONS = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
];
const RUN_ENVELOPE = { id: 7, runId: 'run-1', sessionId: 'sess-1', seq: 3, createdAt: 1_800_000_000_000 };

describe('RUN_API_SCHEMAS', () => {
  it('names every request, response and frame schema as JSON Schema 2020-12', () => {
    for (const name of SCHEMA_NAMES) {
      expect(schemas[name], name).toBeDefined();
      expect(schemas[name]?.['$schema'], name).toBe('https://json-schema.org/draft/2020-12/schema');
    }
  });

  it('compiles every schema under strict Ajv 2020', () => {
    for (const name of SCHEMA_NAMES) expect(() => validator(name), name).not.toThrow();
  });
});

describe('request schemas', () => {
  it('validates the session creation body and rejects unknown properties', () => {
    expect(accepts('CreateSessionRequest', { cwd: '/work/a', env: { PATH: '/usr/bin' } })).toBe(true);
    expect(accepts('CreateSessionRequest', { cwd: '/work/a', env: {}, permissionMode: 'plan', modelAlias: 'fm', bypassAllowed: true })).toBe(true);
    expect(accepts('CreateSessionRequest', { cwd: '/work/a' })).toBe(false);
    expect(accepts('CreateSessionRequest', { cwd: '/work/a', env: { PATH: 1 } })).toBe(false);
    expect(accepts('CreateSessionRequest', { cwd: '/work/a', env: {}, permissionMode: 'yolo' })).toBe(false);
    expect(accepts('CreateSessionRequest', { cwd: '/work/a', env: {}, extra: true })).toBe(false);
  });

  it('accepts MCP servers keyed by name in the session creation body and rejects anything else', () => {
    expect(accepts('CreateSessionRequest', { cwd: '/work/a', env: {}, mcpServers: {} })).toBe(true);
    expect(accepts('CreateSessionRequest', { cwd: '/work/a', env: {}, mcpServers: { fx: { command: 'node' }, docs: { type: 'http', url: 'https://example.com' } } })).toBe(true);
    expect(accepts('CreateSessionRequest', { cwd: '/work/a', env: {}, mcpServers: [] })).toBe(false);
    expect(accepts('CreateSessionRequest', { cwd: '/work/a', env: {}, mcpServers: { fx: 'node' } })).toBe(false);
  });

  it('validates the session patch body', () => {
    expect(accepts('PatchSessionRequest', { permissionMode: 'acceptEdits' })).toBe(true);
    expect(accepts('PatchSessionRequest', {})).toBe(false);
    expect(accepts('PatchSessionRequest', { permissionMode: 'acceptEdits', cwd: '/x' })).toBe(false);
    expect(accepts('PatchSessionRequest', { mcpServers: {} })).toBe(true);
    expect(accepts('PatchSessionRequest', { permissionMode: 'plan', mcpServers: { fx: { command: 'node' } } })).toBe(true);
    expect(accepts('PatchSessionRequest', { mcpServers: [] })).toBe(false);
  });

  it('reports the scope of an MCP server as user, project or session', () => {
    const server = { name: 'fx', transport: 'stdio', auth: 'not_applicable' };
    for (const scope of ['user', 'project', 'session']) expect(accepts('McpServersResponse', { servers: [{ ...server, scope }] }), scope).toBe(true);
    expect(accepts('McpServersResponse', { servers: [{ ...server, scope: 'org' }] })).toBe(false);
  });

  it('bounds the run input by code points', () => {
    expect(accepts('CreateRunRequest', { input: 'x' })).toBe(true);
    expect(accepts('CreateRunRequest', { input: '' })).toBe(false);
    expect(accepts('CreateRunRequest', { input: '😀'.repeat(1_000_000) })).toBe(true);
    expect(accepts('CreateRunRequest', { input: 'a'.repeat(1_000_001) })).toBe(false);
    expect(accepts('CreateRunRequest', { input: 'x', extra: 1 })).toBe(false);
    expect(accepts('CreateRunRequest', { input: 'x', skill: 'pdf-processing' })).toBe(true);
    expect(accepts('CreateRunRequest', { input: 'x', skill: '' })).toBe(false);
  });

  it.each([
    ['maxSteps', 1, 1000],
    ['maxTotalTokens', 1, 100_000_000],
    ['approvalTtlMs', 1000, 7 * DAY_MS],
    ['loopThreshold', 2, 20],
  ])('bounds limits.%s to %d..%d', (field, min, max) => {
    expect(accepts('CreateRunRequest', { input: 'x', limits: { [field]: min } })).toBe(true);
    expect(accepts('CreateRunRequest', { input: 'x', limits: { [field]: max } })).toBe(true);
    expect(accepts('CreateRunRequest', { input: 'x', limits: { [field]: min - 1 } })).toBe(false);
    expect(accepts('CreateRunRequest', { input: 'x', limits: { [field]: max + 1 } })).toBe(false);
    expect(accepts('CreateRunRequest', { input: 'x', limits: { [field]: min + 0.5 } })).toBe(false);
  });

  it('rejects an unknown limit and bounds timeoutMs to 1000..7 days', () => {
    expect(accepts('CreateRunRequest', { input: 'x', limits: { maxWidgets: 1 } })).toBe(false);
    expect(accepts('CreateRunRequest', { input: 'x', timeoutMs: 1000 })).toBe(true);
    expect(accepts('CreateRunRequest', { input: 'x', timeoutMs: 7 * DAY_MS })).toBe(true);
    expect(accepts('CreateRunRequest', { input: 'x', timeoutMs: 999 })).toBe(false);
    expect(accepts('CreateRunRequest', { input: 'x', timeoutMs: 7 * DAY_MS + 1 })).toBe(false);
  });

  it('accepts history inherit or fresh on a run creation body and rejects any other value', () => {
    expect(accepts('CreateRunRequest', { input: 'x', history: 'inherit' })).toBe(true);
    expect(accepts('CreateRunRequest', { input: 'x', history: 'fresh' })).toBe(true);
    expect(accepts('CreateRunRequest', { input: 'x', history: 'none' })).toBe(false);
    expect(accepts('CreateRunRequest', { input: 'x', history: null })).toBe(false);
    expect(accepts('CreateRunRequest', { input: 'x', history: true })).toBe(false);
    expect(accepts('CreateRunRequest', { input: 'x', history: 'fresh', previousRunId: 'run-0' })).toBe(false);
  });

  it('validates the approval resolution body', () => {
    expect(accepts('ResolveApprovalRequest', { optionId: 'allow_once' })).toBe(true);
    expect(accepts('ResolveApprovalRequest', {})).toBe(false);
    expect(accepts('ResolveApprovalRequest', { optionId: 'allow_once', note: 'x' })).toBe(false);
  });
});

describe('response schemas', () => {
  it('describes the health body', () => {
    const health = { status: 'ok', version: '0.0.0', apiVersion: 1, pid: 4242, startedAt: '2027-01-15T08:00:00.000Z', state: 'running', sandbox: 'seatbelt' };
    expect(accepts('Health', health)).toBe(true);
    expect(accepts('Health', { ...health, apiVersion: 2 })).toBe(false);
  });

  it('Health accepts the seven fields and rejects a missing or extra field, an unknown state and an unknown sandbox', () => {
    const health = { status: 'ok', version: '0.0.0', apiVersion: 1, pid: 4242, startedAt: '2027-01-15T08:00:00.000Z', state: 'running', sandbox: 'seatbelt' };
    expect(accepts('Health', health)).toBe(true);
    expect(accepts('Health', { ...health, state: 'draining', sandbox: 'none' })).toBe(true);
    for (const field of Object.keys(health)) {
      const { [field]: _omitted, ...missing } = health as Record<string, unknown>;
      expect(accepts('Health', missing), field).toBe(false);
    }
    expect(accepts('Health', { status: 'ok', version: '0.0.0', apiVersion: 1 })).toBe(false);
    expect(accepts('Health', { ...health, extra: true })).toBe(false);
    expect(accepts('Health', { ...health, state: 'tearingDown' })).toBe(false);
    expect(accepts('Health', { ...health, sandbox: 'docker' })).toBe(false);
    expect(accepts('Health', { ...health, pid: 1.5 })).toBe(false);
    expect(accepts('Health', { ...health, startedAt: 1_800_000_000_000 })).toBe(false);
  });

  it('describes the error body aligned with the gateway', () => {
    expect(accepts('ErrorBody', { error: { type: 'conflict', code: 'approval_not_pending', message: 'approval is resolved' } })).toBe(true);
    expect(accepts('ErrorBody', { error: { type: 'invalid_request', code: 'invalid_request', message: 'bad', param: 'input' } })).toBe(true);
    expect(accepts('ErrorBody', { error: { code: 'x' } })).toBe(false);
  });

  it('describes a SessionView without env values', () => {
    const view = {
      id: 'sess-1',
      cwd: '/work/a',
      permissionMode: 'manual',
      modelAlias: 'fm',
      bypassAllowed: false,
      createdAt: 1_800_000_000_000,
      envKeys: ['PATH'],
      activeRunId: null,
      latestRunId: 'run-1',
      additionalDirectories: ['/work/shared'],
      lastEventId: 12,
    };
    expect(accepts('SessionView', view)).toBe(true);
    expect(accepts('SessionView', { ...view, env: { PATH: '/usr/bin' } })).toBe(false);
  });

  it('SessionView requires lastEventId as a non-negative integer', () => {
    const view = {
      id: 'sess-1',
      cwd: '/work/a',
      permissionMode: 'manual',
      modelAlias: 'fm',
      bypassAllowed: false,
      createdAt: 1_800_000_000_000,
      envKeys: [],
      activeRunId: null,
      latestRunId: null,
      additionalDirectories: [],
    };
    expect(accepts('SessionView', view)).toBe(false);
    expect(accepts('SessionView', { ...view, lastEventId: 0 })).toBe(true);
    expect(accepts('SessionView', { ...view, lastEventId: -1 })).toBe(false);
    expect(accepts('SessionView', { ...view, lastEventId: 1.5 })).toBe(false);
  });

  it('SessionView requires additionalDirectories', () => {
    const view = {
      id: 'sess-1',
      cwd: '/work/a',
      permissionMode: 'manual',
      modelAlias: 'fm',
      bypassAllowed: false,
      createdAt: 1_800_000_000_000,
      envKeys: ['PATH'],
      activeRunId: null,
      latestRunId: null,
      lastEventId: 0,
    };
    expect(accepts('SessionView', view)).toBe(false);
    expect(accepts('SessionView', { ...view, additionalDirectories: [] })).toBe(true);
    expect(accepts('SessionView', { ...view, additionalDirectories: ['/work/b', '/work/c'] })).toBe(true);
    expect(accepts('SessionView', { ...view, additionalDirectories: [1] })).toBe(false);
  });

  it('TrustView, TrustResponse and PutTrustRequest accept valid bodies and reject extras, an empty path and an unknown decision', () => {
    const exact = { path: '/work/a', decision: 'trusted' };
    const inherited = { path: '/work/a/b', decision: 'untrusted', inheritedFrom: '/work/a' };
    const unset = { path: '/work/c', decision: null };
    for (const view of [exact, inherited, unset]) {
      expect(accepts('TrustView', view)).toBe(true);
      expect(accepts('TrustResponse', { trust: view })).toBe(true);
    }
    expect(accepts('TrustView', { ...exact, extra: 1 })).toBe(false);
    expect(accepts('TrustView', { path: '/work/a', decision: 'maybe' })).toBe(false);
    expect(accepts('TrustView', { path: '/work/a' })).toBe(false);
    expect(accepts('TrustResponse', { trust: exact, extra: 1 })).toBe(false);
    expect(accepts('TrustResponse', { trust: { ...exact, extra: 1 } })).toBe(false);
    expect(accepts('TrustResponse', {})).toBe(false);

    expect(accepts('PutTrustRequest', { path: '/work/a', decision: 'trusted' })).toBe(true);
    expect(accepts('PutTrustRequest', { path: '/work/a', decision: 'untrusted' })).toBe(true);
    expect(accepts('PutTrustRequest', { path: '', decision: 'trusted' })).toBe(false);
    expect(accepts('PutTrustRequest', { path: '/work/a', decision: 'maybe' })).toBe(false);
    expect(accepts('PutTrustRequest', { path: '/work/a', decision: null })).toBe(false);
    expect(accepts('PutTrustRequest', { path: '/work/a', decision: 'trusted', extra: 1 })).toBe(false);
    expect(accepts('PutTrustRequest', { path: '/work/a' })).toBe(false);
  });

  it('describes a RunView without lease fields', () => {
    const view = {
      id: 'run-1',
      sessionId: 'sess-1',
      ordinal: 1,
      status: 'STOPPED',
      stopReason: 'approval_timeout',
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      step: 2,
      limits: { maxSteps: 50, maxTotalTokens: 1_000_000, approvalTtlMs: 1_800_000, loopThreshold: 3 },
      createdAt: 1_800_000_000_000,
      deadlineAt: 1_800_021_600_000,
      cancelRequested: false,
      lastSeq: 9,
      previousRunId: 'run-0',
      history: 'inherit',
      parentRunId: null,
      parentCallId: null,
      origin: 'trusted',
    };
    expect(accepts('RunView', view)).toBe(true);
    const { origin: _origin, ...withoutOrigin } = view;
    expect(accepts('RunView', withoutOrigin)).toBe(false);
    expect(accepts('RunView', { ...view, origin: 'elsewhere' })).toBe(false);
    expect(accepts('RunView', { ...view, error: { code: 'max_attempts', message: 'x' } })).toBe(true);
    expect(accepts('RunView', { ...view, leaseToken: 3 })).toBe(false);
    expect(accepts('RunView', { ...view, leaseOwner: 'w1' })).toBe(false);
  });

  it('requires previousRunId and history on a RunView', () => {
    const view = {
      id: 'run-2',
      sessionId: 'sess-1',
      ordinal: 2,
      status: 'QUEUED',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      step: 0,
      limits: { maxSteps: 50 },
      createdAt: 1_800_000_000_000,
      deadlineAt: 1_800_021_600_000,
      cancelRequested: false,
      lastSeq: 1,
      previousRunId: 'run-1',
      history: 'inherit',
      parentRunId: null,
      parentCallId: null,
      origin: 'untrusted',
    };
    expect(accepts('RunView', view)).toBe(true);
    expect(accepts('RunView', { ...view, previousRunId: null, history: 'fresh' })).toBe(true);
    const { previousRunId: _previous, ...withoutPrevious } = view;
    expect(accepts('RunView', withoutPrevious)).toBe(false);
    const { history: _history, ...withoutHistory } = view;
    expect(accepts('RunView', withoutHistory)).toBe(false);
    expect(accepts('RunView', { ...view, history: 'none' })).toBe(false);
    expect(accepts('RunView', { ...view, previousRunId: 7 })).toBe(false);
  });

  it('describes an ApprovalView with its tool call', () => {
    const view = {
      id: 'appr-1',
      runId: 'run-1',
      callId: 'call_1',
      status: 'pending',
      options: OPTIONS,
      createdAt: 1_800_000_000_000,
      suggestedRule: 'Write(/work/a/x)',
      reason: 'edits require approval',
      toolCall: { callId: 'call_1', name: 'Write', title: 'Write x', kind: 'edit', rawInput: { file_path: '/work/a/x' }, locations: [{ path: '/work/a/x' }] },
    };
    expect(accepts('ApprovalView', view)).toBe(true);
    for (const status of ['resolved', 'superseded', 'expired', 'withdrawn']) expect(accepts('ApprovalView', { ...view, status }), status).toBe(true);
    expect(accepts('ApprovalView', { ...view, status: 'bogus' })).toBe(false);
    const { toolCall: _omitted, ...withoutToolCall } = view;
    expect(accepts('ApprovalView', withoutToolCall)).toBe(false);
    expect(accepts('ApprovalView', { ...view, expiresAt: 1_800_000_060_000 })).toBe(false);
  });

  it('carries the reason the policy asked on an ApprovalView, and requires it as a string', () => {
    const view = {
      id: 'appr-1',
      runId: 'run-1',
      callId: 'call_1',
      status: 'pending',
      options: OPTIONS,
      createdAt: 1_800_000_000_000,
      reason: 'edit outside the workspace requires approval',
      toolCall: { callId: 'call_1', name: 'Write', title: 'Write x', kind: 'edit', rawInput: { file_path: '/elsewhere/x' } },
    };
    expect(accepts('ApprovalView', view)).toBe(true);
    const { reason: _reason, ...withoutReason } = view;
    expect(accepts('ApprovalView', withoutReason)).toBe(false);
    expect(accepts('ApprovalView', { ...view, reason: 7 })).toBe(false);
  });
});

describe('tool.permission.requested reason', () => {
  const requested = {
    ...RUN_ENVELOPE,
    type: 'tool.permission.requested',
    approvalId: 'a1',
    callId: 'c1',
    options: OPTIONS,
    subjectDigest: 'd'.repeat(64),
    reason: 'edit outside the workspace requires approval',
  };

  it('accepts a public request that carries the reason the policy asked', () => {
    expect(accepts('PublicRunEvent', requested)).toBe(true);
  });

  it('rejects a public request without a reason or with a reason that is not a string', () => {
    const { reason: _reason, ...withoutReason } = requested;
    expect(accepts('PublicRunEvent', withoutReason)).toBe(false);
    expect(accepts('PublicRunEvent', { ...requested, reason: 7 })).toBe(false);
  });
});

describe('PublicRunEvent projection', () => {
  it('passes ordinary run events through without a leaseToken', () => {
    expect(accepts('PublicRunEvent', { ...RUN_ENVELOPE, type: 'notice', level: 'info', message: 'hi' })).toBe(true);
    expect(accepts('PublicRunEvent', { ...RUN_ENVELOPE, type: 'tool.permission.cancelled', approvalId: 'a1', reason: 'withdrawn' })).toBe(true);
    expect(accepts('PublicRunEvent', { ...RUN_ENVELOPE, type: 'notice', level: 'info', message: 'hi', leaseToken: 1 })).toBe(false);
  });

  it('reduces model.requested to step, attempt and digest', () => {
    const reduced = { ...RUN_ENVELOPE, type: 'model.requested', step: 1, attempt: 1, digest: 'd'.repeat(64) };
    expect(accepts('PublicRunEvent', reduced)).toBe(true);
    expect(accepts('PublicRunEvent', { ...reduced, body: { input: 'secret prompt' } })).toBe(false);
  });

  it('reduces run.started to the attempt', () => {
    expect(accepts('PublicRunEvent', { ...RUN_ENVELOPE, type: 'run.started', attempt: 2 })).toBe(true);
    expect(accepts('PublicRunEvent', { ...RUN_ENVELOPE, type: 'run.started', attempt: 2, now: 1, pins: {} })).toBe(false);
  });

  it('reduces context.compacted to the summary and the replaced seq', () => {
    const reduced = { ...RUN_ENVELOPE, type: 'context.compacted', summary: 'so far', replacedThroughSeq: 4 };
    expect(accepts('PublicRunEvent', reduced)).toBe(true);
    expect(accepts('PublicRunEvent', { ...reduced, item: { type: 'compaction', encrypted_content: 'x' } })).toBe(false);
  });

  it('reduces context.compaction_rejected to step and attempt, without the item', () => {
    const withStep = { ...RUN_ENVELOPE, step: 2, type: 'context.compaction_rejected', attempt: 1 };
    expect(accepts('PublicRunEvent', withStep)).toBe(true);
    expect(accepts('PublicRunEvent', { ...RUN_ENVELOPE, step: 0, type: 'context.compaction_rejected' })).toBe(true);
    expect(accepts('PublicRunEvent', { ...withStep, item: { type: 'message', role: 'user', content: 'secret summary' } })).toBe(false);
  });

  it('removes the item from a public context.compaction_rejected', () => {
    const item = { type: 'message' as const, role: 'user' as const, content: '<conversation_summary>\nsecret\n</conversation_summary>' };
    const atSite3 = toPublicRunEvent({ ...RUN_ENVELOPE, step: 2, leaseToken: 4, type: 'context.compaction_rejected', attempt: 1, item } as unknown as RunEvent);
    expect(atSite3).toEqual({ ...RUN_ENVELOPE, step: 2, type: 'context.compaction_rejected', attempt: 1 });
    expect(accepts('PublicRunEvent', atSite3)).toBe(true);
    const atBuild = toPublicRunEvent({ ...RUN_ENVELOPE, step: 1, leaseToken: 4, type: 'context.compaction_rejected', item } as unknown as RunEvent);
    expect(atBuild).toEqual({ ...RUN_ENVELOPE, step: 1, type: 'context.compaction_rejected' });
    expect(accepts('PublicRunEvent', atBuild)).toBe(true);
  });

  it('reduces context.inherited to counts, closures, markers and the digest, without any item', () => {
    const reduced = {
      ...RUN_ENVELOPE,
      step: 0,
      type: 'context.inherited',
      fromRunId: 'run-0',
      fromLastSeq: 12,
      itemCount: 6,
      nextItemSeq: 9,
      summaryThroughSeq: 2,
      closures: [{ callId: 'call_a', effect: 'not_executed', announced: true }],
      partialMessage: false,
      markers: [{ kind: 'mode_changed' }],
      digest: 'd'.repeat(64),
    };
    expect(accepts('PublicRunEvent', reduced)).toBe(true);
    const { summaryThroughSeq: _through, ...withoutSummary } = reduced;
    expect(accepts('PublicRunEvent', { ...withoutSummary, closures: [], markers: [] })).toBe(true);
    expect(accepts('PublicRunEvent', { ...reduced, history: [] })).toBe(false);
    expect(accepts('PublicRunEvent', { ...reduced, summary: { summary: 'secret' } })).toBe(false);
    expect(accepts('PublicRunEvent', { ...reduced, closures: [{ callId: 'call_a', seq: 7, effect: 'unknown', announced: false }] })).toBe(false);
    expect(accepts('PublicRunEvent', { ...reduced, closures: [{ callId: 'call_a', effect: 'maybe', announced: false }] })).toBe(false);
    expect(accepts('PublicRunEvent', { ...reduced, markers: [{ kind: 'mode_changed', seq: 8 }] })).toBe(false);
    expect(accepts('PublicRunEvent', { ...reduced, markers: [{ kind: 'paused' }] })).toBe(false);
    const { digest: _digest, ...withoutDigest } = reduced;
    expect(accepts('PublicRunEvent', withoutDigest)).toBe(false);
  });

  it('removes the inherited items, the summary and the modes from a public context.inherited', () => {
    const summaryItem = { type: 'message' as const, role: 'user' as const, content: '<conversation_summary>\nsecret\n</conversation_summary>' };
    const event = {
      ...RUN_ENVELOPE,
      step: 0,
      leaseToken: 3,
      type: 'context.inherited',
      fromRunId: 'run-0',
      fromLastSeq: 12,
      history: [
        { seq: 3, item: { type: 'message', role: 'user', content: 'secret question' } },
        { seq: 4, item: { type: 'function_call', call_id: 'call_a', name: 'Read', arguments: '{}' }, callId: 'call_a' },
        { seq: 5, item: { type: 'function_call_output', call_id: 'call_a', output: 'Not run' }, callId: 'call_a' },
        { seq: 6, item: { type: 'function_call', call_id: 'call_b', name: 'Read', arguments: '{}' } },
        { seq: 7, item: { type: 'function_call_output', call_id: 'call_b', output: 'Not run' }, callId: 'call_b' },
        { seq: 8, item: { type: 'message', role: 'user', content: '[The permission mode changed]' } },
      ],
      nextItemSeq: 9,
      summary: { item: summaryItem, summary: 'secret', replacedThroughSeq: 2 },
      evicted: ['call_x'],
      closures: [
        { callId: 'call_a', seq: 5, effect: 'not_executed', announced: true },
        { callId: 'call_b', seq: 7, effect: 'unknown', announced: false },
      ],
      markers: [{ seq: 8, kind: 'mode_changed' }],
      fromMode: 'manual',
      mode: 'plan',
      digest: 'e'.repeat(64),
    } as unknown as RunEvent;
    const publicEvent = toPublicRunEvent(event);
    expect(publicEvent).toEqual({
      ...RUN_ENVELOPE,
      step: 0,
      type: 'context.inherited',
      fromRunId: 'run-0',
      fromLastSeq: 12,
      itemCount: 6,
      nextItemSeq: 9,
      summaryThroughSeq: 2,
      closures: [
        { callId: 'call_a', effect: 'not_executed', announced: true },
        { callId: 'call_b', effect: 'unknown', announced: false },
      ],
      partialMessage: false,
      markers: [{ kind: 'mode_changed' }],
      digest: 'e'.repeat(64),
    });
    expect(accepts('PublicRunEvent', publicEvent)).toBe(true);
    expect(JSON.stringify(publicEvent)).not.toContain('secret');
  });

  it('reports a projected partial message and omits summaryThroughSeq without a summary', () => {
    const event = {
      ...RUN_ENVELOPE,
      step: 0,
      leaseToken: 3,
      type: 'context.inherited',
      fromRunId: 'run-0',
      fromLastSeq: 5,
      history: [
        { seq: 1, item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] } },
        { seq: 2, item: { type: 'message', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text: 'half', annotations: [] }] } },
        { seq: 3, item: { type: 'message', role: 'user', content: '[The user interrupted the previous request before it was finished.]' } },
      ],
      nextItemSeq: 4,
      evicted: [],
      closures: [],
      partial: { seq: 2 },
      markers: [{ seq: 3, kind: 'interrupted' }],
      mode: 'manual',
      digest: 'f'.repeat(64),
    } as unknown as RunEvent;
    const publicEvent = toPublicRunEvent(event);
    expect(publicEvent).toEqual({
      ...RUN_ENVELOPE,
      step: 0,
      type: 'context.inherited',
      fromRunId: 'run-0',
      fromLastSeq: 5,
      itemCount: 3,
      nextItemSeq: 4,
      closures: [],
      partialMessage: true,
      markers: [{ kind: 'interrupted' }],
      digest: 'f'.repeat(64),
    });
    expect(accepts('PublicRunEvent', publicEvent)).toBe(true);
  });

  it('reduces instructions.loaded to the path', () => {
    const reduced = { ...RUN_ENVELOPE, type: 'instructions.loaded', path: '/work/a/AGENTS.md' };
    expect(accepts('PublicRunEvent', reduced)).toBe(true);
    expect(accepts('PublicRunEvent', { ...reduced, content: 'secret' })).toBe(false);
  });

  it('describes the skills of a session', () => {
    const skill = { name: 'pdf-processing', description: 'Extract PDF text', scope: 'project', location: '/work/.agents/skills/pdf-processing/SKILL.md' };
    expect(accepts('SkillsResponse', { skills: [skill], warnings: ['shadowed'] })).toBe(true);
    expect(accepts('SkillsResponse', { skills: [{ ...skill, scope: 'org' }], warnings: [] })).toBe(false);
    expect(accepts('SkillsResponse', { skills: [{ ...skill, body: 'x' }], warnings: [] })).toBe(false);
    expect(accepts('SkillsResponse', { skills: [] })).toBe(false);
  });

  it('reduces skill.activated to the name', () => {
    const reduced = { ...RUN_ENVELOPE, type: 'skill.activated', name: 'pdf-processing' };
    expect(accepts('PublicRunEvent', reduced)).toBe(true);
    expect(accepts('PublicRunEvent', { ...reduced, content: 'secret' })).toBe(false);
  });

  it('describes a session event without runId, seq, step or leaseToken', () => {
    const sessionEvent = { id: 8, sessionId: 'sess-1', createdAt: 1_800_000_000_000, type: 'mode.changed', mode: 'plan' };
    expect(accepts('PublicRunEvent', sessionEvent)).toBe(true);
    expect(accepts('PublicRunEvent', { ...sessionEvent, step: 0 })).toBe(false);
    expect(accepts('PublicRunEvent', { ...sessionEvent, leaseToken: 0 })).toBe(false);
    expect(accepts('PublicRunEvent', { ...sessionEvent, mode: 'yolo' })).toBe(false);
  });

  it('carries the side effect of a tool call and accepts only the values the policy knows', () => {
    const call = { ...RUN_ENVELOPE, step: 1, type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'MemorySave', kind: 'other', title: 'MemorySave', rawInput: {} };
    for (const sideEffect of ['read_only', 'write', 'exec']) expect(accepts('PublicRunEvent', { ...call, sideEffect })).toBe(true);
    expect(accepts('PublicRunEvent', { ...call, sideEffect: 'harmless' })).toBe(false);
  });

  it('counts calls of unknown billing in every cost total', () => {
    const totals = { calls: 1, localCalls: 0, unpricedCalls: 0, unknownBillingCalls: 1, planCalls: 0, planInputTokens: 0, planOutputTokens: 0, inputTokens: 2, outputTokens: 3, cachedInputTokens: 0, cacheReadNotReportedCalls: 0, cacheReadUnpricedCalls: 0, priceNotRecordedCalls: 0, amount: null, currency: 'USD', priceVersions: [], unpriced: { unknown_billing: 1 }, roles: {} };
    const { unknownBillingCalls: _unknownBillingCalls, ...withoutUnknown } = totals;
    const report = (entry: typeof withoutUnknown) => ({
      runs: [{ runId: 'r', sessionId: 's', ...entry }],
      sessions: [{ sessionId: 's', runIds: ['r'], ...entry }],
      total: entry,
      contextCharges: { charges: [], totalTokens: 0 },
    });
    expect(accepts('CostReport', report(totals))).toBe(true);
    expect(accepts('CostReport', report(withoutUnknown))).toBe(false);
  });

  it('counts the plan calls and their tokens in every cost total', () => {
    const totals = { calls: 1, localCalls: 0, unpricedCalls: 0, unknownBillingCalls: 0, planCalls: 1, planInputTokens: 2, planOutputTokens: 3, inputTokens: 2, outputTokens: 3, cachedInputTokens: 0, cacheReadNotReportedCalls: 0, cacheReadUnpricedCalls: 0, priceNotRecordedCalls: 0, amount: null, currency: 'USD', priceVersions: [], unpriced: { plan: 1 }, roles: {} };
    const { planCalls: _planCalls, ...withoutPlan } = totals;
    const report = (entry: object) => ({
      runs: [{ runId: 'r', sessionId: 's', ...entry }],
      sessions: [{ sessionId: 's', runIds: ['r'], ...entry }],
      total: entry,
      contextCharges: { charges: [], totalTokens: 0 },
    });
    expect(accepts('CostReport', report(totals))).toBe(true);
    expect(accepts('CostReport', report(withoutPlan))).toBe(false);
  });

  it('carries the model calls made for context purposes beside the cost totals', () => {
    const totals = { calls: 0, localCalls: 0, unpricedCalls: 0, unknownBillingCalls: 0, planCalls: 0, planInputTokens: 0, planOutputTokens: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheReadNotReportedCalls: 0, cacheReadUnpricedCalls: 0, priceNotRecordedCalls: 0, amount: 0, currency: 'USD', priceVersions: [], unpriced: {}, roles: {} };
    const charge = { id: 1, purpose: 'reflection', runId: null, project: '/work/a', model: 'fm', inputTokens: 100, outputTokens: 20, totalTokens: 120, createdAt: 1 };
    const report = (contextCharges: unknown) => ({ runs: [], sessions: [], total: totals, contextCharges });
    expect(accepts('CostReport', report({ charges: [charge], totalTokens: 120 }))).toBe(true);
    expect(accepts('CostReport', report({ charges: [{ ...charge, purpose: 'compaction' }], totalTokens: 120 }))).toBe(false);
    expect(accepts('CostReport', report({ charges: [{ ...charge, inputTokens: -1 }], totalTokens: 120 }))).toBe(false);
    expect(accepts('CostReport', report({ charges: [] }))).toBe(false);
    expect(accepts('CostReport', { runs: [], sessions: [], total: totals })).toBe(false);
  });

  it('rejects an unknown event type', () => {
    expect(accepts('PublicRunEvent', { ...RUN_ENVELOPE, type: 'made.up' })).toBe(false);
  });
});

describe('memory schemas', () => {
  const view = {
    id: 'mem-1',
    scope: 'project',
    origin: 'trusted',
    project: '/work/a',
    text: 'tests live in test/',
    source: { kind: 'tool', sessionId: 's1', runId: 'r1', step: 2, callId: 'c1', seq: 5 },
    createdAt: 1_800_000_000_000,
    keptAt: 1_800_000_001_000,
    kind: 'fact',
    state: 'active',
    duplicateOf: null,
    supersedes: [],
    supersededBy: [],
    retiredAt: null,
    evidence: [],
    status: 'unbound',
    contributedAt: null,
  };

  it('accepts a project and a user memory and rejects missing provenance, an unknown scope and extras', () => {
    expect(accepts('MemoryView', view)).toBe(true);
    expect(accepts('MemoryView', { ...view, scope: 'user', project: null })).toBe(true);
    expect(accepts('MemoryView', { ...view, scope: 'team' })).toBe(false);
    expect(accepts('MemoryView', { ...view, origin: 'untrusted' })).toBe(true);
    expect(accepts('MemoryView', { ...view, origin: 'unknown' })).toBe(true);
    expect(accepts('MemoryView', { ...view, origin: 'vouched' })).toBe(false);
    const { origin: _origin, ...withoutOrigin } = view;
    expect(accepts('MemoryView', withoutOrigin)).toBe(false);
    expect(accepts('MemoryView', { ...view, source: { ...view.source, seq: undefined } })).toBe(false);
    expect(accepts('MemoryView', { ...view, extra: 1 })).toBe(false);
    const { keptAt: _keptAt, ...withoutKeptAt } = view;
    expect(accepts('MemoryView', withoutKeptAt)).toBe(false);
    expect(accepts('MemoryView', { ...withoutKeptAt, lastUsedAt: 1_800_000_001_000 })).toBe(false);
  });

  it('wraps views in the list and item envelopes', () => {
    expect(accepts('MemoriesResponse', { memories: [view, view], next: null })).toBe(true);
    expect(accepts('MemoriesResponse', { memories: [view], next: 'opaque-cursor' })).toBe(true);
    expect(accepts('MemoriesResponse', { memories: [], next: null })).toBe(true);
    expect(accepts('MemoriesResponse', { memories: [{ ...view, scope: 'x' }] })).toBe(false);
    expect(accepts('MemoryResponse', { memory: view })).toBe(true);
    expect(accepts('MemoryResponse', { memory: view, extra: 1 })).toBe(false);
  });
});
