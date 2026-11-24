import { describe, expect, it } from 'vitest';
import { TARGET_PROBING, TARGET_PROBING_MESSAGE, tokensForText } from '@momonga/protocol';
import { GatewayRequestError, ModelUnlistedError } from '@momonga/runtime';
import { MODEL_ID, OTHER_MODEL_ID, defaultModelCapabilities, expectError, expectSchema, startService } from './helpers.ts';

const textRule = (project: string, overrides: Record<string, unknown> = {}) => ({
  kind: 'constraint',
  target: 'Production Database',
  text: 'never touch production',
  scope: { level: 'project', project, paths: [] },
  ...overrides,
});

describe('rules api', () => {
  it('adds a fact with source command, with a normalized target', async () => {
    const env = await startService({ fakeTimers: true });
    const added = await env.http('POST', '/v1/rules', { body: textRule(env.layout.project) });
    expect(added.status).toBe(201);
    expect(added.json.fact).toMatchObject({ target: 'production-database', text: 'never touch production', source: { kind: 'command' } });
    expectSchema('RuleAddResponse', added.json);
  });

  it('reports the size of the fact against the window of every configured target, from the live route', async () => {
    const env = await startService({ fakeTimers: true });
    const added = await env.http('POST', '/v1/rules', { body: textRule(env.layout.project) });
    const tokens = tokensForText('never touch production');
    expect(added.json.size).toEqual([
      { target: MODEL_ID, contextWindow: 8192, tokens, percent: (tokens * 100) / 8192 },
      { target: OTHER_MODEL_ID, contextWindow: 8192, tokens, percent: (tokens * 100) / 8192 },
    ]);
  });

  it('adds the fact and carries a warning in the response when the gateway cannot answer for the size', async () => {
    const env = await startService({ fakeTimers: true });
    env.ports.listingFailure.error = new GatewayRequestError({ status: 503, type: 'server_error', code: 'unavailable', message: 'the gateway is down' });
    const added = await env.http('POST', '/v1/rules', { body: textRule(env.layout.project) });
    expect(added.status).toBe(201);
    expect(added.json.size).toEqual([]);
    expect(added.json.warnings).toHaveLength(1);
    expect(added.json.warnings[0]).toContain('the gateway is down');
    expectSchema('RuleAddResponse', added.json);
    const listed = await env.http('GET', `/v1/rules?project=${encodeURIComponent(env.layout.project)}`);
    expect(listed.json.facts).toHaveLength(1);
  });

  it('lets a failure that is not the gateway answering through, and adds nothing', async () => {
    const env = await startService({ fakeTimers: true });
    env.ports.listingFailure.error = new TypeError('a defect');
    const added = await env.http('POST', '/v1/rules', { body: textRule(env.layout.project) });
    expect(added.status).toBe(500);
    const listed = await env.http('GET', `/v1/rules?project=${encodeURIComponent(env.layout.project)}`);
    expect(listed.json.facts).toEqual([]);
  });

  it('adding a rule with one model unavailable measures the others and names the unavailable one in warnings', async () => {
    const capabilitiesOf = async (model: string) => {
      if (model === OTHER_MODEL_ID) throw new ModelUnlistedError({ status: 412, type: 'invalid_request', code: 'capabilities_unknown', message: 'no numbers for a' });
      return defaultModelCapabilities();
    };
    const env = await startService({ fakeTimers: true, capabilitiesOf });
    const added = await env.http('POST', '/v1/rules', { body: textRule(env.layout.project) });
    const tokens = tokensForText('never touch production');
    expect(added.status).toBe(201);
    expect(added.json.size).toEqual([{ target: MODEL_ID, contextWindow: 8192, tokens, percent: (tokens * 100) / 8192 }]);
    expect(added.json.warnings).toEqual([`the size of this rule was not measured against the model "${OTHER_MODEL_ID}": no numbers for a`]);
  });

  it('the same for a probing model', async () => {
    const capabilitiesOf = async (model: string) => {
      if (model === OTHER_MODEL_ID) throw new ModelUnlistedError({ status: 503, type: 'server_error', code: TARGET_PROBING, message: TARGET_PROBING_MESSAGE });
      return defaultModelCapabilities();
    };
    const env = await startService({ fakeTimers: true, capabilitiesOf });
    const added = await env.http('POST', '/v1/rules', { body: textRule(env.layout.project) });
    const tokens = tokensForText('never touch production');
    expect(added.status).toBe(201);
    expect(added.json.size).toEqual([{ target: MODEL_ID, contextWindow: 8192, tokens, percent: (tokens * 100) / 8192 }]);
    expect(added.json.warnings).toEqual([`the size of this rule was not measured against the model "${OTHER_MODEL_ID}": ${TARGET_PROBING_MESSAGE}`]);
  });

  it('refuses a repeat of a live fact with the id of the existing one, and stores nothing', async () => {
    const env = await startService({ fakeTimers: true });
    const first = (await env.http('POST', '/v1/rules', { body: textRule(env.layout.project) })).json.fact;
    const repeated = await env.http('POST', '/v1/rules', { body: textRule(env.layout.project) });
    expectError(repeated, 400, 'invalid_request');
    expect(JSON.stringify(repeated.json)).toContain(first.id);
    const listed = await env.http('GET', `/v1/rules?project=${encodeURIComponent(env.layout.project)}`);
    expect(listed.json.facts).toHaveLength(1);
  });

  it('adds one fact when the same rule arrives twice while the gateway size call is held, and refuses the retry with the id of the first', async () => {
    const aliasesPerRequest = 2;
    const requests = 2;
    let reached = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const env = await startService({
      fakeTimers: true,
      beforeCapabilities: async () => {
        reached += 1;
        if (reached === aliasesPerRequest * requests) release();
        await held;
      },
    });
    const [first, second] = await Promise.all([
      env.http('POST', '/v1/rules', { body: textRule(env.layout.project) }),
      env.http('POST', '/v1/rules', { body: textRule(env.layout.project) }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 400]);
    const added = first.status === 201 ? first : second;
    const refused = first.status === 201 ? second : first;
    expectError(refused, 400, 'invalid_request');
    expect(JSON.stringify(refused.json)).toContain(added.json.fact.id);
    const listed = await env.http('GET', `/v1/rules?project=${encodeURIComponent(env.layout.project)}`);
    expect(listed.json.facts).toHaveLength(1);
  });

  it('refuses an absolute path glob', async () => {
    const env = await startService({ fakeTimers: true });
    expectError(await env.http('POST', '/v1/rules', { body: textRule(env.layout.project, { scope: { level: 'project', project: env.layout.project, paths: ['/abs/**'] } }) }), 400, 'invalid_request');
  });

  it('stores the project of a fact in the canonical form that sessions use', async () => {
    const env = await startService({ fakeTimers: true });
    const added = await env.http('POST', '/v1/rules', { body: textRule(env.layout.project) });
    expect(added.json.fact.scope).toEqual({ level: 'project', project: env.layout.projectReal, paths: [] });
  });

  it('lists facts of a project and marks nothing for another', async () => {
    const env = await startService({ fakeTimers: true });
    const { json } = await env.http('POST', '/v1/rules', { body: textRule(env.layout.project) });
    const listed = await env.http('GET', `/v1/rules?project=${encodeURIComponent(env.layout.project)}`);
    expect(listed.json).toEqual({ facts: [json.fact] });
    expectSchema('RulesResponse', listed.json);
  });

  it('retires a fact and shows its history', async () => {
    const env = await startService({ fakeTimers: true });
    const first = (await env.http('POST', '/v1/rules', { body: textRule(env.layout.project) })).json.fact;
    const second = (await env.http('POST', '/v1/rules', { body: textRule(env.layout.project, { text: 'revised', supersedes: [first.id] }) })).json.fact;
    const retired = await env.http('POST', `/v1/rules/${second.id}/retire`);
    expect(retired.status).toBe(200);
    expect(retired.json.fact.retiredAt).not.toBeNull();
    const history = await env.http('GET', `/v1/rules/${first.id}/history`);
    expect(history.json.facts.map((fact: { id: string }) => fact.id)).toEqual([first.id, second.id]);
    expectError(await env.http('POST', '/v1/rules/absent/retire'), 404, 'not_found');
  });

  it('refuses an allow enforcement', async () => {
    const env = await startService({ fakeTimers: true });
    const refused = await env.http('POST', '/v1/rules', { body: textRule(env.layout.project, { enforcement: { behavior: 'allow', rule: 'Bash(ls:*)' } }) });
    expectError(refused, 400, 'invalid_request');
    expect((await env.http('GET', `/v1/rules?project=${encodeURIComponent(env.layout.project)}`)).json).toEqual({ facts: [] });
  });

  it('refuses a rule the policy parser rejects', async () => {
    const env = await startService({ fakeTimers: true });
    expectError(await env.http('POST', '/v1/rules', { body: textRule(env.layout.project, { enforcement: { behavior: 'deny', rule: 'Nonsense((' } }) }), 400, 'invalid_request');
  });

  it('refuses a supersedes entry outside the group', async () => {
    const env = await startService({ fakeTimers: true });
    const first = (await env.http('POST', '/v1/rules', { body: textRule(env.layout.project, { target: 'other' }) })).json.fact;
    expectError(await env.http('POST', '/v1/rules', { body: textRule(env.layout.project, { supersedes: [first.id] }) }), 400, 'invalid_request');
  });

  it('warns when a text fact overlaps the target of an enforced one', async () => {
    const env = await startService({ fakeTimers: true });
    const enforced = (await env.http('POST', '/v1/rules', { body: textRule(env.layout.project, { enforcement: { behavior: 'deny', rule: 'Bash(rm:*)' } }) })).json;
    expect(enforced.warnings).toEqual([]);
    const text = await env.http('POST', '/v1/rules', { body: textRule(env.layout.project, { text: 'careful with production' }) });
    expect(text.json.warnings).toHaveLength(1);
    expect(text.json.warnings[0]).toContain(enforced.fact.id);
  });
});

describe('policy governance route', () => {
  it('gives enforced rules with paths ignored, and each fact as enforced or text-only', async () => {
    const env = await startService({ fakeTimers: true });
    const { project } = env.layout;
    const enforced = (await env.http('POST', '/v1/rules', { body: textRule(project, { target: 'rm', scope: { level: 'project', project, paths: ['src/**'] }, enforcement: { behavior: 'deny', rule: 'Bash(rm:*)' } }) })).json.fact;
    const text = (await env.http('POST', '/v1/rules', { body: textRule(project, { target: 'style' }) })).json.fact;
    const retired = (await env.http('POST', '/v1/rules', { body: textRule(project, { target: 'old', enforcement: { behavior: 'deny', rule: 'Bash(dd:*)' } }) })).json.fact;
    await env.http('POST', `/v1/rules/${retired.id}/retire`);
    const response = await env.http('GET', `/v1/policy/governance?project=${encodeURIComponent(project)}`);
    expect(response.status).toBe(200);
    expect(response.json.rules).toEqual([{ id: enforced.id, behavior: 'deny', rule: 'Bash(rm:*)' }]);
    expect(response.json.textOnly.map((fact: { id: string }) => fact.id)).toEqual([text.id]);
    expectSchema('PolicyGovernanceResponse', response.json);
  });
});

describe('policy verification route', () => {
  const answer = { fingerprint: 'a'.repeat(64), stored: true, exitCode: 0, text: 'policy verification of 1 rule(s)', findings: { exitCode: 0 } };

  it('has no route through which a client writes a verdict', async () => {
    const env = await startService({ fakeTimers: true });
    const proved = { verdict: 'proved', solver: 'z3 1', refuted: [], unknown: [], notProved: [] };
    const response = await env.http('PUT', `/v1/policy/verdicts/${'a'.repeat(64)}`, { body: { verdict: proved } });
    expect(response.status).toBe(404);
    expect(env.store.ruleVerdicts.get('a'.repeat(64))).toBeUndefined();
  });

  it('verifies the rules of the canonical folder in the daemon and answers its report', async () => {
    const asked: unknown[] = [];
    const env = await startService({
      fakeTimers: true,
      policyVerification: async (request) => {
        asked.push(request);
        return answer;
      },
    });
    const response = await env.http('POST', '/v1/policy/verify', { body: { project: env.layout.project, mode: 'manual', secrets: ['/vault'], mandate: 'release' } });
    expect(response.status).toBe(200);
    expect(response.json).toEqual(answer);
    expectSchema('PolicyVerifyResponse', response.json);
    expect(asked).toEqual([{ cwd: env.layout.project, mode: 'manual', secrets: ['/vault'], mandate: 'release' }]);
  });

  it('refuses a body that is not a verification request, and a secret location that is not absolute', async () => {
    const env = await startService({ fakeTimers: true, policyVerification: async () => answer });
    expectError(await env.http('POST', '/v1/policy/verify', { body: { project: env.layout.project, secrets: [], extra: 1 } }), 400, 'invalid_request');
    expectError(await env.http('POST', '/v1/policy/verify', { body: { project: env.layout.project, secrets: ['vault'] } }), 400, 'invalid_request');
  });
});

describe('memory history route', () => {
  const seed = async () => {
    const env = await startService({ fakeTimers: true });
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    const claim = env.claimRun(run.id);
    env.append(claim, ['c1', 'c2'].map((callId) => ({ type: 'tool.call' as const, callId, providerCallId: callId, name: 'MemorySave', kind: 'other' as const, title: 'Save', rawInput: {} })));
    return { env, session, run };
  };

  it('shows a superseded memory and its successor with status', async () => {
    const { env, session, run } = await seed();
    const base = { origin: 'trusted', scope: 'project', project: session.cwd, runId: run.id, step: 1 } as const;
    const older = (await env.store.memories.save({ ...base, text: 'older', callId: 'c1' })).memory;
    const newer = (await env.store.memories.save({ ...base, text: 'newer', callId: 'c2', supersedes: [older.id] })).memory;
    const history = await env.http('GET', `/v1/memories/${older.id}/history`);
    expect(history.status).toBe(200);
    expect(history.json.memories.map((memory: { id: string }) => memory.id)).toEqual([older.id, newer.id]);
    expect(history.json.memories.map((memory: { status: string }) => memory.status)).toEqual(['unbound', 'unbound']);
    expectSchema('MemoriesResponse', history.json);
  });

  it('computes status on every read', async () => {
    const { env, session, run } = await seed();
    const memory = (await env.store.memories.save({ origin: 'trusted', scope: 'project', project: session.cwd, text: 'note', runId: run.id, step: 1, callId: 'c1' })).memory;
    expect((await env.http('GET', `/v1/memories/${memory.id}`)).json.memory.status).toBe('unbound');
  });
});

describe('schema', () => {
  it('requires status on a memory view', async () => {
    const memory = { id: 'm', scope: 'user', origin: 'trusted', project: null, text: 't', source: { kind: 'tool', sessionId: 's', runId: 'r', step: 1, callId: 'c', seq: 1 }, createdAt: 1, keptAt: 1, kind: 'fact', state: 'active', duplicateOf: null, supersedes: [], supersededBy: [], retiredAt: null, evidence: [], contributedAt: null, keptByClassifier: null };
    expect(() => expectSchema('MemoryView', memory)).toThrow(/status/);
    expectSchema('MemoryView', { ...memory, status: 'unbound' });
  });
});
