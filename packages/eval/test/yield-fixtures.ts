import { YIELD_DATASET_FORMAT, parseYieldDataset } from '@momonga/eval';
import type { Transcript, YieldDataset, YieldFamilyRun } from '@momonga/eval';
import type { RunEventPayload } from '@momonga/protocol';
import { REAL_TARGET, SCRIPTED_TARGET, answeredBy } from './answered-fixtures.ts';
import type { Answerer } from './answered-fixtures.ts';
import { recorded } from './context-fixtures.ts';

export const FAMILY_IDS = ['port', 'codename', 'tag', 'variable'] as const;

export const anchorOf = (id: string): string => `fact-of-${id}`;

export const family = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  learn: {
    input: `Find the value for ${id} and run the check.`,
    permissionMode: 'acceptEdits',
    onAsk: 'allow_once',
    files: { 'notes.txt': 'nothing to see\n' },
    verification: 'node check.mjs',
  },
  reuse: {
    input: `Report the value for ${id}.`,
    permissionMode: 'acceptEdits',
    onAsk: 'allow_once',
    graders: [{ kind: 'status', equals: 'COMPLETED' }],
  },
  accept: { anchors: [anchorOf(id)] },
  ...extra,
});

export const yieldDatasetOf = (families: readonly unknown[]): YieldDataset => parseYieldDataset(JSON.stringify({ format: YIELD_DATASET_FORMAT, name: 'yield', families }), 'yield.json');

export const fourFamilies = (): YieldDataset => yieldDatasetOf(FAMILY_IDS.map((id) => family(id)));

export type CallShape = { cost?: number; cached?: number; inputTokens?: number };

export const modelCall = (shape: CallShape): RunEventPayload =>
  ({
    type: 'model.responded',
    step: 1,
    attempt: 1,
    response: {
      status: 'completed',
      output: [],
      usage: {
        input_tokens: shape.inputTokens ?? 1000,
        output_tokens: 50,
        total_tokens: (shape.inputTokens ?? 1000) + 50,
        ...(shape.cached === undefined ? {} : { input_tokens_details: { cached_tokens: shape.cached } }),
      },
      ...(shape.cost === undefined ? {} : { momonga: { cost: { amount: shape.cost, currency: 'USD', priceVersion: '2026-01-01' } } }),
      timing: { firstEventMs: 10, durationMs: 100 },
    },
  }) as unknown as RunEventPayload;

export const loadedMemories = (memories: readonly { id: string; status: 'verified' | 'stale' }[]): RunEventPayload => ({ type: 'context.memories_loaded', memories: [...memories] });

export const contribution = (items: readonly { id: string; contributed: boolean }[]): RunEventPayload => ({
  type: 'context.contribution',
  items: items.map((item) => ({ kind: 'memory', ...item })),
});

export const reflectionCharge = (cost: number | undefined, cached: number | undefined = 100) => ({
  id: 1,
  purpose: 'reflection' as const,
  runId: 'run-x',
  project: '/work',
  model: 'm',
  inputTokens: 500,
  outputTokens: 40,
  totalTokens: 540,
  createdAt: 1,
  detail: {
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
    ...(cost === undefined ? {} : { cost: { amount: cost, currency: 'USD' as const, priceVersion: '2026-01-01' } }),
    timing: { durationMs: 70 },
  },
});

export type ArmShape = { calls?: readonly CallShape[]; status?: 'COMPLETED' | 'FAILED'; extra?: readonly RunEventPayload[] };

export type FamilyShape = {
  without: ArmShape;
  with?: ArmShape;
  seeded?: string[];
  reflection?: Transcript['reflection'];
  candidates?: { text: string; paths: string[] }[];
  answerer?: Answerer;
};

const armTranscript = (caseId: string, shape: ArmShape, answerer: Answerer): Transcript =>
  answeredBy(recorded(caseId, 0, [...(shape.calls ?? [{ cost: 0.01, cached: 400 }]).map(modelCall), ...(shape.extra ?? [])], { status: shape.status ?? 'COMPLETED', model: 'p/m' }), answerer);

export const familyRun = (id: string, shape: FamilyShape): YieldFamilyRun => {
  const answerer = shape.answerer ?? REAL_TARGET;
  const candidates = shape.candidates ?? [{ text: `The value is ${anchorOf(id)}.`, paths: [] }];
  const accepted = shape.with === undefined ? [] : candidates.filter((candidate) => candidate.text.includes(anchorOf(id)));
  return {
    familyId: id,
    learn: answeredBy(recorded(`${id}.learn`, 0, [modelCall({ cost: 0.02, cached: 0 })], { model: 'p/m', reflection: shape.reflection ?? { state: 'done', charges: [reflectionCharge(0.003)] } }), answerer),
    candidates,
    accepted,
    without: armTranscript(`${id}.without`, shape.without, answerer),
    ...(shape.with === undefined ? {} : { with: { transcript: armTranscript(`${id}.with`, shape.with, answerer), seeded: shape.seeded ?? accepted.map((_candidate, index) => `mem-${id}-${index}`) } }),
  };
};

export const uniformRuns = (shape: FamilyShape): YieldFamilyRun[] => FAMILY_IDS.map((id) => familyRun(id, shape));

export { REAL_TARGET, SCRIPTED_TARGET };
