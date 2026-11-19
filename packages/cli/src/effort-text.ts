import { sentReasoningEffort } from '@momonga/protocol';
import type { ReasoningCapability, ReasoningEffort } from '@momonga/protocol';

export type KnownReasoning = { readonly known: false } | { readonly known: true; readonly reasoning: ReasoningCapability | undefined };

export const effortChoiceText = (declared: KnownReasoning, chosen: ReasoningEffort, modelName: string): string | undefined => {
  if (!declared.known) return undefined;
  const sent = sentReasoningEffort(declared.reasoning, chosen);
  if (sent === chosen) return undefined;
  if (sent === undefined) return `effort ${chosen} was chosen, but ${modelName} declares no reasoning effort, so none is sent`;
  return `effort ${chosen} was chosen; ${modelName} does not accept it, so ${sent} is used`;
};

