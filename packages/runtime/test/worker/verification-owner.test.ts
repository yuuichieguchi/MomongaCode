import { describe, expect, it } from 'vitest';
import { deferred } from './deferred.ts';
import { FAKE_PROVED, createFakeRuleVerifier } from './fake-rule-verifier.ts';
import { makeEnv } from './harness.ts';

describe('the rule verification belongs to the daemon, not to the run that asked for it', () => {
  it('a cancel of the run does not stop the verification the run waits for', async () => {
    const ruleVerifier = createFakeRuleVerifier();
    const env = await makeEnv({ ruleVerifier });
    env.settings.extraRules.push({ effect: 'allow', rule: 'Read(src/**)' });
    const asked = deferred<void>();
    const answered = deferred<typeof FAKE_PROVED>();
    const signals: AbortSignal[] = [];
    ruleVerifier.answer = (_input, signal) => {
      signals.push(signal);
      asked.resolve();
      return answered.promise;
    };
    const run = await env.enqueue('Say hello');
    const running = env.runOnce(env.worker('worker-1', { cancelPollMs: 10 }));
    await env.settled(asked.promise, 'the verifier to be asked');

    await env.store.requestCancel(run.id);
    await env.passTime(() => env.run(run.id).status === 'CANCELLING', 'the cancel to be recorded');
    await env.settled(running, 'the cancelled worker to finish');

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    answered.resolve(FAKE_PROVED);
  });
});
