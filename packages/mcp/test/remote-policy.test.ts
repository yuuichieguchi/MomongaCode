import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { McpRemotePolicyError, assertRemoteUrl, createGuardedFetch } from '@momonga/mcp';
import type { HostResolver } from '@momonga/mcp';
import { UNCONFIGURED_NETWORK } from '@momonga/testkit';
import { onCleanup } from './mcp-harness.ts';
import { makeRemoteConnection, startHttpFixture } from './remote-harness.ts';

const OUTBOUND = { network: UNCONFIGURED_NETWORK, connectTimeoutMs: 30_000 } as const;

const violationOf = (action: () => unknown): string | undefined => {
  try {
    action();
  } catch (error) {
    if (error instanceof McpRemotePolicyError) return error.violation;
    throw error;
  }
  return undefined;
};

const messageOf = (error: Error | undefined): string => JSON.stringify([error?.message, String((error?.cause as Error | undefined)?.message)]);

const countingServer = async (respond: (req: http.IncomingMessage, res: http.ServerResponse) => void) => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    respond(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onCleanup(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port: (server.address() as AddressInfo).port, requests: () => requests };
};

describe('project-scope remote URL rules', () => {
  it('accepts a public https URL', () => {
    expect(violationOf(() => assertRemoteUrl('https://mcp.example.com/mcp', 'project'))).toBeUndefined();
  });

  it('refuses plain http because a bearer token would cross the network in clear', () => {
    expect(violationOf(() => assertRemoteUrl('http://mcp.example.com/mcp', 'project'))).toBe('scheme');
  });

  it.each(['file:///etc/passwd', 'ftp://example.com/', 'ws://example.com/'])('refuses the scheme of %s', (url) => {
    expect(violationOf(() => assertRemoteUrl(url, 'project'))).toBe('scheme');
  });

  it('refuses credentials embedded in the URL', () => {
    expect(violationOf(() => assertRemoteUrl('https://user:pass@mcp.example.com/mcp', 'project'))).toBe('credentials_in_url');
  });

  it.each([
    ['loopback', 'https://127.0.0.1/mcp'],
    ['loopback elsewhere in 127/8', 'https://127.1.2.3/mcp'],
    ['10/8', 'https://10.0.0.5/mcp'],
    ['172.16/12', 'https://172.20.1.1/mcp'],
    ['192.168/16', 'https://192.168.1.10/mcp'],
    ['cloud metadata (link-local)', 'https://169.254.169.254/latest/meta-data'],
    ['CGNAT 100.64/10', 'https://100.64.0.1/mcp'],
    ['unspecified', 'https://0.0.0.0/mcp'],
    ['multicast', 'https://224.0.0.1/mcp'],
    ['decimal encoding of 127.0.0.1', 'https://2130706433/mcp'],
    ['hex encoding of 127.0.0.1', 'https://0x7f000001/mcp'],
    ['IPv6 loopback', 'https://[::1]/mcp'],
    ['IPv6 unique-local', 'https://[fd00::1]/mcp'],
    ['IPv6 link-local', 'https://[fe80::1]/mcp'],
    ['IPv4-mapped loopback', 'https://[::ffff:127.0.0.1]/mcp'],
    ['IPv4-mapped metadata in hex form', 'https://[::ffff:a9fe:a9fe]/mcp'],
    ['NAT64 of a private address', 'https://[64:ff9b::10.0.0.1]/mcp'],
    ['6to4 of a private address', 'https://[2002:0a00:0001::1]/mcp'],
    ['shared address space', 'https://100.64.0.1/mcp'],
    ['IPv4-compatible form of a private address', 'https://[::10.0.0.1]/mcp'],
    ['local-use NAT64 of a private address', 'https://[64:ff9b:1::10.0.0.1]/mcp'],
    ['site-local', 'https://[fec0::1]/mcp'],
    ['IPv6 multicast', 'https://[ff02::1]/mcp'],
  ])('refuses an address literal that is %s', (_label, url) => {
    expect(violationOf(() => assertRemoteUrl(url, 'project'))).toBe('non_public_address_literal');
  });

  it.each(['https://localhost/mcp', 'https://app.localhost/mcp', 'https://localhost./mcp'])('refuses the loopback host name in %s', (url) => {
    expect(violationOf(() => assertRemoteUrl(url, 'project'))).toBe('loopback_hostname');
  });

  it.each(['https://93.184.216.34/mcp', 'https://[2606:2800:220:1:248:1893:25c8:1946]/mcp', 'https://[::ffff:8.8.8.8]/mcp'])('allows the public address literal in %s', (url) => {
    expect(violationOf(() => assertRemoteUrl(url, 'project'))).toBeUndefined();
  });
});

describe('user-scope remote URL rules', () => {
  it('allows http and loopback because the user wrote the URL', () => {
    expect(violationOf(() => assertRemoteUrl('http://127.0.0.1:8080/mcp', 'user'))).toBeUndefined();
    expect(violationOf(() => assertRemoteUrl('https://localhost/mcp', 'user'))).toBeUndefined();
  });

  it('still refuses other schemes and embedded credentials', () => {
    expect(violationOf(() => assertRemoteUrl('file:///etc/passwd', 'user'))).toBe('scheme');
    expect(violationOf(() => assertRemoteUrl('https://user:pass@mcp.example.com/', 'user'))).toBe('credentials_in_url');
  });

  it('reaches a loopback server in a user-scope connection', async () => {
    const fixture = await startHttpFixture({ era: 'modern' });
    const { connection } = makeRemoteConnection({ fixture, scope: 'user' });
    expect((await connection.listTools()).length).toBeGreaterThan(0);
  });
});

describe('project-scope connections', () => {
  it('refuses a loopback server before connecting', async () => {
    const fixture = await startHttpFixture({ era: 'modern' });
    const { connection } = makeRemoteConnection({ fixture, scope: 'project' });
    const failure = await connection.listTools().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(McpRemotePolicyError);
    expect(fixture.records).toHaveLength(0);
  });

  it('does not count a policy refusal against the circuit breaker', async () => {
    const fixture = await startHttpFixture({ era: 'modern' });
    const { connection } = makeRemoteConnection({ fixture, scope: 'project' });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(connection.listTools()).rejects.toBeInstanceOf(McpRemotePolicyError);
    }
    expect(connection.diagnostics().state).not.toBe('unavailable');
  });
});

describe('resolved addresses', () => {
  const resolverTo = (...addresses: string[]): HostResolver => () =>
    Promise.resolve(addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));

  it('refuses a public-looking name that resolves to a loopback address, without connecting', async () => {
    const server = await countingServer((_req, res) => res.end('reached'));
    const guarded = createGuardedFetch({ ...OUTBOUND, scope: 'project', resolver: resolverTo('127.0.0.1') });
    onCleanup(() => guarded.close());
    const failure = await guarded.fetch(`https://rebind.example.test:${server.port}/`).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(messageOf(failure)).toContain('non-public address (127.0.0.1)');
    expect(server.requests()).toBe(0);
  });

  it('refuses a name when any one of its addresses is non-public', async () => {
    const guarded = createGuardedFetch({ ...OUTBOUND, scope: 'project', resolver: resolverTo('93.184.216.34', '169.254.169.254') });
    onCleanup(() => guarded.close());
    const failure = await guarded.fetch('https://mixed.example.test/').then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(messageOf(failure)).toContain('non-public address (169.254.169.254)');
  });

  it('refuses a name that resolves to nothing', async () => {
    const guarded = createGuardedFetch({ ...OUTBOUND, scope: 'project', resolver: resolverTo() });
    onCleanup(() => guarded.close());
    const failure = await guarded.fetch('https://empty.example.test/').then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(messageOf(failure)).toContain('did not resolve');
  });

  it('refuses an address literal before any resolution', async () => {
    let resolutions = 0;
    const guarded = createGuardedFetch({
      ...OUTBOUND,
      scope: 'project',
      resolver: (host) => {
        resolutions += 1;
        return resolverTo('93.184.216.34')(host);
      },
    });
    onCleanup(() => guarded.close());
    await expect(guarded.fetch('https://10.1.2.3/')).rejects.toBeInstanceOf(McpRemotePolicyError);
    expect(resolutions).toBe(0);
  });
});

describe('the address that was checked is the address the proxy is asked for', () => {
  const recordingProxy = async (): Promise<{ port: number; heads: string[] }> => {
    const heads: string[] = [];
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
      let text = '';
      socket.on('data', (chunk) => {
        text += chunk.toString('latin1');
        if (!text.includes('\r\n\r\n')) return;
        heads.push(text);
        socket.end('HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    onCleanup(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return { port: (server.address() as AddressInfo).port, heads };
  };

  it('resolves a project-scope name once, and sends the proxy the address it verified, never the name', async () => {
    const proxy = await recordingProxy();
    const value = `http://127.0.0.1:${proxy.port}`;
    const asked: string[] = [];
    const answers = ['93.184.216.34', '10.0.0.1'];
    const resolver: HostResolver = (host) => {
      const address = answers[Math.min(asked.length, answers.length - 1)] as string;
      asked.push(host);
      return Promise.resolve([{ address, family: 4 }]);
    };
    const guarded = createGuardedFetch({
      scope: 'project',
      connectTimeoutMs: 30_000,
      network: { config: { httpsProxy: { value, source: 'network.httpsProxy' }, caFiles: [] }, trust: { sources: [], failures: [] } },
      resolver,
    });
    onCleanup(() => guarded.close());

    await expect(guarded.fetch('https://rebind.example.test/mcp')).rejects.toThrow();

    expect(asked).toEqual(['rebind.example.test']);
    expect(proxy.heads).toHaveLength(1);
    expect(proxy.heads[0]).toMatch(/^CONNECT 93\.184\.216\.34:443 HTTP\/1\.1\r\n/);
    expect(proxy.heads[0]).not.toContain('rebind.example.test');
    expect(proxy.heads[0]).not.toContain('10.0.0.1');
  });
});

describe('a refusal raised while the HTTP client resolves the host name', () => {
  const rebinding: HostResolver = () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]);

  const rebound = async () => {
    const server = await countingServer((_req, res) => res.end('reached'));
    const harness = makeRemoteConnection({
      fixture: { url: `https://rebind.example.test:${server.port}/mcp` },
      scope: 'project',
      resolver: rebinding,
    });
    return { ...harness, server };
  };

  it('keeps its type and its reason on every call and never opens the circuit', async () => {
    const { connection, server } = await rebound();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failure = await connection.listTools().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(McpRemotePolicyError);
      expect(failure).toMatchObject({ violation: 'non_public_resolved_address' });
      expect((failure as Error).message).toContain('non-public address (127.0.0.1)');
    }
    expect(connection.diagnostics().state).toBe('disconnected');
    expect(server.requests()).toBe(0);
  });

  it('is reported by authState as refused with the reason, not as unreachable', async () => {
    const { connection } = await rebound();
    const probe = await connection.authState(new AbortController().signal);
    expect(probe.state).toBe('refused');
    expect(probe.detail).toContain('non-public address (127.0.0.1)');
  });
});

describe('redirects', () => {
  it('does not follow a redirect from the MCP endpoint to another origin', async () => {
    const target = await countingServer((_req, res) => res.end('internal'));
    const origin = await countingServer((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${target.port}/internal` });
      res.end();
    });
    const url = `http://127.0.0.1:${origin.port}/mcp`;
    const { connection } = makeRemoteConnection({ fixture: { url }, scope: 'user' });
    await expect(connection.listTools()).rejects.toThrow();
    expect(origin.requests()).toBeGreaterThan(0);
    expect(target.requests()).toBe(0);
  });
});

describe('redirect handling of the guarded fetch', () => {
  const redirectTo = (location: string, status = 302): Response => new Response(null, { status, headers: { location } });

  const scripted = (...responses: Response[]) => {
    const calls: { url: string; redirect: RequestInit['redirect'] }[] = [];
    const send = (url: URL, init: RequestInit | undefined): Promise<Response> => {
      calls.push({ url: url.href, redirect: init?.redirect });
      const next = responses.shift();
      if (next === undefined) return Promise.reject(new Error(`unexpected request to ${url.href}`));
      return Promise.resolve(next);
    };
    return { calls, send };
  };

  it('never follows a redirect itself and hands the 3xx response to the caller, which re-enters the guard for the next hop', async () => {
    const { calls, send } = scripted(redirectTo('https://169.254.169.254/latest/meta-data'));
    const guarded = createGuardedFetch({ ...OUTBOUND, scope: 'project', send });
    const response = await guarded.fetch('https://mcp.example.com/mcp');
    expect(response.status).toBe(302);
    expect(calls).toEqual([{ url: 'https://mcp.example.com/mcp', redirect: 'manual' }]);
  });

  it('does not follow a same-origin redirect either', async () => {
    const { calls, send } = scripted(redirectTo('/other'), new Response('ok'));
    const guarded = createGuardedFetch({ ...OUTBOUND, scope: 'project', send });
    expect((await guarded.fetch('https://mcp.example.com/mcp')).status).toBe(302);
    expect(calls).toHaveLength(1);
  });

  it('sends manual to the transport when the caller names no redirect mode, so the HTTP client cannot follow on its own', async () => {
    const { calls, send } = scripted(new Response('ok'), new Response('ok'), new Response('ok'));
    const guarded = createGuardedFetch({ ...OUTBOUND, scope: 'project', send });
    await guarded.fetch('https://mcp.example.com/a');
    await guarded.fetch('https://mcp.example.com/b', { redirect: 'follow' });
    await guarded.fetch('https://mcp.example.com/c', { redirect: 'manual' });
    expect(calls.map((call) => call.redirect)).toEqual(['manual', 'manual', 'manual']);
  });

  it('keeps a caller that asks to fail on redirects', async () => {
    const { calls, send } = scripted(new Response('ok'));
    const guarded = createGuardedFetch({ ...OUTBOUND, scope: 'project', send });
    await guarded.fetch('https://mcp.example.com/a', { redirect: 'error' });
    expect(calls.map((call) => call.redirect)).toEqual(['error']);
  });

  it('checks the URL of every call, so each hop the caller makes is checked', async () => {
    const { calls, send } = scripted(redirectTo('https://10.1.2.3/'));
    const guarded = createGuardedFetch({ ...OUTBOUND, scope: 'project', send });
    const first = await guarded.fetch('https://mcp.example.com/mcp', { redirect: 'manual' });
    const next = first.headers.get('location') ?? '';
    await expect(guarded.fetch(next, { redirect: 'manual' })).rejects.toMatchObject({ violation: 'non_public_address_literal' });
    expect(calls).toHaveLength(1);
  });

  it('refuses a URL with credentials before sending it', async () => {
    const { calls, send } = scripted();
    const guarded = createGuardedFetch({ ...OUTBOUND, scope: 'project', send });
    await expect(guarded.fetch('https://user:pass@mcp.example.com/mcp')).rejects.toMatchObject({ violation: 'credentials_in_url' });
    expect(calls).toEqual([]);
  });
});
