import fs from 'node:fs';
import http from 'node:http';
import { ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import type { GoverningFactView, MemoryView, PolicyGovernanceResponse } from '@momonga/protocol';
import { registerCleanup, withTempDir, firstGeneration, testEndpointScope } from '@momonga/testkit';
import type { TestContext } from 'vitest';
import { describe, expect, it } from 'vitest';
import { memoryHistory } from '../src/commands/memory.ts';
import { policyVerify } from '../src/commands/policy.ts';
import { ruleAdd, ruleHistory, ruleList, ruleRetire } from '../src/commands/rule.ts';
import type { CliPorts } from '../src/ports.ts';
import { terminalPorts } from '../src/terminal-writer.ts';
import { startFakeSupervisor, virtualClock } from './fake-supervisor.ts';

const FAKE_PERSON_CAPABILITY = 'f'.repeat(32);

const VERSION = '1.2.3';

const fact = (id: string, overrides: Partial<GoverningFactView> = {}): GoverningFactView => ({
  id,
  kind: 'constraint',
  target: 'pandas',
  text: `text of ${id}`,
  scope: { level: 'user' },
  validFrom: 0,
  validUntil: null,
  retiredAt: null,
  supersedes: [],
  enforcement: null,
  source: { kind: 'command', at: 0 },
  ...overrides,
});

const memory = (id: string, overrides: Partial<MemoryView> = {}): MemoryView => ({
  id,
  scope: 'user',
  origin: 'trusted',
  project: null,
  text: `note ${id}`,
  source: { kind: 'tool', sessionId: 's', runId: 'r', step: 1, callId: id, seq: 1 },
  createdAt: 0,
  keptAt: 0,
  kind: 'fact',
  state: 'active',
  duplicateOf: null,
  supersedes: [],
  supersededBy: [],
  retiredAt: null,
  evidence: [],
  contributedAt: null,
  keptByClassifier: null,
  status: 'unbound',
  ...overrides,
});

type Seen = { method: string; url: string; body: string };

type Answer = { status: number; body: unknown };

const setup = async (context: TestContext, answer: (seen: Seen) => Answer) => {
  const home = withTempDir(context, { asHome: true });
  const paths: MomongaPaths = momongaPaths(home, process.platform, process.env);
  await ensureMomongaDirs(paths);
  const project = fs.realpathSync(withTempDir(context));
  const supervisor = await startFakeSupervisor({ paths, version: VERSION });
  const seen: Seen[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const entry = { method: request.method ?? '', url: request.url ?? '', body: Buffer.concat(chunks).toString('utf8') };
      seen.push(entry);
      const reply = answer(entry);
      response.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(firstGeneration(paths).sockets.runtime, resolve));
  registerCleanup(context, async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await supervisor.stop();
  });
  const out: string[] = [];
  const err: string[] = [];
  const ports = {
    version: VERSION,
    env: { PATH: '/usr/bin' },
    home,
    cwd: project,
    clock: virtualClock(),
    endpointScope: testEndpointScope,
    self: { kind: 'script', execPath: '/opt/node', script: '/opt/momonga/main.js' },
    spawnDetached: () => {
      throw new Error('the daemon is already running');
    },
    stdout: { write: (text: string) => void out.push(text) },
    stderr: { write: (text: string) => void err.push(text) },
    interrupt: new AbortController().signal,
    personCapability: async (home: string) => (home === paths.home ? FAKE_PERSON_CAPABILITY : `no capability for ${home}`),
  } as unknown as CliPorts;
  return { paths, ports: terminalPorts(ports), project, seen, out, err };
};

describe('momonga rule', () => {
  it('adds a rule for this folder with the flags as the request, and prints the size and warnings', async (context) => {
    const { paths, ports, project, seen, out } = await setup(context, () => ({
      status: 201,
      body: { fact: fact('g1', { enforcement: { behavior: 'deny', rule: 'Bash(rm:*)' } }), size: [{ target: 'fm', contextWindow: 1000, tokens: 5, percent: 0.5 }], warnings: ['overlaps g0'] },
    }));
    const code = await ruleAdd(ports, paths, 'pandas', 'never use pandas', {
      kind: 'preference',
      user: false,
      paths: ['src/**'],
      enforcement: { behavior: 'deny', rule: 'Bash(rm:*)' },
      supersedes: ['g0'],
      json: false,
    });
    expect(code).toBe(0);
    expect(seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual(['POST /v1/rules']);
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({
      kind: 'preference',
      target: 'pandas',
      text: 'never use pandas',
      scope: { level: 'project', project, paths: ['src/**'] },
      supersedes: ['g0'],
      enforcement: { behavior: 'deny', rule: 'Bash(rm:*)' },
    });
    expect(out.join('')).toContain('added rule g1 (enforced: deny Bash(rm:*))');
    expect(out.join('')).toContain('5 tokens, 0.5% of the 1000-token window of fm');
    expect(out.join('')).toContain('warning: overlaps g0');
  });

  it('refuses --path together with --user, sending nothing, because a rule for every folder has no folder to take paths from', async (context) => {
    const { paths, ports, seen } = await setup(context, () => ({ status: 201, body: { fact: fact('g1'), size: [], warnings: [] } }));
    await expect(ruleAdd(ports, paths, 'tabs', 'use tabs', { kind: 'constraint', user: true, paths: ['src/**'], enforcement: null, supersedes: [], json: false })).rejects.toThrow('--path');
    expect(seen).toEqual([]);
  });

  it('adds a user rule with no project', async (context) => {
    const { paths, ports, seen } = await setup(context, () => ({ status: 201, body: { fact: fact('g1'), size: [], warnings: [] } }));
    await ruleAdd(ports, paths, 'tabs', 'use tabs', { kind: 'constraint', user: true, paths: [], enforcement: null, supersedes: [], until: 86_400_000, json: true });
    expect(JSON.parse(seen[0]?.body ?? '')).toMatchObject({ scope: { level: 'user' }, validUntil: 86_400_000, enforcement: null });
  });

  it('lists the rules with the control characters of their text and target escaped', async (context) => {
    const hostile = 'x\u001b]0;pwn\u0007\u009b2J‮y';
    const { paths, ports, out } = await setup(context, () => ({ status: 200, body: { facts: [fact('g1', { text: hostile, target: hostile })] } }));
    await ruleList(ports, paths, false);
    expect(out.join('')).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮]/u);
    expect(out.join('').split('x\\u001b]0;pwn\\u0007\\u009b2J\\u202ey').length - 1).toBe(2);
  });

  it('lists the rules of this folder, enforced or text-only', async (context) => {
    const { paths, ports, project, seen, out } = await setup(context, () => ({
      status: 200,
      body: { facts: [fact('g1', { enforcement: { behavior: 'ask', rule: 'Bash(git push:*)' } }), fact('g2')] },
    }));
    expect(await ruleList(ports, paths, false)).toBe(0);
    expect(seen.map((entry) => entry.url)).toEqual([`/v1/rules?project=${encodeURIComponent(project)}`]);
    expect(out.join('')).toContain('enforced: ask Bash(git push:*)');
    expect(out.join('')).toContain('text-only');
  });

  it('retires a rule and shows its history', async (context) => {
    const { paths, ports, seen, out } = await setup(context, ({ url }) =>
      url.endsWith('/retire') ? { status: 200, body: { fact: fact('g2', { retiredAt: 5 }) } } : { status: 200, body: { facts: [fact('g1'), fact('g2', { supersedes: ['g1'], retiredAt: 5 })] } },
    );
    expect(await ruleRetire(ports, paths, 'g2')).toBe(0);
    expect(await ruleHistory(ports, paths, 'g2', false)).toBe(0);
    expect(seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual(['POST /v1/rules/g2/retire', 'GET /v1/rules/g2/history']);
    expect(out.join('')).toContain('retired rule g2');
    expect(out.join('')).toContain('supersedes g1');
  });
});

describe('momonga memory history', () => {
  it('prints the chain with the status and validity of each note', async (context) => {
    const { paths, ports, seen, out } = await setup(context, () => ({
      status: 200,
      body: { memories: [memory('m1', { status: 'stale', retiredAt: 86_400_000, supersededBy: ['m2'] }), memory('m2', { supersedes: ['m1'] })] },
    }));
    expect(await memoryHistory(ports, paths, 'm1', false)).toBe(0);
    expect(seen.map((entry) => entry.url)).toEqual(['/v1/memories/m1/history']);
    const lines = out.join('').split('\n');
    expect(lines[0]).toContain('m1  stale');
    expect(lines[0]).toContain('retired 1970-01-02T00:00:00.000Z');
    expect(lines[0]).toContain('superseded by m2');
    expect(lines[1]).toContain('m2  unbound');
    expect(lines[1]).toContain('supersedes m1');
  });
});

describe('momonga policy verify', () => {
  const governance: PolicyGovernanceResponse = { rules: [{ id: 'g1', behavior: 'ask', rule: 'Bash(git push:*)' }], textOnly: [fact('g2')] };

  const verified = (exitCode = 0) => ({ fingerprint: 'f'.repeat(64), stored: exitCode === 0, exitCode, text: 'verification report', findings: { exitCode, status: exitCode === 0 ? 'proved' : 'refuted' } });

  const answering =
    (body: PolicyGovernanceResponse, exitCode = 0) =>
    ({ url, method }: Seen): Answer => {
      if (method === 'POST' && url === '/v1/policy/verify') return { status: 200, body: verified(exitCode) };
      return { status: 200, body };
    };

  it('asks the daemon to verify the rules of this folder and prints the report the daemon returns, with the governance layer', async (context) => {
    const { paths, ports, seen, out } = await setup(context, answering(governance));
    expect(await policyVerify(ports, paths, { json: false, secrets: ['~/vault', '/keys'], mode: 'plan', mandate: 'release' })).toBe(0);
    expect(seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual([`GET /v1/policy/governance?project=${encodeURIComponent(ports.cwd)}`, 'POST /v1/policy/verify']);
    expect(JSON.parse(seen[1]?.body ?? '')).toEqual({ project: ports.cwd, secrets: [`${ports.home}/vault`, '/keys'], mode: 'plan', mandate: 'release' });
    expect(out.join('')).toContain('verification report');
    expect(out.join('')).toContain('g1: verified as ask Bash(git push:*)');
    expect(out.join('')).toContain('g2: text-only, no guarantee');
  });

  it('does not claim a rule was verified when the daemon reports that the rules did not prove', async (context) => {
    const { paths, ports, out } = await setup(context, answering(governance, 1));
    expect(await policyVerify(ports, paths, { json: false, secrets: [] })).toBe(1);
    expect(out.join('')).toContain('g1: included in the verification as ask Bash(git push:*), which did not prove');
    expect(out.join('')).not.toContain('verified as');
  });

  it('prints the findings as JSON, with the governance answer only when there is one', async (context) => {
    const { paths, ports, out } = await setup(context, answering({ rules: [], textOnly: [] }));
    await policyVerify(ports, paths, { json: true, secrets: [] });
    expect(JSON.parse(out.join(''))).toEqual({ exitCode: 0, status: 'proved' });
  });

  it('refuses a secret location that is neither absolute nor under the home before it asks the daemon', async (context) => {
    const { paths, ports, seen } = await setup(context, answering(governance));
    await expect(policyVerify(ports, paths, { json: false, secrets: ['vault'] })).rejects.toThrow('--secret "vault" must be an absolute path or start with ~/');
    expect(seen).toEqual([]);
  });
});
