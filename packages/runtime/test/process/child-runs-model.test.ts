import { describe, expect, it } from 'vitest';
import { ChildRunError } from '@momonga/agents';
import type { AgentDefinition } from '@momonga/agents';
import type { ModelViews, RunEvent } from '@momonga/protocol';
import { createChildRuns } from '@momonga/runtime';
import type { ChildRunInput, Run, RuntimeStore } from '@momonga/store';

const OLLAMA_GEMMA = 'ollama/gemma-3-4b:latest';
const LMSTUDIO_GEMMA = 'lmstudio/gemma-3-4b';

const S2: ModelViews = [
  { canon: OLLAMA_GEMMA, provider: 'ollama', ownName: 'gemma-3-4b:latest', defaultTag: 'latest' },
  { canon: LMSTUDIO_GEMMA, provider: 'lmstudio', ownName: 'gemma-3-4b' },
];

const agentWith = (model?: string): AgentDefinition => ({
  name: 'reviewer',
  description: 'reviews code',
  prompt: 'You review code.',
  scope: 'project',
  location: '/work/.momonga/agents/reviewer.md',
  ...(model === undefined ? {} : { model }),
});

const childRunsOver = (parentModel: string) => {
  const created: ChildRunInput[] = [];
  const started = { type: 'run.started', seq: 1, attempt: 1, now: 0, pins: { model: parentModel, roles: {} } } as unknown as RunEvent;
  const store = {
    listChildRuns: () => [],
    readRunEventsOfTypes: () => [started],
    createChildRun: (input: ChildRunInput) => {
      created.push(input);
      return { kind: 'created', run: { id: 'child-1', sessionId: 'child-session', status: 'QUEUED' } as unknown as Run, session: {} };
    },
    getRun: () => undefined,
    finalTextOf: async () => '',
    readRunEvents: () => [],
  } as unknown as Pick<RuntimeStore, 'createChildRun' | 'getRun' | 'listChildRuns' | 'finalTextOf' | 'readRunEventsOfTypes' | 'readRunEvents'>;
  return { created, runs: createChildRuns({ store, modelViews: async () => S2 }) };
};

const spawn = (runs: ReturnType<typeof childRunsOver>['runs'], agent: AgentDefinition) => runs.spawn({ parentRunId: 'parent-1', parentCallId: 'call-1', agent, prompt: 'Look at the diff' });

describe('the model a subagent definition asks for (design-model-names 2.10, 3.4)', () => {
  it('refuses a name two servers serve with the sentence that names both and asks for one of them in the agent definition', async () => {
    const { created, runs } = childRunsOver(OLLAMA_GEMMA);
    const failure = await spawn(runs, agentWith('gemma-3-4b')).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChildRunError);
    expect((failure as Error).message).toBe(
      'Subagent reviewer asks for the model "gemma-3-4b", which is ambiguous: ollama/gemma-3-4b, lmstudio/gemma-3-4b. Write one of them in the agent definition.',
    );
    expect(created).toEqual([]);
  });

  it('refuses a model that is not configured with the sentence that lists the configured models', async () => {
    const { created, runs } = childRunsOver(OLLAMA_GEMMA);
    const failure = await spawn(runs, agentWith('ghost')).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChildRunError);
    expect((failure as Error).message).toBe('Subagent reviewer asks for the model "ghost", which is not configured. Configured models: ollama/gemma-3-4b, lmstudio/gemma-3-4b');
    expect(created).toEqual([]);
  });

  it('starts a subagent that names no model on the model its parent pinned, and one that names a model on the full reference it resolves to', async () => {
    const inherited = childRunsOver(LMSTUDIO_GEMMA);
    await spawn(inherited.runs, agentWith());
    expect(inherited.created.map((input) => input.model)).toEqual([LMSTUDIO_GEMMA]);
    const named = childRunsOver(LMSTUDIO_GEMMA);
    await spawn(named.runs, agentWith('ollama/gemma-3-4b'));
    expect(named.created.map((input) => input.model)).toEqual([OLLAMA_GEMMA]);
  });
});
