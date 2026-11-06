import { describe, expect, it } from 'vitest';
import { formatGrep, formatJson, formatLog, formatToolOutput } from '@momonga/context';

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
    ...Array.from({ length: 120 }, () => 'warning: deprecated api'),
    '',
    'FAILED src/math.test.ts:42 sum_handles_overflow expected 7 got 9',
    '',
    ...Array.from({ length: 400 }, (_unused, index) => `linked chunk ${index + 1}`),
  ].join('\n');

const jsonRaw = (): string =>
  JSON.stringify({ items: Array.from({ length: 50 }, (_unused, index) => ({ id: index + 1, label: `item-${index + 1}`, ok: true })) }, null, 2);

describe('formatToolOutput', () => {
  it('formats a Grep output with the grep formatter when grep is enabled', () => {
    const raw = grepRaw();
    const result = formatToolOutput({ status: 'completed', output: raw, tool: GREP, enabled: ['grep'], reader: 'ReadOutput', terms: [] });
    expect(result?.formatter).toBe('grep');
    expect(Number.isInteger(result?.version)).toBe(true);
    expect(result?.version).toBeGreaterThan(0);
    expect(result?.output).toContain(formatGrep(raw) as string);
  });

  it('formats the output of an execute tool with the log formatter when log is enabled', () => {
    const raw = logRaw();
    const result = formatToolOutput({ status: 'completed', output: raw, tool: BASH, enabled: ['log'], reader: 'ReadOutput', terms: [] });
    expect(result?.formatter).toBe('log');
    expect(result?.output).toContain(formatLog(raw));
  });

  it('formats a JSON output with the json formatter when json is enabled, using the task terms', () => {
    const raw = jsonRaw();
    const result = formatToolOutput({ status: 'completed', output: raw, tool: FETCH, enabled: ['json'], reader: 'ReadOutput', terms: ['item-33'] });
    expect(result?.formatter).toBe('json');
    expect(result?.output).toContain(formatJson(raw, ['item-33']) as string);
    expect(result?.output).toContain('item-33');
  });

  it('formats a Bash command that prints JSON with json, which takes precedence over log', () => {
    const raw = jsonRaw();
    const result = formatToolOutput({ status: 'completed', output: raw, tool: BASH, enabled: ['log', 'json'], reader: 'ReadOutput', terms: [] });
    expect(result?.formatter).toBe('json');
    expect(result?.output).toContain(formatJson(raw, []) as string);
  });

  it('falls back to log for a Bash command that prints JSON when only log is enabled', () => {
    expect(formatToolOutput({ status: 'completed', output: jsonRaw(), tool: BASH, enabled: ['log'], reader: 'ReadOutput', terms: [] })?.formatter).not.toBe('json');
  });

  it('formats the Grep output with grep even when json is enabled too', () => {
    expect(formatToolOutput({ status: 'completed', output: grepRaw(), tool: GREP, enabled: ['json', 'grep', 'log'], reader: 'ReadOutput', terms: [] })?.formatter).toBe('grep');
  });

  it('formats nothing when no formatter is enabled', () => {
    expect(formatToolOutput({ status: 'completed', output: grepRaw(), tool: GREP, enabled: [], reader: 'ReadOutput', terms: [] })).toBeUndefined();
    expect(formatToolOutput({ status: 'completed', output: logRaw(), tool: BASH, enabled: [], reader: 'ReadOutput', terms: [] })).toBeUndefined();
  });

  it('formats nothing with a formatter that is not enabled', () => {
    expect(formatToolOutput({ status: 'completed', output: grepRaw(), tool: GREP, enabled: ['log'], reader: 'ReadOutput', terms: [] })).toBeUndefined();
    expect(formatToolOutput({ status: 'completed', output: logRaw(), tool: BASH, enabled: ['grep'], reader: 'ReadOutput', terms: [] })).toBeUndefined();
  });

  it('never applies the log formatter to a tool that is not of kind execute', () => {
    expect(formatToolOutput({ status: 'completed', output: logRaw(), tool: FETCH, enabled: ['log'], reader: 'ReadOutput', terms: [] })).toBeUndefined();
  });

  it('never applies a completion-time formatter for identicalOutput, which renders at build time', () => {
    expect(formatToolOutput({ status: 'completed', output: logRaw(), tool: BASH, enabled: ['identicalOutput'], reader: 'ReadOutput', terms: [] })).toBeUndefined();
  });

  it('uses the raw output when the formatted text would not be smaller (T4-3)', () => {
    expect(formatToolOutput({ status: 'completed', output: 'one line\nanother line', tool: BASH, enabled: ['log'], reader: 'ReadOutput', terms: [] })).toBeUndefined();
  });

  it('uses the raw output when the grep formatter declines it', () => {
    expect(formatToolOutput({ status: 'completed', output: 'src/a.ts\nsrc/b.ts', tool: GREP, enabled: ['grep'], reader: 'ReadOutput', terms: [] })).toBeUndefined();
  });

  it('uses the raw output when the json formatter declines it', () => {
    expect(formatToolOutput({ status: 'completed', output: 'plain words, no json', tool: FETCH, enabled: ['json'], reader: 'ReadOutput', terms: [] })).toBeUndefined();
  });

  it('is pure: the same input gives the same result', () => {
    const input = { status: 'completed' as const, output: grepRaw(), tool: GREP, enabled: ['grep'] as const, reader: 'ReadOutput', terms: [] };
    expect(formatToolOutput({ ...input, enabled: [...input.enabled] })).toEqual(formatToolOutput({ ...input, enabled: [...input.enabled] }));
  });
});
