import type { PermissionMode } from '@momonga/protocol';
import { knownValue } from '@momonga/store';
import type { RuntimeStore, Session } from '@momonga/store';

export type HeldSession = Omit<Session, 'permissionMode'> & { permissionMode: PermissionMode };

export const heldSessionOf = (store: Pick<RuntimeStore, 'getSession'>, sessionId: string): HeldSession => {
  const session = store.getSession(sessionId);
  if (session === undefined) throw new Error(`unknown session ${sessionId}`);
  return { ...session, permissionMode: knownValue(session.permissionMode, `the permission mode of session ${sessionId}`) };
};
