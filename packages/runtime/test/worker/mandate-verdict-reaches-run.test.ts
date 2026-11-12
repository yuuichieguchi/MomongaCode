import { describe, expect, it } from 'vitest';
import { POLICY_REFUTED_CODE } from '@momonga/protocol';
import type { RuleVerdict } from '@momonga/protocol';
import type { MandateRunRequest } from '../../src/process/folder-verification.ts';
import { DEADLINE_MS, createdRun, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const refuted: RuleVerdict = {
  verdict: 'refuted',
  solver: 'z3-fake',
  refuted: [{ property: 'superseded-forms', subject: 'the allow rule Bash(git push:*) of the mandate', message: 'it admits git push' }],
  unknown: [],
  notProved: [],
};

const unknown: RuleVerdict = { verdict: 'unknown', solver: 'z3-fake', refuted: [], unknown: [{ property: 'superseded-forms', reason: 'not decided yet' }], notProved: [] };

const enqueueMandate = async (env: Env) =>
  createdRun(
    await env.store.createRunAndEnqueue(env.session.id, {
      input: 'Echo',
      timeoutMs: DEADLINE_MS - env.clock.now(),
      limits: {},
      pins: {},
      mandate: { scope: { allow: [], ask: [], deny: ['Bash(rm:*)'] } },
    } as never),
  );

describe('a mandate verdict found after creation reaches the run', () => {
  it('a refuted mandate verdict fails the run at its start with policy_refuted, asked with the mandate of the run', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const asked: MandateRunRequest[] = [];
    env.gateway.script.push(textStep('done'));
    const run = await enqueueMandate(env);

    await env.runOnce(
      env.worker('w1', {
        mandateVerification: async (request) => {
          asked.push(request);
          return refuted;
        },
      }),
    );

    expect(env.run(run.id).error).toEqual({ code: POLICY_REFUTED_CODE, message: expect.stringContaining('Bash(git push:*)') });
    expect(asked).toMatchObject([{ cwd: env.session.cwd, mandate: { scope: { deny: ['Bash(rm:*)'] } } }]);
  });

  it('a refutation that arrives while the run works fails it before its next batch', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const answers = [unknown, refuted];
    env.gateway.script.push(callsStep([{ callId: 'call_m_1', name: 'Echo', args: { value: 'one' } }]), textStep('Echoed.'));
    const run = await enqueueMandate(env);

    await env.runOnce(env.worker('w1', { mandateVerification: async () => answers.shift() ?? refuted }));

    expect(env.run(run.id).error).toEqual({ code: POLICY_REFUTED_CODE, message: expect.stringContaining('Bash(git push:*)') });
    expect(env.ofType(run.id, 'tool.started')).toEqual([]);
  });
});
