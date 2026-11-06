import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOL_USAGE_WINDOW_RUNS } from '@momonga/memory';
import type { FunctionTool } from '@momonga/protocol';
import { capabilitiesFor, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const LOADER = 'LoadTools';
const WORK_TOOLS = ['Echo', 'Counter', 'Write'];
const LIVE_RATIO = 0.5;

const namesOf = (body: unknown): string[] => ((body as { tools?: FunctionTool[] }).tools ?? []).map((tool) => tool.name);
const withoutLoader = (names: readonly string[]): string[] => names.filter((name) => name !== LOADER);

const workTools = (env: Env) => () => env.toolbox.tools().filter((tool) => WORK_TOOLS.includes(tool.name));

const PINNED_WINDOW = 1300;

const pinnedDigestsOf = (env: Env, runId: string): string[] =>
  env.ofType(runId, 'run.started').map((event) => (event.pins as { toolSetDigest: string }).toolSetDigest);

describe('decision 52 across a resume whose build drops a tool', () => {
  it('keeps the offered order of the remaining tools, the pinned digest, and records no tools_changed', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(PINNED_WINDOW, { maxOutputTokens: 1024 }) });
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: true };
    const warm = env.worker('warm', { toolList: workTools(env) });
    for (let index = 0; index < TOOL_USAGE_WINDOW_RUNS; index += 1) {
      env.gateway.script.push(callsStep([{ callId: `warm-${index}`, name: 'Echo', args: { value: 'x' } }]), textStep('Done.'));
      env.enqueue(`warm ${index}`, { history: 'fresh' });
      await env.runOnce(warm);
    }
    env.gateway.script.push(
      callsStep([{ callId: 'load-1', name: LOADER, args: { names: ['Counter', 'Write'] } }]),
      callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: path.join(env.project, 'out.txt'), content: 'one' } }]),
    );
    const run = env.enqueue('Use the tools', { history: 'fresh' });
    await env.runOnce(env.worker('worker-1', { toolList: workTools(env) }));
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    const beforeResume = env.ofType(run.id, 'model.requested').map((event) => withoutLoader(namesOf(event.body)));
    expect(beforeResume).toEqual([['Echo'], ['Echo', 'Counter', 'Write']]);
    const digestsBefore = pinnedDigestsOf(env, run.id);

    await env.resolveApproval(run.id, 'allow_once');
    env.gateway.script.push(textStep('Written.'));
    env.gateway.capabilitiesValue = capabilitiesFor(2 * PINNED_WINDOW, { maxOutputTokens: 1024, tokenErrorRatio: LIVE_RATIO });
    await env.runOnce(env.worker('worker-2', { toolList: workTools(env) }));

    expect(env.run(run.id).status).toBe('COMPLETED');
    const resumed = namesOf(env.ofType(run.id, 'model.requested').at(-1)?.body);
    expect(resumed).not.toContain('Write');
    expect(env.ofType(run.id, 'notice').map((notice) => notice.code)).toContain('tools_dropped');
    expect(withoutLoader(resumed)).toEqual(['Echo', 'Counter']);
    expect(new Set(pinnedDigestsOf(env, run.id))).toEqual(new Set(digestsBefore));
    expect(env.ofType(run.id, 'notice').filter((notice) => notice.code === 'tools_changed')).toEqual([]);
  });
});
