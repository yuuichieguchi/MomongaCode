import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { usageOf } from '@momonga/testkit';
import { capabilitiesFor, makeEnv } from './harness.ts';
import { assistantMessage, callsStep, textStep } from './scripts.ts';

const responded = (step: number, output: unknown[]): RunEventPayload => ({
  type: 'model.responded',
  step,
  attempt: 1,
  response: { status: 'completed', output, usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 } },
});

const verdict = JSON.stringify({ verdict: 'safe', confidence: 'high', rationale: 'writes the file the user asked for' });

describe('token spend outside the main model calls counts against the run', () => {
  it('charges a compaction call to the run, in the row, the fold and the tree total', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(40_000) });
    const run = env.enqueue('Task one');
    env.seed(
      run.id,
      [
        responded(1, [assistantMessage('msg_big', 'x'.repeat(100_000))]),
        { type: 'user.message', text: 'question two' },
        responded(2, [assistantMessage('msg_r2', 'answer two')]),
        { type: 'user.message', text: 'question three' },
        responded(3, [assistantMessage('msg_r3', 'answer three')]),
        { type: 'user.message', text: 'question four' },
      ],
      'release',
    );
    env.gateway.script.push(textStep('Answer four.', { usage: usageOf(20, 2) }));

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.compacts).toHaveLength(1);
    expect(env.ofType(run.id, 'usage.charged')).toEqual([
      expect.objectContaining({ purpose: 'compaction', inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
    ]);
    const expected = { inputTokens: 150 + 10 + 20, outputTokens: 15 + 5 + 2, totalTokens: 165 + 15 + 22 };
    expect(env.run(run.id).usage).toEqual(expected);
    expect(env.fold(run.id).usage).toEqual(expected);
    expect(env.store.treeTokens(run.id)).toBe(expected.totalTokens);
  });

  it('stops a run at its token budget when the classifier spend alone exhausts it', async () => {
    const env = await makeEnv({ mode: 'auto' });
    env.settings.classifierAlias = 'guard';
    env.gateway.capabilitiesByAlias['guard'] = capabilitiesFor(100_000, { structuredOutput: 'json_schema' });
    const target = path.join(env.project, 'out.txt');
    env.gateway.script.push(
      callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'x' } }], usageOf(100, 10)),
      textStep(verdict, { usage: usageOf(500, 450) }),
      textStep('Summary.', { usage: usageOf(5, 5) }),
    );
    const run = env.enqueue('Write out.txt', { limits: { maxTotalTokens: 1000 } });

    await env.runOnce(env.worker());

    expect(fs.readFileSync(target, 'utf8')).toBe('x');
    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'budget' });
    expect(env.ofType(run.id, 'usage.charged')).toEqual([
      expect.objectContaining({ purpose: 'permission_classifier', inputTokens: 500, outputTokens: 450, totalTokens: 950 }),
    ]);
    expect(env.run(run.id).usage.totalTokens).toBe(110 + 950 + 10);
    expect(env.fold(run.id).usage).toEqual(env.run(run.id).usage);
  });

  it('copies the answering target of the compaction resource into its usage.charged (D17 section 7)', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(40_000) });
    const run = env.enqueue('Task one');
    env.seed(
      run.id,
      [
        responded(1, [assistantMessage('msg_big', 'x'.repeat(100_000))]),
        { type: 'user.message', text: 'question two' },
        responded(2, [assistantMessage('msg_r2', 'answer two')]),
        { type: 'user.message', text: 'question three' },
        responded(3, [assistantMessage('msg_r3', 'answer three')]),
        { type: 'user.message', text: 'question four' },
      ],
      'release',
    );
    env.gateway.script.push(textStep('Answer four.', { usage: usageOf(20, 2) }));

    await env.runOnce(env.worker());

    expect(env.gateway.compacts).toHaveLength(1);
    expect(env.ofType(run.id, 'usage.charged')).toEqual([expect.objectContaining({ purpose: 'compaction', target: 'primary' })]);
  });

  it('copies the answering target of the classifier response into its usage.charged (D17 section 7)', async () => {
    const env = await makeEnv({ mode: 'auto' });
    env.settings.classifierAlias = 'guard';
    env.gateway.capabilitiesByAlias['guard'] = capabilitiesFor(100_000, { structuredOutput: 'json_schema' });
    env.gateway.targetsByAlias['guard'] = ['guard-target'];
    const target = path.join(env.project, 'out.txt');
    env.gateway.script.push(
      callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'x' } }], usageOf(100, 10)),
      textStep(verdict, { usage: usageOf(5, 5) }),
      textStep('Summary.', { usage: usageOf(5, 5) }),
    );
    const run = env.enqueue('Write out.txt');

    await env.runOnce(env.worker());

    expect(env.ofType(run.id, 'usage.charged')).toEqual([expect.objectContaining({ purpose: 'permission_classifier', target: 'guard-target' })]);
  });
});
