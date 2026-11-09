import { describe, expect, it } from 'vitest';
import type { CapabilityOverride } from '@momonga/protocol';
import { createScriptedAdapter, textResponseEvents, usageOf } from '@momonga/testkit';
import type { ScriptedAdapter } from '@momonga/testkit';
import { postJson, readJson, startGateway } from './gateway-helpers.ts';

const TEXT_AND_IMAGE: CapabilityOverride = { inputKinds: { content: ['text', 'image'], tools: ['function', 'custom'] } };

const answering = (model: string, capabilities: CapabilityOverride): ScriptedAdapter =>
  createScriptedAdapter({ capabilities, calls: [{ events: textResponseEvents({ model, chunks: ['answer'], usage: usageOf(5, 1) }) }] });

const fileInput = [
  {
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: 'summarise the attachment' },
      { type: 'input_file', filename: 'notes.txt', file_data: 'data:text/plain;base64,aGVsbG8=' },
    ],
  },
];

const startAlias = async (members: Record<string, CapabilityOverride>) => {
  const adapters = Object.fromEntries(Object.entries(members).map(([name, capabilities]) => [name, answering(`model-${name}`, capabilities)]));
  const harness = await startGateway({
    adapters,
    config: { aliases: { fast: Object.keys(members) }, targets: Object.fromEntries(Object.keys(members).map((name) => [name, { model: `model-${name}` }])) },
  });
  return { adapters: adapters as Record<string, ScriptedAdapter>, post: async () => readJson(await postJson(harness.client, '/v1/responses', { model: 'fast', input: fileInput })) };
};

describe('narrowing refuses a target whose inputKinds lack a content kind the request carries (P2 item 9, M3)', () => {
  it('answers capability_unsupported on param input before any adapter call when the only member accepts text and images only', async () => {
    const alias = await startAlias({ plan: TEXT_AND_IMAGE });
    const response = await alias.post();
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('capability_unsupported');
    expect(response.body.error.param).toBe('input');
    expect(alias.adapters['plan']?.calls).toHaveLength(0);
  });

  it('passes over the restricted member and serves the file from a member that declares no inputKinds', async () => {
    const alias = await startAlias({ plan: TEXT_AND_IMAGE, open: {} });
    const response = await alias.post();
    expect(response.status).toBe(200);
    expect(alias.adapters['plan']?.calls).toHaveLength(0);
    expect(alias.adapters['open']?.calls).toHaveLength(1);
  });
});
