import { describe, expect, it } from 'vitest';
import { formatLog } from '@momonga/context';

const progressLine = (index: number): string => `step ${String(index).padStart(3, '0')} ok`;

const progress = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_unused, offset) => progressLine(from + offset));

describe('the log formatter', () => {
  it('collapses consecutive identical lines into one line with its count', () => {
    const raw = ['compiling', 'warn: deprecated api', 'warn: deprecated api', 'warn: deprecated api', 'done'].join('\n');
    expect(formatLog(raw)).toBe(['compiling', 'warn: deprecated api [×3]', 'done'].join('\n'));
  });

  it('leaves identical lines that are not consecutive alone', () => {
    const raw = ['fetch a1', 'parse b2', 'fetch a1'].join('\n');
    expect(formatLog(raw)).toBe(raw);
  });

  it('does not collapse consecutive blank lines', () => {
    const raw = ['a', '', '', 'b'].join('\n');
    expect(formatLog(raw)).toBe(raw);
  });

  describe('a long log with a failure block in its middle', () => {
    const failureLine = 'FAILED src/math.test.ts:42 sum_handles_overflow expected 7 got 9';
    const continuation = '    at sumOverflow (src/math.ts:17:3)';
    const raw = (): string => [...progress(1, 300), '', failureLine, continuation, '', ...progress(301, 600)].join('\n');

    it('keeps every line: the formatter never omits text', () => {
      expect(formatLog(raw())).toBe(raw());
    });

    it('keeps the failure block with its indented continuation', () => {
      expect(formatLog(raw())).toContain(`${failureLine}\n${continuation}`);
    });
  });
});
