import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_PROTECTED_SET, ruleEnforcementOf } from '@momonga/foundation';
import type { PermissionRule } from '@momonga/config';
import { computeFileRules } from '@momonga/policy';
import type { ToolEnv } from '@momonga/runtime';
import type { SandboxPolicy } from '@momonga/sandbox';
import type { Session } from '@momonga/store';
import { makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';
import { testProbes } from '@momonga/testkit';

describe('tool step rules', () => {
  it('passes the same rules array to policyFor and to runBatch', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.settings.extraRules.push({ effect: 'deny', rule: 'Read(.env)' });
    env.gateway.script.push(callsStep([{ callId: 'call_e_1', name: 'Echo', args: { value: 'one' } }]), textStep('Echoed.'));
    const given: Array<readonly PermissionRule[] | undefined> = [];
    const worker = env.worker('worker-1', {
      tools: {
        policyFor: async (session: Session, options: { env: ToolEnv; rules?: readonly PermissionRule[] }) => {
          given.push(options.rules);
          const roots = [session.cwd];
          const sandboxPolicy = {
            writableRoots: [session.cwd],
            writeDenied: [path.dirname(env.sessionTmpDir)],
            protectedSet: EMPTY_PROTECTED_SET, writeDeniedLiterals: [],
            readDenied: [path.dirname(env.sessionTmpDir)],
            readAllowed: [env.sessionTmpDir],
            network: 'deny',
            fileRules: await computeFileRules(options.rules ?? [], roots, env.sessionTmpDir, ruleEnforcementOf('none'), testProbes()),
          } as SandboxPolicy;
          return { roots, sandboxPolicy, tmpDir: env.sessionTmpDir, env: options.env };
        },
      },
    });
    const run = env.enqueue('Echo');

    expect(await env.runOnce(worker)).toBe('yielded');

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(given).toHaveLength(2);
    expect(env.batches).toHaveLength(1);
    expect(given[1]).toBe(env.batches[0]?.rules);
    expect(env.batches[0]?.rules.map((rule) => rule.text)).toEqual(['Read(.env)']);
  });
});
