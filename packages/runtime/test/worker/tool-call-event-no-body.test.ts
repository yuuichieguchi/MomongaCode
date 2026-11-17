import { describe, expect, it } from 'vitest';
import { defineTool } from '@momonga/tools';
import { makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

describe('the tool.call event of a call with a large argument', () => {
  it('carries the call reference and not a copy of the arguments; the model response keeps them', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const body = 'a'.repeat(4000);
    const note = defineTool<{ content: string }>({
      name: 'Note',
      description: 'Keeps a note',
      kind: 'other',
      sideEffect: 'read_only',
      inputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false },
      timeoutMs: 60_000,
      title: () => 'Note',
      subject: () => ({ kind: 'none', tool: 'Note' }),
      execute: async () => ({ status: 'completed', output: 'kept' }),
    });
    env.gateway.script.push(callsStep([{ callId: 'c1', name: 'Note', args: { content: body } }]), textStep('Done.'));
    const run = await env.enqueue('Keep the note');

    await env.runOnce(env.worker('w1', { toolList: () => [note] }));

    expect(env.run(run.id).status).toBe('COMPLETED');
    const [call] = env.ofType(run.id, 'tool.call');
    expect(call).toMatchObject({ name: 'Note' });
    expect(call).not.toHaveProperty('rawInput');
    expect(JSON.stringify(call)).not.toContain(body);
    expect(JSON.stringify(env.gateway.streams[1]?.body.input)).toContain(body);
  });
});
