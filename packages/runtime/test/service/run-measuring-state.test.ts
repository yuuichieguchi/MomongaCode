import { describe, expect, it } from 'vitest';
import { TARGET_NOT_READY, TARGET_PROBING, TARGET_PROBING_MESSAGE, measuringLineOf } from '@momonga/protocol';
import type { Measuring } from '@momonga/protocol';
import { GatewayRequestError } from '@momonga/runtime';
import { fakeClock, listedEntry, listingBody, makeClient, settle, startRawHttpFake } from '../gateway-client/fixtures.ts';
import { MODEL_ID, OTHER_MODEL_ID, defaultModelCapabilities, startService } from './helpers.ts';

const MEASURING: Measuring = { fields: ['toolCalling'], step: 'tool call', elapsedSeconds: 42, declaration: 'declare toolCalling for the model in its settings' };
const MEASURING_WIRE = { fields: ['toolCalling'], step: 'tool call', elapsed_seconds: 42, declaration: 'declare toolCalling for the model in its settings' };
const IMAGE = { mediaType: 'image/png', data: Buffer.from('fake png bytes').toString('base64') };

const measuringAnswerClient = async () => {
  const fake = await startRawHttpFake();
  fake.respond((_request, response) => {
    response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '30' });
    response.end(JSON.stringify({ error: { type: 'server_error', code: TARGET_PROBING, message: TARGET_PROBING_MESSAGE, param: null, measuring: MEASURING_WIRE } }));
  });
  return makeClient(fake.socketPath, fakeClock());
};

const measuringListingClient = async () => {
  const fake = await startRawHttpFake();
  fake.respond((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify(
        listingBody([
          listedEntry(MODEL_ID, { toolCalling: { state: 'probing', message: TARGET_PROBING_MESSAGE, retryAfterSeconds: 30, measuring: MEASURING }, source: 'unprobed' }),
          listedEntry(OTHER_MODEL_ID, defaultModelCapabilities(true)),
        ]),
      ),
    );
  });
  return makeClient(fake.socketPath, fakeClock());
};

describe('a run request made while the gateway measures the model', () => {
  it('reads the measuring state of the gateway answer into the typed error', async () => {
    const client = await measuringAnswerClient();
    const raised = await settle(client.capabilities(MODEL_ID, { signal: new AbortController().signal }));
    expect(raised).toBeInstanceOf(GatewayRequestError);
    expect(raised).toMatchObject({ status: 503, code: TARGET_PROBING, measuring: MEASURING, retryAfterMs: 30_000 });
  });

  it('reads the measuring state of a listed model into the typed error', async () => {
    const client = await measuringListingClient();
    const raised = await settle(client.capabilities(MODEL_ID, { signal: new AbortController().signal }));
    expect(raised).toMatchObject({ status: 503, code: TARGET_PROBING, measuring: MEASURING });
  });

  for (const [name, clientOf] of [
    ['answered 503 target_probing', measuringAnswerClient],
    ['listing the model as measured', measuringListingClient],
  ] as const) {
    it(`is answered at once with the step, the elapsed time and the declaration when the gateway is ${name}`, async () => {
      const client = await clientOf();
      const env = await startService({ capabilitiesOf: (model) => client.capabilities(model, { signal: new AbortController().signal }) });
      const session = await env.createSession();
      const response = await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'what is this', images: [IMAGE] } });

      expect({ status: response.status, body: response.json }).toEqual({
        status: 409,
        body: { error: { type: 'conflict', code: TARGET_NOT_READY, message: measuringLineOf(MEASURING), measuring: MEASURING_WIRE } },
      });
      expect(env.errors).toEqual([]);
      expect(env.store.listRuns(session.id)).toEqual([]);
    });
  }

  it('keeps the code and text of a gateway error with a code the service does not know', async () => {
    const fake = await startRawHttpFake();
    fake.respond((_request, response) => {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { type: 'server_error', code: 'kettle_boiling', message: 'the kettle is boiling', param: null } }));
    });
    const client = makeClient(fake.socketPath, fakeClock());
    const env = await startService({ capabilitiesOf: (model) => client.capabilities(model, { signal: new AbortController().signal }) });
    const session = await env.createSession();
    const response = await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'what is this', images: [IMAGE] } });

    expect(response.status).not.toBe(500);
    expect(response.json.error).toMatchObject({ code: 'kettle_boiling', message: 'the kettle is boiling' });
    expect(env.errors).toEqual([]);
  });
});
