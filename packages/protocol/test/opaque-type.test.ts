import { describe, expect, expectTypeOf, it } from 'vitest';
import { RUN_API_SCHEMAS, isOpaqueEvent } from '@momonga/protocol';
import type { PublicOpaqueEvent, PublicRunEvent, PublicStreamEvent } from '@momonga/protocol';
import Ajv2020 from 'ajv/dist/2020.js';

describe('store-protocol-C34: the reader type of the public event stream', () => {
  it('includes the opaque form the schema admits', () => {
    expectTypeOf<PublicOpaqueEvent>().toMatchTypeOf<PublicStreamEvent>();
    expectTypeOf<PublicRunEvent>().toMatchTypeOf<PublicStreamEvent>();
    const opaque = { opaque: true, type: 'future.kind', id: 1, sessionId: 's', createdAt: 1, payload: {} };
    expect(new Ajv2020.default({ strict: true, allErrors: true }).compile(RUN_API_SCHEMAS.PublicRunEvent)(opaque)).toBe(true);
  });

  it('is told apart by one predicate', () => {
    const opaque: PublicStreamEvent = { opaque: true, type: 'future.kind', id: 1, sessionId: 's', createdAt: 1, payload: {} };
    const known: PublicStreamEvent = { type: 'session.mode.changed', id: 2, sessionId: 's', createdAt: 1, mode: 'auto', previousMode: 'manual' } as PublicStreamEvent;
    expect(isOpaqueEvent(opaque)).toBe(true);
    expect(isOpaqueEvent(known)).toBe(false);
    if (isOpaqueEvent(opaque)) expectTypeOf(opaque).toEqualTypeOf<PublicOpaqueEvent>();
  });
});
