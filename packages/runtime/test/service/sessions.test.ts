import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTO_MODE_UNAVAILABLE } from '@momonga/protocol';
import { DECLARED_CREDENTIAL, MODEL_ID, OTHER_MODEL_ID, SERVICE_PID, SERVICE_VERSION, STARTED_AT, START_MS, expectError, expectSchema, startService } from './helpers.ts';

const SECRET = 'hunter2-value';
const TOKEN_PREFIX = 'sk-';

describe('health', () => {
  it('reports the version, api version, pid, start time, state and sandbox', async () => {
    const env = await startService();
    const response = await env.http('GET', '/v1/health');
    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      status: 'ok',
      version: SERVICE_VERSION,
      apiVersion: 1,
      pid: SERVICE_PID,
      startedAt: STARTED_AT,
      state: 'running',
      sandbox: 'seatbelt',
    });
  });
});

describe('session creation, listing and reading', () => {
  it('creates a session and returns its view with a Location header', async () => {
    const env = await startService();
    const response = await env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: { PATH: '/usr/bin:/bin', LANG: 'C' } } });

    expect(response.status).toBe(201);
    const session = response.json.session;
    expect(response.headers['location']).toBe(`/v1/sessions/${session.id}`);
    expect(response.json.strippedEnvKeys).toEqual([]);
    expect(session).toEqual({
      id: expect.any(String),
      cwd: env.layout.projectReal,
      permissionMode: 'default',
      model: MODEL_ID,
      bypassAllowed: false,
      createdAt: START_MS,
      envKeys: expect.any(Array),
      activeRunId: null,
      latestRunId: null,
      additionalDirectories: [],
      lastEventId: 0,
    });
    expect([...session.envKeys].sort()).toEqual(['LANG', 'PATH']);
  });

  it('reads a session by id and lists sessions filtered by cwd', async () => {
    const env = await startService();
    const other = path.join(env.layout.root, 'o');
    fs.mkdirSync(other);
    const first = await env.createSession();
    const second = await env.createSession({ cwd: other });

    const read = await env.http('GET', `/v1/sessions/${first.id}`);
    expect(read.status).toBe(200);
    expect(read.json.session).toEqual(first);

    const filtered = await env.http('GET', `/v1/sessions?cwd=${encodeURIComponent(env.layout.project)}`);
    expect(filtered.status).toBe(200);
    expect(filtered.json.sessions.map((session: { id: string }) => session.id)).toEqual([first.id]);

    const all = await env.http('GET', '/v1/sessions');
    expect(all.json.sessions.map((session: { id: string }) => session.id).sort()).toEqual([first.id, second.id].sort());
  });

  it('returns 404 for an unknown session', async () => {
    const env = await startService();
    expectError(await env.http('GET', '/v1/sessions/ses_missing'), 404, 'not_found');
  });
});

describe('session cwd validation', () => {
  it('rejects a relative cwd', async () => {
    const env = await startService();
    expectError(await env.http('POST', '/v1/sessions', { body: { cwd: 'p', env: {} } }), 400, 'invalid_request');
  });

  it('rejects a missing cwd', async () => {
    const env = await startService();
    expectError(await env.http('POST', '/v1/sessions', { body: { cwd: path.join(env.layout.root, 'missing'), env: {} } }), 400, 'invalid_request');
  });

  it('rejects a cwd that is a file', async () => {
    const env = await startService();
    const file = path.join(env.layout.root, 'f.txt');
    fs.writeFileSync(file, 'x');
    expectError(await env.http('POST', '/v1/sessions', { body: { cwd: file, env: {} } }), 400, 'invalid_request');
  });

  it('stores a symlinked cwd as its realpath and finds it by realpath through ?cwd=', async () => {
    const env = await startService();
    const link = path.join(env.layout.root, 'l');
    fs.symlinkSync(env.layout.project, link, 'dir');

    const session = await env.createSession({ cwd: link });
    expect(session.cwd).toBe(env.layout.projectReal);

    const byLink = await env.http('GET', `/v1/sessions?cwd=${encodeURIComponent(link)}`);
    expect(byLink.json.sessions.map((entry: { id: string }) => entry.id)).toEqual([session.id]);
    const byReal = await env.http('GET', `/v1/sessions?cwd=${encodeURIComponent(env.layout.projectReal)}`);
    expect(byReal.json.sessions.map((entry: { id: string }) => entry.id)).toEqual([session.id]);
  });

  it('lists no sessions for a cwd that does not exist', async () => {
    const env = await startService();
    await env.createSession();
    const response = await env.http('GET', `/v1/sessions?cwd=${encodeURIComponent(path.join(env.layout.root, 'gone'))}`);
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ sessions: [] });
  });
});

describe('session credential stripping', () => {
  it('strips credentials from the stored env, reports their names and never returns values', async () => {
    const env = await startService();
    const input: Record<string, string> = {
      PGPASSWORD: `${SECRET}-pg`,
      MYSQL_PWD: `${SECRET}-mysql`,
      DB_PASS: `${SECRET}-db`,
      STRIPE_SECRET_KEY: `${SECRET}-stripe`,
      AWS_SESSION_TOKEN: `${SECRET}-aws`,
      GPG_PASSPHRASE: `${SECRET}-gpg`,
      DATABASE_URL: `postgres://app:${SECRET}-url@db.example.test/app`,
      TOOL_SETTING: `${TOKEN_PREFIX}${SECRET}-token`,
      [DECLARED_CREDENTIAL]: `${SECRET}-declared`,
      PWD: '/work',
      OLDPWD: '/old',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      GIT_AUTHOR_NAME: 'Momonga',
      TERM_SESSION_ID: 'w0t0p0',
      XDG_SESSION_TYPE: 'tty',
      PATH: '/usr/bin:/bin',
      HOME: '/home/me',
      LANG: 'C',
      REPO_URL: 'https://example.test/repo.git',
    };

    const created = await env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: input } });

    expect(created.status).toBe(201);
    expect(created.json.strippedEnvKeys).toEqual(
      ['AWS_SESSION_TOKEN', 'DATABASE_URL', 'DB_PASS', DECLARED_CREDENTIAL, 'GPG_PASSPHRASE', 'MYSQL_PWD', 'PGPASSWORD', 'SSH_AUTH_SOCK', 'STRIPE_SECRET_KEY', 'TERM_SESSION_ID', 'XDG_SESSION_TYPE'].sort(),
    );
    expect([...created.json.session.envKeys].sort()).toEqual(
      ['GIT_AUTHOR_NAME', 'HOME', 'LANG', 'OLDPWD', 'PATH', 'PWD', 'REPO_URL', 'TOOL_SETTING'].sort(),
    );
    expect(created.text).not.toContain(SECRET);
    expect(created.text).not.toContain('/home/me');

    const read = await env.http('GET', `/v1/sessions/${created.json.session.id}`);
    expect(read.text).not.toContain(SECRET);
    expect(read.text).not.toContain('example.test');

    const stored = env.store.getSession(created.json.session.id);
    expect(stored?.env).toEqual({
      PWD: '/work',
      OLDPWD: '/old',
      GIT_AUTHOR_NAME: 'Momonga',
      TOOL_SETTING: `${TOKEN_PREFIX}${SECRET}-token`,
      PATH: '/usr/bin:/bin',
      HOME: '/home/me',
      LANG: 'C',
      REPO_URL: 'https://example.test/repo.git',
    });
  });

  it('rejects an env with a non-string value', async () => {
    const env = await startService();
    expectError(await env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: { PATH: 1 } } }), 400, 'invalid_request');
  });
});

describe('session permission mode rules', () => {
  it('takes the default mode from the cwd settings', async () => {
    const env = await startService();
    env.ports.settingsByCwd.set(env.layout.projectReal, { defaultMode: 'acceptEdits', defaultModeOrigin: 'project' });
    const session = await env.createSession();
    expect(session).toMatchObject({ permissionMode: 'acceptEdits', bypassAllowed: false });
    expect(env.ports.settingsCalls.length).toBeGreaterThan(0);
  });

  it('falls back to default when settings name no mode', async () => {
    const env = await startService();
    const session = await env.createSession();
    expect(session.permissionMode).toBe('default');
  });

  it('allows bypass when the user settings default is bypassPermissions', async () => {
    const env = await startService();
    env.ports.settingsByCwd.set(env.layout.projectReal, { defaultMode: 'bypassPermissions', defaultModeOrigin: 'user' });
    const session = await env.createSession();
    expect(session).toMatchObject({ permissionMode: 'bypassPermissions', bypassAllowed: true });
  });

  it('keeps an explicit mode over the settings default while still allowing bypass from user settings', async () => {
    const env = await startService();
    env.ports.settingsByCwd.set(env.layout.projectReal, { defaultMode: 'bypassPermissions', defaultModeOrigin: 'user' });
    const session = await env.createSession({ permissionMode: 'plan' });
    expect(session).toMatchObject({ permissionMode: 'plan', bypassAllowed: true });
    const patched = await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { permissionMode: 'bypassPermissions' } });
    expect(patched.status).toBe(200);
    expect(patched.json.session.permissionMode).toBe('bypassPermissions');
  });

  it('rejects an explicit bypass without bypassAllowed with 403', async () => {
    const env = await startService();
    expectError(
      await env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: {}, permissionMode: 'bypassPermissions' } }),
      403,
      'mode_not_allowed',
    );
  });

  it('accepts an explicit bypass when the body sets bypassAllowed', async () => {
    const env = await startService();
    const session = await env.createSession({ permissionMode: 'bypassPermissions', bypassAllowed: true });
    expect(session).toMatchObject({ permissionMode: 'bypassPermissions', bypassAllowed: true });
  });

  it('rejects auto with 409 mode_unavailable', async () => {
    const env = await startService();
    const response = await env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: {}, permissionMode: 'auto' } });
    expectError(response, 409, AUTO_MODE_UNAVAILABLE.code);
    expect(response.json).toMatchObject({ error: { message: AUTO_MODE_UNAVAILABLE.message } });
  });

  it('accepts auto at creation and by PATCH when a known classifier model is configured', async () => {
    const env = await startService();
    env.ports.settingsByCwd.set(env.layout.projectReal, { autoModeClassifier: OTHER_MODEL_ID });
    const session = await env.createSession({ permissionMode: 'auto' });
    expect(session.permissionMode).toBe('auto');
    const other = await env.createSession();
    const patched = await env.http('PATCH', `/v1/sessions/${other.id}`, { body: { permissionMode: 'auto' } });
    expect(patched.status).toBe(200);
    expect(patched.json.session.permissionMode).toBe('auto');
  });

  it('rejects auto with 409 when the classifier model is not known to the gateway', async () => {
    const env = await startService();
    env.ports.settingsByCwd.set(env.layout.projectReal, { autoModeClassifier: 'missing-model' });
    const response = await env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: {}, permissionMode: 'auto' } });
    expectError(response, 409, AUTO_MODE_UNAVAILABLE.code);
    expect(response.json).toMatchObject({ error: { message: expect.stringContaining('missing-model') } });
  });

  it('rejects an unknown mode with 400', async () => {
    const env = await startService();
    expectError(await env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: {}, permissionMode: 'yolo' } }), 400, 'invalid_request');
  });
});

describe('session model', () => {
  it('accepts a known model', async () => {
    const env = await startService();
    const session = await env.createSession({ model: OTHER_MODEL_ID });
    expect(session.model).toBe(OTHER_MODEL_ID);
  });

  it('rejects an unknown model with 400', async () => {
    const env = await startService();
    expectError(await env.http('POST', '/v1/sessions', { body: { cwd: env.layout.project, env: {}, model: 'unknown-model' } }), 400, 'invalid_request');
  });
});

describe('session PATCH', () => {
  it('changes the mode, appends one session-scoped mode.changed and keeps it off run streams', async () => {
    const env = await startService();
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    env.append(env.claimRun(run.id), env.notices(1));

    const patched = await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { permissionMode: 'acceptEdits' } });

    expect(patched.status).toBe(200);
    expect(patched.json.session).toMatchObject({ id: session.id, permissionMode: 'acceptEdits' });
    expect(env.store.getSession(session.id)?.permissionMode).toBe('acceptEdits');

    const sessionStream = await env.stream(`/v1/sessions/${session.id}/events`, { idField: 'id' });
    const seen = await sessionStream.until((event) => event.type === 'mode.changed');
    const modeChanged = seen.at(-1);
    expect(modeChanged).toMatchObject({ type: 'mode.changed', mode: 'acceptEdits', sessionId: session.id });
    expect(modeChanged).not.toHaveProperty('runId');
    expect(modeChanged).not.toHaveProperty('seq');
    expect(modeChanged).not.toHaveProperty('step');
    expect(modeChanged).not.toHaveProperty('leaseToken');

    const current = await env.getRun(run.id);
    const runStream = await env.stream(`/v1/runs/${run.id}/events`);
    const runFrames = await runStream.until((event) => event.seq === current.lastSeq);
    expect(runFrames.map((event) => event.type)).not.toContain('mode.changed');
    expect(env.runEvents(run.id).map((event) => event.type)).not.toContain('mode.changed');
  });

  it('accepts application/merge-patch+json', async () => {
    const env = await startService();
    const session = await env.createSession();
    const patched = await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { permissionMode: 'plan' }, contentType: 'application/merge-patch+json' });
    expect(patched.status).toBe(200);
    expect(patched.json.session.permissionMode).toBe('plan');
  });

  it('appends no event when the mode is unchanged', async () => {
    const env = await startService();
    const session = await env.createSession();
    await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { permissionMode: 'plan' } });
    const before = env.store.readSessionEvents(session.id, 0, 1000).length;

    const unchanged = await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { permissionMode: 'plan' } });

    expect(unchanged.status).toBe(200);
    expect(unchanged.json.session.permissionMode).toBe('plan');
    expect(env.store.readSessionEvents(session.id, 0, 1000)).toHaveLength(before);
  });

  it('applies the mode rules to PATCH', async () => {
    const env = await startService();
    const session = await env.createSession();
    expectError(await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { permissionMode: 'bypassPermissions' } }), 403, 'mode_not_allowed');
    const autoResponse = await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { permissionMode: 'auto' } });
    expectError(autoResponse, 409, AUTO_MODE_UNAVAILABLE.code);
    expect(autoResponse.json).toMatchObject({ error: { message: AUTO_MODE_UNAVAILABLE.message } });
    expectError(await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { permissionMode: 'plan', extra: true } }), 400, 'invalid_request');
    expectError(await env.http('PATCH', '/v1/sessions/ses_missing', { body: { permissionMode: 'plan' } }), 404, 'not_found');
    expect(env.store.getSession(session.id)?.permissionMode).toBe('default');
  });
});

describe('session PATCH of the model', () => {
  it('switches the model and appends one session-scoped model.changed that names both models', async () => {
    const env = await startService();
    const session = await env.createSession();

    const patched = await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { model: OTHER_MODEL_ID } });

    expect(patched.status).toBe(200);
    expect(patched.json.session).toMatchObject({ id: session.id, model: OTHER_MODEL_ID });
    expect(env.store.getSession(session.id)?.model).toBe(OTHER_MODEL_ID);
    const events = env.store.readSessionEvents(session.id, 0, 1000);
    expect(events.filter((event) => event.type === 'model.changed')).toEqual([
      { id: expect.any(Number), sessionId: session.id, createdAt: expect.any(Number), type: 'model.changed', model: OTHER_MODEL_ID, previousModel: session.model },
    ]);
    const stream = await env.stream(`/v1/sessions/${session.id}/events`, { idField: 'id' });
    const seen = await stream.until((event) => event.type === 'model.changed');
    expect(seen.at(-1)).toMatchObject({ type: 'model.changed', model: OTHER_MODEL_ID, previousModel: session.model, sessionId: session.id });
    expect(seen.at(-1)).not.toHaveProperty('runId');
  });

  it('appends no event when the model is unchanged', async () => {
    const env = await startService();
    const session = await env.createSession();
    const before = env.store.readSessionEvents(session.id, 0, 1000).length;

    const unchanged = await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { model: session.model } });

    expect(unchanged.status).toBe(200);
    expect(env.store.readSessionEvents(session.id, 0, 1000)).toHaveLength(before);
  });

  it('refuses a model the gateway does not list, and leaves the session as it was', async () => {
    const env = await startService();
    const session = await env.createSession();
    expectError(await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { model: 'unknown-model' } }), 400, 'invalid_request');
    expect(env.store.getSession(session.id)?.model).toBe(session.model);
    expect(env.store.readSessionEvents(session.id, 0, 1000).filter((event) => event.type === 'model.changed')).toEqual([]);
  });

  it('changes the session while a run is active, without touching the run or its journal', async () => {
    const env = await startService();
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    env.append(env.claimRun(run.id), env.notices(1));
    const before = env.runEvents(run.id);

    const patched = await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { model: OTHER_MODEL_ID } });

    expect(patched.status).toBe(200);
    expect(patched.json.session).toMatchObject({ model: OTHER_MODEL_ID, activeRunId: run.id });
    expect(env.runEvents(run.id)).toEqual(before);
    expect((await env.getRun(run.id)).status).toBe('RUNNING');
  });

  it('can be combined with a mode change in one request', async () => {
    const env = await startService();
    const session = await env.createSession();
    const patched = await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { model: OTHER_MODEL_ID, permissionMode: 'plan' } });
    expect(patched.json.session).toMatchObject({ model: OTHER_MODEL_ID, permissionMode: 'plan' });
  });

  it('is answered with the schema of the session view', async () => {
    const env = await startService();
    const session = await env.createSession();
    const patched = await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { model: OTHER_MODEL_ID } });
    expectSchema('SessionView', patched.json.session);
  });
});

describe('session lastEventId', () => {
  it('is the id of the newest event of the session, so a stream can start after it', async () => {
    const env = await startService();
    const session = await env.createSession();
    expect(session.lastEventId).toBe(0);
    const run = await env.createRun(session.id);
    const claim = env.claimRun(run.id, 'worker-a');
    env.append(claim, [{ type: 'notice', level: 'info', message: 'one' }]);
    expect((await env.http('PATCH', `/v1/sessions/${session.id}`, { body: { permissionMode: 'plan' } })).status).toBe(200);

    const read = await env.http('GET', `/v1/sessions/${session.id}`);

    const newest = env.store.readSessionEvents(session.id, 0, 1000).at(-1);
    expect(newest).toMatchObject({ type: 'mode.changed' });
    expect(read.json.session.lastEventId).toBe(newest?.id);
    const stream = await env.stream(`/v1/sessions/${session.id}/events?after=${read.json.session.lastEventId}`, { idField: 'id' });
    expect(stream.status).toBe(200);
  });
});

describe('session run pointers and run listing', () => {
  it('tracks activeRunId as the lowest-ordinal non-terminal run and latestRunId as the newest run', async () => {
    const env = await startService();
    const session = await env.createSession();
    const first = await env.createRun(session.id, { input: 'one' });
    const second = await env.createRun(session.id, { input: 'two' });

    const read = await env.http('GET', `/v1/sessions/${session.id}`);
    expect(read.json.session).toMatchObject({ activeRunId: first.id, latestRunId: second.id });

    expect((await env.http('POST', `/v1/runs/${first.id}/cancel`)).status).toBe(202);
    expect(await env.store.finishCancelled(() => undefined)).toEqual([first.id]);
    const afterCancel = await env.http('GET', `/v1/sessions/${session.id}`);
    expect(afterCancel.json.session).toMatchObject({ activeRunId: second.id, latestRunId: second.id });

    expect((await env.http('POST', `/v1/runs/${second.id}/cancel`)).status).toBe(202);
    expect(await env.store.finishCancelled(() => undefined)).toEqual([second.id]);
    const allDone = await env.http('GET', `/v1/sessions/${session.id}`);
    expect(allDone.json.session).toMatchObject({ activeRunId: null, latestRunId: second.id });
  });

  it('lists runs by ordinal with an optional status filter', async () => {
    const env = await startService();
    const session = await env.createSession();
    const first = await env.createRun(session.id, { input: 'one' });
    const second = await env.createRun(session.id, { input: 'two' });
    const third = await env.createRun(session.id, { input: 'three' });
    await env.http('POST', `/v1/runs/${second.id}/cancel`);
    expect(await env.store.finishCancelled(() => undefined)).toEqual([second.id]);

    const all = await env.http('GET', `/v1/sessions/${session.id}/runs`);
    expect(all.status).toBe(200);
    expect(all.json.runs.map((run: { id: string; ordinal: number }) => [run.id, run.ordinal])).toEqual([
      [first.id, 1],
      [second.id, 2],
      [third.id, 3],
    ]);

    const queued = await env.http('GET', `/v1/sessions/${session.id}/runs?status=QUEUED`);
    expect(queued.json.runs.map((run: { id: string }) => run.id)).toEqual([first.id, third.id]);

    const both = await env.http('GET', `/v1/sessions/${session.id}/runs?status=CANCELLED,QUEUED`);
    expect(both.json.runs.map((run: { id: string }) => run.id)).toEqual([first.id, second.id, third.id]);

    const cancelled = await env.http('GET', `/v1/sessions/${session.id}/runs?status=CANCELLED`);
    expect(cancelled.json.runs.map((run: { id: string }) => run.id)).toEqual([second.id]);

    expectError(await env.http('GET', `/v1/sessions/${session.id}/runs?status=NOPE`), 400, 'invalid_request');
    expectError(await env.http('GET', '/v1/sessions/ses_missing/runs'), 404, 'not_found');
  });
});
