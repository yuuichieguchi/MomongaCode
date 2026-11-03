import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { RUN_API_SCHEMAS, toPublicRunEvent } from '@momonga/protocol';
import type { RunEvent, TokenAnatomy } from '@momonga/protocol';

const ajv = new Ajv2020.default({ strict: true, allErrors: true });
addFormats.default(ajv);
const validatePublicEvent = ajv.compile(RUN_API_SCHEMAS.PublicRunEvent);

const accepts = (value: unknown): boolean => validatePublicEvent(value) === true;

const ENVELOPE = { id: 7, runId: 'run-1', sessionId: 'sess-1', seq: 3, step: 1, createdAt: 1_800_000_000_000 };

const ANATOMY: TokenAnatomy = {
  estimated: true,
  total: 300,
  layers: {
    system: 20,
    tools: 100,
    instructions: 30,
    skills: 0,
    governing: 0,
    memories: 10,
    summary: 0,
    workingState: 0,
    history: { user: 40, assistant: 30, toolCalls: 20, toolOutputs: 40 },
    notices: 10,
  },
  tools: { Read: 40, Write: 60 },
};

const LEGACY_USAGE = { input_tokens: 300, output_tokens: 20, total_tokens: 320 };

const respondedWith = (response: Record<string, unknown>) => ({ ...ENVELOPE, type: 'model.responded', step: 1, attempt: 1, response: { status: 'completed', output: [], ...response } });

describe('model.requested carries the anatomy of its request', () => {
  const requested = { ...ENVELOPE, type: 'model.requested', step: 1, attempt: 1, digest: 'd'.repeat(64) };

  it('keeps the anatomy in the public event and still drops the body, so the benchmark can read the layers of a recorded run', () => {
    const event = { ...requested, leaseToken: 1, pinnedDigest: 'p'.repeat(64), body: { input: 'secret prompt' }, anatomy: ANATOMY } as unknown as RunEvent;
    const projected = toPublicRunEvent(event);
    expect(projected).toEqual({ ...requested, anatomy: ANATOMY });
    expect(accepts(projected)).toBe(true);
    const older = { ...requested, leaseToken: 1, body: { input: 'old' } } as unknown as RunEvent;
    expect(toPublicRunEvent(older)).toEqual(requested);
    expect(accepts(requested)).toBe(true);
  });

  it('accepts an anatomy only when it is marked as an estimate and its layers are non-negative integers', () => {
    expect(accepts({ ...requested, anatomy: ANATOMY })).toBe(true);
    expect(accepts({ ...requested, anatomy: { ...ANATOMY, estimated: false } })).toBe(false);
    expect(accepts({ ...requested, anatomy: { ...ANATOMY, layers: { ...ANATOMY.layers, system: 2.5 } } })).toBe(false);
    expect(accepts({ ...requested, anatomy: { ...ANATOMY, layers: { ...ANATOMY.layers, history: { ...ANATOMY.layers.history, toolOutputs: -1 } } } })).toBe(false);
    expect(accepts({ ...requested, anatomy: { ...ANATOMY, tools: { Read: 'many' } } })).toBe(false);
    const { notices: _dropped, ...withoutNotices } = ANATOMY.layers;
    expect(accepts({ ...requested, anatomy: { ...ANATOMY, layers: withoutNotices } })).toBe(false);
  });
});

describe('model.responded carries what the call cost', () => {
  it('accepts cached input, reasoning, the cache-write extension, the timing and the cost of the call, and still a response with only the three totals', () => {
    expect(
      accepts(
        respondedWith({
          usage: { ...LEGACY_USAGE, input_tokens_details: { cached_tokens: 200 }, output_tokens_details: { reasoning_tokens: 12 } },
          momonga: { cacheWriteInputTokens: 60, cost: { amount: 0.0012, currency: 'USD', priceVersion: '2026-01-01' } },
          timing: { firstEventMs: 150, durationMs: 400 },
        }),
      ),
    ).toBe(true);
    expect(accepts(respondedWith({ usage: LEGACY_USAGE }))).toBe(true);
  });

  it('rejects a negative or fractional token detail and a timing without its duration, while accepting the well-formed ones', () => {
    expect(accepts(respondedWith({ usage: { ...LEGACY_USAGE, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }, timing: { firstEventMs: 0, durationMs: 0 } }))).toBe(true);
    expect(accepts(respondedWith({ usage: { ...LEGACY_USAGE, input_tokens_details: { cached_tokens: -1 } } }))).toBe(false);
    expect(accepts(respondedWith({ usage: { ...LEGACY_USAGE, output_tokens_details: { reasoning_tokens: 1.5 } } }))).toBe(false);
    expect(accepts(respondedWith({ usage: LEGACY_USAGE, momonga: { cacheWriteInputTokens: -3 } }))).toBe(false);
    expect(accepts(respondedWith({ usage: LEGACY_USAGE, timing: { firstEventMs: 150 } }))).toBe(false);
  });
});
