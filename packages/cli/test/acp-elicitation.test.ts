import { RequestError } from '@agentclientprotocol/sdk';
import type { CreateElicitationResponse } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { elicitationAnswerOf, elicitationRequestOf } from '../src/acp/elicitation.ts';

const SCOPE = { sessionId: 'session-1', toolCallId: 'run-1/call-1', inputId: 'in-1' };

describe('elicitationRequestOf', () => {
  it('asks a form question inside the session and the tool call, with the schema of the MCP server', () => {
    const requestedSchema = { type: 'object', properties: { name: { type: 'string', title: 'Name' } }, required: ['name'] };

    expect(elicitationRequestOf(SCOPE, { key: 'who', mode: 'form', message: 'Who are you?', requestedSchema })).toEqual({
      mode: 'form',
      sessionId: 'session-1',
      toolCallId: 'run-1/call-1',
      message: 'Who are you?',
      requestedSchema,
    });
  });

  it('asks a url question under an elicitation id made of the input and the key', () => {
    expect(elicitationRequestOf(SCOPE, { key: 'login', mode: 'url', message: 'Sign in', url: 'https://example.com/login' })).toEqual({
      mode: 'url',
      sessionId: 'session-1',
      toolCallId: 'run-1/call-1',
      message: 'Sign in',
      elicitationId: 'in-1/login',
      url: 'https://example.com/login',
    });
  });

  it.each([
    ['a schema that is not an object type', { type: 'array' }],
    ['properties that are not an object', { type: 'object', properties: [] }],
    ['a required list that holds a non-name', { type: 'object', required: [1] }],
  ])('refuses %s', (_label, requestedSchema) => {
    expect(() => elicitationRequestOf(SCOPE, { key: 'who', mode: 'form', message: 'm', requestedSchema })).toThrow();
  });
});

describe('elicitationAnswerOf', () => {
  it('keeps the content of an accepted answer', () => {
    expect(elicitationAnswerOf({ action: 'accept', content: { name: 'Ada', age: 36, human: true, tags: ['a', 'b'] } })).toEqual({
      action: 'accept',
      content: { name: 'Ada', age: 36, human: true, tags: ['a', 'b'] },
    });
    expect(elicitationAnswerOf({ action: 'accept' })).toEqual({ action: 'accept' });
    expect(elicitationAnswerOf({ action: 'accept', content: null })).toEqual({ action: 'accept' });
  });

  it('maps decline and cancel to themselves', () => {
    expect(elicitationAnswerOf({ action: 'decline' })).toEqual({ action: 'decline' });
    expect(elicitationAnswerOf({ action: 'cancel' })).toEqual({ action: 'cancel' });
  });

  it('refuses an action it does not know and content it cannot pass on', () => {
    expect(() => elicitationAnswerOf({ action: 'later' } as CreateElicitationResponse)).toThrow(RequestError);
    expect(() => elicitationAnswerOf({ action: 'accept', content: { nested: { a: 1 } } } as CreateElicitationResponse)).toThrow('the elicitation answer nested is not a string');
    expect(() => elicitationAnswerOf({ action: 'accept', content: { list: [1] } } as CreateElicitationResponse)).toThrow('the elicitation answer list is not a string');
  });
});
