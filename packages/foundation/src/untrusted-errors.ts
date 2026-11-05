import type { Engine, EngineValidator, RawError } from './untrusted-engine.ts';
import { capText, sanitizeServerText } from './untrusted-text.ts';

export type UntrustedError = {
  readonly instancePath: string;
  readonly keyword: string;
  readonly message: string;
  readonly params: Readonly<Record<string, unknown>>;
};

export type ErrorDescriber = (errors: readonly RawError[], instance: unknown) => UntrustedError[];

type Located = { readonly uri: string; readonly pointer: string; readonly node: unknown };

type Context = { readonly base: Located; readonly prefix: string; readonly instance: unknown };

const MAX_MESSAGE_CHARS = 200;
const PROBE_ID = 'urn:momonga:error-probe';
const VARIANT_KEYWORDS: ReadonlySet<string> = new Set(['anyOf', 'oneOf']);
const KEY_ALIASES: Readonly<Record<string, string>> = { prefixItems: 'items', $defs: 'definitions' };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const escapeToken = (token: string): string => token.replaceAll('~', '~0').replaceAll('/', '~1');

const unescapeToken = (token: string): string => token.replaceAll('~1', '/').replaceAll('~0', '~');

const segmentsOf = (pointer: string): string[] => (pointer === '' ? [] : pointer.slice(1).split('/').map(unescapeToken));

const childOf = (node: unknown, token: string): { key: string; value: unknown } | undefined => {
  if (Array.isArray(node)) return /^(0|[1-9]\d*)$/.test(token) && Number(token) < node.length ? { key: token, value: node[Number(token)] } : undefined;
  if (!isRecord(node)) return undefined;
  for (const key of [token, KEY_ALIASES[token]]) {
    if (key !== undefined && Object.hasOwn(node, key)) return { key, value: node[key] };
  }
  return undefined;
};

const valueAt = (instance: unknown, instancePath: string): unknown => {
  let value = instance;
  for (const token of segmentsOf(instancePath)) value = childOf(value, token)?.value;
  return value;
};

const fragmentUri = (documentUri: string, pointer: string): string => `${documentUri}#${pointer.split('/').map(encodeURIComponent).join('/')}`;

const locationKey = (at: Located): string => `${at.uri}#${at.pointer}`;

const sanitizeParam = (value: unknown): unknown => {
  if (typeof value === 'string') return sanitizeServerText(value);
  if (Array.isArray(value)) return value.map(sanitizeParam);
  return value;
};

const sanitized = (error: RawError, instancePath: string): UntrustedError => ({
  instancePath: sanitizeServerText(instancePath),
  keyword: error.keyword,
  message: capText(sanitizeServerText(error.message), MAX_MESSAGE_CHARS),
  params: Object.fromEntries(Object.entries(error.params).map(([name, value]) => [name, sanitizeParam(value)])),
});

const rawDepthOf = (errors: readonly RawError[]): number =>
  Math.max(...errors.map((error) => Math.max(segmentsOf(error.instancePath).length, error.branchErrors === undefined ? 0 : rawDepthOf(error.branchErrors) + segmentsOf(error.instancePath).length)));

const compareSegments = (left: string, right: string): number => {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) return Number(left) - Number(right);
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

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const compareErrors = (left: UntrustedError, right: UntrustedError): number =>
  comparePaths(left.instancePath, right.instancePath) ||
  compareText(left.keyword, right.keyword) ||
  compareText(left.message, right.message) ||
  compareText(JSON.stringify(left.params), JSON.stringify(right.params));

export const createErrorDescriber = ({ root, rootUri, engine, registry }: { root: Record<string, unknown>; rootUri: string; engine: Engine; registry: Readonly<Record<string, object>> }): ErrorDescriber => {
  const probes = new Map<string, EngineValidator>();
  const probeRegistry = { ...registry, [rootUri]: root };

  const documentAt = (uri: string): unknown => (uri === rootUri ? root : registry[uri]);

  const probeOf = (branch: Located): EngineValidator => {
    const key = locationKey(branch);
    const cached = probes.get(key);
    if (cached !== undefined) return cached;
    const compiled = engine.compile({ $id: PROBE_ID, $ref: fragmentUri(branch.uri, branch.pointer) }, probeRegistry);
    probes.set(key, compiled);
    return compiled;
  };

  const referenceTarget = (at: Located): Located | undefined => {
    if (!isRecord(at.node)) return undefined;
    const ref = at.node['$ref'];
    if (typeof ref !== 'string') return undefined;
    const hash = ref.indexOf('#');
    const location = hash < 0 ? ref : ref.slice(0, hash);
    let uri = at.uri;
    if (location !== '') {
      try {
        const resolved = new URL(location, at.uri);
        resolved.hash = '';
        uri = resolved.href;
      } catch {
        return undefined;
      }
    }
    let pointer: string;
    try {
      pointer = decodeURIComponent(hash < 0 ? '' : ref.slice(hash + 1));
    } catch {
      return undefined;
    }
    if (pointer !== '' && !pointer.startsWith('/')) return undefined;
    let node: unknown = documentAt(uri);
    if (node === undefined) return undefined;
    for (const token of segmentsOf(pointer)) {
      node = childOf(node, token)?.value;
      if (node === undefined) return undefined;
    }
    return { uri, pointer, node };
  };

  const stepInto = (at: Located, token: string, seen: Set<string>): Located | undefined => {
    const direct = childOf(at.node, token);
    if (direct !== undefined) return { uri: at.uri, pointer: `${at.pointer}/${escapeToken(direct.key)}`, node: direct.value };
    const target = referenceTarget(at);
    if (target === undefined || seen.has(locationKey(target))) return undefined;
    seen.add(locationKey(target));
    return stepInto(target, token, seen);
  };

  const branchesOf = (base: Located, error: RawError): Located[] | undefined => {
    const tokens = segmentsOf(error.schemaPath.replace(/^#/, ''));
    const keyword = tokens.pop();
    if (keyword !== error.keyword) return undefined;
    let at: Located | undefined = base;
    for (const token of tokens) {
      at = at === undefined ? undefined : stepInto(at, token, new Set());
    }
    const list = at === undefined ? undefined : stepInto(at, keyword, new Set());
    if (list === undefined || !Array.isArray(list.node)) return undefined;
    return list.node.map((node, index) => ({ uri: list.uri, pointer: `${list.pointer}/${index}`, node }));
  };

  const shapeOf = (branch: Located): Record<string, unknown> | undefined => {
    const seen = new Set<string>();
    let at: Located | undefined = branch;
    while (at !== undefined && !seen.has(locationKey(at))) {
      if (isRecord(at.node) && isRecord(at.node['properties'])) return at.node;
      seen.add(locationKey(at));
      at = referenceTarget(at);
    }
    return undefined;
  };

  const tagsOf = (branch: Located): Map<string, readonly unknown[]> => {
    const tags = new Map<string, readonly unknown[]>();
    const properties = shapeOf(branch)?.['properties'];
    if (!isRecord(properties)) return tags;
    for (const [key, property] of Object.entries(properties)) {
      if (!isRecord(property)) continue;
      if (Object.hasOwn(property, 'const')) tags.set(key, [property['const']]);
      else if (Array.isArray(property['enum'])) tags.set(key, property['enum']);
    }
    return tags;
  };

  type Selection =
    | { readonly kind: 'matched'; readonly indexes: readonly number[] }
    | { readonly kind: 'unmatched'; readonly key: string; readonly allowed: readonly unknown[] }
    | { readonly kind: 'untagged' };

  const selectionOf = (branches: readonly Located[], instance: unknown): Selection => {
    if (!isRecord(instance)) return { kind: 'untagged' };
    const tagged = branches.map(tagsOf);
    const sharedKeys = [...new Set(tagged.flatMap((tags) => [...tags.keys()]))].filter((key) => tagged.filter((tags) => tags.has(key)).length >= 2);
    for (const key of sharedKeys) {
      const matched = tagged.flatMap((tags, index) => ((tags.get(key) ?? []).some((value) => Object.is(value, instance[key])) ? [index] : []));
      if (matched.length > 0) return { kind: 'matched', indexes: matched };
    }
    const key = sharedKeys.find((candidate) => tagged.every((tags) => tags.has(candidate)));
    if (key === undefined) return { kind: 'untagged' };
    const allowed = tagged.flatMap((tags) => tags.get(key) ?? []).filter((value, index, all) => all.findIndex((other) => Object.is(other, value)) === index);
    return { kind: 'unmatched', key, allowed };
  };

  const tagError = (selection: Extract<Selection, { kind: 'unmatched' }>, path: string, instance: unknown): UntrustedError => {
    const missing = !isRecord(instance) || instance[selection.key] === undefined;
    const base = { instancePath: sanitizeServerText(missing ? path : `${path}/${escapeToken(selection.key)}`) };
    if (missing) return { ...base, keyword: 'required', message: `must have required property '${sanitizeServerText(selection.key)}'`, params: { missingProperty: sanitizeServerText(selection.key) } };
    return { ...base, keyword: 'enum', message: 'must be equal to one of the allowed values', params: { allowedValues: sanitizeParam(selection.allowed) } };
  };

  const flatten = (errors: readonly RawError[], context: Context): UntrustedError[] =>
    errors.flatMap((error): UntrustedError[] => {
      const path = context.prefix + error.instancePath;
      if (!VARIANT_KEYWORDS.has(error.keyword) || error.branchErrors === undefined) return [sanitized(error, path)];
      const branches = branchesOf(context.base, error);
      if (branches === undefined) return [sanitized(error, path)];
      const instance = valueAt(context.instance, error.instancePath);
      const outcomes = branches.flatMap((branch, index) => {
        const verdict = probeOf(branch)(instance);
        return verdict.valid ? [] : [{ branch, index, errors: verdict.errors }];
      });
      if (outcomes.length === 0) return [sanitized(error, path)];
      const selection = selectionOf(branches, instance);
      if (selection.kind === 'unmatched') return [tagError(selection, path, instance)];
      const pool = selection.kind === 'matched' ? outcomes.filter((outcome) => selection.indexes.includes(outcome.index)) : [];
      const contenders = pool.length > 0 ? pool : outcomes;
      const deepest = Math.max(...contenders.map((outcome) => rawDepthOf(outcome.errors)));
      const finalists = pool.length > 0 ? pool : contenders.filter((outcome) => rawDepthOf(outcome.errors) === deepest);
      const best = finalists.reduce((winner, outcome) => (outcome.errors.length < winner.errors.length ? outcome : winner));
      return flatten(best.errors, { base: best.branch, prefix: path, instance });
    });

  return (errors, instance) => {
    const flat = flatten(errors, { base: { uri: rootUri, pointer: '', node: root }, prefix: '', instance });
    const unique = new Map(flat.map((error) => [JSON.stringify([error.instancePath, error.keyword, error.message, error.params]), error]));
    return [...unique.values()].sort(compareErrors);
  };
};
