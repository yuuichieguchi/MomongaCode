import { describe, expect, it } from 'vitest';
import type { PublicStreamEvent } from '@momonga/protocol';
import { createMapperState, mapChildEvent, mapRunEvent } from '../src/acp/events.ts';
import type { ClientFeatures } from '../src/acp/events.ts';

const ALL: ClientFeatures = { notices: true, compaction: true, elicitation: { form: true, url: true } };

const opaque: PublicStreamEvent = { opaque: true, type: 'future.kind', id: 9, runId: 'run-1', sessionId: 'sess-1', seq: 4, step: 1, createdAt: 1, payload: { anything: 1 } };

const SKIPPED = 'an event of type future.kind from a newer daemon was skipped; the session goes on';

describe('store-protocol-C34 and cli-commands-C45: an opaque event in the ACP reader', () => {
  it('gives one visible notice for its type, then nothing for the same type, and does not throw', () => {
    const state = createMapperState();
    expect(mapRunEvent(opaque, 'live', state, ALL)).toEqual([{ kind: 'update', update: { sessionUpdate: 'notice', severity: 'warning', title: SKIPPED } }]);
    expect(mapRunEvent({ ...opaque, id: 10, seq: 5 }, 'history', state, ALL)).toEqual([]);
  });

  it('gives the notice as a message to a client without notices', () => {
    expect(mapRunEvent(opaque, 'live', createMapperState(), { ...ALL, notices: false })).toEqual([
      { kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `momonga warning: ${SKIPPED}\n` }, messageId: 'sess-1/opaque/future.kind' } },
    ]);
  });

  it('gives the notice as a child event too', () => {
    expect(mapChildEvent(opaque, 'explore', createMapperState(), ALL)).toEqual([{ kind: 'update', update: { sessionUpdate: 'notice', severity: 'warning', title: SKIPPED } }]);
  });

  it('records each opaque type once in the mapper state, so the agent reports it once', () => {
    const state = createMapperState();
    mapRunEvent(opaque, 'live', state, ALL);
    mapRunEvent({ ...opaque, id: 10, seq: 5 }, 'live', state, ALL);
    expect([...state.opaqueTypes]).toEqual(['future.kind']);
  });
});
