import type { Stored, UNKNOWN_VALUE } from './stored-value.ts';
export const GOVERNING_KINDS = ['constraint', 'preference', 'commitment', 'role', 'identity'] as const;

export type GoverningKind = (typeof GOVERNING_KINDS)[number];

export const GOVERNING_ENFORCEMENT_BEHAVIORS = ['deny', 'ask'] as const;

export type EnforcedBehavior = (typeof GOVERNING_ENFORCEMENT_BEHAVIORS)[number];

export type GoverningScope = { level: 'user' } | { level: 'project'; project: string; paths: string[] };

export type GoverningEnforcement = { behavior: EnforcedBehavior; rule: string };

export type GoverningFactView = {
  id: string;
  kind: Stored<GoverningKind>;
  target: string;
  text: string;
  scope: GoverningScope | { level: typeof UNKNOWN_VALUE };
  validFrom: number;
  validUntil: number | null;
  retiredAt: number | null;
  supersedes: string[];
  enforcement: { behavior: Stored<EnforcedBehavior>; rule: string } | null;
  source: { kind: 'command'; at: number } | { kind: 'proposal'; sessionId: string; runId: string; seq: number; callId: string } | { kind: typeof UNKNOWN_VALUE };
};

export type AddRuleRequest = {
  kind: GoverningKind;
  target: string;
  text: string;
  scope: GoverningScope;
  validUntil?: number | null;
  supersedes?: string[];
  enforcement?: GoverningEnforcement | null;
};

export type RuleSize = { target: string; contextWindow: number; tokens: number; percent: number };

export type RuleAddResponse = { fact: GoverningFactView; size: RuleSize[]; warnings: string[] };

export type RuleResponse = { fact: GoverningFactView };

export type RulesResponse = { facts: GoverningFactView[] };

export type GovernanceRuleView = { id: string; behavior: EnforcedBehavior; rule: string };

export const enforcedBehaviorOf = (behavior: Stored<EnforcedBehavior>): EnforcedBehavior => (behavior === 'ask' ? 'ask' : 'deny');

export type PolicyGovernanceResponse = { rules: GovernanceRuleView[]; textOnly: GoverningFactView[] };
