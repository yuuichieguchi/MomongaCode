import { execFileSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { EvidenceOutsideRootError, EvidenceUnreadableError } from '@momonga/memory';
import type { RunEvent, ToolFile } from '@momonga/protocol';
import { MemoryEvidenceError, bindMemoryEvidence, createEvidencePorts, readGitHead, runFactsOf } from '@momonga/runtime';
import type { EvidenceCommand } from '@momonga/runtime';
import { createEvidenceFold } from '../../src/memory/evidence-fold.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const PROJECT = '/work/a';
const HASH = 'a'.repeat(64);
const NEWER_HASH = 'b'.repeat(64);
const HEAD = '0123456789abcdef0123456789abcdef01234567';

const call = (seq: number, callId: string, name: string, rawInput: Record<string, unknown>): RunEvent =>
  ({ seq, type: 'tool.call', callId, providerCallId: callId, name, kind: 'other', title: name, rawInput }) as unknown as RunEvent;

const done = (seq: number, callId: string, extra: { status?: 'completed' | 'failed'; output?: string; files?: ToolFile[]; exitCode?: number } = {}): RunEvent => {
  const { status = 'completed', output = 'ok', ...recorded } = extra;
  return { seq, type: 'tool.completed', callId, status, output, ...recorded } as unknown as RunEvent;
};

const verdict = (seq: number, command: string, exitCode: number | undefined, output = ''): RunEvent =>
  ({
    seq,
    type: 'verification.completed',
    round: 1,
    conditionId: `condition:${command}`,
    command,
    outcome: exitCode === 0 ? 'passed' : exitCode === undefined ? 'timed_out' : 'failed',
    ...(exitCode === undefined ? {} : { exitCode }),
    durationMs: 1,
    output,
    mutationSeq: 0,
  }) as unknown as RunEvent;

const fileOf = (target: string, access: ToolFile['access'], sha256 = HASH): ToolFile => ({ path: target, sha256, access });

const binding = (events: RunEvent[], paths: string[], overrides: { trusted?: boolean; head?: string | undefined } = {}) =>
  bindMemoryEvidence({
    scope: 'project',
    paths,
    project: PROJECT,
    platform: 'linux',
    trusted: overrides.trusted ?? true,
    facts: async (resolved) => {
      const fold = createEvidenceFold({ paths: resolved });
      for (const event of events) fold.add(event);
      return runFactsOf('r1', { lastSeq: events.length, ...fold.finish() });
    },
    head: async () => ('head' in overrides ? overrides.head : HEAD),
  });

const READ_A = [call(1, 'c1', 'Read', { file_path: '/work/a/src/a.ts' }), done(2, 'c1', { files: [fileOf('/work/a/src/a.ts', 'read')] })];

describe('bindMemoryEvidence', () => {
  it('takes the hash the tool recorded, stores the path relative to the project, and takes no hash from input', async () => {
    await expect(binding(READ_A, ['src/a.ts'])).resolves.toEqual([
      { kind: 'file', project: PROJECT, path: 'src/a.ts', sha256: HASH },
      { kind: 'commit', sha: HEAD },
    ]);
  });

  it('binds the latest recorded content of a file that was read and then written', async () => {
    const events = [...READ_A, call(3, 'c2', 'Edit', { file_path: '/work/a/src/a.ts' }), done(4, 'c2', { files: [fileOf('/work/a/src/a.ts', 'write', NEWER_HASH)] })];
    await expect(binding(events, ['src/a.ts'])).resolves.toContainEqual({ kind: 'file', project: PROJECT, path: 'src/a.ts', sha256: NEWER_HASH });
  });

  it('accepts a path written in this run, by absolute name', async () => {
    const events = [call(1, 'c1', 'Write', { file_path: 'src/b.ts' }), done(2, 'c1', { files: [fileOf('/work/a/src/b.ts', 'write')] })];
    await expect(binding(events, ['/work/a/src/b.ts'])).resolves.toContainEqual({ kind: 'file', project: PROJECT, path: 'src/b.ts', sha256: HASH });
  });

  it('refuses a path the journal does not show, with a message saying so', async () => {
    const refused = binding(READ_A, ['src/other.ts']);
    await expect(refused).rejects.toBeInstanceOf(MemoryEvidenceError);
    await expect(refused).rejects.toThrow('src/other.ts was not read or written in this run');
  });

  it('refuses a path only attempted: the failed call recorded no file', async () => {
    const events = [call(1, 'c1', 'Read', { file_path: '/work/a/src/a.ts' }), done(2, 'c1', { status: 'failed', output: 'no such file' })];
    await expect(binding(events, ['src/a.ts'])).rejects.toBeInstanceOf(MemoryEvidenceError);
  });

  it('stores the path of a file on a Windows host with forward slashes, relative to the project', async () => {
    const project = 'C:\\work\\a';
    const evidence = await bindMemoryEvidence({
      scope: 'project',
      paths: ['src\\deep\\a.ts', 'C:\\work\\a\\src\\b.ts'],
      project,
      platform: 'win32',
      trusted: false,
      facts: async (resolved) => {
        expect(resolved).toEqual(['C:\\work\\a\\src\\deep\\a.ts', 'C:\\work\\a\\src\\b.ts']);
        return { recorded: [{ sha256: HASH }, { sha256: HASH }], check: null };
      },
      head: async () => undefined,
    });
    expect(evidence).toEqual([
      { kind: 'file', project, path: 'src/deep/a.ts', sha256: HASH },
      { kind: 'file', project, path: 'src/b.ts', sha256: HASH },
    ]);
  });

  it('refuses a Windows path beside the project that shares its prefix', async () => {
    const refused = bindMemoryEvidence({
      scope: 'project',
      paths: ['C:\\work\\ab\\x.ts'],
      project: 'C:\\work\\a',
      platform: 'win32',
      trusted: false,
      facts: async () => ({ recorded: [{ sha256: HASH }], check: null }),
      head: async () => undefined,
    });
    await expect(refused).rejects.toThrow('outside the project');
  });

  it('refuses a path outside the project', async () => {
    const events = [call(1, 'c1', 'Read', { file_path: '/etc/passwd' }), done(2, 'c1', { files: [fileOf('/etc/passwd', 'read')] })];
    await expect(binding(events, ['/etc/passwd'])).rejects.toBeInstanceOf(MemoryEvidenceError);
    await expect(binding(events, ['../../etc/passwd'])).rejects.toBeInstanceOf(MemoryEvidenceError);
  });

  it('binds no file for a note that names no path, but records HEAD in a trusted folder all the same', async () => {
    await expect(binding(READ_A, [])).resolves.toEqual([{ kind: 'commit', sha: HEAD }]);
    await expect(binding(READ_A, [], { trusted: false })).resolves.toEqual([]);
    await expect(binding(READ_A, [], { head: undefined })).resolves.toEqual([]);
  });

  it('takes the latest verdict of the whole run for a note that names no path, even one that came before a write', async () => {
    const events = [verdict(1, 'npm test', 0), call(2, 'c2', 'Write', { file_path: 'src/a.ts' }), done(3, 'c2', { files: [fileOf('/work/a/src/a.ts', 'write')] })];
    await expect(binding(events, [])).resolves.toEqual([{ kind: 'commit', sha: HEAD }, { kind: 'check', runId: 'r1', conditionId: 'condition:npm test', seq: 1, command: 'npm test', exitCode: 0 }]);
  });

  it('adds the latest verdict after the last write to a bound path', async () => {
    const events = [
      verdict(1, 'npm test', 0),
      call(2, 'c2', 'Write', { file_path: 'src/a.ts' }),
      done(3, 'c2', { files: [fileOf('/work/a/src/a.ts', 'write')] }),
      verdict(4, 'npm test', 2),
      verdict(5, 'npm test', 0),
    ];
    await expect(binding(events, ['src/a.ts'])).resolves.toContainEqual({ kind: 'check', runId: 'r1', conditionId: 'condition:npm test', seq: 5, command: 'npm test', exitCode: 0 });
  });

  it('records a failing latest verdict with the exit code the runtime recorded', async () => {
    const events = [call(1, 'c1', 'Write', { file_path: 'src/a.ts' }), done(2, 'c1', { files: [fileOf('/work/a/src/a.ts', 'write')] }), verdict(3, 'npm test', 2)];
    await expect(binding(events, ['src/a.ts'])).resolves.toContainEqual({ kind: 'check', runId: 'r1', conditionId: 'condition:npm test', seq: 3, command: 'npm test', exitCode: 2 });
  });

  it('never takes a command the model ran itself as a check, even one equal to a condition that exited 0', async () => {
    const events = [...READ_A, call(3, 'c2', 'Bash', { command: 'npm test' }), done(4, 'c2', { exitCode: 0 })];
    expect((await binding(events, ['src/a.ts'])).some((entry) => entry.kind === 'check')).toBe(false);
  });

  it('adds no check for a verdict without an exit code, and never reads one out of the output text', async () => {
    const events = [...READ_A, verdict(3, 'npm test', undefined, 'broken\n[exit code 0]')];
    expect((await binding(events, ['src/a.ts'])).map((entry) => entry.kind)).toEqual(['file', 'commit']);
  });

  it('adds no check when the only verdict came before the last write to the bound path', async () => {
    const events = [verdict(1, 'npm test', 0), call(2, 'c2', 'Write', { file_path: 'src/a.ts' }), done(3, 'c2', { files: [fileOf('/work/a/src/a.ts', 'write')] })];
    expect((await binding(events, ['src/a.ts'])).map((entry) => entry.kind)).toEqual(['file', 'commit']);
  });

  it('adds no commit in an untrusted folder, nor when there is no HEAD', async () => {
    await expect(binding(READ_A, ['src/a.ts'], { trusted: false })).resolves.toEqual([{ kind: 'file', project: PROJECT, path: 'src/a.ts', sha256: HASH }]);
    await expect(binding(READ_A, ['src/a.ts'], { head: undefined })).resolves.toEqual([{ kind: 'file', project: PROJECT, path: 'src/a.ts', sha256: HASH }]);
  });
});

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const tempProject = (): { root: string; project: string } => {
  const root = createTempDir();
  tempRoots.push(root);
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  return { root, project };
};

const portsFor = (trusted: boolean, exitCode: number | null, project = PROJECT, signal: AbortSignal = new AbortController().signal) => {
  const commands: EvidenceCommand[] = [];
  const signals: AbortSignal[] = [];
  const ports = createEvidencePorts({
    project,
    trusted,
    signal,
    run: async (command, given) => {
      commands.push(command);
      signals.push(given);
      return { exitCode };
    },
  });
  return { ports, commands, signals };
};

describe('production isAncestor', () => {
  it('runs the fixed argv with the fixed environment, in the project', async () => {
    const { ports, commands } = portsFor(true, 0);
    await expect(ports.isAncestor(HEAD)).resolves.toBe(true);
    expect(commands).toEqual([
      {
        argv: ['git', 'merge-base', '--is-ancestor', HEAD, 'HEAD'],
        cwd: PROJECT,
        env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
        network: 'deny',
      },
    ]);
  });

  it('maps exit 1 to false and anything else to unknown', async () => {
    await expect(portsFor(true, 1).ports.isAncestor(HEAD)).resolves.toBe(false);
    await expect(portsFor(true, 128).ports.isAncestor(HEAD)).resolves.toBeUndefined();
    await expect(portsFor(true, null).ports.isAncestor(HEAD)).resolves.toBeUndefined();
  });

  it('runs nothing in an untrusted folder', async () => {
    const { ports, commands } = portsFor(false, 0);
    await expect(ports.isAncestor(HEAD)).resolves.toBeUndefined();
    expect(commands).toEqual([]);
  });

  it('refuses a recorded sha that is not a hash, so it can never become an option', async () => {
    const { ports, commands } = portsFor(true, 0);
    await expect(ports.isAncestor('--upload-pack=touch')).resolves.toBeUndefined();
    expect(commands).toEqual([]);
  });

  it('starts one process per distinct sha in one read, however many memories carry it', async () => {
    const other = 'f'.repeat(40);
    const { ports, commands } = portsFor(true, 0);
    const answers = await Promise.all([ports.isAncestor(HEAD), ports.isAncestor(HEAD), ports.isAncestor(other), ports.isAncestor(HEAD), ports.isAncestor(other)]);
    expect(answers).toEqual([true, true, true, true, true]);
    expect(commands.map((command) => command.argv[3])).toEqual([HEAD, other]);
  });

  it('asks again in the next read, because the history may have moved', async () => {
    const first = portsFor(true, 0);
    const second = portsFor(true, 1);
    await first.ports.isAncestor(HEAD);
    await expect(second.ports.isAncestor(HEAD)).resolves.toBe(false);
    expect(second.commands).toHaveLength(1);
  });

  it('hands the caller signal to the process, and starts nothing once it has aborted', async () => {
    const live = new AbortController();
    const { ports, signals } = portsFor(true, 0, PROJECT, live.signal);
    await ports.isAncestor(HEAD);
    expect(signals).toEqual([live.signal]);
    const aborted = new AbortController();
    aborted.abort();
    const stopped = portsFor(true, 0, PROJECT, aborted.signal);
    await expect(stopped.ports.isAncestor(HEAD)).resolves.toBeUndefined();
    expect(stopped.commands).toEqual([]);
  });
});

describe('production hashFile', () => {
  it('gives the sha256 of a file', async () => {
    const { project } = tempProject();
    fs.writeFileSync(path.join(project, 'a.txt'), 'abc');
    const { ports } = portsFor(true, 0, project);
    await expect(ports.hashFile(path.join(project, 'a.txt'))).resolves.toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('gives undefined for a missing file', async () => {
    const { project } = tempProject();
    await expect(portsFor(true, 0, project).ports.hashFile(path.join(project, 'absent'))).resolves.toBeUndefined();
  });

  it('does not follow a symlink out of the project, and says so instead of calling the file missing', async () => {
    const { root, project } = tempProject();
    fs.writeFileSync(path.join(root, 'secret'), 'abc');
    fs.symlinkSync(path.join(root, 'secret'), path.join(project, 'link'));
    await expect(portsFor(true, 0, project).ports.hashFile(path.join(project, 'link'))).rejects.toBeInstanceOf(EvidenceOutsideRootError);
  });

  it('gives undefined for a path that is no longer a regular file, so the file counts as gone', async () => {
    const { project } = tempProject();
    fs.mkdirSync(path.join(project, 'dir'));
    await expect(portsFor(true, 0, project).ports.hashFile(path.join(project, 'dir'))).resolves.toBeUndefined();
  });

  it.skipIf(process.getuid?.() === 0)('says a file that cannot be read could not be checked, instead of failing the read', async () => {
    const { project } = tempProject();
    const target = path.join(project, 'locked.txt');
    fs.writeFileSync(target, 'abc');
    fs.chmodSync(target, 0o000);
    await expect(portsFor(true, 0, project).ports.hashFile(target)).rejects.toBeInstanceOf(EvidenceUnreadableError);
  });

  it('does not hang on a FIFO: it is not a regular file and counts as gone', async () => {
    const { project } = tempProject();
    const fifo = path.join(project, 'pipe');
    execFileSync('mkfifo', [fifo]);
    await expect(portsFor(true, 0, project).ports.hashFile(fifo)).resolves.toBeUndefined();
  });

  it('hashes a symlink that stays inside the project', async () => {
    const { project } = tempProject();
    fs.writeFileSync(path.join(project, 'a.txt'), 'abc');
    fs.symlinkSync(path.join(project, 'a.txt'), path.join(project, 'inside'));
    await expect(portsFor(true, 0, project).ports.hashFile(path.join(project, 'inside'))).resolves.toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('production git head', () => {
  const headOf = (trusted: boolean, result: { exitCode: number | null; stdout?: string }, signal: AbortSignal = new AbortController().signal) => {
    const commands: EvidenceCommand[] = [];
    const head = readGitHead({
      project: PROJECT,
      trusted,
      signal,
      run: async (command) => {
        commands.push(command);
        return result;
      },
    });
    return { head, commands };
  };

  it('starts nothing once the caller signal has aborted', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const stopped = headOf(true, { exitCode: 0, stdout: HEAD }, aborted.signal);
    await expect(stopped.head).resolves.toBeUndefined();
    expect(stopped.commands).toEqual([]);
  });

  it('runs the fixed argv with the fixed environment and reads the commit id', async () => {
    const { head, commands } = headOf(true, { exitCode: 0, stdout: `${HEAD}\n` });
    await expect(head).resolves.toBe(HEAD);
    expect(commands).toEqual([
      { argv: ['git', 'rev-parse', 'HEAD'], cwd: PROJECT, env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }, network: 'deny' },
    ]);
  });

  it('gives nothing when git fails or prints something that is not a commit id, and runs nothing in an untrusted folder', async () => {
    await expect(headOf(true, { exitCode: 128, stdout: '' }).head).resolves.toBeUndefined();
    await expect(headOf(true, { exitCode: 0, stdout: '--upload-pack=touch\n' }).head).resolves.toBeUndefined();
    const untrusted = headOf(false, { exitCode: 0, stdout: HEAD });
    await expect(untrusted.head).resolves.toBeUndefined();
    expect(untrusted.commands).toEqual([]);
  });
});
