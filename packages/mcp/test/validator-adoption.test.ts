import { describe, expect, it } from 'vitest';
import { FIXTURE_EXTRA_TOOLS_ENV } from '@momonga/testkit';
import type { ToolSet } from '@momonga/tools';
import { callRecords, entry, makeExecutor, makePool, makeRecordFile, modernConfig } from './mcp-harness.ts';

const EXTRA = ['format_email', 'schema_draft04', 'schema_2019_09', 'schema_unknown', 'schema_absent', 'schema_draft07', 'remote_ref'];

const snapshotWithExtras = async (): Promise<{ set: ToolSet; recordFile: string }> => {
  const recordFile = makeRecordFile();
  const config = modernConfig(recordFile, { [FIXTURE_EXTRA_TOOLS_ENV]: EXTRA.join(',') });
  return { set: await makePool([entry('modern', config)]).snapshot(), recordFile };
};

const skipNoticesFor = (set: ToolSet, name: string): string[] => set.notices.filter((notice) => notice.includes(`"${name}"`) && notice.includes('skipped'));

describe('third-party schema validation after the validator change', () => {
  it('treats format as an annotation and passes a string that is not an email to the server', async () => {
    const { set, recordFile } = await snapshotWithExtras();
    const result = await makeExecutor().resultOf(set, 'mcp__modern__format_email', { address: 'not-an-email' });
    expect(result.output).toBe('format_email');
    expect(result.status).toBe('completed');
    expect(callRecords(recordFile, 'format_email')).toHaveLength(1);
  });

  it.each(['schema_draft04', 'schema_2019_09', 'schema_unknown'])('skips %s, which declares an unmeasured dialect, at registration with a notice', async (name) => {
    const { set } = await snapshotWithExtras();
    const toolName = `mcp__modern__${name}`;
    expect(set.get(toolName)).toBeUndefined();
    expect(skipNoticesFor(set, toolName)).toHaveLength(1);
  });

  it.each(['schema_absent', 'schema_draft07'])('accepts %s at registration', async (name) => {
    const { set } = await snapshotWithExtras();
    const toolName = `mcp__modern__${name}`;
    expect(set.get(toolName)).toBeDefined();
    expect(skipNoticesFor(set, toolName)).toEqual([]);
    const result = await makeExecutor().resultOf(set, toolName, {});
    expect(result).toMatchObject({ status: 'completed', output: name });
  });

  it('skips a schema whose $ref names an unregistered remote at registration with a notice', async () => {
    const { set, recordFile } = await snapshotWithExtras();
    const toolName = 'mcp__modern__remote_ref';
    expect(set.get(toolName)).toBeUndefined();
    const notices = skipNoticesFor(set, toolName);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('https://example.invalid/remote.json');
    expect(callRecords(recordFile, 'remote_ref')).toHaveLength(0);
  });
});
