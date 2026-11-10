import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as config from '@momonga/config';
import * as protocol from '@momonga/protocol';
import { CAPABILITIES, chatConnection, ollamaConnection } from './model-fixtures.ts';
import { loadModelsSection, sentenceOf } from './load-models.ts';

type Connection = { provider?: string; adapter: string; baseUrl?: string; socketPath?: string; plan?: { profile: string; account?: string }; server?: string };

const providerNameOf = (connection: Connection): string => {
  const derive = (config as Record<string, unknown>)['providerNameOf'];
  const kinds = (protocol as Record<string, unknown>)['SERVER_KINDS'];
  if (typeof derive !== 'function') throw new Error('@momonga/config does not export providerNameOf (packages/config/src/provider-name.ts)');
  if (kinds === undefined) throw new Error('@momonga/protocol does not export SERVER_KINDS (packages/protocol/src/server-kinds.ts)');
  return (derive as (connection: Connection, kinds: unknown) => string)(connection, kinds);
};

const chat = (baseUrl: string): Connection => ({ adapter: 'chat-completions', baseUrl });
const ollama = (baseUrl: string): Connection => ({ adapter: 'ollama', baseUrl });

const LONG_SEGMENT = 'Model_Server.With-A-Very-Long-Socket-Name.SOCK';
const hash8 = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 8);

const duplicateSentence = (name: string): string => `models.connections[0] and models.connections[1] both resolve to the server name "${name}"; write "provider" on one of them`;

const anthropic = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ adapter: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', ...extra, models: [{ id: 'claude-x', capabilities: CAPABILITIES }] });

describe('providerNameOf: the server name of a connection', () => {
  it('a written name is the name', () => {
    expect(providerNameOf({ ...chat('http://127.0.0.1:1234/v1'), provider: 'home-pc' })).toBe('home-pc');
    expect(providerNameOf({ ...ollama('http://127.0.0.1:11434'), provider: 'home-pc' })).toBe('home-pc');
  });

  it('an Ollama server is ollama at its own address, and ollama with the address in the name anywhere else', () => {
    expect(providerNameOf(ollama('http://127.0.0.1:11434'))).toBe('ollama');
    expect(providerNameOf(ollama('http://192.168.1.20:11434'))).toBe('ollama-192.168.1.20-11434');
    expect(providerNameOf(ollama('http://localhost:11434'))).toBe('ollama-localhost-11434');
    expect(providerNameOf(ollama('http://[::1]:11434'))).toBe('ollama6---1-11434');
    expect(providerNameOf({ adapter: 'ollama', socketPath: '/run/llm/x.sock' })).toBe('ollama-sock-0a00a44b-x.sock');
  });

  it('a server of no known kind is named from its host and port', () => {
    expect(providerNameOf(chat('http://127.0.0.1:1234/v1'))).toBe('srv-127.0.0.1-1234');
    expect(providerNameOf(chat('http://localhost:8080'))).toBe('srv-localhost-8080');
    expect(providerNameOf(chat('https://api.openai.com/v1'))).toBe('srv-api.openai.com-443');
    expect(providerNameOf(chat('http://example.org'))).toBe('srv-example.org-80');
    expect(providerNameOf(chat('http://[::1]:8080'))).toBe('srv6---1-8080');
    expect(providerNameOf(chat('HTTP://EXAMPLE.org:81'))).toBe('srv-example.org-81');
  });

  it('a socket is named from the hash of its path and its last segment, cut to 32 characters', () => {
    expect(providerNameOf({ adapter: 'chat-completions', socketPath: '/run/llm/x.sock' })).toBe('sock-0a00a44b-x.sock');
    expect(providerNameOf({ adapter: 'chat-completions', socketPath: '/tmp/My Sock_1.SOCK' })).toBe('sock-12730bc3-my-sock-1.sock');
    expect(LONG_SEGMENT.length).toBeGreaterThan(32);
    expect(providerNameOf({ adapter: 'open-responses', socketPath: `/srv/${LONG_SEGMENT}` })).toBe(`sock-${hash8(`/srv/${LONG_SEGMENT}`)}-model-server.with-a-very-long-so`);
  });

  it('a plan connection is named by its account label when pinned, else by its profile', () => {
    expect(providerNameOf({ adapter: 'open-responses', plan: { profile: 'chatgpt', account: 'chatgpt-2' } })).toBe('chatgpt-2');
    expect(providerNameOf({ adapter: 'open-responses', plan: { profile: 'chatgpt' } })).toBe('chatgpt');
  });

  it('a managed connection is named by the id of a declared server, and by the description of a built-in one', () => {
    expect(providerNameOf({ adapter: 'managed', server: 'llama-server' })).toBe('llama-server');
    expect(providerNameOf({ adapter: 'managed', server: 'fm' })).toBe('apple');
  });

  it('an Anthropic connection is anthropic at any address', () => {
    expect(providerNameOf({ adapter: 'anthropic' })).toBe('anthropic');
    expect(providerNameOf({ adapter: 'anthropic', baseUrl: 'https://proxy.corp.example.com/anthropic' })).toBe('anthropic');
  });
});

describe('server names in a settings file', () => {
  it('two connections with one name are refused, naming both entries and the name', async () => {
    expect(await sentenceOf({ models: { connections: [chatConnection('http://127.0.0.1:8080/a'), chatConnection('http://127.0.0.1:8080/b', ['n'])] } })).toBe(duplicateSentence('srv-127.0.0.1-8080'));
  });

  it('the name unknown is a name like any other', async () => {
    const { models } = await loadModelsSection({ connections: [chatConnection('http://127.0.0.1:8080/v1', ['m'], { provider: 'unknown' })] });
    expect([...models.models.keys()]).toEqual(['unknown/m']);
  });

  it('the name of a server kind is refused on a connection that uses another API; lmstudio on an OpenAI-compatible connection is accepted', async () => {
    expect(await sentenceOf({ models: { connections: [chatConnection('http://127.0.0.1:8080/v1', ['m'], { provider: 'ollama' })] } })).toBe(
      'models.connections[0].provider: "ollama" is the name of Ollama servers, which use the Ollama API; this server uses the OpenAI-compatible API. Choose another name.',
    );
    expect(await sentenceOf({ models: { connections: [chatConnection('http://127.0.0.1:8080/v1', ['m'], { provider: 'Home_PC' })] } })).toBe(
      'models.connections[0].provider: "Home_PC" must start with a lower-case letter and use only lower-case letters, digits, . _ -',
    );
    const { models } = await loadModelsSection({ connections: [chatConnection('http://127.0.0.1:1234/v1', ['m'], { provider: 'lmstudio' })] });
    expect([...models.models.keys()]).toEqual(['lmstudio/m']);
  });

  it('a second Anthropic connection needs a written name', async () => {
    expect(await sentenceOf({ models: { connections: [anthropic(), anthropic({ baseUrl: 'https://proxy.corp.example.com/anthropic' })] } })).toBe(duplicateSentence('anthropic'));
    const { models } = await loadModelsSection({ connections: [anthropic(), anthropic({ provider: 'anthropic-work' })] });
    expect([...models.models.keys()]).toEqual(['anthropic/claude-x', 'anthropic-work/claude-x']);
  });

  it('two managed connections on one server need a written name on one', async () => {
    const fm = (extra: Record<string, unknown>) => ({ adapter: 'managed', server: 'fm', ...extra, models: [{ id: 'x' }] });
    expect(await sentenceOf({ models: { connections: [fm({ binary: '/opt/fm/a' }), fm({ binary: '/opt/fm/b' })] } })).toBe(duplicateSentence('apple'));
  });

  it('two Ollama connections at 127.0.0.1 and at localhost are two servers with two names', async () => {
    const { models } = await loadModelsSection({ connections: [ollamaConnection('http://127.0.0.1:11434'), ollamaConnection('http://localhost:11434')] });
    expect([...models.models.keys()]).toEqual(['ollama/m:latest', 'ollama-localhost-11434/m:latest']);
  });
});
