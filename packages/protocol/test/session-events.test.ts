import { describe, expectTypeOf, it } from 'vitest';
import type { InboxRowView, PermissionMode, RunEventPayload, SessionEvent, SessionEventPayload, UserShellRecord } from '@momonga/protocol';

describe('session-scoped events', () => {
  it('defines SessionEventPayload as mode.changed, model.changed, inbox.changed and user_shell', () => {
    expectTypeOf<SessionEventPayload>().toEqualTypeOf<
      { type: 'mode.changed'; mode: PermissionMode | 'unknown' } | { type: 'model.changed'; modelAlias: string; previousModelAlias: string } | { type: 'inbox.changed'; pending: InboxRowView[] } | ({ type: 'user_shell' } & UserShellRecord)
    >();
  });

  it('defines SessionEvent as the payload plus id, sessionId and createdAt', () => {
    expectTypeOf<SessionEvent>().toEqualTypeOf<
      ({ type: 'mode.changed'; mode: PermissionMode | 'unknown' } | { type: 'model.changed'; modelAlias: string; previousModelAlias: string } | { type: 'inbox.changed'; pending: InboxRowView[] } | ({ type: 'user_shell' } & UserShellRecord)) & { id: number; sessionId: string; createdAt: number }
    >();
    expectTypeOf<SessionEvent>().not.toHaveProperty('runId');
    expectTypeOf<SessionEvent>().not.toHaveProperty('seq');
    expectTypeOf<SessionEvent>().not.toHaveProperty('leaseToken');
  });

  it('keeps mode.changed, model.changed and inbox.changed out of the run event union', () => {
    expectTypeOf<Extract<RunEventPayload, { type: 'mode.changed' }>>().toBeNever();
    expectTypeOf<Extract<RunEventPayload, { type: 'model.changed' }>>().toBeNever();
    expectTypeOf<Extract<RunEventPayload, { type: 'inbox.changed' }>>().toBeNever();
  });
});
