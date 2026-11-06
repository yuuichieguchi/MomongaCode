import { HISTORY_OUTPUT_HEAD_CHARS, HISTORY_OUTPUT_TAIL_CHARS, keepingHeadAndTail } from '@momonga/foundation';
import type { Redactor } from '@momonga/foundation';
import { TERMINAL_STATUSES, assistantTextOf } from '@momonga/protocol';
import { isRecord } from './rows.ts';

export type RecordedEvent = { seq: number; step: number; type: string; payload: Record<string, unknown> };

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

type StepDraft = { seqFrom: number; seqTo: number; texts: string[]; calls: string[]; outputs: string[]; paths: Set<string> };

const bodyOf = (redactor: Redactor, groups: readonly (readonly string[])[]): string =>
  groups
    .map((group) => headAndTail(redactor.whole(group.join('\n'))))
    .filter((part) => part !== '')
    .join('\n');

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
    const { payload } = event;
    if (event.type === 'user.message' && task === '' && event.step === 0) task = stringField(payload, 'text') ?? '';
    const responseText = event.type === 'model.responded' ? responseTextOf(payload['response']) : '';
    if (responseText !== '') finalText = responseText;
    if (event.step === 0) continue;
    let draft = steps.get(event.step);
    if (draft === undefined) {
      draft = { seqFrom: event.seq, seqTo: event.seq, texts: [], calls: [], outputs: [], paths: new Set() };
      steps.set(event.step, draft);
    }
    draft.seqTo = event.seq;
    switch (event.type) {
      case 'user.message':
        draft.texts.push(stringField(payload, 'text') ?? '');
        break;
      case 'model.responded':
        draft.texts.push(responseText);
        break;
      case 'tool.call': {
        const title = stringField(payload, 'title') ?? '';
        const paths = locationPathsOf(payload);
        for (const path of paths) {
          draft.paths.add(path);
          touched.add(path);
        }
        draft.calls.push([stringField(payload, 'name') ?? '', title, ...paths.filter((path) => !title.includes(path))].join(' '));
        break;
      }
      case 'tool.completed':
        draft.outputs.push(stringField(payload, 'output') ?? '');
        break;
      default:
        break;
    }
  }
  if (firstSeq === undefined) throw new Error('a terminal run has no recorded events');
  const runBody = bodyOf(redactor, [[task], [finalText], [...touched], [outcome.padEnd(OUTCOME_LABEL_CHARS)]]);
  const documents: SearchDocument[] = [{ level: 'run', step: null, seqFrom: firstSeq, seqTo: lastSeq, body: runBody, paths: [...touched] }];
  for (const [step, draft] of steps) {
    const body = bodyOf(redactor, [draft.texts, draft.calls, draft.outputs]);
    if (body !== '') documents.push({ level: 'step', step, seqFrom: draft.seqFrom, seqTo: draft.seqTo, body, paths: [...draft.paths] });
  }
  return documents;
};
