import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { McpAuthorizationError, McpRemotePolicyError, authorizeMcpServer, createMcpOAuthProvider, createMcpToolSource, credentialKey } from '@momonga/mcp';
import { createFileCredentialStore, createMemoryCredentialStore } from '@momonga/foundation';
import type { FetchLike } from '@modelcontextprotocol/client';
import { createFakeClock, testKernelLock } from '@momonga/testkit';
import { createToolRegistry } from '@momonga/tools';
import { browserThatFollowsRedirect, makeRemoteConnection, observedTimers, startHttpFixture, startOauthFixture, textOf } from './remote-harness.ts';
import { NEVER_ABORTED, makeDir, makeExecutor } from './mcp-harness.ts';

const FAKE_STATIC_TOKEN = 'static-fake-token-0123456789';

const setup = async (extra: Partial<Parameters<typeof makeRemoteConnection>[0]> = {}) => {
  const oauth = await startOauthFixture();
  const fixture = await startHttpFixture({ era: 'modern', oauth });
  let browserOpens = 0;
  const follow = browserThatFollowsRedirect();
  const harness = makeRemoteConnection({
    fixture,
    openAuthorizationUrl: async (url) => {
      browserOpens += 1;
      await follow(url);
    },
    ...extra,
  });
  return { oauth, fixture, browserOpens: () => browserOpens, ...harness };
};

const storedTokens = async (store: Awaited<ReturnType<typeof setup>>['store'], url: string) => {
  const raw = await store.read(credentialKey('remote', url), NEVER_ABORTED);
  return raw === undefined ? undefined : (JSON.parse(raw) as { issuers: Record<string, { tokens?: { access_token: string; refresh_token?: string } }> });
};

describe('OAuth against a loopback authorization server', () => {
  it('fails with a typed error and opens no browser when there are no credentials', async () => {
    const { connection, browserOpens, oauth } = await setup();
    const failure = await connection.listTools().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(McpAuthorizationError);
    expect((failure as McpAuthorizationError).failure).toBe('required');
    expect(browserOpens()).toBe(0);
    expect(oauth.records.filter((record) => record.path === '/authorize' || record.path === '/token')).toEqual([]);
  });

  it('runs discovery, registration and an authorization-code flow with PKCE and the resource indicator', async () => {
    const { connection, oauth, fixture, store, browserOpens } = await setup();
    await connection.authorize(new AbortController().signal);
    expect(browserOpens()).toBe(1);

    const registration = JSON.parse(oauth.records.find((record) => record.path === '/register')?.form['metadata'] as string) as Record<string, unknown>;
    expect(registration['application_type']).toBe('native');
    expect(registration['token_endpoint_auth_method']).toBe('none');
    expect(String((registration['redirect_uris'] as string[])[0])).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    const authorize = oauth.records.find((record) => record.path === '/authorize')?.form as Record<string, string>;
    expect(authorize['response_type']).toBe('code');
    expect(authorize['code_challenge_method']).toBe('S256');
    expect(authorize['resource']).toBe(fixture.url);
    expect(authorize['state']).toBe('random-1');
    expect(authorize['redirect_uri']).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    const token = oauth.records.find((record) => record.path === '/token')?.form as Record<string, string>;
    expect(token['grant_type']).toBe('authorization_code');
    expect(token['resource']).toBe(fixture.url);
    expect(token['code_verifier']?.length).toBeGreaterThanOrEqual(43);

    const tokens = await storedTokens(store, fixture.url);
    expect(Object.values(tokens?.issuers ?? {})[0]?.tokens?.access_token).toBe(oauth.issuedAccessTokens()[0]);
    expect((await connection.listTools()).map((tool) => tool.name)).toContain('echo');
    expect(fixture.rpcRecords('tools/list').at(-1)?.headers['authorization']).toBe(`Bearer ${oauth.issuedAccessTokens()[0]}`);
  });

  it('refreshes an expired access token with the refresh token and retries the request', async () => {
    const { connection, oauth, fixture, store } = await setup();
    await connection.authorize(new AbortController().signal);
    await connection.listTools();
    const [firstAccess] = oauth.issuedAccessTokens();
    oauth.expireAccessTokens();

    expect(textOf(await connection.callTool({ name: 'echo', arguments: { text: 'after refresh' }, signal: NEVER_ABORTED }))).toBe('after refresh');
    const refresh = oauth.records.filter((record) => record.path === '/token' && record.form['grant_type'] === 'refresh_token');
    expect(refresh).toHaveLength(1);
    const tokens = Object.values((await storedTokens(store, fixture.url))?.issuers ?? {})[0]?.tokens;
    expect(tokens?.access_token).not.toBe(firstAccess);
    expect(oauth.issuedAccessTokens()).toContain(tokens?.access_token);
    expect(fixture.rpcRecords('tools/call').map((record) => record.status)).toEqual([401, 200]);
  });

  it('requires a new authorization, without opening a browser, when the refresh token is revoked', async () => {
    const { connection, oauth, browserOpens } = await setup();
    await connection.authorize(new AbortController().signal);
    await connection.listTools();
    oauth.expireAccessTokens();
    oauth.revokeRefreshTokens();
    const opensBefore = browserOpens();
    const failure = await connection.callTool({ name: 'echo', arguments: { text: 'x' }, signal: NEVER_ABORTED }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(McpAuthorizationError);
    expect(browserOpens()).toBe(opensBefore);
  });

  it('reports a refused authorization, stores nothing and never calls the token endpoint', async () => {
    const { connection, oauth, store, fixture } = await setup();
    oauth.authorizeMode = 'deny';
    const failure = await connection.authorize(new AbortController().signal).then(
      () => undefined,
      (error: unknown) => error as McpAuthorizationError,
    );
    expect(failure).toBeInstanceOf(McpAuthorizationError);
    expect(failure?.failure).toBe('denied');
    expect(failure?.message).toContain('access_denied');
    expect(oauth.records.some((record) => record.path === '/token')).toBe(false);
    expect(Object.values((await storedTokens(store, fixture.url))?.issuers ?? {}).some((entry) => entry.tokens !== undefined)).toBe(false);
    await expect(connection.listTools()).rejects.toBeInstanceOf(McpAuthorizationError);
  });

  it.each(['approve_with_foreign_iss', 'approve_without_iss'] as const)('rejects an authorization response from the wrong issuer (%s) before redeeming the code', async (mode) => {
    const { connection, oauth } = await setup();
    oauth.authorizeMode = mode;
    await expect(connection.authorize(new AbortController().signal)).rejects.toThrow();
    expect(oauth.records.some((record) => record.path === '/token')).toBe(false);
  });

  it.each(['timer', 'abort'] as const)('stops waiting for the browser on %s and closes the redirect listener', async (cause) => {
    const oauth = await startOauthFixture();
    const fixture = await startHttpFixture({ era: 'modern', oauth });
    const timers = observedTimers(createFakeClock(1_000_000));
    const controller = new AbortController();
    const waitMs = 5000;
    let opened: URL | undefined;
    const armed = timers.nextScheduled((ms) => ms === waitMs);
    const outcome = authorizeMcpServer({
      server: 'remote',
      url: fixture.url,
      scope: 'user',
      oauth: undefined,
      fetch: globalThis.fetch as FetchLike,
      ports: {
        store: createMemoryCredentialStore(),
        timers,
        randomToken: () => 'random-state',
        openAuthorizationUrl: (url) => {
          opened = url;
          return Promise.resolve();
        },
      },
      signal: controller.signal,
      storeLimitMs: 30_000,
      waitMs,
    }).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    await armed;
    if (cause === 'timer') timers.advance(waitMs);
    else controller.abort(new Error('give up'));
    const failure = await outcome;
    if (cause === 'timer') expect((failure as McpAuthorizationError).failure).toBe('timed_out');
    else expect(failure?.message).toContain('give up');
    const redirectUri = opened?.searchParams.get('redirect_uri');
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    await expect(fetch(`${redirectUri}?state=random-state&code=late`)).rejects.toThrow();
    expect(oauth.records.some((record) => record.path === '/token')).toBe(false);
  });
});

describe('authorization URLs', () => {
  const providerFor = (scope: 'user' | 'project') =>
    createMcpOAuthProvider({
      server: 'remote',
      resourceUrl: 'https://mcp.example.com/mcp',
      scope,
      store: createMemoryCredentialStore(),
      signalForCall: () => NEVER_ABORTED,
      redirectUrl: 'http://127.0.0.1:1/callback',
      randomToken: () => 'state',
      onAuthorizationUrl: () => undefined,
    });

  it.each([
    ['user', 'file:///etc/passwd'],
    ['user', 'javascript:alert(1)'],
    ['project', 'http://auth.example.com/authorize'],
  ] as const)('refuses to hand a %s-scope %s to the browser', async (scope, url) => {
    const refusal = await Promise.resolve()
      .then(() => providerFor(scope).redirectToAuthorization(new URL(url)))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(refusal).toBeInstanceOf(McpRemotePolicyError);
    expect((refusal as McpRemotePolicyError).violation).toBe('authorization_url_scheme');
  });

  it.each([
    ['https://127.0.0.1:8443/authorize', 'non_public_address_literal'],
    ['https://169.254.169.254/authorize', 'non_public_address_literal'],
    ['https://localhost/authorize', 'loopback_hostname'],
    ['https://user:pass@auth.example.com/authorize', 'credentials_in_url'],
  ] as const)('refuses to hand a project-scope %s to the browser (%s)', async (url, violation) => {
    const refusal = await Promise.resolve()
      .then(() => providerFor('project').redirectToAuthorization(new URL(url)))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(refusal).toBeInstanceOf(McpRemotePolicyError);
    expect((refusal as McpRemotePolicyError).violation).toBe(violation);
  });

  it('lets a user-scope connection send the browser to a local authorization server', async () => {
    await expect(Promise.resolve().then(() => providerFor('user').redirectToAuthorization(new URL('http://127.0.0.1:9000/authorize')))).resolves.toBeUndefined();
  });

  it('hands an https authorization URL to the browser', () => {
    let received: URL | undefined;
    const provider = createMcpOAuthProvider({
      server: 'remote',
      resourceUrl: 'https://mcp.example.com/mcp',
      scope: 'project',
      store: createMemoryCredentialStore(),
      signalForCall: () => NEVER_ABORTED,
      redirectUrl: 'http://127.0.0.1:1/callback',
      randomToken: () => 'state',
      onAuthorizationUrl: (url) => {
        received = url;
      },
    });
    provider.redirectToAuthorization(new URL('https://auth.example.com/authorize'));
    expect(received?.href).toBe('https://auth.example.com/authorize');
  });
});

describe('the 401 challenge of the server', () => {
  it('is followed to the protected resource metadata it names and its scope is requested', async () => {
    const oauth = await startOauthFixture();
    const fixture = await startHttpFixture({ era: 'modern', oauth, protectedResourceMetadataPath: '/metadata/custom', challengeScope: 'files:read' });
    const follow = browserThatFollowsRedirect();
    const requested: Array<string | null> = [];
    const { connection } = makeRemoteConnection({
      fixture,
      openAuthorizationUrl: async (url) => {
        requested.push(url.searchParams.get('scope'));
        await follow(url);
      },
    });
    await connection.authorize(new AbortController().signal);
    expect(requested).toEqual(['files:read']);
    expect(await connection.authState(NEVER_ABORTED)).toEqual({ state: 'authorized' });
  });

  it('yields to the scope the user configured', async () => {
    const oauth = await startOauthFixture();
    const fixture = await startHttpFixture({ era: 'modern', oauth, protectedResourceMetadataPath: '/metadata/custom', challengeScope: 'files:read' });
    const follow = browserThatFollowsRedirect();
    const requested: Array<string | null> = [];
    const { connection } = makeRemoteConnection({
      fixture,
      oauth: { scope: 'configured' },
      openAuthorizationUrl: async (url) => {
        requested.push(url.searchParams.get('scope'));
        await follow(url);
      },
    });
    await connection.authorize(new AbortController().signal);
    expect(requested).toEqual(['configured']);
  });
});

describe('credentials never leave the connection', () => {
  it('redacts a token the server reflects from tool output', async () => {
    const { connection, oauth } = await setup();
    await connection.authorize(new AbortController().signal);
    const registry = createToolRegistry();
    registry.addSource(createMcpToolSource({ server: 'remote', connection }));
    const harness = makeExecutor();
    const result = await harness.resultOf(await registry.snapshot(), 'mcp__remote__reflect_auth', {});
    const [token] = oauth.issuedAccessTokens();
    expect(token).toBeDefined();
    expect(result.output).toContain('[redacted]');
    expect(result.output).not.toContain(token as string);
  });

  it('redacts a configured authorization header from diagnostics and messages', async () => {
    const oauth = await startOauthFixture();
    const fixture = await startHttpFixture({ era: 'modern', oauth });
    const { connection } = makeRemoteConnection({ fixture, headers: { Authorization: `Bearer ${FAKE_STATIC_TOKEN}` } });
    const failure = await connection.listTools().then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).not.toContain(FAKE_STATIC_TOKEN);
    expect(JSON.stringify(connection.diagnostics())).not.toContain(FAKE_STATIC_TOKEN);
    expect(connection.redact(`oops ${FAKE_STATIC_TOKEN}`)).toBe('oops [redacted]');
  });

  it('redacts the value of every configured header except the standard descriptive ones', async () => {
    const fixture = await startHttpFixture({ era: 'modern' });
    const { connection } = makeRemoteConnection({
      fixture,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Api-Key': 'key-value-12345', 'X-Workspace': 'workspace-secret-678', Authorization: 'Bearer bearer-secret-9' },
    });
    expect(connection.redact('payload application/json end')).toBe('payload application/json end');
    expect(connection.redact('a key-value-12345 b workspace-secret-678 c bearer-secret-9 d')).toBe('a [redacted] b [redacted] c [redacted] d');
  });

  it('keeps the file credential store owner-only and holds tokens nowhere else', async () => {
    const directory = path.join(makeDir(), 'mcp-credentials');
    const { connection, oauth, fixture } = await setup({ store: createFileCredentialStore(directory, { lock: testKernelLock() }) });
    await connection.authorize(new AbortController().signal);
    const files = fs.readdirSync(directory);
    expect(files).toHaveLength(1);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(directory, files[0] as string)).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(directory, files[0] as string), 'utf8')).toContain(oauth.issuedAccessTokens()[0] as string);
    expect(files[0]).not.toContain(fixture.url);
    for (const value of Object.values(process.env)) expect(value ?? '').not.toContain(oauth.issuedAccessTokens()[0] as string);
  });

  it('refuses a credential file that is readable by others', async () => {
    const directory = path.join(makeDir(), 'mcp-credentials');
    const store = createFileCredentialStore(directory, { lock: testKernelLock() });
    await store.write('k', 'v', NEVER_ABORTED);
    const file = path.join(directory, fs.readdirSync(directory)[0] as string);
    fs.chmodSync(file, 0o644);
    await expect(store.read('k', NEVER_ABORTED)).rejects.toThrow(/mode 0600/);
  });
});
