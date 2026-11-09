import { RuleParseError, checkRuleText, parseGovernanceRule } from '@momonga/config';
import type { PermissionRule } from '@momonga/config';
import type { Clock } from '@momonga/foundation';
import { resolveGoverning } from '@momonga/memory';
import { enforcedBehaviorOf } from '@momonga/protocol';
import type { GoverningFactView } from '@momonga/protocol';
import type { RuntimeStore, Session } from '@momonga/store';
import type { SettingsPort } from '../ports.ts';

type EnforcedFact = GoverningFactView & { enforcement: NonNullable<GoverningFactView['enforcement']> };

export type RuleParseContext = { home: string; project: string };

export type PermissionRuleSources = {
  store: Pick<RuntimeStore, 'governing'>;
  settings: Pick<SettingsPort, 'rules'>;
  clock: Clock;
  home: string;
};

export const ruleParses = (rule: string): boolean => {
  try {
    checkRuleText(rule);
    return true;
  } catch (error) {
    if (error instanceof RuleParseError) return false;
    throw error;
  }
};

export const isEnforced = (fact: GoverningFactView): fact is EnforcedFact => fact.enforcement !== null;

export const enforcedFactsFor = (store: Pick<RuntimeStore, 'governing'>, clock: Clock, project: string): EnforcedFact[] =>
  resolveGoverning(store.governing.list({ project }), { now: clock.now(), project, touchedPaths: [], ignorePaths: true }).active.filter(isEnforced);

export const governanceRulesOf = (facts: readonly EnforcedFact[], context: RuleParseContext): PermissionRule[] =>
  facts.map((fact) => parseGovernanceRule({ id: fact.id, behavior: enforcedBehaviorOf(fact.enforcement.behavior), rule: fact.enforcement.rule }, context));

const governanceRulesFor = (sources: PermissionRuleSources, session: Session): PermissionRule[] =>
  governanceRulesOf(enforcedFactsFor(sources.store, sources.clock, session.cwd), { home: sources.home, project: session.cwd });

export const permissionRulesFor = async (sources: PermissionRuleSources, session: Session): Promise<PermissionRule[]> => [
  ...(await sources.settings.rules(session)),
  ...governanceRulesFor(sources, session),
];

export const permissionRulesComposerFor = async (sources: PermissionRuleSources, session: Session): Promise<() => PermissionRule[]> => {
  const settingsRules = await sources.settings.rules(session);
  return () => [...settingsRules, ...governanceRulesFor(sources, session)];
};
