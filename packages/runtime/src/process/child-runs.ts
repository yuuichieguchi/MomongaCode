import { ChildRunError, INHERIT_MODEL, pinOf } from '@momonga/agents';
import type { ChildRunOutcome, ChildRuns } from '@momonga/agents';
import { TERMINAL_STATUSES, acceptedReasoningEfforts, assistantTextOf, canDoJob, displayMapOf, modelJobRefusal, resolveTypedModelRef, typedModelText } from '@momonga/protocol';
import type { InputItem, ModelViews, ReasoningCapability, ReasoningEffort, RunState } from '@momonga/protocol';
import type { Run, RuntimeStore } from '@momonga/store';
import type { GatewayListing, ListedGatewayModel } from '../gateway-client.ts';
import { parentPinsOf } from '../worker/pins.ts';

export type ChildRunsOptions = {
  store: Pick<RuntimeStore, 'createChildRun' | 'getRun' | 'listChildRuns' | 'finalTextOf' | 'readRunEventsOfTypes' | 'journalFacts'>;
  listing(): Promise<Pick<GatewayListing, 'models' | 'views'>>;
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
  const displays = displayMapOf(views);
  if (resolution.kind === 'found') {
    if (!canDoJob(resolution.model, 'subagent')) throw new ChildRunError(modelJobRefusal(displays.get(resolution.model.canon) ?? resolution.model.canon, 'subagent'));
    return resolution.model.canon;
  }
  const listOf = (listed: ModelViews): string => listed.map((view) => displays.get(view.canon) ?? view.canon).join(', ');
  if (resolution.kind === 'ambiguous') {
    throw new ChildRunError(`Subagent ${agentName} asks for the model "${text}", which is ambiguous: ${listOf(resolution.choices)}. Write one of them in the agent definition.`);
  }
  throw new ChildRunError(`Subagent ${agentName} asks for the model "${text}", which is not configured. Configured models: ${listOf(views)}`);
};

const declaredLevelsOf = (listed: ListedGatewayModel | undefined): readonly ReasoningEffort[] | undefined => {
  if (listed === undefined || typeof listed.capabilities['contextWindow'] !== 'number') return undefined;
  const reasoning = listed.capabilities['reasoning'] as ReasoningCapability | undefined;
  if (reasoning === undefined) return [];
  const accepted = acceptedReasoningEfforts(reasoning);
  return accepted.some((level) => level !== 'none') ? accepted : [];
};

const requestedEffortOf = (agentName: string, requested: ReasoningEffort, model: string, listing: Pick<GatewayListing, 'models' | 'views'>): ReasoningEffort => {
  const accepted = declaredLevelsOf(listing.models.find((listed) => listed.id === model));
  if (accepted === undefined || accepted.includes(requested)) return requested;
  const shown = displayMapOf(listing.views).get(model) ?? model;
  if (accepted.length === 0) throw new ChildRunError(`Subagent ${agentName} cannot run at effort ${requested}: its model ${shown} declares no reasoning control; call Agent again without effort`);
  throw new ChildRunError(`Subagent ${agentName} cannot run at effort ${requested}: its model ${shown} accepts ${accepted.join(', ')}; call Agent again with one of them`);
};

export const createChildRuns = ({ store, listing }: ChildRunsOptions): ChildRuns => {
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
    spawn: async ({ parentRunId, parentCallId, agent, prompt, effort: requested }) => {
      const known = store.listChildRuns(parentRunId).find((child) => child.parentCallId === parentCallId);
      if (known !== undefined) return outcomeOf(known);
      const parentPins = parentPinsOf(store, parentRunId);
      let listed: Promise<Pick<GatewayListing, 'models' | 'views'>> | undefined;
      const listedNow = (): Promise<Pick<GatewayListing, 'models' | 'views'>> => (listed ??= listing());
      const model =
        agent.model === undefined
          ? (parentPins.roles.subagent ?? parentPins.model)
          : agent.model === INHERIT_MODEL
            ? parentPins.model
            : agentModelOf(agent.name, agent.model, (await listedNow()).views);
      const delegated = parentPins.delegation;
      const inherited = model === parentPins.model ? parentPins.effort : undefined;
      const effort = requested === undefined ? (agent.effort ?? inherited) : requestedEffortOf(agent.name, requested, model, await listedNow());
      const created = await store.createChildRun({
        parentRunId,
        parentCallId,
        input: prompt,
        pins: { agent: pinOf(agent), ...(delegated === undefined ? {} : { mandate: { scope: delegated.scope, ...(delegated.hold === undefined ? {} : { hold: delegated.hold }) } }) },
        model,
        ...(effort === undefined ? {} : { effort }),
      });
      if (created.kind === 'parent_not_active') throw new ChildRunError(`A subagent cannot start because the run is ${created.status}`);
      return outcomeOf(created.run);
    },
  };
};
