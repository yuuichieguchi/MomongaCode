import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RuntimeStore } from '@momonga/store';
import { makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

describe('worker event reads per claim', () => {
  it('reads on the loop only the tail beyond the state the journal thread loaded, apart from the single first event', async () => {
    const env = await makeEnv();
    const agentsPath = path.join(env.project, 'AGENTS.md');
    env.instructions.files.set(agentsPath, 'Prefer small diffs.');
    const target = path.join(env.project, 'out.txt');
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'x' } }]));
    const run = await env.enqueue('Write the file');
    await env.runOnce(env.worker('worker-1'));
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    const loadedThrough = env.run(run.id).lastSeq;
    await env.resolveApproval(run.id, 'allow_once');
    env.gateway.script.push(textStep('Written.'));
    const reads: { afterSeq: number; limit: number }[] = [];
    const store: RuntimeStore = {
      ...env.store,
      readRunEvents: (runId, afterSeq, limit) => {
        reads.push({ afterSeq, limit });
        return env.store.readRunEvents(runId, afterSeq, limit);
      },
    };

    await env.runOnce(env.worker('worker-2', { store }));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(reads.filter((read) => read.afterSeq < loadedThrough && read.limit > 1)).toEqual([]);
    expect(env.ofType(run.id, 'instructions.loaded')).toHaveLength(1);
  });
});
