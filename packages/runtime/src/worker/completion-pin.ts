import { conditionIdOf, readMandate } from '@momonga/protocol';
import type { CompletionDeclaration, ConditionSource, ConditionWhen, Mandate, PinnedCompletion, PinnedCondition } from '@momonga/protocol';
import { readAgentPin } from '@momonga/agents';
import type { Run, Session } from '@momonga/store';
import type { SettingsPort } from '../ports.ts';

export type CompletionPin = { mandate?: { completion: PinnedCompletion }; verificationRequired?: true };

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

export const completionPinFor = async (input: { run: Run; session: Session; settings: Pick<SettingsPort, 'verification'> }): Promise<CompletionPin> => {
  const { run, session, settings } = input;
  const standing = await settings.verification(session);
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
  const hasMandate = request !== undefined || profile !== undefined;
  const declared = hasMandate || conditions.length > 0 || requirements.length > 0;
  return {
    ...(declared ? { mandate: { completion: { conditions, requirements } } } : {}),
    ...(standing.required || hasMandate ? { verificationRequired: true as const } : {}),
  };
};
