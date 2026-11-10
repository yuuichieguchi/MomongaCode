import { describe, expect, it } from 'vitest';
import { postJson, readJson } from './gateway-helpers.ts';
import type { Harness } from './gateway-helpers.ts';
import { CC_CAPABILITIES, completionBodies, makeAdapter, startFake, userText } from './cc-support.ts';
import { ccAdapterFor, startCcGateway, summaryOfResource, textReply } from './cc-compact-support.ts';

const CAP = 200;
const TOO_SMALL_OUTPUT = CAP - 1;

const compact = async (harness: Harness) =>
  readJson(await postJson(harness.client, '/v1/responses/compact', { model: harness.model, input: [userText('summarise this')], momonga: { max_summary_tokens: CAP } }));

const limitedAdapter = async () => {
  const fake = await startFake({ scenario: 'tools-ok', script: [textReply('never')] });
  const adapter = makeAdapter(fake, { capabilities: async () => ({ ...CC_CAPABILITIES, maxOutputTokens: TOO_SMALL_OUTPUT }) });
  return { fake, adapter };
};

describe('a summary cap above the maxOutputTokens of a target', () => {
  it('skips that target and lets the next target of the alias answer', async () => {
    const limited = await limitedAdapter();
    const healthy = await startFake({ scenario: 'tools-ok', script: [textReply('from second')] });
    const harness = await startCcGateway({ first: limited.adapter, second: ccAdapterFor(healthy) });
    const response = await compact(harness);
    expect(response.status).toBe(200);
    expect(summaryOfResource(response.body)).toBe('from second');
    expect(completionBodies(limited.fake)).toHaveLength(0);
  });

  it('answers invalid_summary_cap when no target of the alias can hold the cap', async () => {
    const limited = await limitedAdapter();
    const harness = await startCcGateway({ first: limited.adapter });
    const response = await compact(harness);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_summary_cap');
    expect(completionBodies(limited.fake)).toHaveLength(0);
  });

  it('keeps a target whose maxOutputTokens equals the cap', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [textReply('exact')] });
    const adapter = makeAdapter(fake, { capabilities: async () => ({ ...CC_CAPABILITIES, maxOutputTokens: CAP }) });
    const harness = await startCcGateway({ only: adapter });
    const response = await compact(harness);
    expect(response.status).toBe(200);
    expect(summaryOfResource(response.body)).toBe('exact');
  });
});
