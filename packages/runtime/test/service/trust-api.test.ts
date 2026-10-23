import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { expectError, expectSchema, startService } from './helpers.ts';
import type { JsonResponse, ServiceEnv } from './helpers.ts';

const query = (target: string): string => `/v1/trust?path=${encodeURIComponent(target)}`;

const workTree = (env: ServiceEnv) => {
  const work = path.join(env.layout.root, 'work');
  const app = path.join(work, 'app');
  fs.mkdirSync(app, { recursive: true });
  const file = path.join(env.layout.root, 'file.txt');
  fs.writeFileSync(file, 'x');
  const loop = path.join(env.layout.root, 'loop-a');
  fs.symlinkSync(path.join(env.layout.root, 'loop-b'), loop);
  fs.symlinkSync(loop, path.join(env.layout.root, 'loop-b'));
  return { work, app, file, loop, missing: path.join(env.layout.root, 'missing') };
};

const expectPathRejected = (response: JsonResponse, message: string | RegExp): void => {
  expect({ status: response.status, body: response.json }).toEqual({
    status: 400,
    body: { error: { type: 'invalid_request', code: 'invalid_request', param: 'path', message: typeof message === 'string' ? message : expect.stringMatching(message) } },
  });
};

describe('trust api (fake timers)', () => {
  it('PUT 200 with the envelope', async () => {
    const env = await startService({ fakeTimers: true });
    const { work } = workTree(env);
    const link = path.join(env.layout.root, 'work-link');
    fs.symlinkSync(work, link, 'dir');

    const response = await env.http('PUT', '/v1/trust', { body: { path: link, decision: 'trusted' } });

    expect(response.status).toBe(200);
    expect(response.json).toEqual({ trust: { path: work, decision: 'trusted' } });
    expect(env.store.trust.decisionFor(work)).toEqual({ decision: 'trusted' });
  });

  it('GET inherited and exact views', async () => {
    const env = await startService({ fakeTimers: true });
    const { work, app } = workTree(env);
    const untouched = path.join(env.layout.root, 'untouched');
    fs.mkdirSync(untouched);
    expect((await env.http('PUT', '/v1/trust', { body: { path: work, decision: 'trusted' } })).status).toBe(200);

    const exact = await env.http('GET', query(work));
    expect(exact.status).toBe(200);
    expect(exact.json).toEqual({ trust: { path: work, decision: 'trusted' } });

    const inherited = await env.http('GET', query(app));
    expect(inherited.status).toBe(200);
    expect(inherited.json).toEqual({ trust: { path: app, decision: 'trusted', inheritedFrom: work } });

    const unset = await env.http('GET', query(untouched));
    expect(unset.json).toEqual({ trust: { path: untouched, decision: null } });

    const encoded = await env.http('GET', `/v1/trust?path=${encodeURIComponent(path.join(work, '..', 'work', 'app'))}`);
    expect(encoded.json).toEqual({ trust: { path: app, decision: 'trusted', inheritedFrom: work } });
  });

  it('GET 404 for a missing path (code missing)', async () => {
    const env = await startService({ fakeTimers: true });
    const { missing } = workTree(env);
    const response = await env.http('GET', query(missing));
    expectError(response, 404, 'not_found');
    expect(response.json.error.message).not.toBe('no such route');
    expect(response.json.error.message).toContain(missing);
  });

  it('GET 400 for a file, a relative path, an unresolvable path and a missing query', async () => {
    const env = await startService({ fakeTimers: true });
    const { file, loop } = workTree(env);
    expectPathRejected(await env.http('GET', query(file)), `path ${file} is not a directory`);
    expectPathRejected(await env.http('GET', query('relative/dir')), 'path relative/dir must be an absolute path');
    expectPathRejected(await env.http('GET', query(loop)), new RegExp(`^path ${loop} cannot be resolved: .+`));
    expectPathRejected(await env.http('GET', query(path.join(file, 'child'))), new RegExp(`^path ${file}/child cannot be resolved: .+`));
    const noQuery = await env.http('GET', '/v1/trust');
    expect({ status: noQuery.status, code: noQuery.json?.error?.code, param: noQuery.json?.error?.param }).toEqual({ status: 400, code: 'invalid_request', param: 'path' });
  });

  it('PUT 400 for trusted on /, a missing path, a file and a relative path', async () => {
    const env = await startService({ fakeTimers: true });
    const { file, missing } = workTree(env);

    const root = await env.http('PUT', '/v1/trust', { body: { path: '/', decision: 'trusted' } });
    expect({ status: root.status, code: root.json?.error?.code, param: root.json?.error?.param }).toEqual({ status: 400, code: 'invalid_request', param: 'decision' });
    expect(env.store.trust.decisionFor('/')).toEqual({ decision: null });

    expectPathRejected(await env.http('PUT', '/v1/trust', { body: { path: missing, decision: 'trusted' } }), `path ${missing} does not exist`);
    expectPathRejected(await env.http('PUT', '/v1/trust', { body: { path: file, decision: 'untrusted' } }), `path ${file} is not a directory`);
    expectPathRejected(await env.http('PUT', '/v1/trust', { body: { path: 'relative/dir', decision: 'trusted' } }), 'path relative/dir must be an absolute path');
    expectError(await env.http('PUT', '/v1/trust', { body: { path: '', decision: 'trusted' } }), 400, 'invalid_request');
    expectError(await env.http('PUT', '/v1/trust', { body: { path: missing, decision: 'maybe' } }), 400, 'invalid_request');
    expectError(await env.http('PUT', '/v1/trust', { body: { path: missing, decision: 'trusted', extra: true } }), 400, 'invalid_request');
  });

  it('PUT untrusted on / is allowed and returns 200', async () => {
    const env = await startService({ fakeTimers: true });
    const response = await env.http('PUT', '/v1/trust', { body: { path: '/', decision: 'untrusted' } });
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ trust: { path: '/', decision: 'untrusted' } });
    expect(env.store.trust.decisionFor('/')).toEqual({ decision: 'untrusted' });
  });

  it('DELETE 204 for an existing, missing or never-set path', async () => {
    const env = await startService({ fakeTimers: true });
    const { work, app, missing } = workTree(env);
    await env.http('PUT', '/v1/trust', { body: { path: work, decision: 'trusted' } });

    const existing = await env.http('DELETE', query(work));
    expect({ status: existing.status, text: existing.text }).toEqual({ status: 204, text: '' });
    expect((await env.http('GET', query(work))).json).toEqual({ trust: { path: work, decision: null } });

    const gone = await env.http('DELETE', query(missing));
    expect({ status: gone.status, text: gone.text }).toEqual({ status: 204, text: '' });

    const neverSet = await env.http('DELETE', query(app));
    expect({ status: neverSet.status, text: neverSet.text }).toEqual({ status: 204, text: '' });

    const relative = await env.http('DELETE', query('relative/dir'));
    expect({ status: relative.status, code: relative.json?.error?.code }).toEqual({ status: 400, code: 'invalid_request' });
    const noQuery = await env.http('DELETE', '/v1/trust');
    expect({ status: noQuery.status, code: noQuery.json?.error?.code }).toEqual({ status: 400, code: 'invalid_request' });
  });

  it('DELETE clears the decision of a since-deleted path by its recorded path', async () => {
    const env = await startService({ fakeTimers: true });
    const { work, app } = workTree(env);
    await env.http('PUT', '/v1/trust', { body: { path: app, decision: 'trusted' } });
    fs.rmSync(work, { recursive: true });
    expect((await env.http('DELETE', query(app))).status).toBe(204);
    fs.mkdirSync(app, { recursive: true });
    expect((await env.http('GET', query(app))).json).toEqual({ trust: { path: app, decision: null } });
  });

  it('405 with an allow header for other methods', async () => {
    const env = await startService({ fakeTimers: true });
    for (const method of ['POST', 'PATCH']) {
      const response = await env.http(method, '/v1/trust', { body: { path: env.layout.project, decision: 'trusted' } });
      expectError(response, 405, 'method_not_allowed');
      expect(response.headers['allow']).toBe('GET, PUT, DELETE, HEAD');
    }
  });

  it('all three work while draining', async () => {
    const env = await startService({ fakeTimers: true });
    const { work } = workTree(env);
    env.service.beginDraining();
    const put = await env.http('PUT', '/v1/trust', { body: { path: work, decision: 'untrusted' } });
    expect(put.json).toEqual({ trust: { path: work, decision: 'untrusted' } });
    expect((await env.http('GET', query(work))).json).toEqual({ trust: { path: work, decision: 'untrusted' } });
    expect((await env.http('DELETE', query(work))).status).toBe(204);
    expect(env.store.trust.decisionFor(work)).toEqual({ decision: null });
  });

  it('responses validate against TrustResponse', async () => {
    const env = await startService({ fakeTimers: true });
    const { work, app } = workTree(env);
    const responses = [
      await env.http('PUT', '/v1/trust', { body: { path: work, decision: 'trusted' } }),
      await env.http('GET', query(work)),
      await env.http('GET', query(app)),
      await env.http('GET', query(env.layout.project)),
    ];
    for (const response of responses) {
      expect(response.status).toBe(200);
      expectSchema('TrustResponse', response.json);
    }
  });
});
