import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/service/errors.ts';
import { canonicalProject } from '../../src/service/project-query.ts';
import { PERSON_CAPABILITY_TEST_HEADER, personCapabilityFileOf, pollFor, startService } from './helpers.ts';
import type { ServiceEnv, ServiceOverrides } from './helpers.ts';

const SETTLE_BOUND_MS = 10_000;

const untilAborted = <T>(signal: AbortSignal): Promise<T> => new Promise<T>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));

type Held = { reached: Promise<void>; signals: AbortSignal[]; hold<T>(signal: AbortSignal): Promise<T> };

const held = (): Held => {
  const reached = Promise.withResolvers<void>();
  const signals: AbortSignal[] = [];
  return {
    reached: reached.promise,
    signals,
    hold: <T>(signal: AbortSignal) => {
      signals.push(signal);
      reached.resolve();
      return untilAborted<T>(signal);
    },
  };
};

const leaveDuring = async (env: ServiceEnv, step: Held, method: string, target: string, body?: unknown): Promise<void> => {
  const client = new AbortController();
  const answered = env.client
    .request({
      method,
      path: target,
      signal: client.signal,
      headers: { [PERSON_CAPABILITY_TEST_HEADER]: fs.readFileSync(personCapabilityFileOf(env.layout.home), 'utf8'), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    .then(
      () => 'answered',
      () => 'left',
    );
  await step.reached;
  client.abort();
  expect(await answered).toBe('left');
  await pollFor(() => env.service.openRequests() === 0, SETTLE_BOUND_MS, 'the request of the client that left to end');
};

const serviceHolding = async (overridesOf: (step: Held) => ServiceOverrides) => {
  const step = held();
  const env = await startService(overridesOf(step));
  return { env, step };
};

describe('a client that leaves while a handler step is running', () => {
  it('ends the list of skills with the request and logs no service error', async () => {
    const { env, step } = await serviceHolding((held) => ({ skills: { load: (_session, signal) => held.hold(signal) } }));
    const session = await env.createSession();

    await leaveDuring(env, step, 'GET', `/v1/sessions/${session.id}/skills`);

    expect(env.errors).toEqual([]);
  });

  it('ends the list of agents with the request and logs no service error', async () => {
    const { env, step } = await serviceHolding((held) => ({ agents: { load: (_session, signal) => held.hold(signal) } }));
    const session = await env.createSession();

    await leaveDuring(env, step, 'GET', `/v1/sessions/${session.id}/agents`);

    expect(env.errors).toEqual([]);
  });

  it('ends the trace of a run with the request and logs no service error', async () => {
    const { env, step } = await serviceHolding((held) => ({ runTrace: (_runId, signal) => held.hold(signal) }));
    const session = await env.createSession();
    const run = await env.createRun(session.id);

    await leaveDuring(env, step, 'GET', `/v1/runs/${run.id}/trace`);

    expect(env.errors).toEqual([]);
  });

  it('gives the model listing of POST rules the signal of the request, so the measurement ends with the client', async () => {
    const { env, step } = await serviceHolding((held) => ({ modelListing: (signal) => held.hold(signal) }));

    await leaveDuring(env, step, 'POST', '/v1/rules', { kind: 'constraint', target: 'production-database', text: 'never touch production', scope: { level: 'project', project: env.layout.project, paths: [] } });

    expect(step.signals.map((signal) => signal.aborted)).toEqual([true]);
    expect(env.errors).toEqual([]);
  });
});

describe('the canonical path of a project query', () => {
  it('leaves an abort of the asker as its reason, not as an invalid request', async () => {
    const reason = new Error('the client left');

    const outcome = await canonicalProject('/', 'project', AbortSignal.abort(reason)).then(
      () => 'resolved',
      (error: unknown) => error,
    );

    expect(outcome).not.toBeInstanceOf(ApiError);
    expect(outcome).toBe(reason);
  });
});
