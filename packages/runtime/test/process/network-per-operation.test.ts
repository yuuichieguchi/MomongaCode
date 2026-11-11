import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { NetworkConfig, OutboundNetwork, TrustReport } from '@momonga/foundation';
import * as runtime from '@momonga/runtime';
import type { DerivedNetwork } from '@momonga/runtime';
import { createRun, createSession, makeCache, makeRuntimeFixture, makeTempHome, onCleanup, signalNever, writeUserSettings } from './helpers.ts';

const NO_TRUST: TrustReport = { sources: [], failures: [] };

const derivedWithProxy = (proxy: string): DerivedNetwork => ({
  outbound: { config: { httpProxy: { value: proxy, source: 'network.httpProxy' }, httpsProxy: { value: proxy, source: 'network.httpProxy' }, caFiles: [] }, trust: NO_TRUST },
  identity: proxy,
});

const recordingProxy = async (): Promise<{ url: string; seen: string[] }> => {
  const seen: string[] = [];
  const server = http.createServer((request, response) => {
    seen.push(request.url ?? '');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onCleanup(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
};

describe('the network derivation of the runtime', () => {
  it('installs trust once per network setting and shares the result with every reader', async () => {
    const temp = await makeTempHome();
    writeUserSettings(temp.home, { network: { httpProxy: 'http://a.invalid:1' } });
    const cache = makeCache(temp.home);
    const installed: NetworkConfig[] = [];
    const networks = runtime.createNetworkDerivation({
      cache,
      signal: signalNever(),
      env: {},
      install: async (config) => {
        installed.push(config);
        return NO_TRUST;
      },
      onWarning: () => undefined,
    });

    const first = await networks.networkOf(signalNever());
    const second = await networks.networkOf(signalNever());
    expect(installed).toHaveLength(1);
    expect(second.identity).toBe(first.identity);

    writeUserSettings(temp.home, { network: { httpProxy: 'http://b.invalid:1' } });
    const changed = await networks.networkOf(signalNever());
    await networks.networkOf(signalNever());

    expect(installed.map((config) => config.httpProxy?.value)).toEqual(['http://a.invalid:1', 'http://b.invalid:1']);
    expect(changed.outbound.config.httpProxy?.value).toBe('http://b.invalid:1');
    expect(changed.identity).not.toBe(first.identity);
  });
});

describe('the outbound network of the tools of a run', () => {
  it('gives a forge call the network derived when the call starts', async () => {
    const a = await recordingProxy();
    const b = await recordingProxy();
    const answers = [derivedWithProxy(a.url), derivedWithProxy(b.url)];
    const fetch = runtime.outboundForgeFetch(async () => {
      const next = answers.shift();
      if (next === undefined) throw new Error('asked for a third network');
      return next;
    });
    const init = { boundMs: 10_000, method: 'GET', redirect: 'error' as const, signal: signalNever(), headers: {} };

    await fetch(new URL('http://forge.invalid/first'), init);
    await fetch(new URL('http://forge.invalid/second'), init);

    expect(a.seen).toEqual(['http://forge.invalid/first']);
    expect(b.seen).toEqual(['http://forge.invalid/second']);
  });

  it('builds a new MCP pool with the new network after the network setting changed', async () => {
    const answers = [derivedWithProxy('http://a.invalid:1'), derivedWithProxy('http://b.invalid:1')];
    let current = answers[0] as DerivedNetwork;
    const f = await makeRuntimeFixture({ network: async () => current });
    writeUserSettings(f.temp.home, { mcpServers: { fx: { command: process.execPath, args: ['-e', ''] } } });

    await f.toolRuntime.port.toolSet(await createRun(f.store, createSession(f.store, f.temp.project).id), { signal: signalNever(), env: { PATH: '/usr/bin:/bin' } });
    current = answers[1] as DerivedNetwork;
    await f.toolRuntime.port.toolSet(await createRun(f.store, createSession(f.store, f.temp.project).id), { signal: signalNever(), env: { PATH: '/usr/bin:/bin' } });

    const networks = f.pools.pools.map((pool) => (pool.options?.remote?.network as OutboundNetwork | undefined)?.config.httpProxy?.value);
    expect(networks).toEqual(['http://a.invalid:1', 'http://b.invalid:1']);
  });
});
