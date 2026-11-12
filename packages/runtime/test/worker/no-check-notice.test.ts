import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_CHECK_DECLARED_CODE } from '@momonga/runtime';
import { makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

describe('a run that changed the workspace with no declared check', () => {
  it('completes unverified with one notice that names how to declare a check', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.gateway.script.push(callsStep([{ callId: 'call_w', name: 'Write', args: { file_path: path.join(env.project, 'out.txt'), content: 'x' } }]), textStep('Written.'));
    const run = await env.enqueue('Write the file');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    const notes = env.fold(run.id).notes.filter((note) => note.code === NO_CHECK_DECLARED_CODE);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.message).toContain('verification.commands');
  });

  it('gives no such notice when the run changed nothing', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    env.gateway.script.push(textStep('Nothing to change.'));
    const run = await env.enqueue('Look around');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.fold(run.id).notes.filter((note) => note.code === NO_CHECK_DECLARED_CODE)).toEqual([]);
  });
});
