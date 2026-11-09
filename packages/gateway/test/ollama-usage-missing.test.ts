import { describe, expect, it } from 'vitest';
import { terminalOf } from './cc-support.ts';
import { chunkLine, collectOllama, doneLine, makeOllamaAdapter, startFakeOllama, withoutField } from './ollama-support.ts';

const request = { model: 'devstral-small-2', input: [{ type: 'message' as const, role: 'user' as const, content: 'go' }], max_output_tokens: 300 };

const terminalFor = async (done: string) => {
  const fake = await startFakeOllama({ chat: [{ kind: 'ndjson', lines: [chunkLine({ content: 'hi' }), done] }] });
  const { events, error } = await collectOllama(makeOllamaAdapter(fake), request);
  expect(error).toBeUndefined();
  return terminalOf(events);
};

describe('ollama stream: a done frame without its token counts', () => {
  it.each([
    ['both counts', withoutField(withoutField(doneLine(), 'prompt_eval_count'), 'eval_count')],
    ['the input count', withoutField(doneLine(), 'prompt_eval_count')],
    ['the output count', withoutField(doneLine(), 'eval_count')],
  ])('reports no usage when the frame lacks %s, never a reported 0', async (_name, done) => {
    const terminal = await terminalFor(done);

    expect(terminal.type).toBe('response.completed');
    expect(terminal.response.usage).toBeNull();
  });

  it('reports the usage when both counts are present', async () => {
    const terminal = await terminalFor(doneLine());

    expect(terminal.response.usage).toMatchObject({ input_tokens: 40, output_tokens: 9 });
  });
});
