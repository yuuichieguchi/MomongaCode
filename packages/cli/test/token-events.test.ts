import { describe, expect, it } from 'vitest';
import type { PublicRunEvent } from '@momonga/protocol';
import { createMapperState, mapChildEvent, mapRunEvent } from '../src/acp/events.ts';
import type { ClientFeatures, Phase } from '../src/acp/events.ts';
import { initialTranscript, reduceEvent } from '../src/tui/transcript.ts';
import { frameOf } from './acp-harness.ts';
import type { EventPayload } from './acp-harness.ts';

const ALL: ClientFeatures = { notices: true, compaction: true, elicitation: { form: true, url: true } };
const NONE: ClientFeatures = { notices: false, compaction: false, elicitation: { form: false, url: false } };

const LOADED = { type: 'tool.loaded', names: ['Grep', 'Glob'] } as unknown as EventPayload;
const WARNED = { type: 'loop.warned', signature: 'sig-1' } as unknown as EventPayload;

describe('ACP mapping of the token events', () => {
  it.each([
    ['tool.loaded', LOADED],
    ['loop.warned', WARNED],
  ])('maps %s to nothing in every phase and for every client', (_type, payload) => {
    for (const phase of ['live', 'history'] as Phase[]) {
      for (const features of [ALL, NONE]) {
        expect(mapRunEvent(frameOf('run-1', 1, payload).data, phase, createMapperState(), features)).toEqual([]);
      }
    }
    expect(mapChildEvent(frameOf('run-1', 1, payload).data, 'helper', createMapperState(), ALL)).toEqual([]);
  });
});

const envelope = { id: 1, runId: 'r', sessionId: 's', seq: 1, step: 1, createdAt: 1 } as const;

describe('the TUI transcript of the token events', () => {
  it('renders tool.loaded as one info entry naming the tools in load order', () => {
    const state = reduceEvent(initialTranscript, { ...envelope, type: 'tool.loaded', names: ['Grep', 'Glob'] } as unknown as PublicRunEvent);
    expect(state.entries).toEqual([{ kind: 'info', text: 'tools loaded: Grep, Glob' }]);
  });

  it('adds no entry for loop.warned, whose notice carries the message', () => {
    const state = reduceEvent(initialTranscript, { ...envelope, type: 'loop.warned', signature: 'sig-1' } as unknown as PublicRunEvent);
    expect(state.entries).toEqual([]);
  });
});
