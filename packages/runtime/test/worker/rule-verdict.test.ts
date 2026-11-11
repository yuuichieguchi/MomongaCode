import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { POLICY_REFUTED_CODE, policyRefutedMessage } from '@momonga/protocol';
import type { RuleVerdict } from '@momonga/protocol';
import { makeEnv as makeBareEnv } from './harness.ts';
import type { Env, EnvOptions } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const SOLVER = 'fake-solver 1';
const NOT_PROVED = ['What an arbitrary shell command does when it runs.'];
const proved: RuleVerdict = { verdict: 'proved', solver: SOLVER, refuted: [], unknown: [], notProved: NOT_PROVED };
const refuted: RuleVerdict = {
  verdict: 'refuted',
  solver: SOLVER,
  refuted: [
    { property: 'secret-reach', subject: 'Read', message: 'an allow rule opens a secret location', counterexample: 'Read /work/.env' },
    { property: 'bash-admission', subject: 'Bash', message: 'an allow rule admits a denied subcommand' },
  ],
  unknown: [],
  notProved: NOT_PROVED,
};
const refutedWithoutRefusal: RuleVerdict = {
  verdict: 'proved',
  solver: SOLVER,
  refuted: [
    { property: 'rule-consistency', subject: 'Write', message: 'this rule can never take effect' },
    { property: 'deny-precedence', subject: 'Read', message: 'an allow rule lets a denied path through' },
    { property: 'bash-admission', subject: 'Bash', message: 'an allow rule admits a denied subcommand' },
  ],
  unknown: [],
  notProved: NOT_PROVED,
};
const unknown: RuleVerdict = { verdict: 'unknown', solver: SOLVER, refuted: [], unknown: [{ property: 'bash-admission', reason: 'the verification budget of 60000 ms was spent' }], notProved: NOT_PROVED };

const failed: RuleVerdict = { verdict: 'failed', solver: SOLVER, refuted: [], unknown: [{ property: 'secret-reach', reason: 'the model and the decision code disagree on Read /work/a' }], notProved: NOT_PROVED };
const storedVerdicts = (env: Env, runId: string) => {
  const pinned = env.ofType(runId, 'run.started')[0]?.pins['policyVerdict'] as { fingerprint: string };
  return env.store.ruleVerdicts.get(pinned.fingerprint);
};

const makeEnv = async (options?: EnvOptions): Promise<Env> => {
  const env = await makeBareEnv(options);
  env.settings.extraRules.push({ effect: 'allow', rule: 'Read(src/**)' });
  return env;
};

const verdictEvents = (env: Env, runId: string) => env.ofType(runId, 'notice').filter((notice) => notice.code === 'policy_verdict');

describe('the verdict of the permission rules before a run', () => {
  it('a refuted rule set ends the run FAILED with policy_refuted, naming the property and the counterexample, before any model request', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.ruleVerifier.answer = () => refuted;
    env.gateway.script.push(textStep('Hello.'));
    const run = env.enqueue('Say hello');

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'FAILED', error: { code: POLICY_REFUTED_CODE, message: policyRefutedMessage(refuted) } });
    expect(policyRefutedMessage(refuted)).toBe(
      'The permission rules were refuted, so the run was refused: secret-reach (Read): an allow rule opens a secret location; counterexample: Read /work/.env. Change the rules; "momonga policy verify" prints the full report.',
    );
    expect(env.ofType(run.id, 'model.requested')).toEqual([]);
    expect(env.gateway.script).toHaveLength(1);
  });

  it.each(['secret-reach', 'superseded-forms', 'mandate-holds'])('a refuted %s refuses the run', async (property) => {
    const env = await makeEnv();
    env.ruleVerifier.answer = () => ({ ...refuted, refuted: [{ property, subject: 'a rule', message: 'what the protection forbids' }] });
    env.gateway.script.push(textStep('Hello.'));
    const run = env.enqueue('Say hello');

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'FAILED', error: { code: POLICY_REFUTED_CODE } });
    expect(env.ofType(run.id, 'model.requested')).toEqual([]);
  });

  it('a verdict whose findings are about rule consistency, deny precedence or Bash admission refuses nothing: the run reaches the model', async () => {
    const env = await makeEnv();
    env.ruleVerifier.answer = () => refutedWithoutRefusal;
    env.gateway.script.push(textStep('Hello.'));
    const run = env.enqueue('Say hello');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'model.requested')).toHaveLength(1);
  });

  it('a proved rule set starts the run, and run.started pins the verdict with its fingerprint and what is not proved', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('Hello.'));
    const run = env.enqueue('Say hello');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'run.started')[0]?.pins['policyVerdict']).toEqual({ fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), ...proved });
    expect(env.ruleVerifier.verified).toHaveLength(1);
  });

  it('a rule set with no allow rule starts no verification: the run reaches the model at once and its pinned verdict says none was needed', async () => {
    const env = await makeBareEnv();
    env.settings.extraRules.push({ effect: 'deny', rule: 'Read(.env)' }, { effect: 'ask', rule: 'Write' });
    env.ruleVerifier.answer = () => new Promise<RuleVerdict>(() => undefined);
    env.gateway.script.push(textStep('Hello.'));
    const run = env.enqueue('Say hello');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ruleVerifier.verified).toEqual([]);
    expect(env.ofType(run.id, 'run.started')[0]?.pins['policyVerdict']).toEqual({ fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), verdict: 'not-needed', solver: SOLVER, refuted: [], unknown: [], notProved: [] });
    expect(storedVerdicts(env, run.id)).toBeUndefined();
  });

  it('a rule set with an allow rule waits for its verdict before the first model request', async () => {
    const env = await makeEnv();
    const answered = Promise.withResolvers<RuleVerdict>();
    const asked = Promise.withResolvers<void>();
    env.ruleVerifier.answer = () => {
      asked.resolve();
      return answered.promise;
    };
    env.gateway.script.push(textStep('Hello.'));
    const run = env.enqueue('Say hello');
    const running = env.runOnce(env.worker());
    await asked.promise;
    expect(env.ofType(run.id, 'model.requested')).toEqual([]);

    answered.resolve(proved);
    await running;

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'model.requested')).toHaveLength(1);
  });

  it('a rule set that loses its last allow rule during the run is noticed once as needing no verdict, at level info', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.gateway.script.push(callsStep([{ callId: 'call_e_1', name: 'Echo', args: { value: 'one' } }]), textStep('Echoed.'));
    const run = env.enqueue('Echo');
    env.settings.rulesHook = async (read) => {
      if (read === 2) env.settings.extraRules.splice(0);
    };

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(verdictEvents(env, run.id).map((notice) => notice.level)).toEqual(['info']);
    expect(env.ruleVerifier.verified).toHaveLength(1);
  });

  it('the verified subject names the scratch folder the session exempts from the file rules, so the proof models what the run does', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('Hello.'));
    env.enqueue('Say hello');

    await env.runOnce(env.worker());

    expect(env.ruleVerifier.requests[0]?.exemptDirectory).toBe(env.sessionTmpDir);
  });

  it('a second run with the same input reads the stored verdict and does not call the verifier', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('One.'), textStep('Two.'));
    const first = env.enqueue('Say one');
    await env.runOnce(env.worker('worker-1'));
    const second = env.enqueue('Say two');

    await env.runOnce(env.worker('worker-2'));

    expect(env.run(second.id).status).toBe('COMPLETED');
    expect(env.ruleVerifier.verified).toHaveLength(1);
    expect(env.ofType(second.id, 'run.started')[0]?.pins['policyVerdict']).toEqual(env.ofType(first.id, 'run.started')[0]?.pins['policyVerdict']);
  });

  it('a verdict of unknown proceeds and is reported in the pins with its reason', async () => {
    const env = await makeEnv();
    env.ruleVerifier.answer = () => unknown;
    env.gateway.script.push(textStep('Hello.'));
    const run = env.enqueue('Say hello');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'run.started')[0]?.pins['policyVerdict']).toMatchObject({ verdict: 'unknown', unknown: [{ property: 'bash-admission', reason: 'the verification budget of 60000 ms was spent' }] });
  });

  it('an unknown verdict is not stored: the next run starts at once with it while the rules are verified again behind it, and the answer found there is stored for the run after', async () => {
    const env = await makeEnv();
    const retried = Promise.withResolvers<RuleVerdict>();
    const answers: Array<RuleVerdict | Promise<RuleVerdict>> = [unknown, retried.promise];
    env.ruleVerifier.answer = () => answers.shift() ?? proved;
    env.gateway.script.push(textStep('One.'), textStep('Two.'), textStep('Three.'));
    const first = env.enqueue('Say one');
    await env.runOnce(env.worker('worker-1'));
    expect(storedVerdicts(env, first.id)).toBeUndefined();

    const second = env.enqueue('Say two');
    await env.runOnce(env.worker('worker-2'));

    expect(env.run(second.id).status).toBe('COMPLETED');
    expect(env.ofType(second.id, 'run.started')[0]?.pins['policyVerdict']).toMatchObject({ verdict: 'unknown' });
    expect(env.ruleVerifier.verified).toHaveLength(2);
    expect(storedVerdicts(env, second.id)).toBeUndefined();

    retried.resolve(proved);
    await vi.waitFor(() => expect(storedVerdicts(env, second.id)?.verdict).toEqual(proved));
    const third = env.enqueue('Say three');
    await env.runOnce(env.worker('worker-3'));
    expect(env.ofType(third.id, 'run.started')[0]?.pins['policyVerdict']).toMatchObject({ verdict: 'proved' });
    expect(env.ruleVerifier.verified).toHaveLength(2);
  });

  it('one verification at a time is behind a rule set: a run that starts while the retry is in flight starts no second one', async () => {
    const env = await makeEnv();
    const retried = Promise.withResolvers<RuleVerdict>();
    const answers: Array<RuleVerdict | Promise<RuleVerdict>> = [unknown, retried.promise];
    env.ruleVerifier.answer = () => answers.shift() ?? proved;
    env.gateway.script.push(textStep('One.'), textStep('Two.'), textStep('Three.'));
    for (const [index, prompt] of ['Say one', 'Say two', 'Say three'].entries()) {
      env.enqueue(prompt);
      await env.runOnce(env.worker(`worker-${index}`));
    }
    expect(env.ruleVerifier.verified).toHaveLength(2);
    retried.resolve(unknown);
    await env.ruleVerifier.settled();
  });

  it('a verification that failed, because the model and the decision code disagree, refuses nothing and is not stored: the run proceeds as with an unknown verdict', async () => {
    const env = await makeEnv();
    env.ruleVerifier.answer = () => failed;
    env.gateway.script.push(textStep('Hello.'));
    const run = env.enqueue('Say hello');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'run.started')[0]?.pins['policyVerdict']).toMatchObject({ verdict: 'failed', unknown: [{ property: 'secret-reach' }] });
    expect(storedVerdicts(env, run.id)).toBeUndefined();
  });

  it('a worker that stops during the verification loses nothing: the next claim verifies once and starts', async () => {
    const env = await makeEnv();
    let entered = (): void => undefined;
    const verifying = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let first = true;
    env.ruleVerifier.answer = (_input: unknown, signal: AbortSignal) => {
      if (!first) return proved;
      first = false;
      entered();
      return new Promise<RuleVerdict>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    };
    env.gateway.script.push(textStep('Hello.'));
    const run = env.enqueue('Say hello');
    const stopped = env.worker('worker-1');
    const running = env.runOnce(stopped);
    await verifying;
    await stopped.abort('shutdown');
    await running;
    expect(env.ofType(run.id, 'model.requested')).toEqual([]);
    expect(env.run(run.id).status).toBe('QUEUED');

    await env.runOnce(env.worker('worker-2'));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ruleVerifier.verified).toHaveLength(2);
  });

  it('a rule set that changes during the run is verified again before the next batch: refuted executes no call and fails the run; the journal holds the new verdict', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.ruleVerifier.answer = (input: unknown) => (JSON.stringify(input).includes('.env') ? refuted : proved);
    env.gateway.script.push(callsStep([{ callId: 'call_e_1', name: 'Echo', args: { value: 'one' } }]), textStep('Echoed.'));
    const run = env.enqueue('Echo');
    env.settings.rulesHook = async (read) => {
      if (read === 2 && !env.settings.extraRules.some((entry) => entry.rule === 'Read(.env)')) env.settings.extraRules.push({ effect: 'allow', rule: 'Read(.env)' });
    };

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'FAILED', error: { code: POLICY_REFUTED_CODE } });
    expect(env.toolbox.executions).toEqual([]);
    expect(env.ofType(run.id, 'tool.started')).toEqual([]);
    const started = env.ofType(run.id, 'run.started')[0]?.pins['policyVerdict'] as { fingerprint: string };
    const [notice] = verdictEvents(env, run.id);
    expect(notice?.level).toBe('error');
    expect(notice?.message).toContain('secret-reach');
    expect(notice?.message).not.toContain(started.fingerprint);
  });

  it.each([
    ['a finding that refuses no run', refutedWithoutRefusal],
    ['an unknown verdict', unknown],
    ['a failed verification', failed],
  ])('a changed rule set with %s lets the batch run and is noticed as a warning, never as an error', async (_name, verdict) => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.ruleVerifier.answer = (input: unknown) => (JSON.stringify(input).includes('secret.txt') ? verdict : proved);
    env.gateway.script.push(callsStep([{ callId: 'call_e_1', name: 'Echo', args: { value: 'one' } }]), textStep('Echoed.'));
    const run = env.enqueue('Echo');
    env.settings.rulesHook = async (read) => {
      if (read === 2) env.settings.extraRules.push({ effect: 'deny', rule: `Read(${path.join(env.project, 'secret.txt')})` });
    };

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(verdictEvents(env, run.id).map((notice) => notice.level)).toEqual(['warning']);
  });

  it('a changed rule set that proves clean lets the batch run, with one notice of its verdict, and an unchanged one writes no notice', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.gateway.script.push(callsStep([{ callId: 'call_e_1', name: 'Echo', args: { value: 'one' } }]), callsStep([{ callId: 'call_e_2', name: 'Echo', args: { value: 'two' } }]), textStep('Echoed.'));
    const run = env.enqueue('Echo');
    env.settings.rulesHook = async (read) => {
      if (read === 2) env.settings.extraRules.push({ effect: 'deny', rule: `Read(${path.join(env.project, 'secret.txt')})` });
    };

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'tool.completed')).toHaveLength(2);
    expect(verdictEvents(env, run.id)).toHaveLength(1);
    expect(verdictEvents(env, run.id)[0]).toMatchObject({ level: 'info' });
    expect(env.ruleVerifier.verified).toHaveLength(2);
  });
});
