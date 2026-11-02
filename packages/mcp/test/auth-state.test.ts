import { describe, expect, it } from 'vitest';
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

    expect(await connection.authState()).toEqual({ state: 'required' });
    expect(fixture.rpcRecords('initialize').filter((record) => record.status === 200)).toEqual([]);
  });

  it('probes a live session with one tools/list instead of opening another session', async () => {
    const { connection, fixture } = await setup();
    await connection.authorize(new AbortController().signal);

    expect(await connection.authState()).toEqual({ state: 'authorized' });
    expect(fixture.rpcRecords('initialize')).toHaveLength(1);
    expect(fixture.rpcRecords('tools/list')).toHaveLength(0);
    expect(await connection.authState()).toEqual({ state: 'authorized' });
    expect(await connection.authState()).toEqual({ state: 'authorized' });

    expect(fixture.rpcRecords('initialize')).toHaveLength(1);
    expect(fixture.rpcRecords('tools/list')).toHaveLength(2);
  });

  it('reports required, not a stale authorized, when the live session no longer holds valid credentials', async () => {
    const { connection, oauth } = await setup();
    await connection.authorize(new AbortController().signal);
    expect(await connection.authState()).toEqual({ state: 'authorized' });

    oauth.expireAccessTokens();
    oauth.revokeRefreshTokens();

    expect(await connection.authState()).toEqual({ state: 'required' });
  });
});
