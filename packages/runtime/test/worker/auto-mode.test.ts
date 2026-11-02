import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLASSIFIER_INSTRUCTIONS } from '../../src/worker/auto-classifier.ts';
import { makeEnv } from './harness.ts';
import { GatewayRequestError } from '../../src/gateway-client.ts';
import { callsStep, failedStep, textStep } from './scripts.ts';

const verdict = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({ verdict: 'safe', confidence: 'high', rationale: 'writes a file the user asked for', ...overrides });

const setup = async (classifier: string | null = 'guard') => {
  const env = await makeEnv({ mode: 'auto' });
  env.settings.classifierAlias = classifier ?? undefined;
  const target = path.join(env.project, 'out.txt');
  const write = callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'x' } }]);
  return { env, target, write };
};

describe('auto mode in the worker', () => {
  it('runs the call when the classifier is confident it is safe and records the verdict', async () => {
    const { env, target, write } = await setup();
    env.gateway.script.push(write, textStep(verdict()), textStep('Written.'));
    const run = env.enqueue('Write out.txt');
    await env.runOnce(env.worker());
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(fs.readFileSync(target, 'utf8')).toBe('x');
    expect(env.ofType(run.id, 'tool.permission.requested')).toEqual([]);
    expect(env.ofType(run.id, 'tool.permission.classified')).toMatchObject([
      { outcome: 'allow', alias: 'guard', verdict: 'safe', confidence: 'high' },
    ]);
  });

  it('sends the classifier alias, the schema, the instructions and the quoted call', async () => {
    const { env, write } = await setup();
    env.gateway.script.push(write, textStep(verdict()), textStep('Written.'));
    env.enqueue('Write out.txt');
    await env.runOnce(env.worker());
    const request = env.gateway.streams[1];
    expect(request?.body).toMatchObject({
      model: 'guard',
      instructions: CLASSIFIER_INSTRUCTIONS,
      tool_choice: 'none',
      store: false,
      text: { format: { type: 'json_schema' } },
    });
    expect(JSON.stringify(request?.body.input)).toContain('<proposed_tool_call>');
    expect(JSON.stringify(request?.body.input)).toContain('Write out.txt');
  });

  it.each([
    ['an unsafe verdict', textStep(verdict({ verdict: 'unsafe' }))],
    ['a low confidence verdict', textStep(verdict({ confidence: 'low' }))],
    ['a medium confidence verdict', textStep(verdict({ confidence: 'medium' }))],
  ])('asks the person after %s', async (_label, reply) => {
    const { env, target, write } = await setup();
    env.gateway.script.push(write, reply);
    const run = env.enqueue('Write out.txt');
    await env.runOnce(env.worker());
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    expect(env.ofType(run.id, 'tool.permission.requested')).toHaveLength(1);
    expect(env.ofType(run.id, 'tool.permission.classified')).toMatchObject([{ outcome: 'ask' }]);
    expect(fs.existsSync(target)).toBe(false);
  });

  it.each([
    ['a malformed reply', textStep('not json'), 'not JSON'],
    ['a failed upstream response', failedStep('server_error'), 'server_error'],
  ])('asks the person after %s and records the failure', async (_label, reply, fragment) => {
    const { env, write } = await setup();
    env.gateway.script.push(write, reply);
    const run = env.enqueue('Write out.txt');
    await env.runOnce(env.worker());
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    const [classified] = env.ofType(run.id, 'tool.permission.classified');
    expect(classified).toMatchObject({ outcome: 'ask' });
    expect(classified?.failure).toContain(fragment);
  });

  it('asks the person when no classifier alias is configured', async () => {
    const { env, write } = await setup(null);
    env.gateway.script.push(write);
    const run = env.enqueue('Write out.txt');
    await env.runOnce(env.worker());
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    const [classified] = env.ofType(run.id, 'tool.permission.classified');
    expect(classified).toMatchObject({ outcome: 'ask' });
    expect(classified).not.toHaveProperty('alias');
    expect(env.gateway.streams).toHaveLength(1);
  });

  it('does not use the classifier for a deny rule', async () => {
    const { env, target, write } = await setup();
    env.settings.extraRules.push({ effect: 'deny', rule: 'Write' });
    env.gateway.script.push(write, textStep('Blocked.'));
    const run = env.enqueue('Write out.txt');
    await env.runOnce(env.worker());
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'tool.permission.classified')).toEqual([]);
    expect(env.ofType(run.id, 'tool.completed')).toMatchObject([{ status: 'failed', denial: { source: 'rule' } }]);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('does not ask the classifier a second time after the person approves its fallback', async () => {
    const { env, target, write } = await setup();
    env.gateway.script.push(write, textStep(verdict({ verdict: 'unsafe' })), textStep('Written.'));
    const run = env.enqueue('Write out.txt');
    await env.runOnce(env.worker());
    env.resolveApproval(run.id, 'allow_once');
    await env.runOnce(env.worker('worker-2'));
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'tool.permission.classified')).toHaveLength(1);
    expect(fs.readFileSync(target, 'utf8')).toBe('x');
  });
});


describe('auto mode classifier gateway failure', () => {
  it('asks the person and records the gateway error code when the gateway is unavailable', async () => {
    const { env, write } = await setup();
    const error = new GatewayRequestError({ status: 0, type: 'transport', code: 'gateway_unavailable', message: 'the gateway socket is unavailable' });
    env.gateway.script.push(write, { events: [], error });
    const run = env.enqueue('Write out.txt');
    await env.runOnce(env.worker());
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    expect(env.ofType(run.id, 'tool.permission.classified')[0]?.failure).toBe('gateway_unavailable: the gateway socket is unavailable');
  });
});
