import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixedSocket } from '@momonga/foundation';
import type { SupervisorChildState } from '@momonga/protocol';
import { withTempDir } from '@momonga/testkit';
import { supervisedGatewayStanding } from '../../src/process/supervised-gateway.ts';
import { onCleanup } from '../service/helpers.ts';

const supervisorAnswering = async (context: Parameters<typeof withTempDir>[0], gatewayState: SupervisorChildState | undefined, phase = 'running'): Promise<string> => {
  const socketPath = path.join(fs.realpathSync(withTempDir(context)), 's.sock');
  const server = http.createServer((request, response) => {
    if (request.url !== '/v1/health') {
      response.writeHead(404).end();
      return;
    }
    const children = [{ role: 'runtime', state: 'ready', pid: 2 }, ...(gatewayState === undefined ? [] : [{ role: 'gateway', state: gatewayState, pid: 3 }])];
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', version: '1', pid: 1, phase, children }));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  onCleanup(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return socketPath;
};

describe('what the supervisor promises for the gateway, read from its health', () => {
  it.for(['pending', 'starting', 'ready', 'stopping', 'backoff', 'waiting-lock'] as const)('a gateway in the state %s is one the supervisor starts again', async (state, context) => {
    const standing = supervisedGatewayStanding(fixedSocket(await supervisorAnswering(context, state)));
    expect(await standing(new AbortController().signal)).toEqual({ kind: 'restarting', state });
  });

  it.for(['stopped', 'held-config', 'held-version', 'external'] as const)('a gateway in the state %s is one the supervisor has given up', async (state, context) => {
    const standing = supervisedGatewayStanding(fixedSocket(await supervisorAnswering(context, state)));
    expect(await standing(new AbortController().signal)).toEqual({ kind: 'given-up', state });
  });

  it('a gateway of a supervisor that is draining is given up, whatever its state', async (context) => {
    const standing = supervisedGatewayStanding(fixedSocket(await supervisorAnswering(context, 'backoff', 'draining')));
    expect(await standing(new AbortController().signal)).toEqual({ kind: 'given-up', state: 'backoff' });
  });

  it('fails with a reason when the health of the supervisor names no gateway', async (context) => {
    const standing = supervisedGatewayStanding(fixedSocket(await supervisorAnswering(context, undefined)));
    await expect(standing(new AbortController().signal)).rejects.toThrow('the health of the supervisor names no process that serves the models');
  });
});
