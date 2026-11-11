import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kernelLockNamed, layoutProcessInspector, resolveLayoutLocks } from '@momonga/foundation';
import type { KernelLockMechanism, LayoutLocks, LockCapability, LockCapabilityProbe, ProcessInspector } from '@momonga/foundation';

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

export const testProcessInspector = (): ProcessInspector => (inspector ??= layoutProcessInspector(testLocks().capability));

export const fixedLockCapability = (answer: LockCapability): LockCapabilityProbe => ({
  of: async () => answer,
  decide: () => (answer === 'unmeasured' ? 'unprovable' : answer),
  contradicted: () => undefined,
});

export const expectedKernelLockOn = (platform: NodeJS.Platform): KernelLockMechanism => kernelLockNamed(platform === 'darwin' ? 'file-lock' : 'sqlite-lock');
