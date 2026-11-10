import { describe, expect, it } from 'vitest';
import { createScriptedAdapter } from '@momonga/testkit';
import { expectErrorBody, postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';

const idleAdapter = () => createScriptedAdapter({ calls: [] });

describe('POST /v1/responses request errors', () => {
  it('rejects malformed JSON with 400 invalid_request', async () => {
    const primary = idleAdapter();
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary } });
    const response = await readJson(await postJson(client, '/v1/responses', '{"model": "scripted/scripted-primary", '));
    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expectErrorBody(response.body, { type: 'invalid_request', code: 'invalid_json', param: null });
    expect(primary.calls).toHaveLength(0);
  });

  it('rejects a schema-invalid body with param naming the offending field', async () => {
    const primary = idleAdapter();
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary } });
    const response = await readJson(
      await postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: userInput('hi'), max_output_tokens: 1 }),
    );
    expect(response.status).toBe(400);
    expectErrorBody(response.body, { type: 'invalid_request', code: 'invalid_body', param: 'max_output_tokens' });
    expect(primary.calls).toHaveLength(0);
  });

  it('names a nested field in param using bracket indices', async () => {
    const primary = idleAdapter();
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary } });
    const response = await readJson(
      await postJson(client, '/v1/responses', {
        model: 'scripted/scripted-primary',
        input: [{ type: 'function_call_output', call_id: 'x'.repeat(65), output: 'r' }],
      }),
    );
    expect(response.status).toBe(400);
    expectErrorBody(response.body, { type: 'invalid_request', code: 'invalid_body', param: 'input[0].call_id' });
  });

  it('rejects an unknown alias with 404 model_not_found naming the alias in the message', async () => {
    const primary = idleAdapter();
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary } });
    const response = await readJson(await postJson(client, '/v1/responses', { model: 'nope', input: userInput('hi') }));
    expect(response.status).toBe(404);
    expectErrorBody(response.body, { type: 'not_found', code: 'model_not_found', param: 'model' });
    expect(response.body.error.message).toContain('nope');
  });

  it('rejects a body over limits.maxBodyBytes with 413 payload_too_large without calling the adapter', async () => {
    const primary = idleAdapter();
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary }, config: { limits: { maxBodyBytes: 2048 } } });
    const body = JSON.stringify({ model: 'scripted/scripted-primary', input: 'x'.repeat(2100) });
    const response = await readJson(await postJson(client, '/v1/responses', body));
    expect(response.status).toBe(413);
    expectErrorBody(response.body, { type: 'invalid_request', code: 'payload_too_large', param: null });
    expect(response.body.error.message).toContain('2048');
    expect(primary.calls).toHaveLength(0);
  });

  it('keeps serving after a rejected request', async () => {
    const primary = idleAdapter();
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary } });
    await readJson(await postJson(client, '/v1/responses', '{'));
    const models = await client.request({ method: 'GET', path: '/v1/models' });
    expect(models.status).toBe(200);
    await models.text();
  });

  it('answers unknown paths with 404 not_found in the same error shape', async () => {
    const primary = idleAdapter();
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary } });
    const response = await readJson(await client.request({ method: 'GET', path: '/v1/unknown' }));
    expect(response.status).toBe(404);
    expectErrorBody(response.body, { type: 'not_found', code: 'route_not_found' });
  });
});
