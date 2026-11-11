import fs from 'node:fs';
import path from 'node:path';
import { ROOT, childOf, childrenOf, identifierName, isNode, literalValue, programOf } from './source-scan.ts';
import type { SourceNode } from './source-scan.ts';

const parsed = (file: string): SourceNode => programOf(file, fs.readFileSync(file, 'utf8'));

const everyNode = (root: SourceNode): SourceNode[] => {
  const found: SourceNode[] = [];
  const visit = (node: SourceNode): void => {
    found.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.filter(isNode).forEach(visit);
      else if (isNode(value)) visit(value);
    }
  };
  visit(root);
  return found;
};

const nameOf = (node: SourceNode | undefined): string | undefined => identifierName(node) ?? (typeof literalValue(node) === 'string' ? String(literalValue(node)) : undefined);

const sourceOf = (node: SourceNode): string | undefined => {
  const source = literalValue(childOf(node, 'source'));
  return typeof source === 'string' ? source : undefined;
};

const declaredNames = (declaration: SourceNode | undefined): string[] => {
  if (declaration === undefined) return [];
  if (declaration.type === 'VariableDeclaration') return childrenOf(declaration, 'declarations').flatMap((declarator) => nameOf(childOf(declarator, 'id')) ?? []);
  return [nameOf(childOf(declaration, 'id'))].flatMap((name) => name ?? []);
};

export const exportedNames = (file: string): string[] =>
  childrenOf(parsed(file), 'body')
    .flatMap((statement) => {
      if (statement.type === 'ExportAllDeclaration') {
        const source = sourceOf(statement);
        return source === undefined ? [] : exportedNames(path.resolve(path.dirname(file), source));
      }
      if (statement.type !== 'ExportNamedDeclaration') return [];
      return [...childrenOf(statement, 'specifiers').flatMap((specifier) => nameOf(childOf(specifier, 'exported')) ?? []), ...declaredNames(childOf(statement, 'declaration'))];
    })
    .sort();

const namesAnyMemberOf = (nodes: readonly SourceNode[]): string[] =>
  nodes.flatMap((node) => {
    if (node.type === 'MemberExpression' && node['computed'] !== true) return nameOf(childOf(node, 'property')) ?? [];
    if (node.type === 'Property' && node['computed'] !== true) return nameOf(childOf(node, 'key')) ?? [];
    if (node.type === 'TSQualifiedName') return nameOf(childOf(node, 'right')) ?? [];
    return [];
  });

export const namesTakenFrom = (file: string, module: string): Set<string> => {
  const nodes = everyNode(parsed(file));
  const taken = new Set<string>();
  let whole = false;
  for (const node of nodes) {
    if ((node.type === 'ImportExpression' || node.type === 'TSImportType' || node.type === 'ExportAllDeclaration') && sourceOf(node) === module) whole = true;
    if (node.type === 'CallExpression' && childrenOf(node, 'arguments').some((argument) => literalValue(argument) === module)) whole = true;
    if ((node.type !== 'ImportDeclaration' && node.type !== 'ExportNamedDeclaration') || sourceOf(node) !== module) continue;
    for (const specifier of childrenOf(node, 'specifiers')) {
      if (specifier.type === 'ImportNamespaceSpecifier') whole = true;
      else taken.add(nameOf(childOf(specifier, specifier.type === 'ExportSpecifier' ? 'local' : 'imported')) ?? 'default');
    }
  }
  if (whole) namesAnyMemberOf(nodes).forEach((name) => taken.add(name));
  return taken;
};

const filesUnder = (directory: string): string[] =>
  fs.existsSync(directory)
    ? fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(directory, entry.name);
        if (entry.name === 'node_modules') return [];
        if (entry.isDirectory()) return filesUnder(full);
        return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
      })
    : [];

const isTest = (file: string): boolean => /\.test\.tsx?$/.test(file);

const packagesBut = (excluded: readonly string[]): string[] => fs.readdirSync(path.join(ROOT, 'packages')).filter((name) => !excluded.includes(name));

export const productFilesOutside = (owner: string): string[] => [
  ...packagesBut([owner, 'testkit']).flatMap((name) => filesUnder(path.join(ROOT, 'packages', name, 'src'))),
  ...filesUnder(path.join(ROOT, 'scripts')).filter((file) => !isTest(file) && !file.includes(`${path.sep}support${path.sep}`)),
];

export const testFiles = (): string[] => [
  ...packagesBut([]).flatMap((name) => filesUnder(path.join(ROOT, 'packages', name, 'test'))),
  ...filesUnder(path.join(ROOT, 'packages', 'testkit', 'src')),
  ...filesUnder(path.join(ROOT, 'test')),
  ...filesUnder(path.join(ROOT, 'e2e')),
  ...filesUnder(path.join(ROOT, 'scripts')).filter((file) => isTest(file) || file.includes(`${path.sep}support${path.sep}`)),
];

export const namesTakenBy = (files: readonly string[], module: string): Set<string> => new Set(files.flatMap((file) => [...namesTakenFrom(file, module)]));
