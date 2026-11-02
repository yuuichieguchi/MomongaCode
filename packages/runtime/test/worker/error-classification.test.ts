import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { SandboxPolicyError, buildSeatbeltProfile } from '@momonga/sandbox';
import type { SandboxPolicy } from '@momonga/sandbox';
import { EarlierAttemptNotStoppedError } from '@momonga/tools';
import { dispositionOf } from '../../src/worker/gateway-policy.ts';

const policyErrorFromProfile = (): unknown => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cls-')));
  try {
    buildSeatbeltProfile({ writableRoots: [dir], writeDenied: [], protectedSet: EMPTY_PROTECTED_SET, writeDeniedLiterals: [], readDenied: [], readAllowed: [dir], network: 'deny', fileRules: EMPTY_FILE_RULES } as SandboxPolicy);
  } catch (error) {
    return error;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  throw new Error('expected buildSeatbeltProfile to throw');
};

describe('dispositionOf an EarlierAttemptNotStoppedError', () => {
  it.each(['lock_held', 'survived', 'unverifiable'] as const)('fails the run with its code and never requeues (%s)', (reason) => {
    const error = new EarlierAttemptNotStoppedError(`call k: ${reason}`, reason);
    expect(dispositionOf(error, 0)).toEqual({ kind: 'fail', code: 'earlier_attempt_not_stopped', message: `call k: ${reason}` });
  });
});

describe('dispositionOf a SandboxPolicyError', () => {
  it('fails the run with sandbox_policy_error and never requeues', () => {
    const error = policyErrorFromProfile();
    expect(error).toBeInstanceOf(SandboxPolicyError);
    expect(dispositionOf(error, 0)).toEqual({ kind: 'fail', code: 'sandbox_policy_error', message: (error as Error).message });
  });
});
