import { describe, expect, it } from 'vitest';
import type { AdapterInputItem } from '@momonga/protocol';
import { buildMessagesBody } from '../../src/adapters/anthropic/request.ts';
import { nativeHistoryOf, plainHistoryOf } from '../../src/adapters/chat-completions/plain-history.ts';
import { ollamaHistoryOf } from '../../src/adapters/ollama/history.ts';
import { buildResponsesBody } from '../../src/adapters/open-responses/request.ts';
import { EVERY_REASONING_IS_OWN } from '../own-reasoning.ts';

const CUT_OFF_ARGUMENTS = '{"path":"src/<a>.ts","content":"partial';

const history: AdapterInputItem[] = [
  { type: 'message', role: 'user', content: 'write the file' },
  { type: 'function_call', call_id: 'cut', name: 'write_file', arguments: CUT_OFF_ARGUMENTS },
  { type: 'function_call_output', call_id: 'cut', output: 'the arguments were not valid JSON' },
  { type: 'function_call', call_id: 'whole', name: 'read_file', arguments: '{"path":"a.ts"}' },
  { type: 'function_call_output', call_id: 'whole', output: 'body' },
  { type: 'message', role: 'user', content: 'go on' },
];

const wires: Record<string, () => unknown> = {
  anthropic: () => buildMessagesBody({ model: 'm', input: history }, 4096, { cache: undefined }, EVERY_REASONING_IS_OWN).messages,
  'open-responses': () => buildResponsesBody({ model: 'm', input: history }, EVERY_REASONING_IS_OWN).input,
  'chat-completions native': () => nativeHistoryOf(history, EVERY_REASONING_IS_OWN),
  'chat-completions plain': () => plainHistoryOf(history, { envelopeReplies: false, origin: EVERY_REASONING_IS_OWN }),
  ollama: () => ollamaHistoryOf(history, EVERY_REASONING_IS_OWN),
};

describe('a past call whose arguments are not a JSON object is replaced by a note on every wire (gateway-core-C10)', () => {
  it.for(Object.keys(wires).map((wire) => [wire] as const))('on %s: the call and its output are gone, the note names the tool and carries the raw text made inert, and no {} is sent', ([wire]) => {
    const sent = JSON.stringify((wires[wire] as () => unknown)());

    expect(sent).not.toContain('"cut"');
    expect(sent).not.toContain('the arguments were not valid JSON');
    expect(sent).toContain('A call to the tool write_file was cut off');
    expect(sent).toContain('src/&lt;a>.ts');
    expect(sent).toContain('partial');
    expect(sent).not.toContain('{}');
    expect(sent).toContain('read_file');
    expect(sent).toContain('body');
  });
});
