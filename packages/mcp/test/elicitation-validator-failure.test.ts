import { describe, expect, it, vi } from 'vitest';
import { parseElicitationAnswers, parseInputRequests } from '@momonga/mcp';
import { ENGINE_FAILURE_KEY, ENGINE_FAILURE_MESSAGE } from '@momonga/testkit';

vi.mock('../../foundation/src/untrusted-engine.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../foundation/src/untrusted-engine.ts')>();
  const { injectEngineFailure } = await import('../../testkit/src/engine-failure.ts');
  return { ...original, ataEngine: injectEngineFailure(original.ataEngine) };
});

const throwingForm = {
  method: 'elicitation/create',
  params: {
    message: 'Name?',
    requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, [ENGINE_FAILURE_KEY]: true },
  },
};

describe('checking an elicitation answer against a requestedSchema whose validator throws', () => {
  it('declines the request instead of accepting unchecked content or throwing the engine error', () => {
    const requests = parseInputRequests({ who: throwingForm });
    expect(requests[0]).toMatchObject({ key: 'who', mode: 'form' });
    const failures: string[] = [];
    const answers = parseElicitationAnswers(requests, { who: { action: 'accept', content: { name: 'Ada' } } }, { server: 'fx', onValidatorFailure: (request, message) => failures.push(`${request.key}: ${message}`) });
    expect(answers).toEqual({ who: { action: 'decline' } });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(ENGINE_FAILURE_MESSAGE);
  });
});
