import { Box, Text } from 'ink';
import { escapeTerminalBlock } from '@momonga/protocol';
import type { PermissionOption } from '@momonga/protocol';
import { currentField, currentRequest } from '../../elicit/flow.ts';
import type { ElicitationDecision, ElicitationFlow } from '../../elicit/flow.ts';
import { clipDiff, diffOfToolInput, maxDiffLines } from '../diff.ts';
import type { DiffLine } from '../diff.ts';
import type { EditorState } from '../editor.ts';
import type { PendingApproval, PendingElicitation, ToolEntry } from '../transcript.ts';
import { InputBox } from './input-box.tsx';

const shown = (text: string): string => escapeTerminalBlock(text.replaceAll('\r\n', '\n'));

export const TRUST_CHOICES = [
  { key: '1', decision: 'trusted', label: 'Yes, I trust this folder' },
  { key: '2', decision: 'untrusted', label: 'No, continue without its project settings' },
] as const;

export type TrustDecision = (typeof TRUST_CHOICES)[number]['decision'];

const diffColor = (line: DiffLine): string | undefined => {
  switch (line.kind) {
    case 'added':
      return 'green';
    case 'removed':
      return 'red';
    case 'header':
      return 'cyan';
    case 'context':
      return undefined;
  }
};

const diffPrefix = (line: DiffLine): string => {
  switch (line.kind) {
    case 'added':
      return '+ ';
    case 'removed':
      return '- ';
    case 'header':
      return '';
    case 'context':
      return '  ';
  }
};

const colorProps = (color: string | undefined): { color?: string } => (color === undefined ? {} : { color });

function DiffView({ lines, max }: { lines: readonly DiffLine[]; max: number }) {
  const clipped = clipDiff(lines, max);
  return (
    <Box flexDirection="column">
      {clipped.lines.map((line, index) => (
        <Text key={index} {...colorProps(diffColor(line))}>
          {diffPrefix(line)}
          {shown(line.text)}
        </Text>
      ))}
      {clipped.omitted > 0 ? <Text dimColor>… {clipped.omitted} more lines</Text> : null}
    </Box>
  );
}

export function TrustPrompt({ path }: { path: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{`Do you trust the files in ${path}?`}</Text>
      <Text>Project settings and MCP servers in this folder are only loaded when you trust it.</Text>
      {TRUST_CHOICES.map((choice) => (
        <Text key={choice.key}>{`${choice.key}. ${choice.label}`}</Text>
      ))}
      <Text dimColor>esc to exit</Text>
    </Box>
  );
}

export type ApprovalPromptProps = { approval: PendingApproval; tool: ToolEntry | undefined; selected: number; workingDirectory: string; panelRows: number };

export function ApprovalPrompt({ approval, tool, selected, workingDirectory, panelRows }: ApprovalPromptProps) {
  const diff = tool === undefined ? undefined : diffOfToolInput(tool.name, tool.rawInput, workingDirectory);
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{shown(`Permission requested: ${tool?.title ?? approval.callId}`)}</Text>
      <Text>{shown(approval.reason)}</Text>
      {diff === undefined ? null : <DiffView lines={diff} max={maxDiffLines(panelRows, approval.options.length)} />}
      {approval.options.map((option: PermissionOption, index) => (
        <Text key={option.optionId} inverse={index === selected}>{shown(`${index + 1}. ${option.name}`)}</Text>
      ))}
      <Text dimColor>1-{approval.options.length} or up/down and enter to choose, esc to cancel the run</Text>
    </Box>
  );
}

export const decisionChoices = (flow: ElicitationFlow): readonly { decision: ElicitationDecision; label: string }[] => {
  const accept = currentRequest(flow).mode === 'url' ? 'Open the URL in the browser and accept' : 'Submit';
  return [
    { decision: 'accept', label: accept },
    { decision: 'decline', label: 'Decline' },
    { decision: 'cancel', label: 'Cancel' },
  ];
};

export function ElicitationPrompt({ elicitation, title, editor, selected }: { elicitation: PendingElicitation; title: string; editor: EditorState; selected: number }) {
  const { flow } = elicitation;
  const request = currentRequest(flow);
  const field = currentField(flow);
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text bold>{shown(`MCP server ${elicitation.server} asks for input (${title}) ${flow.index + 1}/${flow.requests.length}`)}</Text>
        <Text>{shown(request.message)}</Text>
        {request.mode === 'url' ? <Text>{shown(`URL: ${request.url}`)}</Text> : null}
        {flow.stage === 'fields' && field !== undefined ? (
          <Box flexDirection="column">
            <Text bold>{shown(`${field.title} (${field.name}, ${field.kind}${field.required ? ', required' : ', optional: leave empty to skip'})`)}</Text>
            {field.description === undefined ? null : <Text dimColor>{shown(field.description)}</Text>}
            {field.options.map((option, index) => (
              <Text key={option.value}>{shown(`  ${index + 1}. ${option.label}`)}</Text>
            ))}
          </Box>
        ) : null}
        {flow.stage === 'decision'
          ? decisionChoices(flow).map((choice, index) => (
              <Text key={choice.decision} inverse={index === selected}>{`${index + 1}. ${choice.label}`}</Text>
            ))
          : null}
        {flow.error === undefined ? null : <Text color="red">{shown(flow.error)}</Text>}
        {elicitation.submitted ? <Text dimColor>sending the answer…</Text> : null}
        <Text dimColor>
          {flow.stage === 'fields'
            ? 'enter to confirm the value, esc to decline or cancel instead'
            : '1-3 or up/down and enter to choose, esc to cancel the run'}
        </Text>
      </Box>
      {flow.stage === 'fields' ? <InputBox editor={editor} /> : null}
    </Box>
  );
}
