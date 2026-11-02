import { createFakeClock, createFakeTimers, startMcpHttpFixture, startMcpOauthFixture } from '@momonga/testkit';
import type { FakeClock, FakeTimers, McpHttpFixture, McpHttpFixtureOptions, McpOauthFixture } from '@momonga/testkit';
import { createManagedConnection, createMemoryCredentialStore } from '@momonga/mcp';
import type { HostResolver, McpConnectionOptions, McpCredentialStore, McpRemotePorts, McpTimers } from '@momonga/mcp';
import type { McpServerScope } from '@momonga/config';
import { BASE_ENV, makeDir, onCleanup } from './mcp-harness.ts';

export const startHttpFixture = async (options: McpHttpFixtureOptions): Promise<McpHttpFixture> => {
  const fixture = await startMcpHttpFixture(options);
  onCleanup(() => fixture.close());
  return fixture;
};

export const startOauthFixture = async (): Promise<McpOauthFixture> => {
  const fixture = await startMcpOauthFixture();
  onCleanup(() => fixture.close());
  return fixture;
};

export type ObservedTimers = FakeTimers & { nextScheduled(match?: (ms: number) => boolean): Promise<void> };

export const observedTimers = (clock: FakeClock): ObservedTimers => {
  const fake = createFakeTimers(clock);
  const waiters: Array<{ match: (ms: number) => boolean; resolve: () => void }> = [];
  return {
    ...fake,
    setTimeout: (callback, ms) => {
      const handle = fake.setTimeout(callback, ms);
      for (const waiter of waiters.filter((entry) => entry.match(ms))) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
      return handle;
    },
    nextScheduled: (match = () => true) => new Promise<void>((resolve) => waiters.push({ match, resolve })),
  };
};

export const browserThatFollowsRedirect = (): ((url: URL) => Promise<void>) => async (url) => {
  const authorize = await fetch(url, { redirect: 'manual' });
  const location = authorize.headers.get('location');
  if (location === null) throw new Error(`the authorization endpoint did not redirect (status ${authorize.status})`);
  const callback = await fetch(location);
  await callback.arrayBuffer();
};

export type RemoteHarnessOptions = {
  fixture: Pick<McpHttpFixture, 'url'>;
  url?: string;
  scope?: McpServerScope;
  headers?: Record<string, string>;
  store?: McpCredentialStore;
  timers?: McpTimers;
  openAuthorizationUrl?: (url: URL, signal: AbortSignal) => Promise<void>;
  connection?: Partial<McpConnectionOptions>;
  oauth?: { clientId?: string; scope?: string; callbackPort?: number };
  closeInCleanup?: boolean;
  resolver?: HostResolver;
};

export const makeRemoteConnection = (options: RemoteHarnessOptions) => {
  const clock = createFakeClock(1_000_000);
  const store = options.store ?? createMemoryCredentialStore();
  let tokenCounter = 0;
  const remote: McpRemotePorts = {
    credentials: store,
    randomToken: () => {
      tokenCounter += 1;
      return `random-${tokenCounter}`;
    },
    openAuthorizationUrl: options.openAuthorizationUrl ?? (() => Promise.reject(new Error('no browser in this test'))),
    ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
  };
  const connection = createManagedConnection({
    name: 'remote',
    config: {
      type: 'http',
      url: options.url ?? options.fixture.url,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.oauth === undefined ? {} : { oauth: options.oauth }),
    },
    scope: options.scope ?? 'user',
    projectDir: makeDir(),
    baseEnv: BASE_ENV,
    clock,
    random: () => 0,
    remote,
    ...(options.timers === undefined ? {} : { timers: options.timers }),
    ...options.connection,
  });
  if (options.closeInCleanup !== false) onCleanup(() => connection.close());
  return { connection, store, clock, remote };
};

export const textOf = (result: { content?: unknown }): string =>
  (result.content as Array<{ type: string; text?: string }>).map((block) => block.text ?? '').join('\n');
