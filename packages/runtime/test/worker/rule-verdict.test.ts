import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { POLICY_REFUTED_CODE, policyRefutedMessage } from '@momonga/protocol';
import type { RuleVerdict } from '@momonga/protocol';
import { ruleFingerprint } from '../../src/worker/rule-verdict.ts';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
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
  verdict: 'refuted',
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

const verdictEvents = (env: Env, runId: string) => env.ofType(runId, 'notice').filter((notice) => notice.code === 'policy_verdict');

describe('the verdict of the permission rules before a run', () => {
  it('a refuted rule set ends the run FAILED with policy_refuted, naming the property and the counterexample, before any model request', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.ruleVerifier.answer = () => refuted;
    env.gateway.script.push(textStep('Hello.'));
    const run = await env.enqueue('Say hello');

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
    const run = await env.enqueue('Say hello');

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'FAILED', error: { code: POLICY_REFUTED_CODE } });
    expect(env.ofType(run.id, 'model.requested')).toEqual([]);
  });

  it('a verdict whose findings are about rule consistency, deny precedence or Bash admission refuses nothing: the run reaches the model', async () => {
    const env = await makeEnv();
    env.ruleVerifier.answer = () => refutedWithoutRefusal;
    env.gateway.script.push(textStep('Hello.'));
    const run = await env.enqueue('Say hello');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'model.requested')).toHaveLength(1);
  });

  it('a proved rule set starts the run, and run.started pins the verdict with its fingerprint and what is not proved', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('Hello.'));
    const run = await env.enqueue('Say hello');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'run.started')[0]?.pins['policyVerdict']).toEqual({ fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), ...proved });
    expect(env.ruleVerifier.verified).toHaveLength(1);
  });

  it('a second run with the same input reads the stored verdict and does not call the verifier', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('One.'), textStep('Two.'));
    const first = await env.enqueue('Say one');
    await env.runOnce(env.worker('worker-1'));
    const second = await env.enqueue('Say two');

    await env.runOnce(env.worker('worker-2'));

    expect(env.run(second.id).status).toBe('COMPLETED');
    expect(env.ruleVerifier.verified).toHaveLength(1);
    expect(env.ofType(second.id, 'run.started')[0]?.pins['policyVerdict']).toEqual(env.ofType(first.id, 'run.started')[0]?.pins['policyVerdict']);
  });

  it('a verdict of unknown proceeds and is reported in the pins with its reason', async () => {
    const env = await makeEnv();
    env.ruleVerifier.answer = () => unknown;
    env.gateway.script.push(textStep('Hello.'));
    const run = await env.enqueue('Say hello');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'run.started')[0]?.pins['policyVerdict']).toMatchObject({ verdict: 'unknown', unknown: [{ property: 'bash-admission', reason: 'the verification budget of 60000 ms was spent' }] });
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
    const run = await env.enqueue('Say hello');
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
    const run = await env.enqueue('Echo');
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

  it('a changed rule set that proves clean lets the batch run, with one notice of its verdict, and an unchanged one writes no notice', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.gateway.script.push(callsStep([{ callId: 'call_e_1', name: 'Echo', args: { value: 'one' } }]), callsStep([{ callId: 'call_e_2', name: 'Echo', args: { value: 'two' } }]), textStep('Echoed.'));
    const run = await env.enqueue('Echo');
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

describe('the fingerprint of a rule set', () => {
  const base = { input: { rules: [{ text: 'Read(.env)', effect: 'deny' }], roots: ['/work'], mode: 'manual', home: '/home/u', cwd: '/work', enforcement: 'exact-paths', protectedSet: { paths: ['/work/.git'] }, secretLocations: ['/home/u/.ssh'] }, solverVersion: SOLVER };

  it('is the same for the same input whatever the key order', () => {
    const reordered = { solverVersion: SOLVER, input: Object.fromEntries(Object.entries(base.input).reverse()) };
    expect(ruleFingerprint(reordered)).toBe(ruleFingerprint(base));
  });

  it.each(Object.keys(base.input).map((field) => [field] as const))('changes when %s changes', (field) => {
    for (const suffix of ['x', ' ', '/more']) {
      const changed = { ...base, input: { ...base.input, [field]: `${JSON.stringify(base.input[field as keyof typeof base.input])}${suffix}` } };
      expect(ruleFingerprint(changed)).not.toBe(ruleFingerprint(base));
    }
  });

  it('changes when the solver version changes', () => {
    expect(ruleFingerprint({ ...base, solverVersion: 'fake-solver 2' })).not.toBe(ruleFingerprint(base));
  });
});

describe('the rules of a run under a mandate', () => {
  const mandate = (env: Env) => ({ scope: { allow: ['Bash(ls:*)'], ask: [`Write(/${path.join(env.project, 'out.txt')})`], deny: ['Bash(rm:*)'] } });

  it('are verified once, at the start, with the scope rules of the mandate, and the first batch neither verifies again nor writes a notice that they changed', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([{ callId: 'call_l', name: 'Bash', args: { command: 'ls' } }]), textStep('Listed.'));
    const run = await env.enqueue('List the files', { mandate: mandate(env) });

    await env.runOnce(env.worker());

    expect(env.ofType(run.id, 'tool.completed')).toEqual([expect.objectContaining({ status: 'completed' })]);
    expect(env.ruleVerifier.verified).toHaveLength(1);
    const [request] = env.ruleVerifier.requests;
    expect(request?.rules.map((rule) => rule.text)).toEqual(expect.arrayContaining(['Bash(ls:*)', 'Bash(rm:*)']));
    expect(new Set(env.ruleVerifier.requests.map((asked) => JSON.stringify(asked.rules.map((rule) => rule.text))))).toEqual(new Set([JSON.stringify(request?.rules.map((rule) => rule.text))]));
    expect(verdictEvents(env, run.id)).toEqual([]);
  });
});

