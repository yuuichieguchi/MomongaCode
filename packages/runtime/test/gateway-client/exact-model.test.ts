import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { capabilitiesFor, makeEnv } from '../worker/harness.ts';
import type { Env } from '../worker/harness.ts';
import { callsStep, textStep } from '../worker/scripts.ts';
import { startService } from '../service/helpers.ts';
import { OTHER_MODEL_ID } from '../service/helpers.ts';

const WINDOW = 40_000;
const MAX_CLAIMS = 8;
const USAGE = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };
const SAFE = JSON.stringify({ verdict: 'safe', confidence: 'high', rationale: 'writes a file the user asked for' });

const responded = (step: number, text: string): RunEventPayload => ({
  type: 'model.responded',
  step,
  attempt: 1,
  response: { id: `resp_${step}`, status: 'completed', output: [{ type: 'message', id: `msg_${step}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }], usage: USAGE },
});

const drive = async (env: Env, runId: string): Promise<void> => {
  for (let claim = 0; claim < MAX_CLAIMS && !['COMPLETED', 'FAILED', 'STOPPED'].includes(env.run(runId).status); claim += 1) await env.runOnce(env.worker());
};

describe('the requests the runtime itself sends to the gateway name the model by its full reference only (design-model-names 2.2, 4.11)', () => {
  it('sends momonga.exact_model true with the model step, its token counts, the compaction, and the count and the call of the classifier', async () => {
    const stepped = await makeEnv({ capabilities: capabilitiesFor(WINDOW) });
    const run = stepped.enqueue('question one');
    await stepped.seed(
      run.id,
      [
        responded(1, `long ${'x'.repeat(120_000)}`),
        { type: 'user.message', text: 'question two' },
        responded(2, 'answer two'),
        { type: 'user.message', text: 'question three' },
        responded(3, 'answer three'),
        { type: 'user.message', text: 'question four' },
      ],
      'release',
    );
    stepped.gateway.compactSummaries.push('GOAL:\ng\nSTATE:\ns\nDONE:\nd\nTODO:\nt\nDECISIONS:\nx\nGUARDRAILS:\ny');
    stepped.gateway.script.push(textStep('Done.'));
    await drive(stepped, run.id);
    expect(stepped.run(run.id).status).toBe('COMPLETED');
    expect(stepped.gateway.streams.length).toBeGreaterThan(0);
    for (const stream of stepped.gateway.streams) expect(stream.body.momonga?.exact_model).toBe(true);
    expect(stepped.gateway.counts.length).toBeGreaterThan(0);
    for (const count of stepped.gateway.counts) expect(count.momonga?.exact_model).toBe(true);
    expect(stepped.gateway.compacts.length).toBeGreaterThan(0);
    for (const compact of stepped.gateway.compacts) expect(compact.request.momonga?.exact_model).toBe(true);

    const judged = await makeEnv({ mode: 'auto' });
    judged.settings.classifierModel = 'guard';
    judged.gateway.capabilitiesByModel['guard'] = capabilitiesFor(judged.gateway.capabilitiesValue.contextWindow, { structuredOutput: 'json_schema' });
    judged.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: path.join(judged.project, 'out.txt'), content: 'x' } }]), textStep(SAFE), textStep('Written.'));
    const guarded = judged.enqueue('Write out.txt');
    await drive(judged, guarded.id);
    const classifierStreams = judged.gateway.streams.filter((stream) => stream.role === 'classifier');
    expect(classifierStreams.map((stream) => [stream.body.model, stream.body.momonga?.exact_model])).toEqual([['guard', true]]);
    const classifierCounts = judged.gateway.counts.filter((count) => count.model === 'guard');
    expect(classifierCounts.length).toBeGreaterThan(0);
    for (const count of classifierCounts) expect(count.momonga?.exact_model).toBe(true);
  });

  it('takes the start model and the roles from the listing of the gateway: the settings port offers neither', async () => {
    const service = await startService();
    service.ports.start.model = OTHER_MODEL_ID;
    expect((await service.createSession()).model).toBe(OTHER_MODEL_ID);

    const env = await makeEnv();
    expect(env.settings).not.toHaveProperty('modelRoles');
    expect(env.settings).not.toHaveProperty('modelTargets');
    env.gateway.roles = { reflection: 'cheap' };
    env.gateway.script.push(textStep('done'));
    const run = env.enqueue('Work');
    await drive(env, run.id);
    expect(env.ofType(run.id, 'run.started')[0]?.pins['roles']).toEqual({ reflection: 'cheap' });
  });
});
