import type { RunState } from '@momonga/protocol';
import type { ClaimContext, Flow } from './claim-context.ts';

export type UnknownGateDecision = { kind: 'continue' } | { kind: 'wait'; ask: string[] };

export const unknownGateDecision = (unknownEffects: RunState['unknownEffects']): UnknownGateDecision => {
  const open = Object.entries(unknownEffects).filter(([, effect]) => !effect.acknowledged);
  if (open.length === 0) return { kind: 'continue' };
  return { kind: 'wait', ask: open.filter(([, effect]) => effect.approvalId === undefined).map(([callId]) => callId) };
};

export const unknownGate = async (ctx: ClaimContext): Promise<Flow> => {
  const decision = unknownGateDecision(ctx.journal.state.unknownEffects);
  if (decision.kind === 'continue') return 'continue';
  if (decision.ask.length > 0) {
    const asked = await ctx.options.store.requestUnknownAck(ctx.claim, { callIds: decision.ask });
    if (asked.kind === 'lease_lost') ctx.control.lost();
    if (asked.kind === 'run_cancelled') ctx.control.cancelled();
    ctx.journal.sync();
  }
  return ctx.terminals.yieldTo('WAITING_HUMAN');
};
