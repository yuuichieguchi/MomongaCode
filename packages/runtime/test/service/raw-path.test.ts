import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { startService } from './helpers.ts';

const rawStatus = (socketPath: string, rawPath: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const request = http.request({ socketPath, method: 'GET', path: rawPath }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode as number));
    });
    request.on('error', reject);
    request.end();
  });

describe('raw backslash in the request path', () => {
  it('is answered 400 by the runtime listener', async () => {
    const env = await startService();
    expect(await rawStatus(env.layout.socketPath, '/v1/health')).toBe(200);
    expect(await rawStatus(env.layout.socketPath, '/v1\\health')).toBe(400);
    expect(await rawStatus(env.layout.socketPath, '/v1/sessions\\x')).toBe(400);
  });
});
