import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kernelLockNamed, layoutProcessInspector, resolveLayoutLocks } from '@momonga/foundation';
import type { ClaimOutcome, KernelLockMechanism, LayoutLocks, LockCapability, LockCapabilityProbe, ProcessInspector } from '@momonga/foundation';

const PROOF_PREFIX = 'momonga-test-lock-proof-';

let resolved: LayoutLocks | undefined;
let inspector: ProcessInspector | undefined;

const proveInFreshDirectory = (): LayoutLocks => {
  const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), PROOF_PREFIX));
  process.once('exit', () => fs.rmSync(proofDir, { recursive: true, force: true }));
  return resolveLayoutLocks({ callLocks: proofDir, lockProof: proofDir });
};

export const testLocks = (): LayoutLocks => (resolved ??= proveInFreshDirectory());

export const testKernelLock = (): KernelLockMechanism => testLocks().mechanism;

export type WatchedKernelLock = { mechanism: KernelLockMechanism; refusals(lockPath: string): number };

export const watchedKernelLock = (base: KernelLockMechanism = testKernelLock()): WatchedKernelLock => {
  const refused = new Map<string, number>();
  const counted = (lockPath: string, outcome: ClaimOutcome): ClaimOutcome => {
    if (outcome.kind === 'held') refused.set(lockPath, (refused.get(lockPath) ?? 0) + 1);
    return outcome;
  };
  const claimSync = base.claimSync;
  return {
    mechanism: {
      name: base.name,
      claim: async (lockPath) => counted(lockPath, await base.claim(lockPath)),
      ...(claimSync === undefined ? {} : { claimSync: (lockPath: string) => counted(lockPath, claimSync(lockPath)) }),
      isHeld: (lockPath) => base.isHeld(lockPath),
      readHolder: (lockPath) => base.readHolder(lockPath),
      readHolderSync: (lockPath) => base.readHolderSync(lockPath),
      claimInheritable: base.claimInheritable,
      adoptInherited: base.adoptInherited,
    },
    refusals: (lockPath) => refused.get(lockPath) ?? 0,
  };
};

export const testProcessInspector = (): ProcessInspector => (inspector ??= layoutProcessInspector(testLocks().capability));

export const fixedLockCapability = (answer: LockCapability): LockCapabilityProbe => ({
  of: async () => answer,
  decide: () => (answer === 'unmeasured' ? 'unprovable' : answer),
  contradicted: () => undefined,
});

export const expectedKernelLockOn = (platform: NodeJS.Platform): KernelLockMechanism => kernelLockNamed(platform === 'darwin' ? 'file-lock' : 'sqlite-lock');
