import { describe, expectTypeOf, it } from 'vitest';
import type { PermissionMode, RunEventPayload, SessionEvent, SessionEventPayload } from '@momonga/protocol';

describe('session-scoped events', () => {
  it('defines SessionEventPayload as mode.changed only', () => {
    expectTypeOf<SessionEventPayload>().toEqualTypeOf<{ type: 'mode.changed'; mode: PermissionMode }>();
  });

  it('defines SessionEvent as the payload plus id, sessionId and createdAt', () => {
    expectTypeOf<SessionEvent>().toEqualTypeOf<{ type: 'mode.changed'; mode: PermissionMode } & { id: number; sessionId: string; createdAt: number }>();
    expectTypeOf<SessionEvent>().not.toHaveProperty('runId');
    expectTypeOf<SessionEvent>().not.toHaveProperty('seq');
    expectTypeOf<SessionEvent>().not.toHaveProperty('leaseToken');
  });

  it('keeps mode.changed out of the run event union', () => {
    expectTypeOf<Extract<RunEventPayload, { type: 'mode.changed' }>>().toBeNever();
  });
});
