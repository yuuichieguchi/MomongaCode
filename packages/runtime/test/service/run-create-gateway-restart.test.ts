import { describe, expect, it } from 'vitest';
import { GatewayRequestError } from '@momonga/runtime';
import type { GatewayStanding } from '../../src/process/supervised-gateway.ts';
import { startService } from './helpers.ts';

const UNREACHABLE = new GatewayRequestError({ status: 503, type: 'transport', code: 'gateway_unavailable', message: 'the gateway socket refused the connection' });

const serviceWith = async (standing: GatewayStanding | Error) => {
  const asked: number[] = [];
  const env = await startService({
    gatewayStanding: async () => {
      asked.push(1);
      if (standing instanceof Error) throw standing;
      return standing;
    },
  });
  const session = await env.createSession();
  env.ports.listingFailure.error = UNREACHABLE;
  return { env, session, asked };
};

describe('a run created while the model gateway cannot be read', () => {
  it('is accepted while the supervisor promises to start the gateway again, and its model is checked by its first model request', async () => {
    const { env, session, asked } = await serviceWith({ kind: 'restarting', state: 'backoff' });
    const response = await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'say hello' } });
    expect(response.status).toBe(202);
    expect(env.store.listRuns(session.id).map((run) => run.id)).toEqual([response.json.run.id]);
    expect(asked).toHaveLength(1);
    expect(env.errors).toEqual([]);
  });

  it('is refused when the supervisor has given the gateway up, with a text that names the cause and the command that starts it again', async () => {
    const { env, session } = await serviceWith({ kind: 'given-up', state: 'held-config' });
    const response = await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'say hello' } });
    expect({ status: response.status, body: response.json, retryAfter: response.headers['retry-after'] }).toEqual({
      status: 503,
      body: {
        error: {
          type: 'server_error',
          code: 'gateway_unavailable',
          message: 'The model gateway has stopped and the daemon will not start it again (held-config). Run momonga daemon stop; the next momonga command starts the daemon again.',
        },
      },
      retryAfter: undefined,
    });
    expect(env.store.listRuns(session.id)).toEqual([]);
  });

  it('is refused while the gateway restarts when the run declares a money limit, whose prices only the gateway knows', async () => {
    const { env, session } = await serviceWith({ kind: 'restarting', state: 'starting' });
    const response = await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'say hello', limits: { maxCostUsd: 1 } } });
    expect({ status: response.status, code: response.json.error.code, retryAfter: response.headers['retry-after'] }).toEqual({ status: 503, code: 'gateway_unavailable', retryAfter: '1' });
    expect(response.json.error.message).toBe('The models cannot be reached while the daemon starts them again, and a run with a money budget or a mandate needs their prices. The request was not run; send it again.');
    expect(env.store.listRuns(session.id)).toEqual([]);
  });

  it('is refused with a typed answer that names both causes when the supervisor cannot be asked either', async () => {
    const { env, session } = await serviceWith(new Error('connect ENOENT /run/supervisor.sock'));
    const response = await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'say hello' } });
    expect({ status: response.status, body: response.json, retryAfter: response.headers['retry-after'] }).toEqual({
      status: 503,
      body: {
        error: {
          type: 'server_error',
          code: 'gateway_unavailable',
          message: 'The models cannot be reached, and the supervisor of the daemon could not be asked why: connect ENOENT /run/supervisor.sock. The request was not run; send it again.',
        },
      },
      retryAfter: '1',
    });
    expect(env.errors).toEqual([]);
    expect(env.store.listRuns(session.id)).toEqual([]);
  });
});
