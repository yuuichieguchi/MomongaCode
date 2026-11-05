import { describe, expect, it } from 'vitest';
import { FIXTURE_EXTRA_TOOLS_ENV } from '@momonga/testkit';
import { entry, makePool, makeRecordFile, modernConfig } from './mcp-harness.ts';

describe('registering an MCP tool whose output schema does not compile', () => {
  it('skips the tool with a notice at registration', async () => {
    const pool = makePool([entry('modern', modernConfig(makeRecordFile(), { [FIXTURE_EXTRA_TOOLS_ENV]: 'bad_output_schema' }))]);
    const set = await pool.snapshot();
    expect(set.get('mcp__modern__bad_output_schema')).toBeUndefined();
    const skipped = set.notices.filter((notice) => notice.includes('mcp__modern__bad_output_schema'));
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain('skipped');
  });
});
