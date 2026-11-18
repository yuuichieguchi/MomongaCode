import fs from 'node:fs';
import path from 'node:path';
import { ROOT, calleeName, childOf, childrenOf, identifierName, isNode, lineOf, parseSource, programOf, relativeOf, sourcesUnder, textOf, unwrapped } from './source-scan.ts';
import type { ParsedSource, SourceNode } from './source-scan.ts';

export type UnderivedWait = { readonly file: string; readonly line: number; readonly bound: string };

export const WAIT_BOUND_NAME = /^(?:[a-z]+(?:Deadline|Bound)Ms|deadlineMs|boundMs|timeoutMs)$/;

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
  if (plain.type === 'Literal' && plain['value'] === 0) return 'passed';
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

export type WaitParameters = ReadonlyMap<string, ReadonlySet<number>>;

const FUNCTION_TYPES = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration', 'TSFunctionType', 'TSMethodSignature', 'TSDeclareFunction']);

const parameterNameOf = (parameter: SourceNode): string | undefined => {
  const plain = parameter.type === 'AssignmentPattern' ? childOf(parameter, 'left') : parameter;
  return identifierName(plain);
};

const functionOf = (node: SourceNode): SourceNode | undefined => {
  const plain = unwrapped(node);
  if (plain === undefined) return undefined;
  if (FUNCTION_TYPES.has(plain.type)) return plain;
  const annotation = childOf(childOf(plain, 'typeAnnotation') ?? plain, 'typeAnnotation');
  return annotation?.type === 'TSFunctionType' ? annotation : undefined;
};

const namedFunctionsOf = (program: SourceNode): Array<{ name: string; fn: SourceNode }> => {
  const found: Array<{ name: string; fn: SourceNode }> = [];
  const visit = (node: SourceNode): void => {
    const named = (name: string | undefined, value: SourceNode | undefined): void => {
      const fn = value === undefined ? undefined : functionOf(value);
      if (name !== undefined && fn !== undefined) found.push({ name, fn });
    };
    if (node.type === 'FunctionDeclaration' || node.type === 'TSDeclareFunction') named(identifierName(childOf(node, 'id')), node);
    if (node.type === 'VariableDeclarator') named(identifierName(childOf(node, 'id')), childOf(node, 'init'));
    if (node.type === 'Property' || node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') named(identifierName(childOf(node, 'key')), childOf(node, 'value'));
    if (node.type === 'TSMethodSignature') named(identifierName(childOf(node, 'key')), node);
    if (node.type === 'TSPropertySignature') named(identifierName(childOf(node, 'key')), node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const item of value) if (isNode(item)) visit(item);
      if (isNode(value)) visit(value);
    }
  };
  visit(program);
  return found;
};

export const waitParametersOf = (files: ReadonlyArray<{ file: string; text: string }>): WaitParameters => {
  const table = new Map<string, Set<number>>();
  for (const { file, text } of files) {
    for (const { name, fn } of namedFunctionsOf(programOf(file, text))) {
      childrenOf(fn, 'params').forEach((parameter, index) => {
        if (!WAIT_BOUND_NAME.test(parameterNameOf(parameter) ?? '')) return;
        table.set(name, new Set([...(table.get(name) ?? []), index]));
      });
    }
  }
  return table;
};

const WAIT_HELPER_DIRECTORIES = [path.join(ROOT, 'e2e'), path.join(ROOT, 'packages', 'testkit', 'src')];

export const e2eWaitParameters = (): WaitParameters =>
  waitParametersOf(WAIT_HELPER_DIRECTORIES.flatMap(sourcesUnder).map((file) => ({ file, text: fs.readFileSync(file, 'utf8') })));

const boundsOf = (source: ParsedSource, parameters: WaitParameters): SourceNode[] =>
  source.nodes.flatMap(({ node, parent }) => {
    if (node.type === 'Property' && parent?.type !== 'ObjectPattern' && node['computed'] !== true && WAIT_BOUND_NAME.test(identifierName(childOf(node, 'key')) ?? '')) {
      const value = childOf(node, 'value');
      return value === undefined ? [] : [value];
    }
    if (node.type === 'AssignmentPattern' && WAIT_BOUND_NAME.test(identifierName(childOf(node, 'left')) ?? '')) {
      const value = childOf(node, 'right');
      return value === undefined ? [] : [value];
    }
    if (node.type !== 'CallExpression') return [];
    const args = childrenOf(node, 'arguments');
    const indexes = parameters.get(calleeName(node) ?? '') ?? new Set<number>();
    return [...indexes].flatMap((index) => {
      const bound = args[index];
      return bound === undefined || unwrapped(bound)?.type === 'ObjectExpression' ? [] : [bound];
    });
  });

export const underivedWaitsOf = (source: ParsedSource, parameters: WaitParameters): UnderivedWait[] =>
  boundsOf(source, parameters)
    .filter((bound) => verdictOf(source, bound, new Set()) === 'fixed')
    .map((bound) => ({ file: relativeOf(source.file), line: lineOf(source, bound), bound: textOf(source, bound) }));

export const underivedE2eWaits = (): UnderivedWait[] => {
  const parameters = e2eWaitParameters();
  return sourcesUnder(E2E_DIRECTORY).flatMap((file) => underivedWaitsOf(sourceAt(file), parameters));
};
