import { describe, expect, it } from 'vitest';
import type { PublicStreamEvent } from '@momonga/protocol';
import { createMapperState, mapChildEvent, mapRunEvent } from '../src/acp/events.ts';
import type { ClientFeatures } from '../src/acp/events.ts';

const ALL: ClientFeatures = { notices: true, compaction: true, elicitation: { form: true, url: true } };

const opaque: PublicStreamEvent = { opaque: true, type: 'future.kind', id: 9, runId: 'run-1', sessionId: 'sess-1', seq: 4, step: 1, createdAt: 1, payload: { anything: 1 } };

describe('store-protocol-C34: an opaque event in the ACP reader', () => {
  it('gives an empty list of effects and does not throw', () => {
    expect(mapRunEvent(opaque, 'live', createMapperState(), ALL)).toEqual([]);
    expect(mapRunEvent(opaque, 'history', createMapperState(), ALL)).toEqual([]);
  });

  it('gives an empty list as a child event too', () => {
    expect(mapChildEvent(opaque, 'explore', createMapperState(), ALL)).toEqual([]);
  });

  it('records each opaque type once in the mapper state, so the agent reports it once', () => {
    const state = createMapperState();
    mapRunEvent(opaque, 'live', state, ALL);
    mapRunEvent({ ...opaque, id: 10, seq: 5 }, 'live', state, ALL);
    expect([...state.opaqueTypes]).toEqual(['future.kind']);
  });
});
