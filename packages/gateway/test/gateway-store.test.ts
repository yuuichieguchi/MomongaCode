import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, textResponseEvents } from '@momonga/testkit';
import { expectErrorBody, postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';

const events = (text: string, itemId: string) => textResponseEvents({ model: 'scripted-primary', chunks: [text], itemId });

describe('store and previous_response_id', () => {
  it('sends the adapter prev.input, prev.output, then the new input in order', async () => {
    const primary = createScriptedAdapter({ calls: [{ events: events('first answer', 'msg_a') }, { events: events('second answer', 'msg_b') }] });
    const { client } = await startGateway({ adapters: { primary } });
    const firstInput = userInput('first question');
    const first = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: firstInput, store: true }));
    expect(first.status).toBe(200);
    expect(first.body.store).toBe(true);

    const secondInput = userInput('second question');
    const second = await readJson(
      await postJson(client, '/v1/responses', { model: 'fast', input: secondInput, previous_response_id: first.body.id }),
    );
    expect(second.status).toBe(200);
    expect(second.body.previous_response_id).toBe(first.body.id);
    expect(primary.calls[1]?.request.input).toEqual([...firstInput, ...first.body.output, ...secondInput]);
    expect(primary.calls[1]?.request).not.toHaveProperty('previous_response_id');
  });

  it('chains through two stored responses', async () => {
    const primary = createScriptedAdapter({
      calls: [{ events: events('a1', 'msg_1') }, { events: events('a2', 'msg_2') }, { events: events('a3', 'msg_3') }],
    });
    const { client } = await startGateway({ adapters: { primary } });
    const q1 = userInput('q1');
    const q2 = userInput('q2');
    const q3 = userInput('q3');
    const r1 = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: q1, store: true }));
    const r2 = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: q2, store: true, previous_response_id: r1.body.id }));
    await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: q3, previous_response_id: r2.body.id }));
    expect(primary.calls[2]?.request.input).toEqual([...q1, ...r1.body.output, ...q2, ...r2.body.output, ...q3]);
  });

  it('returns 404 previous_response_not_found for an unknown id without calling the adapter', async () => {
    const primary = createScriptedAdapter({ calls: [] });
    const { client } = await startGateway({ adapters: { primary } });
    const response = await readJson(
      await postJson(client, '/v1/responses', { model: 'fast', input: userInput('q'), previous_response_id: 'resp_missing' }),
    );
    expect(response.status).toBe(404);
    expectErrorBody(response.body, { type: 'not_found', code: 'previous_response_not_found', param: 'previous_response_id' });
    expect(primary.calls).toHaveLength(0);
  });

  it('does not make store:false responses retrievable', async () => {
    const primary = createScriptedAdapter({ calls: [{ events: events('ephemeral', 'msg_e') }] });
    const { client } = await startGateway({ adapters: { primary } });
    const first = await readJson(await postJson(client, '/v1/responses', { model: 'fast', input: userInput('q'), store: false }));
    expect(first.body.store).toBe(false);
    const followUp = await readJson(
      await postJson(client, '/v1/responses', { model: 'fast', input: userInput('q2'), previous_response_id: first.body.id }),
    );
    expect(followUp.status).toBe(404);
    expectErrorBody(followUp.body, { type: 'not_found', code: 'previous_response_not_found', param: 'previous_response_id' });
    expect(primary.calls).toHaveLength(1);
  });
});
