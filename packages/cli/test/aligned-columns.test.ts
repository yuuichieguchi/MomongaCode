import { describe, expect, it } from 'vitest';
import { alignedColumns } from '../src/aligned-columns.ts';

describe('alignedColumns', () => {
  it('pads every cell but the last to the widest of its column and joins the cells with two spaces', () => {
    expect(alignedColumns(['a', 'bb', 'c'], [['long', 'x', 'y'], ['s', 'wider', 'zz']])).toEqual(['a     bb     c', 'long  x      y', 's     wider  zz']);
  });

  it('measures wide characters by their display width', () => {
    expect(alignedColumns(['name', 'n'], [['日本', '1'], ['abcdef', '2']])).toEqual(['name    n', '日本    1', 'abcdef  2']);
  });

  it('pads an empty cell in the middle like any other cell', () => {
    expect(alignedColumns(['a', 'b', 'c'], [['x', '', 'z']])).toEqual(['a  b  c', 'x     z']);
  });

  it('ends no line in whitespace when its last cell is empty', () => {
    expect(alignedColumns(['first', 'second', 'third'], [['1', '2', ''], ['', '', '']])).toEqual(['first  second  third', '1      2', '']);
  });

  it('prints a single column unpadded', () => {
    expect(alignedColumns(['h'], [['longer'], ['x']])).toEqual(['h', 'longer', 'x']);
  });

  it('prints the header alone when there is no row', () => {
    expect(alignedColumns(['model', 'state'], [])).toEqual(['model  state']);
  });

  it('takes rows of exactly the header length', () => {
    // @ts-expect-error a row longer than the header is refused by the type
    alignedColumns(['a'], [['x', 'y']]);
    // @ts-expect-error a row shorter than the header is refused by the type
    alignedColumns(['a', 'b'], [['x']]);
  });
});
