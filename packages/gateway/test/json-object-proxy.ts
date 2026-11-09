import http from 'node:http';
import path from 'node:path';
import { makeDir, registerCleanup } from './gateway-helpers.ts';

export type JsonObjectProxy = { socketPath: string; bodies: () => any[] };

const isJsonObjectRequest = (body: any): boolean => body?.response_format?.type === 'json_object';

export const startJsonObjectAcceptingProxy = async (upstreamSocket: string): Promise<JsonObjectProxy> => {
  const socketPath = path.join(makeDir(), 'json-object.sock');
  const bodies: any[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      let raw = Buffer.concat(chunks).toString('utf8');
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        const body = JSON.parse(raw);
        bodies.push(body);
        if (isJsonObjectRequest(body)) {
          const { response_format: _format, ...rest } = body;
          raw = JSON.stringify(rest);
        }
      }
      const forwarded = http.request(
        { socketPath: upstreamSocket, method: request.method, path: request.url, headers: { ...request.headers, 'content-length': Buffer.byteLength(raw) } },
        (upstream) => {
          response.writeHead(upstream.statusCode ?? 502, upstream.headers);
          upstream.pipe(response);
        },
      );
      forwarded.end(raw);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  registerCleanup(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { socketPath, bodies: () => bodies };
};
