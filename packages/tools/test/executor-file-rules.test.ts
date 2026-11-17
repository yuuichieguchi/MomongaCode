import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, testProbes, testPaths } from '@momonga/testkit';
import { resolveCanonicalPath, ruleEnforcementOf } from '@momonga/foundation';
import type { FileRuleSet, PathResolution } from '@momonga/foundation';
import { computeFileRules, parseRule } from '@momonga/policy';
import type { PermissionRule, RuleEffect } from '@momonga/policy';
import type { Sandbox, SandboxCommand, SandboxPolicy, SandboxedProcess } from '@momonga/sandbox';
import type { CallOutcome } from '@momonga/tools';
import { createReadAccessMatcher } from '../src/read-access.ts';
import { HAS_RG, RG_PATH, makeBuiltins, resultOf } from './builtins/fixtures.ts';
import type { Builtins } from './builtins/fixtures.ts';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import { minimalPolicyFor } from './helpers.ts';
import { syncPaths } from '@momonga/foundation';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const DENIED_FILE_COUNT = 9200;

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

type Extra = { sandbox?: Sandbox; env?: Record<string, string>; mode?: 'manual' | 'acceptEdits' };

const withFileRules = (tools: Builtins, rules: PermissionRule[], fileRules: FileRuleSet, extra: Extra = {}) => {
  const sandboxPolicy = { ...tools.sandboxPolicy, fileRules } as SandboxPolicy;
  return { rules, sandboxPolicy, tmpDir: tools.tmpDir, roots: [tools.layout.project], ...extra };
};

const withRules = async (tools: Builtins, rules: PermissionRule[], extra: Extra = {}) =>
  withFileRules(tools, rules, await computeFileRules(rules, [tools.layout.project], tools.tmpDir, ruleEnforcementOf('none'), testProbes()), extra);

const failedWith = (outcome: CallOutcome | undefined): string => {
  expect(outcome).toMatchObject({ kind: 'result', result: { status: 'failed' } });
  return (outcome as { result: { output: string } }).result.output;
};

const inProject = (tools: Builtins, file: string): string => path.relative(tools.layout.project, file);

const blockedMessage = (target: string, ruleText: string): string => `Permission denied: ${target} is blocked by ${ruleText} (user: ${SOURCE})`;

const stream = (text: string): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    if (text !== '') yield Buffer.from(text);
  },
});

type Spawned = { command: SandboxCommand; policy: SandboxPolicy; config: string[] };

const recordingSandbox = (kind: Sandbox['kind'], stdout: (command: SandboxCommand) => string, stderrText = ''): { sandbox: Sandbox; spawned: Spawned[] } => {
  const spawned: Spawned[] = [];
  const sandbox: Sandbox = {
    kind,
    spawn: (command, policy): SandboxedProcess => {
      if (command.argv[1] === '--version') return { pid: 999_990, pgid: 999_990, rebind: () => undefined, stdout: stream('ripgrep 15.2.0\n'), stderr: stream(''), exited: Promise.resolve({ code: 0, signal: null, stop: 'confirmed' }) };
      const configFile = command.env?.['RIPGREP_CONFIG_PATH'];
      spawned.push({ command, policy, config: configFile === undefined ? [] : fs.readFileSync(configFile, 'utf8').split('\n') });
      const text = stdout(command);
      return { pid: 999_990, pgid: 999_990, rebind: () => undefined, stdout: stream(text), stderr: stream(stderrText), exited: Promise.resolve({ code: text === '' ? 1 : 0, signal: null, stop: 'confirmed' }) };
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
    const outcome = await tools.run('Read', { file_path: target }, await withRules(tools, [ruleOf(tools, 'deny', 'Read(.env)')]));
    expect(failedWith(outcome)).toBe(blockedMessage('.env', 'Read(.env)'));
  });

  it('blocks a Grep whose path is a read-denied file', async () => {
    const tools = await makeBuiltins();
    const target = tools.write('.env', 'SECRET');
    const { sandbox, spawned } = recordingSandbox('seatbelt', () => '');
    const outcome = await tools.run('Grep', { pattern: 'SECRET', path: target }, await withRules(tools, [ruleOf(tools, 'deny', 'Read(.env)')], { sandbox, env: { PATH: RG_PATH, LANG: 'C' } }));
    expect(failedWith(outcome)).toBe(blockedMessage('.env', 'Read(.env)'));
    expect(spawned).toEqual([]);
  });

  it('blocks a Glob whose path is a read-denied directory', async () => {
    const tools = await makeBuiltins();
    tools.write(path.join('secrets', 'k'), 'KEY');
    const target = path.join(tools.layout.project, 'secrets');
    const outcome = await tools.run('Glob', { pattern: '**/*', path: target }, await withRules(tools, [ruleOf(tools, 'deny', 'Read(secrets/**)')]));
    expect(failedWith(outcome)).toBe(blockedMessage('secrets', 'Read(secrets/**)'));
  });

  it('omits a denied file from a Glob over a directory that contains it', async () => {
    const tools = await makeBuiltins();
    tools.write('.env', 'SECRET');
    const visible = tools.write('notes.txt', 'n');
    const outcome = await tools.run('Glob', { pattern: '**/*', path: tools.layout.project }, await withRules(tools, [ruleOf(tools, 'deny', 'Read(.env)')]));
    const output = resultOf(outcome).output;
    expect(output.split('\n')).toContain(inProject(tools, visible));
    expect(output).not.toContain('.env');
  });

  it.runIf(HAS_RG)('omits a denied file from a ripgrep Grep over a directory under the real sandbox', async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    tools.write('.env', 'secret');
    const visible = tools.write('notes.txt', 'secret');
    const outcome = await tools.run('Grep', { pattern: 'secret', path: tools.layout.project }, await withRules(tools, [ruleOf(tools, 'deny', 'Read(.env)')], { env: { PATH: RG_PATH, LANG: 'C' } }));
    const lines = resultOf(outcome).output.split('\n');
    expect(lines).toContain(inProject(tools, visible));
    expect(lines.filter((line) => line.includes('.env'))).toEqual([]);
  });

  it.runIf(HAS_RG)('answers a Grep over a directory with Read(.env) with exactly the visible matches and no unreadable note, under the real sandbox', async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    tools.write('.env', 'secret');
    tools.write(path.join('sub', '.env'), 'secret');
    const visible = tools.write('notes.txt', 'secret');
    const options = await withRules(tools, [ruleOf(tools, 'deny', 'Read(.env)')], { env: { PATH: RG_PATH, LANG: 'C' } });
    const listed = await tools.run('Grep', { pattern: 'secret', path: tools.layout.project }, await options);
    expect(resultOf(listed).output).toBe(inProject(tools, visible));
    const content = await tools.run('Grep', { pattern: 'secret', path: tools.layout.project, output_mode: 'content' }, await options);
    expect(resultOf(content).output).toBe(`${inProject(tools, visible)}:1:secret`);
  });

  it.runIf(HAS_RG)('keeps a file that a ! exception carves out of a deny rule in a directory Grep, and agrees with Read on both, under the real sandbox', async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    const carved = tools.write(path.join('config', 'sample.env'), 'secret');
    const denied = tools.write(path.join('config', 'prod.env'), 'secret');
    const rules = [{ ...ruleOf(tools, 'deny', 'Read(*.env)'), exceptions: ['sample.env'] } as PermissionRule];
    const options = await withRules(tools, rules, { env: { PATH: RG_PATH, LANG: 'C' } });
    expect(resultOf(await tools.run('Read', { file_path: carved }, await options)).status).toBe('completed');
    expect(resultOf(await tools.run('Read', { file_path: denied }, await options)).status).toBe('failed');
    const listed = await tools.run('Grep', { pattern: 'secret', path: tools.layout.project }, await options);
    expect(resultOf(listed).output).toBe(inProject(tools, carved));
  });

  it.runIf(HAS_RG)('searches past a fully denied directory of many files, which the sandbox masks as one directory, and keeps every denied file out, under the real sandbox', async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    const denied = path.join(tools.layout.project, 'many');
    fs.mkdirSync(denied);
    for (let index = 0; index < DENIED_FILE_COUNT; index += 1) fs.writeFileSync(path.join(denied, `secret-${index}.env`), 'secret');
    const visible = tools.write('notes.txt', 'secret');
    const options = await withRules(tools, [ruleOf(tools, 'deny', 'Read(many/*.env)')], { env: { PATH: RG_PATH, LANG: 'C' } });
    const listed = await tools.run('Grep', { pattern: 'secret', path: tools.layout.project }, await options);
    expect(resultOf(listed).output).toBe(inProject(tools, visible));
  });

  it.runIf(HAS_RG)('keeps the exclusion of denied files whose names hold a line break or end in whitespace, and keeps a visible file beside them, under the real sandbox', async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    tools.write('line\nbreak.env', 'secret');
    tools.write('trailing.env ', 'secret');
    tools.write('#hash.env', 'secret');
    const visible = tools.write('line\tbreak.envx', 'secret');
    const options = await withRules(tools, [ruleOf(tools, 'deny', 'Read(*.env)'), ruleOf(tools, 'deny', 'Read(trailing.env*)')], { env: { PATH: RG_PATH, LANG: 'C' } });
    const listed = await tools.run('Grep', { pattern: 'secret', path: tools.layout.project }, await options);
    expect(resultOf(listed).output).toBe(inProject(tools, visible));
  });

  it.runIf(HAS_RG)('lets no glob the model passes bring back a denied file, under the real sandbox', async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    tools.write('.env', 'secret');
    const visible = tools.write('sample.envrc', 'secret');
    const options = await withRules(tools, [ruleOf(tools, 'deny', 'Read(.env)')], { env: { PATH: RG_PATH, LANG: 'C' } });
    const listed = await tools.run('Grep', { pattern: 'secret', path: tools.layout.project, glob: '*.env*' }, await options);
    expect(resultOf(listed).output).toBe(inProject(tools, visible));
  });

  it('hands ripgrep a policy that carries fileRules and drops the denied records', async () => {
    const { tools, project } = await grepFixture();
    const { sandbox, spawned } = recordingSandbox('seatbelt', () => recorded(RECORDINGS.files_with_matches, project));
    const options = await withRules(tools, [ruleOf(tools, 'deny', 'Read(.env)')], { sandbox, env: { PATH: RG_PATH, LANG: 'C' } });
    const outcome = await tools.run('Grep', { pattern: 'secret', path: project }, await options);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.config).toContain('--null');
    expect(spawned[0]?.command.argv).not.toContain('--null');
    expect((spawned[0]?.policy as SandboxPolicy & { fileRules?: unknown }).fileRules).toBe(((await options).sandboxPolicy as SandboxPolicy & { fileRules: unknown }).fileRules);
    expect(resultOf(outcome).output).toBe(inProject(tools, path.join(project, 'notes.txt')));
  });

  it.each([
    ['files_with_matches', (project: string) => path.join(project, 'notes.txt')],
    ['count', (project: string) => `${path.join(project, 'notes.txt')}:1`],
    ['content', (project: string) => [`${project}/notes.txt-1-before`, `${project}/notes.txt:2:secret in notes`, `${project}/notes.txt-3-after`].join('\n')],
  ] as const)('drops every record of a denied file in %s mode under a sandbox of kind none', async (mode, expected) => {
    const { tools, project } = await grepFixture();
    const { sandbox } = recordingSandbox('none', () => recorded(RECORDINGS[mode], project));
    const args = { pattern: 'secret', path: project, output_mode: mode, ...(mode === 'content' ? { '-C': 1 } : {}) };
    const outcome = await tools.run('Grep', args, await withRules(tools, [ruleOf(tools, 'deny', 'Read(.env)')], { sandbox, env: { PATH: RG_PATH, LANG: 'C' } }));
    const output = resultOf(outcome).output;
    expect(output).not.toContain('.env');
    expect(output).not.toContain('\u0000');
    expect(output).toBe(expected(inProject(tools, project)));
  });

  it('resolves a relative record path against the ripgrep spawn cwd', async () => {
    const { tools, project } = await grepFixture();
    const { sandbox, spawned } = recordingSandbox('none', () => RECORDINGS.relative);
    const outcome = await tools.run(
      'Grep',
      { pattern: 'secret', path: project, output_mode: 'content' },
      await withRules(tools, [ruleOf(tools, 'deny', 'Read(.env)')], { sandbox, env: { PATH: RG_PATH, LANG: 'C' } }),
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
    const outcome = await tools.run('Read', { file_path: target }, await withRules(tools, [ruleOf(tools, 'deny', 'Read(.env)')]));
    expect(failedWith(outcome)).toBe(blockedMessage('cfg/.env', 'Read(.env)'));
  });

  it('blocks a Write matched by a write deny glob and exempts the session tmp dir', async () => {
    const tools = await makeBuiltins();
    const rules = [ruleOf(tools, 'deny', 'Write(*.pem)')];
    const target = path.join(tools.layout.project, 'k.pem');
    const blocked = await tools.run('Write', { file_path: target, content: 'x' }, await withRules(tools, rules, { mode: 'acceptEdits' }));
    expect(failedWith(blocked)).toBe(blockedMessage('k.pem', 'Write(*.pem)'));
    expect(fs.existsSync(target)).toBe(false);
    const scratch = path.join(tools.tmpDir, 'k.pem');
    const allowed = await tools.run('Write', { file_path: scratch, content: 'x' }, await withRules(tools, rules, { mode: 'acceptEdits' }));
    expect(resultOf(allowed).status).toBe('completed');
    expect(fs.readFileSync(scratch, 'utf8')).toBe('x');
  });

  it('blocks a project symlink named like a denied path that points outside', async () => {
    const tools = await makeBuiltins();
    const outside = path.join(tools.layout.outside, 'plain.txt');
    fs.writeFileSync(outside, 'plain');
    const target = path.join(tools.layout.project, '.env');
    fs.symlinkSync(outside, target);
    const outcome = await tools.run('Read', { file_path: target }, await withRules(tools, [ruleOf(tools, 'deny', 'Read(.env)')]));
    expect(failedWith(outcome)).toBe(blockedMessage('.env', 'Read(.env)'));
  });

  it('blocks a path through a symlinked directory at the real location', async () => {
    const tools = await makeBuiltins();
    const secret = path.join(tools.layout.outside, 'secret');
    fs.mkdirSync(secret);
    fs.writeFileSync(path.join(secret, 'k'), 'KEY');
    fs.symlinkSync(secret, path.join(tools.layout.project, 'linkdir'));
    const target = path.join(tools.layout.project, 'linkdir', 'k');
    const ruleText = `Read(/${secret}/**)`;
    const outcome = await tools.run('Read', { file_path: target }, await withRules(tools, [ruleOf(tools, 'deny', ruleText)]));
    expect(failedWith(outcome)).toBe(blockedMessage(path.join(secret, 'k'), ruleText));
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
  return tools.run('Grep', { pattern: 'SECRET', ...args }, await withRules(tools, rules, { sandbox, env: { PATH: RG_PATH, LANG: 'C' } }));
};

describe('Grep parses each --null record path up to its NUL', () => {
  it.each([
    ['files_with_matches', 'newline_files_with_matches', {}],
    ['count', 'newline_count', {}],
    ['content', 'newline_content', { '-B': 1 }],
  ] as const)('drops a Read-denied file whose name holds a newline in %s mode', async (mode, recording, extra) => {
    const { tools, project, notes } = await newlineFixture();
    const shownNotes = inProject(tools, notes);
    const expected = { files_with_matches: shownNotes, count: `${shownNotes}:1`, content: `${shownNotes}:1:SECRET-VALUE in notes` }[mode];
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
    const shownNotes = inProject(tools, notes);
    const shownOdd = inProject(tools, odd);
    const expected = {
      files_with_matches: [shownNotes, shownOdd].join('\n'),
      count: [`${shownNotes}:1`, `${shownOdd}:1`].join('\n'),
      content: [`${shownNotes}:1:SECRET-VALUE in notes`, '--', `${shownOdd}-1-before`, `${shownOdd}:2:SECRET-VALUE`].join('\n'),
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
    expect(output).toContain(`${inProject(tools, project)}/notes.txt`);
  });

  it('puts what ripgrep wrote to stderr into the error of a malformed record', async () => {
    const { tools, project } = await newlineFixture();
    const { sandbox } = recordingSandbox('none', (): string => `${project}/notes.txt\u0000garbage\n`, 'rg: unclosed group\n');
    const outcome = await tools.run('Grep', { pattern: 'SECRET', path: project, output_mode: 'count' }, await withRules(tools, [], { sandbox, env: { PATH: RG_PATH, LANG: 'C' } }));
    expect(failedWith(outcome)).toContain('rg: unclosed group');
  });
});

const remapping =
  (from: string, to: string) =>
  async (absolute: string): Promise<PathResolution> =>
    absolute === from ? { ok: true, path: to } : await syncPaths.resolveCanonicalPath(absolute);

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
    const fileRules = await computeFileRules(rules, [tools.layout.project], tools.tmpDir, ruleEnforcementOf('none'), { canonicalise: remapping(path.join(tools.layout.project, 'cfg'), path.join(tools.layout.project, 'real')), volumeProbe: testProbes().volumeProbe });
    expect(fileRules.fingerprint).toBe((await computeFileRules(rules, [tools.layout.project], tools.tmpDir, ruleEnforcementOf('none'), testProbes())).fingerprint);
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
    expect(failedWith(outcome)).toBe(blockedMessage('real/k', ruleText));
    const listed = await tools.run('Glob', { pattern: '**/*', path: tools.layout.project }, withFileRules(tools, rules, fileRules));
    expect(resultOf(listed).output.split('\n')).not.toContain('real/k');
  });

  const loopedFixture = async () => {
    const tools = await makeBuiltins();
    const vault = path.join(tools.layout.outside, 'vault');
    fs.mkdirSync(vault);
    const rules = [ruleOf(tools, 'deny', `Read(/${vault}/**)`)];
    const fileRules = await computeFileRules(rules, [tools.layout.project], tools.tmpDir, ruleEnforcementOf('none'), testProbes());
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
    const stale = await computeFileRules([], [tools.layout.project], tools.tmpDir, ruleEnforcementOf('none'), testProbes());
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
    const stale = await computeFileRules([], [tools.layout.project], tools.tmpDir, ruleEnforcementOf('none'), testProbes());
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
    const pathTool = makeTool('PathTool', { sideEffect: 'read_only', subjectKind: 'path', subject: () => ({ kind: 'path', tool: 'PathTool', paths: [target], access: 'read' }) });
    const input = harness.input(await toolSetOf(pathTool), [call('c1', 'PathTool')], { rules, mode: 'bypassPermissions', sandboxPolicy: await minimalPolicyFor({ layout: harness.layout, rules }) });
    const [outcome] = await harness.executor.runBatch(await input);
    expect(failedWith(outcome)).toBe(blockedMessage('.env', 'Read(.env)'));
  });
});

describe('Grep(...) and Glob(...) entries apply to their own tool only (pins)', () => {
  it('a Grep deny drops the ripgrep records of a matching file', async () => {
    const { tools, project } = await grepFixture();
    const shown = inProject(tools, project);
    const outcome = await grepRecorded(tools, recorded(RECORDINGS.content, project), [ruleOf(tools, 'deny', 'Grep(proj/sub/**)')], { pattern: 'secret', path: project, output_mode: 'content', '-C': 1 });
    expect(resultOf(outcome).output).toBe(
      [`${shown}/.env:1:TOKEN=secret-one`, `${shown}/.env-2-plain`, '--', `${shown}/notes.txt-1-before`, `${shown}/notes.txt:2:secret in notes`, `${shown}/notes.txt-3-after`].join('\n'),
    );
  });

  const secretsFixture = async (ruleText: string) => {
    const tools = await makeBuiltins({ realSandbox: true });
    const secret = tools.write(path.join('secrets', 'k'), 'KEY\n');
    const visible = tools.write('notes.txt', 'KEY\n');
    fs.utimesSync(visible, 2_000_000, 2_000_000);
    fs.utimesSync(secret, 1_000_000, 1_000_000);
    return { tools, secret, visible, options: await withRules(tools, [ruleOf(tools, 'deny', ruleText)], { env: { PATH: RG_PATH, LANG: 'C' } }) };
  };

  it.runIf(HAS_RG)('a Glob deny hides the file from Glob and leaves Read and Grep alone', async () => {
    const { tools, secret, visible, options } = await secretsFixture('Glob(secrets/**)');
    expect(resultOf(await tools.run('Read', { file_path: secret }, await options)).status).toBe('completed');
    expect(resultOf(await tools.run('Glob', { pattern: '**/*', path: tools.layout.project }, await options)).output).toBe(inProject(tools, visible));
    expect(resultOf(await tools.run('Grep', { pattern: 'KEY', path: tools.layout.project }, await options)).output).toBe([visible, secret].map((file) => inProject(tools, file)).join('\n'));
  });

  it.runIf(HAS_RG)('a Grep deny hides the file from Grep and leaves Read and Glob alone', async () => {
    const { tools, secret, visible, options } = await secretsFixture('Grep(secrets/**)');
    expect(resultOf(await tools.run('Read', { file_path: secret }, await options)).status).toBe('completed');
    expect(resultOf(await tools.run('Glob', { pattern: '**/*', path: tools.layout.project }, await options)).output).toBe([visible, secret].map((file) => inProject(tools, file)).join('\n'));
    expect(resultOf(await tools.run('Grep', { pattern: 'KEY', path: tools.layout.project }, await options)).output).toBe(inProject(tools, visible));
  });
});

describe('symlinks under user rules (pins)', () => {
  it('blocks a Write through a project symlink named like a write-denied path that points outside', async () => {
    const tools = await makeBuiltins();
    const outside = path.join(tools.layout.outside, 'plain.txt');
    fs.writeFileSync(outside, 'plain');
    const target = path.join(tools.layout.project, '.env');
    fs.symlinkSync(outside, target);
    const outcome = await tools.run('Write', { file_path: target, content: 'x' }, await withRules(tools, [ruleOf(tools, 'deny', 'Write(.env)')], { mode: 'acceptEdits' }));
    expect(failedWith(outcome)).toBe(blockedMessage('.env', 'Write(.env)'));
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
    const outcome = await tools.run('Glob', { pattern: '**/*', path: tools.layout.project }, await withRules(tools, rules));
    expect(resultOf(outcome).output).toBe('visible-link');
  });
});

describe('read rules block every path subject (pins)', () => {
  it.each([
    ['Write', (target: string) => ({ file_path: target, content: 'x' })],
    ['Edit', (target: string) => ({ file_path: target, old_string: 'SECRET', new_string: 'x' })],
  ] as const)('blocks %s of a Read-denied file naming the Read rule', async (tool, args) => {
    const tools = await makeBuiltins();
    const target = tools.write('.env', 'SECRET');
    const outcome = await tools.run(tool, args(target), await withRules(tools, [ruleOf(tools, 'deny', 'Read(.env)')], { mode: 'acceptEdits' }));
    expect(failedWith(outcome)).toBe(blockedMessage('.env', 'Read(.env)'));
    expect(fs.readFileSync(target, 'utf8')).toBe('SECRET');
  });

  it('does not apply a Glob deny to a Write', async () => {
    const tools = await makeBuiltins();
    const target = path.join(tools.layout.project, '.env');
    const outcome = await tools.run('Write', { file_path: target, content: 'x' }, await withRules(tools, [ruleOf(tools, 'deny', 'Glob(.env)')], { mode: 'acceptEdits' }));
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
    const fileRules = await computeFileRules([ruleOf(tools, 'deny', ruleText)], [tools.layout.project], tools.tmpDir, ruleEnforcementOf('none'), testProbes());
    const matcher = await createReadAccessMatcher({ readDenied: [tools.layout.outside], readAllowed: [shared], fileRules }, testPaths());
    expect(await matcher.blockedBy(secret, tools.layout.project)).toMatchObject({ ruleText, layer: 'user', source: SOURCE });
  });

  it('leaves the session tmp dir writable and readable under a user Read deny that covers it (pin)', async () => {
    const tools = await makeBuiltins();
    const rules = [ruleOf(tools, 'deny', `Read(/${tools.layout.root}/**)`)];
    const target = path.join(tools.tmpDir, 'scratch.txt');
    expect(resultOf(await tools.run('Write', { file_path: target, content: 'tmp' }, await withRules(tools, rules, { mode: 'acceptEdits' }))).status).toBe('completed');
    const read = resultOf(await tools.run('Read', { file_path: target }, await withRules(tools, rules)));
    expect(read.status).toBe('completed');
    expect(read.output).toContain('tmp');
  });
});
