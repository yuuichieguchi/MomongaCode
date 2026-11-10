import { SECURITY_BINARY, SecretStoreAbsentError, momongaLayout } from '@momonga/foundation';
import { describe, expect, it } from 'vitest';
import { secretSet } from '../src/commands/secret.ts';
import { describeFailure } from '../src/failure.ts';
import { NO_DEFAULT_KEYCHAIN_REASON, keychainFixture, secretSetPorts } from './keychain-fixture.ts';

describe('momonga secret set on a host whose secret store is absent', () => {
  it('secret set reports an absent store', async () => {
    const keychain = keychainFixture({ control: { readiness: 'none' } });
    const { ports, stdout } = secretSetPorts(keychain.store, 'v\rv\r');

    const failure: unknown = await secretSet(ports, momongaLayout('/home/u'), 'k', new AbortController().signal).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(SecretStoreAbsentError);
    expect(`momonga: ${describeFailure(failure)}\n`).toBe(
      `momonga: the secret "k" could not be written: no secret store was found on this host (${NO_DEFAULT_KEYCHAIN_REASON}); make a default keychain available\n`,
    );
    expect(stdout).toEqual([]);
    expect(keychain.port.calls).toEqual([{ file: SECURITY_BINARY, args: ['default-keychain'], stdin: '' }]);
    expect(keychain.items).toEqual({});
  });
});
