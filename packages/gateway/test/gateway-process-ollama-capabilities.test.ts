import { describe, expect, it, vi } from 'vitest';
import { momongaPaths, FIRST_GENERATION } from '@momonga/foundation';
import { endpointKeyOf, probeOllamaTarget } from '@momonga/gateway';
import { REAL_PROCESS_TEST_TIMEOUT_MS, testKernelLock } from '@momonga/testkit';
import { outputText, postJson, readJson, userInput } from './gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome, writeSettings, modelsOf } from './gateway-process-helpers.ts';
import { OLLAMA_LISTED, chunkLine, doneLine, fixtureJson, startFakeOllama } from './ollama-support.ts';
import { UNCONFIGURED_NETWORK } from '@momonga/testkit';
import { hostProbePorts } from './probe-ports-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const CONTEXT_WINDOW = 12288;
const IMAGE_TOKENS = { pixelsPerToken: 750, maxTokens: 1600, minTokens: 1 };

const textReply = (text: string) => ({ kind: 'ndjson' as const, lines: [chunkLine({ content: text }), doneLine({ prompt_eval_count: 33, eval_count: 4 })] });

const gatewayOverProbedOllama = async (showCapabilities: readonly string[], replies: ReturnType<typeof textReply>[], declareImage = true) => {
  const fake = await startFakeOllama({ show: { ...fixtureJson('api-show.json'), capabilities: showCapabilities }, chat: replies });
  const home = makeHome();
  writeSettings(home, {
    models: modelsOf({
        local: {
          adapter: 'ollama',
          model: OLLAMA_LISTED,
          baseUrl: fake.origin,
          capabilities: { contextWindow: CONTEXT_WINDOW, maxOutputTokens: 2048, ...(declareImage ? { imageInput: true, imageTokens: IMAGE_TOKENS } : {}) },
        },
      }),
  });
  await probeOllamaTarget({
    ports: hostProbePorts,
    lock: testKernelLock(),
    probeRecordDir: momongaPaths(home, process.platform, {}).probe,
    upstream: { kind: 'tcp', baseUrl: fake.origin, network: UNCONFIGURED_NETWORK }, key: { endpoint: endpointKeyOf({ kind: 'tcp', baseUrl: fake.origin }), model: OLLAMA_LISTED }, model: OLLAMA_LISTED,
    contextWindow: CONTEXT_WINDOW,
  });
  fake.requests.length = 0;
  const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION });
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

describe('a started gateway follows the probed Ollama capabilities (W2)', () => {
  it('sends an image to a target whose probe found no vision when the settings declare image input', async () => {
    const { fake, client } = await gatewayOverProbedOllama(['completion', 'tools'], [textReply('seen')]);

    const response = await readJson(await postJson(client, '/v1/responses', { model: `local/${OLLAMA_LISTED}`, input: imageInput }));

    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe('seen');
    const bodies = fake.chatBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].messages.at(-1).images).toEqual(['iVBORw0KGgo=']);
  });

  it('refuses an image for a target that declares nothing and whose probe found no vision, without calling /api/chat', async () => {
    const { fake, client } = await gatewayOverProbedOllama(['completion', 'tools'], [textReply('never sent')], false);

    const response = await readJson(await postJson(client, '/v1/responses', { model: `local/${OLLAMA_LISTED}`, input: imageInput }));

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('capability_unsupported');
    expect(fake.chatBodies()).toEqual([]);
  });

  it('sends an image to a target that declares nothing and whose probe found vision', async () => {
    const { fake, client } = await gatewayOverProbedOllama(['completion', 'tools', 'vision'], [textReply('seen')], false);

    const response = await readJson(await postJson(client, '/v1/responses', { model: `local/${OLLAMA_LISTED}`, input: imageInput }));

    expect(response.status).toBe(200);
    expect(fake.chatBodies()).toHaveLength(1);
  });

  it('sends no think true for a reasoning effort to a target whose probe found no thinking', async () => {
    const { fake, client } = await gatewayOverProbedOllama(['completion', 'tools'], [textReply('hello')]);

    const response = await readJson(await postJson(client, '/v1/responses', { model: `local/${OLLAMA_LISTED}`, input: userInput('hi'), reasoning: { effort: 'high' } }));

    expect(response.status).toBe(200);
    expect(outputText(response.body)).toBe('hello');
    const bodies = fake.chatBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].think).not.toBe(true);
  });
});
