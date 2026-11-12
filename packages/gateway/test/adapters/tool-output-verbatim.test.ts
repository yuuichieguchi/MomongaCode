import { describe, expect, it } from 'vitest';
import { TOOL_OUTPUT_TAG, fenceUntrusted } from '@momonga/protocol';
import type { AdapterCompactRequest, AdapterInputItem, AdapterRequest } from '@momonga/protocol';
import { buildConstrainedBody } from '../../src/adapters/chat-completions/constrained-request.ts';
import { plainHistoryOf } from '../../src/adapters/chat-completions/plain-history.ts';
import { buildResponsesBody } from '../../src/adapters/open-responses/request.ts';
import { FULL_KEYWORD_SUPPORT } from '../../src/dialect/keyword-support.ts';
import { summaryRequestOf } from '../../src/adapters/shared/compact.ts';
import { boundaryOf } from '../../src/adapters/shared/input-text.ts';
import { createRequestValidator } from '../../src/core/validation.ts';
import { EVERY_REASONING_IS_OWN } from '../own-reasoning.ts';

const FENCE = 'f3a9c1d27b4e48e6a0c5d9b812e7f604';
const OUTPUT = '#include <stdio.h>\nif (a < b && c > d) return &x;';
const RAW_ARGUMENTS = '{"path": <unterminated';

const history: AdapterInputItem[] = [
  { type: 'message', role: 'user', content: 'compile it' },
  { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"command":"cc main.c"}' },
  { type: 'function_call_output', call_id: 'call_1', output: OUTPUT },
  { type: 'function_call', call_id: 'call_2', name: 'read', arguments: RAW_ARGUMENTS },
  { type: 'function_call_output', call_id: 'call_2', output: 'never sent' },
];

const textOf = (value: unknown): string => JSON.stringify(value);

describe('untrusted text reaches the model unchanged inside the one fence', () => {
  it('a tool result in the plain history is fenced with the session boundary and kept verbatim', () => {
    const messages = plainHistoryOf(history, { envelopeReplies: true, origin: EVERY_REASONING_IS_OWN, boundary: FENCE });
    const contents = messages.map((message) => String(message['content']));
    expect(contents.some((content) => content.includes(fenceUntrusted(TOOL_OUTPUT_TAG, { call: 'call_1', tool: 'shell' }, OUTPUT, FENCE)))).toBe(true);
    expect(textOf(messages)).not.toContain('&lt;');
  });

  it('a past call with unreadable arguments carries its raw text inside the fence', () => {
    const request: AdapterRequest = { model: 'm', input: history, fence: FENCE };
    const body = buildResponsesBody(request, EVERY_REASONING_IS_OWN);
    expect(textOf(body.input)).toContain(JSON.stringify(RAW_ARGUMENTS).slice(1, -1));
    expect(textOf(body.input)).toContain(`boundary=\\"${FENCE}\\"`);
    expect(textOf(body.input)).not.toContain('&lt;');
  });

  it('without a session fence the boundary is derived from the first input item, the same on every build', () => {
    const derived = boundaryOf(undefined, history);
    expect(derived).toBe(boundaryOf(undefined, [...history]));
    expect(derived).not.toBe(boundaryOf(undefined, [{ type: 'message', role: 'user', content: 'another conversation' }, ...history.slice(1)]));
    expect(boundaryOf(FENCE, history)).toBe(FENCE);
  });

  it('the compaction transcript fences every text with the session boundary and the instructions name it', () => {
    const request: AdapterCompactRequest = { model: 'm', input: history, momonga: { fence: FENCE } };
    const summary = summaryRequestOf(request, 2000, EVERY_REASONING_IS_OWN);
    const transcript = textOf(summary.input);
    expect(transcript).toContain(JSON.stringify(OUTPUT).slice(1, -1));
    expect(transcript).not.toContain('&lt;');
    expect(transcript).toContain(`boundary=\\"${FENCE}\\"`);
    expect(summary.instructions).toContain(FENCE);
  });

  it('the constrained-request preamble names the boundary', () => {
    const request: AdapterRequest = { model: 'm', input: history.slice(0, 3), fence: FENCE, tools: [{ type: 'function', name: 'shell', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }] };
    const { body } = buildConstrainedBody(request, FULL_KEYWORD_SUPPORT, EVERY_REASONING_IS_OWN, 'json-schema-2020-12');
    expect(String(body.messages[0]?.['content'])).toContain(FENCE);
  });

  it('the create and compact requests carry the session fence as momonga.fence', () => {
    const validator = createRequestValidator();
    const input = [{ type: 'message', role: 'user', content: 'hi' }];
    expect(validator.parseCompact({ model: 'm', input, momonga: { fence: FENCE } }).momonga?.fence).toBe(FENCE);
    expect(() => validator.parseCompact({ model: 'm', input, momonga: { fence: 7 } })).toThrow(/momonga\.fence/);
    expect(() => validator.parseCreate({ model: 'm', input, momonga: { fence: FENCE } })).not.toThrow();
    expect(() => validator.parseCreate({ model: 'm', input, momonga: { fence: '' } })).toThrow(/momonga\.fence/);
  });
});
