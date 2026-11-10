import { describe, expect, it } from 'vitest';
import type { ModelViews } from '@momonga/protocol';
import { textStep } from '../worker/scripts.ts';
import { attachWorkerKit, startService } from './helpers.ts';

const STORED = 'p1/x';
const WITH_X: ModelViews = [{ canon: STORED, provider: 'p1', ownName: 'x' }];
const WITH_OWN_NAME_P1_X: ModelViews = [{ canon: 'p1/p1/x', provider: 'p1', ownName: 'p1/x' }];
const LOCAL = 'local';

const sentenceOf = (stored: string): string => `The model "${stored}" of this session is not configured any more. Choose another with /model.`;

const sessionOnX = async () => {
  const env = await startService();
  env.ports.shown.views = WITH_X;
  const created = await env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: {} } });
  expect(created.json.session.model).toBe(STORED);
  return { env, session: created.json.session as { id: string; model: string } };
};

const runOn = (env: Awaited<ReturnType<typeof startService>>, sessionId: string) => env.http('POST', `/v1/sessions/${sessionId}/runs`, { body: { input: 'Say hello' } });

describe('a stored model is resolved by its full reference only (I-N4, design-model-names 2.2, 3.9)', () => {
  it('refuses a new run with 404 model_not_found when the stored text is now only the own name of another model', async () => {
    const { env, session } = await sessionOnX();
    env.ports.shown.views = WITH_OWN_NAME_P1_X;
    const refused = await runOn(env, session.id);
    expect(refused.status).toBe(404);
    expect(refused.json.error).toMatchObject({ type: 'not_found', code: 'model_not_found', param: 'model', message: sentenceOf(STORED) });
    expect(env.store.listRuns(session.id)).toEqual([]);
    expect(env.store.getSession(session.id)?.model).toBe(STORED);
  });

  it('lets the person choose a model for that session with a patch', async () => {
    const { env, session } = await sessionOnX();
    env.ports.shown.views = WITH_OWN_NAME_P1_X;
    const patched = await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { model: 'p1/p1/x' } });
    expect(patched.status).toBe(200);
    expect(patched.json.session.model).toBe('p1/p1/x');
    expect((await runOn(env, session.id)).status).toBe(202);
  });

  it('starts the run again once the entry is back under the same server and own name', async () => {
    const { env, session } = await sessionOnX();
    const kit = attachWorkerKit(env);
    env.ports.shown.views = WITH_OWN_NAME_P1_X;
    expect((await runOn(env, session.id)).status).toBe(404);
    env.ports.shown.views = WITH_X;
    const accepted = await runOn(env, session.id);
    expect(accepted.status).toBe(202);
    kit.gateway.script.push(textStep('Hello.'));
    await kit.runOnce(kit.worker('worker-1'));
    const run = env.store.getRun(accepted.json.run.id);
    expect(run?.status).toBe('COMPLETED');
    expect(env.ofType(accepted.json.run.id, 'run.started')[0]?.pins['model']).toBe(STORED);
  });

  it('opens a session that holds the name an earlier build stored, shows that name, and refuses a run with the same sentence', async () => {
    const env = await startService();
    env.ports.shown.views = WITH_X;
    const session = env.store.createSession({ cwd: env.layout.projectReal, env: {}, permissionMode: 'manual', model: LOCAL });
    const read = await env.http('GET', `/v1/sessions/${session.id}`);
    expect(read.status).toBe(200);
    expect(read.json.session.model).toBe(LOCAL);
    const runs = await env.http('GET', `/v1/sessions/${session.id}/runs`);
    expect(runs.status).toBe(200);
    const refused = await runOn(env, session.id);
    expect(refused.status).toBe(404);
    expect(refused.json.error).toMatchObject({ code: 'model_not_found', message: sentenceOf(LOCAL) });
  });

  it('ends a queued run of such a session failed with model_not_found and the sentence when it is claimed', async () => {
    const env = await startService();
    const kit = attachWorkerKit(env);
    const session = env.store.createSession({ cwd: env.layout.projectReal, env: {}, permissionMode: 'manual', model: LOCAL });
    const queued = env.store.createRunAndEnqueue(session.id, { input: 'Say hello', timeoutMs: 3_600_000, limits: {}, pins: {}, history: 'inherit' });
    if (queued.kind !== 'created') throw new Error(`the run was not created: ${queued.kind}`);
    kit.gateway.unlisted.add(LOCAL);
    await kit.runOnce(kit.worker('worker-1'));
    const run = env.store.getRun(queued.run.id);
    expect(run?.status).toBe('FAILED');
    expect(run?.error).toEqual({ code: 'model_not_found', message: sentenceOf(LOCAL) });
    expect(kit.gateway.streams).toEqual([]);
    expect(env.store.getSession(session.id)?.model).toBe(LOCAL);
  });
});
