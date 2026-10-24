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

  it('validates the session patch body', () => {
    expect(accepts('PatchSessionRequest', { permissionMode: 'acceptEdits' })).toBe(true);
    expect(accepts('PatchSessionRequest', {})).toBe(false);
    expect(accepts('PatchSessionRequest', { permissionMode: 'acceptEdits', cwd: '/x' })).toBe(false);
  });

  it('bounds the run input by code points', () => {
    expect(accepts('CreateRunRequest', { input: 'x' })).toBe(true);
    expect(accepts('CreateRunRequest', { input: '' })).toBe(false);
    expect(accepts('CreateRunRequest', { input: '😀'.repeat(1_000_000) })).toBe(true);
    expect(accepts('CreateRunRequest', { input: 'a'.repeat(1_000_001) })).toBe(false);
    expect(accepts('CreateRunRequest', { input: 'x', extra: 1 })).toBe(false);
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
      permissionMode: 'default',
      modelAlias: 'fm',
      bypassAllowed: false,
      createdAt: 1_800_000_000_000,
      envKeys: ['PATH'],
      activeRunId: null,
      latestRunId: 'run-1',
      additionalDirectories: ['/work/shared'],
    };
    expect(accepts('SessionView', view)).toBe(true);
    expect(accepts('SessionView', { ...view, env: { PATH: '/usr/bin' } })).toBe(false);
  });

  it('SessionView requires additionalDirectories', () => {
    const view = {
      id: 'sess-1',
      cwd: '/work/a',
      permissionMode: 'default',
      modelAlias: 'fm',
      bypassAllowed: false,
      createdAt: 1_800_000_000_000,
      envKeys: ['PATH'],
      activeRunId: null,
      latestRunId: null,
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
    };
    expect(accepts('RunView', view)).toBe(true);
    expect(accepts('RunView', { ...view, error: { code: 'max_attempts', message: 'x' } })).toBe(true);
    expect(accepts('RunView', { ...view, leaseToken: 3 })).toBe(false);
    expect(accepts('RunView', { ...view, leaseOwner: 'w1' })).toBe(false);
  });

  it('describes an ApprovalView with its tool call', () => {
    const view = {
      id: 'appr-1',
      runId: 'run-1',
      callId: 'call_1',
      status: 'pending',
      options: OPTIONS,
      expiresAt: 1_800_000_060_000,
      createdAt: 1_800_000_000_000,
      suggestedRule: 'Write(/work/a/x)',
      toolCall: { callId: 'call_1', name: 'Write', title: 'Write x', kind: 'edit', rawInput: { file_path: '/work/a/x' }, locations: [{ path: '/work/a/x' }] },
    };
    expect(accepts('ApprovalView', view)).toBe(true);
    for (const status of ['resolved', 'superseded', 'expired', 'withdrawn']) expect(accepts('ApprovalView', { ...view, status }), status).toBe(true);
    expect(accepts('ApprovalView', { ...view, status: 'bogus' })).toBe(false);
    const { toolCall: _omitted, ...withoutToolCall } = view;
    expect(accepts('ApprovalView', withoutToolCall)).toBe(false);
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

  it('reduces instructions.loaded to the path', () => {
    const reduced = { ...RUN_ENVELOPE, type: 'instructions.loaded', path: '/work/a/AGENTS.md' };
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

  it('rejects an unknown event type', () => {
    expect(accepts('PublicRunEvent', { ...RUN_ENVELOPE, type: 'made.up' })).toBe(false);
  });
});
