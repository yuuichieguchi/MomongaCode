import { describe, expect, it } from 'vitest';
import { MIN_ROOM_TOKENS, inputCeilingFor } from '@momonga/context';
import type { Capabilities } from '@momonga/protocol';
import { createGovernancePort } from '@momonga/runtime';
import { defineTool } from '@momonga/tools';
import type { AnyTool } from '@momonga/tools';
import { inputTokensOf } from './fake-gateway.ts';
import { capabilitiesFor, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const WINDOW = 4096;
const OUTPUT = 1024;
const SLACK = 40;

const sized = (): Capabilities => capabilitiesFor(WINDOW, { maxOutputTokens: OUTPUT, tokenCounting: 'estimated' });
const ceiling = inputCeilingFor(sized());

const adding = (onCall: () => void): AnyTool =>
  defineTool<Record<string, never>>({
    name: 'Adder',
    description: 'Adds a fact',
    kind: 'other',
    sideEffect: 'read_only',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 60_000,
    title: () => 'Adder',
    subject: () => ({ kind: 'none', tool: 'Adder' }),
    execute: async () => {
      onCall();
      return { status: 'completed', output: 'added' };
    },
  });

const envFor = async (observedCapacity: boolean): Promise<Env> => {
  const env = await makeEnv({ capabilities: sized(), mode: 'bypassPermissions' });
  env.gateway.countMethod = 'estimated';
  env.settings.contextValue = { ...env.settings.contextValue, observedCapacity };
  return env;
};

const taskReaching = async (observedCapacity: boolean, target: number): Promise<string> => {
  const env = await envFor(observedCapacity);
  env.gateway.script.push(textStep('Done.'));
  await env.enqueue('y'.repeat(4));
  await env.runOnce(env.worker('probe', { toolList: () => [adding(() => undefined)], governance: createGovernancePort({ store: env.store, settings: env.settings }) }));
  const body = env.gateway.streams[0]?.body;
  if (body === undefined) throw new Error('the probe made no model call');
  return 'y'.repeat(4 + 4 * (target - inputTokensOf(body)));
};

describe.for([false, true])('a text-only governing fact added mid-run (observed capacity %s)', (observedCapacity) => {
  it('fails the run as pinned_overflow naming the fact when the fixed part no longer fits', async () => {
    const task = await taskReaching(observedCapacity, ceiling - MIN_ROOM_TOKENS - SLACK);
    const env = await envFor(observedCapacity);
    let added: string | undefined;
    const tools = () => [
      adding(() => {
        added = env.store.governing.add({
          kind: 'constraint',
          target: 'style',
          text: 'Prefer the long form. '.repeat(120),
          scope: { level: 'project', project: env.session.cwd, paths: [] },
          validUntil: null,
          supersedes: [],
          enforcement: null,
          source: { kind: 'command' },
        }).fact.id;
      }),
    ];
    env.gateway.script.push(callsStep([{ callId: 'call_a_1', name: 'Adder', args: {} }]), textStep('Done.'));
    const run = await env.enqueue(task);

    await env.runOnce(env.worker('w1', { toolList: tools, governance: createGovernancePort({ store: env.store, settings: env.settings }) }));

    const failed = env.run(run.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.error?.code).toBe('pinned_overflow');
    expect(added).toBeDefined();
    expect(failed.error?.message).toContain(added as string);
    expect(env.gateway.streams).toHaveLength(1);
  });
});
