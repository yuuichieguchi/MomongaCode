import { describe, expect, it } from 'vitest';
import { ChildRunError } from '@momonga/agents';
import type { AgentDefinition } from '@momonga/agents';
import type { ModelViews, ReasoningEffort, RunEvent } from '@momonga/protocol';
import { createChildRuns } from '@momonga/runtime';
import type { ChildRunInput, Run, RuntimeStore } from '@momonga/store';

const MAIN = 'ollama/main:latest';
const OTHER = 'lmstudio/other';
const PLAIN = 'lmstudio/plain';

const VIEWS: ModelViews = [
  { canon: MAIN, provider: 'ollama', ownName: 'main:latest', defaultTag: 'latest', naming: 'server' },
  { canon: OTHER, provider: 'lmstudio', ownName: 'other', naming: 'server' },
  { canon: PLAIN, provider: 'lmstudio', ownName: 'plain', naming: 'server' },
];

const reasoningCapabilities = { contextWindow: 8192, maxOutputTokens: 1024, reasoning: { control: 'reasoning_effort', lowest: 'low' } };

const LISTED = [
  { id: MAIN, canon: MAIN, provider: 'ollama', ownName: 'main:latest', naming: 'server' as const, capabilities: reasoningCapabilities, chain: [] },
  { id: OTHER, canon: OTHER, provider: 'lmstudio', ownName: 'other', naming: 'server' as const, capabilities: reasoningCapabilities, chain: [] },
  { id: PLAIN, canon: PLAIN, provider: 'lmstudio', ownName: 'plain', naming: 'server' as const, capabilities: { contextWindow: 8192, maxOutputTokens: 1024 }, chain: [] },
];

const agentWith = (fields: { model?: string; effort?: ReasoningEffort } = {}): AgentDefinition => ({
  name: 'reviewer',
  description: 'reviews code',
  prompt: 'You review code.',
  scope: 'project',
  location: '/work/.momonga/agents/reviewer.md',
  ...fields,
});

const childRunsUnder = (parentEffort: ReasoningEffort | undefined) => {
  const created: ChildRunInput[] = [];
  const started = { type: 'run.started', seq: 1, attempt: 1, now: 0, pins: { model: MAIN, roles: {}, ...(parentEffort === undefined ? {} : { effort: parentEffort }) } } as unknown as RunEvent;
  const store = {
    listChildRuns: () => [],
    readRunEventsOfTypes: () => [started],
    createChildRun: (input: ChildRunInput) => {
      created.push(input);
      return { kind: 'created', run: { id: `child-${created.length}`, sessionId: 'child-session', status: 'QUEUED' } as unknown as Run, session: {} };
    },
    getRun: () => undefined,
    finalTextOf: async () => '',
  } as unknown as Pick<RuntimeStore, 'createChildRun' | 'getRun' | 'listChildRuns' | 'finalTextOf' | 'readRunEventsOfTypes' | 'journalFacts'>;
  return { created, runs: createChildRuns({ store, listing: async () => ({ models: LISTED, views: VIEWS }) }) };
};

const spawnWith = async (parentEffort: ReasoningEffort | undefined, agent: AgentDefinition, effort?: ReasoningEffort) => {
  const { created, runs } = childRunsUnder(parentEffort);
  await runs.spawn({ parentRunId: 'parent-1', parentCallId: 'call-1', agent, prompt: 'Look at the diff', ...(effort === undefined ? {} : { effort }) });
  return created[0]?.effort;
};

describe('the reasoning effort a subagent runs at', () => {
  it('is the effort argument of the Agent call first, then the definition, then the parent run level on the same model', async () => {
    expect(await spawnWith('high', agentWith({ effort: 'low' }), 'xhigh')).toBe('xhigh');
    expect(await spawnWith('high', agentWith({ effort: 'low' }))).toBe('low');
    expect(await spawnWith('high', agentWith())).toBe('high');
  });

  it('on another model leaves the level to that model (its saved level, else models.effort, else the standard level) instead of the parent run level', async () => {
    expect(await spawnWith('high', agentWith({ model: OTHER }))).toBeUndefined();
    expect(await spawnWith('high', agentWith({ model: OTHER, effort: 'low' }))).toBe('low');
  });

  it('refuses an effort argument the child model does not accept, listing the levels it accepts, and starts no child', async () => {
    const { created, runs } = childRunsUnder(undefined);
    const failure = await runs.spawn({ parentRunId: 'parent-1', parentCallId: 'call-1', agent: agentWith({ model: OTHER }), prompt: 'p', effort: 'minimal' }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChildRunError);
    expect((failure as Error).message).toBe('Subagent reviewer cannot run at effort minimal: its model lmstudio/other accepts low, medium, high, xhigh; call Agent again with one of them');
    expect(created).toEqual([]);
  });

  it('refuses an effort argument for a child model with no reasoning control', async () => {
    const { runs } = childRunsUnder(undefined);
    const failure = await runs.spawn({ parentRunId: 'parent-1', parentCallId: 'call-1', agent: agentWith({ model: PLAIN }), prompt: 'p', effort: 'high' }).catch((error: unknown) => error);
    expect((failure as Error).message).toBe('Subagent reviewer cannot run at effort high: its model lmstudio/plain declares no reasoning control; call Agent again without effort');
  });
});
