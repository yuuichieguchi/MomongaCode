import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { createMapperState, mapChildEvent, mapRunEvent } from '../src/acp/events.ts';
import type { ClientFeatures, Phase } from '../src/acp/events.ts';
import { fold } from './tui/screen-fakes.ts';
import { frameOf } from './acp-harness.ts';
import type { EventPayload } from './acp-harness.ts';

const ALL: ClientFeatures = { notices: true, compaction: true, elicitation: { form: true, url: true } };
const NONE: ClientFeatures = { notices: false, compaction: false, elicitation: { form: false, url: false } };

const OBSERVED: RunEventPayload = {
  type: 'meter.observed',
  target: 'primary',
  counter: 'c'.repeat(64),
  fallback: false,
  inputDigest: 'd'.repeat(64),
  itemCount: 3,
  counted: 250,
  reported: 240,
  kept: 250,
  known: 200,
  uncounted: 50,
  miss: 5,
  contextWindow: 8192,
  tokenCounting: 'estimated',
};

describe('meter.observed in the clients', () => {
  it('maps to nothing in ACP in every phase and for every client', () => {
    const payload = OBSERVED as unknown as EventPayload;
    for (const phase of ['live', 'history'] as Phase[]) {
      for (const features of [ALL, NONE]) {
        expect(mapRunEvent(frameOf('run-1', 1, payload).data, phase, createMapperState(), features)).toEqual([]);
      }
    }
    expect(mapChildEvent(frameOf('run-1', 1, payload).data, 'helper', createMapperState(), ALL)).toEqual([]);
  });

  it('adds no entry to the TUI transcript', () => {
    const state = fold([{ ...OBSERVED }]);
    expect(state.entries).toEqual([]);
  });
});
