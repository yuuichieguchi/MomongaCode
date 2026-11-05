import type { ReasoningOrigin } from '@momonga/protocol';
import type { ReasoningInput } from './input-text.ts';

export const ownReasoning = (item: ReasoningInput, origin: ReasoningOrigin): ReasoningInput | undefined => origin.own(item);

export const NO_REASONING_IS_OWN: ReasoningOrigin = { own: () => undefined };
