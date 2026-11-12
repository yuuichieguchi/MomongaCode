import { describe, expect, it } from 'vitest';
import { providerNameOf } from '@momonga/config';
import type { ResolvedModel } from '@momonga/config';
import { SERVER_KINDS } from '@momonga/protocol';
import { keyGroupOf } from '../../src/process.ts';

const BASE_URL = 'https://api.example.com/v1';

const targetOf = (provider: string, providerWritten: boolean): ResolvedModel =>
  ({ adapter: 'chat-completions', baseUrl: BASE_URL, apiKeyEnv: 'EXAMPLE_KEY', model: 'm', provider, providerWritten, canon: `${provider}/m`, ownName: 'm' }) as unknown as ResolvedModel;

describe('the key group reads the provider the loader resolved once', () => {
  it('a written provider names the key group, even when it equals the default name', () => {
    const derived = providerNameOf({ adapter: 'chat-completions', baseUrl: BASE_URL }, SERVER_KINDS);
    expect(keyGroupOf(targetOf(derived, true))).toEqual({ keyGroup: derived });
    expect(keyGroupOf(targetOf('mine', true))).toEqual({ keyGroup: 'mine' });
  });

  it('a default provider groups keys by the origin of the address', () => {
    expect(keyGroupOf(targetOf('anything', false))).toEqual({ keyGroup: 'https://api.example.com' });
  });
});
