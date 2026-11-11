import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET, systemRandom } from '@momonga/foundation';
import { DEFAULT_BWRAP_PATH, createBubblewrapSandbox, createPlaceholderJournal, createSeatbeltSandbox, heldMountPoints, startEgressProxy } from '@momonga/sandbox';
import type { EgressProxy, Sandbox, SandboxPolicy, SandboxedProcess } from '@momonga/sandbox';
import { REAL_PROCESS_TEST_TIMEOUT_MS, killGroupsForCleanup, testKernelLock } from '@momonga/testkit';
import { makeTempDir, run } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const RELAY_MAIN = fileURLToPath(new URL('./relay-main.ts', import.meta.url));
const HAS_BWRAP = process.platform === 'linux' && fs.existsSync(DEFAULT_BWRAP_PATH);
const HOSTS_HOST = process.platform === 'darwin' || HAS_BWRAP;
const DIRECT = { config: { caFiles: [] }, trust: { sources: [], failures: [] } };

describe.runIf(HOSTS_HOST)('the hosts scope under the real platform sandbox', () => {
  let created: string[] = [];
  let spawned: SandboxedProcess[] = [];
  let closers: (() => Promise<unknown>)[] = [];
  let work = '';
  let sandbox: Sandbox;

  const temp = (): string => {
    const dir = fs.realpathSync(makeTempDir());
    created.push(dir);
    return dir;
  };

  const origin = async (body: string): Promise<number> => {
    const server = http.createServer((_request, response) => response.writeHead(200, { 'content-type': 'text/plain' }).end(body));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }));
    return (server.address() as net.AddressInfo).port;
  };

  const proxyFor = async (hosts: readonly string[]): Promise<EgressProxy> => {
    const proxy = await startEgressProxy({ hosts, network: DIRECT, random: systemRandom });
    closers.push(() => proxy.close());
    return proxy;
  };

  const fetchThrough = async (proxy: EgressProxy, url: string): Promise<{ code: number | null; stdout: string }> => {
    const script = `const r = require('node:http').request({ host: '127.0.0.1', port: ${proxy.port}, path: ${JSON.stringify(url)}, headers: { 'proxy-authorization': ${JSON.stringify(proxy.authorization)} } }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { process.stdout.write(res.statusCode + ' ' + b); }); }); r.on('error', (e) => { process.stdout.write('error ' + e.code); process.exitCode = 3; }); r.end();`;
    const policy: SandboxPolicy = {
      writableRoots: [work],
      writeDenied: [],
      writeDeniedLiterals: [],
      protectedSet: EMPTY_PROTECTED_SET,
      fileRules: EMPTY_FILE_RULES,
      readDenied: [],
      network: { loopbackPort: proxy.port },
    };
    const proc = await sandbox.spawn({ argv: [process.execPath, '-e', script], cwd: work, env: { PATH: '/usr/bin:/bin' } }, policy, new AbortController().signal);
    spawned.push(proc);
    return run(proc);
  };

  beforeEach(() => {
    work = temp();
    sandbox =
      process.platform === 'darwin'
        ? createSeatbeltSandbox({ lock: testKernelLock(), tmpRoot: temp(), killGraceMs: 300 })
        : createBubblewrapSandbox({
            lock: testKernelLock(),
            tmpRoot: temp(),
            killGraceMs: 300,
            journal: createPlaceholderJournal(path.join(temp(), 'journal')),
            holders: heldMountPoints,
            relay: () => [process.execPath, RELAY_MAIN],
          });
  });

  afterEach(async () => {
    try {
      await killGroupsForCleanup(spawned.map((proc) => proc.pgid));
    } finally {
      for (const close of closers.splice(0).reverse()) await close();
      for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
      spawned = [];
    }
  });

  it('reaches a granted host through the proxy and is refused another', async () => {
    const granted = await origin('granted says hi');
    const other = await origin('other');
    const proxy = await proxyFor([`127.0.0.1:${granted}`]);
    const reached = await fetchThrough(proxy, `http://127.0.0.1:${granted}/`);
    expect(reached.stdout).toBe('200 granted says hi');
    expect(reached.code).toBe(0);
    expect((await fetchThrough(proxy, `http://127.0.0.1:${other}/`)).stdout).toMatch(/^403 /);
  });

  it('cannot reach a host directly, around the proxy', async () => {
    const granted = await origin('granted says hi');
    const proxy = await proxyFor([`127.0.0.1:${granted}`]);
    const script = `require('node:net').connect(${granted}, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(1))`;
    const policy: SandboxPolicy = { writableRoots: [work], writeDenied: [], writeDeniedLiterals: [], protectedSet: EMPTY_PROTECTED_SET, fileRules: EMPTY_FILE_RULES, readDenied: [], network: { loopbackPort: proxy.port } };
    const proc = await sandbox.spawn({ argv: [process.execPath, '-e', script], cwd: work, env: { PATH: '/usr/bin:/bin' } }, policy, new AbortController().signal);
    spawned.push(proc);
    expect((await run(proc)).code).not.toBe(0);
  });
});
