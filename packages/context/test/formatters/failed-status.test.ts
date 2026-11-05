import { describe, expect, it } from 'vitest';
import { formatJson, formatToolOutput } from '@momonga/context';

const BASH = { name: 'Bash', kind: 'execute' } as const;
const FETCH = { name: 'WebFetch', kind: 'fetch' } as const;

const jsonArray = (): string => JSON.stringify(Array.from({ length: 50 }, (_unused, index) => ({ id: index + 1, label: `item-${index + 1}`, ok: index !== 32 })), null, 2);

describe('the record status decides whether a reduction that is not exact may apply', () => {
  it('a failed call is never reduced by json, while the same output of a completed call is', () => {
    const raw = jsonArray();
    const completed = formatToolOutput({ output: raw, tool: FETCH, enabled: ['json'], terms: [], status: 'completed' });
    expect(completed?.formatter).toBe('json');
    expect(completed?.output).toBe(formatJson(raw, []));
    expect(formatToolOutput({ output: raw, tool: FETCH, enabled: ['json'], terms: [], status: 'failed' })).toBeUndefined();
  });

  it('a failed Bash call that prints a JSON array is not reduced by json even with log enabled', () => {
    const raw = jsonArray();
    const result = formatToolOutput({ output: `${raw}\n[exit code 1]`, tool: BASH, enabled: ['json', 'log'], terms: [], status: 'failed' });
    expect(result?.formatter).not.toBe('json');
    expect(formatToolOutput({ output: raw, tool: BASH, enabled: ['json'], terms: [], status: 'failed' })).toBeUndefined();
  });
});
