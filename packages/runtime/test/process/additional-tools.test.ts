import { describe, expect, it } from 'vitest';
import { defineTool } from '@momonga/tools';
import { createRun, createSession, makeRuntimeFixture, signalNever } from './helpers.ts';

const extraTool = defineTool<Record<string, unknown>>({
  name: 'activate_skill',
  description: 'Activates a skill',
  kind: 'read',
  sideEffect: 'read_only',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  timeoutMs: 1000,
  title: () => 'Activate',
  subject: () => ({ kind: 'none', tool: 'activate_skill' }),
  execute: async () => ({ status: 'completed', output: '' }),
});

const env = Object.freeze({ PATH: '/usr/bin:/bin' });

describe('toolSet additionalTools', () => {
  it('adds the given tools next to the builtins', async () => {
    const f = await makeRuntimeFixture();
    const runId = createRun(f.store, createSession(f.store, f.temp.project).id);

    const set = await f.toolRuntime.port.toolSet(runId, { signal: signalNever(), env, additionalTools: [extraTool] });

    expect(set.get('activate_skill')).toBe(extraTool);
    expect(set.get('Read')).toBeDefined();
  });

  it('changes the tool set digest with the tool, so a changed enum shows as a changed tool set', async () => {
    const f = await makeRuntimeFixture();
    const runId = createRun(f.store, createSession(f.store, f.temp.project).id);
    const without = await f.toolRuntime.port.toolSet(runId, { signal: signalNever(), env });
    const withTool = await f.toolRuntime.port.toolSet(runId, { signal: signalNever(), env, additionalTools: [extraTool] });
    expect(withTool.digest).not.toBe(without.digest);
  });

  it('rejects a tool whose name collides with a builtin', async () => {
    const f = await makeRuntimeFixture();
    const runId = createRun(f.store, createSession(f.store, f.temp.project).id);
    const clash = defineTool<Record<string, unknown>>({ ...extraTool, name: 'Read' });
    await expect(f.toolRuntime.port.toolSet(runId, { signal: signalNever(), env, additionalTools: [clash] })).rejects.toThrow('duplicate tool name "Read"');
  });
});
