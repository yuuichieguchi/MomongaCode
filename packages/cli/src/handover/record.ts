import { createHash } from 'node:crypto';
import path from 'node:path';
import { HANDOVER_DIRECTORY, HANDOVER_RECORD_MAX_BYTES, HANDOVER_RECORD_SUFFIX, handoverDirectoryOf, handoverRecordFields, isRecord, parseOutsideJson } from '@momonga/foundation';
import type { HandoverRecordParties, MomongaPaths } from '@momonga/foundation';
import { QUIESCENT_BEHAVIOURS } from '@momonga/protocol';
import type { ImageAttachment, QuiescentBehaviour } from '@momonga/protocol';
import { OUTPUT_FORMATS } from '../run/output-format.ts';
import type { OutputFormat } from '../run/output-format.ts';
import type { TerminalSize } from '../tui/terminal/layer.ts';
import { isNegotiationState, NEWLINE_HINT } from '../tui/terminal/negotiation.ts';
import type { NegotiationState, NewlineHint } from '../tui/terminal/negotiation.ts';

export const HANDOVER_FORMAT = 'handover/1';
export { HANDOVER_DIRECTORY, HANDOVER_RECORD_MAX_BYTES };

const RECORD_SUFFIX = HANDOVER_RECORD_SUFFIX;
const TOO_LARGE_REASON = 'the record is larger than 1 MiB';

export const HANDOVER_KINDS = ['tui', 'acp', 'attach', 'headless'] as const;

export type HandoverKind = (typeof HANDOVER_KINDS)[number];

export type EventKey = { runId: string; seq: number };

export type EntryKey = EventKey & { index: number };

export type HandoverNote = { anchor: EventKey | null; kind: 'info' | 'notice' | 'error'; level: 'info' | 'warning' | 'error'; text: string };

export type HandoverView = { key: EntryKey | null; rowOffset: number; following: boolean };

export type HandoverToggles = { thoughts: Record<string, boolean> };

export type HandoverPaste = { start: number; label: string; text: string };

export type HandoverInput = { text: string; cursor: number; historyIndex: number | null; draft?: string; draftPastes?: HandoverPaste[]; pastes?: HandoverPaste[]; pasteCount?: number; shell?: boolean; draftShell?: boolean };

export type HandoverAttachment = { file: string; sha256: string };

type Common = { format: typeof HANDOVER_FORMAT; fromVersion: string; toVersion: string; session: string; lastSeq: Record<string, number> };

export type TuiRecord = Common & {
  kind: 'tui';
  neg: NegotiationState;
  hint: NewlineHint;
  size: TerminalSize;
  view?: HandoverView;
  toggles?: HandoverToggles;
  printed?: number;
  input: HandoverInput;
  attachments: HandoverAttachment[];
  notes: HandoverNote[];
};

export type AcpRecord = Common & { kind: 'acp'; initialize: unknown; sessions: string[]; input: string };

export type StreamQuiescence = { onQuiescent?: QuiescentBehaviour };

export type StreamRecord = Common & { kind: 'attach' | 'headless'; runId: string; output: OutputFormat; verbose: boolean; quiescent?: StreamQuiescence };

export type HandoverRecord = TuiRecord | AcpRecord | StreamRecord;

export type EncodedRecord = { kind: 'fits'; text: string } | { kind: 'too-large'; bytes: number };

export type ParsedRecord = { kind: 'record'; record: HandoverRecord } | { kind: 'refused'; reason: string };

export const encodeRecord = (record: HandoverRecord, parties: HandoverRecordParties): EncodedRecord => {
  const text = JSON.stringify({ ...record, ...handoverRecordFields(parties) });
  const bytes = Buffer.byteLength(text, 'utf8');
  return bytes > HANDOVER_RECORD_MAX_BYTES ? { kind: 'too-large', bytes } : { kind: 'fits', text };
};

export type RecordName = { session: string; kind: HandoverKind };

export const recordFileOf = (paths: Pick<MomongaPaths, 'run'>, kind: HandoverKind, session: string): string => path.join(handoverDirectoryOf(paths), `${session}.${kind}${RECORD_SUFFIX}`);

export const recordNameOf = (file: string): RecordName | undefined => {
  const stem = path.basename(file, RECORD_SUFFIX);
  const dot = stem.lastIndexOf('.');
  const kind = HANDOVER_KINDS.find((candidate) => candidate === stem.slice(dot + 1));
  return dot <= 0 || kind === undefined ? undefined : { session: stem.slice(0, dot), kind };
};

export const attachmentDigest = (image: ImageAttachment): string => createHash('sha256').update(image.mediaType).update('\n').update(image.data).digest('hex');

class Refused extends Error {}

type Fields = Readonly<Record<string, unknown>>;

const malformed = (name: string): Refused => new Refused(`the record field ${name} is missing or malformed`);

const textOf = (fields: Fields, name: string): string => {
  const value = fields[name];
  if (typeof value !== 'string') throw malformed(name);
  return value;
};

const countOf = (fields: Fields, name: string): number => {
  const value = fields[name];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw malformed(name);
  return value;
};

const flagOf = (fields: Fields, name: string): boolean => {
  const value = fields[name];
  if (typeof value !== 'boolean') throw malformed(name);
  return value;
};

const objectOf = (fields: Fields, name: string): Fields => {
  const value = fields[name];
  if (!isRecord(value)) throw malformed(name);
  return value;
};

const listOf = <T>(fields: Fields, name: string, item: (value: Fields) => T): T[] => {
  const value = fields[name];
  if (!Array.isArray(value)) throw malformed(name);
  return value.map((each: unknown) => {
    if (!isRecord(each)) throw malformed(name);
    return item(each);
  });
};

const oneOf = <T extends string>(fields: Fields, name: string, allowed: readonly T[]): T => {
  const value = fields[name];
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) throw malformed(name);
  return found;
};

const eventKeyOf = (fields: Fields): EventKey => ({ runId: textOf(fields, 'runId'), seq: countOf(fields, 'seq') });

const lastSeqOf = (fields: Fields): Record<string, number> => {
  const given = objectOf(fields, 'lastSeq');
  return Object.fromEntries(Object.keys(given).map((runId) => [runId, countOf(given, runId)]));
};

const commonOf = (fields: Fields): Common => ({
  format: HANDOVER_FORMAT,
  fromVersion: textOf(fields, 'fromVersion'),
  toVersion: textOf(fields, 'toVersion'),
  session: textOf(fields, 'session'),
  lastSeq: lastSeqOf(fields),
});

const noteOf = (fields: Fields): HandoverNote => ({
  anchor: fields['anchor'] === null ? null : eventKeyOf(objectOf(fields, 'anchor')),
  kind: oneOf(fields, 'kind', ['info', 'notice', 'error']),
  level: oneOf(fields, 'level', ['info', 'warning', 'error']),
  text: textOf(fields, 'text'),
});

const viewOf = (fields: Fields): HandoverView => {
  const key = fields['key'] === null ? null : objectOf(fields, 'key');
  return { key: key === null ? null : { ...eventKeyOf(key), index: countOf(key, 'index') }, rowOffset: countOf(fields, 'rowOffset'), following: flagOf(fields, 'following') };
};

const togglesOf = (fields: Fields): HandoverToggles => {
  const thoughts = objectOf(fields, 'thoughts');
  return { thoughts: Object.fromEntries(Object.keys(thoughts).map((itemId) => [itemId, flagOf(thoughts, itemId)])) };
};

const pasteOf = (paste: Fields): HandoverPaste => ({ start: countOf(paste, 'start'), label: textOf(paste, 'label'), text: textOf(paste, 'text') });

const inputOf = (fields: Fields): HandoverInput => ({
  text: textOf(fields, 'text'),
  cursor: countOf(fields, 'cursor'),
  historyIndex: fields['historyIndex'] === null ? null : countOf(fields, 'historyIndex'),
  ...(fields['draft'] === undefined ? {} : { draft: textOf(fields, 'draft') }),
  ...(fields['draftPastes'] === undefined ? {} : { draftPastes: listOf(fields, 'draftPastes', pasteOf) }),
  ...(fields['pastes'] === undefined ? {} : { pastes: listOf(fields, 'pastes', pasteOf) }),
  ...(fields['pasteCount'] === undefined ? {} : { pasteCount: countOf(fields, 'pasteCount') }),
  ...(fields['shell'] === undefined ? {} : { shell: flagOf(fields, 'shell') }),
  ...(fields['draftShell'] === undefined ? {} : { draftShell: flagOf(fields, 'draftShell') }),
});

const tuiOf = (fields: Fields): TuiRecord => {
  if (fields['view'] !== undefined && fields['printed'] !== undefined) throw new Refused('the record holds both a viewport and a printed count');
  const neg = fields['neg'];
  if (!isNegotiationState(neg)) throw malformed('neg');
  const size = objectOf(fields, 'size');
  return {
    ...commonOf(fields),
    kind: 'tui',
    neg,
    hint: oneOf(fields, 'hint', [...new Set(Object.values(NEWLINE_HINT))]),
    size: { columns: countOf(size, 'columns'), rows: countOf(size, 'rows') },
    ...(fields['view'] === undefined ? {} : { view: viewOf(objectOf(fields, 'view')) }),
    ...(fields['toggles'] === undefined ? {} : { toggles: togglesOf(objectOf(fields, 'toggles')) }),
    ...(fields['printed'] === undefined ? {} : { printed: countOf(fields, 'printed') }),
    input: inputOf(objectOf(fields, 'input')),
    attachments: listOf(fields, 'attachments', (attachment) => ({ file: textOf(attachment, 'file'), sha256: textOf(attachment, 'sha256') })),
    notes: listOf(fields, 'notes', noteOf),
  };
};

const acpOf = (fields: Fields): AcpRecord => {
  const sessions = fields['sessions'];
  if (!Array.isArray(sessions) || !sessions.every((session): session is string => typeof session === 'string')) throw malformed('sessions');
  if (!('initialize' in fields)) throw malformed('initialize');
  return { ...commonOf(fields), kind: 'acp', initialize: fields['initialize'], sessions, input: textOf(fields, 'input') };
};

const quiescenceOf = (fields: Fields): StreamQuiescence | undefined => {
  if (fields['quiescent'] === undefined) return undefined;
  const value = objectOf(fields, 'quiescent');
  return value['onQuiescent'] === undefined ? {} : { onQuiescent: oneOf(value, 'onQuiescent', QUIESCENT_BEHAVIOURS) };
};

const streamOf = (fields: Fields, kind: 'attach' | 'headless'): StreamRecord => {
  const quiescent = quiescenceOf(fields);
  return {
    ...commonOf(fields),
    kind,
    runId: textOf(fields, 'runId'),
    output: oneOf(fields, 'output', OUTPUT_FORMATS),
    verbose: flagOf(fields, 'verbose'),
    ...(quiescent === undefined ? {} : { quiescent }),
  };
};

const recordOf = (fields: Fields): HandoverRecord => {
  const { format, kind } = fields;
  if (typeof format !== 'string') throw new Refused('the record names no format');
  if (format !== HANDOVER_FORMAT) throw new Refused(`the record format ${format} is not known to this version`);
  if (kind === 'tui') return tuiOf(fields);
  if (kind === 'acp') return acpOf(fields);
  if (kind === 'attach' || kind === 'headless') return streamOf(fields, kind);
  throw new Refused(`the record kind ${String(kind)} is not known to this version`);
};

const jsonOf = (text: string): unknown => {
  try {
    return parseOutsideJson(text);
  } catch {
    throw new Refused('the record is not JSON');
  }
};

export const parseRecord = (text: string): ParsedRecord => {
  try {
    if (Buffer.byteLength(text, 'utf8') > HANDOVER_RECORD_MAX_BYTES) throw new Refused(TOO_LARGE_REASON);
    const parsed = jsonOf(text);
    if (!isRecord(parsed)) throw new Refused('the record names no format');
    return { kind: 'record', record: recordOf(parsed) };
  } catch (error) {
    if (error instanceof Refused) return { kind: 'refused', reason: error.message };
    throw error;
  }
};
