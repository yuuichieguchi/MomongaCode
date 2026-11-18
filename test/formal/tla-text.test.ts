import { describe, expect, it } from 'vitest';
import { withoutComments } from './tla-text.ts';

describe('withoutComments (the TLA+ and cfg text that decides a row identity)', () => {
  it('drops a line comment up to the end of its line and keeps the line break', () => {
    expect(withoutComments('a == 1 \\* the value\nb == 2')).toBe('a == 1\nb == 2');
  });

  it('drops a block comment, nested ones included', () => {
    expect(withoutComments('a(* outer (* inner *) still outer *)== 1')).toBe('a == 1');
  });

  it('drops a block comment that spans lines', () => {
    expect(withoutComments('x\n(* one\n two *)\ny')).toBe('x\ny');
  });

  it('keeps comment markers inside a string literal', () => {
    expect(withoutComments('s == "a \\* b (* c *) d"')).toBe('s == "a \\* b (* c *) d"');
  });

  it('keeps an escaped quote inside a string literal from ending the string', () => {
    expect(withoutComments('s == "say \\" \\* kept" \\* gone')).toBe('s == "say \\" \\* kept"');
  });

  it('keeps leading indentation, which TLA+ bullet lists depend on', () => {
    expect(withoutComments('Foo ==\n    /\\ a\n    /\\ b \\* two')).toBe('Foo ==\n    /\\ a\n    /\\ b');
  });

  it('removes trailing spaces and lines that held only a comment', () => {
    expect(withoutComments('a == 1   \n\n   (* note *)  \n\nb == 2\n')).toBe('a == 1\nb == 2');
  });

  it('keeps the set difference operator, which is not a comment', () => {
    expect(withoutComments('S \\ T')).toBe('S \\ T');
  });

  it('leaves one space where a block comment stood inside a line', () => {
    expect(withoutComments('a(* x *)b')).toBe('a b');
  });

  it('gives the same text for a comment-free rewording of the same lines', () => {
    const commented = 'Next == Step \\* the step\n\n(* the crash\n   case *)\n    /\\ Crash';
    const bare = 'Next == Step\n    /\\ Crash';
    expect(withoutComments(commented)).toBe(withoutComments(bare));
  });
});
