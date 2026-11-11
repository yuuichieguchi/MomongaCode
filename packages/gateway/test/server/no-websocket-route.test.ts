import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { createScriptedAdapter } from '@momonga/testkit';
import { startGateway } from '../gateway-helpers.ts';

type UpgradeOutcome = { kind: 'upgraded' } | { kind: 'answered'; status: number } | { kind: 'closed' };

const askForUpgrade = (socketPath: string): Promise<UpgradeOutcome> =>
  new Promise((resolve) => {
    const request = http.request({
      socketPath,
      path: '/v1/responses',
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
    });
    request.once('upgrade', (_response, socket) => {
      socket.destroy();
      resolve({ kind: 'upgraded' });
    });
    request.once('response', (response) => {
      response.resume();
      resolve({ kind: 'answered', status: response.statusCode ?? 0 });
    });
    request.once('error', () => resolve({ kind: 'closed' }));
    request.end();
  });

describe('the gateway serves no WebSocket transport', () => {
  it('does not upgrade a request for a WebSocket on its socket', async () => {
    const harness = await startGateway({ adapters: { 'scripted/scripted-primary': createScriptedAdapter({ calls: [] }) } });
    const outcome = await askForUpgrade(harness.socketPath);
    expect(outcome.kind).not.toBe('upgraded');
  });
});
