import { describe, expect, it } from 'vitest';
import { formattedHeader, formattingViolations } from '@momonga/context';

const HANDLE = 'ab'.repeat(32);

const filler = (from: number, count: number): string[] => Array.from({ length: count }, (_unused, index) => `step ${from + index} ok`);

const DROPPED_LINES = [
  'the widget count drifted to 9 in src/widget.ts:88',
  'error[E0308]: mismatched types',
  '    x_test.go:12: got 1 want 2',
  'テストが失敗しました (src/計算.ts:42)',
];

const rawWith = (line: string): string => [...filler(1, 40), line, ...filler(41, 40)].join('\n');

const droppedFrom = (raw: string, line: string): string =>
  raw
    .split('\n')
    .filter((entry) => entry !== line)
    .join('\n');

describe('T4-2prime does not depend on a vocabulary', () => {
  it.each(DROPPED_LINES)('a log formatting that drops the line %j is rejected whatever the line says', (line) => {
    const raw = rawWith(line);
    const violations = formattingViolations({ raw, formatted: droppedFrom(raw, line), handle: HANDLE, header: formattedHeader('log', HANDLE), formatter: 'log' });
    expect(violations).toContain('T4-2');
  });

  it('a log formatting that drops one ordinary progress line is rejected too', () => {
    const raw = rawWith('the widget count drifted to 9 in src/widget.ts:88');
    const violations = formattingViolations({ raw, formatted: droppedFrom(raw, 'step 17 ok'), handle: HANDLE, header: formattedHeader('log', HANDLE), formatter: 'log' });
    expect(violations).toContain('T4-2');
  });

  it('a log formatting that only collapses identical consecutive lines into line [×N] is exact and accepted', () => {
    const repeated = Array.from({ length: 30 }, () => 'warning: deprecated api');
    const raw = [...filler(1, 5), ...repeated, ...filler(6, 5)].join('\n');
    const formatted = [...filler(1, 5), 'warning: deprecated api [×30]', ...filler(6, 5)].join('\n');
    expect(formattingViolations({ raw, formatted, handle: HANDLE, header: formattedHeader('log', HANDLE), formatter: 'log' })).toEqual([]);
    const miscounted = [...filler(1, 5), 'warning: deprecated api [×29]', ...filler(6, 5)].join('\n');
    expect(formattingViolations({ raw, formatted: miscounted, handle: HANDLE, header: formattedHeader('log', HANDLE), formatter: 'log' })).toContain('T4-2');
  });
});
