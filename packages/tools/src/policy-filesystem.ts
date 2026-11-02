import fs from 'node:fs';
import path from 'node:path';
import { MAX_POINTER_FILE_BYTES, resolveCanonicalPath, unresolvableReasonOf, volumeIsCaseInsensitive } from '@momonga/foundation';
import type { EntryRead, StepRead, Unresolved } from '@momonga/foundation';
import type { GlobExpansion, PolicyFilesystem, ProgramResolution } from '@momonga/policy';

const APPLE_DIRECTORIES: readonly string[] = ['/bin', '/usr/bin'];
const GLOB_CHARACTER = /[*?[]/;
const NOT_THERE: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);
const MISSING: ReadonlySet<string> = new Set(['ENOENT']);

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

const unresolvedOf = (error: unknown): Unresolved => {
  const reason = unresolvableReasonOf(error);
  if (reason === undefined) throw error;
  return { unresolvable: reason };
};

const isNotThere = (error: unknown): boolean => NOT_THERE.has(codeOf(error) ?? '');

const SKIPPED_ERRNO: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP', 'ENAMETOOLONG']);

type Holder = { apple: boolean; exact: boolean; unsafe: boolean; program: string };

const holdsProgram = (directory: string, name: string): boolean => {
  const file = path.join(directory, name);
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch (error) {
    if (SKIPPED_ERRNO.has(codeOf(error) ?? '')) return false;
    throw error;
  }
};

const holderAt = (entry: string, cwd: string, name: string, isWritable: (absolute: string) => boolean, unsafeBefore: boolean): Holder | undefined => {
  const directory = path.resolve(cwd, entry);
  if (!holdsProgram(directory, name)) return undefined;
  const absolute = path.isAbsolute(entry);
  return {
    apple: APPLE_DIRECTORIES.includes(directory),
    exact: absolute && APPLE_DIRECTORIES.includes(entry),
    unsafe: unsafeBefore || !absolute || isWritable(entry),
    program: path.join(directory, name),
  };
};

const resolveProgram = (name: string, cwd: string, searchPath: string | undefined, isWritable: (absolute: string) => boolean): ProgramResolution => {
  if (searchPath === undefined) return { none: true };
  const entries = searchPath.split(':');
  let unsafeBefore = false;
  for (const [index, entry] of entries.entries()) {
    const landing = holderAt(entry, cwd, name, isWritable, unsafeBefore);
    if (landing !== undefined) {
      if (landing.apple) return landing.exact && !landing.unsafe ? { program: landing.program } : { none: true };
      if (!landing.unsafe) return { program: landing.program };
      const appleBehind = entries.slice(index + 1).some((later) => {
        const holder = holderAt(later, cwd, name, isWritable, true);
        return holder !== undefined && holder.exact;
      });
      return appleBehind ? { none: true } : { program: landing.program };
    }
    unsafeBefore = unsafeBefore || !path.isAbsolute(entry) || isWritable(entry);
  }
  return { none: true };
};

const typedRead = <T>(read: () => T, notThere: ReadonlySet<string>, absent: T): T | Unresolved => {
  try {
    return read();
  } catch (error) {
    if (notThere.has(codeOf(error) ?? '')) return absent;
    return unresolvedOf(error);
  }
};

const readEntry = (absolute: string): EntryRead =>
  typedRead<EntryRead>(
    () => {
      const stat = fs.statSync(absolute);
      if (stat.isDirectory()) return { kind: 'directory', canonical: fs.realpathSync.native(absolute) };
      if (!stat.isFile()) return { kind: 'file', text: '' };
      if (stat.size > MAX_POINTER_FILE_BYTES) return { kind: 'oversize' };
      return { kind: 'file', text: fs.readFileSync(absolute, 'utf8') };
    },
    NOT_THERE,
    { kind: 'absent' },
  );

const readNoFollow = (absolute: string): StepRead =>
  typedRead<StepRead>(
    () => {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) return { kind: 'symlink', target: fs.readlinkSync(absolute) };
      return stat.isDirectory() ? { kind: 'directory' } : { kind: 'other' };
    },
    MISSING,
    { kind: 'missing' },
  );

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const componentMatcher = (component: string): RegExp => {
  let source = '';
  for (let index = 0; index < component.length; index += 1) {
    const char = component.charAt(index);
    if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else if (char === '\\') {
      index += 1;
      source += escapeRegex(component.charAt(index));
    } else if (char === '[') {
      const close = component.indexOf(']', index + 2);
      if (close === -1) source += '\\[';
      else {
        const body = component.slice(index + 1, close);
        const negated = body.startsWith('!') || body.startsWith('^');
        source += `[${negated ? '^' : ''}${(negated ? body.slice(1) : body).replace(/[\\\]]/g, '\\$&')}]`;
        index = close;
      }
    } else source += escapeRegex(char);
  }
  return new RegExp(`^${source}$`);
};

const joinBase = (base: string, name: string): string => (base === '' ? name : base === '/' ? `/${name}` : `${base}/${name}`);

const expandGlob = (pattern: string, cwd: string, limit: number): GlobExpansion => {
  const components = pattern.split('/').filter((component) => component !== '');
  let bases: string[] = [pattern.startsWith('/') ? '/' : ''];
  let examined = 0;
  for (const [position, component] of components.entries()) {
    const last = position === components.length - 1;
    if (!GLOB_CHARACTER.test(component)) {
      bases = bases.map((base) => joinBase(base, component));
      if (last) {
        const existing: string[] = [];
        for (const base of bases) {
          try {
            fs.lstatSync(path.resolve(cwd, base));
            existing.push(base);
          } catch (error) {
            if (!isNotThere(error)) return unresolvedOf(error);
          }
        }
        bases = existing;
      }
      continue;
    }
    const matcher = componentMatcher(component);
    const next: string[] = [];
    for (const base of bases) {
      let directory: fs.Dir;
      try {
        directory = fs.opendirSync(path.resolve(cwd, base === '' ? '.' : base));
      } catch (error) {
        if (isNotThere(error)) continue;
        return unresolvedOf(error);
      }
      try {
        for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
          examined += 1;
          if (examined > limit) return { overflow: true };
          if (entry.name.startsWith('.') && !component.startsWith('.')) continue;
          if (matcher.test(entry.name)) next.push(joinBase(base, entry.name));
        }
      } finally {
        directory.closeSync();
      }
    }
    bases = next;
  }
  return { matches: bases.sort() };
};

export const createPolicyFilesystem = (): PolicyFilesystem => ({
  canonicalise: (absolute) => resolveCanonicalPath(absolute),
  volumeProbe: (directory) => volumeIsCaseInsensitive(directory),
  resolveProgram,
  expandGlob,
  readEntry,
  readNoFollow,
});
