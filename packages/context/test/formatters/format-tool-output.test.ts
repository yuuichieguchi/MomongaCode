import { describe, expect, it } from 'vitest';
import { FAILURE_MARKERS, formatGrep, formatJson, formatLog, formatToolOutput } from '@momonga/context';

const GREP = { name: 'Grep', kind: 'search' } as const;
const BASH = { name: 'Bash', kind: 'execute' } as const;
const FETCH = { name: 'WebFetch', kind: 'fetch' } as const;

const grepRaw = (): string =>
  [
    ...Array.from({ length: 30 }, (_unused, index) => `packages/core/src/service.ts:${index * 3 + 1}:  throw new Error('unreachable');`),
    ...Array.from({ length: 10 }, (_unused, index) => `/opt/vendor/lib/legacy.ts:${index + 1}:  throw new Error('unreachable');`),
  ].join('\n');

const logRaw = (): string =>
  [
    ...Array.from({ length: 400 }, (_unused, index) => `compiled module ${index + 1}`),
    '',
    `${FAILURE_MARKERS[0] as string} src/math.test.ts:42 sum_handles_overflow expected 7 got 9`,
    '',
    ...Array.from({ length: 400 }, (_unused, index) => `linked chunk ${index + 1}`),
  ].join('\n');

const jsonRaw = (): string =>
  JSON.stringify({ items: Array.from({ length: 50 }, (_unused, index) => ({ id: index + 1, label: `item-${index + 1}`, ok: true })) }, null, 2);

describe('formatToolOutput', () => {
  it('formats a Grep output with the grep formatter when grep is enabled', () => {
    const raw = grepRaw();
    const result = formatToolOutput({ output: raw, tool: GREP, enabled: ['grep'], terms: [] });
    expect(result?.formatter).toBe('grep');
    expect(Number.isInteger(result?.version)).toBe(true);
    expect(result?.version).toBeGreaterThan(0);
    expect(result?.output).toContain(formatGrep(raw) as string);
  });

  it('formats the output of an execute tool with the log formatter when log is enabled', () => {
    const raw = logRaw();
    const result = formatToolOutput({ output: raw, tool: BASH, enabled: ['log'], terms: [] });
    expect(result?.formatter).toBe('log');
    expect(result?.output).toContain(formatLog(raw));
  });

  it('formats a JSON output with the json formatter when json is enabled, using the task terms', () => {
    const raw = jsonRaw();
    const result = formatToolOutput({ output: raw, tool: FETCH, enabled: ['json'], terms: ['item-33'] });
    expect(result?.formatter).toBe('json');
    expect(result?.output).toContain(formatJson(raw, ['item-33']) as string);
    expect(result?.output).toContain('item-33');
  });

  it('formats nothing when no formatter is enabled', () => {
    expect(formatToolOutput({ output: grepRaw(), tool: GREP, enabled: [], terms: [] })).toBeUndefined();
    expect(formatToolOutput({ output: logRaw(), tool: BASH, enabled: [], terms: [] })).toBeUndefined();
  });

  it('formats nothing with a formatter that is not enabled', () => {
    expect(formatToolOutput({ output: grepRaw(), tool: GREP, enabled: ['log'], terms: [] })).toBeUndefined();
    expect(formatToolOutput({ output: logRaw(), tool: BASH, enabled: ['grep'], terms: [] })).toBeUndefined();
  });

  it('never applies the log formatter to a tool that is not of kind execute', () => {
    expect(formatToolOutput({ output: logRaw(), tool: FETCH, enabled: ['log'], terms: [] })).toBeUndefined();
  });

  it('never applies a completion-time formatter for identicalOutput, which renders at build time', () => {
    expect(formatToolOutput({ output: logRaw(), tool: BASH, enabled: ['identicalOutput'], terms: [] })).toBeUndefined();
  });

  it('uses the raw output when the formatted text would not be smaller (T4-3)', () => {
    expect(formatToolOutput({ output: 'one line\nanother line', tool: BASH, enabled: ['log'], terms: [] })).toBeUndefined();
  });

  it('uses the raw output when the grep formatter declines it', () => {
    expect(formatToolOutput({ output: 'src/a.ts\nsrc/b.ts', tool: GREP, enabled: ['grep'], terms: [] })).toBeUndefined();
  });

  it('uses the raw output when the json formatter declines it', () => {
    expect(formatToolOutput({ output: 'plain words, no json', tool: FETCH, enabled: ['json'], terms: [] })).toBeUndefined();
  });

  it('is pure: the same input gives the same result', () => {
    const input = { output: grepRaw(), tool: GREP, enabled: ['grep'] as const, terms: [] };
    expect(formatToolOutput({ ...input, enabled: [...input.enabled] })).toEqual(formatToolOutput({ ...input, enabled: [...input.enabled] }));
  });
});
