import { describe, expect, it } from 'vitest';
import { UpstreamProtocolError } from '../src/adapters/shared/failures.ts';
import { parseAnthropicEvent } from '../src/adapters/anthropic/events.ts';
import { parseOpenResponsesEvent } from '../src/adapters/open-responses/events.ts';
import { streamErrorOf } from '../src/adapters/anthropic/errors.ts';

describe('parseAnthropicEvent', () => {
  it.for(['not json', '[]', '{"type": 3}', '{"type":"content_block_start","index":-1,"content_block":{"type":"text"}}', '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta"}}', '{"type":"message_start","message":{"usage":{"input_tokens":"x"}}}', '{"type":"message_delta","delta":{"stop_reason":4}}', '{"type":"error","error":{"type":"overloaded_error"}}'])(
    'rejects the malformed payload %s',
    (payload) => {
      expect(() => parseAnthropicEvent(payload)).toThrow(UpstreamProtocolError);
    },
  );

  it('reads the usage fields of message_start and message_delta', () => {
    expect(parseAnthropicEvent('{"type":"message_start","message":{"usage":{"input_tokens":1,"cache_read_input_tokens":2,"output_tokens":3}}}')).toEqual({
      type: 'message_start',
      usage: { input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 3 },
    });
    expect(parseAnthropicEvent('{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}')).toEqual({
      type: 'message_delta',
      stopReason: 'end_turn',
      usage: { output_tokens: 9 },
    });
  });

  it('classifies unknown event, block and delta types as ignorable', () => {
    expect(parseAnthropicEvent('{"type":"future"}')).toEqual({ type: 'unknown', name: 'future' });
    expect(parseAnthropicEvent('{"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use"}}')).toMatchObject({ block: { kind: 'other' } });
    expect(parseAnthropicEvent('{"type":"content_block_delta","index":0,"delta":{"type":"brand_new_delta"}}')).toMatchObject({ delta: { kind: 'other' } });
    expect(parseAnthropicEvent('{"type":"content_block_delta","index":0,"delta":{"type":"citations_delta","citation":{"a":1}}}')).toMatchObject({ delta: { kind: 'citation', citation: { a: 1 } } });
    expect(parseAnthropicEvent('{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"t"}}')).toMatchObject({ delta: { kind: 'thinking', thinking: 't' } });
    expect(parseAnthropicEvent('{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"s"}}')).toMatchObject({ delta: { kind: 'signature', signature: 's' } });
  });
});

describe('streamErrorOf', () => {
  it.for([
    ['overloaded_error', 529],
    ['rate_limit_error', 429],
    ['api_error', 500],
    ['authentication_error', 401],
    ['invalid_request_error', 400],
  ] as const)('maps %s to the status %i', ([type, status]) => {
    expect(streamErrorOf(type, 'm')).toMatchObject({ status, upstreamCode: type });
  });

  it('treats an unknown error type as a protocol violation', () => {
    expect(streamErrorOf('brand_new_error', 'm')).toBeInstanceOf(UpstreamProtocolError);
  });
});

describe('parseOpenResponsesEvent', () => {
  it.for([
    'not json',
    '{"type": 3}',
    '{"type":"response.output_item.added","item":{"type":"message"}}',
    '{"type":"response.output_text.delta","output_index":0}',
    '{"type":"response.completed","response":{"usage":{"input_tokens":-1,"output_tokens":1}}}',
    '{"type":"response.failed","response":{}}',
  ])('rejects the malformed payload %s', (payload) => {
    expect(() => parseOpenResponsesEvent(payload)).toThrow(UpstreamProtocolError);
  });

  it('reads usage with cached and reasoning token details', () => {
    const event = parseOpenResponsesEvent(
      JSON.stringify({
        type: 'response.completed',
        response: { usage: { input_tokens: 10, output_tokens: 4, input_tokens_details: { cached_tokens: 6 }, output_tokens_details: { reasoning_tokens: 2 } } },
      }),
    );
    expect(event).toEqual({
      type: 'terminal',
      terminal: {
        status: 'completed',
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          total_tokens: 14,
          input_tokens_details: { cached_tokens: 6 },
          output_tokens_details: { reasoning_tokens: 2 },
        },
      },
    });
  });

  it('ignores event types it does not map', () => {
    expect(parseOpenResponsesEvent('{"type":"response.reasoning_summary_text.delta"}')).toEqual({ type: 'ignored' });
    expect(parseOpenResponsesEvent('{"type":"vendor.extension"}')).toEqual({ type: 'ignored' });
  });

  it('keeps the upstream error type only when it is an Open Responses error type', () => {
    expect(parseOpenResponsesEvent('{"type":"error","error":{"type":"too_many_requests","code":"x","message":"m"}}')).toMatchObject({ errorType: 'too_many_requests' });
    expect(parseOpenResponsesEvent('{"type":"error","error":{"type":"strange","message":"m"}}')).toMatchObject({ errorType: 'server_error', code: 'upstream_error' });
  });
});
