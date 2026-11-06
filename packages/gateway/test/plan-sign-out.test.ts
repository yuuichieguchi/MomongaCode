import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { PROFILE_ID, START_MS, editRecord, planError, rawRecord, readRecord, signedIn, startHarness, toRefreshWindow, profileFor, CONDITION_WAIT, REVOCATION_ATTEMPT_BOUND_MS } from './plan-support.ts';
import type { Harness } from './plan-support.ts';

const harnesses: Harness[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

const harness = async (options: Parameters<typeof startHarness>[0] = {}): Promise<Harness> => {
  const h = await startHarness(options);
  harnesses.push(h);
  return h;
};

const KEPT_AFTER_SIGN_OUT = ['account', 'client_id', 'email', 'ext_agent_host_id', 'profile', 'state', 'subject', 'version', 'welcomeShown'];

const signOut = (h: Harness) => h.sessions.signOut({ profile: PROFILE_ID, account: 'work' });

const discoveryServer = async (document: (issuer: string) => Record<string, unknown>): Promise<string> => {
  let origin = '';
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(document(origin)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return `${origin}/.well-known/openid-configuration`;
};

describe('sign-out (F11, I-C10)', () => {
  it('revokes the latest refresh token with the documented form and reports confirmed on an empty 200', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    const report = await signOut(h);
    expect(report).toEqual({ revocation: 'confirmed', usageUrl: 'https://chatgpt.com/settings/usage' });
    expect(h.auth.calls.revoke).toBe(1);
    const revoke = h.auth.records.find((record) => record.path.endsWith('/revoke'));
    expect(revoke?.form).toEqual({ token: signIn.tokens.refresh_token, token_type_hint: 'refresh_token', client_id: signIn.clientId });
  });

  it('abandons a revocation send that never answers at T_rev = 10 s and tries again', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    h.holdNextRevoke();
    const signingOut = signOut(h);
    await expect.poll(() => h.fetchUrls.includes(h.auth.revokeUrl) && h.pendingBounds().includes(REVOCATION_ATTEMPT_BOUND_MS), CONDITION_WAIT).toBe(true);
    h.fireLatestBound(REVOCATION_ATTEMPT_BOUND_MS);
    const report = await signingOut;
    expect(h.fetchUrls.filter((url) => url === h.auth.revokeUrl)).toHaveLength(2);
    expect(h.auth.calls.revoke).toBe(1);
    expect(report.revocation).toBe('confirmed');
  });

  it('keeps only the registration fields and the record version with state registered, and drops every token including the ID token', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    await signOut(h);
    const after = await readRecord(h, 'work');
    expect(Object.keys(after ?? {}).sort()).toEqual(KEPT_AFTER_SIGN_OUT);
    expect(after).toMatchObject({ state: 'registered', client_id: signIn.clientId, subject: signIn.subject, email: signIn.email, ext_agent_host_id: signIn.hostId });
    const raw = await rawRecord(h, 'work');
    for (const token of [signIn.tokens.access_token, signIn.tokens.refresh_token, signIn.idToken]) expect(raw).not.toContain(token);
  });

  it('no request starts with the cleared tokens after sign-out returns', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    const source = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' });
    await source.read(new AbortController().signal);
    await signOut(h);
    expect((await planError(source.read(new AbortController().signal))).code).toBe('sign_in_required');
  });

  it.each([
    ['HTTP 503 three times', [{ kind: 'http', status: 503 }, { kind: 'http', status: 503 }, { kind: 'http', status: 503 }]],
    ['a dropped connection three times', [{ kind: 'drop' }, { kind: 'drop' }, { kind: 'drop' }]],
  ] as const)('%s: three revocation attempts with backoff, local tokens cleared, unconfirmed', async (_name, steps) => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    h.auth.scriptRevoke([...steps]);
    const report = await signOut(h);
    expect(report.revocation).toBe('unconfirmed');
    expect(h.auth.calls.revoke).toBe(3);
    expect(h.sleeps).toHaveLength(2);
    expect(h.sleeps[0]).toBeLessThanOrEqual(500);
    expect(h.sleeps[1]).toBeLessThanOrEqual(1000);
    expect(await rawRecord(h, 'work')).not.toContain(signIn.tokens.refresh_token);
    expect((await readRecord(h, 'work'))?.['state']).toBe('registered');
  });

  it('a 200 with a body is not the empty success answer and reports unconfirmed', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    h.auth.scriptRevoke([{ kind: 'http', status: 200, body: '{"error":"invalid_request"}' }]);
    expect((await signOut(h)).revocation).toBe('unconfirmed');
  });

  it('a pending refresh intent means the revoked token may not be the latest: unconfirmed even on an empty 200', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    const installed = await readRecord(h, 'work');
    await editRecord(h, 'work', (record) => ({ ...record, pendingRefresh: { generation: installed?.['generation'], startedAt: START_MS } }));
    await h.reopen({ accounts: [{ profile: PROFILE_ID, account: 'work' }] });
    const report = await signOut(h);
    expect(h.auth.calls.revoke).toBe(1);
    expect(report.revocation).toBe('unconfirmed');
    expect((await readRecord(h, 'work'))?.['state']).toBe('registered');
  });

  it('waits behind an in-flight refresh and revokes the replacement, never the token the refresh consumed', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    toRefreshWindow(h, START_MS);
    const gate = h.holdNextRefresh();
    const reading = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' }).read(new AbortController().signal);
    await expect.poll(() => h.fetchUrls.filter((url) => url === h.auth.tokenUrl).length, CONDITION_WAIT).toBe(1);
    const signingOut = signOut(h);
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.auth.calls.revoke).toBe(0);
    gate.release();
    await reading;
    const report = await signingOut;
    const revoked = h.auth.records.find((record) => record.path.endsWith('/revoke'))?.form['token'];
    expect(revoked).not.toBe(signIn.tokens.refresh_token);
    expect(h.auth.issuedSecrets()).toContain(revoked);
    expect(report.revocation).toBe('confirmed');
  });

  it('a discovery document whose issuer differs from the profile issuer is a discovery failure: no revocation is sent', async () => {
    const discoveryUrl = await discoveryServer(() => ({ issuer: 'https://attacker.invalid', revocation_endpoint: 'https://attacker.invalid/revoke' }));
    const h = await harness({ profile: (auth) => ({ ...profileFor(auth), oauth: { ...profileFor(auth).oauth, discoveryUrl } }) });
    const signIn = await signedIn(h, 'work');
    const report = await signOut(h);
    expect(report.revocation).toBe('unconfirmed');
    expect(h.auth.calls.revoke).toBe(0);
    expect(await rawRecord(h, 'work')).not.toContain(signIn.tokens.refresh_token);
  });

  it('a revocation endpoint off the issuer origin is a discovery failure: no revocation is sent', async () => {
    let fakeIssuer = '';
    const discoveryUrl = await discoveryServer(() => ({ issuer: fakeIssuer, revocation_endpoint: 'http://127.0.0.1:9/elsewhere/revoke' }));
    const h = await harness({
      profile: (auth) => {
        fakeIssuer = auth.issuer;
        return { ...profileFor(auth), oauth: { ...profileFor(auth).oauth, discoveryUrl } };
      },
    });
    await signedIn(h, 'work');
    const report = await signOut(h);
    expect(report.revocation).toBe('unconfirmed');
    expect(h.auth.calls.revoke).toBe(0);
    expect(h.fetchUrls).not.toContain('http://127.0.0.1:9/elsewhere/revoke');
  });
});
