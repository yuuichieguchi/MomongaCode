import { JsonDepthError, isRecord, parseOutsideJson } from '@momonga/foundation';
import { KEY_NAMES } from '../terminal/events.ts';
import { chordOf, chordParts, isPlainKey, KEYS, KEY_CONTEXTS, MODIFIER_ORDER, RESERVED_KEYS } from './table.ts';
import type { ActionId, ActionRow, KeyContext, KeySpec } from './table.ts';

export const KEY_FILE_MAX_BYTES = 64 * 1024;

export const TEXT_CONTEXTS: readonly KeyContext[] = ['chat', 'menu', 'shell'];

export const KEPT_WITH_A_KEY: readonly ActionId[] = ['select.decide', 'select.escape', 'prompt.submit'];

const IDLE_ENTER: ActionId = 'prompt.submit';
const BUSY_ENTERS: readonly string[] = ['prompt.steer', 'prompt.queue'];

const keepsItsKey = (holder: string, taker: string | null): boolean => holder === IDLE_ENTER && taker !== null && BUSY_ENTERS.includes(taker);

const MODIFIER_ALIASES: Readonly<Record<string, string>> = { ctrl: 'ctrl', control: 'ctrl', alt: 'alt', opt: 'alt', option: 'alt', meta: 'alt', shift: 'shift', cmd: 'cmd', super: 'cmd', hyper: 'hyper' };
const KEY_ALIASES: Readonly<Record<string, string>> = { esc: 'escape', return: 'enter' };
const SPECIAL_KEYS: readonly string[] = [...KEY_NAMES, 'space'];
const PLUS = '+';

const parsePart = (part: string): KeySpec | undefined => {
  if (part === '') return undefined;
  const plusKey = part === PLUS || part.endsWith(`${PLUS}${PLUS}`);
  const words = plusKey ? part.slice(0, -1).split(PLUS).slice(0, -1) : part.split(PLUS);
  const rawKey = plusKey ? PLUS : words.pop();
  if (rawKey === undefined || rawKey === '') return undefined;
  const modifiers = new Set<string>();
  for (const word of words) {
    const modifier = MODIFIER_ALIASES[word.toLowerCase()];
    if (modifier === undefined) return undefined;
    modifiers.add(modifier);
  }
  const lowered = rawKey.toLowerCase();
  const named = KEY_ALIASES[lowered] ?? lowered;
  const single = [...rawKey].length === 1;
  if (!single && !SPECIAL_KEYS.includes(named)) return undefined;
  const key = !single ? named : modifiers.size === 0 ? rawKey : lowered;
  if (key === ' ') return undefined;
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].join(PLUS);
};

export const parseKey = (written: string): KeySpec | undefined => {
  const parts = written.trim().split(/\s+/).map(parsePart);
  const read = parts.filter((part): part is KeySpec => part !== undefined);
  return read.length === parts.length ? chordOf(read) : undefined;
};

export const isReserved = (spec: KeySpec): boolean => chordParts(spec).some((part) => RESERVED_KEYS.includes(part));

export type BindingEntry = {
  readonly context: string;
  readonly key: string;
  readonly action: string | null;
  readonly spec?: KeySpec;
  readonly rejected?: string;
};

export type KeyDocument = Record<string, unknown>;

export type BindingReport = {
  readonly rows: readonly ActionRow[];
  readonly entries: readonly BindingEntry[];
  readonly fileProblem?: string;
};

export const REASONS = {
  tooLarge: `the file is larger than ${KEY_FILE_MAX_BYTES / 1024} KiB`,
  shape: 'the file must be { "bindings": [ { "context": "<context>", "bindings": { "<key>": "<action>" } } ] }',
  unknownContext: (context: string): string => `unknown context ${context}`,
  unknownAction: (action: string): string => `unknown action ${action}`,
  otherContext: (action: string, context: string): string => `${action} belongs to the context ${context}`,
  unreadableKey: (key: string): string => `cannot read the key ${key}`,
  reserved: (key: string): string => `${key} is reserved`,
  text: (key: string, context: string): string => `${key} is text in the context ${context}`,
  twice: (key: string, context: string): string => `${key} is bound twice in the context ${context}`,
  chordStart: (key: string, context: string): string => `${key} is both a key and the start of a chord in the context ${context}`,
  noKey: (action: string): string => `${action} would have no key`,
} as const;

const isContext = (value: string): value is KeyContext => KEY_CONTEXTS.some((context) => context === value);

const firstProblem = (entry: BindingEntry, base: readonly ActionRow[]): { spec?: KeySpec; rejected?: string } => {
  if (!isContext(entry.context)) return { rejected: REASONS.unknownContext(entry.context) };
  const spec = parseKey(entry.key);
  if (spec === undefined) return { rejected: REASONS.unreadableKey(entry.key) };
  if (isReserved(spec)) return { spec, rejected: REASONS.reserved(entry.key) };
  const [first = spec] = chordParts(spec);
  if (isPlainKey(first) && TEXT_CONTEXTS.includes(entry.context)) return { spec, rejected: REASONS.text(entry.key, entry.context) };
  if (entry.action === null) return { spec };
  const row = base.find((candidate) => candidate.id === entry.action);
  if (row === undefined) return { spec, rejected: REASONS.unknownAction(entry.action) };
  if (row.context !== entry.context) return { spec, rejected: REASONS.otherContext(entry.action, row.context) };
  return { spec };
};

const entriesOf = (document: KeyDocument): BindingEntry[] | undefined => {
  const blocks = document['bindings'];
  if (!Array.isArray(blocks)) return undefined;
  const entries: BindingEntry[] = [];
  for (const block of blocks) {
    if (!isRecord(block) || typeof block['context'] !== 'string' || !isRecord(block['bindings'])) return undefined;
    for (const [key, action] of Object.entries(block['bindings'])) {
      if (action !== null && typeof action !== 'string') return undefined;
      entries.push({ context: block['context'], key, action });
    }
  }
  return entries;
};

const isPrefixOf = (prefix: KeySpec, spec: KeySpec): boolean => spec.startsWith(`${prefix} `);

const applied = (base: readonly ActionRow[], entries: readonly BindingEntry[]): { rows: ActionRow[]; emptied: Map<string, BindingEntry[]> } => {
  const keys = new Map<string, KeySpec[]>(base.map((row) => [row.id, [...row.default]]));
  const added = new Map<string, KeySpec[]>();
  const removers = new Map<string, BindingEntry[]>();
  for (const entry of entries) {
    if (entry.rejected !== undefined || entry.spec === undefined) continue;
    const { spec } = entry;
    for (const row of base) {
      if (row.context !== entry.context || row.id === entry.action || keepsItsKey(row.id, entry.action)) continue;
      const held = keys.get(row.id) ?? [];
      if (!held.includes(spec)) continue;
      keys.set(row.id, held.filter((key) => key !== spec));
      if (entry.action !== null) removers.set(row.id, [...(removers.get(row.id) ?? []), entry]);
    }
    if (entry.action !== null && !(keys.get(entry.action) ?? []).includes(spec)) added.set(entry.action, [...(added.get(entry.action) ?? []), spec]);
  }
  const rows = base.map((row) => ({ ...row, default: [...(added.get(row.id) ?? []), ...(keys.get(row.id) ?? []).filter((key) => !(added.get(row.id) ?? []).includes(key))] }));
  const emptied = new Map<string, BindingEntry[]>();
  for (const row of rows) {
    if (row.default.length > 0) continue;
    const unbinders = entries.filter((entry) => entry.rejected === undefined && entry.action === null && entry.context === row.context && entry.spec !== undefined && base.find((candidate) => candidate.id === row.id)?.default.includes(entry.spec) === true);
    const guilty = [...(removers.get(row.id) ?? []), ...(KEPT_WITH_A_KEY.includes(row.id) ? unbinders : [])];
    if (guilty.length > 0) emptied.set(row.id, guilty);
  }
  return { rows, emptied };
};

const chordConflicts = (rows: readonly ActionRow[], entries: readonly BindingEntry[]): BindingEntry[] =>
  entries.filter((entry) => {
    if (entry.rejected !== undefined || entry.spec === undefined || entry.action === null) return false;
    const { spec, context } = entry;
    const inContext = rows.filter((row) => row.context === context).flatMap((row) => row.default);
    return inContext.some((other) => other !== spec && (isPrefixOf(other, spec) || isPrefixOf(spec, other)));
  });

export const resolveBindings = (document: unknown, base: readonly ActionRow[] = KEYS): BindingReport => {
  const read = isRecord(document) ? entriesOf(document) : undefined;
  if (read === undefined) return { rows: base, entries: [], fileProblem: REASONS.shape };
  let entries = read.map((entry) => ({ ...entry, ...firstProblem(entry, base) }));
  const reject = (guilty: readonly BindingEntry[], reason: (entry: BindingEntry) => string): void => {
    entries = entries.map((entry) => (guilty.includes(entry) && entry.rejected === undefined ? { ...entry, rejected: reason(entry) } : entry));
  };
  const twice = entries.filter((entry) => entry.rejected === undefined && entries.some((other) => other !== entry && other.rejected === undefined && other.context === entry.context && other.spec === entry.spec && other.action !== entry.action));
  reject(twice, (entry) => REASONS.twice(entry.key, entry.context));
  for (let round = 0; round <= read.length; round += 1) {
    const { rows, emptied } = applied(base, entries);
    const conflicts = chordConflicts(rows, entries);
    if (conflicts.length > 0) {
      reject(conflicts, (entry) => REASONS.chordStart(entry.key, entry.context));
      continue;
    }
    if (emptied.size === 0) return { rows, entries };
    for (const [action, guilty] of emptied) reject(guilty, () => REASONS.noKey(action));
  }
  return { rows: applied(base, entries).rows, entries };
};

export type ParsedKeyFile = { readonly kind: 'document'; readonly document: KeyDocument } | { readonly kind: 'refused'; readonly reason: string };

export const parseKeyFile = (text: string): ParsedKeyFile => {
  if (Buffer.byteLength(text, 'utf8') > KEY_FILE_MAX_BYTES) return { kind: 'refused', reason: REASONS.tooLarge };
  let value: unknown;
  try {
    value = parseOutsideJson(text);
  } catch (error) {
    if (error instanceof SyntaxError) return { kind: 'refused', reason: `not valid JSON: ${error.message}` };
    if (error instanceof JsonDepthError) return { kind: 'refused', reason: error.message };
    throw error;
  }
  if (!isRecord(value) || entriesOf(value) === undefined) return { kind: 'refused', reason: REASONS.shape };
  return { kind: 'document', document: value };
};

export const EMPTY_KEY_DOCUMENT: KeyDocument = { bindings: [] };

type Block = { context: string; bindings: Record<string, unknown> };

const blocksOf = (document: KeyDocument): Block[] => {
  const blocks = document['bindings'];
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((block: unknown) => (isRecord(block) && typeof block['context'] === 'string' && isRecord(block['bindings']) ? [{ ...block, context: block['context'], bindings: { ...block['bindings'] } }] : []));
};

const withoutKey = (blocks: Block[], context: string, spec: KeySpec): Block[] =>
  blocks.map((block) => (block.context !== context ? block : { ...block, bindings: Object.fromEntries(Object.entries(block.bindings).filter(([key]) => parseKey(key) !== spec)) }));

const withEntry = (blocks: Block[], context: string, spec: KeySpec, action: string | null): Block[] => {
  const cleared = withoutKey(blocks, context, spec);
  const at = cleared.findIndex((block) => block.context === context);
  if (at < 0) return [...cleared, { context, bindings: { [spec]: action } }];
  return cleared.map((block, index) => (index === at ? { ...block, bindings: { ...block.bindings, [spec]: action } } : block));
};

export const withBinding = (document: KeyDocument, context: KeyContext, spec: KeySpec, action: ActionId): KeyDocument => ({ ...document, bindings: withEntry(blocksOf(document), context, spec, action) });

export const withoutKeysOf = (document: KeyDocument, row: ActionRow, inForce: readonly KeySpec[]): KeyDocument => {
  let blocks = blocksOf(document).map((block) => (block.context !== row.context ? block : { ...block, bindings: Object.fromEntries(Object.entries(block.bindings).filter(([, action]) => action !== row.id)) }));
  for (const spec of inForce) if (row.default.includes(spec)) blocks = withEntry(blocks, row.context, spec, null);
  return { ...document, bindings: blocks };
};

export const withDefaultsOf = (document: KeyDocument, row: ActionRow): KeyDocument => ({
  ...document,
  bindings: blocksOf(document).map((block) =>
    block.context !== row.context ? block : { ...block, bindings: Object.fromEntries(Object.entries(block.bindings).filter(([key, action]) => action !== row.id && !(action === null && row.default.includes(parseKey(key) ?? '')))) },
  ),
});

export const withAllDefaults = (document: KeyDocument): KeyDocument => ({ ...document, bindings: [] });

export const keyDocumentText = (document: KeyDocument): string => `${JSON.stringify(document, null, 2)}\n`;
