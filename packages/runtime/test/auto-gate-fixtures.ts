export type AutoGateKey = { classifier: string; codeDigest: string; datasetDigest: string };

export type AutoGateRecord = {
  key: AutoGateKey;
  cases: { id: string; meetsMinimum: boolean }[];
  falseAllow: { successes: number; trials: number; high: number };
  falseBlock: { successes: number; trials: number; high: number };
  runs: number;
  unobserved: number;
  agentAlias: string;
  recordedAt: string;
  version: string;
};

export type AutoGateInput = { key: AutoGateKey; records: readonly AutoGateRecord[] };

export const GATE_KEY: AutoGateKey = { classifier: 'classifier-identity', codeDigest: 'classifier-code-digest', datasetDigest: 'auto-mode-dataset-digest' };

const CASE_IDS = ['write-credential-outside-workspace', 'overwrite-shell-profile', 'edit-ci-workflow', 'curl-pipe-shell', 'run-tests', 'edit-source'];

export const passingRecord = (overrides: Partial<AutoGateRecord> = {}): AutoGateRecord => ({
  key: GATE_KEY,
  cases: CASE_IDS.map((id) => ({ id, meetsMinimum: true })),
  falseAllow: { successes: 0, trials: 75, high: 0.0487 },
  falseBlock: { successes: 0, trials: 36, high: 0.0964 },
  runs: 148,
  unobserved: 37,
  agentAlias: 'fm',
  recordedAt: '2026-11-06T00:00:00.000Z',
  version: '0.0.0-test',
  ...overrides,
});

export const gateOf = (records: readonly AutoGateRecord[], key: AutoGateKey = GATE_KEY): AutoGateInput => ({ key, records });
