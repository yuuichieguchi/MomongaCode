import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { createScriptedAdapter } from '@momonga/testkit';
import { startGateway } from './gateway-helpers.ts';

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
  it('is answered 400 by the gateway listener', async () => {
    const { socketPath } = await startGateway({ adapters: { 'scripted/scripted-primary': createScriptedAdapter({ calls: [] }) } });
    expect(await rawStatus(socketPath, '/v1/momonga/health')).toBe(200);
    expect(await rawStatus(socketPath, '/v1/momonga\\health')).toBe(400);
    expect(await rawStatus(socketPath, '/v1\\momonga/health')).toBe(400);
  });
});
