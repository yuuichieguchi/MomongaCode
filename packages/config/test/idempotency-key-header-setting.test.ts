import { describe, expect, it } from 'vitest';
import { loadSettings } from '@momonga/config';
import { connectionOf, makeTree, modelOf, trusting, userSettingsPath, writeJson } from './helpers.ts';

const CAPABILITIES = { contextWindow: 32768, maxOutputTokens: 4096 };

const CONNECTIONS: ReadonlyArray<Record<string, unknown>> = [
  { adapter: 'chat-completions', model: 'model-a', baseUrl: 'https://api.example.com/v1', capabilities: CAPABILITIES },
  { adapter: 'open-responses', model: 'model-a', baseUrl: 'https://api.example.com/v1', capabilities: CAPABILITIES },
  { adapter: 'anthropic', model: 'model-a', baseUrl: 'https://api.example.com', apiKeySecret: 'anthropic-main', capabilities: CAPABILITIES },
  { adapter: 'ollama', model: 'model-a', baseUrl: 'http://127.0.0.1:11434', capabilities: CAPABILITIES },
  { adapter: 'managed', server: 'fm', model: 'system' },
];

const settingsWith = (connection: Record<string, unknown>) => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), { models: { connections: [connectionOf('remote', connection)] } });
  return { tree, loaded: loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) }) };
};

const expectRefused = async (connection: Record<string, unknown>, ...fragments: (string | RegExp)[]): Promise<void> => {
  const { tree, loaded } = settingsWith(connection);
  await expect(loaded).rejects.toThrow(userSettingsPath(tree));
  for (const fragment of fragments) await expect(loaded).rejects.toThrow(fragment);
};

describe('models.connections[].idempotencyKeyHeader names the header a server reads an idempotency key from (Q20 B1)', () => {
  it.for(CONNECTIONS)('a $adapter connection keeps the declared header name', async (connection) => {
    const { settings } = await settingsWith({ ...connection, idempotencyKeyHeader: 'Idempotency-Key' }).loaded;
    expect(modelOf(settings, 'remote')).toMatchObject({ idempotencyKeyHeader: 'Idempotency-Key' });
  });

  it.for(CONNECTIONS)('a $adapter connection that declares none resolves to none', async (connection) => {
    const { settings } = await settingsWith(connection).loaded;
    expect(modelOf(settings, 'remote')).not.toHaveProperty('idempotencyKeyHeader');
  });

  it.for(['', 'Idempotency Key', 'Idempotency-Key:', 'kéy'])('refuses %j, which is not a header name', async (idempotencyKeyHeader) => {
    await expectRefused({ ...CONNECTIONS[0], idempotencyKeyHeader }, /models[./]connections[[/]0/, 'idempotencyKeyHeader');
  });

  it.for(['Authorization', 'content-type', 'X-Api-Key', 'anthropic-version', 'Accept', 'Host', 'Content-Length'])('refuses %s, a header the request already carries', async (idempotencyKeyHeader) => {
    await expectRefused({ ...CONNECTIONS[0], idempotencyKeyHeader }, /models[./]connections[[/]0/, 'idempotencyKeyHeader', 'already carries');
  });

  it('is a key of the connection, not of one model', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), {
      models: { connections: [{ adapter: 'chat-completions', provider: 'remote', baseUrl: 'https://api.example.com/v1', models: [{ id: 'model-a', capabilities: CAPABILITIES, idempotencyKeyHeader: 'Idempotency-Key' }] }] },
    });
    await expect(loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) })).rejects.toThrow('idempotencyKeyHeader');
  });
});
