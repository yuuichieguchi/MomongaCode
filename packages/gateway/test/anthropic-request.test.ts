import { describe, expect, it } from 'vitest';
import type { AdapterInputItem, AdapterRequest } from '@momonga/protocol';
import { UnsupportedInputError } from '../src/adapters/shared/failures.ts';
import { buildMessagesBody } from '../src/adapters/anthropic/request.ts';

const MAX_TOKENS = 4096;

const user = (text: string): AdapterInputItem => ({ type: 'message', role: 'user', content: text });
const assistant = (text: string): AdapterInputItem => ({ type: 'message', role: 'assistant', content: text });
const call = (id: string, name: string, args: string): AdapterInputItem => ({ type: 'function_call', call_id: id, name, arguments: args });
const output = (id: string, text: string): AdapterInputItem => ({ type: 'function_call_output', call_id: id, output: text });

const bodyOf = (input: AdapterInputItem[], extra: Partial<AdapterRequest> = {}) => buildMessagesBody({ model: 'm', input, ...extra }, MAX_TOKENS);

const tool = { type: 'function', name: 'read_file', description: 'Read', parameters: { type: 'object', properties: {} } } as const;

describe('buildMessagesBody', () => {
  it('joins instructions and system or developer messages into one system string', () => {
    const body = bodyOf(
      [{ type: 'message', role: 'system', content: 'sys' }, { type: 'message', role: 'developer', content: 'dev' }, user('hi')],
      { instructions: 'first' },
    );
    expect(body.system).toBe('first\n\nsys\n\ndev');
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
      { role: 'user', content: [{ type: 'text', text: '<conversation_summary>\nearlier &lt;work>\n</conversation_summary>' }] },
    ]);
  });

  it('rejects tool arguments that are not JSON', () => {
    expect(() => bodyOf([call('c1', 'read_file', '{oops')])).toThrow(UnsupportedInputError);
  });

  it('rejects image and file input', () => {
    const image: AdapterInputItem = { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/a.png' }] };
    expect(() => bodyOf([image])).toThrow(UnsupportedInputError);
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
