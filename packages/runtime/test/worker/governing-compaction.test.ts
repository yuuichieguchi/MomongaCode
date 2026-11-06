import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineTool } from '@momonga/tools';
import { capabilitiesFor, makeEnv, textOf } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';
import { bigStep, bigTool, padOf, WITHIN_TURN_PROMPT } from './within-turn-support.ts';

const readTool = defineTool<{ file_path: string }>({
  name: 'Read',
  description: 'Reads a file',
  kind: 'read',
  sideEffect: 'read_only',
  inputSchema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'], additionalProperties: false },
  timeoutMs: 60_000,
  title: (input) => `Read ${input.file_path}`,
  locations: (input, ctx) => [{ path: path.resolve(ctx.cwd, input.file_path) }],
  subject: () => ({ kind: 'none', tool: 'Read' }),
  execute: async () => ({ status: 'completed', output: 'contents' }),
});

describe('a path-scoped governing fact across a compaction', () => {
  it('stays in the context after the compaction replaced the call that touched its path', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(4000) });
    env.store.governing.add({
      kind: 'constraint',
      target: 'legacy',
      text: 'Legacy code is frozen.',
      scope: { level: 'project', project: env.session.cwd, paths: ['legacy/**'] },
      validUntil: null,
      supersedes: [],
      enforcement: null,
      source: { kind: 'command' },
    });
    env.gateway.script.push(
      callsStep([{ callId: 'k_read', name: 'Read', args: { file_path: 'legacy/a.ts' } }]),
      ...[0, 1, 2, 3, 4, 5].map((index) => bigStep(`k${index}`, { letter: 'a', size: 0, pad: padOf(index, 1550) })),
      textStep('done'),
    );
    env.gateway.compactSummaries.push('S1');
    const run = env.enqueue('Work on the parser');

    await env.runOnce(env.worker('worker-1', { toolList: () => [readTool, bigTool()], systemPrompt: () => WITHIN_TURN_PROMPT }));

    expect(env.run(run.id).status).toBe('COMPLETED');
    const [compacted] = env.ofType(run.id, 'context.compacted');
    const readCall = env.ofType(run.id, 'tool.call').find((event) => event.name === 'Read');
    expect(readCall).toBeDefined();
    expect(compacted?.replacedThroughSeq).toBeGreaterThanOrEqual(3);
    const texts = env.gateway.streams.map((stream) => (stream.body.input as unknown[]).map(textOf).join('\n'));
    const first = texts[0] ?? '';
    const afterRead = texts[1] ?? '';
    const last = texts.at(-1) ?? '';
    expect(first).not.toContain('Legacy code is frozen.');
    expect(afterRead).toContain('Legacy code is frozen.');
    expect(last).not.toContain('legacy/a.ts');
    expect(last).toContain('Legacy code is frozen.');
    const loaded = env.ofType(run.id, 'context.governing_loaded').map((event) => event.active.length);
    expect(loaded).toEqual([1]);
  });
});
