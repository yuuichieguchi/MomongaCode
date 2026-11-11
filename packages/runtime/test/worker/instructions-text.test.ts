import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeEnv, textOf } from './harness.ts';
import { textStep } from './scripts.ts';

describe('worker instructions.loaded', () => {
  it('records the text the request carried even when the file changes right after the build read it', async () => {
    const env = await makeEnv();
    const agentsPath = path.join(env.project, 'AGENTS.md');
    env.instructions.files.set(agentsPath, 'Rule A: keep diffs small.');
    const read = env.instructions.read;
    env.instructions.read = async (filePath) => {
      const file = await read(filePath);
      if (filePath === agentsPath && file !== undefined) env.instructions.files.set(agentsPath, 'Rule B: rewrite everything.');
      return file;
    };
    env.gateway.script.push(textStep('Done.'));
    const run = await env.enqueue('Work');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    const input = env.gateway.streams[0]?.body.input;
    if (!Array.isArray(input)) throw new Error('expected an input array');
    expect(input.some((item) => textOf(item).includes('Rule A: keep diffs small.'))).toBe(true);
    expect(env.ofType(run.id, 'instructions.loaded').map((event) => [event.path, event.content])).toEqual([[agentsPath, 'Rule A: keep diffs small.']]);
  });
});
