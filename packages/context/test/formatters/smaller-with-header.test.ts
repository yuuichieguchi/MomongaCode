import { describe, expect, it } from 'vitest';
import * as context from '@momonga/context';
import { HANDLE_READER_TOOL, formatToolOutput } from '@momonga/context';

const RAW_HANDLE = 'f'.repeat(64);

type HeaderOf = (formatter: 'log' | 'json' | 'grep', handle: string) => string;

const headerOf = (): HeaderOf => {
  const exported = (context as Record<string, unknown>)['formattedHeader'];
  if (typeof exported !== 'function') throw new Error('@momonga/context exports no formattedHeader(formatter, handle)');
  return exported as HeaderOf;
};

const utf8 = (text: string): number => new TextEncoder().encode(text).length;

const ticks = (count: number): string => ['start', ...Array.from({ length: count }, () => 'tick'), 'end'].join('\n');

const execute = { name: 'Bash', kind: 'execute' };

describe('T4-3 is decided once, on the text the model sees, header included (section 6; review C-5)', () => {
  it('builds the header in the context formatter module and names the reader through HANDLE_READER_TOOL', () => {
    const header = headerOf()('log', RAW_HANDLE);

    expect(header).toBe(`[formatted by log; raw output ${RAW_HANDLE}; read it with ${HANDLE_READER_TOOL}]`);
  });

  it('does not use a formatted output that is smaller than the raw output without its header but not with it', () => {
    const raw = ticks(20);
    const formatted = 'start\ntick [×20]\nend';
    expect(utf8(raw)).toBe(109);
    expect(utf8(formatted)).toBe(21);
    expect(utf8(`[formatted by log; raw output ${RAW_HANDLE}; read it with ReadOutput]\n${formatted}`)).toBe(142);

    expect(formatToolOutput({ status: 'completed', output: raw, tool: execute, enabled: ['log'], terms: [] })).toBeUndefined();
  });

  it('uses a formatted output that is smaller than the raw output with its header', () => {
    const raw = ticks(200);
    expect(utf8(raw)).toBe(1009);

    expect(formatToolOutput({ status: 'completed', output: raw, tool: execute, enabled: ['log'], terms: [] })).toEqual({ output: 'start\ntick [×200]\nend', formatter: 'log', version: 1 });
  });
});
