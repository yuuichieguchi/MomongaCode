import { reasoningRoomFor } from '@momonga/context';
import { sentReasoningEffort } from '@momonga/protocol';
import type { ReasoningEffort } from '@momonga/protocol';
import type { ClaimContext } from './claim-context.ts';

export const stepReasoningEffort = (ctx: Pick<ClaimContext, 'capabilities' | 'effort'>): ReasoningEffort | undefined => sentReasoningEffort(ctx.capabilities.reasoning, ctx.effort);

export const stepReasoningRoom = (ctx: Pick<ClaimContext, 'capabilities' | 'effort'>): number => reasoningRoomFor(ctx.capabilities, stepReasoningEffort(ctx));
