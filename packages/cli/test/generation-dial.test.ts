import http from 'node:http';
import { currentSocketResolver, ensureGenerationDirs, ensureMomongaDirs, generationLayout, momongaPaths, publishCurrentGeneration } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import { describe, expect, it } from 'vitest';
import { createGatewayClient } from '../src/client/gateway-client.ts';
import { createRuntimeClient } from '../src/client/runtime-client.ts';
import { createSupervisorClient } from '../src/client/supervisor-client.ts';

type Role = 'runtime' | 'gateway' | 'supervisor';

const BODIES: Record<Role, { path: string; body: unknown }> = {
  runtime: {
    path: '/v1/health',
    body: { status: 'ok', version: '1.0.0', apiVersion: 1, pid: 4242, startedAt: '2026-11-09T00:00:00.000Z', state: 'running', sandbox: 'none' },
  },
  gateway: { path: '/v1/momonga/models', body: { data: [] } },
  supervisor: { path: '/v1/health', body: { status: 'ok', version: '1.0.0', pid: 4243, phase: 'running', children: [] } },
};

type Deferred = { promise: Promise<void>; resolve(): void };

const deferred = (): Deferred => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

type FakeGeneration = { received: string[]; hold: Deferred | undefined; arrived: Deferred; close(): Promise<void> };

const retiringStyleServer = async (socket: string, role: Role): Promise<FakeGeneration> => {
  const fake: FakeGeneration = { received: [], hold: undefined, arrived: deferred(), close: async () => undefined };
  const server = http.createServer((request, response) => {
    fake.received.push(`${request.method} ${request.url}`);
    fake.arrived.resolve();
    const answer = (): void => {
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' }).end(JSON.stringify(BODIES[role].body));
    };
    if (fake.hold === undefined) answer();
    else void fake.hold.promise.then(answer);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, () => resolve());
  });
  fake.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return fake;
};

type Setup = { paths: MomongaPaths; g1: FakeGeneration; g2: FakeGeneration; promote(): Promise<void> };

const twoGenerations = async (context: Parameters<typeof withTempDir>[0], role: Role): Promise<Setup> => {
  const home = withTempDir(context, { asHome: true });
  const paths = momongaPaths(home);
  await ensureMomongaDirs(paths);
  await ensureGenerationDirs(paths, 1);
  await ensureGenerationDirs(paths, 2);
  const g1 = await retiringStyleServer(generationLayout(home, 1).sockets[role], role);
  registerCleanup(context, () => g1.close());
  const g2 = await retiringStyleServer(generationLayout(home, 2).sockets[role], role);
  registerCleanup(context, () => g2.close());
  await publishCurrentGeneration(paths, { generation: 1, version: '1.0.0', sockets: generationLayout(home, 1).sockets });
  const promote = async (): Promise<void> => {
    await publishCurrentGeneration(paths, { generation: 2, version: '1.0.0', sockets: generationLayout(home, 2).sockets });
  };
  return { paths, g1, g2, promote };
};

type Client = { call(): Promise<unknown>; close(): Promise<void> };

const clients: Record<Role, (paths: MomongaPaths) => Client> = {
  runtime: (paths) => {
    const client = createRuntimeClient({ resolveSocket: currentSocketResolver(paths, 'runtime') });
    return { call: () => client.health(), close: () => client.close() };
  },
  gateway: (paths) => {
    const client = createGatewayClient({ resolveSocket: currentSocketResolver(paths, 'gateway') });
    return { call: () => client.models(), close: () => client.close() };
  },
  supervisor: (paths) => {
    const client = createSupervisorClient({ resolveSocket: currentSocketResolver(paths, 'supervisor') });
    return { call: () => client.health(), close: () => client.close() };
  },
};

describe.each(['runtime', 'gateway', 'supervisor'] as const)('the %s client resolves the current generation at each dial (rule 5a)', (role) => {
  it('sends its next request to g2 after run/current is replaced to name g2', async (context) => {
    const setup = await twoGenerations(context, role);
    const client = clients[role](setup.paths);
    registerCleanup(context, () => client.close());

    await client.call();
    expect(setup.g1.received).toEqual([`GET ${BODIES[role].path}`]);
    expect(setup.g2.received).toEqual([]);

    await setup.promote();
    await client.call();
    expect(setup.g1.received).toHaveLength(1);
    expect(setup.g2.received).toEqual([`GET ${BODIES[role].path}`]);
  });

  it('leaves a request already in flight on g1 there when g2 becomes current', async (context) => {
    const setup = await twoGenerations(context, role);
    const client = clients[role](setup.paths);
    registerCleanup(context, () => client.close());
    const hold = deferred();
    setup.g1.hold = hold;

    const inFlight = client.call();
    await setup.g1.arrived.promise;
    await setup.promote();
    hold.resolve();
    await inFlight;

    expect(setup.g1.received).toEqual([`GET ${BODIES[role].path}`]);
    expect(setup.g2.received).toEqual([]);
  });
});
