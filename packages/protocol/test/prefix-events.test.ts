import { describe, expect, it } from 'vitest';
import { PREFIX_EVENTS } from '@momonga/protocol';
import { PREFIX_EVENTS as FROM_MODULE } from '../src/prefix-events.ts';

describe('PREFIX_EVENTS', () => {
  it('is the closed list of named prefix events, in the order of the prefix rule', () => {
    expect([...PREFIX_EVENTS]).toEqual([
      'eviction',
      'compaction',
      'compaction_rejected',
      'governing_changed',
      'instructions_arrived',
      'instructions_replaced',
      'skill_activated',
      'tools_loaded',
      'claim',
      'wrap_up',
    ]);
  });

  it('is exported from the package and from its own module as one list', () => {
    expect(PREFIX_EVENTS).toBe(FROM_MODULE);
  });

  it('holds no duplicate', () => {
    expect(new Set(PREFIX_EVENTS).size).toBe(PREFIX_EVENTS.length);
  });
});
