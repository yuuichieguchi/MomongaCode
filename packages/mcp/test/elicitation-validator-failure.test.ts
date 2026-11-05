import { describe, expect, it } from 'vitest';
import { parseElicitationAnswers, parseInputRequests } from '@momonga/mcp';
import { overflowingRefChainSchema } from '@momonga/testkit';

const throwingForm = {
  method: 'elicitation/create',
  params: {
    message: 'Name?',
    requestedSchema: overflowingRefChainSchema(),
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
    expect(failures[0]).toContain('Maximum call stack size exceeded');
  });
});
