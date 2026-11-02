import type { GoverningEnforcement, GoverningKind } from '@momonga/protocol';

export type RuleProposalInput = {
  kind: GoverningKind;
  target: string;
  text: string;
  scope: 'user' | 'project';
  paths?: string[];
  enforcement?: GoverningEnforcement | null;
  supersedes?: string[];
};

export type RuleProposalRequest = RuleProposalInput & { runId: string; step: number; callId: string };

export type GovernancePort = {
  propose(request: RuleProposalRequest): { factId: string; created: boolean };
};

export type GovernanceToolsOptions = { port: GovernancePort; trusted: boolean };
