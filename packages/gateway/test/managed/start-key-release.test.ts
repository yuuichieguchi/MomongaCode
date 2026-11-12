import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeKeyOf } from '@momonga/config';
import type { KnownProbeKey } from '@momonga/config';
import { createManagedTarget, managedCurrencyOf, saveProbeRecord } from '@momonga/gateway';
import type { ManagedServer, ManagedTarget } from '@momonga/gateway';
import { TARGET_PROBING } from '@momonga/protocol';
import { FAKE_OS_BUILD, REAL_PROCESS_TEST_TIMEOUT_MS, testKernelLock } from '@momonga/testkit';
import { makeReport } from '../report-fixture.ts';
import { declaredForm } from './declared-support.ts';
import { FakeChild, createManagedServer, makeShortDir } from './managed-support.ts';
import { hostTimers } from '@momonga/testkit';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const COMMAND = '/opt/mine/bin/mine-server';
const DECLARATION = { command: COMMAND, args: ['run', '--socket', '{socket}'], readyPath: '/ready' };

const knownKey = (binarySha256: string): KnownProbeKey => {
  const key = probeKeyOf({ subject: 'mine', identity: ['binarySha256', 'hostOsBuild'], readings: { binarySha256: { kind: 'read', value: binarySha256 }, hostOsBuild: { kind: 'read', value: FAKE_OS_BUILD } }, model: 'fake-1' });
  if (key.kind !== 'known') throw new Error('a key built from read components is known');
  return key;
};

const KEY_A = knownKey('aa'.repeat(32));
const KEY_B = knownKey('bb'.repeat(32));

const dirs: string[] = [];
const children: FakeChild[] = [];
const servers: { stop(): Promise<void> }[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop().catch(() => undefined);
  for (const child of children.splice(0)) await child.crash(0, null);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type Wiring = {
  spawnFails: (index: number) => boolean;
  afterChildStarting: (index: number, server: ManagedServer) => void;
};

const wired = async ({ spawnFails, afterChildStarting }: Wiring) => {
  const dir = makeShortDir(dirs);
  const socket = path.join(dir, 'mine.sock');
  const description = declaredForm('mine', DECLARATION);
  const currency = managedCurrencyOf(description, { userDialects: {} });
  const probeDir = path.join(dir, 'probe');
  await saveProbeRecord(probeDir, KEY_A, makeReport(1, 1), currency, testKernelLock());
  const binary = { key: KEY_A };
  const started: unknown[] = [];
  let spawns = 0;
  let childStarts = 0;
  let managed: ManagedTarget | undefined;
  const server = createManagedServer({
    description,
    target: 'workbench',
    binary: COMMAND,
    socketPath: socket,
    lockPath: path.join(dir, 'mine.lock'),
    readyTimeoutMs: REAL_PROCESS_TEST_TIMEOUT_MS,
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    spawn: () => {
      const index = spawns;
      spawns += 1;
      if (spawnFails(index)) throw new Error('spawn EACCES');
      const child = new FakeChild(socket, '/ready', {});
      children.push(child);
      return child;
    },
    readStopGraceMs: () => 30,
    onWarning: () => undefined,
    onChildStart: async (signal: AbortSignal) => {
      const index = childStarts;
      childStarts += 1;
      if (managed === undefined) throw new Error("the server started a child before its target was wired");
      await managed.childStarting(signal);
      afterChildStarting(index, server as unknown as ManagedServer);
    },
    onChildExit: () => managed?.childExited(),
  } as Parameters<typeof createManagedServer>[0]) as unknown as ManagedServer;
  servers.push(server);
  managed = await createManagedTarget({
    description,
    server,
    binary: COMMAND,
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    probeRecordDir: probeDir,
    serverName: 'workbench',
    requestLimitMs: 300_000,
    timeoutSignal: hostTimers.timeoutSignal,
    isUsableBinary: async () => true,
    readKey: async () => binary.key,
    onInstanceEnd: () => undefined,
    startProbe: async (key) => {
      started.push(key);
      return { state: 'probing', message: 'probing', retryAfterSeconds: 120, measuring: { fields: ['toolCalling'], step: null, elapsedSeconds: 0, declaration: 'declare toolCalling for the model in its settings' } } as const;
    },
    instanceProbe: () => {
      throw new Error('every key component is read in this test');
    },
    currency,
    toolCallingSetting: 'auto',
  });
  return { server, managed, binary, started };
};

const target = { name: 'workbench', display: 'workbench', model: 'fake-1' };

describe('a start that launches no child does not keep its start key for the next start (19.11-a, 19.14 item 16b)', () => {
  it('reads the key again at the next start after a start abandoned because the instance is no longer current', async () => {
    const stops: Promise<void>[] = [];
    const { server, managed, binary, started } = await wired({
      spawnFails: () => false,
      afterChildStarting: (index, running) => {
        if (index === 0) stops.push(running.stop());
      },
    });

    await expect(server.start(AbortSignal.timeout(REAL_PROCESS_TEST_TIMEOUT_MS))).rejects.toThrow('stopped while starting');
    await Promise.all(stops);
    binary.key = KEY_B;
    await server.start(AbortSignal.timeout(REAL_PROCESS_TEST_TIMEOUT_MS));

    await expect(managed.capabilities(target)).rejects.toMatchObject({ status: 503, body: { code: TARGET_PROBING } });
    expect(started).toEqual([KEY_B]);
  });

  it('reads the key again at the next start after a launch that throws', async () => {
    const { server, managed, binary, started } = await wired({
      spawnFails: (index) => index === 0,
      afterChildStarting: () => undefined,
    });

    await expect(server.start(AbortSignal.timeout(REAL_PROCESS_TEST_TIMEOUT_MS))).rejects.toThrow('spawn EACCES');
    binary.key = KEY_B;
    await server.start(AbortSignal.timeout(REAL_PROCESS_TEST_TIMEOUT_MS));

    await expect(managed.capabilities(target)).rejects.toMatchObject({ status: 503, body: { code: TARGET_PROBING } });
    expect(started).toEqual([KEY_B]);
  });
});
