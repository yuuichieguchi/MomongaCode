import { acceptedReasoningEfforts, sentReasoningEffort } from '@momonga/protocol';
import type { MomongaModelEntry, ReasoningCapability, ReasoningEffort } from '@momonga/protocol';

export type DeclaredReasoning = { readonly known: false } | { readonly known: true; readonly reasoning: ReasoningCapability | undefined };

const UNKNOWN: DeclaredReasoning = { known: false };

const declaredOf = (capabilities: MomongaModelEntry['capabilities']): DeclaredReasoning =>
  'contextWindow' in capabilities ? { known: true, reasoning: capabilities.reasoning } : UNKNOWN;

const entryOf = (entries: readonly MomongaModelEntry[], model: string): MomongaModelEntry | undefined => entries.find((entry) => entry.id === model);

export const declaredReasoning = (entries: readonly MomongaModelEntry[], model: string): DeclaredReasoning => {
  const entry = entryOf(entries, model);
  return entry === undefined ? UNKNOWN : declaredOf(entry.capabilities);
};

export const acceptedEffortsOf = (declared: DeclaredReasoning): ReasoningEffort[] => {
  if (!declared.known || declared.reasoning === undefined) return [];
  const accepted = acceptedReasoningEfforts(declared.reasoning);
  return accepted.some((level) => level !== 'none') ? accepted : [];
};

const sentFor = (declared: DeclaredReasoning, chosen: ReasoningEffort | undefined): ReasoningEffort | undefined => (declared.known ? sentReasoningEffort(declared.reasoning, chosen) : undefined);

export const sentEffort = (entries: readonly MomongaModelEntry[], model: string, chosen: ReasoningEffort | undefined, answering?: string): ReasoningEffort | undefined => {
  const sent = sentFor(declaredReasoning(entries, model), chosen);
  if (answering === undefined || answering === model) return sent;
  const member = entryOf(entries, model)?.chain.find((candidate) => candidate.model === answering);
  return member === undefined ? sent : sentFor(declaredOf(member.capabilities), sent);
};

export const effortChoiceText = (declared: DeclaredReasoning, chosen: ReasoningEffort, modelName: string): string | undefined => {
  if (!declared.known) return undefined;
  const sent = sentReasoningEffort(declared.reasoning, chosen);
  if (sent === chosen) return undefined;
  if (sent === undefined) return `effort ${chosen} was chosen, but ${modelName} declares no reasoning effort, so none is sent`;
  return `effort ${chosen} was chosen; ${modelName} does not accept it, so ${sent} is used`;
};
