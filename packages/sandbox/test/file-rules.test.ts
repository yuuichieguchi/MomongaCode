import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { volumeIsCaseInsensitive, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import type { FileRuleSet, FileRuleSpec } from '@momonga/foundation';
import { createSeatbeltSandbox } from '@momonga/sandbox';
import type { SandboxPolicy, SandboxedProcess } from '@momonga/sandbox';
import { REAL_PROCESS_TEST_TIMEOUT_MS, killGroupsForCleanup } from '@momonga/testkit';
import { fileRulesOf, fileSpec } from './file-rule-specs.ts';
import type { FileSpecOptions } from './file-rule-specs.ts';
import { makeTempDir, run } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const KILL_GRACE_MS = 300;
const BASE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

const python3 = (): string => {
  for (const directory of (process.env['PATH'] ?? '').split(':')) {
    const candidate = path.join(directory, 'python3');
    if (directory !== '' && fs.existsSync(candidate)) return fs.realpathSync(candidate);
  }
  throw new Error('python3 is required for this test');
};

type Fixture = { base: string; root: string; home: string; outside: string; tmpRoot: string };

describe.runIf(process.platform === 'darwin')('user file rules under real Seatbelt', () => {
  let created: string[] = [];
  let spawned: SandboxedProcess[] = [];

  afterEach(async () => {
    try {
      await killGroupsForCleanup(spawned.map((proc) => proc.pgid));
    } finally {
      for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
      created = [];
      spawned = [];
    }
  });

  const fixture = (): Fixture => {
    const base = fs.realpathSync(makeTempDir());
    created.push(base);
    const fx = { base, root: path.join(base, 'work'), home: path.join(base, 'home'), outside: path.join(base, 'outside'), tmpRoot: path.join(base, 'spawn-tmp') };
    for (const dir of [fx.root, fx.home, fx.outside, fx.tmpRoot]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return fx;
  };

  const file = (target: string, content: string): string => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
  };

  const spec = (fx: Fixture, specifier: string, options: Partial<FileSpecOptions> = {}): FileRuleSpec =>
    fileSpec(specifier, { roots: [fx.root], home: fx.home, ...options });

  type RunOptions = {
    roots?: readonly string[];
    writableRoots?: readonly string[];
    writeDenied?: readonly string[];
    readDenied?: readonly string[];
    readAllowed?: readonly string[];
    tmpDir?: string;
    env?: Record<string, string>;
    cwd?: string;
    tmpRoot?: string;
    args?: readonly string[];
  };

  const sandboxed = async (fx: Fixture, specs: readonly FileRuleSpec[], script: string, options: RunOptions = {}) => {
    const roots = options.roots ?? [fx.root];
    const fileRules: FileRuleSet = fileRulesOf(specs, roots);
    const policy = {
      writableRoots: options.writableRoots ?? [fx.root],
      writeDenied: options.writeDenied ?? [],
      protectedSet: EMPTY_PROTECTED_SET, writeDeniedLiterals: [],
      readDenied: options.readDenied ?? [],
      ...(options.readAllowed === undefined ? {} : { readAllowed: options.readAllowed }),
      network: 'deny',
      fileRules,
    } as SandboxPolicy;
    const sandbox = createSeatbeltSandbox({ tmpRoot: options.tmpRoot ?? fx.tmpRoot, killGraceMs: KILL_GRACE_MS });
    const proc = sandbox.spawn(
      {
        argv: ['/bin/sh', '-c', script, 'sh', ...(options.args ?? [])],
        cwd: options.cwd ?? fx.root,
        env: { PATH: BASE_PATH, ...options.env },
        ...(options.tmpDir === undefined ? {} : { tmpDir: options.tmpDir }),
      },
      policy,
      new AbortController().signal,
    );
    spawned.push(proc);
    return run(proc);
  };

  const readVerdicts = async (fx: Fixture, specs: readonly FileRuleSpec[], names: readonly string[], options: RunOptions = {}) => {
    const result = await sandboxed(fx, specs, 'for f in "$@"; do if cat -- "$f" >/dev/null 2>&1; then echo R; else echo D; fi; done', { ...options, args: names });
    return Object.fromEntries(names.map((name, index) => [name, result.stdout.split('\n')[index]]));
  };

  const content = (target: string): string => fs.readFileSync(target, 'utf8');

  it('W1: Write(.env) holds for /bin/sh -c "$CMD" with the command only in the environment', async () => {
    const fx = fixture();
    const env = file(path.join(fx.root, '.env'), 'SECRET');
    const result = await sandboxed(fx, [spec(fx, '.env', { tool: 'Edit' })], '/bin/sh -c "$CMD"', { env: { CMD: 'echo pwned >> .env' } });
    expect(result.code).not.toBe(0);
    expect(content(env)).toBe('SECRET');
  });

  it('W2: Write(.env) holds for perl -e', async () => {
    const fx = fixture();
    const env = file(path.join(fx.root, '.env'), 'SECRET');
    const result = await sandboxed(fx, [spec(fx, '.env', { tool: 'Edit' })], `/usr/bin/perl -e 'open(F, ">>.env") or die "open: $!"; print F "pwned"; close(F) or die "close: $!"'`);
    expect(result.code).not.toBe(0);
    expect(content(env)).toBe('SECRET');
  });

  it('R1: Read(//<home>/.ssh/**) holds for perl and python3', async () => {
    const fx = fixture();
    const key = file(path.join(fx.home, '.ssh', 'id_test'), 'KEY');
    const specs = [spec(fx, `/${fx.home}/.ssh/**`)];
    const perl = await sandboxed(fx, specs, `/usr/bin/perl -e 'open(F, "<", $ARGV[0]) or die "open: $!"; print <F>' "$1"`, { args: [key] });
    expect(perl.code).not.toBe(0);
    expect(perl.stdout).not.toContain('KEY');
    const python = await sandboxed(fx, specs, `"$1" -I -c 'import sys; print(open(sys.argv[1]).read())' "$2"`, { args: [python3(), key] });
    expect(python.code).not.toBe(0);
    expect(python.stdout).not.toContain('KEY');
  });

  it('W3: a workspace symlink to .env does not open a write path', async () => {
    const fx = fixture();
    const env = file(path.join(fx.root, '.env'), 'SECRET');
    fs.symlinkSync('.env', path.join(fx.root, 'link-env'));
    const result = await sandboxed(fx, [spec(fx, '.env', { tool: 'Edit' })], `/usr/bin/perl -e 'open(F, ">>link-env") or die "open: $!"; print F "pwned"; close(F) or die'`);
    expect(result.code).not.toBe(0);
    expect(content(env)).toBe('SECRET');
  });

  it('R2: a workspace symlink to the denied key does not open a read path', async () => {
    const fx = fixture();
    const key = file(path.join(fx.home, '.ssh', 'id_test'), 'KEY');
    fs.symlinkSync(key, path.join(fx.root, 'link-key'));
    const result = await sandboxed(fx, [spec(fx, `/${fx.home}/.ssh/**`)], 'cat link-key');
    expect(result.stdout).not.toContain('KEY');
  });

  it('a symlink whose own name matches a write deny cannot be written or created through', async () => {
    const fx = fixture();
    const other = file(path.join(fx.root, 'other.txt'), 'orig');
    fs.symlinkSync('other.txt', path.join(fx.root, 'link-name'));
    fs.mkdirSync(path.join(fx.root, 'realdir'));
    fs.symlinkSync('realdir', path.join(fx.root, 'dir-link'));
    const specs = [spec(fx, 'link-name', { tool: 'Edit' }), spec(fx, 'dir-link', { tool: 'Edit' })];
    const write = await sandboxed(fx, specs, 'echo pwned >> link-name');
    expect(write.code).not.toBe(0);
    expect(content(other)).toBe('orig');
    const create = await sandboxed(fx, specs, 'echo pwned > dir-link/new');
    expect(create.code).not.toBe(0);
    expect(fs.existsSync(path.join(fx.root, 'realdir', 'new'))).toBe(false);
  });

  it('Write(*.pem) guards a symlink inside a matched directory', async () => {
    const fx = fixture();
    const target = file(path.join(fx.root, 'target.txt'), 'orig');
    fs.mkdirSync(path.join(fx.root, 'x.pem'));
    fs.symlinkSync(target, path.join(fx.root, 'x.pem', 'link'));
    const result = await sandboxed(fx, [spec(fx, '*.pem', { tool: 'Edit' })], 'echo pwned >> x.pem/link');
    expect(result.code).not.toBe(0);
    expect(content(target)).toBe('orig');
  });

  it('pin: the symlink guard leaves a regular file with a matching name statable', async () => {
    const fx = fixture();
    const target = file(path.join(fx.root, 'target.txt'), 'orig');
    fs.mkdirSync(path.join(fx.root, 'x.pem'));
    fs.symlinkSync(target, path.join(fx.root, 'x.pem', 'link'));
    file(path.join(fx.root, 'y.pem'), 'pem');
    const result = await sandboxed(fx, [spec(fx, '*.pem', { tool: 'Edit' })], '/usr/bin/stat -f %z y.pem');
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('3');
  });

  it('W4: a hardlink to a write-denied file cannot be made', async () => {
    const fx = fixture();
    const env = file(path.join(fx.root, '.env'), 'SECRET');
    const result = await sandboxed(fx, [spec(fx, '.env', { tool: 'Edit' })], 'ln .env hl && echo pwned >> hl');
    expect(result.code).not.toBe(0);
    expect(fs.existsSync(path.join(fx.root, 'hl'))).toBe(false);
    expect(content(env)).toBe('SECRET');
  });

  it('a hardlink to a read-denied workspace file cannot be made', async () => {
    const fx = fixture();
    file(path.join(fx.root, 'secrets', 'key'), 'KEY');
    const result = await sandboxed(fx, [spec(fx, 'secrets/**')], 'ln secrets/key hl; echo "ln=$?"; cat hl');
    expect(result.stdout).toContain('ln=1');
    expect(result.stdout).not.toContain('KEY');
    expect(fs.existsSync(path.join(fx.root, 'hl'))).toBe(false);
  });

  it('W5: renaming onto a write-denied name fails', async () => {
    const fx = fixture();
    const env = file(path.join(fx.root, '.env'), 'SECRET');
    file(path.join(fx.root, 'newfile'), 'NEW');
    const result = await sandboxed(fx, [spec(fx, '.env', { tool: 'Edit' })], `/usr/bin/perl -e 'rename("newfile", ".env") or die "rename: $!"'`);
    expect(result.code).not.toBe(0);
    expect(content(env)).toBe('SECRET');
  });

  it('moving a read-denied directory or file away fails', async () => {
    const fx = fixture();
    const key = file(path.join(fx.root, 'secrets', 'key'), 'KEY');
    const directory = await sandboxed(fx, [spec(fx, 'secrets/**')], 'mv secrets s2; cat s2/key');
    expect(directory.stdout).not.toContain('KEY');
    expect(fs.existsSync(key)).toBe(true);
    const single = await sandboxed(fx, [spec(fx, 'secrets/**')], 'mv secrets/key k2; cat k2');
    expect(single.stdout).not.toContain('KEY');
    expect(fs.existsSync(key)).toBe(true);
  });

  it('renaming an ancestor of an anchored denied subtree fails', async () => {
    const fx = fixture();
    const key = file(path.join(fx.root, 'a', 'secrets', 'key'), 'KEY');
    const result = await sandboxed(fx, [spec(fx, 'a/secrets/**')], 'mv a a2; cat a2/secrets/key');
    expect(result.stdout).not.toContain('KEY');
    expect(fs.existsSync(key)).toBe(true);
  });

  it.runIf(volumeIsCaseInsensitive(process.cwd()))('denies an existing case variant and the creation of a new one', async () => {
    const fx = fixture();
    const upper = file(path.join(fx.root, '.ENV'), 'SECRET');
    const specs = [spec(fx, '.env'), spec(fx, '.env', { tool: 'Edit' }), spec(fx, '*.key', { tool: 'Edit' })];
    const read = await sandboxed(fx, specs, 'cat .ENV');
    expect(read.stdout).not.toContain('SECRET');
    const write = await sandboxed(fx, specs, 'echo pwned >> .ENV');
    expect(write.code).not.toBe(0);
    expect(content(upper)).toBe('SECRET');
    const create = await sandboxed(fx, specs, 'echo x > NEW.KEY');
    expect(create.code).not.toBe(0);
    expect(fs.readdirSync(fx.root)).not.toContain('NEW.KEY');
  });

  it('Write(*.pem) and Read(secrets/*) match nested names, closures and case variants as listed', async () => {
    const fx = fixture();
    file(path.join(fx.root, 'secrets', 'sub', 'key'), 'KEY');
    const specs = [spec(fx, '*.pem', { tool: 'Edit' }), spec(fx, 'secrets/*')];
    const writes = await sandboxed(fx, specs, 'mkdir -p a/b; echo x > a/b/x.pem; echo x > x.pemx; echo x > x.PEM; cat secrets/sub/key');
    expect(fs.existsSync(path.join(fx.root, 'a', 'b', 'x.pem'))).toBe(false);
    expect(fs.existsSync(path.join(fx.root, 'x.pemx'))).toBe(true);
    if (volumeIsCaseInsensitive(fx.root)) expect(fs.readdirSync(fx.root)).not.toContain('x.PEM');
    expect(writes.stdout).not.toContain('KEY');
  });

  it('depth: Read(secrets/**) denies a nested secrets directory and Read(.env) leaves a .env outside the root readable', async () => {
    const fx = fixture();
    file(path.join(fx.root, 'vendor', 'secrets', 'k'), 'KEY');
    file(path.join(fx.outside, '.env'), 'OUT');
    const result = await sandboxed(fx, [spec(fx, 'secrets/**'), spec(fx, '.env')], 'cat vendor/secrets/k; cat ../outside/.env');
    expect(result.stdout).not.toContain('KEY');
    expect(result.stdout).toContain('OUT');
  });

  it('roots: Read(.env) and Write(*.pem) hold inside an additional directory', async () => {
    const fx = fixture();
    const extra = path.join(fx.base, 'extra');
    fs.mkdirSync(extra);
    const env = file(path.join(extra, '.env'), 'SECRET');
    const roots = [fx.root, extra];
    const specs = [spec(fx, '.env', { roots }), spec(fx, '*.pem', { roots, tool: 'Edit' })];
    const read = await sandboxed(fx, specs, `/usr/bin/perl -e 'open(F, "<", $ARGV[0]) or die "open: $!"; print <F>' "$1"`, { roots, writableRoots: roots, args: [env] });
    expect(read.code).not.toBe(0);
    expect(read.stdout).not.toContain('SECRET');
    const write = await sandboxed(fx, specs, `/usr/bin/perl -e 'open(F, ">", $ARGV[0]) or die "open: $!"; print F "x"; close(F) or die'` + ' "$1"', {
      roots,
      writableRoots: roots,
      args: [path.join(extra, 'x.pem')],
    });
    expect(write.code).not.toBe(0);
    expect(fs.existsSync(path.join(extra, 'x.pem'))).toBe(false);
  });

  it('a relative Edit(src/**) allow does not widen writes into an additional directory', async () => {
    const fx = fixture();
    const extra = path.join(fx.base, 'extra');
    fs.mkdirSync(path.join(extra, 'src'), { recursive: true });
    fs.mkdirSync(path.join(fx.root, 'src'));
    const roots = [fx.root, extra];
    const result = await sandboxed(fx, [spec(fx, 'src/**', { roots, tool: 'Edit', effect: 'allow' })], 'echo x > "$1"; echo x > src/inside', { roots, args: [path.join(extra, 'src', 'f')] });
    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(extra, 'src', 'f'))).toBe(false);
    expect(fs.existsSync(path.join(fx.root, 'src', 'inside'))).toBe(true);
  });

  it('?, [!a], [[:digit:]] and []a] are exact on ASCII names and deny non-ASCII names by the superset', async () => {
    const fx = fixture();
    const names = ['axb', 'ab', 'axxb', 'aあb', 'a😀b', 'aéb', 'xby', 'xay', '1z', 'az', 'q]r', 'qar', 'qbr'];
    for (const name of names) file(path.join(fx.root, name), 'C');
    const specs = [spec(fx, 'a?b'), spec(fx, 'x[!a]y'), spec(fx, '[[:digit:]]z'), spec(fx, 'q[]a]r')];
    expect(await readVerdicts(fx, specs, names)).toEqual({
      axb: 'D',
      ab: 'R',
      axxb: 'R',
      'aあb': 'D',
      'a😀b': 'D',
      'aéb': 'D',
      xby: 'D',
      xay: 'R',
      '1z': 'D',
      az: 'R',
      'q]r': 'D',
      qar: 'D',
      qbr: 'R',
    });
  });

  it('negated classes deny decomposed letters whose base is excluded', async () => {
    const fx = fixture();
    const names = ['aéb', 'añb', 'aeb', 'anb'];
    for (const name of names) file(path.join(fx.root, name), 'C');
    expect(await readVerdicts(fx, [spec(fx, 'a[!e]b')], ['aéb', 'aeb'])).toEqual({ 'aéb': 'D', aeb: 'R' });
    expect(await readVerdicts(fx, [spec(fx, 'a[!n]b')], ['añb', 'anb'])).toEqual({ 'añb': 'D', anb: 'R' });
  });

  it('exceptions use the subset form: Read(*.env) with !a?.env keeps aあい.env denied and carves ab.env', async () => {
    const fx = fixture();
    const names = ['aあい.env', 'ab.env'];
    for (const name of names) file(path.join(fx.root, name), 'C');
    expect(await readVerdicts(fx, [spec(fx, '*.env', { exceptions: ['a?.env'] })], names)).toEqual({ 'aあい.env': 'D', 'ab.env': 'R' });
  });

  it('a widening allow uses the subset form: Edit(~/n/note*) allows note and notex but not noté', async () => {
    const fx = fixture();
    const notes = path.join(fx.home, 'n');
    fs.mkdirSync(notes);
    const specs = [spec(fx, '~/n/note*', { tool: 'Edit', effect: 'allow' })];
    await sandboxed(fx, specs, 'echo x > "$1/note"; echo x > "$1/notex"; echo x > "$1/$2"', { args: [notes, 'noté'] });
    expect(fs.existsSync(path.join(notes, 'note'))).toBe(true);
    expect(fs.existsSync(path.join(notes, 'notex'))).toBe(true);
    expect(fs.readdirSync(notes).map((name) => name.normalize('NFC'))).not.toContain('noté');
  });

  it('pin: the kernel enforces resolved locations, so a .env reached through a symlink to a directory outside every root stays readable', async () => {
    const fx = fixture();
    const shared = path.join(fx.base, 'shared');
    file(path.join(shared, '.env'), 'SHARED');
    fs.symlinkSync(shared, path.join(fx.root, 'cfg'));
    const result = await sandboxed(fx, [spec(fx, '.env')], 'cat cfg/.env; echo; cat "$1"', { args: [path.join(shared, '.env')] });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('SHARED\nSHARED');
  });

  it('denies a name with a newline, a non-ASCII directory and an NFD spelling of an NFC rule', async () => {
    const fx = fixture();
    const names = ['x\ny.txt', path.join('日本語', 'k'), 'café.txt', 'other'];
    for (const name of names) file(path.join(fx.root, name), 'C');
    const specs = [spec(fx, '*.txt'), spec(fx, '日本語/**'), spec(fx, 'café.txt')];
    expect(await readVerdicts(fx, specs, names)).toEqual({ 'x\ny.txt': 'D', [path.join('日本語', 'k')]: 'D', 'café.txt': 'D', other: 'R' });
  });

  it('! exceptions carve exactly the named nodes and never reopen another source', async () => {
    const fx = fixture();
    const names = ['sample.env', 'x.env', path.join('dir.env', 'sample.env'), path.join('dir.env', 'other'), path.join('secrets', 'public', 'p')];
    for (const name of names) file(path.join(fx.root, name), 'C');
    const carved = spec(fx, '*.env', { exceptions: ['sample.env'], source: 's1' });
    expect(await readVerdicts(fx, [carved], names.slice(0, 4))).toEqual({
      'sample.env': 'R',
      'x.env': 'D',
      [path.join('dir.env', 'sample.env')]: 'D',
      [path.join('dir.env', 'other')]: 'D',
    });
    expect(await readVerdicts(fx, [carved, spec(fx, 'sample.env', { source: 's2' })], ['sample.env'])).toEqual({ 'sample.env': 'D' });
    expect(await readVerdicts(fx, [spec(fx, 'secrets/**', { exceptions: ['secrets/public/**'] })], [path.join('secrets', 'public', 'p')])).toEqual({
      [path.join('secrets', 'public', 'p')]: 'D',
    });
  });

  it('an anchored Edit allow widens the sandbox from the user layer only and never reopens an owned deny', async () => {
    const fx = fixture();
    const momonga = path.join(fx.home, '.momonga');
    fs.mkdirSync(momonga);
    const user = await sandboxed(fx, [spec(fx, `/${fx.outside}/**`, { tool: 'Edit', effect: 'allow' })], 'echo x > "$1"', { args: [path.join(fx.outside, 'user')] });
    expect(user.code).toBe(0);
    expect(fs.existsSync(path.join(fx.outside, 'user'))).toBe(true);
    const project = await sandboxed(fx, [spec(fx, `/${fx.outside}/**`, { tool: 'Edit', effect: 'allow', layer: 'project' })], 'echo x > "$1"', {
      args: [path.join(fx.outside, 'project')],
    });
    expect(project.code).not.toBe(0);
    expect(fs.existsSync(path.join(fx.outside, 'project'))).toBe(false);
    const owned = await sandboxed(fx, [spec(fx, '~/.momonga/**', { tool: 'Edit', effect: 'allow' })], 'echo x > "$1"', {
      args: [path.join(momonga, 'f')],
      writeDenied: [momonga],
    });
    expect(owned.code).not.toBe(0);
    expect(fs.existsSync(path.join(momonga, 'f'))).toBe(false);
  });

  it('owned allows win over Read(**) and Write(**): TMPDIR and /dev/null stay usable', async () => {
    const fx = fixture();
    const tmpRoot = path.join(fx.root, 'spawn-tmp');
    fs.mkdirSync(tmpRoot);
    const specs = [spec(fx, '**'), spec(fx, '**', { tool: 'Edit' })];
    const result = await sandboxed(fx, specs, 'echo x > "$TMPDIR/f" && cat "$TMPDIR/f" && echo y > /dev/null', { tmpRoot, cwd: '/' });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('x\n');
  });

  const SCRATCH_SCRIPT = 'mkdir "$TMPDIR/d" && echo x > "$TMPDIR/d/f" && cd "$TMPDIR/d" && cat f && cd "$TMPDIR" && /bin/pwd -P';

  it('a Read deny covering the private scratch dir leaves it usable by relative paths and cd', async () => {
    const fx = fixture();
    const result = await sandboxed(fx, [spec(fx, `/${fx.base}/**`)], SCRATCH_SCRIPT, { cwd: '/' });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`^x\\n${fx.tmpRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/sandbox-[^/]+\\n$`));
  });

  it('a Read deny covering the session tmp dir leaves it usable by relative paths and cd', async () => {
    const fx = fixture();
    const sessions = path.join(fx.base, 'sessions');
    const tmpDir = path.join(sessions, 's1');
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const result = await sandboxed(fx, [spec(fx, `/${fx.base}/**`)], SCRATCH_SCRIPT, { cwd: '/', tmpDir, readDenied: [sessions], writeDenied: [sessions], readAllowed: [tmpDir] });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`x\n${tmpDir}\n`);
  });

  it('a user Read deny over an extra readAllowed directory wins in the kernel', async () => {
    const fx = fixture();
    const shared = path.join(fx.outside, 'shared');
    const secret = file(path.join(shared, 'f'), 'SHARED');
    const result = await sandboxed(fx, [spec(fx, `/${shared}/**`)], 'cat -- "$1"', { readDenied: [fx.outside], readAllowed: [shared], args: [secret] });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
  });

  it('pin: a hardlink made before the sandbox started still reaches the denied file', async () => {
    const fx = fixture();
    const env = file(path.join(fx.root, '.env'), 'SECRET');
    fs.linkSync(env, path.join(fx.root, 'hl'));
    const result = await sandboxed(fx, [spec(fx, '.env', { tool: 'Edit' })], 'echo pwned >> hl');
    expect(result.code).toBe(0);
    expect(content(env)).toBe('SECRETpwned\n');
  });
});
