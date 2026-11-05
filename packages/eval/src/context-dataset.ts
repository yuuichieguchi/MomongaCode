import { canonicalJson, defineProductSchema } from '@momonga/foundation';
import type { ProductValidator } from '@momonga/foundation';
import { GOVERNING_KINDS } from '@momonga/protocol';
import type { GoverningKind } from '@momonga/protocol';
import { DATASET_SCHEMA, DatasetError, assertGoldenCases, describeFirstError, isInsideWorkspace, jsonOf } from './dataset.ts';
import type { GoldenCase } from './dataset.ts';
import { pickFrom, seededRandom } from './random.ts';

export const CONTEXT_DATASET_FORMAT = 'momonga-eval-context/1';

export const COMPACTION_SETTINGS = ['on', 'off'] as const;
export type CompactionSetting = (typeof COMPACTION_SETTINGS)[number];

export type ContextRule = {
  id: string;
  kind: GoverningKind;
  target: string;
  text: string;
  inScope: boolean;
  live: boolean;
  supersedes: string[];
};

export type WorkspaceStep = { beforeRun: number; write?: Record<string, string>; remove?: string[] };

export type GoldRange = { seqFrom: number; seqTo: number };

export type ContextMemory = { text: string; paths: string[] };

export type RevisionChain = { id: string; kind: GoverningKind; target: string; text: string };

export type ContextCase = GoldenCase & {
  scenario: string;
  compaction: CompactionSetting;
  rules: ContextRule[];
  revisionDepth: number;
  revisionChain?: RevisionChain;
  memories?: ContextMemory[];
  noise: { level: number; topics: string[] };
  workspace?: WorkspaceStep[];
  gold?: GoldRange[];
};

export type ContextDataset = { format: typeof CONTEXT_DATASET_FORMAT; name: string; cases: ContextCase[] };

export type NoiseTurn = { user: string; assistant: string };

export type ExpandedCase = Omit<ContextCase, 'rules' | 'revisionChain'> & { rules: ContextRule[]; noiseTurns: NoiseTurn[] };

export type ExpandedContextDataset = { format: typeof CONTEXT_DATASET_FORMAT; name: string; seed: number; cases: ExpandedCase[] };

export const REVISION_PLACEHOLDER = '{revision}';

const string = { type: 'string', minLength: 1 } as const;

const ruleSchema = {
  type: 'object',
  properties: {
    id: string,
    kind: { enum: [...GOVERNING_KINDS] },
    target: string,
    text: string,
    inScope: { type: 'boolean' },
    live: { type: 'boolean' },
    supersedes: { type: 'array', items: string },
  },
  required: ['id', 'kind', 'target', 'text', 'inScope', 'live', 'supersedes'],
  additionalProperties: false,
} as const;

const revisionChainSchema = {
  type: 'object',
  properties: { id: string, kind: { enum: [...GOVERNING_KINDS] }, target: string, text: string },
  required: ['id', 'kind', 'target', 'text'],
  additionalProperties: false,
} as const;

const memorySchema = {
  type: 'object',
  properties: { text: string, paths: { type: 'array', items: string } },
  required: ['text', 'paths'],
  additionalProperties: false,
} as const;

const goldenCaseSchema = DATASET_SCHEMA.properties.cases.items;

export const CONTEXT_DATASET_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    format: { const: CONTEXT_DATASET_FORMAT },
    name: string,
    cases: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          ...goldenCaseSchema.properties,
          minPassRate: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
          scenario: string,
          compaction: { enum: [...COMPACTION_SETTINGS] },
          rules: { type: 'array', items: ruleSchema },
          revisionDepth: { type: 'integer', minimum: 0 },
          revisionChain: revisionChainSchema,
          memories: { type: 'array', items: memorySchema },
          noise: {
            type: 'object',
            properties: { level: { type: 'integer', minimum: 0 }, topics: { type: 'array', minItems: 1, items: string } },
            required: ['level', 'topics'],
            additionalProperties: false,
          },
          workspace: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                beforeRun: { type: 'integer', minimum: 1 },
                write: { type: 'object', additionalProperties: { type: 'string' } },
                remove: { type: 'array', items: string },
              },
              required: ['beforeRun'],
              additionalProperties: false,
            },
          },
          gold: {
            type: 'array',
            items: {
              type: 'object',
              properties: { seqFrom: { type: 'integer', minimum: 1 }, seqTo: { type: 'integer', minimum: 1 } },
              required: ['seqFrom', 'seqTo'],
              additionalProperties: false,
            },
          },
        },
        required: [...goldenCaseSchema.required, 'scenario', 'compaction', 'rules', 'revisionDepth', 'noise'],
        additionalProperties: false,
      },
    },
  },
  required: ['format', 'name', 'cases'],
  additionalProperties: false,
} as const;

const validateContextDataset: ProductValidator<ContextDataset> = defineProductSchema('eval/context-dataset', CONTEXT_DATASET_SCHEMA);

export const bindingRuleIds = (rules: readonly ContextRule[]): string[] => {
  const superseded = new Set(rules.filter((rule) => rule.inScope).flatMap((rule) => rule.supersedes));
  return rules.filter((rule) => rule.live && rule.inScope && !superseded.has(rule.id)).map((rule) => rule.id);
};

export const chainRulesOf = (chain: RevisionChain, depth: number): ContextRule[] =>
  Array.from({ length: depth + 1 }, (_unused, revision) => ({
    id: `${chain.id}-${revision}`,
    kind: chain.kind,
    target: chain.target,
    text: chain.text.replaceAll(REVISION_PLACEHOLDER, String(revision)),
    inScope: true,
    live: true,
    supersedes: revision === 0 ? [] : [`${chain.id}-${revision - 1}`],
  }));

export const rulesOf = (entry: Pick<ContextCase, 'rules' | 'revisionChain' | 'revisionDepth'>): ContextRule[] => [
  ...(entry.revisionChain === undefined ? [] : chainRulesOf(entry.revisionChain, entry.revisionDepth)),
  ...entry.rules,
];

const assertMemoryPaths = (entry: ContextCase, source: string): void => {
  for (const memory of entry.memories ?? []) {
    for (const name of memory.paths) {
      if (!isInsideWorkspace(name)) {
        throw new DatasetError(`${source}: case ${entry.id}: the memory path ${JSON.stringify(name)} must be a relative path inside the workspace`);
      }
    }
  }
};

const assertRevisions = (entry: ContextCase, source: string): void => {
  const rules = rulesOf(entry);
  const byId = new Map<string, ContextRule>();
  for (const rule of rules) {
    if (byId.has(rule.id)) throw new DatasetError(`${source}: case ${entry.id} has duplicate rule id ${rule.id}`);
    byId.set(rule.id, rule);
  }
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (rule: ContextRule): number => {
    const known = depths.get(rule.id);
    if (known !== undefined) return known;
    if (visiting.has(rule.id)) throw new DatasetError(`${source}: case ${entry.id} has a revision cycle through rule ${rule.id}`);
    visiting.add(rule.id);
    let depth = 0;
    for (const supersededId of rule.supersedes) {
      const superseded = byId.get(supersededId);
      if (superseded === undefined) throw new DatasetError(`${source}: case ${entry.id}: rule ${rule.id} supersedes unknown rule ${supersededId}`);
      if (superseded.target !== rule.target) {
        throw new DatasetError(`${source}: case ${entry.id}: rule ${rule.id} supersedes rule ${supersededId} of a different target`);
      }
      depth = Math.max(depth, 1 + depthOf(superseded));
    }
    visiting.delete(rule.id);
    depths.set(rule.id, depth);
    return depth;
  };
  const longest = Math.max(0, ...rules.map(depthOf));
  if (entry.revisionDepth !== longest) {
    throw new DatasetError(`${source}: case ${entry.id} declares revisionDepth ${entry.revisionDepth} but its rules give longest chain ${longest}`);
  }
};

const assertWorkspace = (entry: ContextCase, source: string): void => {
  (entry.workspace ?? []).forEach((step, index) => {
    if (step.beforeRun >= entry.runs) {
      throw new DatasetError(`${source}: case ${entry.id}: workspace step ${index} has beforeRun ${step.beforeRun} but the case has ${entry.runs} run(s); beforeRun counts from 1 to runs - 1`);
    }
    const written = Object.keys(step.write ?? {});
    const removed = step.remove ?? [];
    if (written.length === 0 && removed.length === 0) throw new DatasetError(`${source}: case ${entry.id}: workspace step ${index} changes nothing`);
    for (const name of [...written, ...removed]) {
      if (!isInsideWorkspace(name)) {
        throw new DatasetError(`${source}: case ${entry.id}: workspace step ${index} names ${JSON.stringify(name)}; workspace steps must use relative paths inside the workspace`);
      }
    }
  });
};

const assertGold = (entry: ContextCase, source: string): void => {
  for (const range of entry.gold ?? []) {
    if (range.seqTo < range.seqFrom) throw new DatasetError(`${source}: case ${entry.id} has a gold range ${range.seqFrom}..${range.seqTo} that ends before it starts`);
  }
};

const TOKEN_SEPARATOR = /[^\p{L}\p{N}]+/u;

const tokensOf = (text: string): string[] => text.toLowerCase().split(TOKEN_SEPARATOR).filter((token) => token !== '');

const USER_TEMPLATES: readonly ((topic: string) => string)[] = [
  (topic) => `Before we continue, how should I think about ${topic}?`,
  (topic) => `Can you remind me of the usual pitfalls with ${topic}?`,
  (topic) => `How do people structure ${topic} in a larger codebase?`,
  (topic) => `Is there a rule of thumb for ${topic}?`,
];

const ASSISTANT_TEMPLATES: readonly ((topic: string) => string)[] = [
  (topic) => `For ${topic} the answer depends on the size of the codebase: start simple and measure before changing anything.`,
  (topic) => `With ${topic}, most trouble comes from mixing several concerns at once, so keep each change small.`,
  (topic) => `A common approach to ${topic} is to write down the assumptions first and then check them one by one.`,
];

const assertNoiseNamesNoTarget = (entry: ContextCase, source: string): void => {
  const targets = rulesOf(entry).map((rule) => ({ rule: rule.id, tokens: new Set(tokensOf(rule.target)) }));
  for (const topic of entry.noise.topics) {
    for (const render of [...USER_TEMPLATES, ...ASSISTANT_TEMPLATES]) {
      const text = render(topic);
      for (const token of tokensOf(text)) {
        const governed = targets.find((target) => target.tokens.has(token));
        if (governed !== undefined) {
          throw new DatasetError(`${source}: case ${entry.id}: the noise text ${JSON.stringify(text)} holds the token ${JSON.stringify(token)} of the target of rule ${governed.rule}; noise must stay on topic without naming what a rule governs`);
        }
      }
    }
  }
};

const PAIR_FIELDS = ['input', 'permissionMode', 'onAsk', 'runs', 'timeoutMs', 'files', 'workspace', 'rules', 'revisionDepth', 'revisionChain', 'memories', 'noise', 'graders'] as const;

const assertPairs = (dataset: ContextDataset, source: string): void => {
  const scenarios = [...new Set(dataset.cases.map((entry) => entry.scenario))];
  for (const scenario of scenarios) {
    const members = dataset.cases.filter((entry) => entry.scenario === scenario);
    const on = members.filter((entry) => entry.compaction === 'on');
    const off = members.filter((entry) => entry.compaction === 'off');
    const [first] = on;
    const [second] = off;
    if (on.length !== 1 || off.length !== 1 || first === undefined || second === undefined) {
      throw new DatasetError(`${source}: scenario ${scenario} needs exactly one on case and one off case`);
    }
    for (const field of PAIR_FIELDS) {
      if (canonicalJson(first[field] ?? null) !== canonicalJson(second[field] ?? null)) {
        throw new DatasetError(`${source}: scenario ${scenario}: the on and off cases differ in ${field}, so they are not a pair`);
      }
    }
  }
};

export const parseContextDataset = (text: string, source: string): ContextDataset => {
  const value = jsonOf(text, source);
  const verdict = validateContextDataset(value);
  if (!verdict.valid) throw new DatasetError(`${source}: invalid dataset at ${describeFirstError(verdict.errors)}`);
  const dataset = verdict.value;
  assertGoldenCases(dataset, source);
  for (const entry of dataset.cases) {
    assertRevisions(entry, source);
    assertWorkspace(entry, source);
    assertGold(entry, source);
    assertMemoryPaths(entry, source);
    assertNoiseNamesNoTarget(entry, source);
  }
  assertPairs(dataset, source);
  return dataset;
};

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

const hashOf = (text: string): number => {
  let hash = FNV_OFFSET;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), FNV_PRIME) >>> 0;
  return hash;
};

export const noiseTurnsFor = (entry: Pick<ContextCase, 'scenario' | 'noise'>, seed: number): NoiseTurn[] => {
  const random = seededRandom((seed ^ hashOf(entry.scenario)) >>> 0);
  return Array.from({ length: entry.noise.level }, () => {
    const topic = pickFrom(random, entry.noise.topics);
    const user = pickFrom(random, USER_TEMPLATES);
    const assistant = pickFrom(random, ASSISTANT_TEMPLATES);
    return { user: user(topic), assistant: assistant(topic) };
  });
};

export const expandContextDataset = (dataset: ContextDataset, seed: number): ExpandedContextDataset => ({
  format: dataset.format,
  name: dataset.name,
  seed,
  cases: dataset.cases.map((entry) => {
    const { revisionChain: _chain, rules: _rules, ...rest } = entry;
    return { ...rest, rules: rulesOf(entry), noiseTurns: noiseTurnsFor(entry, seed) };
  }),
});
