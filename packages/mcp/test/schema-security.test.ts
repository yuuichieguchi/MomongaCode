import { describe, expect, it } from 'vitest';
import type { ToolSet } from '@momonga/tools';
import { callRecords, entry, makeExecutor, makePool, makeRecordFile, modernConfig } from './mcp-harness.ts';

const modernSet = async (): Promise<{ set: ToolSet; recordFile: string }> => {
  const recordFile = makeRecordFile();
  return { set: await makePool([entry('modern', modernConfig(recordFile))]).snapshot(), recordFile };
};

const noticesAbout = (set: ToolSet, name: string): string[] => set.notices.filter((notice) => notice.includes(name));

describe('untrusted MCP input schemas', () => {
  it('skips a tool whose schema exceeds 64 KiB and reports it', async () => {
    const { set } = await modernSet();
    expect(set.get('mcp__modern__oversized')).toBeUndefined();
    const notices = noticesAbout(set, 'mcp__modern__oversized');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('64 KiB');
  });

  it('skips a tool whose schema cannot compile and reports it', async () => {
    const { set } = await modernSet();
    expect(set.get('mcp__modern__uncompilable')).toBeUndefined();
    expect(noticesAbout(set, 'mcp__modern__uncompilable')).toHaveLength(1);
  });

  it('strips pattern and patternProperties and loosens additionalProperties only where patternProperties was', async () => {
    const { set } = await modernSet();
    expect(set.get('mcp__modern__patterned')?.inputSchema).toEqual({
      type: 'object',
      properties: {
        code: { type: 'string' },
        when: { type: 'string', format: 'vendor-date' },
        nested: { type: 'object', properties: { inner: { type: 'string' } }, additionalProperties: false },
      },
      additionalProperties: true,
      required: ['code'],
    });
    expect(set.forModel({ mode: 'default', rules: [] }).find((tool) => tool.name === 'mcp__modern__patterned')?.parameters).not.toHaveProperty(
      'patternProperties',
    );
  });

  it('lets arguments that only violate stripped patterns reach the server', async () => {
    const { set, recordFile } = await modernSet();
    const args = { code: 'not-digits', when: 'whenever', 'x-extra': 'text', nested: { inner: 'q' } };
    const result = await makeExecutor().resultOf(set, 'mcp__modern__patterned', args);
    expect(result.status).toBe('completed');
    expect(JSON.parse(result.output)).toEqual(args);
    expect(callRecords(recordFile, 'patterned')).toHaveLength(1);
  });

  it.each([
    ['a wrong type', { code: 5 }],
    ['a missing required property', { when: 'x' }],
    ['an unknown property where additionalProperties stays false', { code: '1', nested: { inner: 'z', other: 1 } }],
  ])('still rejects %s after sanitizing', async (_label, args) => {
    const { set, recordFile } = await modernSet();
    const result = await makeExecutor().resultOf(set, 'mcp__modern__patterned', args);
    expect(result.status).toBe('failed');
    expect(result.output.startsWith('Invalid input for mcp__modern__patterned:')).toBe(true);
    expect(callRecords(recordFile, 'patterned')).toEqual([]);
  });

  it('compiles a draft-07 schema and validates with it', async () => {
    const { set, recordFile } = await modernSet();
    expect(noticesAbout(set, 'mcp__modern__draft07')).toEqual([]);
    const executor = makeExecutor();
    expect((await executor.resultOf(set, 'mcp__modern__draft07', { value: 'seven' })).output).toBe('seven');
    const invalid = await executor.resultOf(set, 'mcp__modern__draft07', { value: 7 });
    expect(invalid.output.startsWith('Invalid input for mcp__modern__draft07:')).toBe(true);
    expect(callRecords(recordFile, 'draft07')).toHaveLength(1);
  });
});
