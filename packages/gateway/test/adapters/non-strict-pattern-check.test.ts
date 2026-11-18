import { beforeEach, describe, expect, it } from 'vitest';
import { clearUntrustedSchemaCaches } from '@momonga/foundation';
import type { AdapterRequest, StreamEvent } from '@momonga/protocol';
import { createFakeClock } from '@momonga/testkit';
import { ResponseEmitter } from '../../src/adapters/shared/response-emitter.ts';
import { START_MS } from '../gateway-helpers.ts';

const INJECTED_LIMIT_MS = 2000;
const NEVER_FINISHING_INPUT = `${'a'.repeat(48)}b`;
const HOSTILE_BACKREFERENCE = '^(a+)+\\1$';

const schemaWithPattern = (pattern: string) => ({
  type: 'object',
  properties: { value: { type: 'string', pattern } },
  required: ['value'],
  additionalProperties: false,
});

const emitterFor = (pattern: string, signal: AbortSignal, patternCheckLimitMs?: number): ResponseEmitter => {
  const request: AdapterRequest = { model: 'm', input: [] };
  const emitter = new ResponseEmitter({
    clock: createFakeClock(START_MS),
    model: 'm',
    request,
    nonStrict: new Map([['Match', schemaWithPattern(pattern)]]),
    signal,
    ...(patternCheckLimitMs === undefined ? {} : { patternCheckLimitMs }),
  });
  emitter.start();
  emitter.take();
  return emitter;
};

const closeCall = async (emitter: ResponseEmitter, value: string): Promise<StreamEvent[]> => {
  emitter.beginCall(0, 'call_1', 'Match');
  emitter.appendCallArguments(0, JSON.stringify({ value }));
  await emitter.completeCall(0);
  return emitter.take();
};

const completeWithOpenCall = async (emitter: ResponseEmitter, value: string): Promise<StreamEvent[]> => {
  emitter.beginCall(0, 'call_1', 'Match');
  emitter.appendCallArguments(0, JSON.stringify({ value }));
  await emitter.complete(undefined);
  return emitter.take();
};

beforeEach(() => {
  clearUntrustedSchemaCaches();
});

describe('the arguments of a non-strict tool are checked off the calling thread', () => {
  it.each([
    ['^(a+)-\\1$', 'aa-aa'],
    ['^(?!x)\\w+$', 'abc'],
    ['^\\w+(?<=c)$', 'abc'],
  ])('%s on %j passes the call', async (pattern, value) => {
    const events = await closeCall(emitterFor(pattern, new AbortController().signal), value);
    expect(events.map((event) => event.type)).toContain('response.output_item.done');
  });

  it.each([
    ['^(a+)-\\1$', 'aa-a'],
    ['^(?!x)\\w+$', 'xbc'],
    ['^\\w+(?<=c)$', 'abd'],
  ])('%s on %j refuses the call as malformed output', async (pattern, value) => {
    await expect(closeCall(emitterFor(pattern, new AbortController().signal), value)).rejects.toMatchObject({
      name: 'MalformedOutputError',
      message: expect.stringContaining('the arguments of tool call "Match" do not match its schema'),
    });
  });

  it('checks a call closed by the completion of the response', async () => {
    await expect(completeWithOpenCall(emitterFor('^(a+)-\\1$', new AbortController().signal), 'aa-a')).rejects.toMatchObject({ name: 'MalformedOutputError' });
  });

  it('refuses a pattern that does not end within the limit with the sentence of protocol-schema 5.5', async () => {
    const emitter = emitterFor(HOSTILE_BACKREFERENCE, new AbortController().signal, INJECTED_LIMIT_MS);
    await expect(closeCall(emitter, NEVER_FINISHING_INPUT)).rejects.toMatchObject({
      name: 'MalformedOutputError',
      message: `The arguments of Match could not be checked against its schema within ${INJECTED_LIMIT_MS / 1000} seconds: the pattern of value is too costly to match.`,
    });
  });

  it('keeps the event loop free while the pattern is matched', async () => {
    const order: string[] = [];
    setTimeout(() => order.push('timer'), 0);
    const pending = closeCall(emitterFor(HOSTILE_BACKREFERENCE, new AbortController().signal, INJECTED_LIMIT_MS), NEVER_FINISHING_INPUT).catch(() => {
      order.push('refused');
    });
    expect(order).toEqual([]);
    await pending;
    expect(order).toEqual(['timer', 'refused']);
  });

  it('ends with the reason of the request signal when the request is stopped during the check', async () => {
    const controller = new AbortController();
    const reason = new Error('the request was stopped');
    const pending = closeCall(emitterFor(HOSTILE_BACKREFERENCE, controller.signal), NEVER_FINISHING_INPUT);
    setTimeout(() => controller.abort(reason), 50);
    await expect(pending).rejects.toBe(reason);
  });
});
