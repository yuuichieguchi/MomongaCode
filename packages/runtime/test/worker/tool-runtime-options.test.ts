import { describe, expect, it } from 'vitest';
import { ConfigError } from '@momonga/runtime';
import type { ToolEnv } from '@momonga/runtime';
import type { Session } from '@momonga/store';
import { within } from './deferred.ts';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { seedStartedCalls } from './cancel-fixture.ts';
import { callsStep, textStep } from './scripts.ts';

const policyReturning = (env: Env, policyEnv: () => ToolEnv, seen: Array<{ env: ToolEnv } | undefined>) => async (session: Session, options: { env: ToolEnv }) => {
  seen.push(options);
  return {
    roots: [session.cwd],
    sandboxPolicy: { writableRoots: [session.cwd], writeDenied: [], writeDeniedLiterals: [], readDenied: [], network: 'deny' as const },
    protectedPaths: [],
    tmpDir: env.sessionTmpDir,
    env: policyEnv(),
  };
};

describe('worker tool runtime options', () => {
  it('drive computes env once per claim and passes the same object to toolSet and every policyFor', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.gateway.script.push(
      callsStep([{ callId: 'call_e_1', name: 'Echo', args: { value: 'one' } }]),
      callsStep([{ callId: 'call_e_2', name: 'Echo', args: { value: 'two' } }]),
      textStep('Done.'),
    );
    const run = env.enqueue('Echo twice');

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.portCalls.envFor).toHaveLength(1);
    const computed = env.portCalls.envFor[0]?.env;
    expect(computed).toBeDefined();
    expect(env.portCalls.toolSet).toHaveLength(1);
    expect(env.portCalls.toolSet[0]?.env).toBe(computed);
    expect(env.portCalls.policyFor).toHaveLength(2);
    for (const call of env.portCalls.policyFor) expect(call.env).toBe(computed);
  });

  it('drive passes the claim signal to toolSet and cancel recovery passes its own signal to recoveryToolSet and the batch', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.gateway.script.push(callsStep([{ callId: 'call_e_1', name: 'Echo', args: { value: 'one' } }]), textStep('Done.'));
    env.enqueue('Echo');

    expect(await env.runOnce(env.worker())).toBe('yielded');

    const claimSignal = env.gateway.capabilitiesCalls[0]?.signal;
    expect(claimSignal).toBeInstanceOf(AbortSignal);
    expect(env.portCalls.toolSet.map((call) => call.signal)).toEqual([claimSignal]);
    expect(env.batches[0]?.signal).toBe(claimSignal);

    const cancelled = await makeEnv();
    seedStartedCalls(cancelled, [{ callId: 'call_m_1', name: 'Mark', args: { value: 'one' } }]);

    expect(await cancelled.runOnce(cancelled.worker())).toBe('yielded');

    expect(cancelled.portCalls.toolSet).toEqual([]);
    expect(cancelled.portCalls.recoveryToolSet).toHaveLength(1);
    const recoverySignal = cancelled.portCalls.recoveryToolSet[0]?.signal;
    expect(recoverySignal).toBeInstanceOf(AbortSignal);
    expect(cancelled.batches.map((batch) => batch.signal)).toEqual([recoverySignal]);
  });

  it('tool-step and cancel recovery pass policy.env as BatchInput.env and never read session.env', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.gateway.script.push(callsStep([{ callId: 'call_e_1', name: 'Echo', args: { value: 'one' } }]), textStep('Done.'));
    env.enqueue('Echo');
    const stripped: ToolEnv = { PATH: '/usr/bin:/bin', FROM_ENV_FOR: '1' };
    const policyEnv: ToolEnv = { PATH: '/usr/bin:/bin', FROM_POLICY: '1' };
    const seen: Array<{ env: ToolEnv } | undefined> = [];
    const worker = env.worker('worker-1', {
      tools: { envFor: () => stripped, policyFor: policyReturning(env, () => policyEnv, seen) },
    });

    expect(await env.runOnce(worker)).toBe('yielded');

    expect(seen.map((options) => options?.env)).toEqual([stripped]);
    expect(seen[0]?.env).toBe(stripped);
    expect(env.batches).toHaveLength(1);
    expect(env.batches[0]?.env).toBe(policyEnv);
    expect(env.batches[0]?.env).not.toEqual(env.session.env);

    const cancelled = await makeEnv();
    seedStartedCalls(cancelled, [{ callId: 'call_m_1', name: 'Mark', args: { value: 'one' } }]);
    const recoveryPolicyEnv: ToolEnv = { PATH: '/usr/bin:/bin', FROM_RECOVERY_POLICY: '1' };
    const recoverySeen: Array<{ env: ToolEnv } | undefined> = [];
    const recoveryStripped: ToolEnv = { PATH: '/usr/bin:/bin', FROM_RECOVERY_ENV_FOR: '1' };
    const recoveryWorker = cancelled.worker('worker-1', {
      tools: { envFor: () => recoveryStripped, policyFor: policyReturning(cancelled, () => recoveryPolicyEnv, recoverySeen) },
    });

    expect(await within(cancelled.runOnce(recoveryWorker), 10_000, 'the cancel recovery')).toBe('yielded');

    expect(recoverySeen.map((options) => options?.env)).toEqual([recoveryStripped]);
    expect(cancelled.batches).toHaveLength(1);
    expect(cancelled.batches[0]?.env).toBe(recoveryPolicyEnv);
    expect(cancelled.batches[0]?.rules).toEqual([]);
  });

  it('a ConfigError from envFor fails the run with config_error', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('never sent'));
    const run = env.enqueue('Work');
    const worker = env.worker('worker-1', {
      tools: {
        envFor: () => {
          throw new ConfigError('the user settings are invalid');
        },
      },
    });

    expect(await env.runOnce(worker)).toBe('yielded');

    expect(env.run(run.id)).toMatchObject({ status: 'FAILED', error: { code: 'config_error', message: 'the user settings are invalid' } });
    expect(env.gateway.streams).toEqual([]);
    expect(env.portCalls.toolSet).toEqual([]);
  });
});
