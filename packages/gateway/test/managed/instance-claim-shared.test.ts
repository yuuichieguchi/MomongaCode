import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { FakeChild, SERVER_KINDS, createManagedServer, makeShortDir } from './managed-support.ts';
import type { ManagedServerHandle } from './managed-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const dirs: string[] = [];
const children: FakeChild[] = [];
const servers: ManagedServerHandle[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop().catch(() => undefined);
  for (const child of children.splice(0)) await child.crash(0, null);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const asking = (): AbortSignal => new AbortController().signal;

describe.each(SERVER_KINDS)('two servers claiming one instance ($label)', (kind) => {
  it('one launch serves both claims: the second waits for the launch in flight and gets the same ready instance', async () => {
    const dir = makeShortDir(dirs);
    const socket = path.join(dir, `${kind.target}.sock`);
    const spawned: FakeChild[] = [];
    const options = {
      description: kind.description(),
      target: kind.target,
      binary: '/opt/managed/bin/server',
      socketPath: socket,
      lockPath: path.join(dir, `${kind.target}.lock`),
      readyTimeoutMs: 2000,
      exec: kind.metExec,
      spawn: () => {
        const created = new FakeChild(socket, kind.readyPath, { manualServe: true });
        spawned.push(created);
        children.push(created);
        return created;
      },
      readStopGraceMs: () => 30,
      onWarning: () => undefined,
    };
    const first = createManagedServer(options);
    const second = createManagedServer(options);
    servers.push(first, second);
    const claims = [first.start(asking()), second.start(asking())];
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    await spawned[0]?.serveNow();
    expect(await Promise.all(claims)).toEqual([
      { kind: 'unix', path: socket },
      { kind: 'unix', path: socket },
    ]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.alive).toBe(true);
  });
});
