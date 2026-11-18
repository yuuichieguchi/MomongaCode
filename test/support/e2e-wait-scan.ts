import fs from 'node:fs';
import path from 'node:path';
import { ROOT, calleeName, childOf, childrenOf, identifierName, lineOf, parseSource, relativeOf, sourcesUnder, textOf, unwrapped } from './source-scan.ts';
import type { ParsedSource, SourceNode } from './source-scan.ts';

export type UnderivedWait = { readonly file: string; readonly line: number; readonly bound: string };

const BOUND_PROPERTIES = new Set(['deadlineMs', 'boundMs']);

const BOUND_ARGUMENTS: Readonly<Record<string, number>> = {
  toEnd: 0,
  ready: 0,
  untilPhase: 1,
  untilChild: 2,
  withinBound: 1,
  measureWindow: 2,
  awaitChecks: 1,
  sendProven: 2,
};

const STREAM_UNTIL_BOUND_ARGUMENT = 1;

const E2E_DIRECTORY = path.join(ROOT, 'e2e');

const PACKAGES_DIRECTORY = path.join(ROOT, 'packages');

const TEST_KIT = 'testkit';

const isE2eModule = (file: string): boolean => !path.relative(E2E_DIRECTORY, file).startsWith('..');

const isProductFile = (file: string): boolean => {
  const [name, folder] = path.relative(PACKAGES_DIRECTORY, file).split(path.sep);
  return name !== undefined && name !== '..' && name !== TEST_KIT && folder === 'src';
};

const isProductPackage = (specifier: string): boolean => specifier.startsWith('@momonga/') && specifier.split('/')[1] !== TEST_KIT;

type Verdict = 'derived' | 'passed' | 'fixed';

const combine = (verdicts: readonly Verdict[]): Verdict => {
  if (verdicts.includes('derived')) return 'derived';
  if (verdicts.includes('passed')) return 'passed';
  return 'fixed';
};

const parsedSources = new Map<string, ParsedSource>();

const sourceAt = (file: string): ParsedSource => {
  const known = parsedSources.get(file);
  if (known !== undefined) return known;
  const source = parseSource(file);
  parsedSources.set(file, source);
  return source;
};

const declarationsOf = (source: ParsedSource): ReadonlyMap<string, SourceNode[]> => {
  const declared = new Map<string, SourceNode[]>();
  const add = (name: string | undefined, node: SourceNode | undefined): void => {
    if (name === undefined || node === undefined) return;
    declared.set(name, [...(declared.get(name) ?? []), node]);
  };
  for (const { node } of source.nodes) {
    if (node.type === 'VariableDeclarator') add(identifierName(childOf(node, 'id')), childOf(node, 'init'));
    if (node.type === 'FunctionDeclaration') add(identifierName(childOf(node, 'id')), childOf(node, 'body'));
  }
  return declared;
};

const parametersOf = (source: ParsedSource): ReadonlySet<string> => {
  const names = new Set<string>();
  const collect = (node: SourceNode | undefined): void => {
    const plain = node?.type === 'AssignmentPattern' ? childOf(node, 'left') : node;
    if (plain === undefined) return;
    if (plain.type === 'Identifier') names.add(identifierName(plain) ?? '');
    if (plain.type === 'ObjectPattern') for (const property of childrenOf(plain, 'properties')) collect(childOf(property, 'value') ?? childOf(property, 'argument'));
    if (plain.type === 'ArrayPattern') for (const element of childrenOf(plain, 'elements')) collect(element);
    if (plain.type === 'RestElement') collect(childOf(plain, 'argument'));
  };
  for (const { node } of source.nodes) {
    if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration') for (const parameter of childrenOf(node, 'params')) collect(parameter);
  }
  return names;
};

const moduleFileOf = (from: string, specifier: string): string | undefined => {
  if (!specifier.startsWith('.')) return undefined;
  const resolved = path.resolve(path.dirname(from), specifier);
  return fs.existsSync(resolved) ? resolved : undefined;
};

const verdictOfName = (source: ParsedSource, name: string, seen: Set<string>): Verdict => {
  const key = `${source.file}#${name}`;
  if (seen.has(key)) return 'fixed';
  seen.add(key);
  const imported = source.imports.get(name);
  if (imported !== undefined) {
    if (isProductPackage(imported.module)) return 'derived';
    const file = moduleFileOf(source.file, imported.module);
    if (file === undefined) return 'fixed';
    if (isProductFile(file)) return 'derived';
    return isE2eModule(file) ? verdictOfName(sourceAt(file), imported.imported, seen) : 'fixed';
  }
  const declared = declarationsOf(source).get(name);
  if (declared !== undefined) return combine(declared.map((node) => verdictOf(source, node, seen)));
  return parametersOf(source).has(name) ? 'passed' : 'fixed';
};

const verdictOf = (source: ParsedSource, node: SourceNode, seen: Set<string>): Verdict => {
  const plain = unwrapped(node);
  if (plain === undefined) return 'fixed';
  if (plain.type === 'Identifier') return verdictOfName(source, identifierName(plain) ?? '', seen);
  if (plain.type === 'MemberExpression') {
    const object = childOf(plain, 'object');
    return object === undefined ? 'fixed' : verdictOf(source, object, seen);
  }
  const verdicts: Verdict[] = [];
  for (const [key, value] of Object.entries(plain)) {
    if (plain.type === 'Property' && key === 'key' && plain['computed'] !== true) continue;
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      if (typeof child === 'object' && child !== null && 'type' in child && typeof child.type === 'string') verdicts.push(verdictOf(source, child as SourceNode, seen));
    }
  }
  return combine(verdicts);
};

const boundsOf = (source: ParsedSource): SourceNode[] =>
  source.nodes.flatMap(({ node, parent }) => {
    if (node.type === 'Property' && parent?.type !== 'ObjectPattern' && node['computed'] !== true && BOUND_PROPERTIES.has(identifierName(childOf(node, 'key')) ?? '')) {
      const value = childOf(node, 'value');
      return value === undefined ? [] : [value];
    }
    if (node.type !== 'CallExpression') return [];
    const name = calleeName(node) ?? '';
    const args = childrenOf(node, 'arguments');
    const callee = unwrapped(childOf(node, 'callee'));
    const index = name === 'until' && callee?.type === 'MemberExpression' && args.length === 2 && unwrapped(args[1])?.type !== 'ObjectExpression' ? STREAM_UNTIL_BOUND_ARGUMENT : BOUND_ARGUMENTS[name];
    const bound = index === undefined ? undefined : args[index];
    return bound === undefined ? [] : [bound];
  });

export const underivedWaitsOf = (source: ParsedSource): UnderivedWait[] =>
  boundsOf(source)
    .filter((bound) => verdictOf(source, bound, new Set()) === 'fixed')
    .map((bound) => ({ file: relativeOf(source.file), line: lineOf(source, bound), bound: textOf(source, bound) }));

export const underivedE2eWaits = (): UnderivedWait[] => sourcesUnder(E2E_DIRECTORY).flatMap((file) => underivedWaitsOf(sourceAt(file)));
