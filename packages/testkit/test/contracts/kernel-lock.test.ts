import { describe } from 'vitest';
import { kernelLockNamed, sqliteFileLock } from '@momonga/foundation';
import { createFakeKernelLock } from '../../src/index.ts';
import { kernelLockContract } from './kernel-lock.contract.ts';

const BSD_LOCK_ONLY_ON_MACOS = 'the BSD open flags of the file lock exist on macOS only';

describe.skipIf(process.platform !== 'darwin')(`the contract of the kernel lock: the file lock of the product (skipped elsewhere: ${BSD_LOCK_ONLY_ON_MACOS})`, () => kernelLockContract(() => kernelLockNamed('file-lock')));

describe('the contract of the kernel lock: the sqlite lock of the product', () => kernelLockContract(() => sqliteFileLock));

describe('the contract of the kernel lock: the fake that hands over', () => kernelLockContract(() => createFakeKernelLock({ inheritable: true })));

describe('the contract of the kernel lock: the fake that does not hand over', () => kernelLockContract(() => createFakeKernelLock({ inheritable: false })));
