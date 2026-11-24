import { Box, Text } from 'ink';
import { approvalShownParts, unknownEffectLines, unknownEffectTitle } from '@momonga/protocol';
import type { ApprovalShown } from '@momonga/protocol';
import { currentField, currentRequest } from '../../elicit/flow.ts';
import type { ElicitationDecision, ElicitationFlow } from '../../elicit/flow.ts';
import type { EditorState } from '../editor.ts';
import type { KeyTable } from '../keys/table.ts';
import { joinHint } from '../select.tsx';
import type { SelectLine, SelectSpec } from '../select.tsx';
import { HELD_PANEL_LINE } from '../transcript.ts';
import type { PendingApproval, PendingElicitation, ToolEntry } from '../transcript.ts';
import { currentA11y } from './a11y.ts';
import { diffRows } from './diff.ts';
import { EditorView, editorViewRows } from './input-box.tsx';
import { styleOf } from './theme.ts';
import { inertText, wrapText } from './wrap.ts';

export const TRUST_CHOICES = [
  { decision: 'trusted', label: 'Yes, I trust this folder' },
  { decision: 'untrusted', label: 'No, continue without its project settings' },
] as const;

export type TrustDecision = (typeof TRUST_CHOICES)[number]['decision'];

const TRUST_NOTE = 'Project settings and MCP servers in this folder are only loaded when you trust it.';

export const trustHeading = (path: string): string => `Do you trust the files in ${path}?`;

export const trustSpec = (path: string): SelectSpec => ({
  title: trustHeading(path),
  lines: [TRUST_NOTE],
  rows: TRUST_CHOICES,
  initial: TRUST_CHOICES.findIndex((choice) => choice.decision === 'trusted'),
  decideOn: 'enter',
  escape: TRUST_CHOICES.findIndex((choice) => choice.decision === 'untrusted'),
  interrupt: 'exit',
  filter: false,
});

const shownLines = (shown: ApprovalShown): SelectLine[] =>
  approvalShownParts(shown).flatMap((part): SelectLine[] =>
    part.kind === 'text' ? part.lines : diffRows(part.hunks),
  );

export const approvalLines = (approval: PendingApproval): SelectLine[] => [
  approval.reason,
  ...(approval.held === true ? [HELD_PANEL_LINE] : []),
  ...(approval.shown === undefined ? [] : shownLines(approval.shown)),
];

export const approvalWording = (approval: PendingApproval, toolOf: (callId: string) => ToolEntry | undefined): { title: string; lines: SelectLine[] } => {
  if (approval.unknownCallIds === undefined) {
    const tool = toolOf(approval.callId);
    return { title: tool?.title ?? approval.callId, lines: approvalLines(approval) };
  }
  const calls = approval.unknownCallIds.map((callId) => {
    const tool = toolOf(callId);
    return { title: tool?.title ?? callId, ...(tool?.output === undefined ? {} : { found: tool.output }) };
  });
  return { title: unknownEffectTitle(calls), lines: unknownEffectLines(calls) };
};

export const waitingCounter = (waiting: number): string => (waiting > 1 ? ` (1 of ${waiting})` : '');

const escapeOf = (approval: PendingApproval): SelectSpec['escape'] => {
  const once = approval.options.findIndex((option) => option.kind === 'reject_once');
  const reject = once >= 0 ? once : approval.options.findIndex((option) => option.kind.startsWith('reject_'));
  return reject >= 0 ? reject : 'inactive';
};

export const approvalHeading = (approval: PendingApproval, title: string): string => (approval.unknownCallIds === undefined ? `Permission requested: ${title}` : title);

export const approvalSpec = (approval: PendingApproval, title: string, lines: readonly SelectLine[], waiting: number): SelectSpec => ({
  title: `${approvalHeading(approval, title)}${waitingCounter(waiting)}`,
  lines,
  rows: approval.options.map((option) => ({ label: option.name })),
  initial: 0,
  decideOn: 'immediate',
  escape: escapeOf(approval),
  interrupt: 'cancel-run',
  filter: false,
});

export const decisionChoices = (flow: ElicitationFlow): readonly { decision: ElicitationDecision; label: string }[] => {
  const accept = currentRequest(flow).mode === 'url' ? 'Open the URL in the browser and accept' : 'Submit';
  return [
    { decision: 'accept', label: accept },
    { decision: 'decline', label: 'Decline' },
    { decision: 'cancel', label: 'Cancel' },
  ];
};

export const elicitationHeading = (elicitation: Pick<PendingElicitation, 'server'>, title: string): string => `MCP server ${elicitation.server} asks for input (${title})`;

const elicitationTitle = (elicitation: PendingElicitation, title: string, waiting: number): string =>
  `${elicitationHeading(elicitation, title)} ${elicitation.flow.index + 1}/${elicitation.flow.requests.length}${waitingCounter(waiting)}`;

export const elicitationSpec = (elicitation: PendingElicitation, title: string, waiting: number): SelectSpec => {
  const { flow } = elicitation;
  const request = currentRequest(flow);
  const choices = decisionChoices(flow);
  return {
    title: elicitationTitle(elicitation, title, waiting),
    lines: [request.message, ...(request.mode === 'url' ? [`URL: ${request.url}`] : []), ...(flow.error === undefined ? [] : [{ text: flow.error, token: 'error' as const }])],
    rows: choices.map((choice) => ({ label: choice.label, ...(choice.decision === 'accept' && request.mode === 'url' ? { opensBrowser: true } : {}) })),
    initial: 0,
    decideOn: 'immediate',
    escape: choices.findIndex((choice) => choice.decision === 'decline'),
    interrupt: 'cancel-run',
    filter: false,
  };
};

export const fieldHint = (keys: KeyTable): string => {
  const confirm = keys.keyHint('select.decide');
  const leave = keys.keyHint('select.escape');
  return joinHint([...(confirm === '' ? [] : [`${confirm} to confirm the value`]), ...(leave === '' ? [] : [`${leave}: decline or cancel instead`])]);
};

const FIELD_BORDER_ROWS = 2;
const FIELD_BORDER_COLUMNS = 4;

const fieldBoxLineCount = (text: string, width: number): number => wrapText(text, Math.max(1, width), { links: false }).length;

/** Compute the exact rendered row height of ElicitationFields synchronously. */
export const elicitationFieldsRows = ({ elicitation, title, editor, columns, waiting, keys, screenReader = currentA11y().screenReader }: { elicitation: PendingElicitation; title: string; editor: EditorState; columns: number; waiting: number; keys: KeyTable; screenReader?: boolean }): number => {
  const { flow } = elicitation;
  const request = currentRequest(flow);
  const field = currentField(flow);
  const inner = Math.max(1, columns - (screenReader ? 0 : FIELD_BORDER_COLUMNS));
  const boxRows =
    (screenReader ? 0 : FIELD_BORDER_ROWS) +
    fieldBoxLineCount(inertText(elicitationTitle(elicitation, title, waiting)), inner) +
    fieldBoxLineCount(inertText(request.message), inner) +
    (request.mode === 'url' ? fieldBoxLineCount(inertText(`URL: ${request.url}`), inner) : 0) +
    (field === undefined
      ? 0
      : fieldBoxLineCount(inertText(`${field.title} (${field.name}, ${field.kind}${field.required ? ', required' : ', optional: leave empty to skip'})`), inner) +
        (field.description === undefined ? 0 : fieldBoxLineCount(inertText(field.description), inner)) +
        field.options.reduce((sum, option, index) => sum + fieldBoxLineCount(inertText(`  ${index + 1}. ${option.label}`), inner), 0)) +
    (flow.error === undefined ? 0 : fieldBoxLineCount(inertText(flow.error), inner)) +
    fieldBoxLineCount(fieldHint(keys), inner);
  return boxRows + editorViewRows(editor, columns, undefined, false, !screenReader);
};

export function ElicitationFields({ elicitation, title, editor, columns, waiting, keys }: { elicitation: PendingElicitation; title: string; editor: EditorState; columns: number; waiting: number; keys: KeyTable }) {
  const { flow } = elicitation;
  const request = currentRequest(flow);
  const field = currentField(flow);
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" {...(currentA11y().screenReader ? {} : { borderStyle: 'round' as const, paddingX: 1 })}>
        <Text bold>{inertText(elicitationTitle(elicitation, title, waiting))}</Text>
        <Text>{inertText(request.message)}</Text>
        {request.mode === 'url' ? <Text>{inertText(`URL: ${request.url}`)}</Text> : null}
        {field === undefined ? null : (
          <Box flexDirection="column">
            <Text bold>{inertText(`${field.title} (${field.name}, ${field.kind}${field.required ? ', required' : ', optional: leave empty to skip'})`)}</Text>
            {field.description === undefined ? null : <Text dimColor>{inertText(field.description)}</Text>}
            {field.options.map((option, index) => (
              <Text key={option.value}>{inertText(`  ${index + 1}. ${option.label}`)}</Text>
            ))}
          </Box>
        )}
        {flow.error === undefined ? null : <Text {...styleOf(['error'])}>{inertText(flow.error)}</Text>}
        <Text dimColor>{fieldHint(keys)}</Text>
      </Box>
      <EditorView editor={editor} columns={columns} rows={undefined} hidden={false} framed={!currentA11y().screenReader} />
    </Box>
  );
}
