import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { bashTool } from '../src/builtins/bash.ts';
import { approvalOf, makeBuiltins, resultOf } from './builtins/fixtures.ts';
import type { Builtins } from './builtins/fixtures.ts';
import { makeLayout } from './helpers.ts';
import { realSandbox, recordingSandbox, scratchRootOf } from './read-only-support.ts';
import type { RecordedSpawn } from './read-only-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

const listener = async (): Promise<{ port: number; hits: () => number }> => {
  let hits = 0;
  const server = net.createServer((socket) => {
    hits += 1;
    socket.on('error', () => undefined);
    socket.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as net.AddressInfo).port, hits: () => hits };
};

type Stage = Builtins & { spawns: RecordedSpawn[] };

const stage = async (): Promise<Stage> => {
  const recorded = recordingSandbox(realSandbox(scratchRootOf(makeLayout().root)));
  return { ...(await makeBuiltins({ sandbox: recorded.sandbox })), spawns: recorded.spawns };
};

const reach = (port: number): string => `/usr/bin/nc -z -w 2 127.0.0.1 ${port}`;

describe('the Bash tool tells the model how to ask for the network', () => {
  it('says the sandbox has no network and names the field, in both descriptions', () => {
    for (const text of [bashTool.description, bashTool.conciseDescription]) {
      expect(text).toContain('no network');
      expect(text).toContain('network');
      expect(text).toContain('"open"');
    }
  });
});

describe.runIf(process.platform === 'darwin')('the network scope of a Bash call', () => {
  it('asks for a call that sets network to open, naming the scope, and suggests no rule', async () => {
    const tools = await stage();
    const asked = approvalOf(await tools.run('Bash', { command: 'npm install', network: 'open' }, { mode: 'manual' }));
    expect(asked.decision.reason).toContain('the command requests unrestricted network access');
    expect(asked.suggestedRule).toBeUndefined();
    expect(tools.spawns).toEqual([]);
  });

  it('binds the approval to the scope: the digest of the call with the network differs from the digest without it (I4.3)', async () => {
    const tools = await stage();
    const plain = approvalOf(await tools.run('Bash', { command: 'make' }, { mode: 'manual' }));
    const open = approvalOf(await tools.run('Bash', { command: 'make', network: 'open' }, { mode: 'manual' }));
    expect(open.subjectDigest).not.toBe(plain.subjectDigest);
    const again = await tools.run('Bash', { command: 'make', network: 'open' }, { mode: 'manual' }, { kind: 'allow_once', subjectDigest: plain.subjectDigest });
    expect(approvalOf(again).subjectDigest).toBe(open.subjectDigest);
    expect(tools.spawns).toEqual([]);
  });

  it('reaches a loopback listener once the person approves the open call', async () => {
    const tools = await stage();
    const { port, hits } = await listener();
    const result = resultOf(await tools.run('Bash', { command: reach(port), network: 'open' }, { mode: 'manual' }, 'allow_once'));
    expect(result.status).toBe('completed');
    expect(hits()).toBe(1);
    expect(tools.spawns.map((spawn) => spawn.policy.network)).toEqual(['allow']);
  });

  it('cannot reach the listener when the call does not ask for the network', async () => {
    const tools = await stage();
    const { port, hits } = await listener();
    const result = resultOf(await tools.run('Bash', { command: reach(port) }, { mode: 'manual' }, 'allow_once'));
    expect(result.status).toBe('failed');
    expect(hits()).toBe(0);
    expect(tools.spawns.map((spawn) => spawn.policy.network)).toEqual(['deny']);
  });

  it('runs a read-only command without the network whatever was requested and granted (I4.2)', async () => {
    const tools = await stage();
    const result = resultOf(await tools.run('Bash', { command: 'ls', network: 'open' }, { mode: 'manual', sandboxNetwork: 'allow' }));
    expect(result.status).toBe('completed');
    expect(tools.spawns.map((spawn) => [spawn.policy.network, spawn.policy.writableRoots])).toEqual([['deny', []]]);
  });

  it('grants the open call without asking in bypassPermissions mode', async () => {
    const tools = await stage();
    const { port, hits } = await listener();
    const result = resultOf(await tools.run('Bash', { command: reach(port), network: 'open' }, { mode: 'bypassPermissions' }));
    expect(result.status).toBe('completed');
    expect(hits()).toBe(1);
  });

  it('refuses the call when the setting is deny, as a denial of the setting', async () => {
    const tools = await stage();
    const result = resultOf(await tools.run('Bash', { command: 'npm install', network: 'open' }, { mode: 'bypassPermissions', sandboxNetwork: 'deny' }));
    expect(result.status).toBe('failed');
    expect(result.denial).toEqual({ source: 'setting', reason: 'the command requests unrestricted network access, and the setting sandboxNetwork is deny' });
    expect(tools.spawns).toEqual([]);
  });

  it('refuses a network value the schema does not have', async () => {
    const tools = await stage();
    const result = resultOf(await tools.run('Bash', { command: 'ls', network: 'everything' }, { mode: 'manual' }));
    expect(result.status).toBe('failed');
    expect(tools.spawns).toEqual([]);
  });
});
