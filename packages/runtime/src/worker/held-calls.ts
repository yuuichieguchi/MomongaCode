import { parseRule } from '@momonga/config';
import type { PermissionRule } from '@momonga/config';
import { pinnedDelegationOf } from '@momonga/protocol';
import type { HeldCall, HeldCallView, HeldOutcome, RunState } from '@momonga/protocol';

const MANDATE_SOURCE = 'the mandate of this run';

export type Delegation = { rules: readonly PermissionRule[]; onQuiescent?: 'report' | 'wait' };

export const delegationOf = (pins: Record<string, unknown>, place: { home: string; cwd: string }): { delegation?: Delegation } => {
  const pinned = pinnedDelegationOf(pins);
  if (pinned === undefined) return {};
  const rules = (['deny', 'ask', 'allow'] as const).flatMap((effect) =>
    pinned.scope[effect].map((text) => parseRule(text, { effect, origin: 'cli', source: MANDATE_SOURCE, settingsRoot: place.cwd, home: place.home, cwd: place.cwd })),
  );
  return { delegation: { rules, ...(pinned.hold?.onQuiescent === undefined ? {} : { onQuiescent: pinned.hold.onQuiescent }) } };
};

export const heldOutput = (approvalId: string): string =>
  `Not run yet: waiting for a person to approve (${approvalId}). Do not repeat or rephrase this call. Continue with work that does not depend on it; its result will be shown to you when it has run.`;

export const HELD_REJECTED_OUTPUT = 'A person rejected this call, so it was not run.';

export const HELD_WITHDRAWN_OUTPUT = 'The request for approval was withdrawn before a person answered, so this call was not run.';

export const heldViewsOf = (state: Pick<RunState, 'heldCalls'>): HeldCallView[] =>
  Object.entries(state.heldCalls ?? {}).map(([callId, held]) => ({ callId, approvalId: held.approvalId, tool: held.name, reason: held.reason, sinceSeq: held.sinceSeq }));

export const hasHeld = (state: Pick<RunState, 'heldCalls'>): boolean => Object.keys(state.heldCalls ?? {}).length > 0;

export type HeldVerdict = { kind: 'waiting' } | { kind: 'run'; approval: { kind: 'allow_once' | 'allow_always'; subjectDigest: string } } | { kind: 'closed'; outcome: Exclude<HeldOutcome, 'executed'>; output: string };

export const heldVerdictOf = (held: HeldCall): HeldVerdict => {
  const { resolution, cancelled } = held;
  if (resolution !== undefined) {
    if (resolution.kind === 'allow_once' || resolution.kind === 'allow_always') return { kind: 'run', approval: { kind: resolution.kind, subjectDigest: resolution.subjectDigest } };
    return { kind: 'closed', outcome: 'rejected', output: HELD_REJECTED_OUTPUT };
  }
  if (cancelled === 'withdrawn' || cancelled === 'expired') return { kind: 'closed', outcome: 'withdrawn', output: HELD_WITHDRAWN_OUTPUT };
  return { kind: 'waiting' };
};

export const quiescentText = (held: readonly HeldCallView[]): string =>
  [
    `The run waits for a person: ${held.length} call${held.length === 1 ? '' : 's'} held for approval, and nothing else can proceed.`,
    ...held.map((entry) => `  ${entry.approvalId}  ${entry.tool}: ${entry.reason}`),
  ].join('\n');
