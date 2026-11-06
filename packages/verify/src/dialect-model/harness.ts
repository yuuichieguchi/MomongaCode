import { SchemaValidatorFailure, checkWithPatterns, compileUntrustedSchema, patternRefusal, validateUntrusted } from '@momonga/foundation';
import { resolveRules, type Definition } from './definition.ts';
import { instancesFor } from './instance-gen.ts';
import { clone, deepEqual, exact, isObject, type Json, type JsonObject, type Schema } from './json.ts';
import { allowedDropKeys, STATED_REASONS, type FailureReason } from './primitives.ts';
import type { Rng } from './prng.ts';
import { createRng } from './prng.ts';
import { render, type Rendered } from './render.ts';
import type { Site } from './selector.ts';

export type CheckClass = 'P' | 'N' | 'W' | 'none';

export type FailureKind =
  | 'false-unsatisfiable'
  | 'unstated-reason'
  | 'original-mutated'
  | 'nondeterministic'
  | 'rendered-uncompilable'
  | 'rendered-accepts-more'
  | 'rendered-rejects-more'
  | 'drop-changed-more-than-keys'
  | 'oracle-error';

export interface Failure {
  kind: FailureKind;
  reason?: FailureReason;
  path?: string;
  instance?: Json;
  detail: string;
}

export interface CheckStats {
  schemas: number;
  rendered: number;
  unchanged: number;
  failedRenders: Record<string, number>;
  instances: number;
  validOriginal: number;
  validRendered: number;
  oracleErrors: number;
  unverifiable: number;
  refused: Record<string, number>;
  refusedExamples: Record<string, string>;
  crossCheckDisagreements: number;
  crossCheckCrashes: number;
  crossCheckExplained: Record<string, number>;
  crossCheckSamples: string[];
}

export const emptyStats = (): CheckStats => ({
  schemas: 0,
  rendered: 0,
  unchanged: 0,
  failedRenders: {},
  instances: 0,
  validOriginal: 0,
  validRendered: 0,
  oracleErrors: 0,
  unverifiable: 0,
  refused: {},
  refusedExamples: {},
  crossCheckDisagreements: 0,
  crossCheckCrashes: 0,
  crossCheckExplained: {},
  crossCheckSamples: [],
});

export class OracleError extends Error {}

export class Refused extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}

const refusalReasonOf = (message: string): string | undefined => {
  if (message.startsWith('schema is invalid:')) return 'meta-schema-invalid';
  if (/^reference ".*" cannot be resolved$/.test(message)) return 'unresolvable-reference';
  if (message.startsWith('$schema ') || message.startsWith('the supplied $schema')) return 'unsupported-$schema';
  return undefined;
};

const asRecord = (schema: Schema): Record<string, unknown> => {
  if (schema === undefined || schema === true) return {};
  if (schema === false) return { not: {} };
  return schema as Record<string, unknown>;
};

const IDENTITY = 'dialect-gate';

class Validators {
  compile(schema: Schema): (value: Json) => Promise<boolean> {
    const root = asRecord(schema);
    try {
      compileUntrustedSchema(root);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = error instanceof SchemaValidatorFailure ? refusalReasonOf(message) : undefined;
      if (reason !== undefined) throw new Refused(reason, message);
      throw new OracleError(`compile: ${message.split('\n')[0] ?? 'failed'}`);
    }
    return async (value) => {
      let checked;
      try {
        checked = await checkWithPatterns(() => validateUntrusted(IDENTITY, root, value));
      } catch (error) {
        throw new OracleError(`validate: ${error instanceof Error ? error.message.split('\n')[0] ?? 'failed' : String(error)}`);
      }
      if (checked.kind !== 'checked') throw new OracleError(`validate: ${checked.kind === 'not-checked' ? patternRefusal('instance', value, checked) : 'the check was stopped'}`);
      return checked.value.valid;
    };
  }
}

const validators = new Validators();

export interface CrossCheck {
  compile(schema: Schema): ((value: Json) => boolean | null) | null;
  explain?(schema: Schema, instance: Json): string | undefined;
}

export interface CaseInput {
  schema: Json | null;
  site: Site;
  definition: Definition;
  cls: CheckClass;
  seed: number;
  perDocument: number;
  forcedInstances?: readonly Json[];
  stats?: CheckStats;
  crossCheck?: CrossCheck;
  renderer?: (schema: Json | null, definition: Definition, site: Site) => Rendered;
}

const standaloneNode = (node: Schema, root: Schema): Json | undefined => {
  if (!isObject(node)) return node;
  const result: JsonObject = { ...clone(node) };
  if (isObject(root)) {
    for (const key of ['$defs', 'definitions'] as const) {
      if (!(key in result) && key in root) result[key] = clone(root[key] as Json);
    }
  }
  return result;
};

const dropKeysOf = (definition: Definition): Set<string> => {
  const keys = new Set<string>();
  for (const rule of resolveRules(definition)) if (rule.op === 'drop') for (const key of rule.keys) keys.add(key);
  return allowedDropKeys([...keys]);
};

export const isDeletionOf = (original: Json | undefined, output: Json | undefined, allowed: ReadonlySet<string>): boolean => {
  if (deepEqual(original, output)) return true;
  if (Array.isArray(original) && Array.isArray(output)) {
    return original.length === output.length && original.every((entry, index) => isDeletionOf(entry, output[index], allowed));
  }
  if (isObject(original) && isObject(output)) {
    const removable = allowed.has('minContains') && original['minContains'] === 0 ? new Set([...allowed, ...allowedDropKeys(['contains'])]) : allowed;
    for (const key of Object.keys(output)) {
      if (!Object.hasOwn(original, key) || !isDeletionOf(original[key], output[key], allowed)) return false;
    }
    return Object.keys(original).every((key) => Object.hasOwn(output, key) || removable.has(key));
  }
  return false;
};

const sameRender = (left: Rendered, right: Rendered): boolean => {
  if (left.ok !== right.ok) return false;
  if (left.ok && right.ok) return exact(left.schema) === exact(right.schema);
  if (!left.ok && !right.ok) return left.reason === right.reason && left.path === right.path;
  return false;
};

const noteRefusal = (stats: CheckStats, refusal: Refused): void => {
  stats.refused[refusal.reason] = (stats.refused[refusal.reason] ?? 0) + 1;
  if (stats.refusedExamples[refusal.reason] === undefined) stats.refusedExamples[refusal.reason] = refusal.message;
};

const MAX_CROSS_CHECK_SAMPLES = 8;

const noteCrossCheck = (stats: CheckStats, crossCheck: CrossCheck, verdictOf: ((value: Json) => boolean | null) | null, side: string, schema: Schema, instance: Json, product: boolean): void => {
  const verdict = verdictOf === null ? null : verdictOf(instance);
  if (verdict === null) {
    stats.crossCheckCrashes += 1;
    return;
  }
  if (verdict === product) return;
  const explanation = crossCheck.explain?.(schema, instance);
  if (explanation !== undefined) {
    stats.crossCheckExplained[explanation] = (stats.crossCheckExplained[explanation] ?? 0) + 1;
    return;
  }
  stats.crossCheckDisagreements += 1;
  if (stats.crossCheckSamples.length < MAX_CROSS_CHECK_SAMPLES) stats.crossCheckSamples.push(JSON.stringify({ side, schema: schema ?? null, instance, product, crossCheck: verdict }));
};

const checkCaseUnguarded = async (input: CaseInput): Promise<Failure | null> => {
  const { schema, site, definition, cls, stats } = input;
  const renderer = input.renderer ?? render;
  const snapshot = clone(schema);
  const first = renderer(schema, definition, site);
  if (!deepEqual(schema, snapshot)) return { kind: 'original-mutated', detail: 'render changed its input' };
  if (!sameRender(first, renderer(schema, definition, site))) return { kind: 'nondeterministic', detail: 'two renders differ' };
  const original: Schema = schema === null ? undefined : schema;
  const rng = createRng(input.seed);
  if (stats !== undefined) stats.schemas += 1;
  if (!first.ok) {
    if (stats !== undefined) stats.failedRenders[first.reason] = (stats.failedRenders[first.reason] ?? 0) + 1;
    if (first.reason === 'unsatisfiable') {
      const standalone = standaloneNode(first.node, original);
      if (standalone === undefined) {
        if (stats !== undefined) stats.unverifiable += 1;
        return null;
      }
      let validNode: (value: Json) => Promise<boolean>;
      try {
        validNode = validators.compile(standalone);
      } catch (error) {
        if (error instanceof OracleError) throw error;
        if (stats !== undefined) {
          stats.unverifiable += 1;
          if (error instanceof Refused) noteRefusal(stats, error);
        }
        return null;
      }
      const probes = [...instancesFor(standalone, standalone, rng, input.perDocument), ...(input.forcedInstances ?? [])];
      if (stats !== undefined) stats.instances += probes.length;
      let witness: Json | undefined;
      for (const probe of probes) {
        if (await validNode(probe)) {
          witness = probe;
          break;
        }
      }
      if (witness !== undefined) return { kind: 'false-unsatisfiable', reason: 'unsatisfiable', path: first.path, instance: witness, detail: first.detail };
      return null;
    }
    if (!STATED_REASONS.includes(first.reason)) return { kind: 'unstated-reason', reason: first.reason, detail: first.detail };
    return null;
  }
  if (stats !== undefined) stats.rendered += 1;
  const rendered = first.schema;
  if (cls === 'W') {
    if (!isDeletionOf(original, rendered, dropKeysOf(definition))) return { kind: 'drop-changed-more-than-keys', detail: 'output differs by more than the dropped keys' };
  }
  if (cls === 'none' || deepEqual(original, rendered)) {
    if (stats !== undefined) stats.unchanged += 1;
    return null;
  }
  let validOriginal: (value: Json) => Promise<boolean>;
  try {
    validOriginal = validators.compile(original);
  } catch (error) {
    if (error instanceof Refused) {
      if (stats !== undefined) noteRefusal(stats, error);
      return null;
    }
    throw error;
  }
  let validRendered: (value: Json) => Promise<boolean>;
  try {
    validRendered = validators.compile(rendered);
  } catch (error) {
    if (error instanceof Refused) return { kind: 'rendered-uncompilable', detail: `${error.reason}: ${error.message}` };
    throw error;
  }
  const crossOriginal = input.crossCheck?.compile(original) ?? null;
  const crossRendered = input.crossCheck?.compile(rendered) ?? null;
  const instances = [...instancesFor(original, rendered, rng, input.perDocument), ...(input.forcedInstances ?? [])];
  for (const instance of instances) {
    const inOriginal = await validOriginal(instance);
    const inRendered = await validRendered(instance);
    if (stats !== undefined) {
      stats.instances += 1;
      if (inOriginal) stats.validOriginal += 1;
      if (inRendered) stats.validRendered += 1;
    }
    if (stats !== undefined && input.crossCheck !== undefined) {
      noteCrossCheck(stats, input.crossCheck, crossOriginal, 'original', original, instance, inOriginal);
      noteCrossCheck(stats, input.crossCheck, crossRendered, 'rendered', rendered, instance, inRendered);
    }
    if (inRendered && !inOriginal && cls !== 'W') return { kind: 'rendered-accepts-more', instance, detail: 'valid under rendered, invalid under original' };
    if (inOriginal && !inRendered && (cls === 'P' || cls === 'W')) return { kind: 'rendered-rejects-more', instance, detail: 'valid under original, invalid under rendered' };
  }
  return null;
};

export const checkCase = async (input: CaseInput): Promise<Failure | null> => {
  try {
    return await checkCaseUnguarded(input);
  } catch (error) {
    if (error instanceof OracleError) return { kind: 'oracle-error', detail: error.message };
    throw error;
  }
};

const sameFailure = (left: Failure, right: Failure): boolean => left.kind === right.kind && left.reason === right.reason && (left.path === '/') === (right.path === '/');

export const schemaCandidates = function* (value: Json): Generator<Json> {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) yield value.filter((_, position) => position !== index);
    for (let index = 0; index < value.length; index += 1) {
      for (const smaller of schemaCandidates(value[index] as Json)) yield value.map((entry, position) => (position === index ? smaller : entry));
    }
    return;
  }
  if (!isObject(value)) return;
  const keys = Object.keys(value);
  for (const key of keys) {
    const copy = { ...value };
    delete copy[key];
    yield copy;
  }
  for (const key of keys) {
    const child = value[key] as Json;
    if (isObject(child) && Object.keys(child).length > 0) yield { ...value, [key]: {} };
    if (isObject(child)) for (const grandchild of Object.values(child)) if (isObject(grandchild)) yield { ...value, [key]: grandchild };
  }
  for (const key of keys) {
    for (const smaller of schemaCandidates(value[key] as Json)) yield { ...value, [key]: smaller };
  }
};

export const instanceCandidates = function*(value: Json): Generator<Json> {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) yield value.filter((_, position) => position !== index);
    for (let index = 0; index < value.length; index += 1) {
      for (const smaller of instanceCandidates(value[index] as Json)) yield value.map((entry, position) => (position === index ? smaller : entry));
    }
    return;
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    for (const key of keys) {
      const copy = { ...value };
      delete copy[key];
      yield copy;
    }
    for (const key of keys) {
      for (const smaller of instanceCandidates(value[key] as Json)) yield { ...value, [key]: smaller };
    }
    return;
  }
  if (typeof value === 'string' && value !== '') yield '';
  if (typeof value === 'number' && value !== 0) yield 0;
  if (typeof value === 'number' && value !== 1 && value !== 0) yield 1;
  if (value !== null) yield null;
};

export interface Minimised {
  schema: Json | null;
  site: Site;
  definition: Definition;
  cls: CheckClass;
  failure: Failure;
  rendered: Rendered;
}

const MAX_SHRINK_EVALUATIONS = 4000;
const SHRINK_BUDGET_MS = 6000;

const tryCheck = async (input: CaseInput): Promise<Failure | null | 'invalid'> => {
  try {
    return await checkCase(input);
  } catch {
    return 'invalid';
  }
};

export const minimise = async (input: CaseInput, failure: Failure): Promise<Minimised> => {
  let current = input.schema;
  let currentFailure = failure;
  let evaluations = 0;
  const deadline = Date.now() + SHRINK_BUDGET_MS;
  const base = { ...input, perDocument: 24, seed: 7919 };
  if (current !== null) {
    let progressed = true;
    while (progressed && evaluations < MAX_SHRINK_EVALUATIONS && Date.now() < deadline) {
      progressed = false;
      for (const candidate of schemaCandidates(current)) {
        evaluations += 1;
        if (evaluations >= MAX_SHRINK_EVALUATIONS || Date.now() >= deadline) break;
        const forced = currentFailure.instance === undefined ? [] : [currentFailure.instance];
        const result = await tryCheck({ ...base, schema: candidate, forcedInstances: forced });
        if (result !== 'invalid' && result !== null && sameFailure(result, failure)) {
          current = candidate;
          currentFailure = result;
          progressed = true;
          break;
        }
      }
    }
  }
  let reduced = currentFailure;
  if (reduced.instance !== undefined && current !== null) {
    let instance = reduced.instance;
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const candidate of instanceCandidates(instance)) {
        if (await instanceFails(current, input.site, input.definition, failure.kind, candidate, input.renderer ?? render)) {
          instance = candidate;
          reduced = { ...reduced, instance: candidate };
          progressed = true;
          break;
        }
      }
    }
  }
  const rendered = (input.renderer ?? render)(current, input.definition, input.site);
  return { schema: current, site: input.site, definition: input.definition, cls: input.cls, failure: reduced, rendered };
};

const instanceFails = async (schema: Json, site: Site, definition: Definition, kind: FailureKind, instance: Json, renderer: NonNullable<CaseInput['renderer']>): Promise<boolean> => {
  const result = renderer(schema, definition, site);
  const validOriginal = validators.compile(schema);
  if (!result.ok) return kind === 'false-unsatisfiable' && (await validOriginal(instance));
  const validRendered = validators.compile(result.schema);
  if (kind === 'rendered-accepts-more') return (await validRendered(instance)) && !(await validOriginal(instance));
  if (kind === 'rendered-rejects-more') return (await validOriginal(instance)) && !(await validRendered(instance));
  return false;
};

export const describeMinimised = (item: Minimised): string =>
  JSON.stringify({
    class: item.cls,
    site: item.site,
    definition: item.definition,
    schema: item.schema,
    rendered: item.rendered.ok ? (item.rendered.schema ?? null) : { renderFailed: item.rendered.reason },
    instance: item.failure.instance,
    kind: item.failure.kind,
    reason: item.failure.reason,
  });

export type { Rng };
