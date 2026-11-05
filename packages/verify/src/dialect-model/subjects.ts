import { BUILTINS, classOf, OPS, resolveRules, type Definition, type Op } from './definition.ts';
import { genDefinition, singleRuleDefinition } from './definition-gen.ts';
import { checkCase, describeMinimised, emptyStats, minimise, type CheckClass, type CheckStats } from './harness.ts';
import { createRng, hashString } from './prng.ts';
import { generateCase } from './schema-gen.ts';

export interface SubjectSpec {
  name: string;
  group: 'primitive' | 'built-in' | 'random-definitions';
  op?: Op;
  builtin?: string;
  boost: string[];
}

const BOOST: Record<Op, string[]> = {
  drop: ['unevaluatedProperties', 'unevaluatedItems', 'properties', 'items', 'containsMax', 'oneOfOverlap', 'refDependency', 'if', 'additionalProperties'],
  reject: ['$ref', 'oneOf', 'patternProperties', 'not'],
  'fill-type': ['not', 'if', 'oneOfOverlap', 'containsMax', 'const', 'enum', 'allOf', 'unevaluatedItems', 'unevaluatedProperties'],
  'split-enum': ['enum', 'type', 'unevaluatedProperties', 'allOf'],
  'split-type-array': ['typeArray', 'enum', 'const', 'unevaluatedProperties', 'allOf'],
  'const-as-enum': ['const', 'enum', 'type'],
  'ensure-key': ['unevaluatedProperties', 'allOf', 'additionalProperties', 'properties', 'anyOf', 'oneOfOverlap', 'containsMax', 'refDependency', 'unevaluatedItems'],
  label: ['properties', 'anyOf', 'items'],
  'property-order': ['properties', 'allOf'],
  'require-all': ['properties', 'required', 'oneOfOverlap', 'containsMax', 'anyOf'],
  'declare-required': ['required', 'additionalProperties', 'patternProperties', 'unevaluatedProperties', 'allOf', 'refDependency'],
  'inline-refs': ['allOf', 'unevaluatedProperties', 'not', 'properties', 'containsMax', 'refDependency', 'unevaluatedItems'],
  'empty-parameters': ['properties'],
};

export const SUBJECTS: SubjectSpec[] = [
  ...OPS.map((op): SubjectSpec => ({ name: op, group: 'primitive', op, boost: BOOST[op] })),
  ...Object.keys(BUILTINS).map((builtin): SubjectSpec => ({ name: builtin, group: 'built-in', builtin, boost: ['$ref', 'enum', 'typeArray', 'required', 'const', 'properties', 'oneOfOverlap', 'containsMax', 'refDependency'] })),
  { name: 'random-user-definitions', group: 'random-definitions', boost: ['$ref', 'enum', 'typeArray', 'required', 'const', 'properties', 'oneOfOverlap', 'containsMax', 'refDependency'] },
];

export interface Variant {
  definition: Definition;
  cls: CheckClass;
}

export const variantsOf = (definition: Definition): Variant[] => {
  const flat = resolveRules(definition);
  const kept = flat.filter((rule) => rule.op !== 'drop');
  const dropped = flat.filter((rule) => rule.op === 'drop');
  const variants: Variant[] = [];
  if (kept.length > 0 || dropped.length === 0) {
    variants.push({ definition: { rules: kept }, cls: kept.some((rule) => classOf(rule) === 'N') ? 'N' : 'P' });
  }
  if (dropped.length > 0) variants.push({ definition: { rules: dropped }, cls: 'W' });
  return variants;
};

export interface Cluster {
  signature: string;
  count: number;
  minimised: number;
  causes: { tag: string; count: number; example: string }[];
}

export interface SubjectReport {
  name: string;
  group: SubjectSpec['group'];
  stats: CheckStats;
  checks: number;
  counterexamples: number;
  clusters: Cluster[];
  definitions: number;
  oracleSamples: string[];
}

const MINIMISE_PER_SIGNATURE = 60;

const CAUSE_KEYWORDS = [
  'oneOf', 'anyOf', 'allOf', 'not', 'if', 'contains', 'maxContains', 'minContains', 'unevaluatedProperties', 'unevaluatedItems',
  'additionalProperties', 'patternProperties', 'required', '$ref', 'dependentSchemas', 'enum', 'const', 'items', 'prefixItems', 'properties',
];

const causeTag = (schema: unknown): string => {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (typeof value === 'object' && value !== null) {
      for (const [key, entry] of Object.entries(value)) {
        if (CAUSE_KEYWORDS.includes(key)) found.add(key);
        visit(entry);
      }
    }
  };
  visit(schema);
  return [...found].sort().join('+');
};

export const runSubject = (spec: SubjectSpec, schemas: number, seed: number, log: (line: string) => void): SubjectReport => {
  const stats = emptyStats();
  const clusters = new Map<string, Cluster>();
  const baseSeed = (hashString(spec.name) ^ Math.imul(seed, 2654435761)) >>> 0;
  let checks = 0;
  const oracleSamples: string[] = [];
  let counterexamples = 0;
  let definitions = 0;
  let cachedDefinition: Definition | undefined;
  for (let index = 0; index < schemas; index += 1) {
    const rng = createRng(baseSeed + index);
    const generated = generateCase(rng.fork(1), { boost: spec.boost, allowLoops: true });
    let definition: Definition;
    if (spec.op !== undefined) {
      definition = singleRuleDefinition(rng.fork(2), spec.op);
    } else if (spec.builtin !== undefined) {
      definition = BUILTINS[spec.builtin] as Definition;
    } else {
      if (index % 5 === 0 || cachedDefinition === undefined) {
        cachedDefinition = genDefinition(createRng(baseSeed ^ (index * 40503)));
        definitions += 1;
      }
      definition = cachedDefinition;
    }
    stats.schemas += 1;
    for (const variant of variantsOf(definition)) {
      checks += 1;
      const input = {
        schema: generated.schema,
        site: generated.site,
        definition: variant.definition,
        cls: variant.cls,
        seed: baseSeed ^ (index * 977),
        perDocument: 14,
      };
      const sink = emptyStats();
      const failure = checkCase({ ...input, stats: sink });
      mergeStats(stats, sink);
      if (failure === null) continue;
      if (failure.kind === 'oracle-error') {
        stats.oracleErrors += 1;
        if (oracleSamples.length < 3) oracleSamples.push(`${failure.detail} | ${JSON.stringify(generated.schema)} | ${JSON.stringify(variant.definition)}`);
        continue;
      }
      counterexamples += 1;
      const signature = `${variant.cls}:${failure.kind}${failure.reason === undefined ? '' : `:${failure.reason}`}${failure.path === undefined ? '' : failure.path === '/' ? ':root' : ':nested'}`;
      const cluster = clusters.get(signature) ?? { signature, count: 0, minimised: 0, causes: [] };
      cluster.count += 1;
      if (cluster.minimised < MINIMISE_PER_SIGNATURE) {
        cluster.minimised += 1;
        const shrunk = minimise(input, failure);
        const tag = causeTag(shrunk.schema);
        const known = cluster.causes.find((entry) => entry.tag === tag);
        if (known === undefined) cluster.causes.push({ tag, count: 1, example: describeMinimised(shrunk) });
        else known.count += 1;
      }
      clusters.set(signature, cluster);
    }
    if ((index + 1) % 2000 === 0) log(`${spec.name}: ${index + 1}/${schemas} counterexamples=${counterexamples}`);
  }
  return { name: spec.name, group: spec.group, stats, checks, counterexamples, clusters: [...clusters.values()], definitions, oracleSamples };
};

const mergeStats = (target: CheckStats, source: CheckStats): void => {
  target.rendered += source.rendered;
  target.unchanged += source.unchanged;
  target.instances += source.instances;
  target.validOriginal += source.validOriginal;
  target.validRendered += source.validRendered;
  target.oracleErrors += source.oracleErrors;
  target.unverifiable += source.unverifiable;
  target.ajvDisagreements += source.ajvDisagreements;
  target.ajvCrashes += source.ajvCrashes;
  for (const sample of source.ajvSamples) if (target.ajvSamples.length < 8) target.ajvSamples.push(sample);
  for (const [reason, count] of Object.entries(source.refused)) target.refused[reason] = (target.refused[reason] ?? 0) + count;
  for (const [reason, example] of Object.entries(source.refusedExamples)) if (target.refusedExamples[reason] === undefined) target.refusedExamples[reason] = example;
  for (const [reason, count] of Object.entries(source.failedRenders)) target.failedRenders[reason] = (target.failedRenders[reason] ?? 0) + count;
};
