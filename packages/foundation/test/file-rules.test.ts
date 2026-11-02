import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileRuleError, HOST_FLAVOUR, HOST_RULE_ENFORCEMENT, canonicalPath, compileFileRuleSet, fileRuleBlocks, fileRuleFingerprint, resolveCanonicalPath } from '@momonga/foundation';
import type { FileRuleEntry, FileRuleSet, FileRuleSpec, PathResolution } from '@momonga/foundation';

const CWD = '/w';
const HOME = '/h';
const SETTINGS_ROOT = '/s';
const ROOTS = [CWD];

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const makeDir = (): string => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-frules-')));
  tempDirs.push(dir);
  return dir;
};

type SpecOptions = {
  ruleIndex?: number;
  tool?: FileRuleSpec['tool'];
  access?: FileRuleSpec['access'];
  effect?: FileRuleSpec['effect'];
  exceptions?: readonly string[];
  roots?: readonly string[];
  layer?: FileRuleSpec['provenance']['layer'];
  source?: string;
};

const ruleTextOf = (tool: string, specifier: string): string => `${tool}(${specifier})`;

const spec = (specifier: string, options: SpecOptions = {}): FileRuleSpec => {
  const tool = options.tool ?? 'Read';
  const effect = options.effect ?? 'deny';
  return {
    ruleIndex: options.ruleIndex ?? 0,
    tool,
    access: options.access ?? (tool === 'Edit' ? 'write' : 'read'),
    effect,
    specifier,
    exceptions: options.exceptions ?? [],
    context: { roots: options.roots ?? ROOTS, home: HOME, settingsRoot: SETTINGS_ROOT, effect },
    provenance: { ruleText: ruleTextOf(tool, specifier), layer: options.layer ?? 'user', source: options.source ?? '/h/.momonga/settings.json' },
  };
};

const identity = (absolute: string): PathResolution => ({ ok: true, path: absolute });
const caseInsensitive = (): boolean => true;
const caseSensitive = (): boolean => false;

const compile = (
  specs: readonly FileRuleSpec[],
  options: { exempt?: string | null; canonicalise?: (absolute: string) => PathResolution; volumeProbe?: (directory: string) => boolean; roots?: readonly string[] } = {},
): FileRuleSet =>
  compileFileRuleSet(specs, options.roots ?? ROOTS, options.exempt ?? null, options.canonicalise ?? identity, options.volumeProbe ?? caseSensitive, 'posix', 'seatbelt-profile');

const blockedBySet = (set: FileRuleSet, requested: string, resolved: string = requested): boolean =>
  set.entries.some((entry: FileRuleEntry) => fileRuleBlocks(set, entry, requested, resolved));

const thrownBy = (action: () => unknown): unknown => {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
};

describe('compileFileRuleSet and the volume probe', () => {
  const widening = spec('//w/notes/**', { tool: 'Edit', effect: 'allow' });
  const withExceptions = spec('*.env', { exceptions: ['sample.env'] });

  it.each([
    ['a widening allow entry', widening],
    ['an entry with exceptions', withExceptions],
  ])('compiles %s on a case-insensitive volume', (_label, given) => {
    expect(compile([given], { volumeProbe: caseInsensitive }).entries.length).toBeGreaterThan(0);
  });

  it.each([
    ['a widening allow entry', widening],
    ['an entry with exceptions', withExceptions],
  ])('rejects %s on a case-sensitive volume with kernel_not_exact', (_label, given) => {
    const error = thrownBy(() => compile([given], { volumeProbe: caseSensitive }));
    expect(error).toBeInstanceOf(FileRuleError);
    expect((error as FileRuleError).code).toBe('kernel_not_exact');
    expect((error as FileRuleError).reason).toBe('case_sensitive_volume');
    expect((error as FileRuleError).provenance).toEqual(given.provenance);
  });

  it.each([
    ['a widening allow entry', widening],
    ['an entry with exceptions', withExceptions],
  ])('rejects %s on a case-sensitive volume when a Seatbelt profile enforces it', (_label, given) => {
    const error = thrownBy(() => compileFileRuleSet([given], ROOTS, null, identity, caseSensitive, 'posix', 'seatbelt-profile'));
    expect((error as FileRuleError).code).toBe('kernel_not_exact');
  });

  it.each([
    ['a widening allow entry', widening],
    ['an entry with exceptions', withExceptions],
  ])('compiles %s on a case-sensitive volume when exact paths enforce it', (_label, given) => {
    const set = compileFileRuleSet([given], ROOTS, null, identity, caseSensitive, 'posix', 'exact-paths');
    expect(set.entries).toHaveLength(1);
    expect((set.entries[0] as FileRuleEntry).ignoreCase).toBe(false);
  });

  it('compiles a deny entry on both volume kinds', () => {
    const deny = spec('.env');
    expect(compile([deny], { volumeProbe: caseInsensitive }).entries).toHaveLength(1);
    expect(compile([deny], { volumeProbe: caseSensitive }).entries).toHaveLength(1);
  });
});

describe('compileFileRuleSet and unresolvable prefixes', () => {
  const lockedCanonicaliser = (absolute: string): PathResolution =>
    absolute === '/locked' || absolute.startsWith('/locked/') ? { ok: false, reason: { kind: 'errno', code: 'EACCES' } } : { ok: true, path: absolute };

  it('compiles an allow entry with an unresolvable prefix as unresolved, and it never matches', () => {
    const set = compile([spec('//locked/x/**', { tool: 'Edit', effect: 'allow' })], { canonicalise: lockedCanonicaliser, volumeProbe: caseInsensitive });
    expect(set.entries).toHaveLength(1);
    const entry = set.entries[0] as FileRuleEntry;
    expect(entry.unresolved).toEqual({ kind: 'errno', code: 'EACCES' });
    expect(fileRuleBlocks(set, entry, '/locked/x/k', '/locked/x/k')).toBe(false);
    expect(fileRuleBlocks(set, entry, '/locked/x', '/locked/x')).toBe(false);
  });

  it.each(['deny', 'ask'] as const)('rejects a %s entry with the same prefix as unresolvable_prefix naming the rule', (effect) => {
    const given = spec('//locked/x/**', { effect });
    const error = thrownBy(() => compile([given], { canonicalise: lockedCanonicaliser }));
    expect(error).toBeInstanceOf(FileRuleError);
    expect((error as FileRuleError).code).toBe('unresolvable_prefix');
    expect((error as FileRuleError).provenance).toEqual(given.provenance);
    expect((error as Error).message).toContain('Read(//locked/x/**)');
  });

  it('compiles a deny entry whose prefix tail does not exist yet with the real canonicaliser', () => {
    const dir = makeDir();
    const set = compileFileRuleSet([spec(`/${dir}/missing/sub/**`, { roots: [dir] })], [dir], null, resolveCanonicalPath, caseSensitive, HOST_FLAVOUR, HOST_RULE_ENFORCEMENT);
    expect(blockedBySet(set, path.join(dir, 'missing', 'sub', 'k'))).toBe(true);
    expect(blockedBySet(set, path.join(dir, 'missing', 'other'))).toBe(false);
  });
});

describe('compileFileRuleSet and a prefix below a regular file', () => {
  it('compiles a deny entry whose prefix runs below a regular file, anchored at the canonical parent plus the basename', () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, 'file'), 'x');
    const set = compileFileRuleSet([spec(`/${dir}/file/sub/**`, { roots: [dir] })], [dir], null, resolveCanonicalPath, caseSensitive, HOST_FLAVOUR, HOST_RULE_ENFORCEMENT);
    expect(set.entries).toHaveLength(1);
    expect((set.entries[0] as FileRuleEntry).anchorDirectory).toBe(path.join(dir, 'file', 'sub'));
    expect(blockedBySet(set, path.join(dir, 'file', 'sub', 'k'))).toBe(true);
  });
});

describe('compileFileRuleSet and a root stored in NFD', () => {
  const nfdRoot = (): string => {
    const created = path.join(makeDir(), 'cafe\u0301');
    fs.mkdirSync(created);
    const root = canonicalPath(created);
    expect(root).not.toBe(root.normalize('NFC'));
    return root;
  };

  it('blocks <root>/.env for Read(.env) in both the NFD and the NFC spelling', () => {
    const root = nfdRoot();
    const set = compileFileRuleSet([spec('.env', { roots: [root] })], [root], null, resolveCanonicalPath, caseSensitive, HOST_FLAVOUR, HOST_RULE_ENFORCEMENT);
    const target = path.join(root, '.env');
    expect(blockedBySet(set, target.normalize('NFD'))).toBe(true);
    expect(blockedBySet(set, target.normalize('NFC'))).toBe(true);
  });

  it('blocks <root>/sub/k for Read(//<root>/sub/**) in both the NFD and the NFC spelling', () => {
    const root = nfdRoot();
    const set = compileFileRuleSet([spec(`/${root}/sub/**`, { roots: [root] })], [root], null, resolveCanonicalPath, caseSensitive, HOST_FLAVOUR, HOST_RULE_ENFORCEMENT);
    const target = path.join(root, 'sub', 'k');
    expect(blockedBySet(set, target.normalize('NFD'))).toBe(true);
    expect(blockedBySet(set, target.normalize('NFC'))).toBe(true);
    expect(blockedBySet(set, '/elsewhere/k', target.normalize('NFD'))).toBe(true);
    expect(blockedBySet(set, '/elsewhere/k', target.normalize('NFC'))).toBe(true);
    expect(blockedBySet(set, path.join(root, 'other').normalize('NFD'))).toBe(false);
  });
});

describe('compileFileRuleSet and a symlinked prefix', () => {
  const linked = (absolute: string): PathResolution =>
    absolute === '/lex/d' || absolute.startsWith('/lex/d/') ? { ok: true, path: `/real/d${absolute.slice('/lex/d'.length)}` } : { ok: true, path: absolute };

  it('carries the canonical and the lexical form', () => {
    const set = compile([spec('//lex/d/**')], { canonicalise: linked });
    const entry = set.entries[0] as FileRuleEntry;
    expect(entry.anchorDirectory).toBe('/real/d');
    expect(entry.lexicalDirectory).toBe('/lex/d');
    expect(entry.exactLexical).not.toBeNull();
    expect(entry.denyLexical).not.toBeNull();
  });

  it('blocks by the requested lexical form or by the resolved canonical form', () => {
    const set = compile([spec('//lex/d/**')], { canonicalise: linked });
    expect(blockedBySet(set, '/lex/d/k', '/real/d/k')).toBe(true);
    expect(blockedBySet(set, '/other/k', '/real/d/k')).toBe(true);
    expect(blockedBySet(set, '/lex/d/k', '/elsewhere/k')).toBe(true);
    expect(blockedBySet(set, '/other/k', '/other/k')).toBe(false);
  });

  it('has no lexical matchers when the prefix is not a symlink', () => {
    const entry = compile([spec('//plain/d/**')]).entries[0] as FileRuleEntry;
    expect(entry.exactLexical).toBeNull();
    expect(entry.denyLexical).toBeNull();
    expect(entry.subsetLexical).toBeNull();
  });
});

describe('fileRuleBlocks symlink table', () => {
  it('a deny entry blocks when the requested path or the resolved path matches', () => {
    const set = compile([spec('.env')]);
    const entry = set.entries[0] as FileRuleEntry;
    expect(fileRuleBlocks(set, entry, '/w/link', '/w/.env')).toBe(true);
    expect(fileRuleBlocks(set, entry, '/w/.env', '/o/x')).toBe(true);
    expect(fileRuleBlocks(set, entry, '/w/link', '/o/x')).toBe(false);
  });

  it('an allow entry applies only when both the requested and the resolved path match', () => {
    const set = compile([spec('*.ts', { tool: 'Edit', effect: 'allow' })]);
    const entry = set.entries[0] as FileRuleEntry;
    expect(fileRuleBlocks(set, entry, '/w/a.ts', '/w/b.ts')).toBe(true);
    expect(fileRuleBlocks(set, entry, '/w/link', '/w/b.ts')).toBe(false);
    expect(fileRuleBlocks(set, entry, '/w/a.ts', '/o/b.ts')).toBe(false);
  });
});

describe('the session tmp exemption', () => {
  it('removes a path under exemptDirectory from every entry', () => {
    const set = compile([spec('//w/**'), spec('//w/**', { ruleIndex: 1, tool: 'Edit' })], { exempt: '/w/tmp' });
    expect(set.exemptDirectory).toBe('/w/tmp');
    for (const entry of set.entries) {
      expect(fileRuleBlocks(set, entry, '/w/a', '/w/a')).toBe(true);
      expect(fileRuleBlocks(set, entry, '/w/tmp/f', '/w/tmp/f')).toBe(false);
      expect(fileRuleBlocks(set, entry, '/w/tmp', '/w/tmp')).toBe(false);
    }
  });
});

describe('! exceptions', () => {
  it('Read(*.env) with !sample.env blocks every .env file except sample.env', () => {
    const set = compile([spec('*.env', { exceptions: ['sample.env'] })], { volumeProbe: caseInsensitive });
    expect(blockedBySet(set, '/w/sample.env')).toBe(false);
    expect(blockedBySet(set, '/w/sub/sample.env')).toBe(false);
    expect(blockedBySet(set, '/w/x.env')).toBe(true);
  });

  it('anchors !sample.env at the root of each entry, so it carves <extra>/sample.env as well', () => {
    const roots = [CWD, '/e'];
    const set = compile([spec('*.env', { exceptions: ['sample.env'], roots })], { volumeProbe: caseInsensitive, roots });
    expect(blockedBySet(set, '/e/sample.env')).toBe(false);
    expect(blockedBySet(set, '/e/x.env')).toBe(true);
    expect(blockedBySet(set, '/w/sample.env')).toBe(false);
    expect(blockedBySet(set, '/w/x.env')).toBe(true);
  });

  it('keeps x.env/sample.env blocked because the directory x.env is not carved', () => {
    const set = compile([spec('*.env', { exceptions: ['sample.env'] })], { volumeProbe: caseInsensitive });
    expect(blockedBySet(set, '/w/x.env/sample.env')).toBe(true);
  });

  it('Read(secrets/**) with !secrets/public/** still blocks secrets/public/x', () => {
    const set = compile([spec('secrets/**', { exceptions: ['secrets/public/**'] })], { volumeProbe: caseInsensitive });
    expect(blockedBySet(set, '/w/secrets/public/x')).toBe(true);
    expect(blockedBySet(set, '/w/secrets/k')).toBe(true);
  });

  it('reads an exception relative to the cwd, so !~/notes/public/** carves nothing out of ~/notes/**', () => {
    const set = compile([spec('~/notes/**', { exceptions: ['~/notes/public/**'] })], { volumeProbe: caseInsensitive });
    expect(blockedBySet(set, '/h/notes/public/p')).toBe(true);
  });

  it("does not apply an exception to another source's rule", () => {
    const set = compile(
      [spec('*.env', { exceptions: ['sample.env'], source: '/w/.momonga/settings.json', layer: 'project' }), spec('sample.env', { ruleIndex: 1 })],
      { volumeProbe: caseInsensitive },
    );
    expect(blockedBySet(set, '/w/sample.env')).toBe(true);
  });
});

describe('compileFileRuleSet and an empty exception', () => {
  it.each(['', '.', './'])('rejects the exception %j with unsupported_pattern and reason empty_negation', (exception) => {
    const error = thrownBy(() => compile([spec('.env', { exceptions: [exception] })], { volumeProbe: caseInsensitive }));
    expect(error).toBeInstanceOf(FileRuleError);
    expect((error as FileRuleError).code).toBe('unsupported_pattern');
    expect((error as FileRuleError).reason).toBe('empty_negation');
  });
});

describe('fileRuleFingerprint', () => {
  const base = (): FileRuleSpec[] => [spec('.env', { exceptions: ['sample.env'] }), spec('*.pem', { ruleIndex: 1, tool: 'Edit' })];

  it('is stable for equal inputs', () => {
    expect(fileRuleFingerprint(base(), [CWD], '/t')).toBe(fileRuleFingerprint(base(), [CWD], '/t'));
    expect(fileRuleFingerprint(base(), [CWD], '/t')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is the fingerprint the compiled set carries', () => {
    expect(compile(base(), { exempt: '/t', volumeProbe: caseInsensitive }).fingerprint).toBe(fileRuleFingerprint(base(), [CWD], '/t'));
  });

  const variants: Array<[string, (specs: FileRuleSpec[]) => FileRuleSpec[]]> = [
    ['ruleIndex', ([first, ...rest]) => [{ ...(first as FileRuleSpec), ruleIndex: 7 }, ...rest]],
    ['tool', ([first, ...rest]) => [{ ...(first as FileRuleSpec), tool: 'Grep' }, ...rest]],
    ['access', ([first, ...rest]) => [{ ...(first as FileRuleSpec), access: 'write' }, ...rest]],
    ['effect', ([first, ...rest]) => [{ ...(first as FileRuleSpec), effect: 'ask' }, ...rest]],
    ['specifier', ([first, ...rest]) => [{ ...(first as FileRuleSpec), specifier: '.envrc' }, ...rest]],
    ['exceptions', ([first, ...rest]) => [{ ...(first as FileRuleSpec), exceptions: ['other.env'] }, ...rest]],
    ['context roots', ([first, ...rest]) => [{ ...(first as FileRuleSpec), context: { ...(first as FileRuleSpec).context, roots: [CWD, '/e'] } }, ...rest]],
    ['context home', ([first, ...rest]) => [{ ...(first as FileRuleSpec), context: { ...(first as FileRuleSpec).context, home: '/h2' } }, ...rest]],
    ['context settingsRoot', ([first, ...rest]) => [{ ...(first as FileRuleSpec), context: { ...(first as FileRuleSpec).context, settingsRoot: '/s2' } }, ...rest]],
    ['context effect', ([first, ...rest]) => [{ ...(first as FileRuleSpec), context: { ...(first as FileRuleSpec).context, effect: 'ask' } }, ...rest]],
    ['provenance ruleText', ([first, ...rest]) => [{ ...(first as FileRuleSpec), provenance: { ...(first as FileRuleSpec).provenance, ruleText: 'Read(./.env)' } }, ...rest]],
    ['provenance layer', ([first, ...rest]) => [{ ...(first as FileRuleSpec), provenance: { ...(first as FileRuleSpec).provenance, layer: 'cli' } }, ...rest]],
    ['provenance source', ([first, ...rest]) => [{ ...(first as FileRuleSpec), provenance: { ...(first as FileRuleSpec).provenance, source: 'cli' } }, ...rest]],
    ['order', (specs) => [...specs].reverse()],
    ['a dropped spec', (specs) => specs.slice(0, 1)],
  ];

  it.each(variants)('changes when %s changes', (_label, change) => {
    expect(fileRuleFingerprint(change(base()), [CWD], '/t')).not.toBe(fileRuleFingerprint(base(), [CWD], '/t'));
  });

  it('changes when the roots change', () => {
    expect(fileRuleFingerprint(base(), [CWD, '/e'], '/t')).not.toBe(fileRuleFingerprint(base(), [CWD], '/t'));
  });

  it('changes when the exempt directory changes', () => {
    expect(fileRuleFingerprint(base(), [CWD], '/t2')).not.toBe(fileRuleFingerprint(base(), [CWD], '/t'));
    expect(fileRuleFingerprint(base(), [CWD], null)).not.toBe(fileRuleFingerprint(base(), [CWD], '/t'));
  });
});
