import { describe, expect, it } from 'vitest';
import { usageOf } from '@momonga/testkit';
import { START_MS, finalSummaryInstruction, makeEnv, modelKey, textOf } from './harness.ts';
import { assistantMessage, callsStep, failedStep, functionCallItem, incompleteStep, refusalStep, textStep } from './scripts.ts';

const lastInputItem = (input: unknown): unknown => (Array.isArray(input) ? input.at(-1) : undefined);

describe('worker stop reasons', () => {
  it('stops at max_steps from run.limits after a final summary call with tool_choice none', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([{ callId: 'call_s_1', name: 'Echo', args: { value: 'x' } }]), textStep('Summary of progress.'));
    const run = env.enqueue('Work', { limits: { maxSteps: 1 } });

    await env.runOnce(env.worker('worker-1', { defaults: { maxSteps: 50 } }));

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'max_steps' });
    expect(env.gateway.streams).toHaveLength(2);
    const [first, summary] = env.gateway.streams;
    expect(summary?.idempotencyKey).toBe(modelKey(run.id, 2));
    expect(summary?.body.tool_choice).toBe('none');
    expect(summary?.body.tools).toEqual(first?.body.tools);
    expect((summary?.body.tools ?? []).length).toBeGreaterThan(0);
    const instruction = lastInputItem(summary?.body.input);
    expect(instruction).toMatchObject({ type: 'message', role: 'developer' });
    expect(textOf(instruction)).toBe(finalSummaryInstruction('max_steps'));
    expect(env.ofType(run.id, 'model.responded').map((event) => event.step)).toEqual([1, 2]);
    expect(env.toolbox.executions.map((execution) => execution.name)).toEqual(['Echo']);
    expect(env.ofType(run.id, 'run.status').at(-1)).toMatchObject({ from: 'RUNNING', to: 'STOPPED', reason: 'max_steps' });
  });

  it('does not execute calls returned by the final summary call', async () => {
    const env = await makeEnv();
    env.gateway.script.push(
      callsStep([{ callId: 'call_s_1', name: 'Echo', args: { value: 'x' } }]),
      callsStep([{ callId: 'call_s_2', name: 'Echo', args: { value: 'y' } }]),
    );
    const run = env.enqueue('Work', { limits: { maxSteps: 1 } });

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'max_steps' });
    expect(env.toolbox.executions.map((execution) => execution.input['value'])).toEqual(['x']);
    expect(env.ofType(run.id, 'tool.started').map((event) => event.callId)).toEqual(['call_s_1']);
  });

  it('stops at the budget from run.limits after a final summary call', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([{ callId: 'call_b_1', name: 'Echo', args: { value: 'x' } }], usageOf(100, 10)), textStep('Budget summary.'));
    const run = env.enqueue('Work', { limits: { maxTotalTokens: 100 } });

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'budget' });
    expect(env.gateway.streams).toHaveLength(2);
    const summary = env.gateway.streams[1];
    expect(summary?.body.tool_choice).toBe('none');
    expect(summary?.body.tools).toEqual(env.gateway.streams[0]?.body.tools);
    expect(textOf(lastInputItem(summary?.body.input))).toBe(finalSummaryInstruction('budget'));
  });

  it('keeps going while total usage stays under the default budget of 1_000_000 tokens', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([{ callId: 'call_b_1', name: 'Echo', args: { value: 'x' } }], usageOf(100, 999_899)), textStep('Done.'));
    const run = env.enqueue('Work');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.streams[1]?.body.tool_choice).toBe('auto');
  });

  it('stops at the default budget once total usage reaches 1_000_000 tokens', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([{ callId: 'call_b_1', name: 'Echo', args: { value: 'x' } }], usageOf(100, 999_900)), textStep('Budget summary.'));
    const run = env.enqueue('Work');

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'budget' });
    expect(env.gateway.streams[1]?.body.tool_choice).toBe('none');
  });

  it('stops at timeout without an extra model call once the deadline passes', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Work', { deadlineAt: START_MS + 20_000 });
    env.toolbox.hooks['Echo'] = () => {
      env.clock.advance(20_000);
    };
    env.gateway.script.push(callsStep([{ callId: 'call_t_1', name: 'Echo', args: { value: 'x' } }]), textStep('never sent'));

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'timeout' });
    expect(env.gateway.streams).toHaveLength(1);
    expect(env.gateway.script).toHaveLength(1);
  });

  it('stops at timeout before the first model call when the deadline already passed', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Work', { deadlineAt: START_MS });

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'timeout' });
    expect(env.gateway.streams).toEqual([]);
  });

  it('stops at max_tokens when an incomplete response has no function call', async () => {
    const env = await makeEnv();
    env.gateway.script.push(incompleteStep([assistantMessage('msg_cut', 'This answer was cut')]));
    const run = env.enqueue('Write a long essay');

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'max_tokens' });
    const [responded] = env.ofType(run.id, 'model.responded');
    expect(responded?.response.output).toEqual([assistantMessage('msg_cut', 'This answer was cut')]);
    expect(env.gateway.streams).toHaveLength(1);
  });

  it('executes function calls that completed inside an incomplete response and continues', async () => {
    const env = await makeEnv();
    env.gateway.script.push(
      incompleteStep([functionCallItem({ callId: 'call_i_1', name: 'Echo', args: { value: 'kept' } })]),
      textStep('Finished.'),
    );
    const run = env.enqueue('Work');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.toolbox.executions.map((execution) => execution.input['value'])).toEqual(['kept']);
    expect(env.ofType(run.id, 'tool.completed')).toEqual([expect.objectContaining({ callId: 'call_i_1', output: 'echo:kept' })]);
  });

  it('stops at refusal on a guardrail_violation failure without retrying', async () => {
    const env = await makeEnv();
    env.gateway.script.push(failedStep('guardrail_violation', 'model_error'), textStep('never sent'));
    const run = env.enqueue('Do something unsafe');

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'refusal' });
    expect(env.gateway.streams).toHaveLength(1);
    expect(await env.runOnce(env.worker('worker-2'))).toBe('idle');
    expect(env.gateway.streams).toHaveLength(1);
  });

  it('stops at refusal when the response carries a refusal part, recording the response', async () => {
    const env = await makeEnv();
    env.gateway.script.push(refusalStep('I cannot help with that.'));
    const run = env.enqueue('Do something unsafe');

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'refusal' });
    const [responded] = env.ofType(run.id, 'model.responded');
    expect(responded?.response.output).toEqual([expect.objectContaining({ content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] })]);
  });
});
