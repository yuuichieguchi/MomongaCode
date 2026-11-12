import type { FetchLike } from '@modelcontextprotocol/client';
import { createMemoryCredentialStore } from '@momonga/foundation';
import type { McpTimers } from '@momonga/mcp';
import { describe, expect, it } from 'vitest';
import { authorizeMcpServer } from '../src/authorize.ts';
import { browserThatFollowsRedirect, startHttpFixture, startOauthFixture } from './remote-harness.ts';

const STORE_LIMIT_MS = 1000;

const globalTimers: McpTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

describe('a second sign-in of an authorized MCP server', () => {
  it('refreshes the stored tokens with the registration they were issued to and opens no browser, though its loopback port is new', async () => {
    const oauth = await startOauthFixture();
    const fixture = await startHttpFixture({ era: 'modern', oauth });
    const store = createMemoryCredentialStore();
    const opened: string[] = [];
    let token = 0;
    const signIn = (open: (url: URL) => Promise<void>): Promise<void> =>
      authorizeMcpServer({
        server: 'remote',
        url: fixture.url,
        scope: 'user',
        oauth: undefined,
        fetch: globalThis.fetch as FetchLike,
        ports: {
          store,
          timers: globalTimers,
          randomToken: () => {
            token += 1;
            return `random-${token}`;
          },
          openAuthorizationUrl: async (url) => {
            opened.push(url.searchParams.get('client_id') ?? '');
            await open(url);
          },
        },
        signal: new AbortController().signal,
        storeLimitMs: STORE_LIMIT_MS,
      });

    await signIn(browserThatFollowsRedirect());
    await signIn(() => Promise.reject(new Error('the second sign-in opened the browser')));

    expect(opened).toHaveLength(1);
    const refreshes = oauth.records.filter((record) => record.path === '/token' && record.form?.['grant_type'] === 'refresh_token');
    expect(refreshes.map((record) => record.form?.['client_id'])).toEqual(opened);
  });
});
