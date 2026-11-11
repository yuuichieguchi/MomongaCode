import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBinaryHashCache } from '@momonga/foundation';
import { createInstanceProbe, createManagedTarget, managedCurrencyOf, managedKeyReader } from '@momonga/gateway';
import type { ManagedServer } from '@momonga/gateway';
import { FM_SERVER, TARGET_PROBING } from '@momonga/protocol';
import type { ManagedServerDescription } from '@momonga/protocol';
import { fakeExec } from '@momonga/testkit';
import { makeDir } from '../gateway-helpers.ts';
import { makeReport } from '../report-fixture.ts';
import { loadedDeclaration, writeExecutable } from './declared-support.ts';
import { FakeChild, createManagedServer, createManualTimers, makeShortDir } from './managed-support.ts';
import type { ManagedServerHandle } from './managed-support.ts';

const dirs: string[] = [];
const children: FakeChild[] = [];
const servers: ManagedServerHandle[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop().catch(() => undefined);
  for (const child of children.splice(0)) await child.crash(0, null);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const DECLARATION = { command: '/opt/mine/bin/mine-server', args: ['run', '--socket', '{socket}'], readyPath: '/ready' };

type RestartKind = { label: string; target: string; description: () => Promise<ManagedServerDescription> };

const RESTART_KINDS: RestartKind[] = [
  { label: 'a declared server', target: 'workbench', description: () => loadedDeclaration('loom', DECLARATION) },
  { label: 'the built-in fm', target: 'apple', description: async () => FM_SERVER },
];

describe.each(RESTART_KINDS)('$label goes to failed after maxRestarts consecutive crashes, on fake timers (design-managed-servers 13.2 item 4, 19.1 restart policy; R-S19-10)', (kind) => {
  it('waits 1000, 2000, 4000, 8000 and 16000 ms between restarts and then reports the server exceeded 5 restarts', async () => {
    const description = await kind.description();
    expect(description.restart).toEqual({ backoffMs: 1000, maxRestarts: 5, windowMs: 60_000 });
    const dir = makeShortDir(dirs);
    const socket = path.join(dir, `${kind.target}.sock`);
    const manual = createManualTimers();
    const spawned: FakeChild[] = [];
    const spawn = vi.fn(() => {
      const child = new FakeChild(socket, description.ready.path, spawned.length === 0 ? {} : { dieOnSpawn: true });
      spawned.push(child);
      children.push(child);
      return child;
    });
    const server = createManagedServer({
      description,
      target: kind.target,
      binary: description.binary.defaultPath,
      socketPath: socket,
      lockPath: path.join(dir, `${kind.target}.lock`),
      readyTimeoutMs: description.ready.limitMs,
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      spawn,
      timers: manual.timers,
      readStopGraceMs: () => 30,
      onWarning: () => undefined,
    });
    servers.push(server);
    await server.start(new AbortController().signal);
    await spawned[0]?.crash(1, null);
    for (const delay of [1000, 2000, 4000, 8000, 16_000]) {
      await vi.waitFor(() => expect(manual.delays()).toEqual([delay]));
      manual.fire(delay);
    }
    await vi.waitFor(async () =>
      expect(await server.health(new AbortController().signal)).toEqual({
        ok: false,
        reason: 'unhealthy',
        detail: `the model "${kind.target}": the server exceeded 5 restarts; the next request starts it again`,
      }),
    );
    expect(spawn).toHaveBeenCalledTimes(6);
  });
});

const idleServer: ManagedServer = {
  restarts: 0,
  start: async () => ({ kind: 'unix', path: '/unused.sock' }),
  ensureRunning: async () => ({ kind: 'unix', path: '/unused.sock' }),
  stop: async () => undefined,
  health: async () => ({ ok: true }),
};

describe('a declared server whose binary exists but cannot be read for its hash (17.10, 19.4; R-S19-14)', () => {
  it('writes no record, shows the item-10 text once per instance, and measures again on each start', async () => {
    const binary = writeExecutable(makeDir(), 'mine-server', '#!/bin/sh\nexit 0\n');
    const description = await loadedDeclaration('loom', { ...DECLARATION, command: binary });
    const refused = Object.assign(new Error(`EACCES: permission denied, open '${binary}'`), { code: 'EACCES' });
    const hashes = { ...createBinaryHashCache(), sha256Of: async () => Promise.reject(refused) };
    const readKey = managedKeyReader({ description, binary, model: 'fake-1', exec: fakeExec, platform: 'darwin', hashes });
    const probeRecordDir = path.join(makeDir(), 'probe');
    const notices: string[] = [];
    let measured = 0;
    const managed = await createManagedTarget({
      description,
      server: idleServer,
      binary,
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      probeRecordDir,
      serverName: 'workbench',
      requestLimitMs: 300_000,
      isUsableBinary: async () => true,
      readKey,
      onInstanceEnd: () => undefined,
      startProbe: async () => {
        throw new Error('a key with an unreadable component never starts a recorded probe');
      },
      instanceProbe: (unknown) =>
        createInstanceProbe({
          target: 'workbench',
          unknown,
          dir: probeRecordDir,
          measure: async () => {
            measured += 1;
            return makeReport(1, 1);
          },
          retryAfterMs: 120_000,
          clock: { now: () => 0 },
          onNotice: (text) => notices.push(text),
        }),
      currency: managedCurrencyOf(description, { userDialects: {} }),
      toolCallingSetting: 'auto',
    });
    const target = { name: 'workbench', display: 'workbench', model: 'fake-1' };
    const notice = `the model "workbench": its probe key needs the binary sha256, which cannot be read: the executable ${binary} cannot be read: ${refused.message}; it is measured each time its server starts and no probe record is kept`;

    await expect(managed.capabilities(target)).rejects.toMatchObject({ status: 503, body: { code: TARGET_PROBING } });
    await vi.waitFor(async () => expect((await managed.capabilities(target)).toolCalling).toBe('native'));
    expect(measured).toBe(1);
    expect(notices).toEqual([notice]);

    managed.childExited();
    await expect(managed.capabilities(target)).rejects.toMatchObject({ status: 503, body: { code: TARGET_PROBING } });
    await vi.waitFor(async () => expect((await managed.capabilities(target)).toolCalling).toBe('native'));
    expect(measured).toBe(2);
    expect(notices).toEqual([notice, notice]);
    expect(fs.existsSync(probeRecordDir) ? fs.readdirSync(probeRecordDir) : []).toEqual([]);
  });
});
