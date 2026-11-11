import fs from 'node:fs';
import path from 'node:path';
import { parseAst } from 'rolldown/parseAst';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');

export interface SourceNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

export interface ImportBinding {
  readonly module: string;
  readonly imported: string;
}

export interface Reference {
  readonly node: SourceNode;
  readonly parent: SourceNode | undefined;
  readonly key: string;
}

export interface ParsedSource {
  readonly file: string;
  readonly text: string;
  readonly program: SourceNode;
  readonly imports: ReadonlyMap<string, ImportBinding>;
  readonly locals: ReadonlySet<string>;
  readonly references: readonly Reference[];
  readonly nodes: readonly Reference[];
}

export type Counts = Record<string, number>;

export const isNode = (value: unknown): value is SourceNode => typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string';

export const programOf = (file: string, text: string): SourceNode => {
  const program: unknown = parseAst(text, { lang: file.endsWith('.tsx') ? 'tsx' : 'ts' }, file);
  if (!isNode(program)) throw new Error(`${file}: the parser returned no program`);
  return program;
};

export const childOf = (node: SourceNode, key: string): SourceNode | undefined => {
  const value = node[key];
  return isNode(value) ? value : undefined;
};

export const childrenOf = (node: SourceNode, key: string): SourceNode[] => {
  const value = node[key];
  return Array.isArray(value) ? value.filter(isNode) : [];
};

export const identifierName = (node: SourceNode | undefined): string | undefined =>
  node !== undefined && node.type === 'Identifier' && typeof node['name'] === 'string' ? node['name'] : undefined;

export const literalValue = (node: SourceNode | undefined): unknown => (node !== undefined && node.type === 'Literal' ? node['value'] : undefined);

const EXPRESSION_WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSInstantiationExpression', 'TSExportAssignment']);

const TYPESCRIPT_CONTAINERS = new Set(['TSModuleDeclaration', 'TSModuleBlock', 'TSEnumDeclaration', 'TSEnumBody', 'TSEnumMember', 'TSParameterProperty']);

export const unwrapped = (node: SourceNode | undefined): SourceNode | undefined => {
  let current = node;
  while (current !== undefined && (EXPRESSION_WRAPPERS.has(current.type) || current.type === 'ParenthesizedExpression')) current = childOf(current, 'expression');
  return current;
};

const BINDING_KEYS: Readonly<Record<string, readonly string[]>> = {
  VariableDeclarator: ['id'],
  FunctionDeclaration: ['id', 'params'],
  FunctionExpression: ['id', 'params'],
  ArrowFunctionExpression: ['params'],
  ClassDeclaration: ['id'],
  ClassExpression: ['id'],
  CatchClause: ['param'],
  TSEnumDeclaration: ['id'],
  TSModuleDeclaration: ['id'],
};

const NAME_ONLY_KEYS: Readonly<Record<string, readonly string[]>> = {
  LabeledStatement: ['label'],
  BreakStatement: ['label'],
  ContinueStatement: ['label'],
  MetaProperty: ['meta', 'property'],
  ExportSpecifier: ['exported'],
  TSEnumMember: ['id'],
};

const KEYED = new Set(['Property', 'MethodDefinition', 'PropertyDefinition', 'AccessorProperty']);

const isNameOnly = (node: SourceNode, key: string): boolean => {
  if (NAME_ONLY_KEYS[node.type]?.includes(key) === true) return true;
  if (node.type === 'MemberExpression' && key === 'property') return node['computed'] !== true;
  if (KEYED.has(node.type) && key === 'key') return node['computed'] !== true;
  return false;
};

const HOST_MODULES = new Set(['fs', 'fs/promises', 'timers', 'timers/promises', 'crypto', 'child_process', 'os', 'net', 'worker_threads', 'perf_hooks', 'process']);

export const hostModuleOf = (specifier: string): string | undefined => {
  const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
  return HOST_MODULES.has(bare) ? `node:${bare}` : undefined;
};

const importedNameOf = (specifier: SourceNode): string => {
  if (specifier.type === 'ImportDefaultSpecifier') return 'default';
  if (specifier.type === 'ImportNamespaceSpecifier') return '*';
  const imported = childOf(specifier, 'imported');
  return identifierName(imported) ?? String(literalValue(imported));
};

export const parseSource = (file: string, text: string = fs.readFileSync(file, 'utf8')): ParsedSource => {
  const program = programOf(file, text);
  const imports = new Map<string, ImportBinding>();
  const locals = new Set<string>();
  const references: Reference[] = [];
  const nodes: Reference[] = [];

  const visit = (node: SourceNode, parent: SourceNode | undefined, key: string, binding: boolean): void => {
    if (node.type === 'ImportDeclaration') {
      if (node['importKind'] === 'type') return;
      const module = String(literalValue(childOf(node, 'source')));
      for (const specifier of childrenOf(node, 'specifiers')) {
        if (specifier['importKind'] === 'type') continue;
        const local = identifierName(childOf(specifier, 'local'));
        if (local !== undefined) imports.set(local, { module, imported: importedNameOf(specifier) });
      }
      return;
    }
    if (node.type.startsWith('TS') && !EXPRESSION_WRAPPERS.has(node.type) && !TYPESCRIPT_CONTAINERS.has(node.type)) return;
    if (node['declare'] === true) return;
    nodes.push({ node, parent, key });
    if (node.type === 'Identifier') {
      const name = identifierName(node);
      if (name === undefined) return;
      if (binding) locals.add(name);
      else references.push({ node, parent, key });
      return;
    }
    for (const [childKey, value] of Object.entries(node)) {
      if (isNameOnly(node, childKey)) continue;
      const childBinding = childBindingOf(node, childKey, binding);
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) visit(item, node, childKey, childBinding);
      } else if (isNode(value)) {
        visit(value, node, childKey, childBinding);
      }
    }
  };

  const childBindingOf = (node: SourceNode, key: string, binding: boolean): boolean => {
    if (BINDING_KEYS[node.type]?.includes(key) === true) return true;
    if (!binding) return false;
    if (node.type === 'AssignmentPattern' && key === 'right') return false;
    if (node.type === 'Property' && key === 'key') return false;
    if (node.type === 'MemberExpression') return false;
    return true;
  };

  visit(program, undefined, 'program', false);
  return { file, text, program, imports, locals, references, nodes };
};

export const lineOf = (source: ParsedSource, node: SourceNode): number => source.text.slice(0, node.start).split('\n').length;

export const textOf = (source: ParsedSource, node: SourceNode): string => source.text.slice(node.start, node.end);

export const memberChain = (node: SourceNode | undefined): string | undefined => {
  const plain = unwrapped(node);
  if (plain === undefined) return undefined;
  if (plain.type === 'Identifier') return identifierName(plain);
  if (plain.type === 'ThisExpression') return 'this';
  if (plain.type !== 'MemberExpression' || plain['computed'] === true) return undefined;
  const object = memberChain(childOf(plain, 'object'));
  const property = identifierName(childOf(plain, 'property'));
  if (object === undefined || property === undefined) return undefined;
  return object === 'globalThis' ? property : `${object}.${property}`;
};

export const calleeName = (call: SourceNode): string | undefined => {
  const chain = memberChain(childOf(call, 'callee'));
  return chain === undefined ? undefined : chain.slice(chain.lastIndexOf('.') + 1);
};

export const relativeOf = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/');

const filesUnder = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.generated.ts') && !entry.name.endsWith('.d.ts') ? [full] : [];
  });

export const productPackages = (): string[] =>
  fs
    .readdirSync(path.join(ROOT, 'packages'))
    .filter((name) => name !== 'testkit' && fs.existsSync(path.join(ROOT, 'packages', name, 'src')))
    .sort();

export const packageSources = (name: string): string[] => filesUnder(path.join(ROOT, 'packages', name, 'src')).sort();

export const productSources = (): string[] => productPackages().flatMap(packageSources);

const parsed = new Map<string, ParsedSource>();

export const parsedProductSource = (file: string): ParsedSource => {
  const known = parsed.get(file);
  if (known !== undefined) return known;
  const source = parseSource(file);
  parsed.set(file, source);
  return source;
};

export const countInto = (counts: Counts, token: string): void => {
  counts[token] = (counts[token] ?? 0) + 1;
};

export const perFile = (files: readonly string[], count: (source: ParsedSource) => Counts): Record<string, Counts> =>
  Object.fromEntries(
    files
      .map((file) => [relativeOf(file), count(parsedProductSource(file))] as const)
      .filter(([, counts]) => Object.keys(counts).length > 0),
  );
