import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ERROR_TYPES,
  MOMONGA_EVENT_PREFIX,
  OPEN_RESPONSES_STREAM_EVENT_TYPES,
  OPEN_RESPONSES_VERSION,
  TERMINAL_STREAM_EVENT_TYPES,
} from '@momonga/protocol';
import type {
  CompactRequest,
  CompactResource,
  CompactionItem,
  CountTokensRequest,
  CountTokensResult,
  CreateResponseBody,
  ErrorBody,
  ErrorEnvelope,
  ErrorType,
  FunctionCallItem,
  FunctionCallOutputItem,
  GatewayHealth,
  InputItem,
  MessageItem,
  MomongaEventName,
  MomongaResponseExtension,
  ReasoningItem,
  ResponseResource,
  StreamEvent,
  UsageReport,
} from '@momonga/protocol';
import { createOpenResponsesValidator, responseResource, textResponseEvents, usageOf } from '@momonga/testkit';

const validator = createOpenResponsesValidator();

const expectValid = (component: string, value: unknown): void => {
  expect(validator.validate(component, value).errors, component).toEqual([]);
};

const message: MessageItem = {
  type: 'message',
  id: 'msg_1',
  status: 'completed',
  role: 'assistant',
  content: [{ type: 'output_text', text: 'done', annotations: [] }],
};
const functionCall: FunctionCallItem = {
  type: 'function_call',
  id: 'fc_1',
  call_id: 'call_1',
  name: 'read_file',
  arguments: '{"path":"a.txt"}',
  status: 'completed',
};
const functionCallOutput: FunctionCallOutputItem = {
  type: 'function_call_output',
  id: 'fco_1',
  call_id: 'call_1',
  output: 'file body',
  status: 'completed',
};
const reasoning: ReasoningItem = {
  type: 'reasoning',
  id: 'rs_1',
  summary: [{ type: 'summary_text', text: 'thinking' }],
};
const compaction: CompactionItem = { type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque' };

describe('Open Responses version and constants', () => {
  it('pins the vendored spec version', () => {
    expect(OPEN_RESPONSES_VERSION).toBe('2026-04-24');
  });

  it('lists exactly the stream event types of the vendored spec', () => {
    expect([...OPEN_RESPONSES_STREAM_EVENT_TYPES].sort()).toEqual([...validator.streamEventSchemaNames().keys()].sort());
  });

  it('lists the terminal events', () => {
    expect([...TERMINAL_STREAM_EVENT_TYPES]).toEqual(['response.completed', 'response.failed', 'response.incomplete']);
    for (const type of TERMINAL_STREAM_EVENT_TYPES) expect(OPEN_RESPONSES_STREAM_EVENT_TYPES).toContain(type);
  });

  it('lists the error types', () => {
    expect([...ERROR_TYPES]).toEqual(['invalid_request', 'not_found', 'too_many_requests', 'server_error', 'model_error']);
  });

  it('uses the momonga: prefix for extension events', () => {
    expect(MOMONGA_EVENT_PREFIX).toBe('momonga:');
    expectTypeOf<'momonga:attempt'>().toExtend<MomongaEventName>();
    expectTypeOf<'response.created'>().not.toExtend<MomongaEventName>();
  });
});

describe('Open Responses types conform to the vendored component schemas', () => {
  it('accepts every output item type as ItemField and its own component', () => {
    expectValid('Message', message);
    expectValid('FunctionCall', functionCall);
    expectValid('FunctionCallOutput', functionCallOutput);
    expectValid('ReasoningBody', reasoning);
    expectValid('CompactionBody', compaction);
    for (const item of [message, functionCall, functionCallOutput, reasoning, compaction]) expectValid('ItemField', item);
  });

  it('accepts a typed CreateResponseBody with every input item kind', () => {
    const input: InputItem[] = [
      { type: 'message', role: 'system', content: 'be terse' },
      { type: 'message', role: 'developer', content: 'use tools' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read a.txt' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'file body' },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] },
      { type: 'compaction', encrypted_content: 'opaque' },
    ];
    const body: CreateResponseBody = {
      model: 'fast',
      input,
      instructions: 'be helpful',
      tools: [
        {
          type: 'function',
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          strict: true,
        },
      ],
      tool_choice: 'auto',
      stream: true,
      store: false,
      max_output_tokens: 256,
      metadata: { run_id: 'run-1', step: '3' },
      previous_response_id: null,
    };
    expectValid('CreateResponseBody', body);
    for (const item of input) expectValid('ItemParam', item);
  });

  it('accepts a typed ResponseResource carrying the momonga extension', () => {
    const extension: MomongaResponseExtension = {
      alias: 'fast',
      target: 'secondary',
      attempts: 3,
      fallbackFrom: ['primary'],
      usageSource: 'reported',
    };
    const resource: ResponseResource = {
      ...responseResource({ id: 'resp_1', model: 'm', status: 'completed', output: [message, functionCall], usage: usageOf(5, 6) }),
      momonga: extension,
    };
    expectValid('ResponseResource', resource);
    expectTypeOf<ResponseResource['momonga']>().toEqualTypeOf<MomongaResponseExtension | undefined>();
    expectTypeOf<MomongaResponseExtension['usageSource']>().toEqualTypeOf<'reported' | 'estimated'>();
  });

  it('rejects a ResponseResource missing required fields so the check is not vacuous', () => {
    const { usage: _usage, ...withoutUsage } = responseResource({ id: 'resp_1', model: 'm', status: 'completed' });
    expect(validator.validate('ResponseResource', withoutUsage).valid).toBe(false);
  });

  it('accepts typed stream events against their own components', () => {
    const names = validator.streamEventSchemaNames();
    const failed: StreamEvent = {
      type: 'response.failed',
      sequence_number: 7,
      response: {
        ...responseResource({ id: 'resp_1', model: 'm', status: 'failed' }),
        error: { code: 'stream_interrupted', message: 'upstream stream ended early' },
      },
    };
    const argumentsDone: StreamEvent = {
      type: 'response.function_call_arguments.done',
      sequence_number: 3,
      item_id: 'fc_1',
      output_index: 0,
      arguments: '{}',
    };
    const errorEvent: StreamEvent = {
      type: 'error',
      sequence_number: 4,
      error: { type: 'server_error', code: 'upstream_error', message: 'boom', param: null },
    };
    for (const event of [...textResponseEvents({ model: 'm', chunks: ['x'] }), failed, argumentsDone, errorEvent]) {
      expectValid(names.get(event.type) as string, event);
    }
  });

  it('types the HTTP error envelope as the spec ErrorPayload', () => {
    const body: ErrorBody = { message: 'no such model', type: 'not_found', param: 'model', code: 'model_not_found' };
    const envelope: ErrorEnvelope = { error: body };
    expectValid('ErrorPayload', envelope.error);
    expectTypeOf<ErrorBody>().toEqualTypeOf<{ message: string; type: ErrorType; param: string | null; code: string | null }>();
    expectTypeOf<ErrorType>().toEqualTypeOf<'invalid_request' | 'not_found' | 'too_many_requests' | 'server_error' | 'model_error'>();
  });

  it('accepts typed compact request and resource', () => {
    const request: CompactRequest = { model: 'fast', input: [{ type: 'message', role: 'user', content: 'hi' }] };
    const resource: CompactResource = {
      id: 'cmp_resp_1',
      object: 'response.compaction',
      output: [compaction],
      created_at: 1_800_000_000,
      usage: usageOf(40, 8),
    };
    expectValid('CompactResponseMethodPublicBody', request);
    expectValid('CompactResource', resource);
  });
});

describe('momonga extension shapes', () => {
  it('defines count_tokens request and result', () => {
    expectTypeOf<CountTokensRequest>().toExtend<{ model: string; input: string | InputItem[] }>();
    expectTypeOf<CountTokensResult>().toEqualTypeOf<{
      input_tokens: number;
      method: 'exact' | 'calibrated' | 'estimated';
      error_bound: number;
      error_shape: { readonly ratio: number; readonly minimum: number };
    }>();
  });

  it('defines health and usage report shapes', () => {
    expectTypeOf<GatewayHealth['targets'][string]['breaker']>().toEqualTypeOf<'closed' | 'open' | 'half-open'>();
    expectTypeOf<GatewayHealth['targets'][string]['ok']>().toEqualTypeOf<boolean>();
    expectTypeOf<UsageReport['run_id']>().toEqualTypeOf<string>();
    expectTypeOf<UsageReport['steps'][number]>().toEqualTypeOf<{
      step: number;
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
    }>();
    expectTypeOf<UsageReport['responses'][number]['usage_source']>().toEqualTypeOf<'reported' | 'estimated'>();
  });
});
