import { canonicalJson, defineProductSchema, sha256Hex } from '@momonga/foundation';
import type { ProductValidator } from '@momonga/foundation';
import { MINIMUM_PAIRS } from './bootstrap.ts';
import { CONTEXT_DATASET_SCHEMA } from './context-dataset.ts';
import type { WorkspaceStep } from './context-dataset.ts';
import { DATASET_SCHEMA, DatasetError, assertGoldenCases, describeFirstError, isInsideWorkspace, jsonOf } from './dataset.ts';
import type { GoldenCase, GraderSpec } from './dataset.ts';

export const YIELD_DATASET_FORMAT = 'momonga-eval-context-yield/1';

export const YIELD_STEP_BEFORE_RUN = 1;

type YieldSession = Pick<GoldenCase, 'input' | 'permissionMode' | 'onAsk' | 'timeoutMs'>;

export type YieldLearn = YieldSession & { files?: Record<string, string>; workspace?: WorkspaceStep[]; verification: string };

export type YieldReuse = YieldSession & { graders: GraderSpec[] };

export type YieldFamily = { id: string; description?: string; learn: YieldLearn; reuse: YieldReuse; accept: { anchors: string[] } };

export type YieldDataset = { format: typeof YIELD_DATASET_FORMAT; name: string; families: YieldFamily[] };

const string = { type: 'string', minLength: 1 } as const;

const golden = DATASET_SCHEMA.properties.cases.items.properties;

const session = { input: golden.input, permissionMode: golden.permissionMode, onAsk: golden.onAsk, timeoutMs: golden.timeoutMs } as const;

const SESSION_REQUIRED = ['input', 'permissionMode', 'onAsk'] as const;

export const YIELD_DATASET_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    format: { const: YIELD_DATASET_FORMAT },
    name: string,
    families: {
      type: 'array',
      minItems: MINIMUM_PAIRS,
      items: {
        type: 'object',
        properties: {
          id: golden.id,
          description: string,
          learn: {
            type: 'object',
            properties: { ...session, files: golden.files, workspace: CONTEXT_DATASET_SCHEMA.properties.cases.items.properties.workspace, verification: string },
            required: [...SESSION_REQUIRED, 'verification'],
            additionalProperties: false,
          },
          reuse: {
            type: 'object',
            properties: { ...session, graders: golden.graders },
            required: [...SESSION_REQUIRED, 'graders'],
            additionalProperties: false,
          },
          accept: {
            type: 'object',
            properties: { anchors: { type: 'array', minItems: 1, items: string } },
            required: ['anchors'],
            additionalProperties: false,
          },
        },
        required: ['id', 'learn', 'reuse', 'accept'],
        additionalProperties: false,
      },
    },
  },
  required: ['format', 'name', 'families'],
  additionalProperties: false,
} as const;

const validateYieldDataset: ProductValidator<YieldDataset> = defineProductSchema('eval/yield-dataset', YIELD_DATASET_SCHEMA);

const pointerOf = (...segments: readonly (string | number)[]): string =>
  segments.map((segment) => `/${String(segment).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');

const refusal = (source: string, pointer: string, reason: string): DatasetError => new DatasetError(`${source}: invalid dataset at ${pointer}: ${reason}`);

type Carrier = { pointer: string; text: string };

const namedTexts = (texts: Readonly<Record<string, string>>, ...prefix: readonly (string | number)[]): Carrier[] =>
  Object.entries(texts).map(([name, content]) => ({ pointer: pointerOf(...prefix, name), text: `${name}\n${content}` }));

const carriersOf = (family: YieldFamily, index: number): Carrier[] => [
  { pointer: pointerOf('families', index, 'reuse', 'input'), text: family.reuse.input },
  ...namedTexts(family.learn.files ?? {}, 'families', index, 'learn', 'files'),
  ...(family.learn.workspace ?? []).flatMap((step, stepIndex) => namedTexts(step.write ?? {}, 'families', index, 'learn', 'workspace', stepIndex, 'write')),
];

const assertAnchorsAddSomething = (family: YieldFamily, index: number, source: string): void => {
  const carriers = carriersOf(family, index);
  family.accept.anchors.forEach((anchor, anchorIndex) => {
    const carrier = carriers.find((candidate) => candidate.text.includes(anchor));
    if (carrier === undefined) return;
    throw refusal(
      source,
      pointerOf('families', index, 'accept', 'anchors', anchorIndex),
      `the anchor ${JSON.stringify(anchor)} occurs in ${carrier.pointer}, so a memory that holds it would add nothing`,
    );
  });
};

const assertSteps = (family: YieldFamily, index: number, source: string): void => {
  (family.learn.workspace ?? []).forEach((step, stepIndex) => {
    const at = ['families', index, 'learn', 'workspace', stepIndex] as const;
    if (step.beforeRun !== YIELD_STEP_BEFORE_RUN) {
      throw refusal(
        source,
        pointerOf(...at, 'beforeRun'),
        `a family has two sessions, the learn session and the reuse session, so a workspace step has beforeRun ${YIELD_STEP_BEFORE_RUN}: it changes the workspace the learn session left before the reuse sessions start`,
      );
    }
    const written = Object.keys(step.write ?? {});
    const removed = step.remove ?? [];
    if (written.length === 0 && removed.length === 0) throw refusal(source, pointerOf(...at), 'the workspace step changes nothing');
    for (const name of [...written, ...removed]) {
      if (!isInsideWorkspace(name)) throw refusal(source, pointerOf(...at), `the workspace step names ${JSON.stringify(name)}; workspace steps must use relative paths inside the workspace`);
    }
  });
};

const reuseCasesOf = (dataset: YieldDataset): { cases: GoldenCase[] } => ({
  cases: dataset.families.map((family) => ({
    ...family.reuse,
    id: family.id,
    runs: 1,
    minPassRate: 1,
    ...(family.learn.files === undefined ? {} : { files: family.learn.files }),
  })),
});

export const parseYieldDataset = (text: string, source: string): YieldDataset => {
  const value = jsonOf(text, source);
  const verdict = validateYieldDataset(value);
  if (!verdict.valid) throw new DatasetError(`${source}: invalid dataset at ${describeFirstError(verdict.errors)}`);
  const dataset = verdict.value;
  assertGoldenCases(reuseCasesOf(dataset), source);
  dataset.families.forEach((family, index) => {
    assertSteps(family, index, source);
    assertAnchorsAddSomething(family, index, source);
  });
  return dataset;
};

export const yieldDatasetDigestOf = (dataset: YieldDataset): string => sha256Hex(canonicalJson(dataset));
