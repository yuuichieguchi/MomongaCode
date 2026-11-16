import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FM_SERVER } from '@momonga/protocol';
import type { ManagedServerDescription } from '@momonga/protocol';
import { describeModel, detectLocalServers } from '../src/index.ts';
import type { DetectFetch } from '../src/index.ts';
import { PreconditionCancelledError } from '../src/managed/preconditions.ts';

type Route = (body: string) => { status: number; json?: unknown };

const servers: http.Server[] = [];

afterEach(async () => {
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

const detect = (options: Record<string, unknown>) =>
  (detectLocalServers as unknown as (options: Record<string, unknown>) => ReturnType<typeof detectLocalServers>)({
    candidates: [],
    typed: [],
    signal: new AbortController().signal,
    fetch,
    servers: [],
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    exists: async () => false,
    ...options,
  });

describe('the detector fills the field its shape reports (O-R5-4 S10)', () => {
  it('gives a chosen Ollama model the ceiling and the tool capability of its /api/show answer, and no ceiling when the answer carries no length', async () => {
    const baseUrl = await serve({
      'GET /api/version': () => ({ status: 200, json: { version: '0.9.0' } }),
      'GET /api/tags': () => ({ status: 200, json: { models: [{ name: 'long:7b' }, { name: 'bare:3b' }] } }),
      'POST /api/show': (body) => {
        const { model } = JSON.parse(body) as { model: string };
        return model === 'long:7b'
          ? { status: 200, json: { capabilities: ['completion', 'tools'], model_info: { 'general.architecture': 'llama', 'llama.context_length': 131072 } } }
          : { status: 200, json: { capabilities: ['completion'] } };
      },
    });
    const [found] = await detect({ candidates: [baseUrl] });
    if (found === undefined || 'shape' in found) throw new Error('the Ollama fake was not found');
    expect(found).toEqual({
      kind: 'ollama',
      provider: `ollama-127.0.0.1-${new URL(baseUrl).port}`,
      address: baseUrl,
      models: [
        { id: 'long:7b', tools: 'unknown' },
        { id: 'bare:3b', tools: 'unknown' },
      ],
    });
    const described = await Promise.all(found.models.map((model) => describeModel({ server: found, model, signal: new AbortController().signal, fetch: fetch as DetectFetch })));
    expect(described).toEqual([
      { id: 'long:7b', tools: 'yes', ceiling: 131072 },
      { id: 'bare:3b', tools: 'no' },
    ]);
  });

  it('gives an OpenAI-shaped model the context window its /v1/models entry reports through the probe reader, and none when absent', async () => {
    const baseUrl = await serve({
      'GET /v1/models': () => ({
        status: 200,
        json: { object: 'list', data: [{ id: 'served', object: 'model', context_window: 32768 }, { id: 'quiet', object: 'model' }, { id: 'odd', object: 'model', context_window: -4 }] },
      }),
    });
    expect(await detect({ candidates: [baseUrl] })).toEqual([
      {
        kind: 'generic',
        provider: `srv-127.0.0.1-${new URL(baseUrl).port}`,
        address: `${baseUrl}/v1`,
        models: [
          { id: 'served', tools: 'unknown', contextWindow: 32768 },
          { id: 'quiet', tools: 'unknown' },
          { id: 'odd', tools: 'unknown' },
        ],
      },
    ]);
  });
});

describe('managed server descriptions are listed when their binary exists (O-R5-4 S7)', () => {
  const described: ManagedServerDescription = { ...FM_SERVER, id: 'custom-server', label: 'the server custom-server', provider: 'someone', binary: { defaultPath: '/opt/custom/serve' }, preconditions: [] };

  it('lists a description whose binary exists, without starting it or reading a model list', async () => {
    const checked: string[] = [];
    const found = await detect({
      servers: [described],
      exists: async (file: string) => {
        checked.push(file);
        return file === '/opt/custom/serve';
      },
    });
    expect(found).toEqual([{ shape: 'managed', id: 'custom-server', label: 'the server custom-server', provider: 'someone', binary: '/opt/custom/serve' }]);
    expect(checked).toContain('/opt/custom/serve');
  });

  it('lists nothing on a host without the binary', async () => {
    expect(await detect({ servers: [described], exists: async () => false })).toEqual([]);
    const listed = await detect({ servers: [described], exists: async () => true });
    expect(listed).toHaveLength(1);
  });
});

describe('managed preconditions run through runPreconditions at detection (O-R5-5 item 4)', () => {
  const gated: ManagedServerDescription = { ...FM_SERVER, id: 'gated-server', label: 'the server gated-server', provider: 'someone', binary: { defaultPath: '/opt/gated/serve' } };
  const exitCodes = (codes: Readonly<Record<string, number>>) => async (file: string, args: readonly string[]) => {
    expect(file).toBe('/opt/gated/serve');
    return { exitCode: codes[args.join(' ')] ?? 0, stdout: '', stderr: '' };
  };

  it('lists a description whose preconditions are met with no refused field', async () => {
    const found = await detect({ servers: [gated], exists: async () => true, exec: exitCodes({}) });
    expect(found).toEqual([{ shape: 'managed', id: 'gated-server', label: 'the server gated-server', provider: 'someone', binary: '/opt/gated/serve' }]);
  });

  it('lists a refused description with the message and remedy of the rule', async () => {
    const found = await detect({ servers: [gated], exists: async () => true, exec: exitCodes({ 'license --status': 69 }) });
    expect(found).toEqual([
      {
        shape: 'managed',
        id: 'gated-server',
        label: 'the server gated-server',
        provider: 'someone',
        binary: '/opt/gated/serve',
        refused: { message: 'the Apple Foundation Models licence has not been accepted', remedy: 'sudo fm license' },
      },
    ]);
  });

  it('turns a spawn error into a refused row naming the precondition', async () => {
    const found = await detect({
      servers: [gated],
      exists: async () => true,
      exec: async () => {
        throw new Error('spawn EACCES');
      },
    });
    expect(found).toEqual([
      { shape: 'managed', id: 'gated-server', label: 'the server gated-server', provider: 'someone', binary: '/opt/gated/serve', refused: { message: 'the precondition "license --status" could not run: spawn EACCES' } },
    ]);
  });

  it('ends the detection with PreconditionCancelledError when the signal aborts, listing nothing', async () => {
    const control = new AbortController();
    const detection = detect({
      servers: [gated],
      exists: async () => true,
      signal: control.signal,
      exec: (_file: string, _args: readonly string[], options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
          control.abort(new Error('the user left'));
        }),
    });
    await expect(detection).rejects.toBeInstanceOf(PreconditionCancelledError);
  });
});
