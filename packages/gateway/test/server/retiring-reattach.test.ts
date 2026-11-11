import { describe, expect, it } from 'vitest';
import { GENERATION_RETIRED_CODE } from '@momonga/foundation';
import { createScriptedAdapter, textResponseEvents, waitFor } from '@momonga/testkit';
import { PRIMARY, outputText, postJson, readJson, registerCleanup, startGateway, switchableRole, userInput } from '../gateway-helpers.ts';

const ASK = { model: PRIMARY, input: userInput('hi') };
const COMPACT = { model: PRIMARY, input: userInput('summarise this conversation') };
const keyed = (key: string) => ({ 'idempotency-key': key });

const servingGateway = async () => {
  const role = switchableRole('serving');
  const primary = createScriptedAdapter({
    calls: [{ events: textResponseEvents({ model: 'scripted-primary', chunks: ['accepted before retirement'] }), gate: { name: 'answer', afterEvents: 1 } }],
    compactSummary: 'the summary',
    compactGate: 'summary',
  });
  const harness = await startGateway({ adapters: { [PRIMARY]: primary }, role });
  registerCleanup(() => primary.release('answer'));
  registerCleanup(() => primary.release('summary'));
  return { ...harness, primary, role };
};

describe('a keyed request for a call accepted before retirement is served by the retiring generation (gateway-core-C27)', () => {
  it('attaches a keyed request to the response in flight and calls the upstream once', async () => {
    const { gateway, client, primary, role } = await servingGateway();
    const first = postJson(client, '/v1/responses', ASK, keyed('accepted-1'));
    await waitFor(() => primary.calls[0]?.emitted === 1, { description: 'the accepted call to reach its upstream' });
    role.become('retiring');

    const second = postJson(client, '/v1/responses', ASK, keyed('accepted-1'));
    await waitFor(() => gateway.activeRequests() === 2, { description: 'the second request to attach to the call in flight' });
    primary.release('answer');
    const answers = await Promise.all([first.then(readJson), second.then(readJson)]);

    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    expect(answers.map((answer) => outputText(answer.body))).toEqual(['accepted before retirement', 'accepted before retirement']);
    expect(primary.calls).toHaveLength(1);
  });

  it('replays the stored answer of a keyed call that ended before the same key is asked again', async () => {
    const { client, primary, role } = await servingGateway();
    primary.release('answer');
    const first = await readJson(await postJson(client, '/v1/responses', ASK, keyed('stored-1')));
    role.become('retiring');

    const again = await readJson(await postJson(client, '/v1/responses', ASK, keyed('stored-1')));

    expect([first.status, again.status]).toEqual([200, 200]);
    expect(outputText(again.body)).toBe('accepted before retirement');
    expect(primary.calls).toHaveLength(1);
  });

  it('attaches a keyed request to the compaction in flight and calls the upstream once', async () => {
    const { gateway, client, primary, role } = await servingGateway();
    const first = postJson(client, '/v1/responses/compact', COMPACT, keyed('compact-1'));
    await waitFor(() => primary.compactCalls.length === 1, { description: 'the accepted compaction to reach its upstream' });
    role.become('retiring');

    const second = postJson(client, '/v1/responses/compact', COMPACT, keyed('compact-1'));
    await waitFor(() => gateway.activeRequests() === 2, { description: 'the second request to attach to the compaction in flight' });
    primary.release('summary');
    const answers = await Promise.all([first.then(readJson), second.then(readJson)]);

    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    expect(primary.compactCalls).toHaveLength(1);
  });

  it.each([
    ['/v1/responses', ASK],
    ['/v1/responses/compact', COMPACT],
  ])('refuses a new keyed request on POST %s with generation_retired and sends nothing upstream', async (route, body) => {
    const { client, primary, role } = await servingGateway();
    role.become('retiring');

    const refused = await readJson(await postJson(client, route, body, keyed('new-after-retirement')));

    expect([refused.status, refused.body.error.code]).toEqual([503, GENERATION_RETIRED_CODE]);
    expect(refused.headers['connection']).toBe('close');
    expect(primary.calls).toEqual([]);
    expect(primary.compactCalls).toEqual([]);
  });
});
