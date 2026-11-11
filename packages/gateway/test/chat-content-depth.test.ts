import { describe, expect, it } from 'vitest';
import { MAX_JSON_DEPTH } from '@momonga/foundation';
import { chatRequestContentOf, chatResponseMessagesOf } from '../src/core/chat-content.ts';

const nested = (depth: number): string => `${'['.repeat(depth)}${']'.repeat(depth)}`;

const TOO_DEEP = nested(MAX_JSON_DEPTH + 1);
const ARGUMENTS_TOO_DEEP = `[arguments nest deeper than ${MAX_JSON_DEPTH} levels]`;
const TOOL_OUTPUT_TOO_DEEP = `[tool output nests deeper than ${MAX_JSON_DEPTH} levels]`;

const call = (argumentsText: string) => ({ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Tree', arguments: argumentsText, status: 'completed' }) as const;

describe('the content a chat span carries and the one JSON depth bound', () => {
  it('carries the parsed arguments of a call within the bound, and the text of malformed arguments', () => {
    expect(chatRequestContentOf([call('{"a":1}')], null, null).inputMessages).toEqual([
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'call_1', name: 'Tree', arguments: { a: 1 } }] },
    ]);
    expect(chatRequestContentOf([call('{not json')], null, null).inputMessages).toEqual([
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'call_1', name: 'Tree', arguments: '{not json' }] },
    ]);
  });

  it('replaces the arguments of a request call deeper than the bound by the placeholder', () => {
    expect(chatRequestContentOf([call(TOO_DEEP)], null, null).inputMessages).toEqual([
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'call_1', name: 'Tree', arguments: ARGUMENTS_TOO_DEEP }] },
    ]);
  });

  it('replaces a tool output deeper than the bound by the placeholder that names a tool output', () => {
    expect(chatRequestContentOf([{ type: 'function_call_output', call_id: 'call_1', output: TOO_DEEP }], null, null).inputMessages).toEqual([
      { role: 'tool', parts: [{ type: 'tool_call_response', id: 'call_1', response: TOOL_OUTPUT_TOO_DEEP }] },
    ]);
  });

  it('replaces the arguments of a response call deeper than the bound by the placeholder', () => {
    expect(chatResponseMessagesOf([call(TOO_DEEP)], 'tool_call')).toEqual([
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'call_1', name: 'Tree', arguments: ARGUMENTS_TOO_DEEP }], finish_reason: 'tool_call' },
    ]);
  });
});
