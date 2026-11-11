import { describe, expect, it } from 'vitest';
import { EMPTY_FILE_RULES, compileFileRuleSet, fileRuleBlocks, isProtectedWrite, nativePathOf, patternPathOf, specifierOf, ruleEnforcementOf } from '@momonga/foundation';
import type { FileRuleSpec, PathFlavour } from '@momonga/foundation';

const ROOT = 'C:\\proj';
const HOME = 'C:\\Users\\me';

const specOf = (specifier: string, tool: FileRuleSpec['tool'] = 'Read'): FileRuleSpec => ({
  ruleIndex: 0,
  tool,
  access: tool === 'Read' ? 'read' : 'write',
  effect: 'deny',
  specifier,
  exceptions: [],
  context: { roots: [ROOT], home: HOME, settingsRoot: ROOT, effect: 'deny' },
  provenance: { ruleText: `${tool}(${specifier})`, layer: 'user', source: 'user-settings' },
});

const compiled = async (specifier: string, flavour: PathFlavour = 'win32') =>
  await compileFileRuleSet([specOf(specifier)], [ROOT], null, (absolute) => ({ ok: true, path: absolute }), () => false, flavour, ruleEnforcementOf('none'));

const blocks = async (specifier: string, candidate: string): Promise<boolean> => {
  const set = await compiled(specifier);
  const [entry] = (await set).entries;
  if (entry === undefined) throw new Error('no entry');
  return fileRuleBlocks(await set, entry, candidate, candidate);
};

describe('the protected set judges Windows paths component by component', () => {
  const set = {
    forms: {},
    roots: ['C:\\proj'],
    paths: ['C:\\proj\\.git\\hooks'],
    lexicalPaths: [],
    literals: [],
    names: ['.git'],
    moduleAnchors: [],
    worktreeAnchors: [],
    patterns: { ...EMPTY_FILE_RULES, flavour: 'win32' as const },
    issues: [],
  };
  const probes = { canonicalise: (absolute: string) => ({ ok: true as const, path: absolute }), volumeProbe: () => false };

  it.each([
    ['C:\\proj\\.git\\hooks\\pre-commit', true],
    ['c:\\PROJ\\.GIT\\Hooks\\pre-commit', true],
    ['C:\\proj\\sub\\.git\\config', true],
    ['C:\\proj\\sub\\x.txt', false],
    ['D:\\proj\\.git\\hooks\\pre-commit', false],
  ])('%s is protected: %s', async (target, expected) => {
    expect(await isProtectedWrite(set, target, probes)).toBe(expected);
  });
});

describe('path flavour conversion', () => {
  it('maps drive and UNC paths into the slash form the pattern grammar reads and back', () => {
    expect(patternPathOf('win32', 'C:\\Users\\Me\\x')).toBe('/c/Users/Me/x');
    expect(patternPathOf('win32', 'c:/a')).toBe('/c/a');
    expect(patternPathOf('win32', 'D:\\')).toBe('/d');
    expect(patternPathOf('win32', '\\\\srv\\share\\dir\\f')).toBe('/unc/srv/share/dir/f');
    expect(nativePathOf('win32', '/c/Users/Me/x')).toBe('C:\\Users\\Me\\x');
    expect(nativePathOf('win32', '/d')).toBe('D:\\');
    expect(nativePathOf('win32', '/unc/srv/share/dir/f')).toBe('\\\\srv\\share\\dir\\f');
    expect(patternPathOf('posix', '/a/b')).toBe('/a/b');
  });

  it('turns a drive or UNC specifier into the absolute // form and leaves the rest alone', () => {
    expect(specifierOf('win32', 'C:\\secret\\**')).toBe('//c/secret/**');
    expect(specifierOf('win32', 'C:/secret/**')).toBe('//c/secret/**');
    expect(specifierOf('win32', '\\\\srv\\share\\x\\**')).toBe('//unc/srv/share/x/**');
    expect(specifierOf('win32', '//c/secret/**')).toBe('//c/secret/**');
    expect(specifierOf('win32', '.env')).toBe('.env');
    expect(specifierOf('posix', 'C:\\secret')).toBe('C:\\secret');
  });
});

describe('Windows file rules match canonical Windows paths', () => {
  it.each([
    ['C:\\secret\\**', 'C:\\secret\\a.txt', true],
    ['C:\\secret\\**', 'C:\\secret\\deep\\er\\a.txt', true],
    ['C:\\secret\\**', 'C:\\other\\a.txt', false],
    ['C:\\secret\\**', 'D:\\secret\\a.txt', false],
    ['C:\\secret\\**', 'c:\\SECRET\\a.txt', true],
    ['//c/secret/**', 'C:\\secret\\a.txt', true],
    ['C:/secret/*.key', 'C:\\secret\\a.key', true],
    ['C:/secret/*.key', 'C:\\secret\\a.txt', false],
    ['.env', 'C:\\proj\\sub\\.env', true],
    ['.env', 'C:\\proj\\sub\\.envx', false],
    ['/src/**', 'C:\\proj\\src\\a.ts', true],
    ['~/.ssh/**', 'C:\\Users\\me\\.ssh\\id_rsa', true],
    ['~/.ssh/**', 'C:\\Users\\other\\.ssh\\id_rsa', false],
    ['\\\\srv\\share\\x\\**', '\\\\srv\\share\\x\\y', true],
    ['\\\\srv\\share\\x\\**', '\\\\srv\\share\\z\\y', false],
  ] as const)('rule %s against %s is %s', async (specifier, candidate, expected) => {
    expect(await blocks(specifier, candidate)).toBe(expected);
  });

  it('keeps the POSIX behaviour byte for byte', async () => {
    const set = await compileFileRuleSet(
      [{ ...specOf('//etc/passwd'), context: { roots: ['/proj'], home: '/home/me', settingsRoot: '/proj', effect: 'deny' } }],
      ['/proj'],
      null,
      (absolute) => ({ ok: true, path: absolute }),
      () => false,
      'posix',
      ruleEnforcementOf('none'),
    );
    const [entry] = set.entries;
    expect(set.flavour).toBe('posix');
    expect(entry !== undefined && fileRuleBlocks(set, entry, '/etc/passwd', '/etc/passwd')).toBe(true);
    expect(entry !== undefined && fileRuleBlocks(set, entry, '/etc/other', '/etc/other')).toBe(false);
  });

  it.each([
    ['an alternate data stream', 'C:\\secret\\key.txt::$DATA'],
    ['a named stream', 'C:\\secret\\key.txt:hidden'],
    ['a trailing dot', 'C:\\secret\\key.txt.'],
    ['trailing dots and spaces', 'C:\\secret\\key.txt. . '],
    ['a trailing dot on a directory name', 'C:\\secret.\\key.txt'],
    ['the plain name', 'C:\\secret\\key.txt'],
  ])('blocks the same file when it is named with %s, as Windows resolves it', async (_label, candidate) => {
    expect(await blocks('C:\\secret\\key.txt', candidate)).toBe(true);
    expect(await blocks('C:\\secret\\**', candidate)).toBe(true);
  });

  it.each(['C:\\proj\\sub\\keep', '\\\\srv\\share\\keep'])('refuses the ! pattern %s, which could never match and would leave the deny wider than the author meant', async (exception) => {
    const spec: FileRuleSpec = { ...specOf('sub\\**'), exceptions: [exception] };
    await expect(compileFileRuleSet([spec], [ROOT], null, (absolute) => ({ ok: true, path: absolute }), () => false, 'win32', ruleEnforcementOf('none'))).rejects.toThrow(expect.objectContaining({ code: 'unsupported_pattern', reason: 'absolute_exception' }));
  });

  it('does not block a different file whose name only starts the same way', async () => {
    expect(await blocks('C:\\secret\\key.txt', 'C:\\secret\\key.txt.bak')).toBe(false);
    expect(await blocks('C:\\secret\\key.txt', 'C:\\secret\\key.txt2:stream')).toBe(false);
  });

  it('keeps names on POSIX byte for byte, where a colon and a trailing dot are ordinary characters', async () => {
    const set = await compiled('//etc/key.txt', 'posix');
    const [entry] = (await set).entries;
    expect(entry !== undefined && fileRuleBlocks(await set, entry, '/etc/key.txt::$DATA', '/etc/key.txt::$DATA')).toBe(false);
    expect(entry !== undefined && fileRuleBlocks(await set, entry, '/etc/key.txt.', '/etc/key.txt.')).toBe(false);
    expect(entry !== undefined && fileRuleBlocks(await set, entry, '/etc/key.txt', '/etc/key.txt')).toBe(true);
  });

  it('shows that without the flavour the same rule silently matched nothing', async () => {
    const set = await compiled('C:\\secret\\**', 'posix');
    const [entry] = (await set).entries;
    expect(entry !== undefined && fileRuleBlocks(await set, entry, 'C:\\secret\\a.txt', 'C:\\secret\\a.txt')).toBe(false);
  });
});
