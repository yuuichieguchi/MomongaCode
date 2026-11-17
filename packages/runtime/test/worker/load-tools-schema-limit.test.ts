import { describe, expect, it } from 'vitest';
import { TOOL_USAGE_WINDOW_RUNS } from '@momonga/memory';
import { MAX_TOOL_PARAMETERS_BYTES } from '@momonga/protocol';
import { defineTool } from '@momonga/tools';
import type { AnyTool } from '@momonga/tools';
import { TOKEN_SETTINGS_OFF } from './fake-settings.ts';
import { capabilitiesFor, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const LOADER = 'LoadTools';
const ECHO = 'Echo';

const oversizedTool = (): AnyTool =>
  defineTool<Record<string, unknown>>({
    name: 'Huge',
    description: 'A tool whose schema is larger than one definition may be.',
    kind: 'read',
    sideEffect: 'read_only',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'x'.repeat(MAX_TOOL_PARAMETERS_BYTES + 1) } },
      required: ['query'],
      additionalProperties: false,
    },
    timeoutMs: 1_000,
    title: () => 'Huge',
    subject: () => ({ kind: 'none', tool: 'Huge' }),
    execute: async () => ({ status: 'completed', output: 'huge' }),
  });

const echoOnly = (env: Env) => (): AnyTool[] => env.toolbox.tools().filter((tool) => tool.name === ECHO);

describe('a load whose definition exceeds the tool parameter limit', () => {
  it('is refused before the gateway call, names the limit, and the run goes on without it', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(200_000) });
    env.settings.toolsValue = { ...env.settings.toolsValue, deferral: true };
    env.settings.contextValue = { ...TOKEN_SETTINGS_OFF };
    const extra = [oversizedTool()];
    const warm = env.worker('warm', { toolList: () => [...echoOnly(env)(), ...extra] });
    for (let index = 0; index < TOOL_USAGE_WINDOW_RUNS; index += 1) {
      env.gateway.script.push(callsStep([{ callId: `warm-${index}`, name: ECHO, args: { value: 'x' } }]), textStep('Done.'));
      const warmRun = await env.enqueue(`warm ${index}`, { history: 'fresh' });
      await env.runOnce(warm);
      expect(env.run(warmRun.id).status).toBe('COMPLETED');
    }
    env.gateway.script.push(callsStep([{ callId: 'load-huge', name: LOADER, args: { names: ['Huge'] } }]), textStep('Done.'));
    const run = await env.enqueue('Use the tools', { history: 'fresh' });
    await env.runOnce(env.worker('main', { toolList: () => [...echoOnly(env)(), ...extra] }));

    const loadCall = env.ofType(run.id, 'tool.call').find((event) => event.name === LOADER);
    const load = env.ofType(run.id, 'tool.completed').find((event) => event.callId === loadCall?.callId);
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(load?.status).toBe('failed');
    expect(load?.output).toContain('Huge');
    expect(load?.output).toContain(`${MAX_TOOL_PARAMETERS_BYTES} bytes`);
    expect(env.ofType(run.id, 'tool.loaded')).toEqual([]);
  });
});
