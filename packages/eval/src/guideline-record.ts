import { MAX_REDACTED_CHARS, safeSlice } from '@momonga/foundation';
import { assistantTextOf, escapeXmlAttribute, escapeXmlText } from '@momonga/protocol';
import type { PublicRunEvent } from '@momonga/protocol';
import type { Transcript } from './transcript.ts';

export const RECORD_OUTPUT_HEAD_CHARS = MAX_REDACTED_CHARS;

export const RECORD_OUTPUT_TAIL_CHARS = 2 * MAX_REDACTED_CHARS;

const ELISION = '\n…\n';

const headAndTail = (text: string): string =>
  text.length <= RECORD_OUTPUT_HEAD_CHARS + RECORD_OUTPUT_TAIL_CHARS
    ? text
    : `${safeSlice(text, 0, RECORD_OUTPUT_HEAD_CHARS)}${ELISION}${safeSlice(text, text.length - RECORD_OUTPUT_TAIL_CHARS, text.length)}`;

const cutTo = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text;
  const head = Math.max(0, Math.floor((maxChars - ELISION.length) / 2));
  const tail = Math.max(0, maxChars - ELISION.length - head);
  return `${safeSlice(text, 0, head)}${ELISION}${safeSlice(text, text.length - tail, text.length)}`;
};

const omissionLine = (count: number): string => `${count} earlier ${count === 1 ? 'step is' : 'steps are'} not shown.`;

const OMISSION_RESERVE_CHARS = omissionLine(Number.MAX_SAFE_INTEGER).length + 1;

type CallEvent = Extract<PublicRunEvent, { type: 'tool.call' }>;

type Piece = { kind: 'step' | 'compaction'; text: string };

const stepOf = (index: number, call: CallEvent, event: PublicRunEvent): string => {
  const status =
    event.type === 'tool.completed'
      ? `${event.status}${event.exitCode === undefined ? '' : `, exit code ${event.exitCode}`}`
      : event.type === 'tool.reconciled'
        ? `reconciled ${event.outcome}`
        : '';
  const files = event.type === 'tool.completed' ? (event.files ?? []).map((file) => `${file.access} ${file.path}`) : [];
  const output = event.type === 'tool.completed' || event.type === 'tool.reconciled' ? headAndTail(event.output) : '';
  return [
    `<step n="${index}" tool="${escapeXmlAttribute(call.name)}" title="${escapeXmlAttribute(call.title)}" status="${escapeXmlAttribute(status)}">`,
    ...files.map(escapeXmlText),
    escapeXmlText(output),
    '</step>',
  ]
    .filter((line) => line !== '')
    .join('\n');
};

const compactionOf = (event: Extract<PublicRunEvent, { type: 'context.compacted' }>): string =>
  [
    `<compaction through_seq="${event.replacedThroughSeq}" source="${escapeXmlAttribute(event.source ?? 'unknown')}">`,
    escapeXmlText(event.summary),
    '</compaction>',
  ].join('\n');

export const recordOf = (transcript: Transcript, label: string, maxChars: number | undefined): string => {
  const calls = new Map<string, CallEvent>();
  const pieces: Piece[] = [];
  let task = '';
  let final = '';
  let steps = 0;
  for (const event of transcript.events) {
    if (event.type === 'user.message' && task === '') task = event.text;
    else if (event.type === 'tool.call') calls.set(event.callId, event);
    else if (event.type === 'tool.completed' || event.type === 'tool.reconciled') {
      const call = calls.get(event.callId);
      if (call !== undefined) {
        steps += 1;
        pieces.push({ kind: 'step', text: stepOf(steps, call, event) });
      }
    } else if (event.type === 'context.compacted') pieces.push({ kind: 'compaction', text: compactionOf(event) });
    else if (event.type === 'model.responded') final = assistantTextOf(event.response.output);
  }
  const header = `<recorded_run kind="${escapeXmlAttribute(label)}" case="${escapeXmlAttribute(transcript.caseId)}" outcome="${escapeXmlAttribute(transcript.run.status)}">`;
  const pinnedChars = maxChars === undefined ? Number.POSITIVE_INFINITY : Math.max(0, maxChars - header.length - OMISSION_RESERVE_CHARS);
  const taskBlock = `<task>\n${cutTo(escapeXmlText(task), Math.floor(pinnedChars / 4))}\n</task>`;
  const finalBlock = `<final_answer>\n${cutTo(escapeXmlText(final), Math.floor(pinnedChars / 4))}\n</final_answer>`;
  const compactionChars = Math.floor(pinnedChars / 4);
  const kept: Piece[] = [];
  let remaining = pinnedChars - taskBlock.length - finalBlock.length;
  for (const piece of [...pieces].reverse()) {
    const text = piece.kind === 'compaction' ? cutTo(piece.text, compactionChars) : piece.text;
    if (text.length + 1 > remaining) break;
    remaining -= text.length + 1;
    kept.unshift({ kind: piece.kind, text });
  }
  const omitted = pieces.length - kept.length;
  return [header, taskBlock, ...(omitted === 0 ? [] : [omissionLine(omitted)]), ...kept.map((piece) => piece.text), finalBlock, '</recorded_run>'].join('\n');
};
