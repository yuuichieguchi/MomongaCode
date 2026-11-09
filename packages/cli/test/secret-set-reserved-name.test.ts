import { describe, expect, it } from 'vitest';
import { momongaLayout } from '@momonga/foundation';
import { createFakeSecretStore } from '@momonga/testkit';
import { SecretInputError, secretSet } from '../src/commands/secret.ts';
import type { CliPorts } from '../src/ports.ts';

describe('momonga secret set and the credential store key (N81)', () => {
  it('refuses a name starting with credential-key- before asking for a value, and writes nothing', async () => {
    const secrets = createFakeSecretStore({});
    const ports = { terminal: undefined, secretStore: () => secrets, stdout: { write: () => true } } as unknown as CliPorts;
    const attempt = secretSet(ports, momongaLayout('/home/u'), 'credential-key-0123456789abcdef', new AbortController().signal);
    await expect(attempt).rejects.toBeInstanceOf(SecretInputError);
    await expect(attempt).rejects.toThrow(/credential-key-/);
    expect(secrets.writes).toEqual([]);
  });
});
