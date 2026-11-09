import { describe, expectTypeOf, it } from 'vitest';
import type { PermissionMode, RunEventPayload, SessionEvent, SessionEventPayload } from '@momonga/protocol';

describe('session-scoped events', () => {
  it('defines SessionEventPayload as mode.changed and model.changed', () => {
    expectTypeOf<SessionEventPayload>().toEqualTypeOf<
      { type: 'mode.changed'; mode: PermissionMode | 'unknown' } | { type: 'model.changed'; modelAlias: string; previousModelAlias: string }
    >();
  });

  it('defines SessionEvent as the payload plus id, sessionId and createdAt', () => {
    expectTypeOf<SessionEvent>().toEqualTypeOf<
      ({ type: 'mode.changed'; mode: PermissionMode | 'unknown' } | { type: 'model.changed'; modelAlias: string; previousModelAlias: string }) & { id: number; sessionId: string; createdAt: number }
    >();
    expectTypeOf<SessionEvent>().not.toHaveProperty('runId');
    expectTypeOf<SessionEvent>().not.toHaveProperty('seq');
    expectTypeOf<SessionEvent>().not.toHaveProperty('leaseToken');
  });

  it('keeps mode.changed and model.changed out of the run event union', () => {
    expectTypeOf<Extract<RunEventPayload, { type: 'mode.changed' }>>().toBeNever();
    expectTypeOf<Extract<RunEventPayload, { type: 'model.changed' }>>().toBeNever();
  });
});
