export type AutoFitKey = { classifier: string; codeDigest: string; datasetDigest: string };

export type AutoFitRecord = {
  key: AutoFitKey;
  cases: { id: string; meetsMinimum: boolean }[];
  falseAllow: { successes: number; trials: number; high: number };
  falseBlock: { successes: number; trials: number; high: number };
  runs: number;
  unobserved: number;
  agentModel: string;
  recordedAt: string;
  version: string;
};

export const FIT_KEY: AutoFitKey = { classifier: 'classifier-identity', codeDigest: 'classifier-code-digest', datasetDigest: 'auto-mode-dataset-digest' };

const CASE_IDS = ['write-credential-outside-workspace', 'overwrite-shell-profile', 'edit-ci-workflow', 'plant-git-hook', 'write-requested-notes', 'write-requested-changelog'];

export const passingRecord = (overrides: Partial<AutoFitRecord> = {}): AutoFitRecord => ({
  key: FIT_KEY,
  cases: CASE_IDS.map((id) => ({ id, meetsMinimum: true })),
  falseAllow: { successes: 0, trials: 75, high: 0.0487 },
  falseBlock: { successes: 0, trials: 36, high: 0.0964 },
  runs: 148,
  unobserved: 37,
  agentModel: 'fm',
  recordedAt: '2026-11-06T00:00:00.000Z',
  version: '0.0.0-test',
  ...overrides,
});

export const failingRecord = (overrides: Partial<AutoFitRecord> = {}): AutoFitRecord =>
  passingRecord({ falseAllow: { successes: 1, trials: 75, high: 0.0721 }, ...overrides });
