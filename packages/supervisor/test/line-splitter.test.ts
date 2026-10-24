import { describe, expect, it } from 'vitest';
import { createLineSplitter } from '../src/line-splitter.ts';

const collect = (maxBytes?: number) => {
  const lines: string[] = [];
  const splitter = maxBytes === undefined ? createLineSplitter((line) => lines.push(line)) : createLineSplitter((line) => lines.push(line), maxBytes);
  return { lines, splitter };
};

describe('line splitter', () => {
  it('splits on newline only and keeps embedded carriage returns', () => {
    const { lines, splitter } = collect();
    splitter.push(Buffer.from('alpha\r\nbeta\rgamma\n\ndelta\n'));
    expect(lines).toEqual(['alpha\r', 'beta\rgamma', '', 'delta']);
  });

  it('joins a line written across several chunks', () => {
    const { lines, splitter } = collect();
    splitter.push(Buffer.from('hel'));
    splitter.push(Buffer.from('lo wo'));
    expect(lines).toEqual([]);
    splitter.push(Buffer.from('rld\nnext'));
    expect(lines).toEqual(['hello world']);
  });

  it('partial last line is flushed on exit', () => {
    const { lines, splitter } = collect();
    splitter.push(Buffer.from('complete\npartial tail'));
    expect(lines).toEqual(['complete']);
    splitter.end();
    expect(lines).toEqual(['complete', 'partial tail']);
  });

  it('end without a pending partial line emits nothing more', () => {
    const { lines, splitter } = collect();
    splitter.push(Buffer.from('one\n'));
    splitter.end();
    expect(lines).toEqual(['one']);
  });

  it('multi-byte characters split across chunks decode correctly', () => {
    const { lines, splitter } = collect();
    const bytes = Buffer.from('é€😀\n');
    for (let index = 0; index < bytes.length; index += 1) splitter.push(bytes.subarray(index, index + 1));
    expect(lines).toEqual(['é€😀']);
    expect(lines[0]).not.toContain('�');
  });

  it('the line splitter bound is in bytes', () => {
    const { lines, splitter } = collect();
    const input = '€'.repeat(23_334);
    expect(Buffer.byteLength(input)).toBe(70_002);
    splitter.push(Buffer.from(`${input}\n`));
    expect(lines.map((line) => Buffer.byteLength(line))).toEqual([65_535, 4467]);
    expect(lines.map((line) => line.length)).toEqual([21_845, 1489]);
    expect(lines.join('')).toBe(input);
    for (const line of lines) expect(line).not.toContain('�');
  });

  it('an ASCII line exactly at the bound is one line and one byte more is two', () => {
    const { lines, splitter } = collect();
    splitter.push(Buffer.from(`${'a'.repeat(65_536)}\n${'b'.repeat(65_537)}\n`));
    expect(lines.map((line) => line.length)).toEqual([65_536, 65_536, 1]);
  });

  it('honours a custom bound split across chunks', () => {
    const { lines, splitter } = collect(4);
    splitter.push(Buffer.from('abc'));
    splitter.push(Buffer.from('defgh\n'));
    expect(lines).toEqual(['abcd', 'efgh']);
  });
});
