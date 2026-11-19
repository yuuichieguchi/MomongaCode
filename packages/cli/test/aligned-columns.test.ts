import { describe, expect, it } from 'vitest';
import { alignedColumns } from '../src/aligned-columns.ts';

describe('alignedColumns', () => {
  it('pads each column to the widest of its header and its cells and joins the columns with two spaces', () => {
    expect(alignedColumns(['a', 'bb', 'c'], [['long', 'x', 'y'], ['s', 'wider', 'z']])).toEqual(['a     bb     c', 'long  x      y', 's     wider  z']);
  });

  it('measures wide characters by their display width', () => {
    expect(alignedColumns(['name', 'n'], [['日本', '1'], ['abcdef', '2']])).toEqual(['name    n', '日本    1', 'abcdef  2']);
  });

  it('keeps an empty cell as blank space inside a line', () => {
    expect(alignedColumns(['a', 'b', 'c'], [['x', '', 'z']])).toEqual(['a  b  c', 'x     z']);
  });

  it('ends every line at its last non-empty cell, with no trailing space', () => {
    expect(alignedColumns(['first', 'second', 'third'], [['1', '', ''], ['', '', '']])).toEqual(['first  second  third', '1', '']);
  });

  it('prints a single column unpadded', () => {
    expect(alignedColumns(['h'], [['longer'], ['x']])).toEqual(['h', 'longer', 'x']);
  });

  it('prints the header alone when there is no row', () => {
    expect(alignedColumns(['model', 'state'], [])).toEqual(['model  state']);
  });
});
