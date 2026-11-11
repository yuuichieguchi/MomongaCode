import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { deferred } from './deferred.ts';
import { LEASE_MS, makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

vi.setConfig({ testTimeout: SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS, hookTimeout: SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS });

describe('worker allow_always rule persistence across a crash', () => {
  it('appends the rule, the persisted event and the notice exactly once', async () => {
    const env = await makeEnv();
    const target = path.join(env.project, 'out.txt');
    const rule = `Write(/${target})`;
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'approved' } }]));
    const run = await env.enqueue('Write the file');
    await env.runOnce(env.worker('worker-1'));
    await env.resolveApproval(run.id, 'allow_always');
    const approvalId = env.ofType(run.id, 'tool.permission.requested')[0]?.approvalId;
    const gate = deferred<void>();
    const reached = deferred<void>();
    let parked = false;
    env.settings.rulesHook = async () => {
      if (parked || env.settings.appended.length === 0) return;
      parked = true;
      reached.resolve();
      await gate.promise;
    };

    const crashed = env.runOnce(env.worker('worker-2'));
    await env.settled(reached.promise, 'worker-2 to read the rules after persisting the rule');
    env.clock.advance(LEASE_MS + 1);
    env.gateway.script.push(textStep('Written.'));
    await env.runOnce(env.worker('worker-3'));
    gate.resolve();
    await env.settled(crashed, 'worker-2 to stop after losing its lease');

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(fs.readFileSync(target, 'utf8')).toBe('approved');
    expect(env.settings.appended).toEqual([{ sessionId: env.session.id, effect: 'allow', rule }]);
    const persisted = env.events(run.id).filter((event) => (event.type as string) === 'approval.rule.persisted');
    expect(persisted).toEqual([expect.objectContaining({ approvalId, effect: 'allow', rule })]);
    expect(env.ofType(run.id, 'notice').filter((notice) => notice.message.includes(`Saved the allow rule ${rule}`))).toHaveLength(1);
    expect(env.fold(run.id).pendingCalls[env.gateway.callId('call_w_1')]?.resolution).toMatchObject({ kind: 'allow_always', rulePersisted: true });
  });
});
