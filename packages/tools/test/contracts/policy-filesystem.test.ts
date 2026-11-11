import { describe } from 'vitest';
import { NEVER_CANCELLED, UndeclaredGlobError, fakePolicyFilesystem, hostFilesystemOf } from '@momonga/testkit';
import { createPolicyFilesystem } from '@momonga/tools';
import { policyFilesystemContract } from './policy-filesystem.contract.ts';

const GLOB_WAIT_MS = 60_000;
const OPEN_DEADLINE = { remainingMs: () => GLOB_WAIT_MS };

describe('the contract of the policy file system: the host file system of the product', () =>
  policyFilesystemContract(() => {
    const host = createPolicyFilesystem();
    return {
      resolveProgram: async (name, cwd, searchPath, isWritable) => host.resolveProgram(name, cwd, searchPath, isWritable, NEVER_CANCELLED),
      expandGlob: async (pattern, cwd, limit) => host.expandGlob(pattern, cwd, limit, OPEN_DEADLINE, NEVER_CANCELLED),
    };
  }, { kind: 'expanded' }));

describe('the contract of the policy file system: the fake', () =>
  policyFilesystemContract(({ held }) => {
    const fake = hostFilesystemOf(fakePolicyFilesystem({ heldPrograms: held, programs: {} }));
    return {
      resolveProgram: async (name, cwd, searchPath, isWritable) => fake.resolveProgram(name, cwd, searchPath, isWritable),
      expandGlob: async (pattern, cwd, limit) => fake.expandGlob(pattern, cwd, limit, OPEN_DEADLINE),
    };
  }, { kind: 'refused', error: UndeclaredGlobError }));

