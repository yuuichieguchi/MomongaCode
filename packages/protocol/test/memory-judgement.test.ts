import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { EVENT_TYPES, MEMORY_JUDGEMENT_OUTCOMES, RUN_API_SCHEMAS, USAGE_CHARGE_PURPOSES, toPublicRunEvent } from '@momonga/protocol';
import type { MemoryJudgement, MemoryRecord, MemoryView, RunEventPayload, SessionEvent, SessionEventPayload } from '@momonga/protocol';

const ajv = new Ajv2020.default({ strict: true, allErrors: true });
addFormats.default(ajv);

const accepts = (name: keyof typeof RUN_API_SCHEMAS, value: unknown): boolean => ajv.compile(RUN_API_SCHEMAS[name])(value) === true;

const VIEW = {
  id: 'mem-1',
  scope: 'project',
  origin: 'trusted',
  project: '/work/a',
  text: 'tests live in test/',
  source: { kind: 'reflection', sessionId: 's1', runId: 'r1', ordinal: 0 },
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
  keptByClassifier: null,
};

describe('the charge purpose of a memory judgement', () => {
  it('lists memory_classifier after the existing purposes', () => {
    expect(USAGE_CHARGE_PURPOSES).toEqual(['compaction', 'permission_classifier', 'rejected_answer', 'reflection', 'memory_classifier']);
  });

  it('accepts a usage.charged event with purpose memory_classifier', () => {
    const envelope = { id: 7, runId: 'run-1', sessionId: 'sess-1', seq: 3, step: 1, createdAt: 1 };
    const charged = { ...envelope, type: 'usage.charged', purpose: 'memory_classifier', inputTokens: 10, outputTokens: 5, totalTokens: 15, responseId: 'response-1' };
    expect(accepts('PublicRunEvent', charged)).toBe(true);
  });
});

describe('the session event memory.judged', () => {
  const event: SessionEvent = { type: 'memory.judged', memoryId: 'mem-1', id: 4, sessionId: 'sess-1', createdAt: 1 };

  it('is a public event type', () => {
    expect(EVENT_TYPES).toContain('memory.judged');
  });

  it('is a session event with exactly the memory id', () => {
    expect(accepts('PublicRunEvent', event)).toBe(true);
    expect(accepts('PublicRunEvent', { type: 'memory.judged', id: 4, sessionId: 'sess-1', createdAt: 1 })).toBe(false);
    expect(accepts('PublicRunEvent', { ...event, outcome: 'kept' })).toBe(false);
    expect(accepts('PublicRunEvent', { ...event, runId: 'run-1' })).toBe(false);
    expect(accepts('PublicRunEvent', { ...event, seq: 1 })).toBe(false);
    expect(accepts('PublicRunEvent', { ...event, memoryId: 5 })).toBe(false);
  });

  it('passes through toPublicRunEvent unchanged', () => {
    expect(toPublicRunEvent(event)).toEqual({ type: 'memory.judged', memoryId: 'mem-1', id: 4, sessionId: 'sess-1', createdAt: 1 });
  });

  it('is in the session payload union and not in the run payload union', () => {
    expectTypeOf<Extract<SessionEventPayload, { type: 'memory.judged' }>>().toEqualTypeOf<{ type: 'memory.judged'; memoryId: string }>();
    expectTypeOf<Extract<RunEventPayload, { type: 'memory.judged' }>>().toBeNever();
  });
});

describe('the judgement record', () => {
  it('has the outcomes kept and left', () => {
    expect(MEMORY_JUDGEMENT_OUTCOMES).toEqual(['kept', 'left']);
  });

  it('has the record shape', () => {
    expectTypeOf<MemoryJudgement>().toEqualTypeOf<{
      memoryId: string;
      outcome: 'kept' | 'left';
      classifier?: string;
      verdict?: 'safe' | 'unsafe';
      confidence?: 'high' | 'medium' | 'low';
      failure?: string;
      judgedAt: number;
    }>();
  });
});

describe('the classifier that kept a memory', () => {
  it('is on the memory record and its view', () => {
    expectTypeOf<MemoryRecord['keptByClassifier']>().toEqualTypeOf<string | null>();
    expectTypeOf<MemoryView['keptByClassifier']>().toEqualTypeOf<string | null>();
  });

  it('is a required nullable string of the memory view', () => {
    expect(accepts('MemoryView', VIEW)).toBe(true);
    expect(accepts('MemoryView', { ...VIEW, keptByClassifier: 'openai/gpt-5-mini' })).toBe(true);
    expect(accepts('MemoryView', { ...VIEW, keptByClassifier: 3 })).toBe(false);
    const { keptByClassifier: _kept, ...without } = VIEW;
    expect(accepts('MemoryView', without)).toBe(false);
    expect(accepts('MemoryResponse', { memory: { ...VIEW, keptByClassifier: 'openai/gpt-5-mini' } })).toBe(true);
  });
});

describe('the judgement view of the HTTP answers', () => {
  const RECORD = { memoryId: 'mem-1', outcome: 'left', classifier: 'openai/gpt-5-mini', verdict: 'unsafe', confidence: 'high', judgedAt: 1, owed: false, closed: true };

  it('carries closed beside owed', () => {
    expect(accepts('MemoryJudgementResponse', { judgement: RECORD })).toBe(true);
    expect(accepts('MemoryJudgementsResponse', { judgements: [RECORD, { ...RECORD, memoryId: 'mem-2', owed: true, closed: false }] })).toBe(true);
  });

  it('requires closed as a boolean', () => {
    const { closed: _closed, ...without } = RECORD;
    expect(accepts('MemoryJudgementResponse', { judgement: without })).toBe(false);
    expect(accepts('MemoryJudgementsResponse', { judgements: [without] })).toBe(false);
    expect(accepts('MemoryJudgementResponse', { judgement: { ...RECORD, closed: 'yes' } })).toBe(false);
  });
});
