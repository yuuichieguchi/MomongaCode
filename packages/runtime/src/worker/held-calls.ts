import { parseRule } from '@momonga/config';
import type { PermissionRule } from '@momonga/config';
import { pinnedDelegationOf } from '@momonga/protocol';
import type { HeldCall, HeldCallView, HeldLink, HeldOutcome, PinnedDelegation, RunState } from '@momonga/protocol';
import type { ClaimContext, Flow } from './claim-context.ts';

const MANDATE_SOURCE = 'the mandate of this run';

export type Delegation = { rules: readonly PermissionRule[]; notice: string; onQuiescent?: 'report' | 'wait' };

export type MandateCatalogue = { alwaysOperations: readonly string[]; supersededForms: ReadonlyArray<{ operation: string; argv: readonly string[] }> };

const ruleLines = (rules: readonly string[]): string[] => (rules.length === 0 ? ['  (none)'] : rules.map((rule) => `  ${rule}`));

export const mandateNotice = (pinned: PinnedDelegation, catalogue: MandateCatalogue): string =>
  [
    'This run works under a mandate that was declared before it started. No person is watching it.',
    'Calls these rules allow are run without asking:',
    ...ruleLines(pinned.scope.allow),
    'Calls these rules name wait for a person. Such a call is held: the run goes on, and its result is shown to you when it has run:',
    ...ruleLines(pinned.scope.ask),
    ...(catalogue.alwaysOperations.length === 0 ? [] : [`These operations are always held for a person: ${catalogue.alwaysOperations.join(', ')}.`]),
    'Calls these rules name are never run:',
    ...ruleLines(pinned.scope.deny),
    'Any other call that would need approval is outside the mandate and is not run.',
    ...(catalogue.supersededForms.length === 0
      ? []
      : ['Use the operation instead of the shell command it replaces:', ...catalogue.supersededForms.map((form) => `  ${form.argv.join(' ')}: ${form.operation}`)]),
    'When a call is held or blocked, do not repeat or rephrase it. Continue with work that does not depend on it. When nothing else can be done, say what waits and stop.',
  ].join('\n');

export const delegationOf = (pins: Record<string, unknown>, place: { home: string; cwd: string }, catalogue: MandateCatalogue): { delegation?: Delegation } => {
  const pinned = pinnedDelegationOf(pins);
  if (pinned === undefined) return {};
  const rules = (['deny', 'ask', 'allow'] as const).flatMap((effect) =>
    pinned.scope[effect].map((text) => parseRule(text, { effect, origin: 'cli', source: MANDATE_SOURCE, settingsRoot: place.cwd, home: place.home, cwd: place.cwd })),
  );
  return { delegation: { rules, notice: mandateNotice(pinned, catalogue), ...(pinned.hold?.onQuiescent === undefined ? {} : { onQuiescent: pinned.hold.onQuiescent }) } };
};

export const heldOutput = (approvalId: string): string =>
  `Not run yet: waiting for a person to approve (${approvalId}). Do not repeat or rephrase this call. Continue with work that does not depend on it; its result will be shown to you when it has run.`;

export const HELD_REJECTED_OUTPUT = 'A person rejected this call, so it was not run.';

export const HELD_WITHDRAWN_OUTPUT = 'The request for approval was withdrawn before a person answered, so this call was not run.';

export const heldViewsOf = (state: Pick<RunState, 'heldCalls'>): HeldCallView[] =>
  Object.entries(state.heldCalls ?? {}).map(([callId, held]) => ({ callId, approvalId: held.approvalId, tool: held.name, reason: held.reason, sinceSeq: held.sinceSeq }));

export const heldLinkOf = (state: Pick<RunState, 'heldCalls'>, callId: string): HeldLink | undefined => {
  const held = state.heldCalls?.[callId];
  return held === undefined ? undefined : { approvalId: held.approvalId };
};

export const stepOfCall = (state: Pick<RunState, 'heldCalls' | 'step'>, callId: string): number => state.heldCalls?.[callId]?.step ?? state.step;

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

export const quiesce = (ctx: ClaimContext): Promise<Flow> => {
  const { journal } = ctx;
  if (journal.state.quiescent !== true) {
    const held = heldViewsOf(journal.state);
    journal.append([
      { type: 'run.quiescent', held },
      { type: 'notice', level: 'warning', message: quiescentText(held), code: 'run_quiescent' },
    ]);
  }
  return ctx.terminals.yieldTo('WAITING_HUMAN');
};
