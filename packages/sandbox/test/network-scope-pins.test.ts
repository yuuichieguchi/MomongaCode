import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { SANDBOX_NETWORK_SCOPES, SandboxPolicyError, buildSeatbeltProfile, planBubblewrap, nodeFilesystemPort } from '@momonga/sandbox';
import type { SandboxNetwork, SandboxPolicy } from '@momonga/sandbox';
import { makeTempDir } from './helpers.ts';
import { NEVER_CANCELLED, testPaths, testKernelLock } from '@momonga/testkit';

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const policyWith = (network: SandboxNetwork): SandboxPolicy => {
  const root = fs.realpathSync(makeTempDir());
  created.push(root);
  return { writableRoots: [root], writeDenied: [], protectedSet: EMPTY_PROTECTED_SET, writeDeniedLiterals: [], fileRules: EMPTY_FILE_RULES, readDenied: [], network };
};

const networkRules = async (network: SandboxNetwork): Promise<string[]> => (await buildSeatbeltProfile(policyWith(network), {}, testPaths())).profile.split('\n').filter((line) => line.includes('network'));

describe('what each network value of a policy lets the kernel allow (I4.5)', () => {
  it('declares the scopes each backend can enforce', () => {
    expect(SANDBOX_NETWORK_SCOPES).toEqual({ seatbelt: ['none', 'hosts', 'open'], bubblewrap: ['none', 'open'], none: ['open'] });
  });

  it('writes (allow network*) into the Seatbelt profile for open only', async () => {
    expect(await networkRules('allow')).toEqual(['(allow network*)']);
    expect(await networkRules('deny')).toEqual([]);
    expect(await networkRules({ loopbackPort: 41234 })).toEqual(['(allow network-outbound (remote ip "localhost:41234"))']);
  });

  it.each([0, -1, 65_536, 1.5, Number.NaN])('refuses the loopback port %s', async (loopbackPort) => {
    await expect(buildSeatbeltProfile(policyWith({ loopbackPort }), {}, testPaths())).rejects.toThrow(SandboxPolicyError);
  });

  it('leaves the network namespace shared under bubblewrap for open only, and refuses a loopback port', async () => {
    const open = policyWith('allow');
    const none = policyWith('deny');
    expect((await planBubblewrap(open, { cwd: open.writableRoots[0] as string }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()))).args).not.toContain('--unshare-net');
    expect((await planBubblewrap(none, { cwd: none.writableRoots[0] as string }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()))).args).toContain('--unshare-net');
    const proxied = policyWith({ loopbackPort: 41234 });
    await expect(planBubblewrap(proxied, { cwd: proxied.writableRoots[0] as string }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()))).rejects.toThrow('the bubblewrap sandbox cannot limit a command to one loopback port');
  });
});
