import http from 'node:http';
import path from 'node:path';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import type { TestContext } from 'vitest';
import { describe, expect, it } from 'vitest';
import { fixedSocket } from '@momonga/foundation';
import { GatewayAnswerError, createGatewayClient } from '../src/client/gateway-client.ts';
import type { GatewayClient } from '../src/client/gateway-client.ts';

const AUTHORIZATION_URL = 'https://auth.example.test/oauth/authorize?state=leaked-state&code_challenge=leaked-challenge';

const LEAKED = ['leaked-state', 'leaked-challenge', 'auth.example.test', 'https://', 'leaked-body'];

const serve = async (context: TestContext, status: number, body: string): Promise<GatewayClient> => {
  const socketPath = path.join(withTempDir(context), 'g.sock');
  const server = http.createServer((request, response) => {
    request.resume();
    response.writeHead(status, { 'content-type': 'application/json' }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const client = createGatewayClient({ resolveSocket: fixedSocket(socketPath) });
  registerCleanup(context, async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return client;
};

const refusalOf = (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => undefined,
    (error: unknown) => error,
  );

const messageOf = (error: unknown): string | undefined => (error instanceof Error ? error.message : undefined);

type Site = { name: string; call: (client: GatewayClient) => Promise<unknown>; text: string };

const SITES: readonly Site[] = [
  { name: 'sign-in/begin', call: (client) => client.plan.signInBegin({ profile: 'chatgpt', account: 'work', port: 1455 }), text: 'POST /v1/momonga/plan/sign-in/begin answered a body that is not a sign-in attempt' },
  { name: 'accounts', call: (client) => client.plan.accounts(), text: 'GET /v1/momonga/plan/accounts answered a body that is not an account list' },
  {
    name: 'the model catalog of an account (its route has a query)',
    call: (client) => client.plan.accountModels('work', { profile: 'leaked-body', refresh: true }),
    text: 'GET /v1/momonga/plan/accounts/work/models answered a body that is not a model catalog',
  },
  { name: 'health', call: (client) => client.health(), text: 'GET /v1/momonga/health answered a body that is not a gateway health report' },
  { name: 'the model list', call: (client) => client.models(), text: 'GET /v1/momonga/models answered a body that is not a model list' },
  { name: 'the usage of a run (its route has a query)', call: (client) => client.usageOf('leaked-body'), text: 'GET /v1/momonga/usage answered a body that is not a usage report' },
];

const MALFORMED_BODIES: ReadonlyArray<{ name: string; body: string }> = [
  { name: 'JSON of another shape that holds an authorization URL', body: JSON.stringify({ attemptId: 7, authorizationUrl: AUTHORIZATION_URL, note: 'leaked-body' }) },
  { name: 'text that is not JSON', body: `<html>leaked-body ${AUTHORIZATION_URL}</html>` },
  { name: 'JSON nested deeper than the limit', body: `${'['.repeat(5000)}"leaked-body"${']'.repeat(5000)}` },
];

describe('a 2xx answer of the gateway whose body fails the client check is named by its method, route and kind, and nothing of the body follows (A6)', () => {
  for (const site of SITES) {
    it.for(MALFORMED_BODIES)(`${site.name}: $name`, async ({ body }, context) => {
      const client = await serve(context, 200, body);
      const message = messageOf(await refusalOf(site.call(client)));
      expect(message).toBe(site.text);
      for (const leaked of LEAKED) expect(message).not.toContain(leaked);
    });
  }

  it('the refusal of a plan route is a GatewayAnswerError with no answer body', async (context) => {
    const client = await serve(context, 200, JSON.stringify({ authorizationUrl: AUTHORIZATION_URL }));
    const refusal = await refusalOf(client.plan.signInBegin({ profile: 'chatgpt', account: 'work', port: 1455 }));
    expect(refusal).toBeInstanceOf(GatewayAnswerError);
    expect(refusal).toMatchObject({ status: 200, answer: undefined });
    expect(refusal instanceof Error ? refusal.cause : 'no error').toBeUndefined();
  });
});

describe('an answer that is not 2xx keeps the message the gateway wrote', () => {
  it('a refused sign-in carries the code and the message of the answer', async (context) => {
    const client = await serve(context, 409, JSON.stringify({ error: { code: 'plan_sign_in_refused', message: 'the gateway wrote this sentence' } }));
    const refusal = await refusalOf(client.plan.signInBegin({ profile: 'chatgpt', account: 'work', port: 1455 }));
    expect(refusal).toBeInstanceOf(GatewayAnswerError);
    expect(refusal).toMatchObject({ status: 409, answer: { code: 'plan_sign_in_refused', message: 'the gateway wrote this sentence' } });
    expect(messageOf(refusal)).toContain('the gateway wrote this sentence');
  });
});
