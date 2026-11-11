import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, textResponseEvents } from '@momonga/testkit';
import { PRIMARY, postJson, readJson, startGateway, userInput } from '../gateway-helpers.ts';

const textCall = (text: string) => ({ events: textResponseEvents({ model: 'scripted-primary', chunks: [text] }) });

const refusedAt = async (route: string, extra: Record<string, unknown>, field: string): Promise<void> => {
  const primary = createScriptedAdapter({ calls: [textCall('never sent')], compactSummary: 'never sent' });
  const { client } = await startGateway({ adapters: { [PRIMARY]: primary } });
  const answer = await readJson(await postJson(client, route, { model: PRIMARY, input: userInput('hi'), ...extra }));
  expect(answer.status).toBe(400);
  expect(answer.body.error).toMatchObject({ type: 'invalid_request', code: 'stored_responses_unsupported', param: field });
  expect(primary.calls).toEqual([]);
  expect(primary.compactCalls).toEqual([]);
};

describe('the gateway keeps no response for a later call to continue', () => {
  it.each([false, true])('refuses store: true on a call with stream %s, naming the field', async (stream) => {
    await refusedAt('/v1/responses', { store: true, stream }, 'store');
  });

  it.each([false, true])('refuses previous_response_id on a call with stream %s, naming the field', async (stream) => {
    await refusedAt('/v1/responses', { previous_response_id: 'resp_earlier', stream }, 'previous_response_id');
  });

  it('refuses previous_response_id on a compaction, naming the field', async () => {
    await refusedAt('/v1/responses/compact', { previous_response_id: 'resp_earlier' }, 'previous_response_id');
  });

  it('answers a call that sends store: false and previous_response_id: null', async () => {
    const primary = createScriptedAdapter({ calls: [textCall('answered')] });
    const { client } = await startGateway({ adapters: { [PRIMARY]: primary } });
    const answer = await readJson(await postJson(client, '/v1/responses', { model: PRIMARY, input: userInput('hi'), store: false, previous_response_id: null }));
    expect(answer.status).toBe(200);
    expect(answer.body.store).toBe(false);
    expect(answer.body.previous_response_id).toBeNull();
  });
});
