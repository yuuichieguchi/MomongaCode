import { describe, expect, it } from 'vitest';
import { createRunBody, eventsHeadersOf, eventsQueryOf, isApprovalView, joinSseChunk, parseSse } from './runtime-client.ts';

const deltaData = JSON.stringify({ type: 'agent.message.delta', runId: 'r1', seq: 3, step: 1, text: 'hel' });
const terminalData = JSON.stringify({
  type: 'run.status',
  id: 9,
  runId: 'r1',
  sessionId: 's1',
  seq: 9,
  step: 1,
  createdAt: 1,
  from: 'RUNNING',
  to: 'COMPLETED',
});

describe('parseSse', () => {
  it('reads id, event and data, skips keep-alive comments and unknown fields, and keeps an unfinished frame as rest', () => {
    const buffer = [
      'id: 3',
      'event: agent.message.delta',
      `data: ${deltaData}`,
      '',
      ': keep-alive',
      '',
      'retry: 1000',
      'id: 9',
      'event: run.status',
      `data: ${terminalData}`,
      '',
      'id: 10',
      'data: {"partial"',
    ].join('\n');
    const parsed = parseSse(buffer);
    expect(parsed.frames).toEqual([
      { id: '3', event: 'agent.message.delta', data: deltaData },
      { id: '9', event: 'run.status', data: terminalData },
    ]);
    expect(parsed.rest).toBe('id: 10\ndata: {"partial"');
  });

  it('joins multi-line data with a newline and accepts a field without the space', () => {
    expect(parseSse('id:1\ndata: a\ndata:b\n\n')).toEqual({ frames: [{ id: '1', data: 'a\nb' }], rest: '' });
  });

  it('a lone keep-alive produces no frame', () => {
    expect(parseSse(': keep-alive\n\n')).toEqual({ frames: [], rest: '' });
  });

  it('the terminal frame data parses to the run.status transition', () => {
    const [frame] = parseSse(`id: 9\nevent: run.status\ndata: ${terminalData}\n\n`).frames;
    expect(JSON.parse(frame?.data ?? 'null')).toMatchObject({ type: 'run.status', from: 'RUNNING', to: 'COMPLETED', runId: 'r1', seq: 9 });
  });
});

describe('joinSseChunk', () => {
  it('normalises a CRLF split across two chunks, a CR ending one chunk and the LF starting the next', () => {
    const first = parseSse(joinSseChunk('', 'id: 1\r'));
    expect(first.frames).toEqual([]);
    const second = parseSse(joinSseChunk(first.rest, '\ndata: x\r\n\r\n'));
    expect(second).toEqual({ frames: [{ id: '1', data: 'x' }], rest: '' });
  });

  it('normalises every CRLF of the joined buffer and keeps a lone LF', () => {
    expect(joinSseChunk('id: 2\r\nda', 'ta: y\r\n\n')).toBe('id: 2\ndata: y\n\n');
  });
});

describe('createRunBody', () => {
  it('sends only the input when no history is given, so the runtime default applies', () => {
    expect(createRunBody('Say hello')).toEqual({ input: 'Say hello' });
    expect(JSON.stringify(createRunBody('Say hello', {}))).toBe('{"input":"Say hello"}');
  });

  it('sends the history option when given', () => {
    expect(createRunBody('Start over', { history: 'fresh' })).toEqual({ input: 'Start over', history: 'fresh' });
    expect(createRunBody('Go on', { history: 'inherit' })).toEqual({ input: 'Go on', history: 'inherit' });
  });
});

describe('event cursor options', () => {
  it.each([
    { options: { after: 4 }, query: '?after=4', headers: { accept: 'text/event-stream' } },
    { options: { lastEventId: 7 }, query: '', headers: { accept: 'text/event-stream', 'last-event-id': '7' } },
    { options: { after: 4, lastEventId: 7 }, query: '?after=4', headers: { accept: 'text/event-stream', 'last-event-id': '7' } },
    { options: {}, query: '', headers: { accept: 'text/event-stream' } },
  ])('builds query $query and headers for $options', ({ options, query, headers }) => {
    expect(eventsQueryOf(options)).toBe(query);
    expect(eventsHeadersOf(options)).toEqual(headers);
  });

  it('sends a zero cursor instead of dropping it', () => {
    expect(eventsQueryOf({ after: 0 })).toBe('?after=0');
    expect(eventsHeadersOf({ lastEventId: 0 })).toEqual({ accept: 'text/event-stream', 'last-event-id': '0' });
  });
});

describe('isApprovalView', () => {
  it('accepts an approval with string id, runId, callId and status', () => {
    expect(isApprovalView({ id: 'a1', runId: 'r1', callId: 'c1', status: 'pending', options: [] })).toBe(true);
  });

  it.each([
    ['a missing id', { runId: 'r1', callId: 'c1', status: 'pending' }],
    ['a numeric runId', { id: 'a1', runId: 1, callId: 'c1', status: 'pending' }],
    ['a missing callId', { id: 'a1', runId: 'r1', status: 'pending' }],
    ['a missing status', { id: 'a1', runId: 'r1', callId: 'c1' }],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expect(isApprovalView(value)).toBe(false);
  });
});
