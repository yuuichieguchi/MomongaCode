import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@momonga/protocol';
import { parentPinsOf } from '../../src/worker/pins.ts';

const storeWith = (events: readonly Pick<RunEvent, 'type'>[]) => ({
  readRunEventsOfTypes: () => events as unknown as RunEvent[],
});

const started = (pins: Record<string, unknown>) => ({ type: 'run.started' as const, seq: 1, attempt: 1, now: 0, pins });

describe('parentPinsOf', () => {
  it('returns the model and the roles a run pinned when it started', () => {
    const store = storeWith([started({ model: 'fm', roles: { reflection: 'cheap' } })]);
    expect(parentPinsOf(store, 'run-1')).toEqual({ model: 'fm', roles: { reflection: 'cheap' } });
  });

  it('returns no roles for a run recorded before roles existed', () => {
    expect(parentPinsOf(storeWith([started({ model: 'fm' })]), 'run-1')).toEqual({ model: 'fm', roles: {} });
  });

  it('fails when the run never recorded run.started', () => {
    expect(() => parentPinsOf(storeWith([]), 'run-1')).toThrow('run-1');
  });

  it('fails when run.started pinned no model', () => {
    expect(() => parentPinsOf(storeWith([started({ roles: {} })]), 'run-1')).toThrow('run run-1 recorded run.started without a model pin');
  });
});
