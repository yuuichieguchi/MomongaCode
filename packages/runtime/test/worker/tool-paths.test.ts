import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBuiltinTools } from '@momonga/tools';
import { makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

describe('file tool paths in the worker', () => {
  it('resolves a relative path against the session working directory and shows it relative in tool.call and the result', async () => {
    const env = await makeEnv({ mode: 'acceptEdits' });
    const target = path.join(env.project, 'notes.txt');
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: 'notes.txt', content: 'hi' } }]), textStep('Written.'));
    const run = env.enqueue('Write notes');

    await env.runOnce(env.worker('worker-1', { toolList: () => createBuiltinTools() }));

    expect(env.ofType(run.id, 'tool.call')[0]).toMatchObject({ kind: 'edit', title: 'Write notes.txt', locations: [{ path: target }] });
    expect(env.ofType(run.id, 'tool.completed')[0]).toMatchObject({ status: 'completed', output: 'Created notes.txt (1 line)' });
    expect(fs.readFileSync(target, 'utf8')).toBe('hi');
  });

  it('shows an absolute path inside the working directory relative in tool.call', async () => {
    const env = await makeEnv({ mode: 'acceptEdits' });
    const target = path.join(env.project, 'src', 'a.txt');
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'a' } }]), textStep('Written.'));
    const run = env.enqueue('Write a');

    await env.runOnce(env.worker('worker-1', { toolList: () => createBuiltinTools() }));

    expect(env.ofType(run.id, 'tool.call')[0]).toMatchObject({ title: 'Write src/a.txt', locations: [{ path: target }] });
    expect(env.ofType(run.id, 'tool.completed')[0]).toMatchObject({ status: 'completed', output: 'Created src/a.txt (1 line)' });
  });
});
