import { Box, Text } from 'ink';
import { escapeTerminalLine } from '@momonga/protocol';
import type { PlanProfileView } from '@momonga/protocol';
import type { SlashCompletion } from '../slash.ts';

export type Invitation = { profile: PlanProfileView };

export const INVITATION_CHOICES = 2;

export const INVITATION_ROWS = 2 + INVITATION_CHOICES;

export const COMPLETION_ROWS = 1;

export function CompletionMenu({ completion }: { completion: SlashCompletion }) {
  return (
    <Text dimColor wrap="truncate">
      {completion.names.map((name) => `/${name}`).join('  ')} (tab completes)
    </Text>
  );
}

export function InvitationMenu({ invitation, selected }: { invitation: Invitation; selected: number }) {
  return (
    <Box flexDirection="column">
      <Text bold>New</Text>
      <Text>{escapeTerminalLine(invitation.profile.messages.inviteTitle)}</Text>
      {[invitation.profile.loginLabel, 'Not now'].map((label, index) => (
        <Text key={label}>{`${index === selected ? '›' : ' '} ${index + 1}. ${escapeTerminalLine(label)}`}</Text>
      ))}
    </Box>
  );
}
