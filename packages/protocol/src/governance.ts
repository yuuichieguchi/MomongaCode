import type { Stored } from './stored-value.ts';
export const GOVERNING_KINDS = ['constraint', 'preference', 'commitment', 'role', 'identity'] as const;

export type GoverningKind = (typeof GOVERNING_KINDS)[number];

export type GoverningFactView = {
  id: string;
  kind: Stored<GoverningKind>;
  target: string;
  text: string;
  scope: { level: 'user' } | { level: 'project'; project: string; paths: string[] };
  validFrom: number;
  validUntil: number | null;
  retiredAt: number | null;
  supersedes: string[];
  enforcement: { behavior: 'deny' | 'ask'; rule: string } | null;
  source: { kind: 'command'; at: number } | { kind: 'proposal'; sessionId: string; runId: string; seq: number; callId: string };
};

export const GOVERNING_ENFORCEMENT_BEHAVIORS = ['deny', 'ask'] as const;

export type GoverningEnforcement = NonNullable<GoverningFactView['enforcement']>;

export type AddRuleRequest = {
  kind: GoverningKind;
  target: string;
  text: string;
  scope: GoverningFactView['scope'];
  validUntil?: number | null;
  supersedes?: string[];
  enforcement?: GoverningEnforcement | null;
};

export type RuleSize = { target: string; contextWindow: number; tokens: number; percent: number };

export type RuleAddResponse = { fact: GoverningFactView; size: RuleSize[]; warnings: string[] };

export type RuleResponse = { fact: GoverningFactView };

export type RulesResponse = { facts: GoverningFactView[] };

export type GovernanceRuleView = { id: string; behavior: GoverningEnforcement['behavior']; rule: string };

export type PolicyGovernanceResponse = { rules: GovernanceRuleView[]; textOnly: GoverningFactView[] };
