import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import * as protocol from '@momonga/protocol';
import type { RunEventPayload } from '@momonga/protocol';
import { createUnsandboxed } from '@momonga/sandbox';
import { fixedSandboxBindings } from '@momonga/runtime';
import type { Run } from '@momonga/store';
import * as tools from '@momonga/tools';
import { REAL_PROCESS_TEST_TIMEOUT_MS, killGroupsForCleanup, waitFor } from '@momonga/testkit';
import { spawn } from '@momonga/testkit/child-process';
import { groupExists } from './cancel-fixture.ts';

import { DEADLINE_MS, LEASE_MS, createdRun, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { assistantMessage, textStep } from './scripts.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

type VerificationCompleted = { seq: number; round: number; conditionId: string; outcome: string; exitCode?: number };

type VerificationStarted = { seq: number; round: number; conditionId: string; attempt: number };

const groups: number[] = [];

afterEach(async () => {
  await killGroupsForCleanup(groups.splice(0));
});

const conditionIdOf = (command: string): string => {
  const found = (protocol as Record<string, unknown>)['conditionIdOf'];
  if (typeof found !== 'function') throw new Error('@momonga/protocol does not export conditionIdOf');
  return (found as (value: string) => string)(command);
};

const verificationMarkerName = (key: { runId: string; round: number; conditionId: string }): string => {
  const found = (tools as Record<string, unknown>)['verificationMarkerName'];
  if (typeof found !== 'function') throw new Error('@momonga/tools does not export verificationMarkerName');
  return (found as (value: typeof key) => string)(key);
};

const workerOf = (env: Env, id = 'worker-2') => env.worker(id, { tools: { sandboxes: fixedSandboxBindings(createUnsandboxed({ killGraceMs: 200 })) } });

const enqueueWith = async (env: Env, command: string, deadlineAt = DEADLINE_MS): Promise<Run> =>
  createdRun(
    await env.store.createRunAndEnqueue(env.session.id, {
      input: 'check it',
      timeoutMs: deadlineAt - env.clock.now(),
      limits: {},
      pins: {},
      mandate: { completion: { conditions: [{ command }] } },
    } as never),
  );

const completions = (env: Env, runId: string): VerificationCompleted[] => env.ofType(runId, 'verification.completed' as never) as unknown as VerificationCompleted[];

const starts = (env: Env, runId: string): VerificationStarted[] => env.ofType(runId, 'verification.started' as never) as unknown as VerificationStarted[];

const stoppedResponse: RunEventPayload = {
  type: 'model.responded',
  step: 1,
  attempt: 1,
  response: { status: 'completed', output: [assistantMessage('msg_1', 'done')], usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } },
};

const startedCheck = (conditionId: string): RunEventPayload => ({ type: 'verification.started', round: 1, conditionId, mutationSeq: 0, attempt: 1 }) as unknown as RunEventPayload;

const holdMarker = (env: Env, name: string): number => {
  const fd = fs.openSync(path.join(env.markers, name), 'w', 0o600);
  let pid: number | undefined;
  try {
    pid = spawn('/bin/sh', ['-c', 'exec sleep 30'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', fd] }).pid;
  } finally {
    fs.closeSync(fd);
  }
  if (pid === undefined) throw new Error('the marker holder did not spawn');
  groups.push(pid);
  return pid;
};

describe('the condition id', () => {
  it('is derived from the command alone, as a prefix of the sha256 of its canonical JSON', () => {
    const id = conditionIdOf('npm test');
    expect(id.length).toBeGreaterThanOrEqual(12);
    expect(sha256Hex(canonicalJson({ command: 'npm test' })).startsWith(id)).toBe(true);
    expect(conditionIdOf('npm test')).toBe(id);
    expect(conditionIdOf('npm run lint')).not.toBe(id);
  });
});

describe('recovery during verification', () => {
  it('never treats a started check without a completion as a verdict, and the new owner reruns it once', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const counter = path.join(env.root, 'check-runs.txt');
    const command = `echo run >> ${counter}`;
    const run = await enqueueWith(env, command);
    env.seed(run.id, [stoppedResponse, startedCheck(conditionIdOf(command))], 'crash');

    await env.runOnce(workerOf(env));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(fs.readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(starts(env, run.id).map((event) => event.attempt)).toEqual([1, 2]);
    expect(completions(env, run.id)).toMatchObject([{ round: 1, conditionId: conditionIdOf(command), outcome: 'passed' }]);
    expect(env.gateway.streams).toHaveLength(0);
  });

  it('reaps the process group the crashed owner left behind before it reruns the check', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const command = 'true';
    const run = await enqueueWith(env, command);
    const conditionId = conditionIdOf(command);
    env.seed(run.id, [stoppedResponse, startedCheck(conditionId)], 'crash');
    const pid = holdMarker(env, verificationMarkerName({ runId: run.id, round: 1, conditionId }));

    await env.runOnce(workerOf(env));

    expect(await groupExists(pid)).toBe(false);
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(completions(env, run.id)).toHaveLength(1);
  });

  it('does not rerun a check whose completion was journaled before the crash', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const counter = path.join(env.root, 'check-runs.txt');
    const command = `echo run >> ${counter}`;
    const run = await enqueueWith(env, command);
    const conditionId = conditionIdOf(command);
    env.seed(
      run.id,
      [
        stoppedResponse,
        startedCheck(conditionId),
        { type: 'verification.completed', round: 1, conditionId, outcome: 'passed', exitCode: 0, durationMs: 3, output: '', mutationSeq: 0 } as unknown as RunEventPayload,
      ],
      'crash',
    );

    await env.runOnce(workerOf(env));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(fs.existsSync(counter)).toBe(false);
    expect(completions(env, run.id)).toHaveLength(1);
  });

  it('ends CANCELLED on a cancel during a long check, with no verdict and no live check process', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const started = path.join(env.root, 'check-started');
    const pidFile = path.join(env.root, 'check-pid');
    env.gateway.script.push(textStep('done'));
    const run = await enqueueWith(env, `echo $$ > ${pidFile}; touch ${started}; sleep 30`);

    const running = env.runOnce(workerOf(env, 'worker-1'));
    await env.settled((async () => {
        await waitFor(() => fs.existsSync(started), { description: 'the check to start' });
      })(), 'the check to start');
    const checkPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    env.store.requestCancel(run.id);
    await env.settled(running, 'the worker to finish after cancel');

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(completions(env, run.id).filter((event) => event.outcome === 'passed' || event.outcome === 'failed')).toEqual([]);
    expect(await groupExists(checkPid)).toBe(false);
  });

  it('records timed_out and ends STOPPED(timeout) when the run deadline passes during a check', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const started = path.join(env.root, 'check-started');
    env.gateway.script.push(textStep('done'));
    const run = await enqueueWith(env, `touch ${started}; sleep 30`, env.clock.now() + 1500);

    const running = env.runOnce(workerOf(env, 'worker-1'));
    await env.settled((async () => {
        await waitFor(() => fs.existsSync(started), { description: 'the check to start' });
      })(), 'the check to start');
    env.clock.advance(2000);
    await env.settled(running, 'the worker to finish at the deadline');

    expect(completions(env, run.id)).toMatchObject([{ outcome: 'timed_out' }]);
    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'timeout' });
  });
});

describe('the decision after a verification round is read from the journal only', () => {
  const FIRST = 'echo first failed >&2; exit 1';
  const SECOND = 'echo second failed >&2; exit 2';

  const enqueueTwo = async (env: Env): Promise<Run> =>
    createdRun(
      await env.store.createRunAndEnqueue(env.session.id, {
        input: 'check it',
        timeoutMs: DEADLINE_MS - env.clock.now(),
        limits: {},
        pins: {},
        mandate: { completion: { conditions: [{ command: FIRST }, { command: SECOND }] } },
      } as never),
    );

  const failedCheck = (command: string): RunEventPayload[] =>
    [
      { type: 'verification.started', round: 1, conditionId: conditionIdOf(command), command, mutationSeq: 0, attempt: 1 },
      { type: 'verification.completed', round: 1, conditionId: conditionIdOf(command), command, outcome: 'failed', exitCode: 1, durationMs: 1, output: 'first failed', mutationSeq: 0 },
    ] as unknown as RunEventPayload[];

  const feedback = (env: Env, runId: string): string[] =>
    env
      .ofType(runId, 'user.message')
      .map((event) => event.text)
      .filter((text) => text.startsWith(protocol.VERIFICATION_FEEDBACK_PREFIX));

  it('gives the feedback of a round whose first check failed before a crash, and goes on with the next model step', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const run = await enqueueTwo(env);
    await env.seed(run.id, [stoppedResponse, ...failedCheck(FIRST)], 'crash');
    env.gateway.script.push(textStep('still done'));

    await env.runOnce(workerOf(env));

    expect(completions(env, run.id).map((event) => [event.round, event.conditionId])).toEqual([
      [1, conditionIdOf(FIRST)],
      [1, conditionIdOf(SECOND)],
    ]);
    expect(feedback(env, run.id)).toHaveLength(1);
    expect(env.gateway.streams).toHaveLength(1);
    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'conditions_unmet' });
  });

  it('records the last result of a round with its feedback in one append, so a crash between them cannot end the run without the feedback', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const run = await enqueueTwo(env);
    await env.seed(run.id, [stoppedResponse], 'crash');
    let dropped = false;
    const losesTheFeedback = new Proxy(env.store, {
      get: (target, property, receiver) => {
        if (property !== 'append') return Reflect.get(target, property, receiver) as unknown;
        return (...args: Parameters<typeof target.append>) => {
          const [, payloads] = args;
          if (!dropped && payloads.some((payload) => payload.type === 'user.message')) {
            dropped = true;
            env.clock.advance(LEASE_MS + 1);
            return { kind: 'lease_lost' as const };
          }
          return target.append(...args);
        };
      },
    });

    await env.runOnce(env.worker('worker-1', { store: losesTheFeedback, tools: { sandboxes: fixedSandboxBindings(createUnsandboxed({ killGraceMs: 200 })) } }));
    expect(dropped).toBe(true);
    env.gateway.script.push(textStep('still done'));
    await env.runOnce(workerOf(env));

    expect(feedback(env, run.id)).toHaveLength(1);
    const [message] = env.ofType(run.id, 'user.message').filter((event) => event.text.startsWith(protocol.VERIFICATION_FEEDBACK_PREFIX));
    const last = completions(env, run.id).filter((event) => event.round === 1).at(-1);
    expect(message?.seq).toBe((last?.seq ?? 0) + 1);
    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'conditions_unmet' });
  });
});

