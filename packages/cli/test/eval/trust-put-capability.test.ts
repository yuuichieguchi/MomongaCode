import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { TestContext } from 'vitest';
import { describe, expect, it } from 'vitest';
import { ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import { PERSON_CAPABILITY_HEADER } from '@momonga/protocol';
import { registerCleanup, testKernelLock, withTempDir } from '@momonga/testkit';
import { nodeContextEffects } from '../../src/eval/context-effects.ts';
import type { CliPorts } from '../../src/ports.ts';
import { nodeClock } from '../../src/node-ports.ts';

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders };

const serveRuntime = async (context: TestContext, socketPath: string): Promise<Seen[]> => {
  const seen: Seen[] = [];
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      seen.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers });
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ trust: { path: '/work', decision: null } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  registerCleanup(context, async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return seen;
};

describe('the eval host sends the person capability on its trust put', () => {
  it('the PUT /v1/trust of a case home carries the capability of that home', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, process.env);
    await ensureMomongaDirs(paths);
    const socketPath = path.join(withTempDir(context), 'r.sock');
    const seen = await serveRuntime(context, socketPath);
    fs.writeFileSync(paths.current, JSON.stringify({ generation: 1, version: '0.0.0', sockets: { gateway: socketPath, runtime: socketPath, supervisor: socketPath } }));
    const ports = {
      platform: process.platform,
      env: {},
      home,
      clock: nodeClock,
      process: { pid: 4242, uid: () => 501, kill: () => undefined },
      personCapability: async (of: string) => `capability-of-${path.basename(of)}`,
    } as unknown as CliPorts;
    const runtime = nodeContextEffects(ports, testKernelLock()).connect(paths);
    registerCleanup(context, () => runtime.close());
    await runtime.setTrust('/work', 'trusted');
    const put = seen.find((entry) => entry.method === 'PUT');
    expect(put?.url).toBe('/v1/trust');
    expect(put?.headers[PERSON_CAPABILITY_HEADER]).toBe(`capability-of-${path.basename(home)}`);
  });
});
