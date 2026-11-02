import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { McpRemotePolicyError, assertRemoteUrl, createGuardedFetch, isPublicAddress } from '@momonga/mcp';
import type { HostResolver } from '@momonga/mcp';
import { onCleanup } from './mcp-harness.ts';
import { makeRemoteConnection, startHttpFixture } from './remote-harness.ts';

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
  ])('refuses an address literal that is %s', (_label, url) => {
    expect(violationOf(() => assertRemoteUrl(url, 'project'))).toBe('non_public_address_literal');
  });

  it.each(['https://localhost/mcp', 'https://app.localhost/mcp', 'https://localhost./mcp'])('refuses the loopback host name in %s', (url) => {
    expect(violationOf(() => assertRemoteUrl(url, 'project'))).toBe('loopback_hostname');
  });

  it('classifies public and non-public addresses', () => {
    expect(isPublicAddress('93.184.216.34')).toBe(true);
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(true);
    expect(isPublicAddress('::ffff:8.8.8.8')).toBe(true);
    for (const address of ['127.0.0.1', '10.1.1.1', '169.254.1.1', '192.0.2.1', '198.18.0.1', '255.255.255.255', '::', '::1', 'fc00::1', '2001:db8::1', 'not-an-ip']) {
      expect(isPublicAddress(address)).toBe(false);
    }
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
    const guarded = createGuardedFetch({ scope: 'project', resolver: resolverTo('127.0.0.1') });
    onCleanup(() => guarded.close());
    const failure = await guarded.fetch(`https://rebind.example.test:${server.port}/`).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(messageOf(failure)).toContain('non-public address (127.0.0.1)');
    expect(server.requests()).toBe(0);
  });

  it('refuses a name when any one of its addresses is non-public', async () => {
    const guarded = createGuardedFetch({ scope: 'project', resolver: resolverTo('93.184.216.34', '169.254.169.254') });
    onCleanup(() => guarded.close());
    const failure = await guarded.fetch('https://mixed.example.test/').then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(messageOf(failure)).toContain('non-public address (169.254.169.254)');
  });

  it('refuses a name that resolves to nothing', async () => {
    const guarded = createGuardedFetch({ scope: 'project', resolver: resolverTo() });
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

describe('redirects followed by the guarded fetch itself', () => {
  const redirectTo = (location: string, status = 302): Response => new Response(null, { status, headers: { location } });

  const scripted = (...responses: Response[]) => {
    const urls: string[] = [];
    const send = (url: URL): Promise<Response> => {
      urls.push(url.href);
      const next = responses.shift();
      if (next === undefined) return Promise.reject(new Error(`unexpected request to ${url.href}`));
      return Promise.resolve(next);
    };
    return { urls, send };
  };

  it('never sends the second request when a public name redirects to a private address literal', async () => {
    const { urls, send } = scripted(redirectTo('https://169.254.169.254/latest/meta-data'));
    const guarded = createGuardedFetch({ scope: 'project', send });
    const response = await guarded.fetch('https://mcp.example.com/.well-known/oauth-protected-resource');
    expect(response.status).toBe(302);
    expect(urls).toEqual(['https://mcp.example.com/.well-known/oauth-protected-resource']);
  });

  it('refuses a same-origin redirect that adds credentials to the URL', async () => {
    const { urls, send } = scripted(redirectTo('https://user:pass@mcp.example.com/mcp'));
    const guarded = createGuardedFetch({ scope: 'project', send });
    await expect(guarded.fetch('https://mcp.example.com/mcp')).rejects.toMatchObject({ violation: 'credentials_in_url' });
    expect(urls).toHaveLength(1);
  });

  it('does not follow a redirect to another origin and hands the redirect response back', async () => {
    const { urls, send } = scripted(redirectTo('https://elsewhere.example.net/token'));
    const guarded = createGuardedFetch({ scope: 'project', send });
    const response = await guarded.fetch('https://auth.example.com/token', { method: 'POST' });
    expect(response.status).toBe(302);
    expect(urls).toHaveLength(1);
  });

  it('follows a same-origin redirect, re-checking the target', async () => {
    const { urls, send } = scripted(redirectTo('/other'), new Response('ok'));
    const guarded = createGuardedFetch({ scope: 'project', send });
    expect(await (await guarded.fetch('https://mcp.example.com/mcp')).text()).toBe('ok');
    expect(urls).toEqual(['https://mcp.example.com/mcp', 'https://mcp.example.com/other']);
  });

  it('does not follow a method-changing redirect of a POST', async () => {
    const { urls, send } = scripted(redirectTo('/elsewhere', 302));
    const guarded = createGuardedFetch({ scope: 'project', send });
    expect((await guarded.fetch('https://auth.example.com/token', { method: 'POST' })).status).toBe(302);
    expect(urls).toHaveLength(1);
  });

  it('stops after five hops', async () => {
    const { urls, send } = scripted(...Array.from({ length: 7 }, () => redirectTo('/again')));
    const guarded = createGuardedFetch({ scope: 'project', send });
    expect((await guarded.fetch('https://mcp.example.com/mcp')).status).toBe(302);
    expect(urls).toHaveLength(6);
  });

  it('leaves redirect handling to the caller when it asks for manual', async () => {
    const { urls, send } = scripted(redirectTo('https://169.254.169.254/'));
    const guarded = createGuardedFetch({ scope: 'project', send });
    expect((await guarded.fetch('https://mcp.example.com/mcp', { redirect: 'manual' })).status).toBe(302);
    expect(urls).toHaveLength(1);
  });
});
