import { RequestError } from '@agentclientprotocol/sdk';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { promptInputOf } from '../src/acp/prompt-input.ts';

const text = (value: string): ContentBlock => ({ type: 'text', text: value });

describe('promptInputOf', () => {
  it('joins the blocks with new lines and renders links and text resources into the text', () => {
    const blocks: ContentBlock[] = [
      text('Look at'),
      { type: 'resource_link', name: 'a.txt', uri: 'file:///w/a.txt' },
      { type: 'resource', resource: { uri: 'file:///w/b.txt', mimeType: 'text/plain', text: 'bee' } },
    ];

    expect(promptInputOf(blocks, [])).toEqual({ input: 'Look at\n[a.txt](file:///w/a.txt)\n<resource uri="file:///w/b.txt">\nbee\n</resource>' });
  });

  it('names the skill when the prompt starts with a slash and the name of a skill of the session', () => {
    expect(promptInputOf([text('/pdf summarize it')], ['pdf'])).toEqual({ input: '/pdf summarize it', skill: 'pdf' });
    expect(promptInputOf([text('  /pdf  ')], ['pdf'])).toEqual({ input: '  /pdf  ', skill: 'pdf' });
  });

  it.each([
    ['a name that is not a skill', '/unknown go', ['pdf']],
    ['a slash in the middle', 'please /pdf this', ['pdf']],
    ['a path', '/usr/bin/env', ['pdf']],
    ['no skills at all', '/pdf go', []],
  ])('sends %s as plain text', (_label, value, skills) => {
    expect(promptInputOf([text(value)], skills)).toEqual({ input: value });
  });

  it.each([
    ['an image', { type: 'image', data: 'AA==', mimeType: 'image/png' }],
    ['audio', { type: 'audio', data: 'AA==', mimeType: 'audio/wav' }],
  ] as const)('refuses %s with invalid params', (_label, block) => {
    expect(() => promptInputOf([block], [])).toThrow(RequestError);
    try {
      promptInputOf([block], []);
    } catch (error) {
      expect((error as RequestError).code).toBe(-32602);
    }
  });

  it('names an embedded binary resource with its uri, type and size instead of its bytes', () => {
    const blob = Buffer.from('0123456789').toString('base64');

    expect(promptInputOf([{ type: 'resource', resource: { uri: 'file:///w/x.bin', mimeType: 'application/octet-stream', blob } }], [])).toEqual({
      input: '<resource uri="file:///w/x.bin" mimeType="application/octet-stream" binary="true" bytes="10" />',
    });
    expect(promptInputOf([{ type: 'resource', resource: { uri: 'file:///w/y.bin', blob } }], [])).toEqual({
      input: '<resource uri="file:///w/y.bin" binary="true" bytes="10" />',
    });
  });

  it('refuses a prompt without text', () => {
    expect(() => promptInputOf([], [])).toThrow('the prompt has no text');
    expect(() => promptInputOf([text('  \n')], [])).toThrow('the prompt has no text');
  });
});
