import { describe, expect, it } from 'vitest';
import { momongaPaths } from '@momonga/foundation';
import { endpointKeyOf, probeOllamaTarget } from '@momonga/gateway';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { outputText, postJson, readJson, userInput } from './gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome, writeSettings } from './gateway-process-helpers.ts';
import { OLLAMA_MODEL, chunkLine, doneLine, fixtureJson, startFakeOllama } from './ollama-support.ts';

const CONTEXT_WINDOW = 12288;
const IMAGE_TOKENS = { pixelsPerToken: 750, maxTokens: 1600, minTokens: 1 };

const textReply = (text: string) => ({ kind: 'ndjson' as const, lines: [chunkLine({ content: text }), doneLine({ prompt_eval_count: 33, eval_count: 4 })] });

const gatewayOverProbedOllama = async (showCapabilities: readonly string[], replies: ReturnType<typeof textReply>[]) => {
  const fake = await startFakeOllama({ show: { ...fixtureJson('api-show.json'), capabilities: showCapabilities }, chat: replies });
  const home = makeHome();
  writeSettings(home, {
    models: {
      aliases: { fast: ['local'] },
      targets: {
        local: {
          adapter: 'ollama',
          model: OLLAMA_MODEL,
          baseUrl: fake.origin,
          capabilities: { contextWindow: CONTEXT_WINDOW, maxOutputTokens: 2048, imageInput: true, imageTokens: IMAGE_TOKENS },
        },
      },
    },
  });
  await probeOllamaTarget({
    probeRecordDir: momongaPaths(home, process.platform, {}).probe,
    upstream: { kind: 'tcp', baseUrl: fake.origin }, key: { endpoint: endpointKeyOf({ kind: 'tcp', baseUrl: fake.origin }), model: OLLAMA_MODEL }, model: OLLAMA_MODEL,
    contextWindow: CONTEXT_WINDOW,
  });
  fake.requests.length = 0;
  const handle = await launchGateway({ home, env: baseEnv(home), version: PROCESS_VERSION });
  return { fake, client: clientFor(handle.socketPath) };
};

const imageInput = [
  {
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: 'what is this' },
      { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
    ],
  },
];

describe('a started gateway follows the probed Ollama capabilities (W2)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('sends an image to a target whose probe found no vision when the settings declare image input', async () => {
    const { fake, client } = await gatewayOverProbedOllama(['completion', 'tools'], [textReply('seen')]);

    const response = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: imageInput }));

    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe('seen');
    const bodies = fake.chatBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].messages.at(-1).images).toEqual(['iVBORw0KGgo=']);
  });

  it('sends no think true for a reasoning effort to a target whose probe found no thinking', async () => {
    const { fake, client } = await gatewayOverProbedOllama(['completion', 'tools'], [textReply('hello')]);

    const response = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi'), reasoning: { effort: 'high' } }));

    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe('hello');
    const bodies = fake.chatBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].think).not.toBe(true);
  });
});
