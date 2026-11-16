import { describe, expect, it } from 'vitest';
import { takeHandoverStart } from '../../src/handover/start.ts';

describe('the handover start carries only the fields that something reads', () => {
  it('a started handover has the record file, its parse and the terminal, and no session name', () => {
    const taken = takeHandoverStart(['--handover', '/home/u/.momonga/run/handover/session-1.tui.json'], {}, () => '{}');
    expect(taken.started).toBeDefined();
    expect(Object.keys(taken.started ?? {}).sort()).toEqual(['file', 'parsed', 'terminal']);
  });
});
