import { describe, expect, it } from 'vitest';
import { ConfigError } from '@momonga/config';
import type { GenerationRole } from '@momonga/foundation';
import { mutableRole } from '../shared/mutable-role.ts';
import { expectError, startService } from './helpers.ts';
import type { DelegationPort, JsonResponse, ServiceEnv } from './helpers.ts';

const MONEY_LIMIT_USD = 2;

const standingMoneyLimit: DelegationPort = {
  settings: async () => ({ limits: { maxCostUsd: MONEY_LIMIT_USD } }),
  projectMandate: async () => undefined,
  chainBilling: async () => ({ metered: true, priced: true }),
};

const compact = (env: ServiceEnv, sessionId: string): Promise<JsonResponse> => env.http('POST', `/v1/sessions/${sessionId}/compact`, { body: {} });

const addInbox = (env: ServiceEnv, sessionId: string): Promise<JsonResponse> => env.http('POST', `/v1/sessions/${sessionId}/inbox`, { body: { delivery: 'queue', text: 'then the docs' } });

const serviceIn = async (role: GenerationRole, openRun: boolean) => {
  const state = mutableRole('serving');
  const env = await startService({ fakeTimers: true, role: state.port });
  const session = await env.createSession();
  if (openRun) await env.createRun(session.id);
  state.set(role);
  env.service.applyRole();
  return { env, session };
};

describe('the terms of every new run come from one computation', () => {
  it('gives the run of POST compact the standing money limit of the user settings', async () => {
    const env = await startService({ delegation: standingMoneyLimit });
    const session = await env.createSession();

    const response = await compact(env, session.id);

    expect(response.status).toBe(202);
    expect(env.store.getRun(response.json.run.id)?.limits).toMatchObject({ maxCostUsd: MONEY_LIMIT_USD });
  });

  it('gives the run that POST inbox starts when no run is open the standing money limit', async () => {
    const env = await startService({ delegation: standingMoneyLimit });
    const session = await env.createSession();

    expect((await addInbox(env, session.id)).status).toBe(201);

    const runs = env.store.listRuns(session.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.limits).toMatchObject({ maxCostUsd: MONEY_LIMIT_USD });
  });

  it('stores the terms on a message that waits behind an open run', async () => {
    const env = await startService({ delegation: standingMoneyLimit });
    const session = await env.createSession();
    await env.createRun(session.id);

    expect((await addInbox(env, session.id)).status).toBe(201);

    expect(env.store.inbox.list(session.id)[0]?.queued?.terms.limits).toMatchObject({ maxCostUsd: MONEY_LIMIT_USD });
  });

  it('refuses a money limit on a model without a price on every route that creates a run', async () => {
    const env = await startService({ delegation: { ...standingMoneyLimit, chainBilling: async () => ({ metered: true, priced: false }) } });
    const session = await env.createSession();

    expectError(await compact(env, session.id), 400, 'invalid_request');
    expectError(await addInbox(env, session.id), 400, 'invalid_request');

    expect(env.store.listRuns(session.id)).toEqual([]);
  });
});

describe('the admission of every new run is one check', () => {
  it('refuses POST compact and POST inbox with the settings refusal while the settings file is invalid, as POST runs does', async () => {
    const env = await startService();
    const session = await env.createSession();
    env.ports.settingsFailure.error = new ConfigError('settings.json: permissions.allow[0] is not a rule');

    const refusedRun = await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'x' } });
    const refusedCompact = await compact(env, session.id);
    const refusedInbox = await addInbox(env, session.id);

    expectError(refusedRun, 422, 'config_error');
    expect(refusedCompact.json).toEqual(refusedRun.json);
    expect(refusedCompact.status).toBe(422);
    expect(refusedInbox.json).toEqual(refusedRun.json);
    expect(refusedInbox.status).toBe(422);
    expect(env.store.listRuns(session.id)).toEqual([]);
    expect(env.store.inbox.list(session.id)).toEqual([]);
  });

  it('refuses POST compact and POST inbox while the model of the session is not configured, as POST runs does', async () => {
    const env = await startService();
    const session = await env.createSession();
    env.ports.listed.splice(0, env.ports.listed.length, 'another-model');

    const refusedRun = await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'x' } });

    expectError(refusedRun, 404, 'model_not_found');
    expect((await compact(env, session.id)).json).toEqual(refusedRun.json);
    expect((await addInbox(env, session.id)).json).toEqual(refusedRun.json);
    expect(env.store.listRuns(session.id)).toEqual([]);
  });
});

describe('a message for the inbox on a generation that is not serving', () => {
  it('is answered moved by a retiring runtime when it would start a run', async () => {
    const { env, session } = await serviceIn('retiring', false);

    expectError(await addInbox(env, session.id), 503, 'moved');

    expect(env.store.listRuns(session.id)).toEqual([]);
    expect(env.store.inbox.list(session.id)).toEqual([]);
  });

  it('is accepted by a retiring runtime when a run is open: it only writes a row', async () => {
    const { env, session } = await serviceIn('retiring', true);

    expect((await addInbox(env, session.id)).status).toBe(201);

    expect(env.store.listRuns(session.id)).toHaveLength(1);
    expect(env.store.inbox.list(session.id)).toHaveLength(1);
  });
});

describe('a starting runtime says that it is starting', () => {
  const expectStarting = (response: JsonResponse): void => {
    expect({ status: response.status, error: response.json.error, retryAfter: response.headers['retry-after'] }).toEqual({
      status: 503,
      error: { type: 'server_error', code: 'starting', message: 'The daemon is still starting and accepts no new work yet. The request was not run; send it again.' },
      retryAfter: '1',
    });
  };

  it('answers the routes that create a run or a session with the starting refusal, not moved', async () => {
    const { env, session } = await serviceIn('starting', false);

    expectStarting(await env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: { PATH: '/usr/bin:/bin' } } }));
    expectStarting(await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'new work' } }));
    expectStarting(await compact(env, session.id));
    expectStarting(await addInbox(env, session.id));

    expect(env.store.listRuns(session.id)).toEqual([]);
  });

  it('accepts a message behind an open run', async () => {
    const { env, session } = await serviceIn('starting', true);

    expect((await addInbox(env, session.id)).status).toBe(201);
  });
});
