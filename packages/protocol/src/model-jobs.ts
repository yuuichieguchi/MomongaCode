export const MODEL_OUTPUT_KINDS = ['text', 'choice'] as const;

export type ModelOutputKind = (typeof MODEL_OUTPUT_KINDS)[number];

export const MODEL_JOBS = [
  'start',
  'fallback',
  'compaction',
  'reflection',
  'analysis',
  'subagent',
  'session',
  'billing',
  'classifier',
  'memoryReview',
] as const;

export type ModelJob = (typeof MODEL_JOBS)[number];

const JOB_REQUIRES: Readonly<Record<ModelJob, { readonly kind: ModelOutputKind; readonly phrase: string }>> = {
  start: { kind: 'text', phrase: 'new sessions' },
  fallback: { kind: 'text', phrase: 'fallback' },
  compaction: { kind: 'text', phrase: 'summaries' },
  reflection: { kind: 'text', phrase: 'reflection' },
  analysis: { kind: 'text', phrase: 'analysis' },
  subagent: { kind: 'text', phrase: 'subagents' },
  session: { kind: 'text', phrase: 'a session' },
  billing: { kind: 'text', phrase: 'a billing rule' },
  classifier: { kind: 'choice', phrase: 'approvals' },
  memoryReview: { kind: 'choice', phrase: 'memory auto review' },
};

export const outputKindOf = (model: { readonly outputKind?: ModelOutputKind | undefined }): ModelOutputKind => model.outputKind ?? 'text';

export const canDoJob = (model: { readonly outputKind?: ModelOutputKind | undefined }, job: ModelJob): boolean =>
  JOB_REQUIRES[job].kind === 'choice' || outputKindOf(model) === 'text';

export const modelsForJob = <T extends { readonly outputKind?: ModelOutputKind | undefined }>(models: readonly T[], job: ModelJob): T[] =>
  models.filter((model) => canDoJob(model, job));

export const modelJobRefusal = (display: string, job: ModelJob): string =>
  `${display} only judges approvals; it cannot be the model for ${JOB_REQUIRES[job].phrase}.`;

export type ChoiceQuestion = {
  readonly type: 'choice';
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string | null>>;
};

export type ChoiceQuestionSpec = Readonly<Record<string, ChoiceQuestion>>;

export type RequestChoices = {
  readonly questions: ChoiceQuestionSpec;
};
