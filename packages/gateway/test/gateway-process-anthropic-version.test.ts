import { describe, expect, it } from 'vitest';
import { DAEMON_PROCESS_TEST_TIMEOUT_MS, anthropicCountTokensReply, anthropicTextReply, startFakeAnthropic } from '@momonga/testkit';
import { postJson, readJson, registerCleanup, userInput } from './gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome, writeSettings } from './gateway-process-helpers.ts';
import { FAKE_API_KEY } from './upstream-gateway-support.ts';

const KEY_ENV = 'MOMONGA_TEST_ANTHROPIC_KEY';

const launchWith = async (apiVersion: string | undefined) => {
  const fake = await startFakeAnthropic({ apiKey: FAKE_API_KEY, script: [anthropicTextReply(['ok']), anthropicCountTokensReply(42)] });
  registerCleanup(() => fake.close());
  const home = makeHome();
  writeSettings(home, {
    models: {
      aliases: { fast: ['remote'] },
      targets: {
        remote: {
          adapter: 'anthropic',
          model: 'model-a',
          socketPath: fake.socketPath,
          apiKeyEnv: KEY_ENV,
          capabilities: { contextWindow: 200000, maxOutputTokens: 8192 },
          ...(apiVersion === undefined ? {} : { apiVersion }),
        },
      },
    },
  });
  const handle = await launchGateway({ home, env: baseEnv(home, { [KEY_ENV]: FAKE_API_KEY }), version: PROCESS_VERSION });
  const client = clientFor(handle.socketPath);
  const created = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('hi') }));
  const counted = await readJson(await postJson(client, '/v1/momonga/count_tokens', { model: 'fast', input: userInput('hi') }));
  const versionOn = (urlPath: string): unknown[] =>
    fake.requests.filter((request) => request.path === urlPath).map((request) => request.headers['anthropic-version']);
  return { created, counted, versionOn };
};

describe('the anthropic API version in settings reaches the upstream header through the gateway process', { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('sends 2023-06-01 on create and on count_tokens when the target declares it', async () => {
    const { created, counted, versionOn } = await launchWith('2023-06-01');
    expect(created.status).toBe(200);
    expect(counted.status).toBe(200);
    expect(versionOn('/v1/messages')).toEqual(['2023-06-01']);
    expect(versionOn('/v1/messages/count_tokens')).toEqual(['2023-06-01']);
  });

  it('sends 2026-10-21 on create and on count_tokens when the target declares no version', async () => {
    const { created, counted, versionOn } = await launchWith(undefined);
    expect(created.status).toBe(200);
    expect(counted.status).toBe(200);
    expect(versionOn('/v1/messages')).toEqual(['2026-10-21']);
    expect(versionOn('/v1/messages/count_tokens')).toEqual(['2026-10-21']);
  });
});
