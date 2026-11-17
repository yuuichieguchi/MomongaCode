import { TEST_HELPER_SELF } from '../../../tools/test/writer-launch.ts';
import { FIRST_GENERATION, fixedRolePort } from '@momonga/foundation';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { SecretStore } from '@momonga/foundation';
import type { McpAuthorizingPool, McpPoolOptions } from '@momonga/mcp';
import * as runtime from '@momonga/runtime';
import { FAKE_LEASE, unconfiguredDerivedNetworkOf, testLocks, testKernelLock, waitFor, TEST_STDIO_LAUNCH, TEST_UNPROTECTED_LAUNCH } from '@momonga/testkit';
import { nodeShellHost } from '@momonga/tools';
import { createSession, inertSandbox, makeRuntimeFixture, writeUserSettings } from './helpers.ts';

const NO_STORE_REASON = 'security (Keychain) is not on PATH';

const fakeKeys = (): SecretStore & { names: string[] } => {
  const items = new Map<string, string>();
  const names: string[] = [];
  return {
    names,
    read: async (name) => {
      const value = items.get(name);
      if (value === undefined) throw new Error(`the fake key store has no item ${name}`);
      return value;
    },
    write: async (name, value) => {
      names.push(name);
      items.set(name, value);
    },
  };
};

const recordFile = (directory: string, key: string): string => path.join(directory, `${createHash('sha256').update(key).digest('hex')}.json`);

const authorizingThroughStore = async (secretStore: { kind: 'available'; store: SecretStore } | { kind: 'none'; reason: string }) => {
  const f = await makeRuntimeFixture();
  const written: string[] = [];
  let tokens = 'tokens-1';
  const createAdminPool = (options: McpPoolOptions): McpAuthorizingPool =>
    ({
      authorize: async (_server: string, signal: AbortSignal) => {
        const key = `mcp/${written.length}`;
        await options.remote?.credentials.write(key, tokens, signal);
        written.push(key);
      },
      authState: async () => ({ state: 'required' }),
      close: async () => undefined,
    }) as unknown as McpAuthorizingPool;
  const toolRuntime = runtime.createToolRuntime({ helperSelf: TEST_HELPER_SELF, mcpLaunch: TEST_STDIO_LAUNCH, childLaunch: TEST_UNPROTECTED_LAUNCH, hostParallelism: 8,
    kernelLock: testKernelLock(),
    lockCapability: testLocks().capability,
    version: '0.0.0-test',
    network: unconfiguredDerivedNetworkOf,
    paths: f.temp.paths,
    sharedPaths: f.temp.paths,
    generation: FIRST_GENERATION,
    role: fixedRolePort('serving'),
    home: f.temp.home,
    store: f.store,
    notifier: f.notifier,
    clock: f.clock,
    timers: f.timers,
    logger: f.logger,
    report: f.reporter.report,
    sandboxes: runtime.fixedSandboxBindings(inertSandbox),
    shellHost: nodeShellHost(),
    settings: f.composition,
    reapTiming: f.reapTiming,
    ...FAKE_LEASE,
    createAdminPool,
    credentialSecretStore: secretStore,
  } as Parameters<typeof runtime.createToolRuntime>[0]);
  const session = createSession(f.store, f.temp.project, { mcpServers: { docs: { type: 'http', url: 'https://mcp.example.test/' } } });
  const authorize = async (value: string) => {
    tokens = value;
    await toolRuntime.mcpAdmin.startAuthorization(session.id, 'docs', new AbortController().signal);
    const settledView = () => {
      const view = toolRuntime.mcpAdmin.authorization(session.id, 'docs');
      return view !== undefined && view.status !== 'awaiting_user' ? view : undefined;
    };
    const settled: NonNullable<ReturnType<typeof settledView>>[] = [];
    await waitFor(() => {
      const view = settledView();
      if (view !== undefined) settled.push(view);
      return view !== undefined;
    }, { description: 'the authorization to settle' });
    const view = settled[0];
    if (view === undefined) throw new Error('the authorization did not settle');
    return view;
  };
  return { f, written, authorize, directory: path.join(f.temp.paths.state, 'mcp-credentials') };
};

describe('the runtime MCP credential store is the encrypted store (N81)', () => {
  it('writes an MCP record as an envelope whose key field is the store key', async () => {
    const keys = fakeKeys();
    const { f, written, authorize } = await authorizingThroughStore({ kind: 'available', store: keys });
    const view = await authorize('tokens-1');
    expect(view.status).toBe('completed');
    const files = fs.readdirSync(path.join(f.temp.paths.state, 'mcp-credentials'));
    expect(files).toHaveLength(1);
    const envelope = JSON.parse(fs.readFileSync(path.join(f.temp.paths.state, 'mcp-credentials', files[0] as string), 'utf8')) as Record<string, string>;
    expect(envelope['format']).toBe('momonga-credential/1');
    expect(envelope['key']).toBe(written[0]);
    expect(keys.names.filter((name) => name.startsWith('credential-key-'))).toHaveLength(1);
  });

  it('reads credentials.plaintextTokenFiles at each write: a change between two authorizations changes the second, with no restart', async () => {
    const keys = fakeKeys();
    const { f, written, authorize } = await authorizingThroughStore({ kind: 'available', store: keys });
    const directory = path.join(f.temp.paths.state, 'mcp-credentials');
    await authorize('sealed');
    writeUserSettings(f.temp.home, { credentials: { plaintextTokenFiles: true } });
    await authorize('plain');
    const first = recordFile(directory, written[0] as string);
    const second = recordFile(directory, written[1] as string);
    expect(JSON.parse(fs.readFileSync(first, 'utf8')).format).toBe('momonga-credential/1');
    expect(fs.readFileSync(second, 'utf8')).toBe('plain');
    expect(fs.statSync(second).mode & 0o777).toBe(0o600);
  });

  it('with no OS store and the setting false, the authorization fails with the exact refusal and writes nothing', async () => {
    const { f, authorize } = await authorizingThroughStore({ kind: 'none', reason: NO_STORE_REASON });
    const view = await authorize('tokens');
    expect(view.status).toBe('failed');
    expect(view.failure?.code).toBe('store_unwritable');
    expect(view.failure?.message).toBe(
      `No secret store was found on this host (${NO_STORE_REASON}). MomongaCode does not keep sign-in tokens in a plain file unless you ask: set credentials.plaintextTokenFiles to true in your user settings to keep them in a file only you can read.`,
    );
    const directory = path.join(f.temp.paths.state, 'mcp-credentials');
    expect(fs.existsSync(directory) ? fs.readdirSync(directory) : []).toEqual([]);
  });
});
