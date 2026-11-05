import type { ReasoningOrigin } from '@momonga/protocol';
import type { ReasoningInput } from './input-text.ts';

export const ownReasoning = (item: ReasoningInput, origin: ReasoningOrigin | undefined): ReasoningInput | undefined => origin?.own(item);
