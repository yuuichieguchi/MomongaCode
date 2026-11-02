import { describe, expect, it } from 'vitest';
import { tokensForText } from '../src/core/estimate.ts';

describe('tokensForText by script class', () => {
  it('counts Latin text at four units per token', () => {
    expect(tokensForText('a'.repeat(400))).toBe(100);
  });

  it.for([
    { name: 'Cyrillic', text: 'я'.repeat(400) },
    { name: 'Greek', text: 'α'.repeat(400) },
    { name: 'Arabic', text: 'ب'.repeat(400) },
    { name: 'Hebrew', text: 'א'.repeat(400) },
  ])('counts word-like $name text at two characters per token', ({ text }) => {
    expect(tokensForText(text)).toBe(200);
  });

  it.for([
    { name: 'Han', text: '漢'.repeat(400) },
    { name: 'Hiragana', text: 'あ'.repeat(400) },
    { name: 'Hangul', text: '한'.repeat(400) },
    { name: 'Devanagari', text: 'क'.repeat(400) },
    { name: 'Thai', text: 'ก'.repeat(400) },
    { name: 'emoji', text: '😀'.repeat(400) },
  ])('counts $name text at one token per character', ({ text }) => {
    expect(tokensForText(text)).toBe(400);
  });

  it('sums the classes of mixed text', () => {
    expect(tokensForText(`${'a'.repeat(40)}${'я'.repeat(40)}${'漢'.repeat(40)}`)).toBe(10 + 20 + 40);
  });

  it('counts a Russian sentence well below its character count', () => {
    const sentence = 'Быстрая коричневая лиса прыгает через ленивую собаку';
    expect(tokensForText(sentence)).toBeLessThan(sentence.length * 0.6);
  });
});
