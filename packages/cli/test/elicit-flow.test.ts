import { describe, expect, it } from 'vitest';
import type { ElicitationRequestView } from '@momonga/protocol';
import { currentField, currentRequest, decide, enterValue, leaveFields, startFlow } from '../src/elicit/flow.ts';

const FORM: ElicitationRequestView = {
  key: 'profile',
  mode: 'form',
  message: 'Tell me about you',
  requestedSchema: { type: 'object', properties: { name: { type: 'string' }, age: { type: 'integer' } }, required: ['name', 'age'] },
};
const URL_REQUEST: ElicitationRequestView = { key: 'consent', mode: 'url', message: 'Sign in', url: 'https://example.test/consent?token=abc' };

describe('elicitation flow', () => {
  it('walks the fields of a form, then waits for a decision and answers accept with the collected content', () => {
    let flow = startFlow([FORM], 'fx');
    expect(flow.stage).toBe('fields');
    expect(currentField(flow)?.name).toBe('name');
    flow = enterValue(flow, 'Ada');
    expect(currentField(flow)?.name).toBe('age');
    flow = enterValue(flow, '36');
    expect(flow.stage).toBe('decision');
    flow = decide(flow, 'accept');
    expect(flow.complete).toBe(true);
    expect(flow.answers).toEqual({ profile: { action: 'accept', content: { name: 'Ada', age: 36 } } });
  });

  it('keeps the field and reports the error when the entered value does not fit the schema', () => {
    const flow = enterValue(enterValue(startFlow([FORM], 'fx'), 'Ada'), 'old');
    expect(currentField(flow)?.name).toBe('age');
    expect(flow.error).toBe('age must be a number');
    expect(flow.stage).toBe('fields');
  });

  it('goes back to the first missing required field when accept is chosen with an incomplete form', () => {
    const flow = decide(leaveFields(enterValue(startFlow([FORM], 'fx'), 'Ada')), 'accept');
    expect(flow.complete).toBe(false);
    expect(flow.stage).toBe('fields');
    expect(currentField(flow)?.name).toBe('age');
    expect(flow.error).toContain("must have required property 'age'");
  });

  it('records decline and cancel without content and never synthesises an answer for a request nobody answered', () => {
    const declined = decide(leaveFields(startFlow([FORM], 'fx')), 'decline');
    expect(declined.answers).toEqual({ profile: { action: 'decline' } });
    const partial = decide(startFlow([URL_REQUEST, FORM], 'fx'), 'cancel');
    expect(partial.complete).toBe(false);
    expect(partial.answers).toEqual({ consent: { action: 'cancel' } });
    expect(currentRequest(partial).key).toBe('profile');
  });

  it('asks for a decision straight away on a url request and accepts it without content', () => {
    const flow = startFlow([URL_REQUEST], 'fx');
    expect(flow.stage).toBe('decision');
    expect(decide(flow, 'accept').answers).toEqual({ consent: { action: 'accept' } });
  });

  it('refuses to take a value while a decision is pending', () => {
    expect(() => enterValue(startFlow([URL_REQUEST], 'fx'), 'x')).toThrow('not asking for a field');
  });
});
