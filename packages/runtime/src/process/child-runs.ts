import { ChildRunError, pinOf } from '@momonga/agents';
import type { ChildRunOutcome, ChildRuns } from '@momonga/agents';
import { TERMINAL_STATUSES, assistantTextOf, displayMapOf, resolveTypedModelRef, typedModelText } from '@momonga/protocol';
import type { InputItem, ModelViews, RunState } from '@momonga/protocol';
import type { Run, RuntimeStore } from '@momonga/store';
import { parentPinsOf } from '../worker/pins.ts';

export type ChildRunsOptions = {
  store: Pick<RuntimeStore, 'createChildRun' | 'getRun' | 'listChildRuns' | 'finalTextOf' | 'readRunEventsOfTypes' | 'journalFacts'>;
  modelViews(): Promise<ModelViews>;
};

type TerminalStatus = Extract<ChildRunOutcome, { state: 'finished' }>['status'];

const isTerminalStatus = (status: Run['status']): status is TerminalStatus => (TERMINAL_STATUSES as readonly string[]).includes(status);

const textOfItem = (item: InputItem): string | undefined => {
  const text = assistantTextOf([item]);
  return text === '' ? undefined : text;
};

export const finalTextOf = (state: RunState): string => {
  for (let index = state.history.length - 1; index >= 0; index -= 1) {
    const entry = state.history[index];
    const text = entry === undefined ? undefined : textOfItem(entry.item);
    if (text !== undefined) return text;
  }
  return '';
};

const agentModelOf = (agentName: string, text: string, views: ModelViews): string => {
  const resolution = resolveTypedModelRef(typedModelText(text), views);
  if (resolution.kind === 'found') return resolution.model.canon;
  const displays = displayMapOf(views);
  const listOf = (listed: ModelViews): string => listed.map((view) => displays.get(view.canon) ?? view.canon).join(', ');
  if (resolution.kind === 'ambiguous') {
    throw new ChildRunError(`Subagent ${agentName} asks for the model "${text}", which is ambiguous: ${listOf(resolution.choices)}. Write one of them in the agent definition.`);
  }
  throw new ChildRunError(`Subagent ${agentName} asks for the model "${text}", which is not configured. Configured models: ${listOf(views)}`);
};

export const createChildRuns = ({ store, modelViews }: ChildRunsOptions): ChildRuns => {
  const outcomeOf = async (run: Run): Promise<ChildRunOutcome> => {
    if (!isTerminalStatus(run.status)) return { state: 'running', runId: run.id, sessionId: run.sessionId };
    return {
      state: 'finished',
      runId: run.id,
      sessionId: run.sessionId,
      status: run.status,
      ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
      ...(run.error === undefined ? {} : { error: run.error }),
      text: await store.finalTextOf(run.id),
      report: (await store.journalFacts.report({ runId: run.id })).report,
    };
  };

  return {
    outcomeOf: async (runId) => {
      const run = store.getRun(runId);
      if (run === undefined) throw new Error(`unknown child run ${runId}`);
      return outcomeOf(run);
    },
    spawn: async ({ parentRunId, parentCallId, agent, prompt }) => {
      const known = store.listChildRuns(parentRunId).find((child) => child.parentCallId === parentCallId);
      if (known !== undefined) return outcomeOf(known);
      const parentPins = parentPinsOf(store, parentRunId);
      const model = agent.model === undefined ? parentPins.model : agentModelOf(agent.name, agent.model, await modelViews());
      const delegated = parentPins.delegation;
      const created = store.createChildRun({
        parentRunId,
        parentCallId,
        input: prompt,
        pins: { agent: pinOf(agent), ...(delegated === undefined ? {} : { mandate: { scope: delegated.scope, ...(delegated.hold === undefined ? {} : { hold: delegated.hold }) } }) },
        model,
      });
      if (created.kind === 'parent_not_active') throw new ChildRunError(`A subagent cannot start because the run is ${created.status}`);
      return outcomeOf(created.run);
    },
  };
};
