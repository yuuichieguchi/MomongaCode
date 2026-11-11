import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@momonga/foundation';
import { createMemoryPort } from '@momonga/runtime';
import type { EvidenceCommand, EvidenceRun } from '@momonga/runtime';
import { defineTool } from '@momonga/tools';
import type { AnyTool } from '@momonga/tools';
import { makeEnv, textOf } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';
import { NEVER_CANCELLED } from '@momonga/testkit';

const trustedEnv = async (): Promise<Env> => {
  const env = await makeEnv({ mode: 'bypassPermissions' });
  await env.store.trust.setAsked(env.session.cwd, 'trusted', NEVER_CANCELLED);
  return env;
};

const HEAD = '0123456789abcdef0123456789abcdef01234567';

const FILE = 'src/a.ts';

const readTool = defineTool<{ file_path: string }>({
  name: 'Read',
  description: 'Reads a file and records its content hash',
  kind: 'read',
  sideEffect: 'read_only',
  inputSchema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'], additionalProperties: false },
  timeoutMs: 60_000,
  title: (input) => `Read ${input.file_path}`,
  subject: () => ({ kind: 'none', tool: 'Read' }),
  execute: async (input) => {
    const real = fs.realpathSync(input.file_path);
    return { status: 'completed', output: 'read', files: [{ path: real, sha256: sha256Hex(fs.readFileSync(real, 'utf8')), access: 'read' }] };
  },
});

const bashTool = defineTool<{ command: string }>({
  name: 'Bash',
  description: 'Runs a command and records its exit code',
  kind: 'execute',
  sideEffect: 'read_only',
  inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false },
  timeoutMs: 60_000,
  title: (input) => `Bash ${input.command}`,
  subject: () => ({ kind: 'none', tool: 'Bash' }),
  execute: async () => ({ status: 'failed', output: 'one test failed', exitCode: 1 }),
});

const gitRun = (commands: EvidenceCommand[]): EvidenceRun => async (command) => {
  commands.push(command);
  return { exitCode: 0, stdout: `${HEAD}\n` };
};

const workerFor = (env: Env, id: string, run: EvidenceRun) =>
  env.worker(id, {
    toolList: () => [...env.toolbox.tools().filter((tool) => tool.name !== 'Bash'), readTool, bashTool],
    memories: createMemoryPort({ platform: process.platform, store: env.store, settings: env.settings, evidenceRun: () => run }),
  });

const writeFile = (env: Env, content: string): string => {
  const target = path.join(env.session.cwd, FILE);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
};

const savePaths = (paths: string[], overrides: Record<string, unknown> = {}) =>
  callsStep([{ callId: 'call_m_1', name: 'MemorySave', args: { text: 'a.ts parses the config', scope: 'project', paths, ...overrides } }]);

const inputText = (env: Env, index: number): string => (env.gateway.streams[index]?.body.input as unknown[]).map(textOf).join('\n');

describe('MemorySave in a run', () => {
  it('binds a file read in this run with the hash the tool recorded and the head commit, takes no hash from the model, and takes no command the model ran as a check', async () => {
    const env = await trustedEnv();
    const target = writeFile(env, 'abc');
    const commands: EvidenceCommand[] = [];
    env.settings.verificationValue = { commands: ['npm test'], manifests: [], conditions: [], required: false };
    env.gateway.script.push(
      callsStep([{ callId: 'call_r_1', name: 'Read', args: { file_path: target } }]),
      callsStep([{ callId: 'call_b_1', name: 'Bash', args: { command: 'npm test' } }]),
      savePaths([FILE]),
      textStep('Saved.'),
    );
    const run = await env.enqueue('Remember what a.ts does');
    await env.runOnce(workerFor(env, 'w-1', gitRun(commands)));
    expect(env.run(run.id).status).toBe('COMPLETED');
    const [memory] = env.store.memories.list();
    expect(memory?.evidence).toEqual([
      { kind: 'file', project: env.session.cwd, path: FILE, sha256: sha256Hex('abc') },
      { kind: 'commit', sha: HEAD },
    ]);
    expect(commands.map((command) => command.argv)).toEqual([['git', 'rev-parse', 'HEAD']]);
  });

  it('records HEAD for a note that names no path, and hands the evidence run the signal of the tool call', async () => {
    const env = await trustedEnv();
    const signals: AbortSignal[] = [];
    const commands: EvidenceCommand[] = [];
    env.gateway.script.push(callsStep([{ callId: 'call_m_1', name: 'MemorySave', args: { text: 'the repo uses vitest', scope: 'project' } }]), textStep('Saved.'));
    await env.enqueue('Remember');
    await env.runOnce(
      workerFor(env, 'w-1', async (command, signal) => {
        commands.push(command);
        signals.push(signal);
        return { exitCode: 0, stdout: `${HEAD}\n` };
      }),
    );
    const [memory] = env.store.memories.list();
    expect(memory?.evidence).toEqual([{ kind: 'commit', sha: HEAD }]);
    expect(commands.map((command) => command.argv)).toEqual([['git', 'rev-parse', 'HEAD'], ['git', 'merge-base', '--is-ancestor', HEAD, 'HEAD']]);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal instanceof AbortSignal && !signal.aborted)).toBe(true);
  });

  it('hands recall a signal that follows the run: open while the run lives', async () => {
    const env = await trustedEnv();
    const given: AbortSignal[] = [];
    const inner = createMemoryPort({ platform: process.platform, store: env.store, settings: env.settings, evidenceRun: () => gitRun([]) });
    env.gateway.script.push(textStep('Fine.'));
    await env.enqueue('Hello');
    await env.runOnce(
      env.worker('w-1', {
        memories: {
          load: (session, signal) => {
            given.push(signal);
            return inner.load(session, signal);
          },
        },
      }),
    );
    expect(given).toHaveLength(1);
    expect(given[0]?.aborted).toBe(false);
  });

  it('fails the call, saving nothing, when the path was not read or written in this run', async () => {
    const env = await trustedEnv();
    writeFile(env, 'abc');
    env.gateway.script.push(savePaths([FILE]), textStep('Refused.'));
    const run = await env.enqueue('Remember what a.ts does');
    await env.runOnce(workerFor(env, 'w-1', gitRun([])));
    const [completed] = env.ofType(run.id, 'tool.completed');
    expect(completed?.status).toBe('failed');
    expect(completed?.output).toContain(`${FILE} was not read or written in this run`);
    expect(env.store.memories.list()).toEqual([]);
  });

  describe('a note may only replace a note of its own scope and project, saved at an origin no higher than its own', () => {
    const saveOnce = async (env: Env, id: string, args: Record<string, unknown>, trusted: boolean) => {
      env.settings.trustedValue = trusted;
      env.gateway.script.push(callsStep([{ callId: `call_${id}`, name: 'MemorySave', args }]), textStep('Done.'));
      const run = await env.enqueue(`Remember ${id}`, { history: 'fresh' });
      await env.runOnce(env.worker(`w-${id}`, { memories: createMemoryPort({ platform: process.platform, store: env.store, settings: env.settings, evidenceRun: () => gitRun([]) }) }));
      return run;
    };

    it('refuses an untrusted folder replacing a trusted user note, leaving the old note recalled', async () => {
      const env = await trustedEnv();
      await saveOnce(env, 'a', { text: 'trusted user note', scope: 'user' }, true);
      const [older] = env.store.memories.list();
      const run = await saveOnce(env, 'b', { text: 'hostile replacement', scope: 'user', supersedes: [older?.id] }, false);
      const completed = env.ofType(run.id, 'tool.completed')[0];
      expect(completed?.status).toBe('failed');
      expect(completed?.output).toContain(`${older?.id} is not a saved memory you can replace`);
      expect(env.store.memories.list().map((memory) => memory.text)).toEqual(['trusted user note']);
    });

    it('refuses a user note replacing a project note, and a project note replacing a user note', async () => {
      const env = await trustedEnv();
      await saveOnce(env, 'a', { text: 'project note', scope: 'project' }, true);
      await saveOnce(env, 'b', { text: 'user note', scope: 'user' }, true);
      const [project, user] = env.store.memories.list();
      const first = await saveOnce(env, 'c', { text: 'x', scope: 'user', supersedes: [project?.id] }, true);
      const second = await saveOnce(env, 'd', { text: 'y', scope: 'project', supersedes: [user?.id] }, true);
      expect(env.ofType(first.id, 'tool.completed')[0]?.status).toBe('failed');
      expect(env.ofType(second.id, 'tool.completed')[0]?.status).toBe('failed');
      expect(env.store.memories.list()).toHaveLength(2);
    });
  });

  it('fails the call when the note replaces a memory that is not saved', async () => {
    const env = await trustedEnv();
    env.gateway.script.push(savePaths([], { supersedes: ['absent'] }), textStep('Refused.'));
    const run = await env.enqueue('Remember');
    await env.runOnce(workerFor(env, 'w-1', gitRun([])));
    expect(env.ofType(run.id, 'tool.completed')[0]?.status).toBe('failed');
    expect(env.store.memories.list()).toEqual([]);
  });

  it('shows the note as verified while the file is unchanged and as stale once it changes, recording the status each run recalled', async () => {
    const env = await trustedEnv();
    const target = writeFile(env, 'abc');
    const run = gitRun([]);
    env.gateway.script.push(callsStep([{ callId: 'call_r_1', name: 'Read', args: { file_path: target } }]), savePaths([FILE]), textStep('Saved.'));
    await env.enqueue('Remember what a.ts does', { history: 'fresh' });
    await env.runOnce(workerFor(env, 'w-1', async () => ({ exitCode: 128 })));
    const [memory] = env.store.memories.list();
    expect(memory?.evidence.map((entry) => entry.kind)).toEqual(['file']);

    env.gateway.script.push(textStep('Fine.'));
    const verified = await env.enqueue('Continue', { history: 'fresh' });
    await env.runOnce(workerFor(env, 'w-2', run));
    expect(env.ofType(verified.id, 'context.memories_loaded').map((event) => event.memories)).toEqual([[{ id: memory?.id, status: 'verified' }]]);
    expect(inputText(env, env.gateway.streams.length - 1)).toMatch(/status="verified"/);

    fs.writeFileSync(target, 'changed');
    env.gateway.script.push(textStep('Fine.'));
    const stale = await env.enqueue('Continue again', { history: 'fresh' });
    await env.runOnce(workerFor(env, 'w-3', run));
    expect(env.ofType(stale.id, 'context.memories_loaded').map((event) => event.memories)).toEqual([[{ id: memory?.id, status: 'stale' }]]);
    expect(inputText(env, env.gateway.streams.length - 1)).toContain('Do not rely on a note with status="stale"');
  });

  it('shows a replaced note only with include all, and the status of each', async () => {
    const env = await trustedEnv();
    const port = createMemoryPort({ platform: process.platform, store: env.store, settings: env.settings, evidenceRun: () => gitRun([]) });
    env.gateway.script.push(
      callsStep([{ callId: 'call_m_1', name: 'MemorySave', args: { text: 'old shared note', scope: 'project' } }]),
      textStep('Saved.'),
    );
    await env.enqueue('Remember', { history: 'fresh' });
    await env.runOnce(env.worker('w-1', { memories: port }));
    const [older] = env.store.memories.list();
    env.gateway.script.push(
      callsStep([{ callId: 'call_m_2', name: 'MemorySave', args: { text: 'new shared note', scope: 'project', supersedes: [older?.id] } }]),
      textStep('Replaced.'),
    );
    await env.enqueue('Replace', { history: 'fresh' });
    await env.runOnce(env.worker('w-2', { memories: port }));
    env.gateway.script.push(
      callsStep([{ callId: 'call_s_1', name: 'MemorySearch', args: { query: 'shared' } }]),
      callsStep([{ callId: 'call_s_2', name: 'MemorySearch', args: { query: 'shared', include: 'all' } }]),
      textStep('Searched.'),
    );
    const search = await env.enqueue('Search', { history: 'fresh' });
    await env.runOnce(env.worker('w-3', { memories: port }));
    const [live, all] = env.ofType(search.id, 'tool.completed').map((event) => event.output);
    expect(live).toContain('new shared note');
    expect(live).not.toContain('old shared note');
    expect(live).toContain('status unbound');
    expect(all).toContain('old shared note');
    expect(all).toContain('new shared note');
    expect(all).toContain(`supersedes ${older?.id}`);
  });
});
