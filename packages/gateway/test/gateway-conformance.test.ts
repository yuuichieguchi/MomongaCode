import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, textResponseEvents, usageOf } from '@momonga/testkit';
import { counterForTest, outputText, postJson, readJson, readSse, startGateway, userInput, validator } from './gateway-helpers.ts';

const TERMINAL = ['response.completed', 'response.failed', 'response.incomplete'];

const scriptedTwice = () =>
  createScriptedAdapter({
    calls: [
      { events: textResponseEvents({ model: 'scripted-primary', chunks: ['Hello, ', 'world'], usage: usageOf(11, 3) }) },
      { events: textResponseEvents({ model: 'scripted-primary', chunks: ['Hello, ', 'world'], usage: usageOf(11, 3) }) },
    ],
  });

const stripIds = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, inner) => (key === 'id' ? undefined : inner)));

describe('POST /v1/responses conformance with the vendored Open Responses schema', () => {
  it('returns a non-stream body that validates as ResponseResource with gateway identity and the momonga extension', async () => {
    const primary = scriptedTwice();
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary } });
    const first = await readJson(await postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: userInput('hi') }));
    const second = await readJson(await postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: userInput('hi') }));

    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toMatch(/^application\/json/);
    expect(validator.validate('ResponseResource', first.body).errors).toEqual([]);
    expect(first.body.object).toBe('response');
    expect(first.body.status).toBe('completed');
    expect(first.body.model).toBe('scripted-primary');
    expect(first.body.id).toMatch(/^resp_/);
    expect(second.body.id).toMatch(/^resp_/);
    expect(first.body.id).not.toBe(second.body.id);
    expect(outputText(first.body)).toBe('Hello, world');
    expect(first.body.usage).toEqual(usageOf(11, 3));
    expect(first.body.momonga).toEqual({ model: 'scripted/scripted-primary', target: 'scripted/scripted-primary', counter: counterForTest('scripted/scripted-primary'), attempts: 1, usageSource: 'reported', unpriced: { code: 'no_price_entry', reason: 'no price table' } });
    expect(primary.calls).toHaveLength(2);
    expect(primary.calls[0]?.request.model).toBe('scripted-primary');
  });

  it('streams events that each validate, increase strictly, open with the lifecycle events, and end with one terminal event', async () => {
    const primary = scriptedTwice();
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary } });
    const frames = await readSse(await postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: userInput('hi'), stream: true }));
    const names = validator.streamEventSchemaNames();

    for (const frame of frames) {
      expect(frame.event).toBe(frame.data.type);
      const component = names.get(frame.data.type);
      if (component !== undefined) expect(validator.validate(component, frame.data).errors, frame.data.type).toEqual([]);
    }
    const sequence = frames.map((frame) => frame.data.sequence_number as number);
    for (let index = 1; index < sequence.length; index += 1) expect(sequence[index]).toBeGreaterThan(sequence[index - 1] as number);
    expect(frames.slice(0, 2).map((frame) => frame.data.type)).toEqual(['response.created', 'response.in_progress']);
    expect(frames.filter((frame) => TERMINAL.includes(frame.data.type))).toHaveLength(1);
    expect(frames.at(-1)?.data.type).toBe('response.completed');

    const created = frames[0]?.data.response;
    const completed = frames.at(-1)?.data.response;
    expect(created.id).toMatch(/^resp_/);
    expect(completed.id).toBe(created.id);
    expect(completed.momonga).toEqual({ model: 'scripted/scripted-primary', target: 'scripted/scripted-primary', counter: counterForTest('scripted/scripted-primary'), attempts: 1, usageSource: 'reported', unpriced: { code: 'no_price_entry', reason: 'no price table' } });
    const deltas = frames.filter((frame) => frame.data.type === 'response.output_text.delta').map((frame) => frame.data.delta);
    expect(deltas.join('')).toBe('Hello, world');
  });

  it('assembles the non-stream body from the same event stream as the streamed response', async () => {
    const primary = scriptedTwice();
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary } });
    const frames = await readSse(await postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: userInput('hi'), stream: true }));
    const nonStream = await readJson(await postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: userInput('hi') }));
    const streamed = frames.at(-1)?.data.response;
    expect(stripIds(nonStream.body.output)).toEqual(stripIds(streamed.output));
    expect(nonStream.body.usage).toEqual(streamed.usage);
    expect(nonStream.body.status).toBe(streamed.status);
  });

  it('accepts a plain string input and passes it to the adapter as one user message', async () => {
    const primary = scriptedTwice();
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary } });
    const response = await readJson(await postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: 'plain text' }));
    expect(response.status).toBe(200);
    expect(primary.calls[0]?.request.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'plain text' }] },
    ]);
  });
});
