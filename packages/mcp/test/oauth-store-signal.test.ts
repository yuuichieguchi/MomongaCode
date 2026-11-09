import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCK_TIMEOUT_MS, createFileCredentialStore } from '@momonga/foundation';
import type { FileLockPorts } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, startLockHolder } from '@momonga/testkit';
import { createMcpOAuthProvider, credentialKey } from '../src/mcp-oauth.ts';

const steppedPorts = (): FileLockPorts & { waitedMs(): number } => {
  const start = 1_000_000;
  let now = start;
  return {
    clock: { now: () => now },
    sleep: (ms) => {
      now += ms;
      return new Promise((resolve) => setImmediate(resolve));
    },
    randomHex: () => 'cafe0001',
    waitedMs: () => now - start,
  };
};

describe('MCP OAuth provider store waits (N81)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('a record lock wait outlasts the default lock timeout and ends only on the signal of the operation', async (context) => {
    const directory = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-oauth-'))), 'mcp-credentials');
    const url = 'https://mcp.example.com/mcp';
    const store = createFileCredentialStore(directory, { ports: steppedPorts() });
    await store.write(credentialKey('remote', url), '{"version":1,"issuers":{}}');
    const ports = steppedPorts();
    const waiting = createFileCredentialStore(directory, { ports });
    const lockDirectory = `${directory}.locks`;
    const [lockName] = fs.readdirSync(lockDirectory);
    await startLockHolder(context, path.join(lockDirectory, lockName as string));
    const controller = new AbortController();
    const provider = createMcpOAuthProvider({
      server: 'remote',
      resourceUrl: url,
      scope: 'user',
      store: waiting,
      signal: controller.signal,
      redirectUrl: 'http://127.0.0.1:1/callback',
      randomToken: () => 'state',
      onAuthorizationUrl: () => undefined,
    });
    let settled = false;
    const attempt = Promise.resolve(provider.invalidateCredentials?.('tokens')).finally(() => {
      settled = true;
    });
    attempt.catch(() => undefined);
    for (let turn = 0; turn < 100_000 && ports.waitedMs() <= 3 * DEFAULT_LOCK_TIMEOUT_MS && !settled; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(ports.waitedMs()).toBeGreaterThan(3 * DEFAULT_LOCK_TIMEOUT_MS);
    const reason = new Error('the authorization was cancelled');
    controller.abort(reason);
    await expect(attempt).rejects.toBe(reason);
  });
});
