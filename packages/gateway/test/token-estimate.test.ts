import { describe, expect, it } from 'vitest';
import { estimateInputTokens, wireTokensOf } from '@momonga/gateway';

const textInput = (text: string) => [{ type: 'message' as const, role: 'user' as const, content: [{ type: 'input_text' as const, text }] }];

const tokensOfText = (text: string): number => estimateInputTokens({ input: textInput(text) }) - estimateInputTokens({ input: textInput('') });

describe('token estimation by the text itself', () => {
  it('counts a quarter token per Latin character', () => {
    expect(tokensOfText('a'.repeat(400))).toBe(100);
  });

  it.each([
    ['Japanese', 'こんにちは世界、これは日本語の文章です。'],
    ['Chinese', '这是一个用于测试令牌估算的中文句子。'],
    ['Korean', '이것은 토큰 추정을 시험하기 위한 문장입니다'],
    ['Hindi', 'यह टोकन अनुमान का परीक्षण करने वाला वाक्य है'],
  ])('counts at least one token per %s character', (_name, text) => {
    const letters = [...text].filter((character) => /\p{L}|\p{P}/u.test(character) && character !== ' ').length;
    expect(tokensOfText(text)).toBeGreaterThanOrEqual(letters);
  });

  it('counts the ideographic punctuation of CJK text as full tokens', () => {
    expect(tokensOfText('。'.repeat(40))).toBeGreaterThanOrEqual(40);
  });

  it('counts an emoji as at least one token', () => {
    expect(tokensOfText('😀'.repeat(10))).toBeGreaterThanOrEqual(10);
  });

  it('applies the same rule to a wire body', () => {
    expect(wireTokensOf({ messages: [{ role: 'user', content: '日本語'.repeat(100) }] })).toBeGreaterThanOrEqual(300);
  });
});
