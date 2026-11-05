import { describe, expect, it } from 'vitest';
import { parseElicitationAnswers, parseInputRequests } from '@momonga/mcp';

const throwingForm = {
  method: 'elicitation/create',
  params: {
    message: 'Name?',
    requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, if: { anyOf: [{ properties: { a: {} } }], not: {} }, then: false },
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
    expect(failures[0]).toContain('props0 is not defined');
  });
});
