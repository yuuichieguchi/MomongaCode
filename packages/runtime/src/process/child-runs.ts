import { ChildRunError, pinOf } from '@momonga/agents';
import type { ChildRunOutcome, ChildRuns } from '@momonga/agents';
import { TERMINAL_STATUSES, assistantTextOf } from '@momonga/protocol';
import type { InputItem, RunState } from '@momonga/protocol';
import type { Run, RuntimeStore } from '@momonga/store';
import { parentPinsOf } from '../worker/pins.ts';

export type ChildRunsOptions = {
  store: Pick<RuntimeStore, 'createChildRun' | 'getRun' | 'listChildRuns' | 'finalTextOf' | 'readRunEventsOfTypes'>;
  modelAliases(): Promise<readonly string[]>;
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

export const createChildRuns = ({ store, modelAliases }: ChildRunsOptions): ChildRuns => {
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
      if (agent.model !== undefined) {
        const aliases = await modelAliases();
        if (!aliases.includes(agent.model)) {
          throw new ChildRunError(`Subagent ${agent.name} asks for the model alias "${agent.model}", which is not configured. Available aliases: ${aliases.join(', ')}`);
        }
      }
      const created = store.createChildRun({
        parentRunId,
        parentCallId,
        input: prompt,
        pins: { agent: pinOf(agent) },
        modelAlias: agent.model ?? parentPinsOf(store, parentRunId).modelAlias,
      });
      if (created.kind === 'parent_not_active') throw new ChildRunError(`A subagent cannot start because the run is ${created.status}`);
      return outcomeOf(created.run);
    },
  };
};
