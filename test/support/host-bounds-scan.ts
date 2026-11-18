import { calleeName, childOf, childrenOf, identifierName, literalValue, memberChain, parsedProductSource, productSources, relativeOf, textOf, unwrapped } from './source-scan.ts';
import type { ParsedSource, SourceNode } from './source-scan.ts';

export interface FoundConstant {
  readonly name: string;
  readonly file: string;
}

export interface FoundClient {
  readonly file: string;
  readonly construction: string;
  readonly sets: readonly string[];
}

export type PerFile<T> = Readonly<Record<string, T>>;

export interface HostBounds {
  readonly constants: readonly FoundConstant[];
  readonly literalBounds: PerFile<number>;
  readonly signalTimeouts: PerFile<readonly string[]>;
  readonly clientsWithoutEveryBound: PerFile<number>;
  readonly synchronousChildWaits: PerFile<number>;
}

const NAMED_BOUND = /^[A-Z][A-Z0-9_]*_(MS|SECONDS|BYTES|CHARS)$/;

const NUMERIC_BOUND = /[a-z0-9](Ms|Seconds)$/;

const COUNT_WORDS = new Set(['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN', 'FIFTEEN', 'TWENTY', 'THIRTY', 'SIXTY']);

const TIME_UNIT_WORDS = new Set(['MILLISECOND', 'MILLISECONDS', 'SECOND', 'SECONDS', 'MINUTE', 'MINUTES', 'HOUR', 'HOURS', 'DAY', 'DAYS', 'WEEK', 'WEEKS']);

export const isTimeUnitName = (name: string): boolean => {
  const words = name.split('_').slice(0, -1);
  return words.length > 0 && TIME_UNIT_WORDS.has(words.at(-1) ?? '') && words.slice(0, -1).every((word) => COUNT_WORDS.has(word));
};

export const TIME_BOUND = /(_MS|_SECONDS|Ms|Seconds)$/;

const BOUND_PROPERTY = /^(timeout|\w*Timeout|\w*TimeoutMs|\w*Ms)$/;

const ARITHMETIC = new Set(['+', '-', '*', '/', '**']);

const isLiteralNumber = (node: SourceNode | undefined): boolean => {
  const plain = unwrapped(node);
  if (plain === undefined) return false;
  if (plain.type === 'Literal') return typeof literalValue(plain) === 'number';
  if (plain.type === 'UnaryExpression') return isLiteralNumber(childOf(plain, 'argument'));
  if (plain.type === 'BinaryExpression') return ARITHMETIC.has(String(plain['operator'])) && isLiteralNumber(childOf(plain, 'left')) && isLiteralNumber(childOf(plain, 'right'));
  return false;
};

const isNumericExpression = (node: SourceNode | undefined): boolean => {
  const plain = unwrapped(node);
  if (plain === undefined) return false;
  if (plain.type === 'Identifier') return NAMED_BOUND.test(identifierName(plain) ?? '');
  if (plain.type === 'BinaryExpression') return ARITHMETIC.has(String(plain['operator'])) && isNumericExpression(childOf(plain, 'left')) && isNumericExpression(childOf(plain, 'right'));
  return isLiteralNumber(plain);
};

const isZero = (node: SourceNode | undefined): boolean => literalValue(unwrapped(node)) === 0;

const isLiteralBound = (node: SourceNode | undefined): boolean => isLiteralNumber(node) && !isZero(node);

const TIMER_CALLS = new Set(['setTimeout', 'setInterval', 'sleep']);

const literalDelays = (call: SourceNode): number => (TIMER_CALLS.has(calleeName(call) ?? '') ? childrenOf(call, 'arguments').filter(isLiteralBound).length : 0);

const isSignalTimeout = (call: SourceNode): boolean => memberChain(childOf(call, 'callee')) === 'AbortSignal.timeout';

const keysOf = (args: readonly SourceNode[]): string[] =>
  args.flatMap((argument) => {
    const plain = unwrapped(argument);
    if (plain === undefined || plain.type !== 'ObjectExpression') return [];
    return childrenOf(plain, 'properties').map((property) =>
      property.type === 'SpreadElement' ? '...' : (identifierName(childOf(property, 'key')) ?? String(literalValue(childOf(property, 'key')))),
    );
  });

const SYNCHRONOUS_CHILD_CALLS = new Set(['spawnSync', 'execFileSync', 'execSync']);

const CHILD_PROCESS_MODULES = new Set(['node:child_process', 'child_process']);

const isSynchronousChildCall = (source: ParsedSource, call: SourceNode): boolean => {
  const callee = unwrapped(childOf(call, 'callee'));
  const name = identifierName(callee);
  if (name !== undefined) {
    const binding = source.imports.get(name);
    return binding !== undefined && CHILD_PROCESS_MODULES.has(binding.module) && SYNCHRONOUS_CHILD_CALLS.has(binding.imported);
  }
  const [head, method, ...rest] = (memberChain(callee) ?? '').split('.');
  const binding = source.imports.get(head ?? '');
  return rest.length === 0 && binding !== undefined && CHILD_PROCESS_MODULES.has(binding.module) && SYNCHRONOUS_CHILD_CALLS.has(method ?? '');
};

const isUnboundedSynchronousChild = (source: ParsedSource, call: SourceNode): boolean => isSynchronousChildCall(source, call) && !keysOf(childrenOf(call, 'arguments')).includes('timeout');

const UNDICI_CALLS = new Set(['fetch', 'request', 'stream', 'pipeline', 'buildConnector']);

const constructionOf = (source: ParsedSource, node: SourceNode): string | undefined => {
  const callee = unwrapped(childOf(node, 'callee'));
  const name = identifierName(callee);
  if (name === undefined) return undefined;
  const binding = source.imports.get(name);
  if (node.type === 'NewExpression') return binding?.module === 'undici' ? `new ${binding.imported}` : undefined;
  if (binding?.module === 'undici') return UNDICI_CALLS.has(binding.imported) ? `undici ${binding.imported}` : undefined;
  if (name === 'createUdsClient') return name;
  if (name === 'fetch' && binding === undefined && !source.locals.has(name)) return 'fetch';
  return undefined;
};

const REQUIRED_KEYS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  createUdsClient: [['headersTimeoutMs'], ['bodyTimeoutMs']],
  'undici buildConnector': [['timeout']],
  fetch: [['dispatcher']],
  'undici fetch': [['dispatcher']],
  'undici request': [['dispatcher']],
  'undici stream': [['dispatcher']],
  'undici pipeline': [['dispatcher']],
};

const DISPATCHER_KEYS: readonly (readonly string[])[] = [['headersTimeout'], ['bodyTimeout'], ['connect', 'connectTimeout']];

export const setsEveryBound = (client: FoundClient): boolean =>
  (REQUIRED_KEYS[client.construction] ?? DISPATCHER_KEYS).every((alternatives) => alternatives.some((key) => client.sets.includes(key)));

const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort();

const forFile = <T>(file: string, value: T, empty: boolean): PerFile<T> => (empty ? {} : { [file]: value });

export const scanSource = (source: ParsedSource): HostBounds => {
  const file = relativeOf(source.file);
  const constants = new Set<string>();
  const signalTimeouts: string[] = [];
  let literalBounds = 0;
  let clientsWithoutEveryBound = 0;
  let synchronousChildWaits = 0;
  for (const { node } of source.nodes) {
    if (node.type === 'VariableDeclaration' && node['kind'] === 'const') {
      for (const declarator of childrenOf(node, 'declarations')) {
        const name = identifierName(childOf(declarator, 'id'));
        if (name === undefined) continue;
        if (isTimeUnitName(name)) continue;
        if (NAMED_BOUND.test(name) || (NUMERIC_BOUND.test(name) && isNumericExpression(childOf(declarator, 'init')))) constants.add(name);
      }
    }
    if (node.type === 'CallExpression') {
      literalBounds += literalDelays(node);
      if (isUnboundedSynchronousChild(source, node)) synchronousChildWaits += 1;
      if (isSignalTimeout(node)) {
        const bound = childrenOf(node, 'arguments')[0];
        if (bound !== undefined) signalTimeouts.push(textOf(source, bound).replace(/\s+/g, ' '));
        if (isLiteralBound(bound)) literalBounds += 1;
      }
    }
    if (node.type === 'Property' && node['computed'] !== true && BOUND_PROPERTY.test(identifierName(childOf(node, 'key')) ?? '') && isLiteralBound(childOf(node, 'value'))) {
      literalBounds += 1;
    }
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      const construction = constructionOf(source, node);
      if (construction !== undefined && !setsEveryBound({ file, construction, sets: keysOf(childrenOf(node, 'arguments')) })) clientsWithoutEveryBound += 1;
    }
  }
  return {
    constants: [...constants].sort().map((name) => ({ name, file })),
    literalBounds: forFile(file, literalBounds, literalBounds === 0),
    signalTimeouts: forFile(file, sortedUnique(signalTimeouts), signalTimeouts.length === 0),
    clientsWithoutEveryBound: forFile(file, clientsWithoutEveryBound, clientsWithoutEveryBound === 0),
    synchronousChildWaits: forFile(file, synchronousChildWaits, synchronousChildWaits === 0),
  };
};

const joined = <T>(tables: readonly PerFile<T>[]): PerFile<T> => Object.fromEntries(tables.flatMap((table) => Object.entries(table)));

export const merged = (parts: readonly HostBounds[]): HostBounds => ({
  constants: parts.flatMap((part) => part.constants),
  literalBounds: joined(parts.map((part) => part.literalBounds)),
  signalTimeouts: joined(parts.map((part) => part.signalTimeouts)),
  clientsWithoutEveryBound: joined(parts.map((part) => part.clientsWithoutEveryBound)),
  synchronousChildWaits: joined(parts.map((part) => part.synchronousChildWaits)),
});

export const scanProduct = (): HostBounds => merged(productSources().map((file) => scanSource(parsedProductSource(file))));

const CADENCE_WORDS = new Set(['INTERVAL', 'POLL', 'TTL', 'RETENTION', 'BACKOFF', 'CADENCE', 'DEBOUNCE', 'TICK', 'HEARTBEAT', 'PERIOD']);

export const isCadenceName = (name: string): boolean => name.split('_').some((word) => CADENCE_WORDS.has(word));

export const hasRow = (document: string, name: string): boolean => document.split('\n').some((line) => line.startsWith('|') && (line.split('|')[1] ?? '').includes(`\`${name}\``));
