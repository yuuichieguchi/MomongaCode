import { describe, expect, it } from 'vitest';
import { createMapperState, mapRunEvent } from '../src/acp/events.ts';
import type { ClientFeatures } from '../src/acp/events.ts';
import { frameOf } from './acp-harness.ts';
import type { EventPayload } from './acp-harness.ts';

const NONE: ClientFeatures = { notices: false, compaction: false, elicitation: { form: false, url: false } };

const map = (state: ReturnType<typeof createMapperState>, payload: EventPayload) => mapRunEvent(frameOf('run-1', 1, payload).data, 'live', state, NONE);

describe('the input of an ACP tool call', () => {
  it('takes the arguments from the function call item of the model response, not from the tool.call event', () => {
    const state = createMapperState();
    const functionCall = { type: 'function_call', call_id: 'call-1', name: 'Write', arguments: '{"file_path":"/a.txt","content":"hello"}' };

    map(state, { type: 'model.responded', step: 1, attempt: 0, response: { status: 'completed', output: [functionCall], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } } as EventPayload);
    const effects = map(state, { type: 'tool.call', callId: 'call-1', providerCallId: 'call-1', name: 'Write', kind: 'edit', title: 'Write a.txt' });

    expect(effects).toEqual([
      expect.objectContaining({ kind: 'update', update: expect.objectContaining({ sessionUpdate: 'tool_call', rawInput: { file_path: '/a.txt', content: 'hello' } }) }),
    ]);
  });
});
