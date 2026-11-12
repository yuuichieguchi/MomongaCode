import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '@momonga/config';
import { momongaLayout, momongaPaths, syncPaths } from '@momonga/foundation';
import { GatewayRequestError } from '@momonga/runtime';
import { MODEL_ID, expectError, expectSchema, onCleanup, startService } from './helpers.ts';
import type { JsonResponse, ServiceEnv } from './helpers.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const CASE_INSENSITIVE = syncPaths.volumeIsCaseInsensitive(fs.realpathSync(os.tmpdir()));
const RUNNING_AS_ROOT = process.getuid?.() === 0;
const SESSION_ENV = { PATH: '/usr/bin:/bin', LANG: 'C' };

const post = (env: ServiceEnv, body: Record<string, unknown>): Promise<JsonResponse> =>
  env.http('POST', '/v1/sessions', { body: { env: SESSION_ENV, ...body } });

const mkdir = (dir: string): string => {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const expectCwdRejected = (response: JsonResponse, message: string): void => {
  expect({ status: response.status, body: response.json }).toEqual({
    status: 400,
    body: { error: { type: 'invalid_request', code: 'invalid_request', param: 'cwd', message } },
  });
};

const expectConfigError = (response: JsonResponse, message: string, param?: string): void => {
  expect({ status: response.status, body: response.json }).toEqual({
    status: 422,
    body: { error: { type: 'invalid_request', code: 'config_error', message, ...(param === undefined ? {} : { param }) } },
  });
};

const areasOf = (env: ServiceEnv) => {
  const paths = momongaPaths(env.layout.home, process.platform, {});
  return { momonga: paths.root, keychains: momongaLayout(env.layout.home, process.platform, process.env).keychains, tmpRoot: paths.tmp.root, spawn: paths.tmp.spawn };
};

describe('session create validation (fake timers)', () => {
  it.runIf(CASE_INSENSITIVE)('stores the native true-case cwd for a case variant', async () => {
    const env = await startService({ fakeTimers: true });
    const trueCase = mkdir(path.join(env.layout.root, 'CaseProject'));
    const response = await post(env, { cwd: path.join(env.layout.root, 'caseproject') });
    expect(response.status).toBe(201);
    expect(response.json.session.cwd).toBe(trueCase);
    expect(env.store.getSession(response.json.session.id)?.cwd).toBe(trueCase);
  });

  it('stores a symlinked cwd canonically', async () => {
    const env = await startService({ fakeTimers: true });
    const link = path.join(env.layout.root, 'link');
    fs.symlinkSync(env.layout.project, link, 'dir');
    const response = await post(env, { cwd: link });
    expect(response.status).toBe(201);
    expect(response.json.session.cwd).toBe(env.layout.projectReal);
    expect(env.ports.settingsCalls).toEqual([env.layout.projectReal]);
  });

  it.skipIf(RUNNING_AS_ROOT)('400 for a relative, missing, file, looping or unreadable cwd, each with param cwd', async () => {
    const env = await startService({ fakeTimers: true });
    const missing = path.join(env.layout.root, 'missing');
    const file = path.join(env.layout.root, 'file.txt');
    fs.writeFileSync(file, 'x');
    const loop = path.join(env.layout.root, 'loop-a');
    fs.symlinkSync(path.join(env.layout.root, 'loop-b'), loop);
    fs.symlinkSync(loop, path.join(env.layout.root, 'loop-b'));
    const locked = mkdir(path.join(env.layout.root, 'locked'));
    fs.chmodSync(locked, 0o000);
    onCleanup(() => fs.chmodSync(locked, 0o700));

    expectCwdRejected(await post(env, { cwd: 'relative/dir' }), 'cwd relative/dir must be an absolute path');
    expectCwdRejected(await post(env, { cwd: missing }), `cwd ${missing} does not exist`);
    expectCwdRejected(await post(env, { cwd: file }), `cwd ${file} is not a directory`);
    const looping = await post(env, { cwd: loop });
    expect({ status: looping.status, body: looping.json }).toEqual({
      status: 400,
      body: { error: { type: 'invalid_request', code: 'invalid_request', param: 'cwd', message: expect.stringMatching(new RegExp(`^cwd ${loop} cannot be resolved: .+`)) } },
    });
    expectCwdRejected(await post(env, { cwd: locked }), `cwd ${locked} cannot be read: permission denied (EACCES)`);
    expect(env.store.listSessions({ limit: 100, cursor: null }).sessions).toEqual([]);
    expect(env.ports.settingsCalls).toEqual([]);
  });

  it('400 for a cwd inside home/.momonga, home/Library/Keychains, the tmp root or the spawn dir under it, each with param cwd', async () => {
    const env = await startService({ fakeTimers: true });
    const areas = areasOf(env);
    const insideMomonga = mkdir(path.join(areas.momonga, 'work'));
    const insideKeychains = mkdir(path.join(areas.keychains, 'nested'));
    const insideTmp = mkdir(path.join(areas.tmpRoot, 'scratch'));
    const insideSpawn = mkdir(path.join(areas.spawn, 'child'));

    expectCwdRejected(await post(env, { cwd: areas.momonga }), `cwd ${areas.momonga} is inside ${areas.momonga} and cannot be a session root`);
    expectCwdRejected(await post(env, { cwd: insideMomonga }), `cwd ${insideMomonga} is inside ${areas.momonga} and cannot be a session root`);
    expectCwdRejected(await post(env, { cwd: insideKeychains }), `cwd ${insideKeychains} is inside ${areas.keychains} and cannot be a session root`);
    expectCwdRejected(await post(env, { cwd: insideTmp }), `cwd ${insideTmp} is inside ${areas.tmpRoot} and cannot be a session root`);
    expectCwdRejected(await post(env, { cwd: areas.spawn }), `cwd ${areas.spawn} is inside ${areas.tmpRoot} and cannot be a session root`);
    expectCwdRejected(await post(env, { cwd: insideSpawn }), `cwd ${insideSpawn} is inside ${areas.tmpRoot} and cannot be a session root`);
    expect(env.store.listSessions({ limit: 100, cursor: null }).sessions).toEqual([]);
    expect(env.ports.settingsCalls).toEqual([]);
  });

  it('allows a cwd that is an ancestor of a protected area', async () => {
    const env = await startService({ fakeTimers: true });
    const areas = areasOf(env);
    mkdir(areas.keychains);
    mkdir(areas.tmpRoot);
    const library = path.dirname(areas.keychains);
    const atHome = await post(env, { cwd: env.layout.home });
    expect(atHome.status).toBe(201);
    expect(atHome.json.session.cwd).toBe(env.layout.home);
    const atLibrary = await post(env, { cwd: library });
    expect(atLibrary.status).toBe(201);
    expect(atLibrary.json.session.cwd).toBe(library);
  });

  it('snapshots additionalDirectories from sessionCreateSettings, deduplicated and without cwd', async () => {
    const env = await startService({ fakeTimers: true });
    const shared = mkdir(path.join(env.layout.root, 'shared'));
    const docs = mkdir(path.join(env.layout.root, 'docs'));
    env.ports.settingsByCwd.set(env.layout.projectReal, { additionalDirectories: [docs, shared, env.layout.projectReal, docs, shared] });

    const response = await post(env, { cwd: env.layout.project });

    expect(response.status).toBe(201);
    expect(response.json.session.additionalDirectories).toEqual([docs, shared]);
    expect(env.store.getSession(response.json.session.id)?.additionalDirectories).toEqual([docs, shared]);

    env.ports.settingsByCwd.set(env.layout.projectReal, { additionalDirectories: [] });
    const reread = await env.http('GET', `/v1/sessions/${response.json.session.id}`);
    expect(reread.json.session.additionalDirectories).toEqual([docs, shared]);
  });

  it.runIf(CASE_INSENSITIVE)('deduplicates additionalDirectories that differ only in case', async () => {
    const env = await startService({ fakeTimers: true });
    const shared = mkdir(path.join(env.layout.root, 'Shared'));
    env.ports.settingsByCwd.set(env.layout.projectReal, { additionalDirectories: [shared, path.join(env.layout.root, 'shared'), env.layout.projectReal.toUpperCase()] });
    const response = await post(env, { cwd: env.layout.project });
    expect(response.status).toBe(201);
    expect(response.json.session.additionalDirectories).toEqual([shared]);
  });

  it('422 config_error for a missing, file or unresolvable additional directory', async () => {
    const env = await startService({ fakeTimers: true });
    const settingsFile = path.join(env.layout.momonga, 'settings.json');
    const missing = path.join(env.layout.root, 'gone');
    const messages = [
      `${settingsFile}: additionalDirectories entry ${missing} does not exist`,
      `${settingsFile}: additionalDirectories entry ${missing} is not a directory`,
      `${settingsFile}: additionalDirectories entry ${missing} cannot be resolved: too many symbolic links`,
    ];
    for (const message of messages) {
      env.ports.settingsFailure.error = new ConfigError(message);
      expectConfigError(await post(env, { cwd: env.layout.project }), message);
    }
    expect(env.store.listSessions({ limit: 100, cursor: null }).sessions).toEqual([]);
  });

  it('422 with param additionalDirectories for an entry inside a protected area', async () => {
    const env = await startService({ fakeTimers: true });
    const areas = areasOf(env);
    const fine = mkdir(path.join(env.layout.root, 'fine'));
    const inKeychains = mkdir(path.join(areas.keychains, 'k'));
    const inMomonga = mkdir(path.join(areas.momonga, 'm'));
    env.ports.settingsByCwd.set(env.layout.projectReal, { additionalDirectories: [fine, inKeychains, inMomonga] });

    expectConfigError(
      await post(env, { cwd: env.layout.project }),
      `additionalDirectories entry ${inKeychains} is inside ${areas.keychains} and cannot be a session root`,
      'additionalDirectories',
    );

    const inSpawn = mkdir(path.join(areas.spawn, 's'));
    env.ports.settingsByCwd.set(env.layout.projectReal, { additionalDirectories: [inSpawn] });
    expectConfigError(
      await post(env, { cwd: env.layout.project }),
      `additionalDirectories entry ${inSpawn} is inside ${areas.tmpRoot} and cannot be a session root`,
      'additionalDirectories',
    );
    expect(env.store.listSessions({ limit: 100, cursor: null }).sessions).toEqual([]);
  });

  it('422 config_error when sessionCreateSettings throws ConfigError, and nothing is stored', async () => {
    const env = await startService({ fakeTimers: true });
    const message = `${path.join(env.layout.momonga, 'settings.json')}: invalid JSON`;
    env.ports.settingsFailure.error = new ConfigError(message);
    expectConfigError(await post(env, { cwd: env.layout.project, env: { ...SESSION_ENV, ACME_ROUTE_VALUE: 'kept' } }), message);
    expect(env.store.listSessions({ limit: 100, cursor: null }).sessions).toEqual([]);
    expect(env.errors).toEqual([]);
  });

  it('a single sessionCreateSettings call per create, and stripCredentialEnv uses its credentialEnvNames', async () => {
    const env = await startService({ fakeTimers: true });
    const shared = mkdir(path.join(env.layout.root, 'shared'));
    env.ports.settingsByCwd.set(env.layout.projectReal, {
      defaultMode: 'acceptEdits',
      defaultModeOrigin: 'project',
      additionalDirectories: [shared],
      credentialEnvNames: ['ACME_ROUTE_VALUE'],
    });

    const response = await post(env, { cwd: env.layout.project, env: { ...SESSION_ENV, ACME_ROUTE_VALUE: 'declared', FM_UPSTREAM_VALUE: 'not-declared-now' } });

    expect(response.status).toBe(201);
    expect(env.ports.settingsCalls).toEqual([env.layout.projectReal]);
    expect(response.json.strippedEnvKeys).toEqual(['ACME_ROUTE_VALUE']);
    expect(response.json.session).toMatchObject({ permissionMode: 'acceptEdits', bypassAllowed: false, additionalDirectories: [shared] });
    expect(env.store.getSession(response.json.session.id)?.env).toEqual({ ...SESSION_ENV, FM_UPSTREAM_VALUE: 'not-declared-now' });
  });

  it('500 when sessionCreateSettings throws anything else', async () => {
    const env = await startService({ fakeTimers: true });
    const failure = new Error('the settings port broke');
    env.ports.settingsFailure.error = failure;
    expectError(await post(env, { cwd: env.layout.project }), 500, 'internal_error');
    expect(env.errors).toEqual([failure]);
    expect(env.store.listSessions({ limit: 100, cursor: null }).sessions).toEqual([]);
  });

  it('503 gateway_unavailable with retry-after 1 for a transport error or a 5xx from the model listing', async () => {
    const env = await startService({ fakeTimers: true });
    const failures = [
      ...['gateway_unavailable', 'client_destroyed', 'invalid_response', 'deadline_exceeded', 'gateway_timeout'].map(
        (code) => new GatewayRequestError({ status: 0, type: 'transport', code, message: `transport ${code}` }),
      ),
      new GatewayRequestError({ status: 502, type: 'server_error', code: 'upstream_error', message: 'bad gateway' }),
      new GatewayRequestError({ status: 500, type: 'server_error', code: 'internal_error', message: 'internal' }),
    ];
    for (const failure of failures) {
      env.ports.listingFailure.error = failure;
      const response = await post(env, { cwd: env.layout.project });
      expect({ status: response.status, code: response.json?.error?.code, type: response.json?.error?.type, retryAfter: response.headers['retry-after'] }, failure.code).toEqual({
        status: 503,
        code: 'gateway_unavailable',
        type: 'server_error',
        retryAfter: '1',
      });
    }
    expect(env.errors).toEqual([]);
    expect(env.ports.settingsCalls).toEqual([]);
    expect(env.store.listSessions({ limit: 100, cursor: null }).sessions).toEqual([]);
  });

  it('a 4xx from the model listing keeps its status, code and text', async () => {
    const env = await startService({ fakeTimers: true });
    const failure = new GatewayRequestError({ status: 400, type: 'invalid_request', code: 'invalid_request', message: 'bad request' });
    env.ports.listingFailure.error = failure;
    const response = await post(env, { cwd: env.layout.project });
    expectError(response, 400, 'invalid_request');
    expect(response.json.error.message).toBe('bad request');
    expect(env.errors).toEqual([]);
  });

  it('the session view carries additionalDirectories and validates against RUN_API_SCHEMAS.SessionView', async () => {
    const env = await startService({ fakeTimers: true });
    const shared = mkdir(path.join(env.layout.root, 'shared'));
    env.ports.settingsByCwd.set(env.layout.projectReal, { additionalDirectories: [shared] });
    const created = await post(env, { cwd: env.layout.project });
    expect(created.status).toBe(201);
    expect(created.json.session).toMatchObject({ cwd: env.layout.projectReal, model: MODEL_ID, additionalDirectories: [shared] });
    expectSchema('SessionView', created.json.session);
    const listed = await env.http('GET', '/v1/sessions');
    expect(listed.json.sessions.map((session: { additionalDirectories: string[] }) => session.additionalDirectories)).toEqual([[shared]]);
  });

  it.runIf(CASE_INSENSITIVE)('?cwd= matches a case variant', async () => {
    const env = await startService({ fakeTimers: true });
    const trueCase = mkdir(path.join(env.layout.root, 'CaseProject'));
    const created = await post(env, { cwd: trueCase });
    const response = await env.http('GET', `/v1/sessions?cwd=${encodeURIComponent(path.join(env.layout.root, 'CASEPROJECT'))}`);
    expect(response.status).toBe(200);
    expect(response.json.sessions.map((session: { id: string }) => session.id)).toEqual([created.json.session.id]);
  });

  it('?cwd= on a missing path returns an empty last page', async () => {
    const env = await startService({ fakeTimers: true });
    await env.createSession();
    const response = await env.http('GET', `/v1/sessions?cwd=${encodeURIComponent(path.join(env.layout.root, 'gone', 'deeper'))}`);
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ sessions: [], next: null });
  });

  it('?cwd= 400 for a relative path', async () => {
    const env = await startService({ fakeTimers: true });
    const response = await env.http('GET', `/v1/sessions?cwd=${encodeURIComponent('relative/dir')}`);
    expect({ status: response.status, code: response.json?.error?.code, param: response.json?.error?.param }).toEqual({ status: 400, code: 'invalid_request', param: 'cwd' });
  });

  it('?cwd= 400 when canonicalPath throws', async () => {
    const env = await startService({ fakeTimers: true });
    const file = path.join(env.layout.root, 'file.txt');
    fs.writeFileSync(file, 'x');
    const loop = path.join(env.layout.root, 'loop-a');
    fs.symlinkSync(path.join(env.layout.root, 'loop-b'), loop);
    fs.symlinkSync(loop, path.join(env.layout.root, 'loop-b'));
    for (const requested of [loop, path.join(file, 'child')]) {
      const response = await env.http('GET', `/v1/sessions?cwd=${encodeURIComponent(requested)}`);
      expect({ status: response.status, code: response.json?.error?.code, param: response.json?.error?.param }, requested).toEqual({
        status: 400,
        code: 'invalid_request',
        param: 'cwd',
      });
    }
    expect(env.errors).toEqual([]);
  });

  it('?cwd= answers 500 through onError when canonicalPath throws a transient EMFILE', async () => {
    const env = await startService({ fakeTimers: true });
    const injected = Object.assign(new Error('EMFILE: injected'), { code: 'EMFILE' });
    const realRealpath = fs.promises.realpath;
    vi.spyOn(fs.promises, 'realpath').mockImplementation((async (candidate: fs.PathLike, options?: unknown) => {
      if (String(candidate) === env.layout.projectReal) throw injected;
      return realRealpath(candidate, options as never);
    }) as typeof fs.promises.realpath);
    const response = await env.http('GET', `/v1/sessions?cwd=${encodeURIComponent(env.layout.projectReal)}`);
    expectError(response, 500, 'internal_error');
    expect(env.errors).toEqual([injected]);
  });
});
