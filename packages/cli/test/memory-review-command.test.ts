import fs from 'node:fs';
import http from 'node:http';
import { ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import type { MemoryView } from '@momonga/protocol';
import { registerCleanup, withTempDir, firstGeneration } from '@momonga/testkit';
import type { TestContext } from 'vitest';
import { describe, expect, it } from 'vitest';
import * as commands from '../src/commands/memory.ts';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram } from '../src/program.ts';
import { terminalPorts } from '../src/terminal-writer.ts';
import * as notices from '../src/tui/notices.ts';
import type { NoticeSource } from '../src/tui/notices.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { nodePolicyVerifyHost } from '../src/verify/host.ts';
import { fakeRuntime } from './acp-harness.ts';
import { startFakeSupervisor, virtualClock } from './fake-supervisor.ts';

const VERSION = '1.2.3';

const memory = (id: string, overrides: Partial<MemoryView> = {}): MemoryView => ({
  id,
  scope: 'project',
  origin: 'trusted',
  project: '/p',
  text: `note ${id}`,
  source: { kind: 'reflection', sessionId: 's', runId: 'r', ordinal: 0 },
  createdAt: 0,
  keptAt: 0,
  kind: 'procedure',
  state: 'candidate',
  duplicateOf: null,
  supersedes: [],
  supersededBy: [],
  retiredAt: null,
  evidence: [],
  contributedAt: null,
  status: 'unbound',
  ...overrides,
});

type Seen = { method: string; url: string; body: string };

type Answer = { status: number; body: unknown };

const setup = async (context: TestContext, answer: (seen: Seen) => Answer) => {
  const home = withTempDir(context, { asHome: true });
  const paths: MomongaPaths = momongaPaths(home);
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
  const ports = {
    version: VERSION,
    env: { PATH: '/usr/bin' },
    home,
    cwd: project,
    clock: virtualClock(),
    self: { kind: 'script', execPath: '/opt/node', script: '/opt/momonga/main.js' },
    spawnDetached: () => {
      throw new Error('the daemon is already running');
    },
    stdout: { write: (text: string) => void out.push(text) },
    stderr: { write: () => undefined },
  } as unknown as CliPorts;
  return { paths, ports: terminalPorts(ports), project, seen, out };
};

const command = (name: string): ((...args: unknown[]) => Promise<number>) => {
  const found = (commands as Record<string, unknown>)[name];
  if (typeof found !== 'function') throw new Error(`commands/memory.ts does not export ${name}`);
  return found as (...args: unknown[]) => Promise<number>;
};

const requests = (seen: readonly Seen[]): string[] => seen.map((entry) => `${entry.method} ${entry.url}`);

describe('momonga memory delete', () => {
  it('memory delete prints that the note was retired', async (context) => {
    const { paths, ports, seen, out } = await setup(context, () => ({ status: 204, body: null }));
    expect(await command('memoryDelete')(ports, paths, 'm1')).toBe(0);
    expect(requests(seen)).toEqual(['DELETE /v1/memories/m1']);
    expect(out.join('')).toBe('retired memory m1; it stays in momonga memory history\n');
  });
});

describe('momonga memory review', () => {
  it('lists the candidates of this folder', async (context) => {
    const { paths, ports, project, seen, out } = await setup(context, () => ({ status: 200, body: { memories: [memory('m1')] } }));
    expect(await command('memoryReview')(ports, paths, { json: false })).toBe(0);
    expect(requests(seen)).toEqual([`GET /v1/memories?state=candidate&project=${encodeURIComponent(project)}`]);
    expect(out.join('')).toContain('m1');
    expect(out.join('')).toContain('note m1');
  });

  const jobView = (overrides: Record<string, unknown> = {}) => ({
    runId: 'run-9',
    state: 'done',
    attempts: 1,
    reason: 'every candidate the model proposed was dropped',
    dropped: [
      { ordinal: 0, text: 'unbound note', cause: 'evidence', reason: 'src/x.ts was not read or written in this run' },
      { ordinal: 1, text: null, cause: 'text_rule', reason: 'looks like a credential' },
      { ordinal: 2, text: 'repeated note', cause: 'duplicate', reason: 'the same text is already a live memory' },
    ],
    updatedAt: 0,
    ...overrides,
  });

  const answerBy = (job: unknown) => (seen: Seen) =>
    seen.url.startsWith('/v1/reflection') ? { status: 200, body: { job } } : { status: 200, body: { memories: [] } };

  it('says when nothing waits, and asks for the last reflection of this folder', async (context) => {
    const { paths, ports, project, seen, out } = await setup(context, answerBy(null));
    await command('memoryReview')(ports, paths, { json: false });
    expect(requests(seen)).toEqual([`GET /v1/memories?state=candidate&project=${encodeURIComponent(project)}`, `GET /v1/reflection?project=${encodeURIComponent(project)}`]);
    expect(out.join('')).toBe('no memories waiting for review\nno reflection has run in this folder yet\n');
  });

  it('gives the reasons of the last reflection when nothing waits', async (context) => {
    const { paths, ports, out } = await setup(context, answerBy(jobView()));
    await command('memoryReview')(ports, paths, { json: false });
    const text = out.join('');
    expect(text).toContain('no memories waiting for review');
    expect(text).toContain('run run-9');
    expect(text).toContain('every candidate the model proposed was dropped');
    expect(text).toContain('candidate 0 dropped, evidence could not be bound: src/x.ts was not read or written in this run');
    expect(text).toContain('"unbound note"');
    expect(text).toContain('candidate 1 dropped, refused by the text rule: looks like a credential');
    expect(text).toContain('candidate 2 dropped, already known: the same text is already a live memory');
  });

  it('gives the reason of a reflection that produced nothing without any dropped candidate', async (context) => {
    const { paths, ports, out } = await setup(context, answerBy(jobView({ reason: 'the model proposed no candidates', dropped: [] })));
    await command('memoryReview')(ports, paths, { json: false });
    expect(out.join('')).toContain('the model proposed no candidates');
  });

  const HOSTILE = 'x\u001b]0;pwn\u0007\u009b2J‮y';
  const ESCAPED = 'x\\u001b]0;pwn\\u0007\\u009b2J\\u202ey';
  const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮]/u;

  it('prints the text and the paths of a candidate with the control characters escaped', async (context) => {
    const hostile = memory('m1', { text: `first\n${HOSTILE}`, project: HOSTILE, evidence: [{ kind: 'file', project: '/p', path: HOSTILE, sha256: 'a'.repeat(64) }] });
    const { paths, ports, out } = await setup(context, () => ({ status: 200, body: { memories: [hostile] } }));
    await command('memoryReview')(ports, paths, { json: false });
    const text = out.join('');
    expect(text).not.toMatch(UNSAFE);
    expect(text.split(ESCAPED).length - 1).toBe(3);
  });

  it('prints the reasons, the job reason and the candidate text of the last reflection with the control characters escaped', async (context) => {
    const { paths, ports, out } = await setup(
      context,
      answerBy(
        jobView({
          reason: HOSTILE,
          dropped: [
            { ordinal: 0, text: HOSTILE, cause: 'evidence', reason: `${HOSTILE} was not read or written in this run` },
            { ordinal: 1, text: null, cause: 'text_rule', reason: HOSTILE },
          ],
        }),
      ),
    );
    await command('memoryReview')(ports, paths, { json: false });
    const text = out.join('');
    expect(text).not.toMatch(UNSAFE);
    expect(text.split(ESCAPED).length - 1).toBe(4);
  });

  it('keeps the JSON output as recorded', async (context) => {
    const { paths, ports, out } = await setup(context, () => ({ status: 200, body: { memories: [memory('m1', { text: HOSTILE })] } }));
    await command('memoryReview')(ports, paths, { json: true });
    expect(JSON.parse(out.join(''))[0].text).toBe(HOSTILE);
  });

  it('prints memory list with the control characters of a memory text escaped', async (context) => {
    const { paths, ports, out } = await setup(context, () => ({ status: 200, body: { memories: [memory('m1', { text: HOSTILE })] } }));
    await command('memoryList')(ports, paths, { json: false });
    expect(out.join('')).not.toMatch(UNSAFE);
    expect(out.join('')).toContain(ESCAPED);
  });

  it('prints memory history with the control characters of a memory text escaped', async (context) => {
    const { paths, ports, out } = await setup(context, () => ({ status: 200, body: { memories: [memory('m1', { text: HOSTILE })] } }));
    await command('memoryHistory')(ports, paths, 'm1', false);
    expect(out.join('')).not.toMatch(UNSAFE);
    expect(out.join('')).toContain(ESCAPED);
  });

  it('does not ask for the reflection while candidates wait', async (context) => {
    const { paths, ports, seen } = await setup(context, () => ({ status: 200, body: { memories: [memory('m1')] } }));
    await command('memoryReview')(ports, paths, { json: false });
    expect(requests(seen)).toHaveLength(1);
  });

  it('keeps the JSON output the list of memories', async (context) => {
    const { paths, ports, out } = await setup(context, () => ({ status: 200, body: { memories: [] } }));
    await command('memoryReview')(ports, paths, { json: true });
    expect(JSON.parse(out.join(''))).toEqual([]);
  });

  it('accepts by id', async (context) => {
    const { paths, ports, seen, out } = await setup(context, () => ({ status: 200, body: { memory: memory('m1', { state: 'active' }) } }));
    expect(await command('memoryAccept')(ports, paths, 'm1')).toBe(0);
    expect(requests(seen)).toEqual(['POST /v1/memories/m1/accept']);
    expect(out.join('')).toContain('accepted memory m1');
  });

  it('rejects by id', async (context) => {
    const { paths, ports, seen, out } = await setup(context, () => ({ status: 200, body: { memory: memory('m1', { state: 'archived' }) } }));
    expect(await command('memoryReject')(ports, paths, 'm1')).toBe(0);
    expect(requests(seen)).toEqual(['POST /v1/memories/m1/reject']);
    expect(out.join('')).toContain('rejected memory m1');
  });
});

describe('momonga memory restore and promote', () => {
  it('restores by id', async (context) => {
    const { paths, ports, seen, out } = await setup(context, () => ({ status: 200, body: { memory: memory('m1', { state: 'active' }) } }));
    expect(await command('memoryRestore')(ports, paths, 'm1')).toBe(0);
    expect(requests(seen)).toEqual(['POST /v1/memories/m1/restore']);
    expect(out.join('')).toContain('restored memory m1');
  });

  it('promotes with the skill name and prints the path', async (context) => {
    const { paths, ports, seen, out } = await setup(context, () => ({ status: 201, body: { path: '/p/.momonga/skills/seed-first/SKILL.md' } }));
    expect(await command('memoryPromote')(ports, paths, 'm1', 'seed-first')).toBe(0);
    expect(requests(seen)).toEqual(['POST /v1/memories/m1/promote']);
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({ skill: 'seed-first' });
    expect(out.join('')).toContain('/p/.momonga/skills/seed-first/SKILL.md');
  });
});

describe('command registration', () => {
  const program = () => {
    const ports = { version: '9.9.9', home: '/h', cwd: '/c', terminal: undefined } as unknown as CliPorts;
    const entry = async (): Promise<number> => 0;
    return buildProgram({
      ports,
      policyVerify: () => nodePolicyVerifyHost(ports, { executables: '/c/cache/executables' }),
      entries: { supervise: entry, gateway: entry, runtime: entry },
      update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 }),
      interrupt: new AbortController().signal,
      entryIo: () => ({ argv: [] }) as never,
      complete: () => undefined,
    });
  };

  it('registers review with accept and reject, restore, and promote with a required skill', () => {
    const memoryCommand = program().commands.find((entry) => entry.name() === 'memory');
    const names = memoryCommand?.commands.map((entry) => entry.name()) ?? [];
    expect(names).toEqual(expect.arrayContaining(['review', 'restore', 'promote']));
    const review = memoryCommand?.commands.find((entry) => entry.name() === 'review');
    expect(review?.commands.map((entry) => entry.name()).sort()).toEqual(['accept', 'reject']);
    const promote = memoryCommand?.commands.find((entry) => entry.name() === 'promote');
    expect(promote?.options.find((option) => option.long === '--skill')?.mandatory).toBe(true);
  });
});

describe('the TUI start note', () => {
  const source = (): NoticeSource => {
    const found = (notices as Record<string, unknown>)['memoryReviewNoticeSource'];
    if (typeof found !== 'function') throw new Error('notices.ts does not export memoryReviewNoticeSource');
    return found as NoticeSource;
  };

  it('counts the candidates of the folder and names the command', async () => {
    const runtime = fakeRuntime();
    const asked: unknown[] = [];
    runtime.memories = async (filter) => {
      asked.push(filter);
      return [memory('m1'), memory('m2')];
    };
    const [note, ...rest] = await source()({ runtime, session: runtime.session });
    expect(rest).toEqual([]);
    expect(note).toContain('2');
    expect(note).toContain('momonga memory review');
    expect(asked).toEqual([{ state: 'candidate', project: runtime.session.cwd }]);
  });

  it('stays silent when nothing waits', async () => {
    const runtime = fakeRuntime();
    runtime.memories = async () => [];
    expect(await source()({ runtime, session: runtime.session })).toEqual([]);
  });

  it('is one of the default sources', () => {
    const defaults = notices.defaultNoticeSources({ home: '/h' }, {} as never);
    expect(defaults).toContain(source());
  });
});
