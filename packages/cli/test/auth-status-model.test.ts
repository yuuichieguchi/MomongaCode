import { messageOf } from '@momonga/protocol';
import { describe, expect, it } from 'vitest';
import type { MomongaModelList } from '@momonga/protocol';
import type { PlanGatewayClient } from '../src/client/gateway-client.ts';
import { authStatus } from '../src/commands/auth.ts';
import { S3, homeWith, listingOf } from './models-shell-harness.ts';

const plan = { accounts: async () => ({ profiles: [], accounts: [] }) } as unknown as PlanGatewayClient;

const statusOf = async (listing: MomongaModelList, options: { json: boolean; model?: string }): Promise<{ code: number; text: string }> => {
  const written: string[] = [];
  const code = await authStatus({ stdout: { write: (text) => void written.push(text) }, plan, listing: async () => listing }, options);
  return { code, text: written.join('') };
};

describe('momonga auth status names the model new sessions start with', () => {
  it('prints the display name of the start model with its billing', async (context) => {
    const status = await statusOf(listingOf(homeWith(context, S3).home), { json: false });

    expect(status.code).toBe(0);
    expect(status.text.trimEnd().split('\n').at(-1)).toBe('model: chatgpt/gpt-5.5 (plan)');
  });

  it('prints the named model when one is given, and the name, the full reference and the billing with --json', async (context) => {
    const listing = listingOf(homeWith(context, S3).home);

    const named = await statusOf(listing, { json: false, model: 'openai/gpt-5.5' });
    const json = await statusOf(listing, { json: true });

    expect(named.text.trimEnd().split('\n').at(-1)).toBe('model: openai/gpt-5.5 (metered)');
    expect((JSON.parse(json.text) as { model: unknown }).model).toEqual({ name: 'chatgpt/gpt-5.5', canon: 'chatgpt/gpt-5.5', billing: 'plan' });
  });

  it('says that no model is connected when the gateway lists none', async () => {
    const status = await statusOf({ object: 'list', data: [], start: null, roles: {} }, { json: false });

    expect(status.text.trimEnd().split('\n').at(-1)).toBe(`model: none (${messageOf('noModelConnected', 'cli')})`);
  });
});
