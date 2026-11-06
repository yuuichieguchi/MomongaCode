import { describe, expect, it } from 'vitest';
import { formattedHeader, formattingViolations } from '@momonga/context';

const HANDLE = 'ab'.repeat(32);

const filler = Array.from({ length: 80 }, (_unused, index) => `step ${index + 1} ok`);

const failureLine = (): string => 'FAILED src/math.test.ts:42 sum_handles_overflow expected 7 got 9';

const rawWithFailure = (): string => [...filler, failureLine(), ...filler].join('\n');

describe('the invariants of a formatted output', () => {
  it('accepts a shorter text that is the raw lines with identical consecutive lines collapsed', () => {
    const raw = [...Array.from({ length: 60 }, () => 'step 1 ok'), failureLine()].join('\n');
    const formatted = ['step 1 ok [×60]', failureLine()].join('\n');
    expect(formattingViolations({ raw, formatted, handle: HANDLE, header: formattedHeader('log', HANDLE), formatter: 'log' })).toEqual([]);
  });

  it('T4-1: refuses a path that does not occur in the raw output', () => {
    const formatted = ['step 1 ok', failureLine(), 'see src/invented/module.ts'].join('\n');
    expect(formattingViolations({ raw: rawWithFailure(), formatted, handle: HANDLE, header: formattedHeader('log', HANDLE), formatter: 'log' })).toContain('T4-1');
  });

  it('T4-1: allows the raw handle, which the raw output never holds', () => {
    const formatted = ['step 1 ok', failureLine(), `raw output stored as ${HANDLE}`].join('\n');
    expect(formattingViolations({ raw: rawWithFailure(), formatted, handle: HANDLE, header: formattedHeader('log', HANDLE), formatter: 'log' })).not.toContain('T4-1');
  });

  it('T4-1: refuses a hex identifier other than the raw handle that the raw output lacks', () => {
    const formatted = ['step 1 ok', failureLine(), 'commit 9f3c2e1d7a'].join('\n');
    expect(formattingViolations({ raw: rawWithFailure(), formatted, handle: HANDLE, header: formattedHeader('log', HANDLE), formatter: 'log' })).toContain('T4-1');
  });

  it('T4-2: refuses a text whose expansion is not the raw lines, whichever line was lost', () => {
    const lost = rawWithFailure().split('\n').filter((line) => line !== 'step 40 ok').join('\n');
    expect(formattingViolations({ raw: rawWithFailure(), formatted: lost, handle: HANDLE, header: formattedHeader('log', HANDLE), formatter: 'log' })).toContain('T4-2');
  });

  it('T4-2: accepts a text whose expansion is the raw lines', () => {
    const raw = ['x', ...Array.from({ length: 30 }, () => 'y'), 'z'].join('\n');
    expect(formattingViolations({ raw, formatted: ['x', 'y [×30]', 'z'].join('\n'), handle: HANDLE, header: '', formatter: 'log' })).toEqual([]);
  });

  it('T4-3: refuses a text that is not smaller than the raw output', () => {
    const raw = 'alpha beta gamma';
    expect(formattingViolations({ raw, formatted: `${raw}\n${raw}`, handle: HANDLE, header: formattedHeader('log', HANDLE), formatter: 'log' })).toContain('T4-3');
  });

  it('T4-3: measures size in UTF-8 bytes, so fewer characters of more bytes are refused', () => {
    const raw = 'aaaaa';
    const formatted = 'ééé';
    expect(formatted.length).toBeLessThan(raw.length);
    expect(formattingViolations({ raw, formatted, handle: HANDLE, header: formattedHeader('log', HANDLE), formatter: 'log' })).toContain('T4-3');
  });

  it('T4-3: refuses a text of the same size as the raw output', () => {
    const raw = 'alpha beta gamma';
    expect(formattingViolations({ raw, formatted: raw, handle: HANDLE, header: formattedHeader('log', HANDLE), formatter: 'log' })).toContain('T4-3');
  });
});
