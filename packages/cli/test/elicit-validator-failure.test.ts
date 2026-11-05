import { describe, expect, it, vi } from 'vitest';
import { untrustedSchemaFailure } from '@momonga/foundation';
import type { ElicitationRequestView } from '@momonga/protocol';
import { ENGINE_FAILURE_KEY } from '@momonga/testkit';
import { decide, enterValue, startFlow } from '../src/elicit/flow.ts';

vi.mock('../../foundation/src/untrusted-engine.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../foundation/src/untrusted-engine.ts')>();
  const { injectEngineFailure } = await import('../../testkit/src/engine-failure.ts');
  return { ...original, ataEngine: injectEngineFailure(original.ataEngine) };
});

const THROWING_FORM: ElicitationRequestView = {
  key: 'profile',
  mode: 'form',
  message: 'Tell me about you',
  requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, [ENGINE_FAILURE_KEY]: true },
};

describe('elicitation flow with a requestedSchema whose validator throws', () => {
  it('answers decline for the request instead of accepting unchecked content or throwing the engine error', () => {
    const flow = decide(enterValue(startFlow([THROWING_FORM], 'fx'), 'Ada'), 'accept');
    expect(flow.complete).toBe(true);
    expect(flow.answers).toEqual({ profile: { action: 'decline' } });
  });
});

describe('the validator failure of one server', () => {
  it('is recorded per server and request, not shared with another server that sends the same schema', () => {
    const decline = (server: string) => decide(enterValue(startFlow([THROWING_FORM], server), 'Ada'), 'accept');
    const recorded = (server: string) => untrustedSchemaFailure(JSON.stringify(['cli-elicitation', server, 'profile']), THROWING_FORM.requestedSchema);
    expect(decline('alpha').answers).toEqual({ profile: { action: 'decline' } });
    expect(recorded('alpha')).toBeDefined();
    expect(recorded('beta')).toBeUndefined();
    expect(decline('beta').answers).toEqual({ profile: { action: 'decline' } });
    expect(recorded('beta')).toBeDefined();
  });
});
