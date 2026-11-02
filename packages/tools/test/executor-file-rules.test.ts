import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HOST_RULE_ENFORCEMENT, resolveCanonicalPath } from '@momonga/foundation';
import type { FileRuleSet, PathResolution } from '@momonga/foundation';
import { computeFileRules, parseRule } from '@momonga/policy';
import type { PermissionRule, RuleEffect } from '@momonga/policy';
import type { Sandbox, SandboxCommand, SandboxPolicy, SandboxedProcess } from '@momonga/sandbox';
import type { CallOutcome } from '@momonga/tools';
import { createReadAccessMatcher } from '../src/read-access.ts';
import { JS_BACKEND_PATH, RG_PATH, makeBuiltins, resultOf } from './builtins/fixtures.ts';
import type { Builtins } from './builtins/fixtures.ts';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { minimalPolicyFor } from './helpers.ts';

type Recordings = {
  files_with_matches: string;
  count: string;
  content: string;
  relative: string;
  newline_files_with_matches: string;
  newline_count: string;
  newline_content: string;
};

const RECORDINGS: Recordings = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'grep-null-records.json'), 'utf8'),
) as Recordings;

const SOURCE = 'user-settings';

const ruleOf = (tools: Builtins, effect: RuleEffect, text: string): PermissionRule =>
  parseRule(text, { effect, origin: 'user', source: SOURCE, settingsRoot: tools.layout.project, home: tools.layout.home, cwd: tools.layout.project });

type Extra = { sandbox?: Sandbox; env?: Record<string, string>; mode?: 'default' | 'acceptEdits' };

const withFileRules = (tools: Builtins, rules: PermissionRule[], fileRules: FileRuleSet, extra: Extra = {}) => {
  const sandboxPolicy = { ...tools.sandboxPolicy, fileRules } as SandboxPolicy;
  return { rules, sandboxPolicy, tmpDir: tools.tmpDir, roots: [tools.layout.project], ...extra };
};

const withRules = (tools: Builtins, rules: PermissionRule[], extra: Extra = {}) =>
  withFileRules(tools, rules, computeFileRules(rules, [tools.layout.project], tools.tmpDir, HOST_RULE_ENFORCEMENT), extra);

const failedWith = (outcome: CallOutcome | undefined): string => {
  expect(outcome).toMatchObject({ kind: 'result', result: { status: 'failed' } });
  return (outcome as { result: { output: string } }).result.output;
};

const blockedMessage = (target: string, ruleText: string): string => `Permission denied: ${target} is blocked by ${ruleText} (user: ${SOURCE})`;

const stream = (text: string): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    if (text !== '') yield Buffer.from(text);
  },
});

type Spawned = { command: SandboxCommand; policy: SandboxPolicy };

const recordingSandbox = (kind: Sandbox['kind'], stdout: (command: SandboxCommand) => string): { sandbox: Sandbox; spawned: Spawned[] } => {
  const spawned: Spawned[] = [];
  const sandbox: Sandbox = {
    kind,
    spawn: (command, policy): SandboxedProcess => {
      spawned.push({ command, policy });
      const text = stdout(command);
      return { pid: 0, pgid: 0, stdout: stream(text), stderr: stream(''), exited: Promise.resolve({ code: text === '' ? 1 : 0, signal: null }) };
    },
  };
  return { sandbox, spawned };
};

const recorded = (text: string, project: string): string => text.split('{{PROJECT}}').join(project);

const grepFixture = async () => {
  const tools = await makeBuiltins();
  const project = path.join(tools.layout.project, 'proj');
  tools.write(path.join('proj', '.env'), 'TOKEN=secret-one\nplain\n');
  tools.write(path.join('proj', 'notes.txt'), 'before\nsecret in notes\nafter\n');
  tools.write(path.join('proj', 'sub', '.env'), 'x\nsecret sub\n');
  return { tools, project };
};

describe('executor guards read the user file rules', () => {
  it('fails a Read of a denied .env naming the rule and its file', async () => {
    const tools = await makeBuiltins();
    const target = tools.write('.env', 'SECRET');
    const outcome = await tools.run('Read', { file_path: target }, withRules(tools, [ruleOf(tools, 'deny', 'Read(.env)')]));
    expect(failedWith(outcome)).toBe(blockedMessage(target, 'Read(.env)'));
  });

  it('blocks a Grep whose path is a read-denied file', async () => {
    const tools = await makeBuiltins();
    const target = tools.write('.env', 'SECRET');
    const { sandbox, spawned } = recordingSandbox('seatbelt', () => '');
    const outcome = await tools.run('Grep', { pattern: 'SECRET', path: target }, withRules(tools, [ruleOf(tools, 'deny', 'Read(.env)')], { sandbox, env: { PATH: RG_PATH, LANG: 'C' } }));
    expect(failedWith(outcome)).toBe(blockedMessage(target, 'Read(.env)'));
    expect(spawned).toEqual([]);
  });

  it('blocks a Glob whose path is a read-denied directory', async () => {
    const tools = await makeBuiltins();
    tools.write(path.join('secrets', 'k'), 'KEY');
    const target = path.join(tools.layout.project, 'secrets');
    const outcome = await tools.run('Glob', { pattern: '**/*', path: target }, withRules(tools, [ruleOf(tools, 'deny', 'Read(secrets/**)')]));
    expect(failedWith(outcome)).toBe(blockedMessage(target, 'Read(secrets/**)'));
  });

  it('omits a denied file from a Glob over a directory that contains it', async () => {
    const tools = await makeBuiltins();
    tools.write('.env', 'SECRET');
    const visible = tools.write('notes.txt', 'n');
    const outcome = await tools.run('Glob', { pattern: '**/*', path: tools.layout.project }, withRules(tools, [ruleOf(tools, 'deny', 'Read(.env)')]));
    const output = resultOf(outcome).output;
    expect(output.split('\n')).toContain(visible);
    expect(output).not.toContain('.env');
  });

  it('omits a denied file from a JavaScript Grep over a directory', async () => {
    const tools = await makeBuiltins();
    tools.write('.env', 'secret');
    const visible = tools.write('notes.txt', 'secret');
    const outcome = await tools.run('Grep', { pattern: 'secret', path: tools.layout.project }, withRules(tools, [ruleOf(tools, 'deny', 'Read(.env)')], { env: { PATH: JS_BACKEND_PATH, LANG: 'C' } }));
    expect(resultOf(outcome).output).toBe(visible);
  });

  it('hands ripgrep a policy that carries fileRules and drops the denied records', async () => {
    const { tools, project } = await grepFixture();
    const { sandbox, spawned } = recordingSandbox('seatbelt', () => recorded(RECORDINGS.files_with_matches, project));
    const options = withRules(tools, [ruleOf(tools, 'deny', 'Read(.env)')], { sandbox, env: { PATH: RG_PATH, LANG: 'C' } });
    const outcome = await tools.run('Grep', { pattern: 'secret', path: project }, options);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.command.argv).toContain('--null');
    expect((spawned[0]?.policy as SandboxPolicy & { fileRules?: unknown }).fileRules).toBe((options.sandboxPolicy as SandboxPolicy & { fileRules: unknown }).fileRules);
    expect(resultOf(outcome).output).toBe(path.join(project, 'notes.txt'));
  });

  it.each([
    ['files_with_matches', (project: string) => path.join(project, 'notes.txt')],
    ['count', (project: string) => `${path.join(project, 'notes.txt')}:1`],
    ['content', (project: string) => [`${project}/notes.txt-1-before`, `${project}/notes.txt:2:secret in notes`, `${project}/notes.txt-3-after`].join('\n')],
  ] as const)('drops every record of a denied file in %s mode under a sandbox of kind none', async (mode, expected) => {
    const { tools, project } = await grepFixture();
    const { sandbox } = recordingSandbox('none', () => recorded(RECORDINGS[mode], project));
    const args = { pattern: 'secret', path: project, output_mode: mode, ...(mode === 'content' ? { '-C': 1 } : {}) };
    const outcome = await tools.run('Grep', args, withRules(tools, [ruleOf(tools, 'deny', 'Read(.env)')], { sandbox, env: { PATH: RG_PATH, LANG: 'C' } }));
    const output = resultOf(outcome).output;
    expect(output).not.toContain('.env');
    expect(output).not.toContain('\u0000');
    expect(output).toBe(expected(project));
  });

  it('resolves a relative record path against the ripgrep spawn cwd', async () => {
    const { tools, project } = await grepFixture();
    const { sandbox, spawned } = recordingSandbox('none', () => RECORDINGS.relative);
    const outcome = await tools.run(
      'Grep',
      { pattern: 'secret', path: project, output_mode: 'content' },
      withRules(tools, [ruleOf(tools, 'deny', 'Read(.env)')], { sandbox, env: { PATH: RG_PATH, LANG: 'C' } }),
    );
    expect(spawned[0]?.command.cwd).toBe(project);
    expect(resultOf(outcome).output).toBe('No matches found');
  });

  it('blocks a Read through a symlink below the anchor by the requested form', async () => {
    const tools = await makeBuiltins();
    const shared = path.join(tools.layout.outside, 'shared');
    fs.mkdirSync(shared);
    fs.writeFileSync(path.join(shared, '.env'), 'SHARED');
    fs.symlinkSync(shared, path.join(tools.layout.project, 'cfg'));
    const target = path.join(tools.layout.project, 'cfg', '.env');
    const outcome = await tools.run('Read', { file_path: target }, withRules(tools, [ruleOf(tools, 'deny', 'Read(.env)')]));
    expect(failedWith(outcome)).toBe(blockedMessage(target, 'Read(.env)'));
  });

  it('blocks a Write matched by a write deny glob and exempts the session tmp dir', async () => {
    const tools = await makeBuiltins();
    const rules = [ruleOf(tools, 'deny', 'Write(*.pem)')];
    const target = path.join(tools.layout.project, 'k.pem');
    const blocked = await tools.run('Write', { file_path: target, content: 'x' }, withRules(tools, rules, { mode: 'acceptEdits' }));
    expect(failedWith(blocked)).toBe(blockedMessage(target, 'Write(*.pem)'));
    expect(fs.existsSync(target)).toBe(false);
    const scratch = path.join(tools.tmpDir, 'k.pem');
    const allowed = await tools.run('Write', { file_path: scratch, content: 'x' }, withRules(tools, rules, { mode: 'acceptEdits' }));
    expect(resultOf(allowed).status).toBe('completed');
    expect(fs.readFileSync(scratch, 'utf8')).toBe('x');
  });

  it('blocks a project symlink named like a denied path that points outside', async () => {
    const tools = await makeBuiltins();
    const outside = path.join(tools.layout.outside, 'plain.txt');
    fs.writeFileSync(outside, 'plain');
    const target = path.join(tools.layout.project, '.env');
    fs.symlinkSync(outside, target);
    const outcome = await tools.run('Read', { file_path: target }, withRules(tools, [ruleOf(tools, 'deny', 'Read(.env)')]));
    expect(failedWith(outcome)).toBe(blockedMessage(target, 'Read(.env)'));
  });

  it('blocks a path through a symlinked directory at the real location', async () => {
    const tools = await makeBuiltins();
    const secret = path.join(tools.layout.outside, 'secret');
    fs.mkdirSync(secret);
    fs.writeFileSync(path.join(secret, 'k'), 'KEY');
    fs.symlinkSync(secret, path.join(tools.layout.project, 'linkdir'));
    const target = path.join(tools.layout.project, 'linkdir', 'k');
    const ruleText = `Read(/${secret}/**)`;
    const outcome = await tools.run('Read', { file_path: target }, withRules(tools, [ruleOf(tools, 'deny', ruleText)]));
    expect(failedWith(outcome)).toBe(blockedMessage(target, ruleText));
  });
});

const newlineFixture = async () => {
  const tools = await makeBuiltins();
  const project = path.join(tools.layout.project, 'proj');
  const notes = tools.write(path.join('proj', 'notes.txt'), 'SECRET-VALUE in notes\n');
  const odd = tools.write(path.join('proj', 'sub', 'a\nb.txt'), 'before\nSECRET-VALUE\n');
  fs.utimesSync(notes, 2_000_000, 2_000_000);
  fs.utimesSync(odd, 1_000_000, 1_000_000);
  return { tools, project, notes, odd };
};

const grepRecorded = async (tools: Builtins, stdout: string, rules: PermissionRule[], args: Record<string, unknown>) => {
  const { sandbox } = recordingSandbox('none', () => stdout);
  return tools.run('Grep', { pattern: 'SECRET', ...args }, withRules(tools, rules, { sandbox, env: { PATH: RG_PATH, LANG: 'C' } }));
};

describe('Grep parses each --null record path up to its NUL', () => {
  it.each([
    ['files_with_matches', 'newline_files_with_matches', {}],
    ['count', 'newline_count', {}],
    ['content', 'newline_content', { '-B': 1 }],
  ] as const)('drops a Read-denied file whose name holds a newline in %s mode', async (mode, recording, extra) => {
    const { tools, project, notes } = await newlineFixture();
    const expected = { files_with_matches: notes, count: `${notes}:1`, content: `${notes}:1:SECRET-VALUE in notes` }[mode];
    const outcome = await grepRecorded(tools, recorded(RECORDINGS[recording], project), [ruleOf(tools, 'deny', 'Read(proj/sub/**)')], { path: project, output_mode: mode, ...extra });
    const output = resultOf(outcome).output;
    expect(output).toBe(expected);
    expect(output).not.toContain('SECRET-VALUE\n');
    expect(output).not.toContain('b.txt');
  });

  it.each([
    ['files_with_matches', 'newline_files_with_matches', {}],
    ['count', 'newline_count', {}],
    ['content', 'newline_content', { '-B': 1 }],
  ] as const)('keeps a newline name as one record without a deny in %s mode', async (mode, recording, extra) => {
    const { tools, project, notes, odd } = await newlineFixture();
    const expected = {
      files_with_matches: [notes, odd].join('\n'),
      count: [`${notes}:1`, `${odd}:1`].join('\n'),
      content: [`${notes}:1:SECRET-VALUE in notes`, '--', `${odd}-1-before`, `${odd}:2:SECRET-VALUE`].join('\n'),
    }[mode];
    const outcome = await grepRecorded(tools, recorded(RECORDINGS[recording], project), [], { path: project, output_mode: mode, ...extra });
    expect(resultOf(outcome)).toMatchObject({ status: 'completed', output: expected });
  });

  it.each([
    ['content', (project: string) => `${project}/notes.txt\u0000garbage\n`],
    ['count', (project: string) => `${project}/notes.txt\n`],
  ] as const)('fails a malformed %s record with a typed tool error that names the record', async (mode, stdout) => {
    const { tools, project } = await newlineFixture();
    const outcome = await grepRecorded(tools, stdout(project), [], { path: project, output_mode: mode });
    const output = failedWith(outcome);
    expect(output).not.toMatch(/^Internal error/);
    expect(output).toContain(`${project}/notes.txt`);
  });
});

const remapping =
  (from: string, to: string) =>
  (absolute: string): PathResolution =>
    absolute === from ? { ok: true, path: to } : resolveCanonicalPath(absolute);

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );

describe('one compilation per batch: every reader uses batch.sandboxPolicy.fileRules', () => {
  const remappedFixture = async (effect: RuleEffect) => {
    const tools = await makeBuiltins();
    const target = tools.write(path.join('real', 'k'), 'KEY');
    const ruleText = `Read(/${path.join(tools.layout.project, 'cfg')}/**)`;
    const rules = [ruleOf(tools, effect, ruleText)];
    const fileRules = computeFileRules(rules, [tools.layout.project], tools.tmpDir, HOST_RULE_ENFORCEMENT, remapping(path.join(tools.layout.project, 'cfg'), path.join(tools.layout.project, 'real')));
    expect(fileRules.fingerprint).toBe(computeFileRules(rules, [tools.layout.project], tools.tmpDir, HOST_RULE_ENFORCEMENT).fingerprint);
    return { tools, target, rules, fileRules, ruleText };
  };

  it('decide reads the carried set, not a second compilation with the same fingerprint', async () => {
    const { tools, target, rules, fileRules } = await remappedFixture('ask');
    const outcome = await tools.run('Read', { file_path: target }, withFileRules(tools, rules, fileRules));
    expect(outcome).toMatchObject({ kind: 'needs_approval', decision: { kind: 'ask', source: 'rule' } });
  });

  it('the guards read the carried set (pin)', async () => {
    const { tools, target, rules, fileRules, ruleText } = await remappedFixture('deny');
    const outcome = await tools.run('Read', { file_path: target }, withFileRules(tools, rules, fileRules));
    expect(failedWith(outcome)).toBe(blockedMessage(target, ruleText));
    const listed = await tools.run('Glob', { pattern: '**/*', path: tools.layout.project }, withFileRules(tools, rules, fileRules));
    expect(resultOf(listed).output).not.toContain(target);
  });

  const loopedFixture = async () => {
    const tools = await makeBuiltins();
    const vault = path.join(tools.layout.outside, 'vault');
    fs.mkdirSync(vault);
    const rules = [ruleOf(tools, 'deny', `Read(/${vault}/**)`)];
    const fileRules = computeFileRules(rules, [tools.layout.project], tools.tmpDir, HOST_RULE_ENFORCEMENT);
    fs.rmdirSync(vault);
    fs.symlinkSync(vault, vault);
    const notes = tools.write('notes.txt', 'NOTES');
    return { tools, rules, fileRules, notes };
  };

  it('never raises a FileRuleError inside runBatch when a rule prefix became unresolvable after the set was built', async () => {
    const { tools, rules, fileRules, notes } = await loopedFixture();
    const outcome = await tools.run('Read', { file_path: notes }, withFileRules(tools, rules, fileRules));
    expect(resultOf(outcome).status).toBe('completed');
  });

  it('checks the fingerprint without touching the filesystem: a stale seatbelt set fails as file_rules_stale even when a prefix cannot be resolved', async () => {
    const { tools, rules, notes } = await loopedFixture();
    const { sandbox, spawned } = recordingSandbox('seatbelt', () => '');
    const stale = computeFileRules([], [tools.layout.project], tools.tmpDir, HOST_RULE_ENFORCEMENT);
    const error = await rejectionOf(tools.run('Read', { file_path: notes }, withFileRules(tools, rules, stale, { sandbox })));
    expect(error).toMatchObject({ name: 'SandboxPolicyError', code: 'file_rules_stale' });
    expect(spawned).toEqual([]);
  });

  it('uses the carried set as given under a sandbox of kind none', async () => {
    const { tools, rules, fileRules } = await remappedFixture('deny');
    const { sandbox, spawned } = recordingSandbox('none', () => '');
    const outcome = await tools.run('Grep', { pattern: 'x', path: tools.layout.project }, withFileRules(tools, rules, fileRules, { sandbox, env: { PATH: RG_PATH, LANG: 'C' } }));
    expect(resultOf(outcome).output).toBe('No matches found');
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.policy.fileRules).toBe(fileRules);
  });

  it('fails a stale set as file_rules_stale under a sandbox of kind none', async () => {
    const tools = await makeBuiltins();
    const rules = [ruleOf(tools, 'deny', 'Read(.env)')];
    const stale = computeFileRules([], [tools.layout.project], tools.tmpDir, HOST_RULE_ENFORCEMENT);
    const { sandbox, spawned } = recordingSandbox('none', () => '');
    const error = await rejectionOf(tools.run('Grep', { pattern: 'x', path: tools.layout.project }, withFileRules(tools, rules, stale, { sandbox, env: { PATH: RG_PATH, LANG: 'C' } })));
    expect(error).toMatchObject({ name: 'SandboxPolicyError', code: 'file_rules_stale' });
    expect(spawned).toEqual([]);
  });

  it('blocks a path subject of a tool other than Read, Grep and Glob by a Read deny', async () => {
    const harness = makeHarness();
    const target = path.join(harness.layout.project, '.env');
    fs.writeFileSync(target, 'SECRET');
    const rules = [
      parseRule('Read(.env)', { effect: 'deny', origin: 'user', source: SOURCE, settingsRoot: harness.layout.project, home: harness.layout.home, cwd: harness.layout.project }),
    ];
    const pathTool = makeTool('PathTool', { subject: () => ({ kind: 'path', tool: 'PathTool', paths: [target], access: 'read' }) });
    const input = harness.input(await toolSetOf(pathTool), [call('c1', 'PathTool')], { rules, mode: 'bypassPermissions', sandboxPolicy: minimalPolicyFor({ layout: harness.layout, rules }) });
    const [outcome] = await harness.executor.runBatch(input);
    expect(failedWith(outcome)).toBe(blockedMessage(target, 'Read(.env)'));
  });
});

describe('Grep(...) and Glob(...) entries apply to their own tool only (pins)', () => {
  it('a Grep deny drops the ripgrep records of a matching file', async () => {
    const { tools, project } = await grepFixture();
    const outcome = await grepRecorded(tools, recorded(RECORDINGS.content, project), [ruleOf(tools, 'deny', 'Grep(proj/sub/**)')], { pattern: 'secret', path: project, output_mode: 'content', '-C': 1 });
    expect(resultOf(outcome).output).toBe(
      [`${project}/.env:1:TOKEN=secret-one`, `${project}/.env-2-plain`, '--', `${project}/notes.txt-1-before`, `${project}/notes.txt:2:secret in notes`, `${project}/notes.txt-3-after`].join('\n'),
    );
  });

  const secretsFixture = async (ruleText: string) => {
    const tools = await makeBuiltins();
    const secret = tools.write(path.join('secrets', 'k'), 'KEY\n');
    const visible = tools.write('notes.txt', 'KEY\n');
    fs.utimesSync(visible, 2_000_000, 2_000_000);
    fs.utimesSync(secret, 1_000_000, 1_000_000);
    return { tools, secret, visible, options: withRules(tools, [ruleOf(tools, 'deny', ruleText)], { env: { PATH: JS_BACKEND_PATH, LANG: 'C' } }) };
  };

  it('a Glob deny hides the file from Glob and leaves Read and Grep alone', async () => {
    const { tools, secret, visible, options } = await secretsFixture('Glob(secrets/**)');
    expect(resultOf(await tools.run('Read', { file_path: secret }, options)).status).toBe('completed');
    expect(resultOf(await tools.run('Glob', { pattern: '**/*', path: tools.layout.project }, options)).output).toBe(visible);
    expect(resultOf(await tools.run('Grep', { pattern: 'KEY', path: tools.layout.project }, options)).output).toBe([visible, secret].join('\n'));
  });

  it('a Grep deny hides the file from Grep and leaves Read and Glob alone', async () => {
    const { tools, secret, visible, options } = await secretsFixture('Grep(secrets/**)');
    expect(resultOf(await tools.run('Read', { file_path: secret }, options)).status).toBe('completed');
    expect(resultOf(await tools.run('Glob', { pattern: '**/*', path: tools.layout.project }, options)).output).toBe([visible, secret].join('\n'));
    expect(resultOf(await tools.run('Grep', { pattern: 'KEY', path: tools.layout.project }, options)).output).toBe(visible);
  });
});

describe('symlinks under user rules (pins)', () => {
  it('blocks a Write through a project symlink named like a write-denied path that points outside', async () => {
    const tools = await makeBuiltins();
    const outside = path.join(tools.layout.outside, 'plain.txt');
    fs.writeFileSync(outside, 'plain');
    const target = path.join(tools.layout.project, '.env');
    fs.symlinkSync(outside, target);
    const outcome = await tools.run('Write', { file_path: target, content: 'x' }, withRules(tools, [ruleOf(tools, 'deny', 'Write(.env)')], { mode: 'acceptEdits' }));
    expect(failedWith(outcome)).toBe(blockedMessage(target, 'Write(.env)'));
    expect(fs.readFileSync(outside, 'utf8')).toBe('plain');
  });

  it('omits from Glob a symlinked file whose own name or target a Read deny covers', async () => {
    const tools = await makeBuiltins();
    const secretDir = path.join(tools.layout.outside, 'secret');
    fs.mkdirSync(secretDir);
    fs.writeFileSync(path.join(secretDir, 'k'), 'KEY');
    fs.writeFileSync(path.join(tools.layout.outside, 'plain.txt'), 'plain');
    fs.writeFileSync(path.join(tools.layout.outside, 'other.txt'), 'other');
    const visible = path.join(tools.layout.project, 'visible-link');
    fs.symlinkSync(path.join(tools.layout.outside, 'plain.txt'), visible);
    fs.symlinkSync(path.join(tools.layout.outside, 'other.txt'), path.join(tools.layout.project, 'x.env'));
    fs.symlinkSync(path.join(secretDir, 'k'), path.join(tools.layout.project, 'k-link'));
    const rules = [ruleOf(tools, 'deny', 'Read(*.env)'), ruleOf(tools, 'deny', `Read(/${secretDir}/**)`)];
    const outcome = await tools.run('Glob', { pattern: '**/*', path: tools.layout.project }, withRules(tools, rules));
    expect(resultOf(outcome).output).toBe(visible);
  });
});

describe('read rules block every path subject (pins)', () => {
  it.each([
    ['Write', (target: string) => ({ file_path: target, content: 'x' })],
    ['Edit', (target: string) => ({ file_path: target, old_string: 'SECRET', new_string: 'x' })],
  ] as const)('blocks %s of a Read-denied file naming the Read rule', async (tool, args) => {
    const tools = await makeBuiltins();
    const target = tools.write('.env', 'SECRET');
    const outcome = await tools.run(tool, args(target), withRules(tools, [ruleOf(tools, 'deny', 'Read(.env)')], { mode: 'acceptEdits' }));
    expect(failedWith(outcome)).toBe(blockedMessage(target, 'Read(.env)'));
    expect(fs.readFileSync(target, 'utf8')).toBe('SECRET');
  });

  it('does not apply a Glob deny to a Write', async () => {
    const tools = await makeBuiltins();
    const target = path.join(tools.layout.project, '.env');
    const outcome = await tools.run('Write', { file_path: target, content: 'x' }, withRules(tools, [ruleOf(tools, 'deny', 'Glob(.env)')], { mode: 'acceptEdits' }));
    expect(resultOf(outcome).status).toBe('completed');
    expect(fs.readFileSync(target, 'utf8')).toBe('x');
  });
});

describe('a user Read deny over owned read allows', () => {
  it('blockedBy refuses a file in an extra readAllowed directory that a user Read deny covers', async () => {
    const tools = await makeBuiltins();
    const shared = path.join(tools.layout.outside, 'shared');
    fs.mkdirSync(shared);
    const secret = path.join(shared, 'f');
    fs.writeFileSync(secret, 'SHARED');
    const ruleText = `Read(/${shared}/**)`;
    const fileRules = computeFileRules([ruleOf(tools, 'deny', ruleText)], [tools.layout.project], tools.tmpDir, HOST_RULE_ENFORCEMENT);
    const matcher = createReadAccessMatcher({ readDenied: [tools.layout.outside], readAllowed: [shared], fileRules });
    expect(matcher.blockedBy(secret, tools.layout.project)).toMatchObject({ ruleText, layer: 'user', source: SOURCE });
  });

  it('leaves the session tmp dir writable and readable under a user Read deny that covers it (pin)', async () => {
    const tools = await makeBuiltins();
    const rules = [ruleOf(tools, 'deny', `Read(/${tools.layout.root}/**)`)];
    const target = path.join(tools.tmpDir, 'scratch.txt');
    expect(resultOf(await tools.run('Write', { file_path: target, content: 'tmp' }, withRules(tools, rules, { mode: 'acceptEdits' }))).status).toBe('completed');
    const read = resultOf(await tools.run('Read', { file_path: target }, withRules(tools, rules)));
    expect(read.status).toBe('completed');
    expect(read.output).toContain('tmp');
  });
});
