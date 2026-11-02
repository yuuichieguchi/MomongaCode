import { RequestError } from '@agentclientprotocol/sdk';
import type { SessionMode, SessionModeState } from '@agentclientprotocol/sdk';
import { PERMISSION_MODES } from '@momonga/protocol';
import type { PermissionMode } from '@momonga/protocol';

const DESCRIPTIONS: Readonly<Record<PermissionMode, { name: string; description: string }>> = {
  default: { name: 'Default', description: 'Ask before edits and commands' },
  acceptEdits: { name: 'Accept edits', description: 'Apply edits inside the workspace without asking; ask before commands' },
  plan: { name: 'Plan', description: 'Offer read-only tools so the agent can plan without changing anything' },
  auto: { name: 'Auto', description: 'Let a classifier decide which tool calls to allow' },
  bypassPermissions: { name: 'Bypass permissions', description: 'Run every tool without asking' },
};

export type ModeSource = { readonly permissionMode: PermissionMode; readonly bypassAllowed: boolean };

const selectableModes = (source: Pick<ModeSource, 'bypassAllowed'>): PermissionMode[] =>
  PERMISSION_MODES.filter((mode) => mode !== 'auto' && (mode !== 'bypassPermissions' || source.bypassAllowed));

export const modeStateOf = (source: ModeSource): SessionModeState => ({
  currentModeId: source.permissionMode,
  availableModes: selectableModes(source).map((mode): SessionMode => ({ id: mode, ...DESCRIPTIONS[mode] })),
});

export const selectableModeOf = (source: Pick<ModeSource, 'bypassAllowed'>, modeId: string): PermissionMode => {
  const mode = selectableModes(source).find((candidate) => candidate === modeId);
  if (mode === undefined) throw RequestError.invalidParams({ modeId }, `the mode ${modeId} is not available in this session`);
  return mode;
};
