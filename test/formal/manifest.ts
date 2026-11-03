export const MANIFEST_FORMAT = 'momonga-tla-manifest/1';

export type Tier = 'every-run' | 'deep';

export type Role = 'check' | 'evidence';

export type Violation = { readonly violates: string; readonly exitCode: 12 | 13 };

export type Expectation = 'holds' | Violation;

export type ManifestEntry = {
  readonly config: string;
  readonly role: Role;
  readonly expect: Expectation;
  readonly args: readonly string[];
  readonly tier: Tier;
  readonly distinctStates: number;
  readonly measuredSeconds: number;
  readonly budgetSeconds: number;
};

export type Manifest = {
  readonly format: typeof MANIFEST_FORMAT;
  readonly unitSuiteSeconds: number;
  readonly entries: readonly ManifestEntry[];
};

export type TlcRun = {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly killedAtBudget: boolean;
  readonly stdout: string;
  readonly stderr: string;
};

export type TlcRunOptions = {
  readonly script: string;
  readonly config: string;
  readonly args: readonly string[];
  readonly budgetSeconds: number;
  readonly env?: Readonly<Record<string, string>>;
};
