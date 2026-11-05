import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, textResponseEvents } from '@momonga/testkit';
import type { AdapterInputItem, AdapterRequest, ContentPart } from '@momonga/protocol';
import { buildNativeBody } from '../src/adapters/chat-completions/native-request.ts';
import { buildResponsesBody } from '../src/adapters/open-responses/request.ts';
import { summaryRequestOf } from '../src/adapters/shared/compact.ts';
import { UnsupportedInputError } from '../src/adapters/shared/failures.ts';
import { estimateInputTokens, wireTokensOf } from '../src/core/estimate.ts';
import { dimensionsOfBase64 } from '../src/core/image-size.ts';
import { withoutImages } from '../src/core/image-tokens.ts';
import { expectErrorBody, outputText, postJson, readJson, startGateway } from './gateway-helpers.ts';

const png = (width: number, height: number): string => {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString('base64');
};

describe('the per-image minimum of an image token model', () => {
  const tokensOf = (side: number): number =>
    withoutImages({ type: 'image_url', image_url: { url: `data:image/png;base64,${png(side, side)}` } }, { pixelsPerToken: 750, maxTokens: 1600, minTokens: 85 }).imageTokens;

  it('raises a small image to the minimum', () => {
    expect(tokensOf(100)).toBe(85);
  });

  it('leaves a size between the minimum and the cap on the pixel rate', () => {
    expect(tokensOf(1000)).toBe(1334);
  });

  it('holds a large image at the cap', () => {
    expect(tokensOf(2000)).toBe(1600);
  });

  it('estimates a fixed cost for a 100 px image at that cost', () => {
    const fixed = { pixelsPerToken: 455, maxTokens: 576, minTokens: 576 };
    expect(withoutImages({ type: 'image_url', image_url: { url: `data:image/png;base64,${png(100, 100)}` } }, fixed).imageTokens).toBe(576);
  });
});

const gif = (width: number, height: number): string => {
  const bytes = Buffer.alloc(13);
  bytes.write('GIF89a', 0, 'latin1');
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes.toString('base64');
};

const jpeg = (width: number, height: number): string => {
  const app = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x06]), Buffer.alloc(4)]);
  const frame = Buffer.alloc(19);
  frame.set([0xff, 0xc0, 0x00, 0x11, 0x08]);
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app, frame]).toString('base64');
};

const webpExtended = (width: number, height: number): string => {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'latin1');
  bytes.write('WEBP', 8, 'latin1');
  bytes.write('VP8X', 12, 'latin1');
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes.toString('base64');
};

const webpLossy = (width: number, height: number): string => {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'latin1');
  bytes.write('WEBP', 8, 'latin1');
  bytes.write('VP8 ', 12, 'latin1');
  bytes.set([0x9d, 0x01, 0x2a], 23);
  bytes.writeUInt16LE(width, 26);
  bytes.writeUInt16LE(height, 28);
  return bytes.toString('base64');
};

const webpLossless = (width: number, height: number): string => {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'latin1');
  bytes.write('WEBP', 8, 'latin1');
  bytes.write('VP8L', 12, 'latin1');
  bytes[20] = 0x2f;
  bytes.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
  return bytes.toString('base64');
};

describe('image dimensions', () => {
  it.for([
    { name: 'png', data: png(640, 480), expected: { width: 640, height: 480 } },
    { name: 'gif', data: gif(20, 30), expected: { width: 20, height: 30 } },
    { name: 'jpeg after an APP0 segment', data: jpeg(800, 600), expected: { width: 800, height: 600 } },
    { name: 'webp extended', data: webpExtended(1000, 200), expected: { width: 1000, height: 200 } },
    { name: 'webp lossy', data: webpLossy(300, 100), expected: { width: 300, height: 100 } },
    { name: 'webp lossless', data: webpLossless(64, 128), expected: { width: 64, height: 128 } },
  ])('reads $name', ({ data, expected }) => {
    expect(dimensionsOfBase64(data)).toEqual(expected);
  });

  it('returns undefined for unknown or truncated data', () => {
    expect(dimensionsOfBase64(Buffer.from('not an image at all, just text').toString('base64'))).toBeUndefined();
    expect(dimensionsOfBase64(png(0, 10))).toBeUndefined();
    expect(dimensionsOfBase64('iVBORw0K')).toBeUndefined();
  });
});

describe('image token estimate', () => {
  const imageInput = (url: string): AdapterInputItem[] => [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: url }] }];
  const MODEL = { pixelsPerToken: 750, maxTokens: 1600, minTokens: 1 };

  it('counts an image from its dimensions, not from the length of its base64', () => {
    const huge = `data:image/png;base64,${png(750, 100)}${'A'.repeat(2_000_000)}`;
    const tokens = estimateInputTokens({ input: imageInput(huge) }, MODEL);
    expect(tokens).toBeGreaterThanOrEqual(100);
    expect(tokens).toBeLessThan(200);
  });

  it('caps one image at the declared maximum and uses it when the size is unknown', () => {
    const big = estimateInputTokens({ input: imageInput(`data:image/png;base64,${png(4000, 4000)}`) }, MODEL);
    const remote = estimateInputTokens({ input: imageInput('https://example.com/a.png') }, MODEL);
    const base = estimateInputTokens({ input: [] });
    expect(big - base).toBeGreaterThanOrEqual(1600);
    expect(big - base).toBeLessThan(1700);
    expect(remote - base).toBeGreaterThanOrEqual(1600);
    expect(remote - base).toBeLessThan(1700);
  });

  it('derives the count from the declared model of the target', () => {
    const declared = { pixelsPerToken: 100, maxTokens: 500, minTokens: 1 };
    const sized = estimateInputTokens({ input: imageInput(`data:image/png;base64,${png(300, 100)}`) }, declared);
    const capped = estimateInputTokens({ input: imageInput(`data:image/png;base64,${png(750, 100)}`) }, declared);
    const unknown = estimateInputTokens({ input: imageInput('https://example.com/a.png') }, declared);
    const base = estimateInputTokens({ input: [] });
    expect(sized - base).toBeGreaterThanOrEqual(300);
    expect(sized - base).toBeLessThan(400);
    expect(capped - base).toBeGreaterThanOrEqual(500);
    expect(capped - base).toBeLessThan(600);
    expect(unknown - base).toBeGreaterThanOrEqual(500);
    expect(unknown - base).toBeLessThan(600);
  });

  it('refuses to estimate an image when the target declares no image token model', () => {
    expect(() => estimateInputTokens({ input: imageInput('https://example.com/a.png') })).toThrow(/imageTokens/);
    expect(() => wireTokensOf({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }] })).toThrow(/imageTokens/);
  });

  it('applies the same rule to chat-completions and Anthropic wires', () => {
    const data = png(750, 100);
    const chat = wireTokensOf({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } }] }] }, MODEL);
    const anthropic = wireTokensOf({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] }] }, MODEL);
    expect(chat).toBeLessThan(200);
    expect(anthropic).toBeLessThan(200);
  });
});

const PNG_URL = `data:image/png;base64,${png(32, 32)}`;
const userImage = (detail?: 'low' | 'high' | 'auto'): AdapterInputItem => ({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: 'see' }, { type: 'input_image', image_url: PNG_URL, ...(detail === undefined ? {} : { detail }) }],
});
const request = (input: AdapterInputItem[]): AdapterRequest => ({ model: 'm', input });

describe('chat-completions image conversion', () => {
  it('turns input_image into an image_url part and keeps the detail', () => {
    expect(buildNativeBody(request([userImage('low')]), 'json-schema-2020-12').messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image_url', image_url: { url: PNG_URL, detail: 'low' } }] },
    ]);
  });

  it('merges a following text user message into the same parts message', () => {
    const messages = buildNativeBody(request([userImage(), { type: 'message', role: 'user', content: 'and this' }]), 'json-schema-2020-12').messages;
    expect(messages).toHaveLength(1);
    expect((messages[0]?.['content'] as unknown[]).length).toBe(3);
  });

  it.for<{ name: string; item: AdapterInputItem }>([
    { name: 'an assistant message', item: { type: 'message', role: 'assistant', content: [{ type: 'input_image', image_url: PNG_URL }] } },
    { name: 'a system message', item: { type: 'message', role: 'system', content: [{ type: 'input_image', image_url: PNG_URL }] } },
    { name: 'a tool result', item: { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_image', image_url: PNG_URL }] } },
    { name: 'an image without image_url', item: { type: 'message', role: 'user', content: [{ type: 'input_image' }] } },
  ])('rejects an image in $name', ({ item }) => {
    expect(() => buildNativeBody(request([item]), 'json-schema-2020-12')).toThrow(UnsupportedInputError);
  });
});

describe('open-responses image conversion', () => {
  it('relays input_image parts of user messages and tool results unchanged', () => {
    const parts: ContentPart[] = [{ type: 'input_image', image_url: PNG_URL, detail: 'high' }];
    const body = buildResponsesBody(
      request([
        { type: 'message', role: 'user', content: parts },
        { type: 'function_call', call_id: 'c1', name: 'shot', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: parts },
      ]),
    );
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: parts },
      { type: 'function_call', call_id: 'c1', name: 'shot', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: parts },
    ]);
  });

  it('still rejects an image in an assistant message and input_file', () => {
    expect(() => buildResponsesBody(request([{ type: 'message', role: 'assistant', content: [{ type: 'input_image', image_url: PNG_URL }] }]))).toThrow(UnsupportedInputError);
    expect(() => buildResponsesBody(request([{ type: 'message', role: 'user', content: [{ type: 'input_file', file_url: 'https://e.com/a' }] }]))).toThrow(UnsupportedInputError);
  });
});

describe('compaction transcript with images', () => {
  const compactRequest = (input: AdapterInputItem[]) => ({ model: 'm', input });

  it('stays one text message when there is no image', () => {
    const [message] = summaryRequestOf(compactRequest([{ type: 'message', role: 'user', content: 'hi' }]), 200).input;
    expect(typeof (message as { content: unknown }).content).toBe('string');
  });

  it('keeps each image at its place between the text around it', () => {
    const [message] = summaryRequestOf(
      compactRequest([
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: PNG_URL }, { type: 'input_text', text: 'after' }] },
        { type: 'function_call', call_id: 'c1', name: 'shot', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_image', image_url: PNG_URL }] },
      ]),
      200,
    ).input;
    const content = (message as { content: ContentPart[] }).content;
    expect(content.map((part) => part.type)).toEqual(['input_text', 'input_image', 'input_text', 'input_image', 'input_text']);
    expect((content[0] as { text: string }).text).toBe('<transcript>\n<item role="user">look');
    expect((content[2] as { text: string }).text).toContain('after</item>\n<tool_call id="c1" name="shot">{}</tool_call>\n<tool_result id="c1">');
    expect((content[4] as { text: string }).text.startsWith('</tool_result>\n</transcript>\n')).toBe(true);
  });
});

describe('image capability filter', () => {
  const imageBody = {
    model: 'fast',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'see' }, { type: 'input_image', image_url: PNG_URL }] }],
  };

  it('skips a target without imageInput and uses the next one that declares it', async () => {
    const plain = createScriptedAdapter({ calls: [] });
    const seeing = createScriptedAdapter({ calls: [{ events: textResponseEvents({ model: 'model-b', chunks: ['seen'] }) }], capabilities: { imageInput: true, imageTokens: { pixelsPerToken: 750, maxTokens: 1600, minTokens: 1 } } });
    const { client } = await startGateway({
      adapters: { a: plain, b: seeing },
      config: { aliases: { fast: ['a', 'b'] }, targets: { a: { model: 'model-a' }, b: { model: 'model-b' } } },
    });
    const response = await readJson(await postJson(client, '/v1/responses', imageBody));
    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe('seen');
    expect(plain.calls).toHaveLength(0);
  });

  it('rejects with capability_unsupported when no target declares imageInput', async () => {
    const plain = createScriptedAdapter({ calls: [] });
    const { client } = await startGateway({ adapters: { a: plain }, config: { aliases: { fast: ['a'] }, targets: { a: { model: 'model-a' } } } });
    const response = await readJson(await postJson(client, '/v1/responses', imageBody));
    expect(response.status).toBe(400);
    expectErrorBody(response.body, { type: 'invalid_request', code: 'capability_unsupported' });
    expect(plain.calls).toHaveLength(0);
  });

  it('applies the same filter to count_tokens', async () => {
    const plain = createScriptedAdapter({ calls: [] });
    const { client } = await startGateway({ adapters: { a: plain }, config: { aliases: { fast: ['a'] }, targets: { a: { model: 'model-a' } } } });
    const response = await readJson(await postJson(client, '/v1/momonga/count_tokens', imageBody));
    expect(response.status).toBe(400);
    expectErrorBody(response.body, { type: 'invalid_request', code: 'capability_unsupported' });
  });
});
