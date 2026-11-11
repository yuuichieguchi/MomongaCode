import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineTool } from '@momonga/tools';
import type { AnyTool } from '@momonga/tools';
import { makeEnv, textOf } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const FACT = 'Legacy code is frozen.';

const addLegacyFact = (env: Env): void => {
  env.store.governing.add({
    kind: 'constraint',
    target: 'legacy',
    text: FACT,
    scope: { level: 'project', project: env.session.cwd, paths: ['legacy/**'] },
    validUntil: null,
    supersedes: [],
    enforcement: null,
    source: { kind: 'command' },
  });
};

const locatingTool = (name: string, cwd: string): AnyTool =>
  defineTool<{ page: string }>({
    name,
    description: 'Opens a page of a document server',
    kind: 'read',
    sideEffect: 'read_only',
    inputSchema: { type: 'object', properties: { page: { type: 'string' } }, required: ['page'], additionalProperties: false },
    timeoutMs: 60_000,
    title: (input) => `Open ${input.page}`,
    subject: () => ({ kind: 'none', tool: name }),
    locations: (input) => [{ path: path.join(cwd, input.page) }],
    execute: async () => ({ status: 'completed', output: 'page contents' }),
  }) as AnyTool;

const requestTexts = (env: Env, from = 0): string[] =>
  env.gateway.streams.slice(from).map((stream) => (stream.body.input as unknown[]).map(textOf).join('\n'));

describe('path-scoped governing facts activate from the session record of declared locations', () => {
  it('a tool added later that declares a location activates a fact without any tool list being edited', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    addLegacyFact(env);
    const tool = locatingTool('mcp__docs__open_page', env.session.cwd);
    env.gateway.script.push(callsStep([{ callId: 'k_open', name: 'mcp__docs__open_page', args: { page: 'legacy/a.ts' } }]), textStep('done'));
    const run = await env.enqueue('Work on the parser');
    await env.runOnce(env.worker('worker-1', { toolList: () => [tool] }));
    expect(env.run(run.id).status).toBe('COMPLETED');
    const [first, second] = requestTexts(env);
    expect(first).not.toContain(FACT);
    expect(second).toContain(FACT);
  });

  it('a fact added mid-session activates against paths touched earlier', async () => {
    const env = await makeEnv({ mode: 'bypassPermissions' });
    const tool = locatingTool('mcp__docs__open_page', env.session.cwd);
    env.gateway.script.push(callsStep([{ callId: 'k_open', name: 'mcp__docs__open_page', args: { page: 'legacy/a.ts' } }]), textStep('done'));
    const first = await env.enqueue('Look at the legacy parser');
    await env.runOnce(env.worker('worker-1', { toolList: () => [tool] }));
    expect(env.run(first.id).status).toBe('COMPLETED');
    expect(requestTexts(env).join('\n')).not.toContain(FACT);

    addLegacyFact(env);
    const before = env.gateway.streams.length;
    env.gateway.script.push(textStep('ok'));
    const second = await env.enqueue('Now continue', { history: 'fresh' });
    await env.runOnce(env.worker('worker-2', { toolList: () => [tool] }));
    expect(env.run(second.id).status).toBe('COMPLETED');
    expect(requestTexts(env, before)[0]).toContain(FACT);
  });
});
