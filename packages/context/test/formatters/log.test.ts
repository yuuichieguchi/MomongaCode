import { describe, expect, it } from 'vitest';
import { HISTORY_OUTPUT_HEAD_CHARS, HISTORY_OUTPUT_TAIL_CHARS } from '@momonga/foundation';
import { FAILURE_MARKERS, formatLog } from '@momonga/context';

const progressLine = (index: number): string => `step ${String(index).padStart(3, '0')} ok`;

const progress = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_unused, offset) => progressLine(from + offset));

const OMITTED = /(\d+) lines omitted/;

const omittedTotal = (text: string): number =>
  text
    .split('\n')
    .map((line) => OMITTED.exec(line))
    .reduce((sum, match) => sum + (match === null ? 0 : Number(match[1])), 0);

describe('the log formatter', () => {
  it('names a stated, non-empty list of failure markers', () => {
    expect(FAILURE_MARKERS.length).toBeGreaterThan(0);
    for (const marker of FAILURE_MARKERS) expect(marker.trim()).not.toBe('');
  });

  it('collapses consecutive identical lines into one line with its count', () => {
    const raw = ['compiling', 'warn: deprecated api', 'warn: deprecated api', 'warn: deprecated api', 'done'].join('\n');
    expect(formatLog(raw)).toBe(['compiling', 'warn: deprecated api [×3]', 'done'].join('\n'));
  });

  it('leaves identical lines that are not consecutive alone', () => {
    const raw = ['fetch a1', 'parse b2', 'fetch a1'].join('\n');
    expect(formatLog(raw)).toBe(raw);
  });

  describe('a long log with a failure block in its middle', () => {
    const marker = (): string => FAILURE_MARKERS[0] as string;
    const failureLine = (): string => `${marker()} src/math.test.ts:42 sum_handles_overflow expected 7 got 9`;
    const continuation = '    at sumOverflow (src/math.ts:17:3)';
    const before = progress(1, 300);
    const after = progress(301, 600);
    const raw = (): string => [...before, '', failureLine(), continuation, '', ...after].join('\n');
    const formatted = (): string => formatLog(raw());

    it('is long enough that head and tail cannot cover it', () => {
      expect(raw().length).toBeGreaterThan(HISTORY_OUTPUT_HEAD_CHARS + HISTORY_OUTPUT_TAIL_CHARS + 2000);
    });

    it('keeps the head of the raw output', () => {
      expect(formatted().startsWith(progress(1, 10).join('\n'))).toBe(true);
    });

    it('keeps the tail of the raw output', () => {
      expect(formatted().endsWith(progress(591, 600).join('\n'))).toBe(true);
    });

    it('keeps the whole failure block with its indented continuation', () => {
      expect(formatted()).toContain(`${failureLine()}\n${continuation}`);
    });

    it('omits the middle lines that are neither head, tail nor failure', () => {
      expect(formatted().split('\n')).not.toContain(progressLine(200));
      expect(formatted().split('\n')).not.toContain(progressLine(400));
    });

    it('writes in place exactly as many omitted lines as it dropped', () => {
      const text = formatted();
      const keptLines = new Set(text.split('\n'));
      const dropped = [...before, ...after].filter((line) => !keptLines.has(line)).length;
      expect(dropped).toBeGreaterThan(0);
      expect(omittedTotal(text)).toBe(dropped);
    });

    it('writes one omission between the head and the failure block and another between the failure block and the tail', () => {
      const lines = formatted().split('\n');
      const failureAt = lines.indexOf(failureLine());
      const omissions = lines.flatMap((line, index) => (OMITTED.test(line) ? [index] : []));
      expect(failureAt).toBeGreaterThan(0);
      expect(omissions.some((index) => index < failureAt)).toBe(true);
      expect(omissions.some((index) => index > failureAt)).toBe(true);
    });

    it('is shorter than the raw output', () => {
      expect(formatted().length).toBeLessThan(raw().length);
    });
  });
});
