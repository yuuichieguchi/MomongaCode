import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { titleOf } from './support/cases.ts';
import { createUdsClient, fixedSocket } from '@momonga/foundation';
import type { MomongaModelList } from '@momonga/protocol';
import { firstGeneration, modelSettings, startFakeChatCompletions } from '@momonga/testkit';
import type { FakeChatCompletionsServer } from '@momonga/testkit';
import { createE2eHome, registerE2eCleanup } from './support/home.ts';
import { startStack } from './support/stack.ts';
import { chatCompletions, textReply } from './support/upstream.ts';
import { E2E_TEST_TIMEOUT_MS } from './support/wait.ts';

const SHARED_NAME = 'shared-model';
const PROVIDERS = ['alpha', 'beta'] as const;
const CAPABILITIES = { contextWindow: 8192, maxOutputTokens: 1024 };

const modelsAsked = (fake: FakeChatCompletionsServer): unknown[] => chatCompletions(fake).map((request) => (request.body as { model?: unknown }).model);

describe('two servers that serve a model of the same name', () => {
  it(titleOf('same-name-two-servers'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const servers = await Promise.all(
      PROVIDERS.map(async (provider) => {
        const fake = await startFakeChatCompletions({
          scenario: 'tools-ok',
          contextWindow: CAPABILITIES.contextWindow,
          modelId: SHARED_NAME,
          socketPath: path.join(path.dirname(home.upstreamSocket), `${provider}.sock`),
          routes: [{ match: () => true, reply: textReply(`answered by ${provider}`) }],
        });
        registerE2eCleanup(() => fake.close());
        return { provider, fake, canon: `${provider}/${SHARED_NAME}` };
      }),
    );
    const [first] = servers;
    if (first === undefined) throw new Error('no server was started');
    await startStack({
      home,
      upstream: first.fake,
      settings: modelSettings({
        start: first.canon,
        models: servers.map(({ provider, fake }) => ({ adapter: 'chat-completions', provider, id: SHARED_NAME, answers: 'script', socketPath: fake.socketPath, capabilities: CAPABILITIES })),
      }),
    });
    const client = createUdsClient(fixedSocket(firstGeneration(home.paths).sockets.gateway), { connectTimeoutMs: 0 });
    try {
      const listed = await client.request({ method: 'GET', path: '/v1/momonga/models' });
      expect(listed.status).toBe(200);
      const listing = (await listed.json()) as MomongaModelList;
      expect(listing.data.map((entry) => ({ id: entry.id, provider: entry.provider, ownName: entry.ownName }))).toEqual(
        servers.map(({ provider, canon }) => ({ id: canon, provider, ownName: SHARED_NAME })),
      );

      const ambiguous = await client.request({
        method: 'POST',
        path: '/v1/responses',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: SHARED_NAME, input: 'hi' }),
      });
      expect(ambiguous.status).toBeGreaterThanOrEqual(400);
      expect(await ambiguous.json()).toMatchObject({
        error: { code: 'ambiguous_model', message: `The model "${SHARED_NAME}" is served by two servers: ${servers.map((server) => server.canon).join(', ')}. Write one of them.` },
      });
      for (const server of servers) expect(modelsAsked(server.fake)).toEqual([]);

      for (const [index, server] of servers.entries()) {
        const response = await client.request({
          method: 'POST',
          path: '/v1/responses',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: server.canon, input: 'hi' }),
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toContain(`answered by ${server.provider}`);
        expect(servers.map((each) => modelsAsked(each.fake))).toEqual(servers.map((_, position) => (position <= index ? [SHARED_NAME] : [])));
      }
    } finally {
      await client.close();
    }
  });
});
