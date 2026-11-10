import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PlanProfile } from '@momonga/config';
import { FIRST_GENERATION, createEncryptedCredentialStore, momongaLayout, nodeFileSystem } from '@momonga/foundation';
import type { FakeUpstreamReply, RecordedUpstreamRequest } from '@momonga/testkit';
import {
  REAL_PROCESS_TEST_TIMEOUT_MS,
  createFakeClock,
  createFakeSecretStore,
  openResponsesTextReply,
  startFakeOpenResponses,
  startFakePlanResponses,
  startFakeSiwcAuth,
} from '@momonga/testkit';
import { openPlanSessions } from '../src/plan/session.ts';
import { outputText, postJson, readJson, registerCleanup, userInput } from './gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome, writeSettings } from './gateway-process-helpers.ts';
import { PROFILE_ID, profileFor, signInAtFake } from './plan-support.ts';
import type { Harness } from './plan-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const CAPABILITIES = { contextWindow: 128000, maxOutputTokens: 16000 };

const bearerOf = (request: RecordedUpstreamRequest): string => String(request.headers['authorization'] ?? '').replace(/^Bearer /, '');

const filesUnder = (directory: string): string[] =>
  fs.existsSync(directory)
    ? fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(directory, entry.name);
        return entry.isDirectory() ? filesUnder(full) : [full];
      })
    : [];

describe('the gateway process loads plan profiles from the injected planProfiles (O-R5-3 g)', () => {
  it('refuses a profile id that the injected planProfiles do not hold, even a shipped one', async () => {
    const home = makeHome();
    writeSettings(home, { models: { aliases: { default: 'gpt' }, targets: { gpt: { adapter: 'open-responses', model: 'm', capabilities: CAPABILITIES, plan: { profile: 'chatgpt' } } } } });
    await expect(
      launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, secretStore: createFakeSecretStore({}), planProfiles: {} } as never),
    ).rejects.toThrow(/unknown plan profile "chatgpt"/);
  });
});

const TOKEN_PREFIX_CHARS = 64;

describe('plan tokens are redacted in every generation (M6, I-C1)', () => {
  it('keeps the loaded and the refreshed token, each echoed by the upstream in an error body after the refresh, out of the response, the log and every file under the home', async () => {
    const home = makeHome();
    const layout = momongaLayout(home);
    const secretStore = createFakeSecretStore({});
    const installed = new Set<string>();
    const echoes: Array<(request: RecordedUpstreamRequest) => string> = [() => [...installed].join(' '), (request) => bearerOf(request)];
    const upstream = await startFakePlanResponses({
      verifyBearer: (bearer) => (bearer === undefined || installed.has(bearer) ? 'expired' : 'valid'),
      respond: (request): FakeUpstreamReply => ({ kind: 'error', status: 400, body: { error: { message: `echo ${(echoes.shift() ?? bearerOf)(request)}`, type: 'invalid_request_error', code: null, param: null } } }),
    });
    registerCleanup(() => upstream.close());
    const loopback = `${upstream.origin}/v1`;
    const auth = await startFakeSiwcAuth({ resource: loopback });
    registerCleanup(() => auth.close());
    const shipped = profileFor(auth);
    const profile: PlanProfile = { ...shipped, oauth: { ...shipped.oauth, resource: loopback }, targetDefaults: { ...shipped.targetDefaults, baseUrl: loopback } };
    fs.mkdirSync(layout.planSessions, { recursive: true, mode: 0o700 });
    const store = createEncryptedCredentialStore({
      directory: layout.planSessions,
      stateDirectory: path.dirname(layout.planSessions),
      secretStore: { kind: 'available', store: secretStore },
      plaintextTokenFiles: () => false,
    });
    const clock = createFakeClock(Date.now());
    const sessions = await openPlanSessions({ signal: new AbortController().signal,
      profiles: { [PROFILE_ID]: profile },
      paths: { sessions: layout.planSessions, host: layout.planHost, active: layout.planActive },
      store,
      fileSystem: nodeFileSystem,
      accounts: [],
      clock,
      outbound: (signal, use) => {
        signal.throwIfAborted();
        return use((url, init) => fetch(url, init));
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      redact: () => undefined,
      warn: () => undefined,
    });
    const signIn = await signInAtFake({ paths: { host: layout.planHost }, auth } as unknown as Harness, { resource: profile.oauth.resource });
    installed.add(signIn.tokens.access_token);
    await sessions.register({ profile: PROFILE_ID, account: 'work', clientId: signIn.clientId, hostId: signIn.hostId }, new AbortController().signal);
    await sessions.install({ profile: PROFILE_ID, account: 'work', clientId: signIn.clientId, hostId: signIn.hostId, subject: signIn.subject, email: signIn.email, idToken: signIn.idToken, tokens: signIn.tokens }, new AbortController().signal);
    await sessions.close();
    clock.advance(60_000);

    writeSettings(home, { models: { aliases: { default: 'gpt' }, targets: { gpt: { adapter: 'open-responses', model: 'm', capabilities: CAPABILITIES, plan: { profile: PROFILE_ID, account: 'work' } } } } });
    const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, secretStore, planProfiles: { [PROFILE_ID]: profile }, clock } as never);
    const ask = async () => readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model: 'default', input: userInput('hi') }));
    const responses = [await ask(), await ask()];

    const answered = upstream.requests.filter((request) => request.method === 'POST' && !installed.has(bearerOf(request)));
    expect(answered).toHaveLength(2);
    const refreshed = bearerOf(answered[0] as RecordedUpstreamRequest);
    expect(refreshed).not.toBe('');
    expect(answered.map(bearerOf)).toEqual([refreshed, refreshed]);
    for (const response of responses) {
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).toContain('echo');
    }
    await handle.close();
    const files = filesUnder(layout.root ?? path.join(home, '.momonga'));
    for (const token of [signIn.tokens.access_token, refreshed]) {
      const leaked = token.slice(0, TOKEN_PREFIX_CHARS);
      for (const response of responses) expect(JSON.stringify(response.body)).not.toContain(leaked);
      for (const file of files) expect(fs.readFileSync(file).includes(leaked), file).toBe(false);
    }
  });
});

describe('models.billingChanges of the user settings reaches the alias walk (P5a-w, M9)', () => {
  const startWith = async (billingChanges: unknown[] | undefined) => {
    const failing = await startFakeOpenResponses({ script: [{ kind: 'error', status: 401, body: { error: { message: 'key refused' } } } as FakeUpstreamReply] });
    const serving = await startFakeOpenResponses({ script: [openResponsesTextReply(['served'])] });
    registerCleanup(() => failing.close());
    registerCleanup(() => serving.close());
    const home = makeHome();
    writeSettings(home, {
      models: {
        aliases: { default: ['free', 'paid'] },
        ...(billingChanges === undefined ? {} : { billingChanges }),
        targets: {
          free: { adapter: 'open-responses', provider: 'test', model: 'm', socketPath: failing.socketPath, billing: 'local', capabilities: CAPABILITIES },
          paid: { adapter: 'open-responses', provider: 'test', model: 'm', socketPath: serving.socketPath, billing: 'metered', capabilities: CAPABILITIES },
        },
      },
    });
    const handle = await launchGateway({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION });
    return { serving, post: async () => readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model: 'default', input: userInput('hi') })) };
  };

  it('does not move from local to metered without the pair, and moves with it', async () => {
    const refused = await startWith(undefined);
    const failed = await refused.post();
    expect(failed.status).toBe(401);
    expect(failed.body.error.message).toContain('Model target "paid" was not tried');
    expect(refused.serving.requests).toHaveLength(0);

    const allowed = await startWith([{ from: 'local', to: 'metered' }]);
    expect((await allowed.post()).status).toBe(200);
  });
});
