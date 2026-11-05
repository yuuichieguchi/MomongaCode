import { describe, expect, it } from 'vitest';
import { formatLog, formatToolOutput } from '@momonga/context';

const COLLAPSED = /^(.*) \[×(\d+)\]$/;

const expanded = (formatted: string): string =>
  formatted
    .split('\n')
    .flatMap((line) => {
      const match = COLLAPSED.exec(line);
      return match === null ? [line] : Array.from({ length: Number(match[2]) }, () => match[1] as string);
    })
    .join('\n');

const seeded = (seed: number) => {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  return { int: (min: number, max: number): number => min + Math.floor(next() * (max - min + 1)) };
};

const FAILURE_FORMS = [
  'error[E0308]: mismatched types',
  '  --> src/lib.rs:42:9',
  '--- FAIL: TestX (0.00s)',
  '    x_test.go:12: got 1 want 2',
  'テストが失敗しました: 期待値 7、実際の値 9 (src/計算.ts:42)',
  'java.lang.AssertionError: expected:<7> but was:<9>',
  '\tat com.example.SumTest.overflow(SumTest.java:42)',
  'the widget count drifted to 9 in src/widget.ts:88',
];

const progressLine = (index: number): string => `compiling unit ${index} of the workspace`;

const generatedLog = (seed: number): string => {
  const random = seeded(seed);
  const length = random.int(0, 2000);
  const lines: string[] = [];
  while (lines.length < length) {
    const choice = random.int(0, 9);
    if (choice === 0) lines.push(FAILURE_FORMS[random.int(0, FAILURE_FORMS.length - 1)] as string);
    else if (choice === 1) lines.push('');
    else if (choice === 2) {
      const repeated = `warning: deprecated api ${random.int(0, 3)}`;
      const count = random.int(2, 20);
      for (let index = 0; index < count; index += 1) lines.push(repeated);
    } else lines.push(progressLine(lines.length));
  }
  return lines.slice(0, length).join('\n');
};

const midLog = (failure: readonly string[]): string =>
  [
    ...Array.from({ length: 60 }, () => 'warning: unused import `std::fmt`'),
    ...Array.from({ length: 200 }, (_unused, index) => progressLine(index)),
    '',
    ...failure,
    '',
    ...Array.from({ length: 200 }, (_unused, index) => progressLine(200 + index)),
  ].join('\n');

const CARGO = midLog(['error[E0308]: mismatched types', '  --> src/lib.rs:42:9', '   |', '42 |     let total: u32 = "seven";', '   |                      ^^^^^^^ expected `u32`, found `&str`']);
const GO = midLog(['--- FAIL: TestX (0.00s)', '    x_test.go:12: got 1 want 2', 'FAIL', 'exit status 1']);
const JAPANESE = midLog(['テストが失敗しました: 期待値 7、実際の値 9 (src/計算.ts:42)']);
const JUNIT = midLog(['java.lang.AssertionError: expected:<7> but was:<9>', '\tat com.example.SumTest.overflow(SumTest.java:42)']);
const NO_MARKER = midLog(['the widget count drifted to 9 in src/widget.ts:88']);

const BASH = { name: 'Bash', kind: 'execute' } as const;

describe('T4-2prime: the log formatter is exact, its inverse reproduces the raw lines', () => {
  it.each([
    ['a long cargo log with error[E0308] mid-log', CARGO],
    ['a long go test log with --- FAIL: mid-log', GO],
    ['a long log whose failure is written in Japanese', JAPANESE],
    ['a long JUnit log with an AssertionError mid-log', JUNIT],
    ['a long log whose failure line carries no known marker at all', NO_MARKER],
  ])('%s: expanding the formatted text reproduces the raw lines', (_name, raw) => {
    expect(expanded(formatLog(raw))).toBe(raw);
  });

  it('log: expanding the formatted text reproduces the raw lines for generated logs of 0 to 2000 lines', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const raw = generatedLog(seed);
      expect(expanded(formatLog(raw)), `seed ${seed}`).toBe(raw);
    }
  });

  it('never writes an omission of its own', () => {
    for (const raw of [CARGO, GO, JAPANESE, JUNIT, NO_MARKER]) expect(formatLog(raw)).not.toMatch(/lines omitted/);
  });

  it.each([
    ['cargo', CARGO, ['error[E0308]: mismatched types', '  --> src/lib.rs:42:9']],
    ['go', GO, ['--- FAIL: TestX (0.00s)', '    x_test.go:12: got 1 want 2']],
    ['marker-less', NO_MARKER, ['the widget count drifted to 9 in src/widget.ts:88']],
  ])('a failed %s call formatted with log keeps every raw line in the text the model sees', (_name, raw, lines) => {
    const result = formatToolOutput({ output: raw, tool: BASH, enabled: ['log'], terms: [], status: 'failed' });
    expect(result).toBeDefined();
    const shown = (result as { output: string }).output;
    for (const line of lines) expect(shown.split('\n')).toContain(line);
    expect(expanded(shown)).toBe(raw);
  });
});
