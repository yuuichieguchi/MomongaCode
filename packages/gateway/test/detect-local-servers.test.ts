import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { afterMicrotasks, createTempDir } from '@momonga/testkit';
import { LOCAL_SERVER_CANDIDATES } from '@momonga/protocol';
import type { LocalServerDetection } from '@momonga/protocol';
import { detectLocalServers } from '../src/index.ts';
import type { DetectFetch } from '../src/index.ts';

type Route = (body: string) => { status: number; json?: unknown };

const servers: http.Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const serve = async (routes: Readonly<Record<string, Route>>): Promise<string> => {
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    request.on('end', () => {
      const route = routes[`${request.method ?? 'GET'} ${request.url ?? ''}`];
      const reply = route === undefined ? { status: 404 } : route(body);
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(reply.json === undefined ? '' : JSON.stringify(reply.json));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

const closedPort = async (): Promise<string> => {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
};

const ollamaShaped = (): Record<string, Route> => ({
  'GET /api/version': () => ({ status: 200, json: { version: '0.9.0' } }),
  'GET /api/tags': () => ({ status: 200, json: { models: [{ name: 'coder:7b' }, { name: 'chatter:3b' }] } }),
  'POST /api/show': (body) => {
    const { model } = JSON.parse(body) as { model: string };
    return { status: 200, json: { capabilities: model === 'coder:7b' ? ['completion', 'tools'] : ['completion'] } };
  },
});

const openAiShaped = (): Record<string, Route> => ({
  'GET /v1/models': () => ({ status: 200, json: { object: 'list', data: [{ id: 'served-model', object: 'model' }] } }),
});

const recordingFetch = () => {
  const contacted: string[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    contacted.push(url);
    if (!new URL(url).hostname.startsWith('127.')) throw new TypeError(`fetch failed: ${url} is unreachable in this test`);
    return fetch(input, init);
  };
  return { contacted, fetch: fetchFn as typeof fetch };
};

const noManagedHost = {
  servers: [],
  exec: async () => {
    throw new Error('no process runs in this test');
  },
  exists: async () => false,
} as const;

const run = (candidates: readonly string[], options: { typed?: readonly string[]; fetch?: typeof fetch } = {}) =>
  detectLocalServers({ candidates, typed: options.typed ?? [], signal: new AbortController().signal, fetch: (options.fetch ?? fetch) as DetectFetch, ...noManagedHost });

const endpointsOf = (found: readonly LocalServerDetection[]): string[] => found.flatMap((server) => ('shape' in server ? [] : [server.address]));

describe('detecting a local model server is a measurement that writes nothing', () => {
  it('ships its candidates as loopback data', () => {
    expect(LOCAL_SERVER_CANDIDATES.length).toBeGreaterThan(0);
    for (const candidate of LOCAL_SERVER_CANDIDATES) expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(candidate).hostname);
  });

  it('lists an endpoint that answers as Ollama with its models, whatever its port; the tool capability is read when a model is chosen', async () => {
    const baseUrl = await serve(ollamaShaped());

    const found = await run([baseUrl]);

    expect(found).toEqual([
      {
        kind: 'ollama',
        provider: `ollama-127.0.0.1-${new URL(baseUrl).port}`,
        address: baseUrl,
        models: [
          { id: 'coder:7b', tools: 'unknown' },
          { id: 'chatter:3b', tools: 'unknown' },
        ],
      },
    ]);
  });

  it('lists an endpoint that answers in the OpenAI shape and reports tools unknown, because it reports no tool field', async () => {
    const baseUrl = await serve(openAiShaped());

    const found = await run([baseUrl]);

    expect(found).toEqual([{ kind: 'generic', provider: `srv-127.0.0.1-${new URL(baseUrl).port}`, address: `${baseUrl}/v1`, models: [{ id: 'served-model', tools: 'unknown' }] }]);
  });

  it('skips an endpoint whose shape it does not know instead of guessing one', async () => {
    const baseUrl = await serve({ 'GET /': () => ({ status: 200, json: { hello: 'world' } }) });

    expect(await run([baseUrl])).toEqual([]);
  });

  it('skips a refused port without a clock', async () => {
    const refused = await closedPort();
    const live = await serve(openAiShaped());
    const timeouts = vi.spyOn(AbortSignal, 'timeout');

    const found = await run([refused, live]);

    expect(endpointsOf(found)).toEqual([`${live}/v1`]);
    expect(timeouts).not.toHaveBeenCalled();
  });

  it('bounds an endpoint that never answers by the user cancel, not by a number, and keeps what it found', async () => {
    const live = await serve(openAiShaped());
    const arrived = Promise.withResolvers<void>();
    const hanging = http.createServer(() => arrived.resolve());
    servers.push(hanging);
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));
    const silent = `http://127.0.0.1:${(hanging.address() as AddressInfo).port}`;
    const cancel = new AbortController();
    const timeouts = vi.spyOn(AbortSignal, 'timeout');

    const liveListed = Promise.withResolvers<void>();
    const observed: DetectFetch = async (url, init) => {
      const response = await (fetch as DetectFetch)(url, init);
      const { body } = response;
      if (url !== `${live}/v1/models` || body === null) return response;
      return {
        ok: response.ok,
        body: (async function* () {
          yield* body;
          liveListed.resolve();
        })(),
      };
    };
    const pending = detectLocalServers({ candidates: [live, silent], typed: [], signal: cancel.signal, fetch: observed, ...noManagedHost });
    await Promise.all([arrived.promise, liveListed.promise]);
    await afterMicrotasks();
    cancel.abort();

    expect(endpointsOf(await pending)).toEqual([`${live}/v1`]);
    expect(timeouts).not.toHaveBeenCalled();
    hanging.closeAllConnections();
  });

  it('never contacts a candidate that is not a loopback address', async () => {
    const recorder = recordingFetch();
    const live = await serve(openAiShaped());

    const found = await run(['http://192.0.2.10:11434', live], { fetch: recorder.fetch });

    expect(endpointsOf(found)).toEqual([`${live}/v1`]);
    expect(recorder.contacted.filter((url) => url.includes('192.0.2.10'))).toEqual([]);
    expect(recorder.contacted.length).toBeGreaterThan(0);
  });

  it('contacts a non-loopback address only when the user typed it', async () => {
    const recorder = recordingFetch();

    await run([], { typed: ['http://192.0.2.10:11434'], fetch: recorder.fetch });

    expect(recorder.contacted.some((url) => url.startsWith('http://192.0.2.10:11434/'))).toBe(true);
  });

  it('writes nothing under HOME', async () => {
    const home = createTempDir();
    const previous = process.env['HOME'];
    process.env['HOME'] = home;
    try {
      await run([await serve(ollamaShaped())]);
      expect(fs.readdirSync(home)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env['HOME'];
      else process.env['HOME'] = previous;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
