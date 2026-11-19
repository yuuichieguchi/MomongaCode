import { acceptedReasoningEfforts, sentReasoningEffort } from '@momonga/protocol';
import type { MomongaModelEntry, ReasoningCapability, ReasoningEffort } from '@momonga/protocol';
import type { RowSteps } from './select.tsx';
import { effortChoiceText } from '../effort-text.ts';

export { effortChoiceText };

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

export const effortInForce = (entries: readonly MomongaModelEntry[], model: string, chosen: ReasoningEffort | undefined): ReasoningEffort | undefined => chosen ?? entryOf(entries, model)?.effort;

export const sentEffort = (entries: readonly MomongaModelEntry[], model: string, chosen: ReasoningEffort | undefined, answering?: string): ReasoningEffort | undefined => {
  const sent = sentFor(declaredReasoning(entries, model), effortInForce(entries, model, chosen));
  if (answering === undefined || answering === model) return sent;
  const member = entryOf(entries, model)?.chain.find((candidate) => candidate.model === answering);
  return member === undefined ? sent : sentFor(declaredOf(member.capabilities), sent);
};

export type ShownEffort = { readonly kind: 'sent'; readonly level: ReasoningEffort } | { readonly kind: 'not-available' };

export const EFFORT_NOT_AVAILABLE = 'not available';

export const shownEffort = (entries: readonly MomongaModelEntry[], model: string, chosen: ReasoningEffort | undefined, answering?: string): ShownEffort | undefined => {
  const target = answering === undefined ? undefined : entryOf(entries, model)?.chain.find((candidate) => candidate.model === answering);
  const declared = target === undefined ? declaredReasoning(entries, model) : declaredOf(target.capabilities);
  if (!declared.known) return undefined;
  const level = sentEffort(entries, model, chosen, answering);
  return level === undefined ? { kind: 'not-available' } : { kind: 'sent', level };
};

export const effortLine = (shown: ShownEffort, form: 'full' | 'short'): string =>
  shown.kind === 'sent' ? `effort: ${shown.level}` : form === 'full' ? `effort: ${EFFORT_NOT_AVAILABLE} for this model` : `effort: ${EFFORT_NOT_AVAILABLE}`;

export const effortValue = (shown: ShownEffort): string => (shown.kind === 'sent' ? shown.level : EFFORT_NOT_AVAILABLE);

export const effortRefusalText = (modelName: string): string => `effort is ${EFFORT_NOT_AVAILABLE} for ${modelName}: it declares no reasoning control`;

export const effortStepsOf = (entry: MomongaModelEntry, chosen: ReasoningEffort | undefined): RowSteps | undefined => {
  const declared = declaredOf(entry.capabilities);
  const accepted = acceptedEffortsOf(declared);
  const level = sentFor(declared, chosen ?? entry.effort);
  if (accepted.length === 0 || level === undefined) return undefined;
  return { name: EFFORT_STEP_NAME, values: accepted, at: Math.max(0, accepted.indexOf(level)) };
};

export const EFFORT_STEP_NAME = 'effort';
