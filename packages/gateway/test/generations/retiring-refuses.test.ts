import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { GENERATION_RETIRED_CODE } from '@momonga/foundation';
import { createScriptedAdapter, textResponseEvents } from '@momonga/testkit';
import { PRIMARY, getJson, postJson, readJson, startGateway, switchableRole, userInput } from '../gateway-helpers.ts';

const RETIRED_MESSAGE = 'This gateway belongs to a replaced generation and takes no new requests. The request was not run; send it again.';

const textCall = (text: string) => ({ events: textResponseEvents({ model: 'scripted-primary', chunks: [text] }) });

const upgradeStatus = (socketPath: string): Promise<number | 'open'> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws+unix://${socketPath}:/v1/responses`);
    socket.once('open', () => {
      socket.close();
      resolve('open');
    });
    socket.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
    socket.once('error', reject);
  });

const retiringGateway = async () => {
  const role = switchableRole('retiring');
  const primary = createScriptedAdapter({ calls: [textCall('never sent')], compactSummary: 'never sent' });
  const harness = await startGateway({ adapters: { [PRIMARY]: primary }, role });
  return { ...harness, primary, role };
};

describe('a retiring gateway refuses new calls and sends nothing upstream (design-update 18.1, 20.3, 20.60)', () => {
  it.each([
    ['/v1/responses', { model: PRIMARY, input: userInput('hi') }],
    ['/v1/responses/compact', { model: PRIMARY, input: userInput('hi') }],
    ['/v1/momonga/count_tokens', { model: PRIMARY, input: userInput('hi') }],
  ])('answers POST %s with 503 generation_retired and the text of 18.1, and closes the connection', async (route, body) => {
    const { client, primary } = await retiringGateway();

    const refused = await readJson(await postJson(client, route, body));

    expect(refused.status).toBe(503);
    expect(refused.body).toEqual({ error: { type: 'server_error', code: GENERATION_RETIRED_CODE, message: RETIRED_MESSAGE, param: null } });
    expect(refused.headers['connection']).toBe('close');
    expect(primary.calls).toEqual([]);
    expect(primary.compactCalls).toEqual([]);
    expect(primary.countCalls).toEqual([]);
  });

  it('refuses a WebSocket upgrade with 503 Service Unavailable', async () => {
    const { socketPath } = await retiringGateway();

    expect(await upgradeStatus(socketPath)).toBe(503);
  });

  it('refuses a new request on a WebSocket connection opened before retirement, and closes the connection', async () => {
    const role = switchableRole('serving');
    const primary = createScriptedAdapter({ calls: [textCall('never sent')] });
    const { socketPath } = await startGateway({ adapters: { [PRIMARY]: primary }, role });
    const socket = new WebSocket(`ws+unix://${socketPath}:/v1/responses`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const answered = new Promise<Record<string, unknown>>((resolve) => socket.once('message', (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>)));
    const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));

    role.become('retiring');
    socket.send(JSON.stringify({ type: 'response.create', model: PRIMARY, store: false, input: userInput('hi') }));

    expect(await answered).toMatchObject({ type: 'error', status: 503, error: { code: GENERATION_RETIRED_CODE, message: RETIRED_MESSAGE } });
    expect(await closed).toBe(1001);
    expect(primary.calls).toEqual([]);
  });

  it('closes an idle WebSocket connection when the gateway releases its idle connections', async () => {
    const role = switchableRole('serving');
    const { gateway, socketPath } = await startGateway({ adapters: { [PRIMARY]: createScriptedAdapter({ calls: [] }) }, role });
    const socket = new WebSocket(`ws+unix://${socketPath}:/v1/responses`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));

    role.become('retiring');
    gateway.releaseIdleConnections();

    expect(await closed).toBe(1001);
  });

  it('answers a cancel of an unknown id with 200 and cancelled false, as while serving', async () => {
    const { client } = await retiringGateway();

    const answered = await readJson(await postJson(client, '/v1/momonga/responses/cancel', '', { 'idempotency-key': '"never-accepted"' }));

    expect(answered.status).toBe(200);
    expect(answered.body).toEqual({ cancelled: false });
  });

  it('serves the reads: models, the momonga model list and health with state retiring and no active request', async () => {
    const { client } = await retiringGateway();

    expect((await getJson(client, '/v1/models')).status).toBe(200);
    expect((await getJson(client, '/v1/momonga/models')).status).toBe(200);
    const health = await getJson(client, '/v1/momonga/health');
    expect(health.status).toBe(200);
    expect(health.body.state).toBe('retiring');
    expect(health.body.activeRequests).toBe(0);
  });

  it('answers the billed calls route and an unknown route by their own rule, not with the refusal', async () => {
    const { client } = await retiringGateway();

    const calls = await readJson(await postJson(client, '/v1/momonga/cost/calls', { runIds: [], cursor: { run: 0, after: 0 }, limit: 1, includeRunless: false }));
    const unknown = await getJson(client, '/v1/momonga/no-such-route');

    expect([calls.status, calls.body.error.code]).toEqual([404, 'cost_unavailable']);
    expect([unknown.status, unknown.body.error.code]).toEqual([404, 'route_not_found']);
  });

  it('serves calls while its role is starting or serving, and reports state running', async () => {
    const role = switchableRole('starting');
    const primary = createScriptedAdapter({ calls: [textCall('one'), textCall('two')] });
    const { client } = await startGateway({ adapters: { [PRIMARY]: primary }, role });

    expect((await readJson(await postJson(client, '/v1/responses', { model: PRIMARY, input: userInput('hi') }))).status).toBe(200);
    role.become('serving');
    const served = await postJson(client, '/v1/responses', { model: PRIMARY, input: userInput('hi') });
    expect(served.status).toBe(200);
    expect(served.headers['connection']).not.toBe('close');
    await served.text();
    expect((await getJson(client, '/v1/momonga/health')).body.state).toBe('running');
  });
});
