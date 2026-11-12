import { describe, expect, it } from 'vitest';
import type { RuleVerdict } from '@momonga/protocol';
import type { MandateRunRequest } from '../../src/process/folder-verification.ts';
import { expectError, startService } from './helpers.ts';

const SOLVER = 'z3-test';

const refuted: RuleVerdict = {
  verdict: 'refuted',
  solver: SOLVER,
  refuted: [{ property: 'superseded-forms', subject: 'the allow rule Bash(git push:*) of the mandate', message: 'it admits git push, which the operation git.push replaces' }],
  unknown: [],
  notProved: [],
};

const proved: RuleVerdict = { verdict: 'proved', solver: SOLVER, refuted: [], unknown: [], notProved: [] };

const unknown: RuleVerdict = { verdict: 'unknown', solver: SOLVER, refuted: [], unknown: [{ property: 'superseded-forms', reason: 'the solver gave no answer within its budget' }], notProved: [] };

const scoped = { input: 'release it', mandate: { scope: { allow: ['Bash(git push:*)'] } } };

const serviceAnswering = async (verdict: RuleVerdict) => {
  const asked: MandateRunRequest[] = [];
  const env = await startService({
    mandateVerification: async (request) => {
      asked.push(request);
      return verdict;
    },
  });
  return { env, asked, session: await env.createSession() };
};

describe('the two mandate properties are verified when a run with a mandate is created', () => {
  it('refuses a mandate whose allow rule admits a superseded form with the typed refusal that names the rule, and creates no run', async () => {
    const { env, asked, session } = await serviceAnswering(refuted);

    const response = await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: scoped });

    expectError(response, 409, 'policy_refuted');
    expect(JSON.stringify(response.json)).toContain('Bash(git push:*)');
    expect(env.store.listRuns(session.id)).toEqual([]);
    expect(asked).toMatchObject([{ cwd: session.cwd, mode: session.permissionMode, mandate: { scope: { allow: ['Bash(git push:*)'] } } }]);
  });

  it('creates the run of a proved mandate', async () => {
    const { env, session } = await serviceAnswering(proved);

    const response = await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: scoped });

    expect(response.status).toBe(202);
  });

  it('creates the run of a mandate whose property is unknown', async () => {
    const { env, session } = await serviceAnswering(unknown);

    const response = await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: scoped });

    expect(response.status).toBe(202);
  });

  it('asks nothing for a run without a mandate scope', async () => {
    const { env, asked, session } = await serviceAnswering(refuted);

    const response = await env.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'plain' } });

    expect(response.status).toBe(202);
    expect(asked).toEqual([]);
  });
});
