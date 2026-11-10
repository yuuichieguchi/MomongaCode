import { HISTORY_OUTPUT_HEAD_CHARS, HISTORY_OUTPUT_TAIL_CHARS, keepingHeadAndTail } from '@momonga/foundation';
import type { Redactor } from '@momonga/foundation';
import { TERMINAL_STATUSES, assistantTextOf } from '@momonga/protocol';
import { isRecord } from './rows.ts';

export type SearchDocument = {
  level: 'run' | 'step';
  step: number | null;
  seqFrom: number;
  seqTo: number;
  body: string;
  paths: string[];
};

const OUTCOME_LABEL_CHARS = Math.max(...TERMINAL_STATUSES.map((status) => status.length));

export const INDEXED_PAYLOAD_TYPES = ['user.message', 'model.responded', 'tool.call', 'tool.completed'] as const;

export const DRAFT_PART_KINDS = ['text', 'call', 'output'] as const;

export type DraftPartKind = (typeof DRAFT_PART_KINDS)[number];

export type DraftPart = { kind: DraftPartKind; body: string; paths: string[] };

export type EventDraft = { task?: string; finalText?: string; part?: DraftPart };

export type RunDraft = { task: string; finalText: string; paths: string[]; seqFrom: number; seqTo: number };

export type StepDraft = { step: number; seqFrom: number; seqTo: number; parts: DraftPart[] };

const headAndTail = (text: string): string => keepingHeadAndTail(text, HISTORY_OUTPUT_HEAD_CHARS, HISTORY_OUTPUT_TAIL_CHARS);

const stringField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
};

const responseTextOf = (response: unknown): string =>
  isRecord(response) && Array.isArray(response['output']) ? assistantTextOf(response['output']) : '';

export const locationPathsOf = (payload: Record<string, unknown>): string[] => {
  const locations = payload['locations'];
  if (!Array.isArray(locations)) return [];
  return locations.flatMap((location: unknown) => (isRecord(location) && typeof location['path'] === 'string' ? [location['path']] : []));
};

const stepPart = (step: number, part: DraftPart): { part?: DraftPart } => (step === 0 ? {} : { part });

export const eventDraftOf = (event: { step: number; type: string; payload: Record<string, unknown> }): EventDraft => {
  const { step, payload } = event;
  switch (event.type) {
    case 'user.message': {
      const text = stringField(payload, 'text') ?? '';
      return step === 0 ? { task: text } : { part: { kind: 'text', body: text, paths: [] } };
    }
    case 'model.responded': {
      const text = responseTextOf(payload['response']);
      return { ...(text === '' ? {} : { finalText: text }), ...stepPart(step, { kind: 'text', body: text, paths: [] }) };
    }
    case 'tool.call': {
      const title = stringField(payload, 'title') ?? '';
      const paths = locationPathsOf(payload);
      return stepPart(step, { kind: 'call', body: [stringField(payload, 'name') ?? '', title, ...paths.filter((path) => !title.includes(path))].join(' '), paths });
    }
    case 'tool.completed':
      return stepPart(step, { kind: 'output', body: stringField(payload, 'output') ?? '', paths: [] });
    default:
      return {};
  }
};

const bodyOf = (redactor: Redactor, groups: readonly (readonly string[])[]): string =>
  groups
    .map((group) => headAndTail(redactor.whole(group.join('\n'))))
    .filter((part) => part !== '')
    .join('\n');

export const runDocumentOf = (draft: RunDraft, outcome: string, redactor: Redactor): SearchDocument => ({
  level: 'run',
  step: null,
  seqFrom: draft.seqFrom,
  seqTo: draft.seqTo,
  body: bodyOf(redactor, [[draft.task], [draft.finalText], draft.paths, [outcome.padEnd(OUTCOME_LABEL_CHARS)]]),
  paths: draft.paths,
});

export const stepDocumentOf = (draft: StepDraft, redactor: Redactor): SearchDocument | undefined => {
  const bodiesOf = (kind: DraftPartKind): string[] => draft.parts.filter((part) => part.kind === kind).map((part) => part.body);
  const body = bodyOf(redactor, DRAFT_PART_KINDS.map(bodiesOf));
  if (body === '') return undefined;
  return { level: 'step', step: draft.step, seqFrom: draft.seqFrom, seqTo: draft.seqTo, body, paths: [...new Set(draft.parts.flatMap((part) => part.paths))] };
};

export type RecordedEvent = { seq: number; step: number; type: string; payload: Record<string, unknown> };

export const buildDocuments = (events: Iterable<RecordedEvent>, outcome: string, redactor: Redactor): SearchDocument[] => {
  const steps = new Map<number, StepDraft>();
  const touched = new Set<string>();
  let firstSeq: number | undefined;
  let lastSeq = 0;
  let task = '';
  let finalText = '';
  for (const event of events) {
    firstSeq ??= event.seq;
    lastSeq = event.seq;
    const draft = eventDraftOf(event);
    if (draft.task !== undefined && task === '') task = draft.task;
    if (draft.finalText !== undefined) finalText = draft.finalText;
    if (event.step === 0) continue;
    const step = steps.get(event.step) ?? { step: event.step, seqFrom: event.seq, seqTo: event.seq, parts: [] };
    steps.set(event.step, step);
    step.seqTo = event.seq;
    if (draft.part === undefined) continue;
    step.parts.push(draft.part);
    for (const path of draft.part.paths) touched.add(path);
  }
  if (firstSeq === undefined) throw new Error('a terminal run has no recorded events');
  const run = runDocumentOf({ task, finalText, paths: [...touched], seqFrom: firstSeq, seqTo: lastSeq }, outcome, redactor);
  return [run, ...[...steps.values()].flatMap((step) => stepDocumentOf(step, redactor) ?? [])];
};
