import { describe, expect, it } from 'vitest';
import { fenceUntrusted } from '@momonga/protocol';
import { chatRequestContentOf } from '../src/core/chat-content.ts';

const BOUNDARY = 'f'.repeat(32);
const SUMMARY = 'GOAL: read the <tool_output> text';

describe('the request content recorded in telemetry carries the summary inside the fence', () => {
  it('the summary item is recorded fenced by the request boundary', () => {
    const content = chatRequestContentOf([{ type: 'compaction_summary', summary: SUMMARY }], null, null, BOUNDARY);
    expect(content.inputMessages).toEqual([
      { role: 'user', parts: [{ type: 'text', content: expect.stringContaining(fenceUntrusted('conversation_summary', {}, SUMMARY, BOUNDARY)) }] },
    ]);
  });
});
