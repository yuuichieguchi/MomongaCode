import { describe, expect, it } from 'vitest';
import type { PublicRunEvent } from '@momonga/protocol';
import { foldLiveEvent } from '../../src/tui/transcript.ts';
import { createTranscriptStore } from '../../src/tui/screen/store.ts';
import type { ToolEntry } from '../../src/tui/transcript.ts';

const ARGUMENTS = { file_path: 'notes.txt', content: 'the whole file body' };

const responded = {
  type: 'model.responded',
  createdAt: 1,
  response: {
    usage: { total_tokens: 0 },
    output: [{ type: 'function_call', call_id: 'c1', name: 'Write', arguments: JSON.stringify(ARGUMENTS) }],
  },
} as unknown as PublicRunEvent;

const toolCall = {
  type: 'tool.call',
  callId: 'c1',
  providerCallId: 'c1',
  name: 'Write',
  kind: 'edit',
  title: 'Write notes.txt',
  createdAt: 2,
} as unknown as PublicRunEvent;

const toolEntryOf = (store: ReturnType<typeof createTranscriptStore>): ToolEntry => {
  for (let index = 0; index < store.count(); index += 1) {
    const { entry } = store.at(index);
    if (entry.kind === 'tool') return entry;
  }
  throw new Error('no tool entry');
};

describe('the input of a tool call comes from the function-call item of the model response', () => {
  it('gives the tool entry the arguments of its function call when the call event carries no input', () => {
    const store = createTranscriptStore();
    foldLiveEvent(store, responded, undefined);
    foldLiveEvent(store, toolCall, undefined);
    expect(toolEntryOf(store).rawInput).toEqual(ARGUMENTS);
  });
});
