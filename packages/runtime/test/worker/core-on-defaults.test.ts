import { describe, expect, it } from 'vitest';
import { defaultContextSettings, defaultToolsSettings } from '@momonga/config';
import { DEFAULT_MEMORY_SHARE, TOOL_USAGE_WINDOW_RUNS } from '@momonga/memory';
import type { Run, Session } from '@momonga/store';
import { tokenPinFor, tokenPolicyOf } from '../../src/worker/token-pin.ts';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const SESSION = { id: 'sess-1', cwd: '/work/a' } as unknown as Session;
const ROOT_RUN = { id: 'run-root', parentRunId: null } as unknown as Run;
const EVERY_FORMATTER = ['log', 'json', 'grep', 'identicalOutput'];
const WORK_TOOLS = ['Echo', 'Counter', 'Write'];

const defaultsEnv = async (): Promise<Env> => {
  const env = await makeEnv();
  env.settings.contextValue = defaultContextSettings();
  env.settings.toolsValue = defaultToolsSettings();
  return env;
};

describe('the token pin under the shipped defaults (design core-on 1, test 4)', () => {
  it('pins every on key for a new root run, and a run recorded without a token pin still recovers with every key off', async () => {
    const settings = { context: async () => defaultContextSettings(), tools: async () => defaultToolsSettings() };
    const pin = await tokenPinFor({ store: { readRunEventsOfTypes: () => [] }, settings, session: SESSION, run: ROOT_RUN });

    expect(pin).toEqual({ cachePrefix: true, conciseDescriptions: true, outputFormatters: EVERY_FORMATTER, loopGuidance: true, observedCapacity: true });
    expect(tokenPolicyOf(undefined)).toEqual({ cachePrefix: false, conciseDescriptions: false, loopGuidance: false, observedCapacity: false, outputFormatters: [], deferred: undefined });
  });

  it('records the run-scoped core keys on run.started of the first run of a folder: the on token pin with an empty deferred set, and the memory share of the adaptive budget', async () => {
    const env = await defaultsEnv();
    env.gateway.script.push(textStep('Done.'));
    const run = await env.enqueue('say done');
    await env.runOnce(env.worker());

    expect(env.ofType(run.id, 'run.started')[0]?.pins['token']).toEqual({
      cachePrefix: true,
      conciseDescriptions: true,
      outputFormatters: EVERY_FORMATTER,
      loopGuidance: true,
      observedCapacity: true,
      deferred: [],
    });
    expect(env.ofType(run.id, 'run.started')[0]?.pins['memoryShare']).toBe(DEFAULT_MEMORY_SHARE);
  });
});

describe('a deferred tool called before LoadTools under the shipped defaults (design core-on 5 R6, test 5)', () => {
  it('fails the call with the recoverable message, runs nothing, and lets the run complete', async () => {
    const env = await defaultsEnv();
    const toolList = () => env.toolbox.tools().filter((tool) => WORK_TOOLS.includes(tool.name));
    const warm = env.worker('warm', { toolList });
    for (let index = 0; index < TOOL_USAGE_WINDOW_RUNS; index += 1) {
      env.gateway.script.push(callsStep([{ callId: `warm-${index}`, name: 'Echo', args: { value: 'x' } }]), textStep('Done.'));
      await env.enqueue(`warm ${index}`, { history: 'fresh' });
      await env.runOnce(warm);
    }

    env.gateway.script.push(callsStep([{ callId: 'count-1', name: 'Counter', args: { value: 'x' } }]), textStep('Done.'));
    const run = await env.enqueue('Use the tools', { history: 'fresh' });
    await env.runOnce(env.worker('main', { toolList }));
    const call = env.ofType(run.id, 'tool.call').find((event) => event.name === 'Counter');
    const completed = env.ofType(run.id, 'tool.completed').find((event) => event.callId === call?.callId);

    expect(completed?.status).toBe('failed');
    expect(completed?.output).toContain('load it with LoadTools first');
    expect(env.toolbox.executions.filter((execution) => execution.name === 'Counter')).toEqual([]);
    expect(env.run(run.id).status).toBe('COMPLETED');
  });
});
