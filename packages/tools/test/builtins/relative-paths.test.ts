import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOST_RULE_ENFORCEMENT } from '@momonga/foundation';
import { computeFileRules, parseRule } from '@momonga/policy';
import type { PermissionRule } from '@momonga/policy';
import type { SandboxPolicy } from '@momonga/sandbox';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import type { AnyTool, SubjectContext } from '@momonga/tools';
import { HAS_REAL_SANDBOX, keyFor } from '../helpers.ts';
import { HAS_RG, JS_BACKEND_PATH, RG_PATH, approvalOf, makeBuiltins, resultOf, sha256 } from './fixtures.ts';
import type { Builtins } from './fixtures.ts';

const BASE_TIME = 1_700_000_000;

const stamp = (file: string, secondsAfterBase: number): string => {
  fs.utimesSync(file, BASE_TIME + secondsAfterBase, BASE_TIME + secondsAfterBase);
  return file;
};

const project = (tools: Builtins): string => tools.layout.project;

const moveShellTo = (tools: Builtins, relative: string): string => {
  const directory = path.join(project(tools), relative);
  fs.mkdirSync(directory, { recursive: true });
  tools.session.cwd = directory;
  return directory;
};

const toolNamed = (tools: Builtins, name: string): AnyTool => {
  const tool = tools.toolSet.get(name);
  if (tool === undefined) throw new Error(`${name} is not registered`);
  return tool;
};

const contextAfterCd = (tools: Builtins, shell: string): SubjectContext => ({
  cwd: shell,
  workingDirectory: project(tools),
  home: tools.layout.home,
  roots: [project(tools)],
});

const failedOutput = (outcome: Awaited<ReturnType<Builtins['run']>>): string => {
  const result = resultOf(outcome);
  expect(result.status).toBe('failed');
  return result.output;
};

const withPolicy = (tools: Builtins, change: Partial<SandboxPolicy>): { sandboxPolicy: SandboxPolicy } => ({
  sandboxPolicy: { ...tools.sandboxPolicy, ...change } as SandboxPolicy,
});

const SOURCE = 'user-settings';

const denyRule = (tools: Builtins, text: string): PermissionRule =>
  parseRule(text, { effect: 'deny', origin: 'user', source: SOURCE, settingsRoot: project(tools), home: tools.layout.home, cwd: project(tools) });

const withDenyRule = (tools: Builtins, text: string) => {
  const rules = [denyRule(tools, text)];
  const fileRules = computeFileRules(rules, [project(tools)], tools.tmpDir, HOST_RULE_ENFORCEMENT);
  return { rules, sandboxPolicy: { ...tools.sandboxPolicy, fileRules } as SandboxPolicy, roots: [project(tools)] };
};

const seedPending = (tools: Builtins, tool: 'Edit' | 'Write', prepared: { path: string; preHash: string | null; postHash: string }): void => {
  tools.idempotency.seed(keyFor('run-1', 1, 'c1'), 'PENDING', { tool, runId: 'run-1', prepared });
};

describe('file tool descriptions', () => {
  it.each([
    ['Read', 'file_path'],
    ['Write', 'file_path'],
    ['Edit', 'file_path'],
    ['Glob', 'path'],
    ['Grep', 'path'],
  ])('%s says a relative %s is resolved against the working directory instead of requiring an absolute path', async (name, field) => {
    const tools = await makeBuiltins();
    const tool = toolNamed(tools, name);
    const properties = tool.inputSchema['properties'] as Record<string, { description: string }>;
    const fieldDescription = properties[field]?.description ?? '';
    for (const text of [tool.description, fieldDescription]) {
      expect(text).not.toMatch(/must be (an )?absolute/i);
      expect(text).not.toMatch(/^absolute/i);
    }
    expect(`${tool.description}\n${fieldDescription}`).toMatch(/relative .*resolved against the working directory/i);
  });
});

describe('Read with a relative path', () => {
  it('reads the file under the working directory', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('sub/a.txt', 'nested\n');
    const result = resultOf(await tools.run('Read', { file_path: 'sub/a.txt' }));
    expect(result).toMatchObject({ status: 'completed', output: '     1\tnested' });
    expect(result.files).toEqual([{ path: file, sha256: sha256('nested\n'), access: 'read' }]);
    expect([...tools.session.readLedger.keys()]).toEqual([file]);
  });

  it('still resolves against the working directory after the shell moved into a subdirectory', async () => {
    const tools = await makeBuiltins();
    tools.write('a.txt', 'top\n');
    tools.write('sub/a.txt', 'nested\n');
    moveShellTo(tools, 'sub');
    const result = resultOf(await tools.run('Read', { file_path: 'a.txt' }));
    expect(result).toMatchObject({ status: 'completed', output: '     1\ttop' });
    expect(result.files?.[0]?.path).toBe(path.join(project(tools), 'a.txt'));
  });

  it('keeps reading an absolute path', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('sub/a.txt', 'nested\n');
    moveShellTo(tools, 'sub');
    const result = resultOf(await tools.run('Read', { file_path: file }));
    expect(result).toMatchObject({ status: 'completed', output: '     1\tnested' });
  });

  it('names a missing file relative to the working directory, whether given relative or absolute', async () => {
    const tools = await makeBuiltins();
    moveShellTo(tools, 'sub');
    expect(failedOutput(await tools.run('Read', { file_path: 'sub/missing.txt' }))).toBe('File does not exist: sub/missing.txt');
    expect(failedOutput(await tools.run('Read', { file_path: path.join(project(tools), 'sub', 'missing.txt') }))).toBe('File does not exist: sub/missing.txt');
  });

  it('names a directory relative to the working directory', async () => {
    const tools = await makeBuiltins();
    moveShellTo(tools, 'sub');
    expect(failedOutput(await tools.run('Read', { file_path: path.join(project(tools), 'sub') }))).toBe(
      'sub is a directory, not a file; use Glob to find files or Bash with ls to list it',
    );
  });

  it('names a binary file relative to the working directory', async () => {
    const tools = await makeBuiltins();
    tools.write('bin/blob.dat', Buffer.from([0, 1, 2, 0, 3]));
    expect(failedOutput(await tools.run('Read', { file_path: 'bin/blob.dat' }))).toBe('bin/blob.dat is a binary file (5 bytes) and cannot be read as text');
  });

  it('asks for ../outside exactly as for the same absolute path, before and after a shell cd', async () => {
    const tools = await makeBuiltins();
    const outsideFile = path.join(tools.layout.outside, 'o.txt');
    fs.writeFileSync(outsideFile, 'outside\n');
    const absolute = approvalOf(await tools.run('Read', { file_path: outsideFile }));
    const relative = approvalOf(await tools.run('Read', { file_path: '../outside/o.txt' }));
    moveShellTo(tools, 'outside');
    const afterCd = approvalOf(await tools.run('Read', { file_path: '../outside/o.txt' }));
    expect(relative.subjectDigest).toBe(absolute.subjectDigest);
    expect(afterCd.subjectDigest).toBe(absolute.subjectDigest);
    expect(relative.decision).toEqual(absolute.decision);
    expect(relative.title).toBe(`Read ${outsideFile}`);
    expect(relative.locations).toEqual([{ path: outsideFile }]);
  });

  it('reads ../outside after an approval bound to the resolved path', async () => {
    const tools = await makeBuiltins();
    const outsideFile = path.join(tools.layout.outside, 'o.txt');
    fs.writeFileSync(outsideFile, 'outside\n');
    const result = resultOf(await tools.run('Read', { file_path: '../outside/o.txt' }, {}, 'allow_once'));
    expect(result).toMatchObject({ status: 'completed', output: '     1\toutside' });
    expect(result.files?.[0]?.path).toBe(outsideFile);
  });

  it('denies a relative path under a readDenied directory, naming it relative to the working directory', async () => {
    const tools = await makeBuiltins();
    tools.write('vault/s.txt', 'secret\n');
    moveShellTo(tools, 'sub');
    const result = resultOf(
      await tools.run('Read', { file_path: 'vault/s.txt' }, withPolicy(tools, { readDenied: [...tools.sandboxPolicy.readDenied, path.join(project(tools), 'vault')] })),
    );
    expect(result).toEqual({
      status: 'failed',
      output: 'Permission denied: vault/s.txt is blocked by the sandbox policy',
      denial: { source: 'sandbox', reason: 'vault/s.txt is blocked by the sandbox policy' },
    });
  });

  it('denies ../outside under a readDenied directory, naming it by its absolute path', async () => {
    const tools = await makeBuiltins();
    const outsideFile = path.join(tools.layout.outside, 'o.txt');
    fs.writeFileSync(outsideFile, 'outside\n');
    const result = resultOf(
      await tools.run('Read', { file_path: '../outside/o.txt' }, withPolicy(tools, { readDenied: [...tools.sandboxPolicy.readDenied, tools.layout.outside] }), 'allow_once'),
    );
    expect(result).toEqual({
      status: 'failed',
      output: `Permission denied: ${outsideFile} is blocked by the sandbox policy`,
      denial: { source: 'sandbox', reason: `${outsideFile} is blocked by the sandbox policy` },
    });
  });

  it('names a file blocked by a deny rule relative to the working directory', async () => {
    const tools = await makeBuiltins();
    tools.write('.env', 'SECRET');
    moveShellTo(tools, 'sub');
    const outcome = await tools.run('Read', { file_path: '.env' }, withDenyRule(tools, 'Read(.env)'));
    expect(failedOutput(outcome)).toBe(`Permission denied: .env is blocked by Read(.env) (user: ${SOURCE})`);
  });

  it('shows a symlink inside the working directory that points outside by its canonical absolute path in the title', async () => {
    const tools = await makeBuiltins();
    const outsideFile = path.join(tools.layout.outside, 'secret.txt');
    fs.writeFileSync(outsideFile, 'outside\n');
    const link = path.join(project(tools), 'escape.txt');
    fs.symlinkSync(outsideFile, link);
    const outcome = approvalOf(await tools.run('Read', { file_path: 'escape.txt', offset: 2 }));
    expect(outcome.title).toBe(`Read ${outsideFile}`);
    expect(outcome.locations).toEqual([{ path: link, line: 2 }]);
  });

  it('builds the title from the resolved path in the display form', async () => {
    const tools = await makeBuiltins();
    const read = toolNamed(tools, 'Read');
    const shell = moveShellTo(tools, 'sub');
    const ctx = contextAfterCd(tools, shell);
    expect(read.title({ file_path: path.join(project(tools), 'sub', 'a.txt') }, ctx)).toBe('Read sub/a.txt');
    expect(read.title({ file_path: 'sub/a.txt' }, ctx)).toBe('Read sub/a.txt');
    expect(read.title({ file_path: '../outside/o.txt' }, ctx)).toBe(`Read ${path.join(tools.layout.outside, 'o.txt')}`);
    expect(read.locations?.({ file_path: 'sub/a.txt' }, ctx)).toEqual([{ path: path.join(project(tools), 'sub', 'a.txt') }]);
  });

  it('puts the resolved absolute path into the policy subject even after a shell cd', async () => {
    const tools = await makeBuiltins();
    const shell = moveShellTo(tools, 'sub');
    const subject = toolNamed(tools, 'Read').subject({ file_path: 'a.txt' }, contextAfterCd(tools, shell));
    expect(subject).toEqual({ kind: 'path', tool: 'Read', paths: [path.join(project(tools), 'a.txt')], access: 'read' });
  });
});

describe('Write with a relative path', () => {
  it('creates the file under the working directory after a shell cd and reports it relative', async () => {
    const tools = await makeBuiltins();
    moveShellTo(tools, 'sub');
    const file = path.join(project(tools), 'sub', 'new.txt');
    const result = resultOf(await tools.run('Write', { file_path: 'sub/new.txt', content: 'x' }, { mode: 'acceptEdits' }));
    expect(result).toMatchObject({ status: 'completed', output: 'Created sub/new.txt (1 line)' });
    expect(result.content).toEqual([{ type: 'diff', path: file, oldText: null, newText: 'x' }]);
    expect(result.files).toEqual([{ path: file, sha256: sha256('x'), access: 'write' }]);
    expect(fs.readFileSync(file, 'utf8')).toBe('x');
    expect(fs.existsSync(path.join(project(tools), 'sub', 'sub', 'new.txt'))).toBe(false);
  });

  it('records the resolved absolute path as the prepared state', async () => {
    const tools = await makeBuiltins();
    moveShellTo(tools, 'sub');
    resultOf(await tools.run('Write', { file_path: 'sub/p.txt', content: 'one' }, { mode: 'acceptEdits' }));
    const metas = tools.idempotency.log.flatMap((entry) => (entry.op === 'begin' ? [entry.meta] : []));
    const resolved = path.join(project(tools), 'sub', 'p.txt');
    expect(metas).toEqual([{ tool: 'Write', runId: 'run-1', prepared: { path: resolved, preHash: null, postHash: sha256('one') }, facts: { files: [{ path: resolved, access: 'write' }] } }]);
  });

  it('reports an absolute path inside the working directory relative to it', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('existing.txt', 'old\n');
    tools.markRead(file);
    const result = resultOf(await tools.run('Write', { file_path: file, content: 'a\nb' }, { mode: 'acceptEdits' }));
    expect(result).toMatchObject({ status: 'completed', output: 'Updated existing.txt (2 lines)' });
    expect(result.content).toEqual([{ type: 'diff', path: file, oldText: 'old\n', newText: 'a\nb' }]);
  });

  it('reports a file outside the working directory by its absolute path', async () => {
    const tools = await makeBuiltins();
    const file = path.join(tools.layout.outside, 'w.txt');
    const result = resultOf(await tools.run('Write', { file_path: '../outside/w.txt', content: 'x' }, { mode: 'acceptEdits' }, 'allow_once'));
    expect(result).toMatchObject({ status: 'completed', output: `Created ${file} (1 line)` });
    expect(fs.readFileSync(file, 'utf8')).toBe('x');
  });

  it('names a changed file relative to the working directory', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('sub/c.txt', 'one\n');
    tools.markRead(file);
    fs.writeFileSync(file, 'changed\n');
    expect(failedOutput(await tools.run('Write', { file_path: 'sub/c.txt', content: 'two' }, { mode: 'acceptEdits' }))).toBe(
      'sub/c.txt has changed since it was last read; Read it again before modifying it',
    );
  });

  it('asks with a title and locations built from the resolved path', async () => {
    const tools = await makeBuiltins();
    moveShellTo(tools, 'sub');
    const target = path.join(project(tools), 'sub', 'n.txt');
    const inside = approvalOf(await tools.run('Write', { file_path: target, content: 'x' }));
    expect(inside.title).toBe('Write sub/n.txt');
    expect(inside.locations).toEqual([{ path: target }]);
    const relative = approvalOf(await tools.run('Write', { file_path: 'sub/n.txt', content: 'x' }));
    expect(relative.title).toBe('Write sub/n.txt');
    expect(relative.locations).toEqual([{ path: target }]);
    expect(relative.subjectDigest).toBe(inside.subjectDigest);
    const outside = approvalOf(await tools.run('Write', { file_path: '../outside/n.txt', content: 'x' }));
    expect(outside.title).toBe(`Write ${path.join(tools.layout.outside, 'n.txt')}`);
    expect(outside.locations).toEqual([{ path: path.join(tools.layout.outside, 'n.txt') }]);
  });

  it('names a write-protected relative path relative to the working directory', async () => {
    const tools = await makeBuiltins();
    const guarded = path.join(project(tools), 'guarded');
    fs.mkdirSync(guarded);
    moveShellTo(tools, 'sub');
    const result = resultOf(
      await tools.run('Write', { file_path: 'guarded/x.txt', content: 'x' }, { mode: 'acceptEdits', ...withPolicy(tools, { writeDenied: [...tools.sandboxPolicy.writeDenied, guarded] }) }),
    );
    expect(result).toEqual({
      status: 'failed',
      output: 'Permission denied: guarded/x.txt is write-protected by the sandbox policy',
      denial: { source: 'sandbox', reason: 'guarded/x.txt is write-protected by the sandbox policy' },
    });
  });
});

describe('Edit with a relative path', () => {
  it('edits the file under the working directory after a shell cd and reports it relative', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('sub/a.txt', 'hello\n');
    tools.markRead(file);
    moveShellTo(tools, 'sub');
    const result = resultOf(await tools.run('Edit', { file_path: 'sub/a.txt', old_string: 'hello', new_string: 'bye' }, { mode: 'acceptEdits' }));
    expect(result.status).toBe('completed');
    expect(result.output).toBe('The file sub/a.txt has been updated. Here is the result of running cat -n on a snippet of the edited file:\n     1\tbye');
    expect(result.content).toEqual([{ type: 'diff', path: file, oldText: 'hello\n', newText: 'bye\n' }]);
    expect(result.files).toEqual([{ path: file, sha256: sha256('bye\n'), access: 'write' }]);
    expect(fs.readFileSync(file, 'utf8')).toBe('bye\n');
  });

  it('names the file relative to the working directory when old_string is not found', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('sub/a.txt', 'hello\n');
    tools.markRead(file);
    expect(failedOutput(await tools.run('Edit', { file_path: file, old_string: 'absent', new_string: 'x' }, { mode: 'acceptEdits' }))).toBe(
      'old_string was not found in sub/a.txt. It must match the file exactly, including whitespace and indentation.',
    );
  });

  it('names a missing file relative to the working directory', async () => {
    const tools = await makeBuiltins();
    expect(failedOutput(await tools.run('Edit', { file_path: 'sub/none.txt', old_string: 'a', new_string: 'b' }, { mode: 'acceptEdits' }))).toBe(
      'File does not exist: sub/none.txt',
    );
  });

  it('asks with a title built from the resolved path in the display form', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('sub/a.txt', 'hello\n');
    tools.markRead(file);
    const outcome = approvalOf(await tools.run('Edit', { file_path: file, old_string: 'hello', new_string: 'bye' }));
    expect(outcome.title).toBe('Edit sub/a.txt');
    expect(outcome.locations).toEqual([{ path: file }]);
  });

  it('executes a recovered not_applied call with a relative path on the prepared file even though the shell directory differs', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('sub/a.txt', 'hello\n');
    tools.markRead(file);
    moveShellTo(tools, 'sub');
    seedPending(tools, 'Edit', { path: file, preHash: sha256('hello\n'), postHash: sha256('bye\n') });
    const outcome = await tools.run('Edit', { file_path: 'sub/a.txt', old_string: 'hello', new_string: 'bye' }, { mode: 'acceptEdits' }, undefined, 'c1');
    expect(outcome).toMatchObject({ kind: 'result', reconciled: 'not_applied', result: { status: 'completed' } });
    expect(fs.readFileSync(file, 'utf8')).toBe('bye\n');
  });

  it('reports a recovered already-applied call with its path relative to the working directory', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('sub/a.txt', 'bye\n');
    moveShellTo(tools, 'sub');
    seedPending(tools, 'Edit', { path: file, preHash: sha256('hello\n'), postHash: sha256('bye\n') });
    const outcome = await tools.run('Edit', { file_path: 'sub/a.txt', old_string: 'hello', new_string: 'bye' }, { mode: 'acceptEdits' }, undefined, 'c1');
    expect(outcome).toMatchObject({ kind: 'result', reconciled: 'already_applied', result: { status: 'completed', output: 'Edit to sub/a.txt had already been applied' } });
  });

  it('reports a recovered call in an unknown state with its path relative to the working directory', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('sub/a.txt', 'something else\n');
    moveShellTo(tools, 'sub');
    seedPending(tools, 'Write', { path: file, preHash: sha256('hello\n'), postHash: sha256('bye\n') });
    const outcome = await tools.run('Write', { file_path: 'sub/a.txt', content: 'bye\n' }, { mode: 'acceptEdits' }, undefined, 'c1');
    expect(outcome).toMatchObject({
      kind: 'result',
      reconciled: 'unknown',
      result: { status: 'failed', output: 'sub/a.txt matches neither the state before nor after the interrupted Write; inspect it before retrying.' },
    });
  });

  it('executes a recovered not_applied Write with a relative path on the prepared file even though the shell directory differs', async () => {
    const tools = await makeBuiltins();
    const file = path.join(project(tools), 'sub', 'w.txt');
    moveShellTo(tools, 'sub');
    seedPending(tools, 'Write', { path: file, preHash: null, postHash: sha256('w') });
    const outcome = await tools.run('Write', { file_path: 'sub/w.txt', content: 'w' }, { mode: 'acceptEdits' }, undefined, 'c1');
    expect(outcome).toMatchObject({ kind: 'result', reconciled: 'not_applied', result: { status: 'completed', output: 'Created sub/w.txt (1 line)' } });
    expect(fs.readFileSync(file, 'utf8')).toBe('w');
  });
});

describe('Glob paths', () => {
  const tree = async () => {
    const tools = await makeBuiltins();
    stamp(tools.write('top.ts', 'top\n'), 3);
    stamp(tools.write('sub/x.ts', 'x\n'), 2);
    stamp(tools.write('sub/deeper/y.ts', 'y\n'), 1);
    return tools;
  };

  it('searches the working directory when path is omitted, even after a shell cd', async () => {
    const tools = await tree();
    moveShellTo(tools, 'sub');
    const result = resultOf(await tools.run('Glob', { pattern: '*.ts' }));
    expect(result).toMatchObject({ status: 'completed', output: 'top.ts' });
  });

  it('treats "." exactly like an omitted path', async () => {
    const tools = await tree();
    moveShellTo(tools, 'sub');
    const expected = ['top.ts', 'sub/x.ts', 'sub/deeper/y.ts'].join('\n');
    expect(resultOf(await tools.run('Glob', { pattern: '**/*.ts', path: '.' })).output).toBe(expected);
    expect(resultOf(await tools.run('Glob', { pattern: '**/*.ts' })).output).toBe(expected);
  });

  it('resolves a relative path against the working directory after a shell cd and lists matches relative to it', async () => {
    const tools = await tree();
    moveShellTo(tools, 'sub');
    expect(resultOf(await tools.run('Glob', { pattern: '**/*.ts', path: 'sub' })).output).toBe(['sub/x.ts', 'sub/deeper/y.ts'].join('\n'));
  });

  it('lists matches relative to the working directory for an absolute path inside it', async () => {
    const tools = await tree();
    expect(resultOf(await tools.run('Glob', { pattern: '*.ts', path: path.join(project(tools), 'sub', 'deeper') })).output).toBe('sub/deeper/y.ts');
  });

  it('lists matches outside the working directory by their absolute paths', async () => {
    const tools = await tree();
    const outsideFile = path.join(tools.layout.outside, 'o.ts');
    fs.writeFileSync(outsideFile, 'o\n');
    const result = resultOf(await tools.run('Glob', { pattern: '*.ts', path: '../outside' }, {}, 'allow_once'));
    expect(result).toMatchObject({ status: 'completed', output: outsideFile });
  });

  it('names a missing directory relative to the working directory', async () => {
    const tools = await tree();
    expect(failedOutput(await tools.run('Glob', { pattern: '*', path: 'missing' }))).toBe('Directory does not exist: missing');
  });

  it('names a file given as path relative to the working directory', async () => {
    const tools = await tree();
    expect(failedOutput(await tools.run('Glob', { pattern: '*', path: 'top.ts' }))).toBe('top.ts is not a directory');
  });

  it('asks for ../outside exactly as for the same absolute path and reports the absolute location', async () => {
    const tools = await tree();
    const absolute = approvalOf(await tools.run('Glob', { pattern: '*', path: tools.layout.outside }));
    const relative = approvalOf(await tools.run('Glob', { pattern: '*', path: '../outside' }));
    expect(relative.subjectDigest).toBe(absolute.subjectDigest);
    expect(relative.decision).toEqual(absolute.decision);
    expect(relative.locations).toEqual([{ path: tools.layout.outside }]);
  });

  it('puts the working directory into locations and the subject when path is omitted after a shell cd', async () => {
    const tools = await tree();
    const shell = moveShellTo(tools, 'sub');
    const glob = toolNamed(tools, 'Glob');
    const ctx = contextAfterCd(tools, shell);
    expect(glob.locations?.({ pattern: '*' }, ctx)).toEqual([{ path: project(tools) }]);
    expect(glob.locations?.({ pattern: '*', path: 'sub' }, ctx)).toEqual([{ path: path.join(project(tools), 'sub') }]);
    expect(glob.subject({ pattern: '*' }, ctx)).toEqual({ kind: 'path', tool: 'Glob', paths: [project(tools)], access: 'read' });
  });

  it('denies a relative path under a readDenied directory, naming it relative to the working directory', async () => {
    const tools = await tree();
    tools.write('vault/v.ts', 'v\n');
    moveShellTo(tools, 'sub');
    const result = resultOf(
      await tools.run('Glob', { pattern: '*', path: 'vault' }, withPolicy(tools, { readDenied: [...tools.sandboxPolicy.readDenied, path.join(project(tools), 'vault')] })),
    );
    expect(result).toEqual({
      status: 'failed',
      output: 'Permission denied: vault is blocked by the sandbox policy',
      denial: { source: 'sandbox', reason: 'vault is blocked by the sandbox policy' },
    });
  });
});

const backends: Array<[string, string, boolean, boolean]> = [
  ['ripgrep', RG_PATH, HAS_RG, true],
  ['JS fallback', JS_BACKEND_PATH, true, false],
];

describe.each(backends)('Grep paths (%s backend)', (_name, envPath, available, realSandbox) => {
  const tree = async () => {
    const tools = await makeBuiltins({ realSandbox });
    stamp(tools.write('top.ts', 'alpha top\n'), 3);
    stamp(tools.write('sub/x.ts', 'alpha sub\nbeta\n'), 2);
    stamp(tools.write('sub/deeper/y.ts', 'alpha deep\n'), 1);
    return tools;
  };

  const grep = async (tools: Builtins, args: Record<string, unknown>, approval?: 'allow_once') =>
    resultOf(await tools.run('Grep', args, { env: { PATH: envPath, LANG: 'C' } }, approval));

  describe.runIf(available)('display and resolution', () => {
    it('searches the working directory when path is omitted, even after a shell cd, listing files relative to it', async () => {
      const tools = await tree();
      moveShellTo(tools, 'sub');
      expect((await grep(tools, { pattern: 'alpha' })).output).toBe(['top.ts', 'sub/x.ts', 'sub/deeper/y.ts'].join('\n'));
    });

    it('treats "." exactly like an omitted path', async () => {
      const tools = await tree();
      moveShellTo(tools, 'sub');
      expect((await grep(tools, { pattern: 'alpha', path: '.' })).output).toBe(['top.ts', 'sub/x.ts', 'sub/deeper/y.ts'].join('\n'));
    });

    it('resolves a relative directory against the working directory after a shell cd', async () => {
      const tools = await tree();
      moveShellTo(tools, 'sub');
      expect((await grep(tools, { pattern: 'alpha', path: 'sub' })).output).toBe(['sub/x.ts', 'sub/deeper/y.ts'].join('\n'));
    });

    it('prints content records relative to the working directory for a relative file path', async () => {
      const tools = await tree();
      moveShellTo(tools, 'sub');
      expect((await grep(tools, { pattern: 'alpha', path: 'sub/x.ts', output_mode: 'content' })).output).toBe('sub/x.ts:1:alpha sub');
    });

    it('prints content records relative to the working directory for an absolute directory inside it', async () => {
      const tools = await tree();
      const output = (await grep(tools, { pattern: 'alpha', path: path.join(project(tools), 'sub'), output_mode: 'content', '-n': false })).output;
      expect(output.split('\n').sort()).toEqual(['sub/deeper/y.ts:alpha deep', 'sub/x.ts:alpha sub']);
    });

    it('prints context lines with the relative path', async () => {
      const tools = await tree();
      expect((await grep(tools, { pattern: 'alpha', path: 'sub/x.ts', output_mode: 'content', '-A': 1 })).output).toBe(['sub/x.ts:1:alpha sub', 'sub/x.ts-2-beta'].join('\n'));
    });

    it('prints counts relative to the working directory', async () => {
      const tools = await tree();
      moveShellTo(tools, 'sub');
      expect((await grep(tools, { pattern: 'alpha', path: 'sub', output_mode: 'count' })).output.split('\n').sort()).toEqual(['sub/deeper/y.ts:1', 'sub/x.ts:1']);
    });

    it('prints files_with_matches for an absolute file inside the working directory relative to it', async () => {
      const tools = await tree();
      expect((await grep(tools, { pattern: 'alpha', path: path.join(project(tools), 'top.ts'), output_mode: 'files_with_matches' })).output).toBe('top.ts');
    });

    it('prints records outside the working directory by their absolute paths', async () => {
      const tools = await tree();
      const outsideFile = path.join(tools.layout.outside, 'o.ts');
      fs.writeFileSync(outsideFile, 'alpha out\n');
      expect((await grep(tools, { pattern: 'alpha', path: '../outside', output_mode: 'content' }, 'allow_once')).output).toBe(`${outsideFile}:1:alpha out`);
      expect((await grep(tools, { pattern: 'alpha', path: '../outside' }, 'allow_once')).output).toBe(outsideFile);
      expect((await grep(tools, { pattern: 'alpha', path: '../outside', output_mode: 'count' }, 'allow_once')).output).toBe(`${outsideFile}:1`);
    });

    it('names a missing path relative to the working directory', async () => {
      const tools = await tree();
      expect(await grep(tools, { pattern: 'alpha', path: 'missing' })).toMatchObject({ status: 'failed', output: 'Path does not exist: missing' });
    });
  });
});

describe('Grep policy', () => {
  it('asks for ../outside exactly as for the same absolute path and reports the absolute location', async () => {
    const tools = await makeBuiltins();
    const absolute = approvalOf(await tools.run('Grep', { pattern: 'a', path: tools.layout.outside }));
    const relative = approvalOf(await tools.run('Grep', { pattern: 'a', path: '../outside' }));
    expect(relative.subjectDigest).toBe(absolute.subjectDigest);
    expect(relative.decision).toEqual(absolute.decision);
    expect(relative.locations).toEqual([{ path: tools.layout.outside }]);
  });

  it('puts the working directory into locations and the subject when path is omitted after a shell cd', async () => {
    const tools = await makeBuiltins();
    const shell = moveShellTo(tools, 'sub');
    const grep = toolNamed(tools, 'Grep');
    const ctx = contextAfterCd(tools, shell);
    expect(grep.locations?.({ pattern: 'a' }, ctx)).toEqual([{ path: project(tools) }]);
    expect(grep.subject({ pattern: 'a' }, ctx)).toEqual({ kind: 'path', tool: 'Grep', paths: [project(tools)], access: 'read' });
  });
});

describe('a working directory reached through a symlink', () => {
  it('shows paths relative to it while machine fields carry the resolved path', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('sub/a.txt', 'nested\n');
    const alias = path.join(tools.layout.root, 'alias');
    fs.symlinkSync(project(tools), alias);
    tools.session.cwd = alias;
    tools.session.workingDirectory = alias;
    expect(failedOutput(await tools.run('Read', { file_path: 'sub/missing.txt' }))).toBe('File does not exist: sub/missing.txt');
    expect(resultOf(await tools.run('Glob', { pattern: '**/*.txt' })).output).toBe('sub/a.txt');
    expect(resultOf(await tools.run('Read', { file_path: 'sub/a.txt' })).files?.[0]?.path).toBe(file);
  });
});

describe('Bash locations', () => {
  it('resolves a relative path in the command against the shell directory and keeps an absolute one as written', async () => {
    const tools = await makeBuiltins();
    const shell = moveShellTo(tools, 'sub');
    const bash = toolNamed(tools, 'Bash');
    const ctx = contextAfterCd(tools, shell);
    expect(bash.locations?.({ command: 'cat a.txt' }, ctx)).toEqual([{ path: path.join(project(tools), 'sub', 'a.txt') }]);
    expect(bash.locations?.({ command: '/bin/cat /etc/hosts' }, ctx)).toEqual([{ path: '/etc/hosts' }]);
  });
});

describe.runIf(HAS_REAL_SANDBOX)('a real Bash cd', () => {
  it('moves the shell but not the base of relative file paths', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    tools.write('a.txt', 'top\n');
    tools.write('sub/a.txt', 'nested\n');
    resultOf(await tools.run('Bash', { command: 'cd sub' }, {}, 'allow_once'));
    expect(tools.session.cwd).toBe(path.join(project(tools), 'sub'));
    expect(tools.session.workingDirectory).toBe(project(tools));
    expect(resultOf(await tools.run('Read', { file_path: 'a.txt' })).output).toBe('     1\ttop');
  });
});
