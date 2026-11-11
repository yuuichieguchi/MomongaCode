import { describe } from 'vitest';
import { SECURITY_BINARY, createKeychainSecretStore } from '@momonga/foundation';
import { FAKE_KEYCHAIN_PATH, createFakeSecretFiles, createFakeSecretStore, createFakeSecurityPort } from '../../src/index.ts';
import { secretStoreContract } from './secret-store.contract.ts';

describe('the contract of the secret store: the keychain store of the product over the fake security program', () =>
  secretStoreContract((secrets) => {
    const held: Record<string, string> = { ...secrets };
    const port = createFakeSecurityPort(
      () => held,
      (name, value) => {
        held[name] = value;
      },
    );
    return createKeychainSecretStore(port, SECURITY_BINARY, createFakeSecretFiles(() => new Set([FAKE_KEYCHAIN_PATH])));
  }));

describe('the contract of the secret store: the fake store', () => secretStoreContract((secrets) => createFakeSecretStore(secrets)));
