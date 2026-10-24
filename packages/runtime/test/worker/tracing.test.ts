import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

describe('worker tracing', () => {
  it('opens one invoke_agent span per claim and one execute_tool span per call, propagating traceparent', async () => {
    const env = await makeEnv();
    env.gateway.script.push(
      callsStep([
        { callId: 'call_p_1', name: 'Probe', args: { value: 'one' } },
        { callId: 'call_p_2', name: 'Probe', args: { value: 'two' } },
      ]),
      textStep('Probed.'),
    );
    const run = env.enqueue('Probe twice');

    await env.runOnce(env.worker());

    const agents = env.tracer.spans.filter((span) => span.kind === 'agent');
    const tools = env.tracer.spans.filter((span) => span.kind === 'tool');
    expect(agents).toHaveLength(1);
    expect(agents[0]?.input).toMatchObject({ runId: run.id, sessionId: env.session.id, attempt: 1 });
    expect(tools.map((span) => span.input['callId']).sort()).toEqual([env.gateway.callId('call_p_1'), env.gateway.callId('call_p_2')]);
    for (const span of tools) {
      expect(span.parent).toBe(agents[0]?.traceparent);
      expect(span.input).toMatchObject({ runId: run.id, step: 1, toolName: 'Probe' });
    }
    expect(env.tracer.spans.every((span) => span.ended === 1)).toBe(true);

    expect(env.gateway.streams.map((stream) => stream.traceparent)).toEqual([agents[0]?.traceparent, agents[0]?.traceparent]);
    for (const execution of env.toolbox.executions) {
      const span = tools.find((candidate) => candidate.input['callId'] === execution.callId);
      expect(execution.traceparent).toBe(span?.traceparent);
    }
  });

  it('opens a fresh invoke_agent span for each claim of the same run', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: path.join(env.project, 'a.txt'), content: 'a' } }]));
    const run = env.enqueue('Write');
    await env.runOnce(env.worker('worker-1'));
    env.resolveApproval(run.id, 'allow_once');
    env.gateway.script.push(textStep('Written.'));
    await env.runOnce(env.worker('worker-2'));

    const agents = env.tracer.spans.filter((span) => span.kind === 'agent');
    expect(agents.map((span) => span.input['attempt'])).toEqual([1, 2]);
    expect(agents.every((span) => span.ended === 1)).toBe(true);
    expect(env.gateway.streams[1]?.traceparent).toBe(agents[1]?.traceparent);
  });
});
