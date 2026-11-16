import { conditionIdOf, readMandate } from '@momonga/protocol';
import type { CompletionDeclaration, ConditionSource, ConditionWhen, Mandate, PermissionMode, PinnedCondition, PinnedMandate } from '@momonga/protocol';
import { readAgentPin } from '@momonga/agents';
import type { PermissionRule } from '@momonga/config';
import { denyingRuleFor } from '@momonga/policy';
import { shellCommandSubject } from '@momonga/tools';
import type { Run, Session } from '@momonga/store';
import type { SettingsPort } from '../ports.ts';

export type CompletionPin = { mandate?: PinnedMandate; verificationRequired?: true };

type Layer = { source: ConditionSource; defaultWhen: ConditionWhen; declaration: CompletionDeclaration };

const requestMandateOf = (run: Run): Mandate | undefined => {
  const value = run.pins['mandate'];
  return value === undefined ? undefined : readMandate(value, `run ${run.id}`);
};

const pinnedConditionOf = (layer: Layer, condition: NonNullable<CompletionDeclaration['conditions']>[number]): PinnedCondition => ({
  id: condition.id ?? conditionIdOf(condition.command),
  command: condition.command,
  when: condition.when ?? layer.defaultWhen,
  source: layer.source,
  ...(condition.timeoutMs === undefined ? {} : { timeoutMs: condition.timeoutMs }),
});

export const COMPLETION_CONDITION_DENIED_CODE = 'completion_condition_denied';

const SOURCE_NAMES: Record<ConditionSource, string> = {
  request: 'the mandate of the request',
  profile: 'the front matter of the agent',
  settings: 'verification.commands of the settings',
};

export type DeniedCondition = { command: string; source: ConditionSource; rule: PermissionRule };

export const deniedConditionOf = (rules: readonly PermissionRule[], mode: PermissionMode, conditions: ReadonlyArray<{ command: string; source: ConditionSource }>): DeniedCondition | undefined => {
  for (const condition of conditions) {
    const rule = denyingRuleFor(rules, mode, shellCommandSubject(condition.command));
    if (rule !== undefined) return { command: condition.command, source: condition.source, rule };
  }
  return undefined;
};

export const deniedConditionText = ({ command, source, rule }: DeniedCondition): string =>
  `the completion condition ${JSON.stringify(command)} from ${SOURCE_NAMES[source]} is denied by the permission rule ${rule.text} (${rule.origin}: ${rule.source})`;

export type CompletionPinOutcome = { kind: 'pinned'; pin: CompletionPin } | { kind: 'denied'; denied: DeniedCondition };

export const completionPinFor = async (input: {
  run: Run;
  session: Session;
  settings: Pick<SettingsPort, 'verification'>;
  rules: () => Promise<readonly PermissionRule[]>;
  mode: PermissionMode;
  signal: AbortSignal;
}): Promise<CompletionPinOutcome> => {
  const { run, session, settings, signal } = input;
  const standing = await settings.verification(session, signal);
  const request = requestMandateOf(run);
  const profile = readAgentPin(run.pins)?.mandate;
  const layers: Layer[] = [
    ...(request?.completion === undefined ? [] : [{ source: 'request' as const, defaultWhen: 'always' as const, declaration: request.completion }]),
    ...(profile?.completion === undefined ? [] : [{ source: 'profile' as const, defaultWhen: 'always' as const, declaration: profile.completion }]),
    { source: 'settings', defaultWhen: 'after_mutation', declaration: { conditions: standing.conditions.map((command) => ({ command })) } },
  ];
  const conditions: PinnedCondition[] = [];
  const requirements: string[] = [];
  for (const layer of layers) {
    for (const condition of layer.declaration.conditions ?? []) {
      const pinned = pinnedConditionOf(layer, condition);
      if (!conditions.some((known) => known.id === pinned.id)) conditions.push(pinned);
    }
    for (const requirement of layer.declaration.requirements ?? []) {
      if (!requirements.includes(requirement)) requirements.push(requirement);
    }
    if (layer.declaration.inherit === false) break;
  }
  const denied = conditions.length === 0 ? undefined : deniedConditionOf(await input.rules(), input.mode, conditions);
  if (denied !== undefined) return { kind: 'denied', denied };
  const hasMandate = request !== undefined || profile !== undefined;
  const declared = hasMandate || conditions.length > 0 || requirements.length > 0;
  const pin: CompletionPin = {
    ...(declared
      ? { mandate: { completion: { conditions, requirements }, ...(request?.scope === undefined ? {} : { scope: request.scope }), ...(request?.hold === undefined ? {} : { hold: request.hold }) } }
      : {}),
    ...(standing.required || hasMandate ? { verificationRequired: true as const } : {}),
  };
  return { kind: 'pinned', pin };
};
