import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { daemonReadyBoundMs } from '../../src/daemon/ensure-daemon.ts';
import { createHomes } from '../../src/eval/context-host.ts';
import type { HomeEffects } from '../../src/eval/context-host.ts';

const effectsFor = (root: string): HomeEffects<never> =>
  ({
    lock: {},
    platform: 'linux',
    env: {},
    sessionEnv: async () => ({}),
    makeRoot: async () => root,
    prepare: async () => undefined,
    writeFile: async () => undefined,
    makeDirectory: async () => undefined,
    canonical: async (directory: string) => directory,
    refuseUnfitSockets: async () => undefined,
    startDaemon: async () => undefined,
    terminate: async () => undefined,
    remove: async () => undefined,
    connect: () => ({ setTrust: async () => undefined, close: async () => undefined }),
    applyStep: async () => undefined,
    after: async () => undefined,
    now: () => 0,
    random: () => 0.5,
    ownerPid: 1,
    ownerHome: root,
    readSecret: async () => '',
    copyProbeRecord: async () => undefined,
    copyEndpointProbeRecord: async () => undefined,
    listRoots: async () => [],
    readOwner: async () => undefined,
  }) as unknown as HomeEffects<never>;

describe('the eval host reconnects within the same bound as the TUI follow', () => {
  it('the reconnect bound of a case is the daemon ready bound the TUI follow uses', async () => {
    const homes = createHomes(effectsFor(path.join(os.tmpdir(), 'momonga-reconnect-bound')), {
      credentialValues: {},
      reflection: { pendingBoundMs: 1, attemptBoundMs: 1, pollMs: 1 },
      managedTargets: [],
      endpointProbes: [],
      interrupt: new AbortController().signal,
    });
    const opened = await homes.open({ label: 'case', settings: {} });
    expect(opened.follow.reconnectBoundMs).toBe(await daemonReadyBoundMs());
    await homes.dispose();
  });
});
