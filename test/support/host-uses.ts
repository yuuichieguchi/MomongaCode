import { childOf, childrenOf, countInto, hostModuleOf, identifierName, literalValue, memberChain, unwrapped } from './source-scan.ts';
import type { Counts, ParsedSource, Reference, SourceNode } from './source-scan.ts';

const GLOBAL_TIMERS = new Set(['setTimeout', 'setInterval', 'setImmediate']);

const GLOBAL_MEMBERS = new Set(['AbortSignal.timeout', 'Date.now', 'performance.now', 'Math.random', 'process.kill', 'process.hrtime', 'crypto.randomUUID', 'crypto.getRandomValues']);

const RANDOM_SOURCES = new Set(['randomUUID', 'randomBytes', 'randomInt', 'randomFill', 'randomFillSync', 'getRandomValues', 'webcrypto']);

const TIMER_SOURCES: Readonly<Record<string, string>> = { setTimeout: 'setTimeout', setInterval: 'setInterval', setImmediate: 'setImmediate', scheduler: 'setTimeout' };

const WHOLE_MODULES = new Set(['node:fs', 'node:fs/promises', 'node:child_process', 'node:os', 'node:net', 'node:worker_threads']);

const GLOBAL_HOST_OBJECTS: Readonly<Record<string, string>> = { 'node:perf_hooks': 'performance', 'node:process': 'process' };

const PURE_MEMBERS = new Set(['constants', 'EOL', 'devNull', 'isIP', 'isIPv4', 'isIPv6', 'BlockList', 'SocketAddress']);

const memberOf = (reference: Reference): string | undefined =>
  reference.parent?.type === 'MemberExpression' && reference.key === 'object' && reference.parent['computed'] !== true
    ? identifierName(childOf(reference.parent, 'property'))
    : undefined;

const capabilityOf = (module: string, name: string | undefined): string | undefined => {
  if (module === 'node:timers' || module === 'node:timers/promises') return name === undefined ? module : TIMER_SOURCES[name];
  if (module === 'node:crypto') return name === undefined ? module : RANDOM_SOURCES.has(name) ? name : undefined;
  if (WHOLE_MODULES.has(module)) return name !== undefined && PURE_MEMBERS.has(name) ? undefined : module;
  return undefined;
};

const importedCapability = (source: ParsedSource, reference: Reference): string | undefined => {
  const binding = source.imports.get(identifierName(reference.node) ?? '');
  if (binding === undefined) return undefined;
  const module = hostModuleOf(binding.module);
  if (module === undefined || module in GLOBAL_HOST_OBJECTS) return undefined;
  const whole = binding.imported === '*' || binding.imported === 'default';
  return capabilityOf(module, whole ? memberOf(reference) : binding.imported);
};

const isHostGlobal = (source: ParsedSource, name: string): boolean => {
  if (source.locals.has(name)) return false;
  const binding = source.imports.get(name);
  if (binding === undefined) return true;
  return GLOBAL_HOST_OBJECTS[hostModuleOf(binding.module) ?? ''] === name;
};

const requestedModule = (node: SourceNode): string | undefined => {
  const requested =
    node.type === 'ImportExpression'
      ? childOf(node, 'source')
      : node.type === 'CallExpression' && ['require', 'process.getBuiltinModule'].includes(memberChain(childOf(node, 'callee')) ?? '')
        ? childrenOf(node, 'arguments')[0]
        : undefined;
  const specifier = literalValue(unwrapped(requested));
  return typeof specifier === 'string' ? hostModuleOf(specifier) : undefined;
};

export const countHostUses = (source: ParsedSource): Counts => {
  const counts: Counts = {};
  for (const reference of source.references) {
    const name = identifierName(reference.node) ?? '';
    const imported = importedCapability(source, reference);
    if (imported !== undefined) countInto(counts, imported);
    else if (GLOBAL_TIMERS.has(name) && isHostGlobal(source, name)) countInto(counts, name);
  }
  for (const { node } of source.nodes) {
    if (node.type === 'MemberExpression') {
      const chain = memberChain(node);
      if (chain !== undefined && GLOBAL_MEMBERS.has(chain) && isHostGlobal(source, chain.slice(0, chain.indexOf('.')))) countInto(counts, chain);
      if (chain !== undefined && GLOBAL_TIMERS.has(chain) && memberChain(childOf(node, 'object')) === 'globalThis') countInto(counts, chain);
    }
    if (node.type === 'NewExpression' && identifierName(childOf(node, 'callee')) === 'Date' && childrenOf(node, 'arguments').length === 0 && isHostGlobal(source, 'Date')) {
      countInto(counts, 'new Date()');
    }
    if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
      const module = hostModuleOf(String(literalValue(childOf(node, 'source'))));
      if (module !== undefined && node['exportKind'] !== 'type') countInto(counts, module);
    }
    const requested = requestedModule(node);
    if (requested !== undefined) countInto(counts, requested);
  }
  return counts;
};

export const countSynchronousFileCalls = (source: ParsedSource): Counts => {
  const counts: Counts = {};
  for (const reference of source.references) {
    const binding = source.imports.get(identifierName(reference.node) ?? '');
    if (binding === undefined || hostModuleOf(binding.module) !== 'node:fs') continue;
    const whole = binding.imported === '*' || binding.imported === 'default';
    const name = whole ? memberOf(reference) : binding.imported;
    if (name !== undefined && name.endsWith('Sync')) countInto(counts, name);
  }
  return counts;
};

const CLI_MEMBERS = new Set(['process.env']);

const CLI_NAMES = new Set(['createHostExec', 'nodeFileSystem']);

export const countCliUses = (source: ParsedSource): Counts => {
  const counts: Counts = {};
  for (const reference of source.references) {
    const name = identifierName(reference.node) ?? '';
    if (CLI_NAMES.has(name) && !source.locals.has(name)) countInto(counts, name);
  }
  for (const { node } of source.nodes) {
    const chain = node.type === 'MemberExpression' ? memberChain(node) : undefined;
    if (chain !== undefined && CLI_MEMBERS.has(chain) && isHostGlobal(source, 'process')) countInto(counts, chain);
  }
  return counts;
};
