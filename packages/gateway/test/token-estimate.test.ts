import { describe, expect, it } from 'vitest';
import { estimateInputTokens, wireTokensOf } from '@momonga/gateway';
import { PROMPT_PART_KEYS, type PromptPartKey } from '../src/core/prompt-parts.ts';
import { textOfWire } from '../src/core/wire-text.ts';

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

describe('the parts of a wire that a count covers', () => {
  const promptParts = {
    messages: [{ role: 'user', content: 'count these words' }],
    system: [{ type: 'text', text: 'Be terse.' }],
    instructions: 'Answer in one line.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'and these' }] }],
    tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }],
  };
  const decodingFields = {
    max_tokens: 4096,
    thinking: { type: 'enabled', budget_tokens: 2048 },
    text: { format: { type: 'json_schema', name: 'envelope', schema: { type: 'object', properties: { kind: { type: 'string' } } } } },
    reasoning: { effort: 'low' },
    response_format: { type: 'json_schema', json_schema: { name: 'envelope', schema: { type: 'object' } } },
  };

  it('estimates a wire as its prompt parts alone', () => {
    expect(wireTokensOf({ ...promptParts, ...decodingFields })).toBe(wireTokensOf(promptParts));
  });

  it('renders every key of PROMPT_PART_KEYS into the text a counter receives, and nothing else', () => {
    const valueOf: Record<PromptPartKey, (marker: string) => unknown> = {
      messages: (marker) => [{ role: 'user', content: marker }],
      system: (marker) => marker,
      instructions: (marker) => marker,
      input: (marker) => [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: marker }] }],
      tools: (marker) => [{ type: 'function', name: marker }],
    };
    const markerOf = (key: string): string => `marker-of-${key}`;
    const wire: Record<string, unknown> = {
      ...Object.fromEntries(PROMPT_PART_KEYS.map((key) => [key, valueOf[key](markerOf(key))])),
      response_format: { type: 'json_schema', name: markerOf('response_format') },
      max_tokens: 4096,
    };
    const text = textOfWire(wire);
    for (const key of PROMPT_PART_KEYS) expect(text).toContain(markerOf(key));
    expect(text).not.toContain(markerOf('response_format'));
  });
});
