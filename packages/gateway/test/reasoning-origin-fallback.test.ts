import { describe, expect, it } from 'vitest';
import { createAnthropicAdapter } from '@momonga/gateway';
import {
  anthropicBlockDelta,
  anthropicBlockStart,
  anthropicBlockStop,
  anthropicErrorReply,
  anthropicMessageEnd,
  anthropicMessageStart,
  anthropicStream,
  anthropicTextBlock,
  anthropicTextReply,
  createFakeClock,
  startFakeAnthropic,
} from '@momonga/testkit';
import { START_MS, postJson, readSse, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';
import { QWEN_MODEL, chunkLine, doneLine, makeOllamaAdapter, startFakeOllama } from './ollama-support.ts';
import { FAKE_API_KEY, REMOTE_CAPABILITIES } from './upstream-gateway-support.ts';

const ANTHROPIC_MODEL = 'claude-model-x';
const THINKING = 'anthropic thinking of turn one';
const SIGNATURE = 'anthropic-signature-of-turn-one';
const OLLAMA_THINKING = 'ollama thinking of turn two';

const thinkingReply = () =>
  anthropicStream([
    anthropicMessageStart(),
    anthropicBlockStart(0, { type: 'thinking', thinking: '' }),
    anthropicBlockDelta(0, { type: 'thinking_delta', thinking: THINKING }),
    anthropicBlockDelta(0, { type: 'signature_delta', signature: SIGNATURE }),
    anthropicBlockStop(0),
    ...anthropicTextBlock(1, ['one']),
    ...anthropicMessageEnd('end_turn'),
  ]);

const outputOf = (frames: Array<{ data: any }>): any[] => {
  const last = frames.at(-1)?.data;
  expect(last.type).toBe('response.completed');
  return last.response.output;
};

describe('a fallback away and back on a mixed-adapter alias (item 5, decision 2(b))', () => {
  it('the detour target sends none of the original target reasoning, and the original target gets it again on the way back', async () => {
    const anthropicFake = await startFakeAnthropic({
      apiKey: FAKE_API_KEY,
      script: [thinkingReply(), anthropicErrorReply(529, 'overloaded_error', 'primary is overloaded'), anthropicTextReply(['three'])],
    });
    registerCleanup(() => anthropicFake.close());
    const primary = createAnthropicAdapter({
      resolveEndpoint: async () => ({ kind: 'unix', socketPath: anthropicFake.socketPath }),
      apiKey: async () => FAKE_API_KEY,
      capabilities: async () => REMOTE_CAPABILITIES,
      clock: createFakeClock(START_MS),
      apiVersion: '2026-10-21',
    });
    registerCleanup(() => primary.close());
    const ollamaFake = await startFakeOllama({
      chat: [{ kind: 'ndjson', lines: [chunkLine({ thinking: OLLAMA_THINKING }), chunkLine({ content: 'two' }), doneLine()] }],
    });
    const secondary = makeOllamaAdapter(ollamaFake);
    const { client } = await startGateway({
      adapters: { primary, secondary },
      config: {
        aliases: { fast: ['primary', 'secondary'] },
        targets: { primary: { model: ANTHROPIC_MODEL, kind: 'remote' }, secondary: { model: QWEN_MODEL } },
        retry: { maxAttempts: 1 },
      },
    });
    const turn = async (input: unknown[]) => outputOf(await readSse(await postJson(client, '/v1/responses', { model: 'fast', stream: true, input })));

    const first = await turn(userInput('one'));
    const secondInput = [...userInput('one'), ...first, ...userInput('two')];
    const second = await turn(secondInput);
    await turn([...secondInput, ...second, ...userInput('three')]);

    const primaryBodies: any[] = anthropicFake.requests.filter((request) => request.path === '/v1/messages').map((request) => request.body);
    expect(primaryBodies).toHaveLength(3);
    expect(ollamaFake.chatBodies()).toHaveLength(1);
    expect(second.filter((item) => item.type === 'message').flatMap((item) => item.content).map((part: any) => part.text)).toEqual(['two']);

    const ollamaWire = JSON.stringify(ollamaFake.chatBodies()[0].messages);
    expect.soft([ollamaWire.includes(THINKING), ollamaWire.includes(SIGNATURE)]).toEqual([false, false]);

    const anthropicMessages: any[] = primaryBodies[2].messages;
    const thinkingBlocks = anthropicMessages.flatMap((message: any) => message.content).filter((block: any) => block.type === 'thinking');
    expect(thinkingBlocks).toEqual([{ type: 'thinking', thinking: THINKING, signature: SIGNATURE }]);
    expect(JSON.stringify(anthropicMessages).includes(OLLAMA_THINKING)).toBe(false);
  });
});
