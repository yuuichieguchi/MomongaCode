import { describe, expect, it } from 'vitest';
import { McpElicitationAnswerError, McpInputProtocolError, parseElicitationAnswers, parseInputRequests } from '@momonga/mcp';

const nameForm = {
  method: 'elicitation/create',
  params: { message: 'Name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' }, age: { type: 'integer', minimum: 18 } }, required: ['name'] } },
};
const link = { method: 'elicitation/create', params: { mode: 'url', message: 'Connect', url: 'https://example.test/c' } };

describe('parseInputRequests', () => {
  it('treats a request without a mode as a form and strips control characters from the message', () => {
    const [request] = parseInputRequests({ who: { ...nameForm, params: { ...nameForm.params, message: 'Name?\u001b[31m\u0007' } } });
    expect(request).toMatchObject({ key: 'who', mode: 'form', message: 'Name?' });
  });

  it.each([
    ['sampling', { method: 'sampling/createMessage', params: {} }, 'sampling/createMessage'],
    ['roots', { method: 'roots/list' }, 'roots/list'],
    ['an unknown mode', { method: 'elicitation/create', params: { mode: 'voice', message: 'x' } }, 'unsupported elicitation mode'],
    ['a file url', { method: 'elicitation/create', params: { mode: 'url', message: 'x', url: 'file:///etc/passwd' } }, 'only http and https'],
    ['a url that is not absolute', { method: 'elicitation/create', params: { mode: 'url', message: 'x', url: '/relative' } }, 'not an absolute URL'],
    ['a form without a schema', { method: 'elicitation/create', params: { message: 'x' } }, 'without a requestedSchema'],
  ])('rejects %s with a typed error', (_name, entry, fragment) => {
    expect(() => parseInputRequests({ k: entry })).toThrow(McpInputProtocolError);
    expect(() => parseInputRequests({ k: entry })).toThrow(fragment);
  });
});

describe('parseElicitationAnswers', () => {
  const requests = parseInputRequests({ who: nameForm, link });

  it('accepts a form answer that matches the schema and a url consent', () => {
    expect(parseElicitationAnswers(requests, { who: { action: 'accept', content: { name: 'Ada', age: 30 } }, link: { action: 'accept' } })).toEqual({
      who: { action: 'accept', content: { name: 'Ada', age: 30 } },
      link: { action: 'accept' },
    });
  });

  it('lets a person decline or cancel without content', () => {
    expect(parseElicitationAnswers(requests, { who: { action: 'decline' }, link: { action: 'cancel' } })).toEqual({ who: { action: 'decline' }, link: { action: 'cancel' } });
  });

  it.each([
    ['content that breaks the schema', { who: { action: 'accept', content: { age: 3 } }, link: { action: 'accept' } }, 'does not match the requested schema'],
    ['an accepted form without content', { who: { action: 'accept' }, link: { action: 'accept' } }, 'must carry content'],
    ['content on a url consent', { who: { action: 'decline' }, link: { action: 'accept', content: { a: 'b' } } }, 'must not carry content'],
    ['a missing answer', { who: { action: 'decline' } }, 'no answer was given for "link"'],
    ['an unknown key', { who: { action: 'decline' }, link: { action: 'cancel' }, extra: { action: 'cancel' } }, 'not an outstanding request key'],
    ['an unknown action', { who: { action: 'maybe' }, link: { action: 'cancel' } }, 'expected accept, decline or cancel'],
    ['content on a decline', { who: { action: 'decline', content: {} }, link: { action: 'cancel' } }, 'must not carry content'],
  ])('rejects %s', (_name, answers, fragment) => {
    expect(() => parseElicitationAnswers(requests, answers)).toThrow(McpElicitationAnswerError);
    expect(() => parseElicitationAnswers(requests, answers)).toThrow(fragment);
  });
});
