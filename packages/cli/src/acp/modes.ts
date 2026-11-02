import { RequestError } from '@agentclientprotocol/sdk';
import type { SessionMode, SessionModeState } from '@agentclientprotocol/sdk';
import type { PermissionMode } from '@momonga/protocol';
import { selectableModes } from '../modes.ts';
import type { ModeAvailability } from '../modes.ts';

const DESCRIPTIONS: Readonly<Record<PermissionMode, { name: string; description: string }>> = {
  default: { name: 'Default', description: 'Ask before edits and commands' },
  acceptEdits: { name: 'Accept edits', description: 'Apply edits inside the workspace without asking; ask before commands' },
  plan: { name: 'Plan', description: 'Offer read-only tools so the agent can plan without changing anything' },
  auto: { name: 'Auto', description: 'Let a classifier decide which tool calls to allow' },
  bypassPermissions: { name: 'Bypass permissions', description: 'Run every tool without asking' },
};

export type ModeSource = ModeAvailability & { readonly permissionMode: PermissionMode };

export const modeStateOf = (source: ModeSource): SessionModeState => ({
  currentModeId: source.permissionMode,
  availableModes: selectableModes(source).map((mode): SessionMode => ({ id: mode, ...DESCRIPTIONS[mode] })),
});

export const selectableModeOf = (source: ModeAvailability, modeId: string): PermissionMode => {
  const mode = selectableModes(source).find((candidate) => candidate === modeId);
  if (mode === undefined) throw RequestError.invalidParams({ modeId }, `the mode ${modeId} is not available in this session`);
  return mode;
};
