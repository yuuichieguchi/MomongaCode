import { Box, Text } from 'ink';
import { escapeTerminalBlock } from '@momonga/protocol';
import { currentField, currentRequest } from '../../elicit/flow.ts';
import type { ElicitationDecision, ElicitationFlow } from '../../elicit/flow.ts';
import { diffOfToolInput } from '../diff.ts';
import type { DiffLine } from '../diff.ts';
import type { EditorState } from '../editor.ts';
import { joinHint } from '../select.tsx';
import type { SelectLine, SelectSpec } from '../select.tsx';
import type { PendingApproval, PendingElicitation, ToolEntry } from '../transcript.ts';
import { InputBox } from './input-box.tsx';

const shown = (text: string): string => escapeTerminalBlock(text.replaceAll('\r\n', '\n'));

export const TRUST_CHOICES = [
  { decision: 'trusted', label: 'Yes, I trust this folder' },
  { decision: 'untrusted', label: 'No, continue without its project settings' },
] as const;

export type TrustDecision = (typeof TRUST_CHOICES)[number]['decision'];

const TRUST_NOTE = 'Project settings and MCP servers in this folder are only loaded when you trust it.';

export const trustSpec = (path: string): SelectSpec => ({
  title: `Do you trust the files in ${path}?`,
  lines: [TRUST_NOTE],
  rows: TRUST_CHOICES,
  initial: TRUST_CHOICES.findIndex((choice) => choice.decision === 'trusted'),
  decideOn: 'enter',
  escape: TRUST_CHOICES.findIndex((choice) => choice.decision === 'untrusted'),
  interrupt: 'exit',
  filter: false,
});

const DIFF_STYLE = {
  added: { color: 'green', first: '+ ' },
  removed: { color: 'red', first: '- ' },
  header: { color: 'cyan', first: '' },
  context: { first: '  ' },
} as const satisfies Record<DiffLine['kind'], { color?: string; first: string }>;

export const approvalLines = (approval: PendingApproval, tool: ToolEntry | undefined, workingDirectory: string): SelectLine[] => {
  const diff = tool === undefined ? undefined : diffOfToolInput(tool.name, tool.rawInput, workingDirectory);
  return [approval.reason, ...(diff ?? []).map((line): SelectLine => ({ text: line.text, ...DIFF_STYLE[line.kind] }))];
};

export const waitingCounter = (waiting: number): string => (waiting > 1 ? ` (1 of ${waiting})` : '');

const escapeOf = (approval: PendingApproval): SelectSpec['escape'] => {
  const once = approval.options.findIndex((option) => option.kind === 'reject_once');
  const reject = once >= 0 ? once : approval.options.findIndex((option) => option.kind.startsWith('reject_'));
  return reject >= 0 ? reject : 'inactive';
};

export const approvalSpec = (approval: PendingApproval, title: string, lines: readonly SelectLine[], waiting: number): SelectSpec => ({
  title: `Permission requested: ${title}${waitingCounter(waiting)}`,
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

const elicitationTitle = (elicitation: PendingElicitation, title: string, waiting: number): string =>
  `MCP server ${elicitation.server} asks for input (${title}) ${elicitation.flow.index + 1}/${elicitation.flow.requests.length}${waitingCounter(waiting)}`;

export const elicitationSpec = (elicitation: PendingElicitation, title: string, waiting: number): SelectSpec => {
  const { flow } = elicitation;
  const request = currentRequest(flow);
  const choices = decisionChoices(flow);
  return {
    title: elicitationTitle(elicitation, title, waiting),
    lines: [request.message, ...(request.mode === 'url' ? [`URL: ${request.url}`] : []), ...(flow.error === undefined ? [] : [{ text: flow.error, color: 'red' }])],
    rows: choices.map((choice) => ({ label: choice.label })),
    initial: 0,
    decideOn: 'immediate',
    escape: choices.findIndex((choice) => choice.decision === 'decline'),
    interrupt: 'cancel-run',
    filter: false,
  };
};

const FIELD_HINT = joinHint(['enter to confirm the value', 'esc: decline or cancel instead']);

export function ElicitationFields({ elicitation, title, editor, waiting }: { elicitation: PendingElicitation; title: string; editor: EditorState; waiting: number }) {
  const { flow } = elicitation;
  const request = currentRequest(flow);
  const field = currentField(flow);
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text bold>{shown(elicitationTitle(elicitation, title, waiting))}</Text>
        <Text>{shown(request.message)}</Text>
        {request.mode === 'url' ? <Text>{shown(`URL: ${request.url}`)}</Text> : null}
        {field === undefined ? null : (
          <Box flexDirection="column">
            <Text bold>{shown(`${field.title} (${field.name}, ${field.kind}${field.required ? ', required' : ', optional: leave empty to skip'})`)}</Text>
            {field.description === undefined ? null : <Text dimColor>{shown(field.description)}</Text>}
            {field.options.map((option, index) => (
              <Text key={option.value}>{shown(`  ${index + 1}. ${option.label}`)}</Text>
            ))}
          </Box>
        )}
        {flow.error === undefined ? null : <Text color="red">{shown(flow.error)}</Text>}
        <Text dimColor>{FIELD_HINT}</Text>
      </Box>
      <InputBox editor={editor} />
    </Box>
  );
}
