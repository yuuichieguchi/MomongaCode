import { describe, expect, it } from 'vitest';
import { PLAN_API_PREFIX, PLAN_ROUTES, QUOTE_ROUTE } from '@momonga/protocol';
import { createScriptedAdapter } from '@momonga/testkit';
import { PRIMARY, postJson, readJson, startGateway } from '../gateway-helpers.ts';

const NOT_AN_OBJECT = ['null', '[]', '"x"'] as const;

const OBJECT_BODY_ROUTES = ['/v1/responses', '/v1/responses/compact', '/v1/momonga/count_tokens', QUOTE_ROUTE, '/v1/momonga/cost/calls'] as const;

const PLAN_BODY_ROUTES = [PLAN_ROUTES.accountsActive, PLAN_ROUTES.signInBegin, PLAN_ROUTES.signInComplete, PLAN_ROUTES.signInCancel, PLAN_ROUTES.signOut].map((route) => `${PLAN_API_PREFIX}${route}`);

const cases = (routes: readonly string[]): Array<[string, string]> => routes.flatMap((route) => NOT_AN_OBJECT.map((body): [string, string] => [route, body]));

const gateway = () =>
  startGateway({
    adapters: { [PRIMARY]: createScriptedAdapter({ calls: [] }) },
    billedCalls: async () => {
      throw new Error('the billed calls must not be read for a body that is not an object');
    },
  });

describe('every route checks the shape of its body before it reads a field (gateway-core-C18)', () => {
  it.each(cases(OBJECT_BODY_ROUTES))('answers POST %s with the body %s with 400', async (route, body) => {
    const { client } = await gateway();

    const answer = await readJson(await postJson(client, route, body));

    expect(answer.status).toBe(400);
    expect(answer.body.error.type).toBe('invalid_request');
  });

  it.each(cases(PLAN_BODY_ROUTES))('never answers POST %s with the body %s with a server error', async (route, body) => {
    const { client } = await gateway();

    const answer = await readJson(await postJson(client, route, body));

    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(answer.status).toBeLessThan(500);
  });
});
