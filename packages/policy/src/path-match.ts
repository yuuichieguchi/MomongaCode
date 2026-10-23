import path from 'node:path';
import picomatch from 'picomatch';
import { canonicalPath, comparableContains, foldCase, volumeIsCaseInsensitive } from '@momonga/foundation';
import type { PermissionRule } from '@momonga/config';

const MATCH_OPTIONS = { dot: true, nocase: false, nonegate: true, windows: false } as const;
const GLOB_CHARACTERS = /[*?[\]{}!+@()\\]/;
const ONLY_GLOBSTARS = /^(\*\*\/?)+$/;

export { volumeIsCaseInsensitive };

export const canonicalizePath = (absolute: string): string | null => {
  try {
    return canonicalPath(absolute);
  } catch {
    return null;
  }
};

export const absoluteFrom = (target: string, cwd: string): string => (path.isAbsolute(target) ? target : `${cwd}/${target}`);

type CompiledPattern =
  | { kind: 'any-depth'; glob: string }
  | { kind: 'anchored'; literalDirectory: string; globRest: string };

const compiledPatterns = new WeakMap<PermissionRule, CompiledPattern>();

const compilePattern = (rule: PermissionRule): CompiledPattern => {
  const specifier = rule.specifier as string;
  let absolute: string;
  if (specifier.startsWith('//')) absolute = specifier.slice(1);
  else if (specifier === '~' || specifier.startsWith('~/')) absolute = `${rule.home}${specifier.slice(1)}`;
  else if (specifier.startsWith('/')) absolute = `${rule.settingsRoot}${specifier}`;
  else if (specifier.includes('/')) absolute = `${rule.cwd}/${specifier}`;
  else return { kind: 'any-depth', glob: specifier };
  const segments = absolute.split('/').filter((segment) => segment !== '');
  const firstGlob = segments.findIndex((segment) => GLOB_CHARACTERS.test(segment));
  const literalCount = firstGlob === -1 ? segments.length : firstGlob;
  return {
    kind: 'anchored',
    literalDirectory: `/${segments.slice(0, literalCount).join('/')}`,
    globRest: segments.slice(literalCount).join('/'),
  };
};

const patternOf = (rule: PermissionRule): CompiledPattern => {
  const cached = compiledPatterns.get(rule);
  if (cached !== undefined) return cached;
  const compiled = compilePattern(rule);
  compiledPatterns.set(rule, compiled);
  return compiled;
};

const matchesBeneath = (
  rawCandidate: string,
  rawDirectory: string,
  globRest: string,
  includeDirectoryItself: boolean,
  ignoreCase: boolean,
): boolean => {
  const candidate = ignoreCase ? foldCase(rawCandidate) : rawCandidate;
  const directory = ignoreCase ? foldCase(rawDirectory) : rawDirectory;
  if (candidate === directory) return globRest === '' || (includeDirectoryItself && ONLY_GLOBSTARS.test(globRest));
  const prefix = directory === '/' ? '/' : `${directory}/`;
  if (!candidate.startsWith(prefix)) return false;
  if (globRest === '') return true;
  return picomatch(globRest, { ...MATCH_OPTIONS, nocase: ignoreCase })(candidate.slice(prefix.length));
};

const segmentsOf = (absolute: string): string[] => absolute.split('/').filter((segment) => segment !== '');

const insideAnyRoot = (candidate: string, roots: readonly string[], cwd: string): boolean =>
  roots.some((root) => {
    const canonical = canonicalizePath(absoluteFrom(root, cwd));
    return canonical !== null && comparableContains(canonical, candidate);
  });

export const pathMatchesRule = (rule: PermissionRule, target: string, strict: boolean, roots: readonly string[]): boolean => {
  const pattern = patternOf(rule);
  const absolute = absoluteFrom(target, rule.cwd);
  const real = canonicalizePath(absolute);
  const lexical = path.resolve(rule.cwd, target);
  const ignoreCase = !strict && volumeIsCaseInsensitive;

  if (pattern.kind === 'any-depth') {
    const isMatch = picomatch(pattern.glob, { ...MATCH_OPTIONS, nocase: ignoreCase });
    if (strict) return real !== null && isMatch(path.basename(real)) && insideAnyRoot(real, roots, rule.cwd);
    return [real, lexical].some((candidate) => candidate !== null && segmentsOf(candidate).some((segment) => isMatch(segment)));
  }

  const literalReal = canonicalizePath(pattern.literalDirectory);
  if (real !== null && literalReal !== null && matchesBeneath(real, literalReal, pattern.globRest, !strict, ignoreCase)) return true;
  if (strict) return false;
  return matchesBeneath(lexical, path.resolve(pattern.literalDirectory), pattern.globRest, true, ignoreCase);
};
