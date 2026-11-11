import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as protocol from '@momonga/protocol';
import type { HooksSettings } from '@momonga/protocol';
import { createUnsandboxed } from '@momonga/sandbox';
import { fixedSandboxBindings } from '@momonga/runtime';
import type { Sandbox, SandboxPolicy } from '@momonga/sandbox';
import type { Run } from '@momonga/store';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { createRequestValidator } from '../../../gateway/src/core/validation.ts';
import { DEADLINE_MS, createdRun, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

type Condition = { id?: string; command: string; timeoutMs?: number; when?: 'always' | 'after_mutation' };

type Completion = { conditions?: Condition[]; requirements?: string[]; inherit?: boolean };

type VerificationCompleted = { seq: number; round: number; conditionId: string; outcome: string; exitCode?: number; mutationSeq: number; output: string };

type VerificationStarted = { seq: number; round: number; conditionId: string; mutationSeq: number; attempt: number };

type PinnedCondition = { id: string; command: string; when: string; source: string; timeoutMs?: number };

const feedbackPrefix = (): string => {
  const found = (protocol as Record<string, unknown>)['VERIFICATION_FEEDBACK_PREFIX'];
  if (typeof found !== 'string') throw new Error('@momonga/protocol does not export VERIFICATION_FEEDBACK_PREFIX');
  return found;
};

const spawned: { argv: readonly string[]; policy: SandboxPolicy }[] = [];

const recordingSandbox = (): Sandbox => {
  const inner = createUnsandboxed({ killGraceMs: 200 });
  return {
    ...inner,
    kind: 'seatbelt',
    spawn: (spec, policy, signal, descriptors) => {
      spawned.push({ argv: spec.argv, policy });
      return inner.spawn(spec, policy, signal, descriptors);
    },
  };
};

const workerOf = (env: Env) => env.worker('worker-1', { tools: { sandboxes: fixedSandboxBindings(recordingSandbox()) } });

const enqueueWith = (env: Env, input: string, completion: Completion | undefined): Run =>
  createdRun(
    env.store.createRunAndEnqueue(env.session.id, {
      input,
      timeoutMs: DEADLINE_MS - env.clock.now(),
      limits: {},
      pins: {},
      ...(completion === undefined ? {} : { mandate: { completion } }),
    } as never),
  );

const standing = (env: Env, conditions: string[], required = false): void => {
  env.settings.verificationValue = { ...env.settings.verificationValue, conditions, required } as never;
};

const completions = (env: Env, runId: string): VerificationCompleted[] => env.ofType(runId, 'verification.completed' as never) as unknown as VerificationCompleted[];

const starts = (env: Env, runId: string): VerificationStarted[] => env.ofType(runId, 'verification.started' as never) as unknown as VerificationStarted[];

const feedback = (env: Env, runId: string): string[] =>
  env
    .ofType(runId, 'user.message')
    .map((event) => event.text)
    .filter((text) => text.startsWith(feedbackPrefix()));

const pinnedConditions = (env: Env, runId: string): PinnedCondition[] => {
  const started = env.ofType(runId, 'run.started')[0];
  const mandate = started?.pins['mandate'] as { completion?: { conditions?: PinnedCondition[] } } | undefined;
  return mandate?.completion?.conditions ?? [];
};

const write = (callId: string, file: string, content = 'x') => callsStep([{ callId, name: 'Write', args: { file_path: file, content } }]);

const stopHook = (command: string): HooksSettings => ({ Stop: [{ hooks: [{ type: 'command', command }] }] });

describe('verifiable completion in the worker', () => {
  it('does not complete when a declared condition fails, tells the model, and stops with conditions_unmet when it stops again without a change', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const command = 'echo "2 tests failed" >&2; exit 1';
    env.gateway.script.push(textStep('All done.'), textStep('Really done.'));
    const run = enqueueWith(env, 'make the tests pass', { conditions: [{ command }] });

    await env.runOnce(workerOf(env));

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'conditions_unmet' });
    expect(completions(env, run.id)).toMatchObject([{ round: 1, outcome: 'failed', exitCode: 1 }]);
    expect(env.gateway.streams).toHaveLength(2);
    const [message] = feedback(env, run.id);
    expect(feedback(env, run.id)).toHaveLength(1);
    expect(message).toContain(command);
    expect(message).toContain('2 tests failed');
    expect(message).toMatch(/exit(ed)?( with)?( code)? 1/);
    expect(JSON.stringify(env.gateway.streams[1]?.body.input)).toContain('2 tests failed');
  });

  it('counts the output of a check under a call id that the request validation of the gateway accepts, whatever the length of the condition id', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.gateway.script.push(textStep('All done.'), textStep('Really done.'));
    const run = enqueueWith(env, 'make the tests pass', { conditions: [{ id: `check-${'long-'.repeat(40)}id`, command: 'echo "2 tests failed" >&2; exit 1' }] });

    await env.runOnce(workerOf(env));

    expect(completions(env, run.id)).toMatchObject([{ round: 1, outcome: 'failed', exitCode: 1 }]);
    const validator = createRequestValidator();
    const checkCounts = env.gateway.counts.filter((request) => JSON.stringify(request.input).includes('2 tests failed') && JSON.stringify(request.input).includes('function_call_output'));
    expect(checkCounts.length).toBeGreaterThan(0);
    for (const request of env.gateway.counts) expect(() => validator.parseCountTokens(structuredClone(request))).not.toThrow();
    for (const body of env.gateway.streams.map((stream) => stream.body)) expect(() => validator.parseCreate(structuredClone(body))).not.toThrow();
  });

  it('does not accept a command the model ran itself as evidence, even when it equals the condition and succeeded', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const command = 'test -f done.txt';
    env.gateway.script.push(callsStep([{ callId: 'call_b_1', name: 'Bash', args: { command } }]), textStep('Verified, it passes.'), textStep('It passes.'));
    const run = enqueueWith(env, 'make done.txt exist', { conditions: [{ command }] });

    await env.runOnce(workerOf(env));

    expect(env.run(run.id).status).not.toBe('COMPLETED');
    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'conditions_unmet' });
    expect(completions(env, run.id).filter((event) => event.outcome === 'passed')).toEqual([]);
  });

  it('runs the conditions again after the model fixes the workspace, and completes only when they pass', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.gateway.script.push(textStep('Done.'), write('call_w_1', path.join(env.project, 'done.txt')), textStep('Fixed.'));
    const run = enqueueWith(env, 'create done.txt', { conditions: [{ command: 'test -f done.txt' }] });

    await env.runOnce(workerOf(env));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.streams).toHaveLength(3);
    const results = completions(env, run.id);
    expect(results.map((event) => event.outcome)).toEqual(['failed', 'passed']);
    expect(results[1]?.mutationSeq).toBeGreaterThan(results[0]?.mutationSeq ?? Number.POSITIVE_INFINITY);
    expect(results[1]?.round).toBe(2);
  });

  it('runs every owed condition in declared order even when the first fails, and reports all failures at once', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.gateway.script.push(textStep('Done.'), textStep('Done.'));
    const run = enqueueWith(env, 'two checks', { conditions: [{ command: 'echo first-broken; exit 4' }, { command: 'echo second-broken; exit 5' }] });

    await env.runOnce(workerOf(env));

    expect(completions(env, run.id).map((event) => event.exitCode)).toEqual([4, 5]);
    const [message] = feedback(env, run.id);
    expect(message).toContain('first-broken');
    expect(message).toContain('second-broken');
  });

  it('runs a condition again when a write follows its pass, so a pass is valid only until the next mutation', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const hooked = path.join(env.root, 'hooked');
    env.settings.hooksValue = stopHook(`if [ ! -f ${hooked} ]; then touch ${hooked}; echo "one more thing" >&2; exit 2; fi`);
    env.gateway.script.push(write('call_w_1', path.join(env.project, 'done.txt')), textStep('Done.'), write('call_w_2', path.join(env.project, 'more.txt')), textStep('Done again.'));
    const run = enqueueWith(env, 'create done.txt', { conditions: [{ command: 'test -f done.txt' }] });

    await env.runOnce(workerOf(env));

    expect(env.run(run.id).status).toBe('COMPLETED');
    const results = completions(env, run.id);
    expect(results.map((event) => event.outcome)).toEqual(['passed', 'passed']);
    expect(results[1]?.mutationSeq).toBeGreaterThan(results[0]?.mutationSeq ?? Number.POSITIVE_INFINITY);
  });

  it('runs the conditions before the Stop hooks', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.settings.hooksValue = stopHook('true');
    env.gateway.script.push(textStep('Done.'));
    const run = enqueueWith(env, 'check', { conditions: [{ command: 'true' }] });

    await env.runOnce(workerOf(env));

    expect(env.run(run.id).status).toBe('COMPLETED');
    const [verified] = completions(env, run.id);
    const [hook] = env.ofType(run.id, 'hook.completed');
    expect(verified?.outcome).toBe('passed');
    expect(verified?.seq).toBeLessThan(hook?.seq ?? 0);
  });

  it('does not run the Stop hooks of a round whose conditions failed', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.settings.hooksValue = stopHook('true');
    env.gateway.script.push(textStep('Done.'), textStep('Done.'));
    const run = enqueueWith(env, 'check', { conditions: [{ command: 'false' }] });

    await env.runOnce(workerOf(env));

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'conditions_unmet' });
    expect(env.ofType(run.id, 'hook.completed')).toEqual([]);
  });

  it('runs the condition through the session sandbox with the session policy, in the project directory', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    spawned.length = 0;
    env.gateway.script.push(textStep('Done.'));
    const run = enqueueWith(env, 'check', { conditions: [{ command: 'pwd > where.txt' }] });

    await env.runOnce(workerOf(env));

    expect(env.run(run.id).status).toBe('COMPLETED');
    const spawn = spawned.find((entry) => entry.argv.at(-1) === 'pwd > where.txt');
    expect(spawn).toBeDefined();
    expect(spawn?.policy.writableRoots ?? []).toContain(env.project);
    expect(fs.readFileSync(path.join(env.project, 'where.txt'), 'utf8').trim()).toBe(env.project);
  });

  it('passes only on exit 0: a condition that exits 0 passes, any other exit fails', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.gateway.script.push(textStep('Done.'));
    const run = enqueueWith(env, 'check', { conditions: [{ command: 'exit 0' }] });

    await env.runOnce(workerOf(env));

    expect(completions(env, run.id)).toMatchObject([{ outcome: 'passed', exitCode: 0 }]);
    expect(env.run(run.id).status).toBe('COMPLETED');
  });

  it('records a condition that outruns its declared timeout as timed_out, never passed', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.gateway.script.push(textStep('Done.'), textStep('Done.'));
    const run = enqueueWith(env, 'check', { conditions: [{ command: 'sleep 30', timeoutMs: 1000 }] });

    await env.runOnce(workerOf(env));

    expect(completions(env, run.id)).toMatchObject([{ outcome: 'timed_out' }]);
    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'conditions_unmet' });
  });

  it('does not count verification as model steps', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.gateway.script.push(textStep('Done.'), write('call_w_1', path.join(env.project, 'done.txt')), textStep('Fixed.'));
    const run = enqueueWith(env, 'create done.txt', { conditions: [{ command: 'test -f done.txt' }] });

    await env.runOnce(workerOf(env));

    expect(env.run(run.id)).toMatchObject({ status: 'COMPLETED', step: 3 });
  });
});

describe('when a condition is owed', () => {
  it('does not evaluate an after_mutation condition when nothing was changed', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    standing(env, ['exit 1']);
    env.gateway.script.push(textStep('The answer is 42.'));
    const run = enqueueWith(env, 'a question', undefined);

    await env.runOnce(workerOf(env));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(starts(env, run.id)).toEqual([]);
    expect(pinnedConditions(env, run.id)).toMatchObject([{ command: 'exit 1', when: 'after_mutation', source: 'settings' }]);
  });

  it('evaluates a settings condition after a mutation', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    standing(env, ['echo lint-broken; exit 1']);
    env.gateway.script.push(write('call_w_1', path.join(env.project, 'a.txt')), textStep('Done.'), textStep('Done.'));
    const run = enqueueWith(env, 'edit', undefined);

    await env.runOnce(workerOf(env));

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'conditions_unmet' });
    expect(completions(env, run.id)).toMatchObject([{ outcome: 'failed', exitCode: 1 }]);
  });

  it('evaluates an always condition from the request even when nothing was changed', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.gateway.script.push(textStep('Nothing to do.'));
    const run = enqueueWith(env, 'check', { conditions: [{ command: 'true' }] });

    await env.runOnce(workerOf(env));

    expect(completions(env, run.id)).toMatchObject([{ outcome: 'passed', mutationSeq: 0 }]);
    expect(pinnedConditions(env, run.id)).toMatchObject([{ command: 'true', when: 'always', source: 'request' }]);
  });

  it('never turns the memory gate default commands into standing conditions', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    standing(env, []);
    env.gateway.script.push(write('call_w_1', path.join(env.project, 'a.txt')), textStep('Done.'));
    const run = enqueueWith(env, 'edit', undefined);

    await env.runOnce(workerOf(env));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(starts(env, run.id)).toEqual([]);
  });
});

describe('the pinned declaration', () => {
  it('pins the union of the request and the settings conditions in run.started.pins.mandate.completion', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    standing(env, ['npm run lint']);
    env.gateway.script.push(textStep('Done.'));
    const run = enqueueWith(env, 'check', { conditions: [{ command: 'true', timeoutMs: 5000 }], requirements: ['the docs mention it'] });

    await env.runOnce(workerOf(env));

    const conditions = pinnedConditions(env, run.id);
    expect(conditions).toMatchObject([
      { command: 'true', when: 'always', source: 'request', timeoutMs: 5000 },
      { command: 'npm run lint', when: 'after_mutation', source: 'settings' },
    ]);
    expect(conditions.every((condition) => typeof condition.id === 'string' && condition.id.length > 0)).toBe(true);
    const started = env.ofType(run.id, 'run.started')[0];
    expect((started?.pins['mandate'] as { completion?: { requirements?: string[] } }).completion?.requirements).toEqual(['the docs mention it']);
  });

  it('keeps one condition for a command declared by two sources, with the meaning of the most specific source', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    standing(env, ['true']);
    env.gateway.script.push(textStep('Done.'));
    const run = enqueueWith(env, 'check', { conditions: [{ command: 'true' }] });

    await env.runOnce(workerOf(env));

    expect(pinnedConditions(env, run.id)).toMatchObject([{ command: 'true', when: 'always', source: 'request' }]);
    expect(pinnedConditions(env, run.id)).toHaveLength(1);
  });

  it('drops the inherited settings conditions when the request says inherit false', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    standing(env, ['npm run lint']);
    env.gateway.script.push(textStep('Done.'));
    const run = enqueueWith(env, 'check', { conditions: [{ command: 'true' }], inherit: false });

    await env.runOnce(workerOf(env));

    expect(pinnedConditions(env, run.id).map((condition) => condition.command)).toEqual(['true']);
  });

  it('derives the same id for the same command, so the id does not depend on the source', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.gateway.script.push(textStep('Done.'), textStep('Done.'));
    const first = enqueueWith(env, 'check', { conditions: [{ command: 'true' }] });
    await env.runOnce(workerOf(env));
    standing(env, ['true']);
    const second = enqueueWith(env, 'check again', undefined);
    await env.runOnce(workerOf(env));

    const [left] = pinnedConditions(env, first.id);
    const [right] = pinnedConditions(env, second.id);
    expect(left?.id).toBeDefined();
    expect(left?.id).toBe(right?.id);
  });

  it('keeps the pinned declaration when the settings change while the run waits', async () => {
    const env = await makeEnv({ mode: 'manual' });
    standing(env, ['true']);
    env.gateway.script.push(write('call_w_1', path.join(env.project, 'a.txt')), textStep('Done.'));
    const run = enqueueWith(env, 'edit', undefined);

    await env.runOnce(workerOf(env));
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    standing(env, ['exit 7']);
    await env.resolveApproval(run.id, 'allow_once');
    await env.runOnce(workerOf(env));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(pinnedConditions(env, run.id).map((condition) => condition.command)).toEqual(['true']);
    expect(env.ofType(run.id, 'run.started').every((event) => JSON.stringify(event.pins['mandate']) === JSON.stringify(env.ofType(run.id, 'run.started')[0]?.pins['mandate']))).toBe(true);
    expect(completions(env, run.id)).toMatchObject([{ outcome: 'passed' }]);
  });
});

describe('verification.required', () => {
  it('stops a run that wrote without any declared condition when required is on', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    standing(env, [], true);
    env.gateway.script.push(write('call_w_1', path.join(env.project, 'a.txt')), textStep('Done.'));
    const run = enqueueWith(env, 'edit', undefined);

    await env.runOnce(workerOf(env));

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'conditions_unmet' });
  });

  it('completes a run that changed nothing when required is on and nothing is declared', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    standing(env, [], true);
    env.gateway.script.push(textStep('The answer is 42.'));
    const run = enqueueWith(env, 'a question', undefined);

    await env.runOnce(workerOf(env));

    expect(env.run(run.id).status).toBe('COMPLETED');
  });

  it('is on for a run with a mandate, so a mandate run that wrote with only unchecked requirements stops', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    standing(env, [], false);
    env.gateway.script.push(write('call_w_1', path.join(env.project, 'a.txt')), textStep('Done.'));
    const run = enqueueWith(env, 'edit', { requirements: ['the docs mention it'] });

    await env.runOnce(workerOf(env));

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'conditions_unmet' });
  });

  it('completes a run that wrote without a condition when required is off', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    standing(env, [], false);
    env.gateway.script.push(write('call_w_1', path.join(env.project, 'a.txt')), textStep('Done.'));
    const run = enqueueWith(env, 'edit', undefined);

    await env.runOnce(workerOf(env));

    expect(env.run(run.id).status).toBe('COMPLETED');
  });
});

describe('limits during the send-back loop', () => {
  it('ends with the existing max_steps reason when the fix rounds use up the steps', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.gateway.script.push(
      textStep('Done.'),
      write('call_w_1', path.join(env.project, 'a.txt')),
      textStep('Done.'),
      write('call_w_2', path.join(env.project, 'b.txt')),
      textStep('Summary.'),
    );
    const run = createdRun(
      env.store.createRunAndEnqueue(env.session.id, {
        input: 'fix it',
        timeoutMs: DEADLINE_MS - env.clock.now(),
        limits: { maxSteps: 3 },
        pins: {},
        mandate: { completion: { conditions: [{ command: 'false' }] } },
      } as never),
    );

    await env.runOnce(workerOf(env));

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'max_steps' });
    expect(completions(env, run.id).length).toBeGreaterThanOrEqual(2);
  });
});
