import { PERMISSION_MODES } from '@momonga/protocol';
import type { PermissionMode } from '@momonga/protocol';

export type ModeAvailability = { readonly bypassAllowed: boolean; readonly autoAvailable: boolean };

export const selectableModes = (availability: ModeAvailability): PermissionMode[] =>
  PERMISSION_MODES.filter((mode) => (mode !== 'auto' || availability.autoAvailable) && (mode !== 'bypassPermissions' || availability.bypassAllowed));
