import fs from 'node:fs';
import path from 'node:path';
import { kernelLockNamed, layoutProcessInspector, resolveLayoutLocks } from '@momonga/foundation';
import type { ClaimOutcome, KernelLockMechanism, LayoutLocks, LockCapability, LockCapabilityProbe, ProcessInspector } from '@momonga/foundation';

export const LOCK_PROOF_PREFIX = 'momonga-test-lock-proof-';

export const LOCK_PROOF_ENV = 'MOMONGA_TEST_LOCK_PROOF';

let resolved: LayoutLocks | undefined;
let inspector: ProcessInspector | undefined;

export const lockProofFolder = (): string => {
  const runFolder = process.env[LOCK_PROOF_ENV];
  if (runFolder === undefined || runFolder === '') throw new Error(`${LOCK_PROOF_ENV} is not set; run through a vitest project with the lock-proof global setup`);
  return runFolder;
};

const proveInRunFolder = (): LayoutLocks => {
  const runFolder = lockProofFolder();
  const proofDir = path.join(runFolder, String(process.pid));
  fs.mkdirSync(proofDir, { recursive: true, mode: 0o700 });
  return resolveLayoutLocks({ callLocks: proofDir, lockProof: proofDir });
};

export const testLocks = (): LayoutLocks => (resolved ??= proveInRunFolder());

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
