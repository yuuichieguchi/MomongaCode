import { describe, expect, it } from 'vitest';
import { FAILURE_MARKERS, formattedHeader, formattingViolations } from '@momonga/context';

const HANDLE = 'ab'.repeat(32);

const filler = Array.from({ length: 80 }, (_unused, index) => `step ${index + 1} ok`);

const failureLine = (): string => `${FAILURE_MARKERS[0] as string} src/math.test.ts:42 sum_handles_overflow expected 7 got 9`;

const rawWithFailure = (): string => [...filler, failureLine(), ...filler].join('\n');

describe('the invariants of a formatted output', () => {
  it('accepts a shorter text that keeps the failure line and invents nothing', () => {
    const formatted = ['step 1 ok', '[158 lines omitted]', failureLine()].join('\n');
    expect(formattingViolations({ raw: rawWithFailure(), formatted, handle: HANDLE, header: formattedHeader('log', HANDLE) })).toEqual([]);
  });

  it('T4-1: refuses a path that does not occur in the raw output', () => {
    const formatted = ['step 1 ok', failureLine(), 'see src/invented/module.ts'].join('\n');
    expect(formattingViolations({ raw: rawWithFailure(), formatted, handle: HANDLE, header: formattedHeader('log', HANDLE) })).toContain('T4-1');
  });

  it('T4-1: allows the raw handle, which the raw output never holds', () => {
    const formatted = ['step 1 ok', failureLine(), `raw output stored as ${HANDLE}`].join('\n');
    expect(formattingViolations({ raw: rawWithFailure(), formatted, handle: HANDLE, header: formattedHeader('log', HANDLE) })).not.toContain('T4-1');
  });

  it('T4-1: refuses a hex identifier other than the raw handle that the raw output lacks', () => {
    const formatted = ['step 1 ok', failureLine(), 'commit 9f3c2e1d7a'].join('\n');
    expect(formattingViolations({ raw: rawWithFailure(), formatted, handle: HANDLE, header: formattedHeader('log', HANDLE) })).toContain('T4-1');
  });

  it('T4-2: refuses a text that loses a path of a failure line', () => {
    const formatted = ['step 1 ok', `${FAILURE_MARKERS[0] as string} sum_handles_overflow expected 7 got 9`].join('\n');
    expect(formattingViolations({ raw: rawWithFailure(), formatted, handle: HANDLE, header: formattedHeader('log', HANDLE) })).toContain('T4-2');
  });

  it('T4-2: refuses a text that loses an identifier of a failure line', () => {
    const formatted = ['step 1 ok', `${FAILURE_MARKERS[0] as string} src/math.test.ts:42 expected 7 got 9`].join('\n');
    expect(formattingViolations({ raw: rawWithFailure(), formatted, handle: HANDLE, header: formattedHeader('log', HANDLE) })).toContain('T4-2');
  });

  it('T4-2: refuses a text that loses a number of a failure line', () => {
    const formatted = ['step 1 ok', `${FAILURE_MARKERS[0] as string} src/math.test.ts:42 sum_handles_overflow expected 7`].join('\n');
    expect(formattingViolations({ raw: rawWithFailure(), formatted, handle: HANDLE, header: formattedHeader('log', HANDLE) })).toContain('T4-2');
  });

  it('T4-3: refuses a text that is not smaller than the raw output', () => {
    const raw = 'alpha beta gamma';
    expect(formattingViolations({ raw, formatted: `${raw}\n${raw}`, handle: HANDLE, header: formattedHeader('log', HANDLE) })).toContain('T4-3');
  });

  it('T4-3: measures size in UTF-8 bytes, so fewer characters of more bytes are refused', () => {
    const raw = 'aaaaa';
    const formatted = 'ééé';
    expect(formatted.length).toBeLessThan(raw.length);
    expect(formattingViolations({ raw, formatted, handle: HANDLE, header: formattedHeader('log', HANDLE) })).toContain('T4-3');
  });

  it('T4-3: refuses a text of the same size as the raw output', () => {
    const raw = 'alpha beta gamma';
    expect(formattingViolations({ raw, formatted: raw, handle: HANDLE, header: formattedHeader('log', HANDLE) })).toContain('T4-3');
  });
});
