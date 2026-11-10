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

  it('keeps pattern and patternProperties as the server wrote them, also in the schema shown to the model', async () => {
    const { set } = await modernSet();
    const written = {
      type: 'object',
      properties: {
        code: { type: 'string', pattern: '^[0-9]+$' },
        when: { type: 'string', format: 'vendor-date' },
        nested: { type: 'object', properties: { inner: { type: 'string', pattern: '^z$' } }, additionalProperties: false },
      },
      patternProperties: { '^x-': { type: 'number' } },
      additionalProperties: false,
      required: ['code'],
    };
    expect(set.get('mcp__modern__patterned')?.inputSchema).toEqual(written);
    const parameters = set.forModel({ mode: 'manual', rules: [] }).find((tool) => tool.name === 'mcp__modern__patterned')?.parameters;
    expect(parameters).toMatchObject({ properties: { code: { pattern: '^[0-9]+$' } }, patternProperties: { '^x-': { type: 'number' } } });
  });

  it.each([
    ['a value that breaks a pattern', { code: 'not-digits' }],
    ['a nested value that breaks a pattern', { code: '1', nested: { inner: 'q' } }],
    ['a property matched by patternProperties with the wrong type', { code: '1', 'x-extra': 'text' }],
    ['a property neither listed nor matched by patternProperties', { code: '1', other: 1 }],
  ])('refuses %s before it reaches the server', async (_label, args) => {
    const { set, recordFile } = await modernSet();
    const result = await makeExecutor().resultOf(set, 'mcp__modern__patterned', args);
    expect(result.status).toBe('failed');
    expect(result.output.startsWith('Invalid input for mcp__modern__patterned:')).toBe(true);
    expect(callRecords(recordFile, 'patterned')).toEqual([]);
  });

  it('lets arguments that meet every pattern reach the server', async () => {
    const { set, recordFile } = await modernSet();
    const args = { code: '42', when: 'whenever', 'x-extra': 3, nested: { inner: 'z' } };
    const result = await makeExecutor().resultOf(set, 'mcp__modern__patterned', args);
    expect(result.status).toBe('completed');
    expect(JSON.parse(result.output)).toEqual(args);
    expect(callRecords(recordFile, 'patterned')).toHaveLength(1);
  });

  it.each([
    ['a wrong type', { code: 5 }],
    ['a missing required property', { when: 'x' }],
    ['an unknown property where additionalProperties stays false', { code: '1', nested: { inner: 'z', other: 1 } }],
  ])('still rejects %s', async (_label, args) => {
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
