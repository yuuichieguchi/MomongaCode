import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMIT_TEST, NO_STORE_REFUSAL, controlledCredentialStore, keyReadLimitSentence, outcomeOf, settledAfter, stillPendingAfter, useLimitTimers } from './credential-store-fakes.ts';
import { NEVER_ABORTED } from './mcp-harness.ts';
import { browserThatFollowsRedirect, makeRemoteConnection, startHttpFixture, startOauthFixture } from './remote-harness.ts';

const setup = async () => {
  const oauth = await startOauthFixture();
  const fixture = await startHttpFixture({ era: 'legacy', oauth });
  const follow = browserThatFollowsRedirect();
  const harness = makeRemoteConnection({ fixture, openAuthorizationUrl: async (url) => follow(url) });
  return { oauth, fixture, ...harness };
};

describe('authState of a remote connection', () => {
  it('reports required without opening a session when the server demands credentials', async () => {
    const { connection, fixture } = await setup();

    expect(await connection.authState(NEVER_ABORTED)).toEqual({ state: 'required' });
    expect(fixture.rpcRecords('initialize').filter((record) => record.status === 200)).toEqual([]);
  });

  it('probes a live session with one tools/list instead of opening another session', async () => {
    const { connection, fixture } = await setup();
    await connection.authorize(new AbortController().signal);

    expect(await connection.authState(NEVER_ABORTED)).toEqual({ state: 'authorized' });
    expect(fixture.rpcRecords('initialize')).toHaveLength(1);
    expect(fixture.rpcRecords('tools/list')).toHaveLength(0);
    expect(await connection.authState(NEVER_ABORTED)).toEqual({ state: 'authorized' });
    expect(await connection.authState(NEVER_ABORTED)).toEqual({ state: 'authorized' });

    expect(fixture.rpcRecords('initialize')).toHaveLength(1);
    expect(fixture.rpcRecords('tools/list')).toHaveLength(2);
  });

  it('reports required, not a stale authorized, when the live session no longer holds valid credentials', async () => {
    const { connection, oauth } = await setup();
    await connection.authorize(new AbortController().signal);
    expect(await connection.authState(NEVER_ABORTED)).toEqual({ state: 'authorized' });

    oauth.expireAccessTokens();
    oauth.revokeRefreshTokens();

    expect(await connection.authState(NEVER_ABORTED)).toEqual({ state: 'required' });
  });
});

describe('authState against a credential store that cannot answer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const serverWhoseStoredReadIs = async (mode: 'hang' | 'absent') => {
    const fixture = await startHttpFixture({ era: 'legacy' });
    const credentials = controlledCredentialStore();
    const harness = makeRemoteConnection({ fixture, store: credentials.store });
    credentials.mode = () => (harness.connection.diagnostics().state === 'connected' ? mode : 'answer');
    return { credentials, ...harness };
  };

  it('authState reports unreachable with the limit sentence', LIMIT_TEST, async () => {
    const { connection, credentials } = await serverWhoseStoredReadIs('hang');
    useLimitTimers();

    const probe = outcomeOf(connection.authState(NEVER_ABORTED));
    await credentials.arrived(1, 'hang');
    await stillPendingAfter(probe, 29_999);
    await vi.advanceTimersByTimeAsync(1);
    await settledAfter(probe);

    expect(probe.state()).toBe('fulfilled');
    expect(probe.value()).toEqual({ state: 'unreachable', detail: keyReadLimitSentence('the MCP connect limit', 30_000) });
  });

  it("authState with no live session reports the connect's limit sentence", LIMIT_TEST, async () => {
    const fixture = await startHttpFixture({ era: 'legacy' });
    const credentials = controlledCredentialStore();
    credentials.mode = 'hang';
    const { connection } = makeRemoteConnection({ fixture, store: credentials.store });
    useLimitTimers();

    const probe = outcomeOf(connection.authState(NEVER_ABORTED));
    await credentials.arrived(1, 'hang');
    await stillPendingAfter(probe, 29_999);
    await vi.advanceTimersByTimeAsync(1);
    await settledAfter(probe);

    expect(probe.state()).toBe('fulfilled');
    expect(probe.value()).toEqual({ state: 'unreachable', detail: keyReadLimitSentence('the MCP connect limit', 30_000) });
    expect(credentials.calls).toHaveLength(1);
    expect(fixture.rpcRecords('initialize')).toEqual([]);
  });

  it('authState reports unreachable with the N81 text for an absent store', async () => {
    const { connection, credentials } = await serverWhoseStoredReadIs('absent');

    const probe = outcomeOf(connection.authState(NEVER_ABORTED));
    await credentials.arrived(1, 'absent');
    await settledAfter(probe);

    expect(probe.state()).toBe('fulfilled');
    expect(probe.value()).toEqual({ state: 'unreachable', detail: NO_STORE_REFUSAL });
  });

  it('authState ends at its request signal', async () => {
    const { connection, credentials } = await serverWhoseStoredReadIs('hang');
    const request = new AbortController();
    const reason = new Error('the request ended');

    const probe = outcomeOf(connection.authState(request.signal));
    await credentials.arrived(1, 'hang');
    request.abort(reason);
    await settledAfter(probe);

    expect(probe.state()).toBe('rejected');
    expect(probe.error()).toBe(reason);
    expect(credentials.calls.at(-1)?.rejection).toBe(reason);
  });
});
