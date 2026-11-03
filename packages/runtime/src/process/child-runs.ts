import { ChildRunError, pinOf } from '@momonga/agents';
import type { ChildRunOutcome, ChildRuns } from '@momonga/agents';
import { TERMINAL_STATUSES, assistantTextOf } from '@momonga/protocol';
import type { InputItem, RunState } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import type { Run, RuntimeStore } from '@momonga/store';

export type ChildRunsOptions = {
  store: Pick<RuntimeStore, 'createChildRun' | 'getRun' | 'listChildRuns' | 'load' | 'readRunEventsOfTypes'>;
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

const pinnedAliasOf = (store: Pick<RuntimeStore, 'readRunEventsOfTypes'>, runId: string): string => {
  const started = store.readRunEventsOfTypes(runId, ['run.started'])[0];
  if (started === undefined || started.type !== 'run.started') throw new Error(`run ${runId} has not recorded run.started, so it has pinned no model alias for a child run`);
  const alias = started.pins['modelAlias'];
  if (typeof alias !== 'string') throw new Error(`run ${runId} recorded run.started without a model alias pin`);
  return alias;
};

export const createChildRuns =({ store, modelAliases }: ChildRunsOptions): ChildRuns => {
  const foldedFinalText = (run: Run): string => {
    const loaded = store.load(run.id);
    const state = loaded.tail.reduce(foldRunState, loaded.snapshot?.state ?? initialRunState({ runId: run.id, sessionId: run.sessionId }));
    return finalTextOf(state);
  };

  const outcomeOf = (run: Run): ChildRunOutcome => {
    if (!isTerminalStatus(run.status)) return { state: 'running', runId: run.id, sessionId: run.sessionId };
    return {
      state: 'finished',
      runId: run.id,
      sessionId: run.sessionId,
      status: run.status,
      ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
      ...(run.error === undefined ? {} : { error: run.error }),
      text: foldedFinalText(run),
    };
  };

  return {
    outcomeOf: (runId) => {
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
        modelAlias: agent.model ?? pinnedAliasOf(store, parentRunId),
      });
      if (created.kind === 'parent_not_active') throw new ChildRunError(`A subagent cannot start because the run is ${created.status}`);
      return outcomeOf(created.run);
    },
  };
};
