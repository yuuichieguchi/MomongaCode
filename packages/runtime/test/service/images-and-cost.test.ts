import { describe, expect, it } from 'vitest';
import { toPublicRunEvent } from '@momonga/protocol';
import { expectError, startService } from './helpers.ts';

const PNG_BYTES = Buffer.from('fake png bytes');
const totals = { calls: 1, unpricedCalls: 0, inputTokens: 2, outputTokens: 3, cachedInputTokens: 0, amount: 0.5, currency: 'USD', priceVersions: ['v1'] };
const IMAGE = { mediaType: 'image/png', data: PNG_BYTES.toString('base64') };

describe('POST /v1/sessions/:id/runs with images', () => {
  it('records the images on the user message when the model alias declares image input', async () => {
    const env = await startService({ imageInput: true });
    const session = await env.createSession();

    const run = await env.createRun(session.id, { input: 'what is this', images: [IMAGE] });

    const [first] = env.store.readRunEvents(run.id, 0, 1);
    expect(first).toMatchObject({ type: 'user.message', text: 'what is this', images: [IMAGE] });
    if (first === undefined) throw new Error('no first event');
    expect(toPublicRunEvent(first)).toMatchObject({ type: 'user.message', images: [{ mediaType: 'image/png', byteLength: PNG_BYTES.length }] });
    expect(JSON.stringify(toPublicRunEvent(first))).not.toContain(IMAGE.data);
  });

  it('refuses images with image_input_unsupported when the alias does not declare image input', async () => {
    const env = await startService({ imageInput: false });
    const session = await env.createSession();

    const response = await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'what is this', images: [IMAGE] } });

    expectError(response, 422, 'image_input_unsupported');
    expect(response.json.error).toMatchObject({ param: 'images' });
    expect(env.store.listRuns(session.id)).toEqual([]);
  });

  it.each([
    ['a media type outside the supported set', { mediaType: 'image/bmp', data: IMAGE.data }],
    ['data that is not base64', { mediaType: 'image/png', data: 'not base64!' }],
    ['empty data', { mediaType: 'image/png', data: '' }],
  ])('rejects %s', async (_label, image) => {
    const env = await startService({ imageInput: true });
    const session = await env.createSession();
    expectError(await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'x', images: [image] } }), 400, 'invalid_request');
  });
});

describe('GET /v1/cost', () => {
  it('answers the text rendering of the report when the format is text', async () => {
    const env = await startService({ runCost: async () => ({ report: { runs: [], sessions: [], total: totals }, text: 'the text report' }) });
    const response = await env.http('GET', '/v1/cost?format=text');
    expect(response.status).toBe(200);
    expect(response.text).toBe('the text report\n');
  });


  it('prices every run when no filter is given and answers what the cost port returns', async () => {
    const asked: unknown[] = [];
    const env = await startService({
      runCost: async (runs) => {
        asked.push(runs);
        return { report: { runs: [], sessions: [], total: totals }, text: 'the text report' };
      },
    });
    const session = await env.createSession();
    const run = await env.createRun(session.id, { input: 'x' });

    const response = await env.http('GET', '/v1/cost');

    expect(response.status).toBe(200);
    expect(response.json).toEqual({ runs: [], sessions: [], total: totals });
    expect(asked).toEqual([[{ runId: run.id, sessionId: session.id }]]);
  });

  it('narrows to a run, a session or a working directory and refuses two filters at once', async () => {
    const asked: unknown[] = [];
    const env = await startService({
      runCost: async (runs) => {
        asked.push(runs);
        return { report: { runs: [], sessions: [], total: totals }, text: 'the text report' };
      },
    });
    const session = await env.createSession();
    const run = await env.createRun(session.id, { input: 'x' });

    await env.http('GET', `/v1/cost?run=${run.id}`);
    await env.http('GET', `/v1/cost?session=${session.id}`);
    await env.http('GET', `/v1/cost?cwd=${encodeURIComponent(session.cwd)}`);

    const expected = [{ runId: run.id, sessionId: session.id }];
    expect(asked).toEqual([expected, expected, expected]);
    expectError(await env.http('GET', `/v1/cost?run=${run.id}&session=${session.id}`), 400, 'invalid_request');
    expectError(await env.http('GET', '/v1/cost?format=xml'), 400, 'invalid_request');
    expectError(await env.http('GET', '/v1/cost?run=missing'), 404, 'not_found');
    expectError(await env.http('GET', '/v1/cost?cwd=relative'), 400, 'invalid_request');
  });
});
