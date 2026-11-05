import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@momonga/foundation';
import { usageOf } from '@momonga/testkit';
import { DEADLINE_MS, START_MS, bodyDigest, makeEnv, modelKey, testSystemPrompt, textOf, typesOf } from './harness.ts';
import { MODEL_ALIAS, textStep } from './scripts.ts';

describe('worker final answer', () => {
  it('returns idle when nothing is queued', async () => {
    const env = await makeEnv();
    expect(await env.runOnce(env.worker())).toBe('idle');
    expect(env.gateway.streams).toEqual([]);
  });

  it('completes a run with a single answer and records events in order', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('Hello there, friend.', { chunks: ['Hello ', 'there, ', 'friend.'], usage: usageOf(120, 7), itemId: 'msg_final' }));
    const run = env.enqueue('Say hello');

    expect(await env.runOnce(env.worker())).toBe('yielded');

    const events = env.events(run.id);
    expect(typesOf(events)).toEqual([
      'user.message',
      'run.started',
      'tool.offered',
      'tool.offered',
      'model.requested',
      'agent.message.delta',
      'model.responded',
      'usage.updated',
      'meter.observed',
      'run.status',
    ]);
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'run.status')).toEqual([expect.objectContaining({ from: 'RUNNING', to: 'COMPLETED' })]);

    const deltas = env.ofType(run.id, 'agent.message.delta');
    expect(deltas.map((delta) => delta.text).join('')).toBe('Hello there, friend.');
    for (const delta of deltas) expect(delta).toMatchObject({ step: 1, attempt: 1, itemId: 'msg_final' });

    const [started] = env.ofType(run.id, 'run.started');
    expect(started).toMatchObject({ attempt: 1, now: START_MS });

    const [responded] = env.ofType(run.id, 'model.responded');
    expect(responded?.step).toBe(1);
    expect(responded?.attempt).toBe(1);
    expect(responded?.response.output).toEqual([
      { type: 'message', id: 'msg_final', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Hello there, friend.', annotations: [] }] },
    ]);
    expect(responded?.response.usage).toMatchObject({ input_tokens: 120, output_tokens: 7, total_tokens: 127 });

    expect(env.ofType(run.id, 'usage.updated')).toEqual([expect.objectContaining({ inputTokens: 120, outputTokens: 7, totalTokens: 127 })]);
    expect(env.run(run.id).usage).toEqual({ inputTokens: 120, outputTokens: 7, totalTokens: 127 });
  });

  it('sends the documented request body under the step idempotency key', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('done'));
    const run = env.enqueue('Say hello');

    await env.runOnce(env.worker());

    const [requested] = env.ofType(run.id, 'model.requested');
    const [stream] = env.gateway.streams;
    if (requested === undefined || stream === undefined) throw new Error('expected one model request');
    expect(requested.step).toBe(1);
    expect(requested.attempt).toBe(1);
    expect(stream.idempotencyKey).toBe(modelKey(run.id, 1, 1));
    expect(stream.deadlineAt).toBe(DEADLINE_MS);
    expect(stream.body).toEqual(requested.body);
    expect(requested.digest).toBe(bodyDigest(requested.body));

    const body = stream.body;
    expect(Object.keys(body).sort()).toEqual(['input', 'max_output_tokens', 'metadata', 'model', 'momonga', 'parallel_tool_calls', 'prompt_cache_key', 'store', 'stream', 'tool_choice', 'tools']);
    expect(body.metadata).toEqual({ run_id: run.id, step: '1' });
    expect(body.model).toBe(MODEL_ALIAS);
    expect(body.tool_choice).toBe('auto');
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.max_output_tokens).toBe(4096);
    expect((body.tools ?? []).map((tool) => tool.name).sort()).toEqual(['Bash', 'Counter', 'Echo', 'Mark', 'Probe', 'UpdatePlan', 'Wait', 'Write']);

    const input = Array.isArray(body.input) ? body.input : [];
    expect(input[0]).toMatchObject({ type: 'message', role: 'system' });
    expect(textOf(input[0])).toBe(testSystemPrompt({ cwd: env.project, platform: process.platform }));
    expect(input.some((item) => item.type === 'message' && item.role === 'user' && textOf(item) === 'Say hello')).toBe(true);
  });

  it('passes the capability parallelToolCalls flag and the alias to the gateway', async () => {
    const env = await makeEnv();
    env.gateway.capabilitiesValue = { ...env.gateway.capabilitiesValue, parallelToolCalls: true };
    env.gateway.script.push(textStep('done'));
    env.enqueue();
    await env.runOnce(env.worker());
    expect(env.gateway.streams[0]?.body.parallel_tool_calls).toBe(true);
    expect(env.gateway.capabilityRequests).toContain(MODEL_ALIAS);
  });

  it('pins the model alias, prompt digest, tool set digest and capabilities on the first attempt', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('done'));
    const run = env.enqueue();
    await env.runOnce(env.worker());
    const toolSet = await env.snapshotTools(env.toolbox.tools());
    const [started] = env.ofType(run.id, 'run.started');
    expect(started?.pins).toEqual({
      modelAlias: MODEL_ALIAS,
      systemPromptDigest: sha256Hex(testSystemPrompt({ cwd: env.project, platform: process.platform })),
      toolSetDigest: toolSet.digest,
      capabilities: env.gateway.capabilitiesValue,
      roles: {},
      token: {},
    });
    expect(env.fold(run.id).pins).toEqual(started?.pins);
  });
});
