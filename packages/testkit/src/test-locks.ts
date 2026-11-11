import fs from 'node:fs';
import path from 'node:path';
import { kernelLockNamed, layoutProcessInspector, resolveLayoutLocks } from '@momonga/foundation';
import type { KernelLockMechanism, LayoutLocks, LockCapability, LockCapabilityProbe, ProcessInspector } from '@momonga/foundation';

export const LOCK_PROOF_PREFIX = 'momonga-test-lock-proof-';

export const LOCK_PROOF_ENV = 'MOMONGA_TEST_LOCK_PROOF';

let resolved: LayoutLocks | undefined;
let inspector: ProcessInspector | undefined;

const proveInRunFolder = (): LayoutLocks => {
  const runFolder = process.env[LOCK_PROOF_ENV];
  if (runFolder === undefined || runFolder === '') throw new Error(`${LOCK_PROOF_ENV} is not set; run through a vitest project with the lock-proof global setup`);
  const proofDir = path.join(runFolder, String(process.pid));
  fs.mkdirSync(proofDir, { recursive: true, mode: 0o700 });
  return resolveLayoutLocks({ callLocks: proofDir, lockProof: proofDir });
};

export const testLocks = (): LayoutLocks => (resolved ??= proveInRunFolder());

export const testKernelLock = (): KernelLockMechanism => testLocks().mechanism;

export const testProcessInspector = (): ProcessInspector => (inspector ??= layoutProcessInspector(testLocks().capability));

export const fixedLockCapability = (answer: LockCapability): LockCapabilityProbe => ({
  of: async () => answer,
  decide: () => (answer === 'unmeasured' ? 'unprovable' : answer),
  contradicted: () => undefined,
});

export const expectedKernelLockOn = (platform: NodeJS.Platform): KernelLockMechanism => kernelLockNamed(platform === 'darwin' ? 'file-lock' : 'sqlite-lock');
