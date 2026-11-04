import { describe, expect, it } from 'vitest';
import { formatGrep } from '@momonga/context';

const RAW = [
  "src/app/main.ts:3:import { load } from './load';",
  'src/app/main.ts:9:  return null;',
  "src/app/main.ts:14:  const url = 'http://localhost:8080/api';",
  'src/app/main.ts:20:  return null;',
  'src/app/main.ts:31:  return null;',
  '/opt/vendor/lib/b.ts:4:  return null;',
  '/opt/vendor/lib/b.ts:7:export const b = 2;',
  'test/main.test.ts:5:  return null;',
].join('\n');

const EXPECTED = [
  'src/app/main.ts',
  "3: import { load } from './load';",
  '9,20,31:   return null;',
  "14:   const url = 'http://localhost:8080/api';",
  '/opt/vendor/lib/b.ts',
  '4:   return null;',
  '7: export const b = 2;',
  'test/main.test.ts',
  '5:   return null;',
].join('\n');

describe('the grep formatter', () => {
  it('groups lines by path, relative and absolute alike, and joins identical texts of one file as L1,L2: text', () => {
    expect(formatGrep(RAW)).toBe(EXPECTED);
  });

  it('never joins identical texts across files', () => {
    const formatted = formatGrep(RAW) as string;
    expect(formatted).toContain('4:   return null;');
    expect(formatted).toContain('5:   return null;');
    expect(formatted).not.toMatch(/\b4,5\b/);
  });

  it('is exact: every path, line number and text of the raw output can be read back', () => {
    const formatted = formatGrep(RAW) as string;
    const readBack: string[] = [];
    let current = '';
    for (const line of formatted.split('\n')) {
      const entry = /^(\d+(?:,\d+)*): (.*)$/.exec(line);
      if (entry === null) {
        current = line;
        continue;
      }
      for (const number of (entry[1] as string).split(',')) readBack.push(`${current}:${number}:${entry[2] as string}`);
    }
    const order = (lines: string[]): string[] => [...lines].sort();
    expect(order(readBack)).toEqual(order(RAW.split('\n')));
  });

  it('declines an output of paths only', () => {
    expect(formatGrep(['src/app/main.ts', '/opt/vendor/lib/b.ts'].join('\n'))).toBeUndefined();
  });

  it('declines an output of counts', () => {
    expect(formatGrep(['src/app/main.ts:4', '/opt/vendor/lib/b.ts:1'].join('\n'))).toBeUndefined();
  });
});
