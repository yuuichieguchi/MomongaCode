import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import type { Sandbox } from '@momonga/sandbox';
import type { BackgroundJobStart, BackgroundJobs, ExecutionBatchInput } from '@momonga/tools';
import { bashTool } from '../src/builtins/bash.ts';
import { approvalOf, makeBuiltins, resultOf } from './builtins/fixtures.ts';
import type { Builtins } from './builtins/fixtures.ts';
import { makeLayout } from './helpers.ts';
import { realSandbox, recordingSandbox, scratchRootOf } from './read-only-support.ts';
import type { RecordedSpawn } from './read-only-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const closers: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

const origin = async (): Promise<{ port: number; seen: string[] }> => {
  const seen: string[] = [];
  const server = http.createServer((request, response) => {
    seen.push(request.url ?? '');
    response.writeHead(200, { 'content-type': 'text/plain' }).end('origin says hi');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return { port: (server.address() as net.AddressInfo).port, seen };
};

const refusesConnections = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });

type Stage = Builtins & { spawns: RecordedSpawn[] };

const stage = async (): Promise<Stage> => {
  const recorded = recordingSandbox(realSandbox(scratchRootOf(makeLayout().root)));
  return { ...(await makeBuiltins({ sandbox: recorded.sandbox })), spawns: recorded.spawns };
};

const neverSpawning = (kind: Sandbox['kind']): Sandbox => ({
  kind,
  spawn: () => {
    throw new Error('this sandbox must not be asked to spawn');
  },
});

const PROXY_NOTE = 'through the sandbox proxy, which carries HTTP and HTTPS; a program that does not use the proxy variables stays without network';

const authorizationOf = (proxyUrl: string): string => {
  const url = new URL(proxyUrl);
  return `Basic ${Buffer.from(`${url.username}:${url.password}`).toString('base64')}`;
};

describe('the Bash tool tells the model how to ask for named hosts', () => {
  it('names the hosts form in both descriptions', () => {
    for (const text of [bashTool.description, bashTool.conciseDescription]) expect(text).toContain('{"hosts": [');
  });
});

describe('a Bash call that asks for named hosts, before it runs', () => {
  it('asks naming the hosts and the proxy, suggests no rule, and binds the approval to the set of hosts', async () => {
    const tools = await makeBuiltins({ sandbox: neverSpawning('seatbelt') });
    const first = approvalOf(await tools.run('Bash', { command: 'npm install', network: { hosts: ['registry.example.org', 'Github.example.com:443'] } }, { mode: 'manual' }));
    expect(first.decision.reason).toBe(`shell commands require approval; the command requests network access to github.example.com:443, registry.example.org only (${PROXY_NOTE})`);
    expect(first.suggestedRule).toBeUndefined();
    const reordered = approvalOf(await tools.run('Bash', { command: 'npm install', network: { hosts: ['github.example.com:443', 'registry.example.org'] } }, { mode: 'manual' }));
    expect(reordered.decision).toEqual(first.decision);
    expect(reordered.subjectDigest).not.toBe(first.subjectDigest);
    const wider = approvalOf(await tools.run('Bash', { command: 'npm install', network: { hosts: ['registry.example.org', 'github.example.com:443', 'evil.example.net'] } }, { mode: 'manual' }));
    expect(wider.subjectDigest).not.toBe(first.subjectDigest);
    const open = approvalOf(await tools.run('Bash', { command: 'npm install', network: 'open' }, { mode: 'manual' }));
    expect(open.subjectDigest).not.toBe(first.subjectDigest);
    const again = await tools.run('Bash', { command: 'npm install', network: 'open' }, { mode: 'manual' }, { kind: 'allow_once', subjectDigest: first.subjectDigest });
    expect(approvalOf(again).subjectDigest).toBe(open.subjectDigest);
  });

  it.each(['*.example.org', 'https://example.org', 'example.org/path'])('fails the call for the host entry %j, saying what an entry is', async (entry) => {
    const tools = await makeBuiltins({ sandbox: neverSpawning('seatbelt') });
    const result = resultOf(await tools.run('Bash', { command: 'npm install', network: { hosts: [entry] } }, { mode: 'manual' }));
    expect(result.status).toBe('failed');
    expect(result.output).toBe(`network.hosts: ${JSON.stringify(entry)} is not a host name or an IP address, optionally followed by :port`);
  });

  it('fails the call for an empty list of hosts', async () => {
    const tools = await makeBuiltins({ sandbox: neverSpawning('seatbelt') });
    expect(resultOf(await tools.run('Bash', { command: 'npm install', network: { hosts: [] } }, { mode: 'manual' })).status).toBe('failed');
  });

  it('refuses the call under a sandbox that cannot limit a command to hosts, and grants nothing wider in its place', async () => {
    const tools = await makeBuiltins({ sandbox: neverSpawning('none') });
    const result = resultOf(await tools.run('Bash', { command: 'npm install', network: { hosts: ['registry.example.org'] } }, { mode: 'bypassPermissions' }));
    expect(result.status).toBe('failed');
    expect(result.denial).toEqual({
      source: 'sandbox',
      reason: 'the command requests network access to registry.example.org only, and the sandbox in use (none) cannot limit a command to that; nothing wider is granted in its place',
    });
  });
});

describe('a network request is an ask of the mode, which a hook or the classifier may answer', () => {
  const allowingHooks = { matchesPreToolUse: () => true, matchesPostToolUse: () => false, preToolUse: async () => ({ decision: 'allow' as const }) } as unknown as NonNullable<ExecutionBatchInput['hooks']>;
  const NETWORKS = [['open', 'open' as const], ['named hosts', { hosts: ['registry.example.org'] }]] as const;

  const stoppingAtSpawn = (): { sandbox: Sandbox; spawns: () => number } => {
    let spawns = 0;
    return {
      sandbox: {
        kind: 'seatbelt',
        spawn: () => {
          spawns += 1;
          throw new Error('stopped at the spawn');
        },
      },
      spawns: () => spawns,
    };
  };

  it.each(NETWORKS)('asks for %s in manual mode with an ask that is not for a person only', async (_name, network) => {
    const tools = await makeBuiltins({ sandbox: neverSpawning('seatbelt') });
    const asked = approvalOf(await tools.run('Bash', { command: 'npm install', network }, { mode: 'manual' }));
    expect(asked.decision.humanOnly).toBeUndefined();
    expect(asked.decision.reason).toContain('the command requests');
  });

  it.each(NETWORKS)('a hook that allows answers the request for %s: the call goes to the sandbox and the person is not asked', async (_name, network) => {
    const stopped = stoppingAtSpawn();
    const tools = await makeBuiltins({ sandbox: stopped.sandbox });
    const outcome = await tools.run('Bash', { command: 'npm install', network }, { mode: 'manual', hooks: allowingHooks });
    expect(outcome?.kind).toBe('result');
    expect(stopped.spawns()).toBe(1);
  });

  it.each(NETWORKS)('in auto mode the classifier is asked about %s and told the scope; when it does not allow, the person is asked', async (_name, network) => {
    const tools = await makeBuiltins({ sandbox: neverSpawning('seatbelt') });
    const reasons: string[] = [];
    const classifier = { classify: async (request: { reason: string }) => (reasons.push(request.reason), 'ask' as const) };
    const asked = approvalOf(await tools.run('Bash', { command: 'npm install', network }, { mode: 'auto', classifier }));
    expect(asked.decision.reason).toContain('the command requests');
    expect(reasons).toEqual([expect.stringContaining('the command requests')]);
  });

  it.each(NETWORKS)('in auto mode a classifier that allows answers the request for %s', async (_name, network) => {
    const stopped = stoppingAtSpawn();
    const tools = await makeBuiltins({ sandbox: stopped.sandbox });
    const outcome = await tools.run('Bash', { command: 'npm install', network }, { mode: 'auto', classifier: { classify: async () => 'allow' as const } });
    expect(outcome?.kind).toBe('result');
    expect(stopped.spawns()).toBe(1);
  });
});

describe.runIf(process.platform === 'darwin')('a Bash call that was granted named hosts, under the real sandbox', () => {
  const fetch = (port: number, path = '/pkg'): string => `/usr/bin/curl -sS http://127.0.0.1:${port}${path}`;

  it('reaches a granted host through the proxy, and the sandbox allows the command only the port of that proxy', async () => {
    const tools = await stage();
    const target = await origin();
    const result = resultOf(await tools.run('Bash', { command: fetch(target.port), network: { hosts: [`127.0.0.1:${target.port}`] } }, { mode: 'manual' }, 'allow_once'));
    expect(result).toMatchObject({ status: 'completed', output: 'origin says hi' });
    expect(target.seen).toEqual(['/pkg']);
    const [spawn] = tools.spawns;
    const network = spawn?.policy.network as { loopbackPort: number };
    expect(network.loopbackPort).toBeGreaterThan(0);
    const proxy = spawn?.command.env['HTTP_PROXY'] as string;
    expect(proxy).toMatch(new RegExp(`^http://momonga:[0-9a-f]{64}@127\\.0\\.0\\.1:${network.loopbackPort}$`));
    expect(spawn?.command.env).toMatchObject({ HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, all_proxy: proxy, NO_PROXY: '', no_proxy: '' });
    expect(await refusesConnections(network.loopbackPort)).toBe(true);
  });

  it('reports a host that was not granted in the tool result, and the host sees nothing', async () => {
    const tools = await stage();
    const granted = await origin();
    const other = await origin();
    const result = resultOf(await tools.run('Bash', { command: fetch(other.port), network: { hosts: [`127.0.0.1:${granted.port}`] } }, { mode: 'manual' }, 'allow_once'));
    const sentence = `the sandbox proxy refused 127.0.0.1:${other.port}: it is not among the hosts this command was granted (127.0.0.1:${granted.port})`;
    expect(result.output).toBe(`${sentence}\n[network] ${sentence}`);
    expect(other.seen).toEqual([]);
  });

  it('reports each refused host once however often the command tried it', async () => {
    const tools = await stage();
    const granted = await origin();
    const other = await origin();
    const result = resultOf(await tools.run('Bash', { command: `${fetch(other.port)} >/dev/null; ${fetch(other.port)} >/dev/null; ${fetch(granted.port)}`, network: { hosts: [`127.0.0.1:${granted.port}`] } }, { mode: 'manual' }, 'allow_once'));
    expect(result.output.split('\n').filter((line) => line.startsWith('[network] '))).toHaveLength(1);
    expect(result.output).toContain('origin says hi');
  });

  it('cannot go around the proxy: a direct connection to a granted address is refused by the sandbox', async () => {
    const tools = await stage();
    const target = await origin();
    const result = resultOf(await tools.run('Bash', { command: `/usr/bin/nc -z -w 2 127.0.0.1 ${target.port}`, network: { hosts: [`127.0.0.1:${target.port}`] } }, { mode: 'manual' }, 'allow_once'));
    expect(result.status).toBe('failed');
    expect(target.seen).toEqual([]);
  });

  it('starts no proxy for a read-only command, which runs without network (I4.2)', async () => {
    const tools = await stage();
    const result = resultOf(await tools.run('Bash', { command: 'ls', network: { hosts: ['registry.example.org'] } }, { mode: 'manual', sandboxNetwork: 'allow' }));
    expect(result.status).toBe('completed');
    expect(tools.spawns.map((spawn) => spawn.policy.network)).toEqual(['deny']);
    expect(tools.spawns[0]?.command.env['HTTP_PROXY']).toBeUndefined();
  });
});

describe('a background job that was granted named hosts', () => {
  it('gets the proxy for as long as the job runs, and the proxy ends with the job', async () => {
    const started: BackgroundJobStart[] = [];
    const jobs = { start: async (request: BackgroundJobStart) => (started.push(request), { jobId: 'bash_aaaaaaaaaaaa' }) } as unknown as BackgroundJobs;
    const spawns: RecordedSpawn[] = [];
    let end: () => void = () => undefined;
    const sandbox: Sandbox = {
      kind: 'seatbelt',
      spawn: (command, policy) => {
        spawns.push({ command, policy });
        return { pid: 1, pgid: 1, rebind: () => undefined, stdout: (async function* () {})(), stderr: (async function* () {})(), exited: new Promise((resolve) => (end = () => resolve({ code: 0, signal: null }))) };
      },
    };
    const tools = await makeBuiltins({ jobs, sandbox });
    const result = resultOf(await tools.run('Bash', { command: 'npm install', run_in_background: true, network: { hosts: ['registry.example.org'] } }, { mode: 'manual' }, 'allow_once'));
    expect(result.status).toBe('completed');
    const child = (started[0] as BackgroundJobStart).spawn('/marker', new AbortController().signal, undefined);
    const network = spawns[0]?.policy.network as { loopbackPort: number };
    expect(spawns[0]?.command.env['HTTPS_PROXY']).toMatch(new RegExp(`^http://momonga:[0-9a-f]{64}@127\\.0\\.0\\.1:${network.loopbackPort}$`));
    expect(await refusesConnections(network.loopbackPort)).toBe(false);
    end();
    await (await child).exited;
    expect(await refusesConnections(network.loopbackPort)).toBe(true);
  });
  it('writes the hosts the proxy refused into the output of the job when the job ends, even while a stream of the job stays open', async () => {
    const started: BackgroundJobStart[] = [];
    const jobs = { start: async (request: BackgroundJobStart) => (started.push(request), { jobId: 'bash_aaaaaaaaaaaa' }) } as unknown as BackgroundJobs;
    const spawns: RecordedSpawn[] = [];
    let end: () => void = () => undefined;
    let closeStream: () => void = () => undefined;
    const streamHeld = new Promise<void>((resolve) => (closeStream = resolve));
    const sandbox: Sandbox = {
      kind: 'seatbelt',
      spawn: (command, policy) => {
        spawns.push({ command, policy });
        return {
          pid: 1,
          pgid: 1, rebind: () => undefined,
          stdout: (async function* () {})(),
          stderr: (async function* () {
            yield Buffer.from('from the job\n');
            await streamHeld;
          })(),
          exited: new Promise((resolve) => (end = () => resolve({ code: 0, signal: null }))),
        };
      },
    };
    const tools = await makeBuiltins({ jobs, sandbox });
    await tools.run('Bash', { command: 'npm install', run_in_background: true, network: { hosts: ['registry.example.org'] } }, { mode: 'manual' }, 'allow_once');
    const child = await (started[0] as BackgroundJobStart).spawn('/marker', new AbortController().signal, undefined);
    const network = spawns[0]?.policy.network as { loopbackPort: number };
    await new Promise<void>((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: network.loopbackPort, method: 'GET', path: 'http://evil.example.net/', headers: { 'proxy-authorization': authorizationOf(spawns[0]?.command.env['HTTP_PROXY'] as string) } }, (response) => {
        response.resume();
        response.once('end', resolve);
      });
      request.once('error', reject);
      request.end();
    });
    const errors = child.stderr[Symbol.asyncIterator]();
    expect(Buffer.from((await errors.next()).value as Uint8Array).toString()).toBe('from the job\n');
    end();
    expect(await child.exited).toEqual({ code: 0, signal: null });
    expect(Buffer.from((await errors.next()).value as Uint8Array).toString()).toBe(
      '[network] the sandbox proxy refused evil.example.net:80: it is not among the hosts this command was granted (registry.example.org)\n',
    );
    closeStream();
    expect((await errors.next()).done).toBe(true);
  });
});
