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

export type RuleProposalRequest = RuleProposalInput & { runId: string; callId: string };

export type GovernancePort = {
  propose(request: RuleProposalRequest): Promise<{ factId: string; created: boolean }>;
  find(runId: string, callId: string): { factId: string } | undefined;
};

export type GovernanceToolsOptions = { port: GovernancePort; trusted: boolean };
