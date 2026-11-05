import { capText, sanitizeServerText } from './untrusted-text.ts';

export type UntrustedError = {
  readonly instancePath: string;
  readonly keyword: string;
  readonly message: string;
  readonly params: Readonly<Record<string, unknown>>;
};

export type RawError = {
  readonly keyword: string;
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly params: Record<string, unknown>;
  readonly message: string;
  readonly branchErrors?: readonly RawError[];
};

export type ErrorContext = {
  readonly root: Record<string, unknown>;
  readonly instance: unknown;
  readonly errorsOf: (schema: Record<string, unknown>, instance: unknown) => readonly RawError[];
};

const MAX_BRANCH_PROBES = 20;
const MAX_BRANCH_DEPTH = 3;
const MAX_MESSAGE_CHARS = 200;
const VARIANT_KEYWORDS: ReadonlySet<string> = new Set(['anyOf', 'oneOf']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const unescapeToken = (token: string): string => token.replaceAll('~1', '/').replaceAll('~0', '~');

const segmentsOf = (pointer: string): string[] => (pointer === '' ? [] : pointer.slice(1).split('/').map(unescapeToken));

const pointerStep = (node: unknown, token: string): unknown => {
  if (Array.isArray(node)) return /^(0|[1-9]\d*)$/.test(token) ? node[Number(token)] : undefined;
  if (isRecord(node) && Object.hasOwn(node, token)) return node[token];
  return undefined;
};

const resolveLocalReference = (root: Record<string, unknown>, node: unknown): unknown => {
  if (!isRecord(node)) return undefined;
  const ref = node['$ref'];
  if (typeof ref !== 'string' || !ref.startsWith('#')) return undefined;
  let target: unknown = root;
  for (const token of segmentsOf(decodeURIComponent(ref.slice(1)))) target = pointerStep(target, token);
  return target;
};

const stepSchema = (root: Record<string, unknown>, node: unknown, token: string): unknown => {
  const direct = pointerStep(node, token);
  if (direct !== undefined) return direct;
  const followed = resolveLocalReference(root, node);
  return followed === undefined ? undefined : pointerStep(followed, token);
};

const variantsAt = (root: Record<string, unknown>, schemaPath: string): { container: Record<string, unknown>; keyword: string; branches: unknown[] } | undefined => {
  const tokens = segmentsOf(schemaPath.replace(/^#/, ''));
  const keyword = tokens.pop();
  if (keyword === undefined || !VARIANT_KEYWORDS.has(keyword)) return undefined;
  let node: unknown = root;
  for (const token of tokens) {
    node = stepSchema(root, node, token);
    if (node === undefined) return undefined;
  }
  const container = isRecord(node) && Array.isArray(node[keyword]) ? node : resolveLocalReference(root, node);
  if (!isRecord(container)) return undefined;
  const branches = container[keyword];
  return Array.isArray(branches) ? { container, keyword, branches } : undefined;
};

const valueAt = (instance: unknown, instancePath: string): unknown => {
  let value = instance;
  for (const token of segmentsOf(instancePath)) value = pointerStep(value, token);
  return value;
};

const tagsOf = (root: Record<string, unknown>, branch: unknown): Map<string, readonly unknown[]> => {
  const tags = new Map<string, readonly unknown[]>();
  const resolved = isRecord(branch) && isRecord(branch['properties']) ? branch : resolveLocalReference(root, branch);
  const properties = isRecord(resolved) ? resolved['properties'] : undefined;
  if (!isRecord(properties)) return tags;
  for (const [key, property] of Object.entries(properties)) {
    if (!isRecord(property)) continue;
    if (Object.hasOwn(property, 'const')) tags.set(key, [property['const']]);
    else if (Array.isArray(property['enum'])) tags.set(key, property['enum']);
  }
  return tags;
};

const matchedTagBranches = (root: Record<string, unknown>, branches: readonly unknown[], instance: unknown): number[] => {
  if (!isRecord(instance)) return [];
  const tagged = branches.map((branch) => tagsOf(root, branch));
  const sharedKeys = [...new Set(tagged.flatMap((tags) => [...tags.keys()]))].filter((key) => tagged.filter((tags) => tags.has(key)).length >= 2);
  for (const key of sharedKeys) {
    const matched = tagged.flatMap((tags, index) => ((tags.get(key) ?? []).some((value) => Object.is(value, instance[key])) ? [index] : []));
    if (matched.length > 0) return matched;
  }
  return [];
};

const depthOf = (errors: readonly UntrustedError[]): number => Math.max(0, ...errors.map((error) => segmentsOf(error.instancePath).length));

const isWithin = (path: string, target: string): boolean => path === target || path.startsWith(`${target}/`);

const sanitizeParam = (value: unknown): unknown => {
  if (typeof value === 'string') return sanitizeServerText(value);
  if (Array.isArray(value)) return value.map(sanitizeParam);
  return value;
};

const sanitized = (error: RawError): UntrustedError => ({
  instancePath: sanitizeServerText(error.instancePath),
  keyword: error.keyword,
  message: capText(sanitizeServerText(error.message), MAX_MESSAGE_CHARS),
  params: Object.fromEntries(Object.entries(error.params).map(([name, value]) => [name, sanitizeParam(value)])),
});

const flatten = (errors: readonly RawError[], context: ErrorContext, depth: number, budget: { probes: number }): UntrustedError[] =>
  errors.flatMap((error): UntrustedError[] => {
    const variants = VARIANT_KEYWORDS.has(error.keyword) && error.branchErrors !== undefined ? variantsAt(context.root, error.schemaPath) : undefined;
    if (variants === undefined || depth >= MAX_BRANCH_DEPTH || budget.probes + variants.branches.length > MAX_BRANCH_PROBES) {
      return error.branchErrors === undefined ? [sanitized(error)] : flatten(error.branchErrors, context, depth + 1, budget);
    }
    budget.probes += variants.branches.length;
    const candidates = variants.branches.flatMap((_branch, index) => {
      const probe = structuredClone(context.root);
      const located = variantsAt(probe, error.schemaPath);
      if (located === undefined) return [];
      located.container[located.keyword] = [structuredClone(variants.branches[index])];
      const own = context.errorsOf(probe, context.instance).filter((candidate) => isWithin(candidate.instancePath, error.instancePath));
      const errors = flatten(own, { ...context, root: probe }, depth + 1, budget);
      return errors.length === 0 ? [] : [{ index, errors }];
    });
    if (candidates.length === 0) return error.branchErrors === undefined ? [] : flatten(error.branchErrors, context, depth + 1, budget);
    const tagged = matchedTagBranches(context.root, variants.branches, valueAt(context.instance, error.instancePath));
    const pool = candidates.filter((outcome) => tagged.includes(outcome.index));
    const contenders = pool.length > 0 ? pool : candidates;
    const deepest = Math.max(...contenders.map((outcome) => depthOf(outcome.errors)));
    const best = contenders
      .filter((outcome) => pool.length > 0 || depthOf(outcome.errors) === deepest)
      .reduce((winner, outcome) => (outcome.errors.length < winner.errors.length ? outcome : winner));
    return best.errors;
  });

const compareSegments = (left: string, right: string): number => {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  return left < right ? -1 : left > right ? 1 : 0;
};

const comparePaths = (left: string, right: string): number => {
  const a = segmentsOf(left);
  const b = segmentsOf(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const order = compareSegments(a[index] ?? '', b[index] ?? '');
    if (order !== 0) return order;
  }
  return a.length - b.length;
};

const compareErrors = (left: UntrustedError, right: UntrustedError): number =>
  comparePaths(left.instancePath, right.instancePath) ||
  (left.keyword < right.keyword ? -1 : left.keyword > right.keyword ? 1 : 0) ||
  (left.message < right.message ? -1 : left.message > right.message ? 1 : 0) ||
  (JSON.stringify(left.params) < JSON.stringify(right.params) ? -1 : JSON.stringify(left.params) > JSON.stringify(right.params) ? 1 : 0);

export const describeUntrustedErrors = (errors: readonly RawError[], context: ErrorContext): UntrustedError[] => {
  const flat = flatten(errors, context, 0, { probes: 0 });
  const unique = new Map(flat.map((error) => [JSON.stringify([error.instancePath, error.keyword, error.message, error.params]), error]));
  return [...unique.values()].sort(compareErrors);
};
