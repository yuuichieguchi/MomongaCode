import { TEST_FENCE } from '@momonga/testkit';
import { EVERY_REASONING_IS_OWN } from './own-reasoning.ts';
import { describe, expect, it } from 'vitest';
import type { AdapterInputItem, AdapterRequest, ContentPart } from '@momonga/protocol';
import { UnsupportedInputError } from '../src/adapters/shared/failures.ts';
import { buildMessagesBody } from '../src/adapters/anthropic/request.ts';
import { MODEL_FRAMING } from './cc-support.ts';

const MAX_TOKENS = 4096;
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAABmklEQVR42tyWAaTyUBzFew/eG4AHz+MBSAHKBiJRGFKwIgQQJKLUIioBIhCAiCAAEizAQIAECaASqFFJq84nudjnaqvuPnxtJjs=';
const PNG_URL = `data:image/png;base64,${PNG_BASE64}`;

const user = (text: string): AdapterInputItem => ({ type: 'message', role: 'user', content: text });
const assistant = (text: string): AdapterInputItem => ({ type: 'message', role: 'assistant', content: text });
const call = (id: string, name: string, args: string): AdapterInputItem => ({ type: 'function_call', call_id: id, name, arguments: args });
const output = (id: string, text: string): AdapterInputItem => ({ type: 'function_call_output', call_id: id, output: text });

const bodyOf = (input: AdapterInputItem[], extra: Partial<AdapterRequest> = {}) => buildMessagesBody({ model: 'm', input, fence: TEST_FENCE, ...extra }, MAX_TOKENS, { cache: undefined }, EVERY_REASONING_IS_OWN);

const tool = { type: 'function', name: 'read_file', description: 'Read', parameters: { type: 'object', properties: {} } } as const;

describe('buildMessagesBody', () => {
  it('sends instructions and each system or developer message as its own system text block', () => {
    const body = bodyOf(
      [{ type: 'message', role: 'system', content: 'sys' }, { type: 'message', role: 'developer', content: 'dev' }, user('hi')],
      { instructions: 'first' },
    );
    expect(body.system).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'sys' },
      { type: 'text', text: 'dev' },
    ]);
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('merges consecutive same-role items and puts tool results before text in a user turn', () => {
    const body = bodyOf([user('a'), assistant('thinking'), call('c1', 'read_file', '{}'), call('c2', 'read_file', '{"p":1}'), output('c1', 'r1'), user('next'), output('c2', 'r2')]);
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'thinking' },
          { type: 'tool_use', id: 'c1', name: 'read_file', input: {} },
          { type: 'tool_use', id: 'c2', name: 'read_file', input: { p: 1 } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'c1', content: 'r1' },
          { type: 'tool_result', tool_use_id: 'c2', content: 'r2' },
          { type: 'text', text: 'next' },
        ],
      },
    ]);
  });

  it('skips empty text, reasoning items and messages that end up empty', () => {
    const body = bodyOf([user(''), { type: 'reasoning', summary: [] }, assistant(''), user('real')]);
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'real' }] }]);
  });

  it('omits the content of an empty tool result', () => {
    expect(bodyOf([call('c1', 'read_file', '{}'), output('c1', '')]).messages[1]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1' }] });
  });

  it('renders a compaction summary as a user turn', () => {
    const body = bodyOf([{ type: 'compaction_summary', summary: 'earlier <work>' }]);
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: `<conversation_summary>\n${MODEL_FRAMING}\nearlier &lt;work>\n</conversation_summary>` }] },
    ]);
  });

  it('replaces a call whose arguments are not a JSON object, and its result, by a note in the assistant turn', () => {
    const inputs = [call('c1', 'read_file', '{oops'), output('c1', 'r1'), call('c2', 'read_file', '[1]'), call('c3', 'read_file', '')];
    const blocks = bodyOf(inputs).messages.flatMap((message) => (Array.isArray(message.content) ? message.content : []));
    expect(blocks.map((block) => block.type)).toEqual(['text', 'text', 'text']);
    expect(blocks.every((block) => (block as { text: string }).text.includes('A call to the tool read_file was cut off'))).toBe(true);
    expect(JSON.stringify(blocks)).not.toContain('r1');
  });

  it('rejects file input and an image in an assistant turn', () => {
    const file: AdapterInputItem = { type: 'message', role: 'user', content: [{ type: 'input_file', file_url: 'https://example.com/a.pdf' }] };
    const assistantImage: AdapterInputItem = { type: 'message', role: 'assistant', content: [{ type: 'input_image', image_url: PNG_URL }] };
    expect(() => bodyOf([file])).toThrow(UnsupportedInputError);
    expect(() => bodyOf([assistantImage])).toThrow(UnsupportedInputError);
  });

  it('turns a data URL into a base64 image block and an http URL into a url image block', () => {
    const body = bodyOf([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'look' },
          { type: 'input_image', image_url: PNG_URL },
          { type: 'input_image', image_url: 'https://example.com/a.png' },
        ],
      },
    ]);
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 } },
          { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
        ],
      },
    ]);
  });

  it('carries an image of a tool result inside the tool_result content', () => {
    const body = bodyOf([
      call('c1', 'read_file', '{}'),
      { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'shot' }, { type: 'input_image', image_url: PNG_URL }] },
    ]);
    expect(body.messages[1]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'c1',
          content: [
            { type: 'text', text: 'shot' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 } },
          ],
        },
      ],
    });
  });

  it.for([
    { name: 'an image without an image_url', part: { type: 'input_image' } },
    { name: 'a non-base64 data URL', part: { type: 'input_image', image_url: 'data:image/png,abc' } },
    { name: 'an unsupported scheme', part: { type: 'input_image', image_url: 'file:///tmp/a.png' } },
    { name: 'an unsupported media type', part: { type: 'input_image', image_url: 'data:image/bmp;base64,AAAA' } },
  ] satisfies Array<{ name: string; part: ContentPart }>)('rejects $name', ({ part }) => {
    expect(() => bodyOf([{ type: 'message', role: 'user', content: [part] }])).toThrow(UnsupportedInputError);
  });

  it('uses the declared maximum unless the request sets max_output_tokens', () => {
    expect(bodyOf([user('x')]).max_tokens).toBe(MAX_TOKENS);
    expect(bodyOf([user('x')], { max_output_tokens: 10 }).max_tokens).toBe(10);
    expect(bodyOf([user('x')], { max_output_tokens: null }).max_tokens).toBe(MAX_TOKENS);
  });

  it('gives a tool without parameters an empty object schema', () => {
    const body = bodyOf([user('x')], { tools: [{ type: 'function', name: 'ping' }] });
    expect(body.tools).toEqual([{ name: 'ping', input_schema: { type: 'object', properties: {} } }]);
  });

  it.for([
    [undefined, undefined, undefined],
    [undefined, false, { type: 'auto', disable_parallel_tool_use: true }],
    ['auto', undefined, { type: 'auto' }],
    ['auto', true, { type: 'auto' }],
    ['required', undefined, { type: 'any' }],
    ['required', false, { type: 'any', disable_parallel_tool_use: true }],
    ['none', false, { type: 'none' }],
    [{ type: 'function', name: 'read_file' }, undefined, { type: 'tool', name: 'read_file' }],
    [{ type: 'function', name: 'read_file' }, false, { type: 'tool', name: 'read_file', disable_parallel_tool_use: true }],
  ] as const)('maps tool_choice %j with parallel_tool_calls %j to %j', ([choice, parallel, expected]) => {
    const body = bodyOf([user('x')], {
      tools: [tool],
      ...(choice === undefined ? {} : { tool_choice: choice }),
      ...(parallel === undefined ? {} : { parallel_tool_calls: parallel }),
    });
    expect(body.tool_choice).toEqual(expected);
  });

  it('sends neither tools nor tool_choice when there are no tools', () => {
    const body = bodyOf([user('x')], { tool_choice: 'required', parallel_tool_calls: false });
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  });
});

describe('cache breakpoints', () => {
  const cached = (input: AdapterInputItem[], extra: Partial<AdapterRequest> = {}) =>
    buildMessagesBody({ model: 'm', input, fence: TEST_FENCE, ...extra }, MAX_TOKENS, { cache: { maxBreakpoints: 4 } }, EVERY_REASONING_IS_OWN);
  const marker = { type: 'ephemeral' };
  const secondTool = { ...tool, name: 'write_file' };
  const summary: AdapterInputItem = { type: 'compaction_summary', summary: 'earlier' };
  const system: AdapterInputItem = { type: 'message', role: 'system', content: 'rules' };

  const breakpoints = (body: ReturnType<typeof cached>): string[] => {
    const found: string[] = [];
    for (const entry of body.tools ?? []) if (entry.cache_control !== undefined) found.push(`tool:${entry.name}`);
    for (const [index, block] of (body.system ?? []).entries()) if (block.cache_control !== undefined) found.push(`system:${index}`);
    for (const [messageIndex, message] of body.messages.entries()) {
      for (const [blockIndex, block] of (message.content as Array<{ cache_control?: unknown }>).entries()) {
        if (block.cache_control !== undefined) found.push(`message:${messageIndex}.${blockIndex}`);
      }
    }
    return found;
  };

  it('marks the last tool, the last system block, the end of the compaction summary and the last block', () => {
    const body = cached([system, summary, user('one'), assistant('two'), user('three')], { instructions: 'first', tools: [tool, secondTool] });
    expect(breakpoints(body)).toEqual(['tool:write_file', 'system:1', 'message:0.0', 'message:2.0']);
    expect(body.tools?.at(-1)?.cache_control).toEqual(marker);
  });

  it('keeps the compaction-summary breakpoint on the summary block when later user items merge into its turn', () => {
    const body = cached([summary, user('next')]);
    expect(breakpoints(body)).toEqual(['message:0.0', 'message:0.1']);
  });

  it('does not mark one block twice and never exceeds four breakpoints', () => {
    const body = cached([summary], { instructions: 'first', tools: [tool] });
    expect(breakpoints(body)).toEqual(['tool:read_file', 'system:0', 'message:0.0']);
    const widest = cached([system, summary, user('a'), assistant('b'), user('c')], { instructions: 'first', tools: [tool] });
    expect(breakpoints(widest).length).toBeLessThanOrEqual(4);
  });

  it('has no summary breakpoint when the summary does not lead the input', () => {
    const body = cached([user('a'), summary, user('b')]);
    expect(breakpoints(body)).toEqual(['message:0.2']);
  });

  it('marks nothing when breakpoints are disabled', () => {
    const body = buildMessagesBody({ model: 'm', input: [summary, user('x')], tools: [tool] }, MAX_TOKENS, { cache: undefined }, EVERY_REASONING_IS_OWN);
    expect(breakpoints(body as ReturnType<typeof cached>)).toEqual([]);
  });

  it('places the final breakpoint on a tool_result of the last user turn', () => {
    const body = cached([user('a'), call('c1', 'read_file', '{}'), output('c1', 'r1')], { tools: [tool] });
    expect(breakpoints(body)).toEqual(['tool:read_file', 'message:2.0']);
  });
});
