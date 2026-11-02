import type { DecisionKind } from '@momonga/policy';
import type { PermissionMode } from '@momonga/protocol';
import type { Witness } from './decision-model.ts';

export const PROPERTY_IDS = ['deny-precedence', 'secret-reach', 'rule-consistency', 'bash-admission'] as const;
export type PropertyId = (typeof PROPERTY_IDS)[number];

export type Replay =
  | { agrees: true; actual: DecisionKind; final: DecisionKind }
  | { agrees: false; predicted: DecisionKind; actual: DecisionKind; final: DecisionKind }
  | { crashed: string }
  | { skipped: string };

export const isMismatch = (replay: Replay): boolean => 'crashed' in replay || ('agrees' in replay && !replay.agrees);

export type Counterexample = {
  witness: Witness;
  predicted: DecisionKind;
  cause: string;
  replay: Replay;
};

export type Finding = {
  subject: string;
  message: string;
  counterexample?: Counterexample;
};

export type Verdict =
  | { status: 'proved'; notes: readonly string[] }
  | { status: 'refuted'; findings: readonly Finding[]; notes: readonly string[] }
  | { status: 'unknown'; reason: string; notes: readonly string[] };

export type PropertyResult = {
  id: PropertyId;
  title: string;
  subject: string;
  proves: string;
  doesNotProve: readonly string[];
  verdict: Verdict;
};

export type ModelMismatch = { property: PropertyId; subject: string; counterexample: Counterexample };

export type VerificationReport = {
  mode: PermissionMode;
  ruleCount: number;
  solver: string;
  results: readonly PropertyResult[];
  mismatches: readonly ModelMismatch[];
  outsideProof: readonly string[];
  exitCode: 0 | 1;
};

export const describeWitness = (witness: Witness): string => {
  switch (witness.kind) {
    case 'path': {
      const where = witness.requested === witness.resolved ? witness.requested : `${witness.requested} (resolving to ${witness.resolved})`;
      return `${witness.tool} ${where}`;
    }
    case 'command':
      return `Bash ${JSON.stringify(witness.command)}`;
    case 'mcp':
      return `mcp__${witness.server}__${witness.tool}${witness.readOnly ? ' (read-only tool)' : ''}`;
  }
};

export const exitCodeOf =(results: readonly PropertyResult[], mismatches: readonly ModelMismatch[]): 0 | 1 =>
  mismatches.length === 0 && results.every((result) => result.verdict.status === 'proved') ? 0 : 1;
