import { RequestError } from '@agentclientprotocol/sdk';
import type { SessionMode, SessionModeState } from '@agentclientprotocol/sdk';
import { PERMISSION_MODE_DESCRIPTIONS } from '@momonga/protocol';
import type { PermissionMode } from '@momonga/protocol';
import { selectableModes } from '../modes.ts';
import type { ModeAvailability } from '../modes.ts';

const NAMES: Readonly<Record<PermissionMode, string>> = {
  manual: 'Manual',
  acceptEdits: 'Accept edits',
  plan: 'Plan',
  auto: 'Auto',
  bypassPermissions: 'Bypass permissions',
};

export type ModeSource = ModeAvailability & { readonly permissionMode: PermissionMode };

export const modeStateOf = (source: ModeSource): SessionModeState => ({
  currentModeId: source.permissionMode,
  availableModes: selectableModes(source).map((mode): SessionMode => ({ id: mode, name: NAMES[mode], description: PERMISSION_MODE_DESCRIPTIONS[mode] })),
});

export const selectableModeOf = (source: ModeAvailability, modeId: string): PermissionMode => {
  const mode = selectableModes(source).find((candidate) => candidate === modeId);
  if (mode === undefined) throw RequestError.invalidParams({ modeId }, `the mode ${modeId} is not available in this session`);
  return mode;
};
