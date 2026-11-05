import { describe, expect, it } from 'vitest';
import { FIXTURE_EXTRA_TOOLS_ENV } from '@momonga/testkit';
import { entry, makePool, makeRecordFile, modernConfig } from './mcp-harness.ts';

const CYCLE_CODE = 'SCHEMA_REFERENCE_CYCLE';

describe('registering an MCP tool whose schema has a reference cycle that never descends into the instance', () => {
  it.each([
    ['input', 'reference_cycle_input'],
    ['output', 'reference_cycle_output'],
  ])('skips the tool whose %s schema cycles, naming the tool, the server and the cycle, and keeps the other tools', async (_label, tool) => {
    const pool = makePool([entry('modern', modernConfig(makeRecordFile(), { [FIXTURE_EXTRA_TOOLS_ENV]: tool }))]);
    const set = await pool.snapshot();
    const name = `mcp__modern__${tool}`;
    expect(set.get(name)).toBeUndefined();
    const skipped = set.notices.filter((notice) => notice.includes(name));
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain('skipped');
    expect(skipped[0]).toContain(CYCLE_CODE);
    expect(skipped[0]).toContain('"#/not/$ref"');
    expect(set.get('mcp__modern__echo')).toBeDefined();
    expect(set.get('mcp__modern__add')).toBeDefined();
  });
});
